// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// kwblk host side: block devices for the unkernel kernel (drivers/block/kwblk.c).
//
// The kernel describes each request in memory (struct kwblk_req) and calls
// wasm_driver_block_submit(), which must not suspend. A disk backend either
// finishes the request synchronously (return value <= 0 is the status) or
// returns a promise; then the submit returns 1, and when the promise
// settles the status is written into the request, the request is queued for
// wasm_driver_block_reap() and WASM_IRQ_BLOCK is raised. The host only
// touches kernel memory while the kernel is suspended (any JSPI import), and
// the request's pages stay pinned until the kernel reaps it. On an SMP
// kernel every request comes through CPU 0 (kwblk hands other CPUs'
// requests to it), so this runs in CPU 0's thread while the other CPUs
// may run on, as beside a DMA engine.
//
// Backends (all share one interface, BlockDevice):
//   * FileDisk (node/disk.ts): a disk image file, pread/pwrite (Node).
//   * CowDisk: copy-on-write overlay (4 KiB blocks) over a read-only base.
//     Without a store the overlay lives in memory. With a store (IdbStore
//     in web/disk.ts keeps it in IndexedDB) it is persisted and loaded
//     lazily: memory holds only the blocks written since the last committed
//     flush, plus the set of block numbers that have a record in the store.
//   * HttpBase: read-only base fetched lazily with HTTP Range requests, in
//     chunks, with an in-memory chunk cache; the start of the image can be
//     fetched ahead in one streaming request (a distro image's header says
//     how much, see distro.ts).
//   * ZeroBase / SparseBase: an all-zero base (the data disk), or one made
//     of a few non-zero blocks (a kwsparse image, see kwsparse.ts).
//   * BaseDisk: a base read directly, read-only (a distro image over HTTP;
//     distro.ts).
//
// Memory is never grown (initial == maximum), so views of it stay valid
// across the asynchronous part of a request.
//
// Persistent disks (CowDisk with a store, FileDisk) count their flushes, so
// Kernel.requestSync() can wait for a flush issued after its request
// (flushSeq, whenFlushed).
//
// Machine snapshots (Kernel.snapshot()) do not copy disks. A disk that can
// be part of one says which disk it is and keeps a write generation
// (snapshotState): the generation changes before the first write after the
// disk is opened and after each snapshot, and persistent disks store it
// with their data. A restore refuses a disk whose identity or generation
// differs, since the restored kernel's caches would not match it.

import type { Kernel } from "./kernel.ts";
import { isZeroBlock, kwsparseHeader, type KwsparseImage } from "./kwsparse.ts";

export const IRQ_BLOCK = 3;

const OP_READ = 0, OP_WRITE = 1, OP_FLUSH = 2, OP_DISCARD = 3, OP_WRITE_ZEROES = 4;
export const F_RO = 1, F_FLUSH = 2, F_DISCARD = 4, F_WRITE_ZEROES = 8;
const EIO = 5, EROFS = 30, ENODEV = 19, EOPNOTSUPP = 95;
const MAX_DEVS = 16;

// struct kwblk_req (packed): dev u32 @0, op u32 @4, sector u64 @8, bytes u64 @16,
// nr_segs u32 @24, status s32 @28, segs[] {addr u64, len u64} @32.
const REQ_STATUS = 28, REQ_SEGS = 32;

/** A result that is either ready now or arrives later. */
export type MaybePromise<T> = T | Promise<T>;

/**
 * A kwblk disk (/dev/wda, wdb, ... in the order given). Byte offsets and
 * sizes; `views` are subarrays of the kernel's memory to fill (read) or
 * take the data from (write). A method either completes synchronously or
 * returns a promise. It must not touch the views after that promise
 * settles.
 */
export interface BlockDevice {
	/** Size in bytes (a multiple of 512). */
	size: number;
	/** F_FLUSH | F_DISCARD | F_WRITE_ZEROES | F_RO. */
	flags?: number;
	readOnly?: boolean;
	/** Logical block size, default 512. */
	blockSize?: number;
	read(off: number, views: Uint8Array[]): MaybePromise<void>;
	write(off: number, views: Uint8Array[]): MaybePromise<unknown>;
	flush?(): MaybePromise<unknown>;
	discard?(off: number, len: number): MaybePromise<unknown>;
	writeZeroes?(off: number, len: number): MaybePromise<unknown>;
	/**
	 * Flushes reach storage that outlives the host process or page (a file,
	 * IndexedDB). Kernel.requestSync() waits only for such disks, which must
	 * also provide flushSeq and whenFlushed.
	 */
	readonly persistent?: boolean;
	/** Number of flushes issued so far (see FlushTracker). */
	readonly flushSeq?: number;
	/** Resolves once a flush issued after the `after`-th one has completed successfully. */
	whenFlushed?(after: number): Promise<void>;
	/** A save in flight, if any (CowDisk): requestSync() waits for it when the kernel is not running. */
	readonly saving?: Promise<void> | null;
	/**
	 * Snapshot support: which disk this is and its write generation now.
	 * Throws if the disk cannot be part of a snapshot (its writes live only
	 * in this process's memory). A disk without it cannot be in a snapshot.
	 */
	snapshotState?(): DiskSnapshotState;
	/**
	 * At a snapshot's consistent point (the kernel parked, no request in
	 * flight; synchronous): make the current content durable and return
	 * its state. `done` settles when it is durable (a failure fails the
	 * snapshot). The next write starts a new generation.
	 */
	snapshotSeal?(): { state: DiskSnapshotState; done: Promise<void> };
}

/** What a snapshot records about a disk (BlockDevice.snapshotState). */
export interface DiskSnapshotState {
	/** For messages: a path or a store name. */
	name: string;
	/** Which disk: stays the same across processes for the same content source. */
	identity: string;
	/** Write generation: differs whenever the content may differ. */
	gen: number;
	/** What changes when another program writes the disk (a file's size and mtime), if known. */
	stamp?: string;
}

/** Block I/O counters of one kernel (Kernel.block.stats). */
export interface BlockStats {
	reads: number;
	writes: number;
	flushes: number;
	discards: number;
	async: number;
	bytesRead: number;
	bytesWritten: number;
}

/** Copy a contiguous buffer into a list of memory views (scatter). */
export function scatter(views: Uint8Array[], src: Uint8Array): void {
	let o = 0;
	for (const v of views) {
		v.set(src.subarray(o, o + v.length));
		o += v.length;
	}
}

/** Concatenate memory views into one new buffer (gather). */
export function gather(views: Uint8Array[]): Uint8Array {
	if (views.length === 1) return views[0]!.slice();
	let n = 0;
	for (const v of views) n += v.length;
	const out = new Uint8Array(n);
	let o = 0;
	for (const v of views) {
		out.set(v, o);
		o += v.length;
	}
	return out;
}

export class BlockHost {
	k: Kernel;
	disks: BlockDevice[];
	/** Completed async requests (BigInt pointers). */
	done: bigint[];
	inflight: number;
	stats: BlockStats;

	/**
	 * @param kernel  the Kernel (needs dv(), u8(), irqAddr, wake(), log)
	 * @param disks  backends; index i becomes /dev/wd('a'+i)
	 */
	constructor(kernel: Kernel, disks: BlockDevice[] = []) {
		this.k = kernel;
		this.disks = disks.slice(0, MAX_DEVS);
		this.done = [];
		this.inflight = 0;
		this.stats = { reads: 0, writes: 0, flushes: 0, discards: 0, async: 0, bytesRead: 0, bytesWritten: 0 };
	}

	imports(): Record<string, unknown> {
		const h = this;
		return {
			wasm_driver_block_info(dev: number, info: bigint): number {
				const d = h.disks[dev];
				if (!d) return -ENODEV;
				const dv = h.k.dv();
				const p = Number(info);
				let flags = d.flags ?? 0;
				if (d.readOnly) flags |= F_RO;
				dv.setBigUint64(p, BigInt(d.size), true);
				dv.setUint32(p + 8, flags, true);
				dv.setUint32(p + 12, d.blockSize ?? 512, true);
				return 0;
			},
			wasm_driver_block_submit: (req: bigint) => h.submit(req),
			wasm_driver_block_reap: () => (h.done.length ? h.done.shift()! : 0n),
		};
	}

	submit(reqPtr: bigint): number {
		const dv = this.k.dv();
		const p = Number(reqPtr);
		const dev = dv.getUint32(p, true);
		const op = dv.getUint32(p + 4, true);
		const off = Number(dv.getBigUint64(p + 8, true)) * 512;
		const bytes = Number(dv.getBigUint64(p + 16, true));
		const nseg = dv.getUint32(p + 24, true);
		const d = this.disks[dev];
		if (!d) return -ENODEV;
		if (op !== OP_FLUSH && off + bytes > d.size) return -EIO;

		const views: Uint8Array[] = [];
		if (op === OP_READ || op === OP_WRITE) {
			const u8 = this.k.u8();
			for (let i = 0; i < nseg; i++) {
				const a = Number(dv.getBigUint64(p + REQ_SEGS + 16 * i, true));
				const l = Number(dv.getBigUint64(p + REQ_SEGS + 16 * i + 8, true));
				views.push(u8.subarray(a, a + l));
			}
		}

		let r: unknown;
		try {
			switch (op) {
			case OP_READ:
				this.stats.reads++;
				this.stats.bytesRead += bytes;
				r = d.read(off, views);
				break;
			case OP_WRITE:
				if (d.readOnly) return -EROFS;
				this.stats.writes++;
				this.stats.bytesWritten += bytes;
				r = d.write(off, views);
				break;
			case OP_FLUSH:
				this.stats.flushes++;
				r = d.flush?.();
				break;
			case OP_DISCARD:
				this.stats.discards++;
				if (!d.discard) return -EOPNOTSUPP;
				r = d.discard(off, bytes);
				break;
			case OP_WRITE_ZEROES:
				if (!d.writeZeroes) return -EOPNOTSUPP;
				r = d.writeZeroes(off, bytes);
				break;
			default:
				return -EOPNOTSUPP;
			}
		} catch (e) {
			this.k.log(`[host] block: wd${String.fromCharCode(97 + dev)} op ${op} @${off}+${bytes}: ${(e as Error)?.message ?? e}`);
			return -EIO;
		}
		if (!(r instanceof Promise)) return 0;

		this.stats.async++;
		this.inflight++;
		r.then(() => 0, (e) => {
			this.k.log(`[host] block: wd${String.fromCharCode(97 + dev)} op ${op} @${off}+${bytes}: ${e?.message ?? e}`);
			return -EIO;
		}).then((status) => {
			this.inflight--;
			this.k.dv().setInt32(p + REQ_STATUS, status, true);
			this.done.push(BigInt(p));
			this.raise();
		});
		return 1;
	}

	raise(): void {
		const k = this.k;
		if (k.irqAddr === undefined) return;
		// Atomically on a shared memory: other CPUs set bits there too.
		k.setIrqBits(1 << IRQ_BLOCK);
		k.wake();
	}
}

// ---------------------------------------------------------------------------
// Flush accounting for Kernel.requestSync().

/**
 * Counts flushes: flushSeq is the number of flushes issued, and
 * whenFlushed(n) resolves once a flush issued after the n-th one has
 * completed successfully. Flushes of one disk complete in order.
 */
export class FlushTracker {
	flushSeq = 0;
	flushedSeq = 0;
	waiters: Array<{ after: number; resolve: () => void }> = [];

	/** A flush starts: its sequence number. */
	begin(): number {
		return ++this.flushSeq;
	}

	/** Flush `seq` completed successfully. */
	done(seq: number): void {
		if (seq <= this.flushedSeq) return;
		this.flushedSeq = seq;
		this.waiters = this.waiters.filter((w) => (w.after < seq ? (w.resolve(), false) : true));
	}

	whenFlushed(after: number): Promise<void> {
		if (this.flushedSeq > after) return Promise.resolve();
		return new Promise((resolve) => this.waiters.push({ after, resolve }));
	}
}

// ---------------------------------------------------------------------------
// Copy-on-write overlay over a read-only base.

const BLOCK = 4096;
/** Overlay value of a block that reads as zeros (stored as an empty record). */
export const ZERO_BLOCK: Uint8Array = new Uint8Array(0);
const ZERO = ZERO_BLOCK;

/** A read-only disk image: the base of a CowDisk. */
export interface DiskBase {
	size: number;
	/** Identifies the image's content (e.g. URL + size + ETag); a store refuses or drops an overlay saved for another one. */
	identity?: string;
	/** The base reads as all zeros (ZeroBase): discarding a block deletes its record instead of storing zeros. */
	zero?: boolean;
	/** Block indices with content, ascending (SparseBase; used by exportParts). */
	keys?(): number[];
	read(off: number, len: number): MaybePromise<Uint8Array>;
}

/** What OverlayStore.open() found. */
export interface StoreIndex {
	/** Block numbers that have a record. */
	keys: Set<number>;
	/** The store was seeded (a data disk, see web/disk.ts). */
	initialized: boolean;
	/** The store belongs to this other identity and was left alone ("refuse", or a read-only open). */
	mismatch?: string;
	/** The store belonged to this other identity and was cleared ("clear"). */
	cleared?: string;
	/** The write generation saved with the blocks (save()'s `meta`), if the store keeps one. */
	gen?: number;
	/** A random id the store chose when it was created, seeded or cleared, if it keeps one. */
	uid?: string;
}

/**
 * Persistence for a CowDisk overlay: records of 4 KiB blocks by index, an
 * empty record for a block that reads as zeros. IdbStore (web/disk.ts) is
 * the IndexedDB one. Every save must be atomic (one transaction), so the
 * stored state is always the state after some complete flush.
 */
export interface OverlayStore {
	/** e.g. "kwdisk:alpine", for messages. */
	readonly name?: string;
	/** Read the index (block numbers, not data). onMismatch: what to do with a store of another identity (default "refuse"). */
	open(identity: string, opts?: { onMismatch?: "clear" | "refuse"; write?: boolean }): Promise<StoreIndex>;
	/** The records of these blocks (absent ones are missing from the map). */
	getBlocks(blocks: number[]): Promise<Map<number, Uint8Array>>;
	/** One atomic transaction: put these records, delete those, and record `meta.gen` (the disk's write generation) if given. */
	save(puts: Array<[number, Uint8Array]>, dels: number[], meta?: { gen: number }): Promise<void>;
	/** Delete everything. */
	clear(): Promise<void>;
	close?(): Promise<void>;
}

/** A base that reads as zeros (the data disk: its content is all in the store). */
export class ZeroBase implements DiskBase {
	size: number;
	readonly zero = true;
	identity = "";

	constructor(size: number) {
		this.size = size;
	}

	read(_off: number, len: number): Uint8Array {
		return new Uint8Array(len);
	}
}

/** A base made of a few non-zero 4 KiB blocks (a decoded kwsparse image, or a Map). */
export class SparseBase implements DiskBase {
	size: number;
	blocks: Map<number, Uint8Array>;
	identity = "";

	constructor(size: number, blocks: Map<number, Uint8Array>) {
		this.size = size;
		this.blocks = blocks;
	}

	static fromKwsparse(img: KwsparseImage): SparseBase {
		if (img.blockSize !== BLOCK) throw new Error(`kwsparse block size ${img.blockSize}, need ${BLOCK}`);
		return new SparseBase(img.size, img.map());
	}

	read(off: number, len: number): Uint8Array {
		const out = new Uint8Array(len);
		const b0 = Math.floor(off / BLOCK), b1 = Math.floor((off + len - 1) / BLOCK);
		for (let b = b0; b <= b1; b++) {
			const blk = this.blocks.get(b);
			if (!blk || !blk.length) continue; // absent, or an empty (zeros) record
			const s = Math.max(off, b * BLOCK), e = Math.min(off + len, (b + 1) * BLOCK);
			out.set(blk.subarray(s - b * BLOCK, e - b * BLOCK), s - off);
		}
		return out;
	}

	keys(): number[] {
		return [...this.blocks.keys()].sort((a, b) => a - b);
	}
}

/** Copy the part [s, e) of disk block b (absolute byte offsets) into out, which starts at off. */
function copyPart(out: Uint8Array, off: number, blk: Uint8Array, b: number, s: number, e: number): void {
	if (blk === ZERO || !blk.length) out.fill(0, s - off, e - off);
	else out.set(blk.subarray(s - b * BLOCK, e - b * BLOCK), s - off);
}

export interface CowDiskOptions {
	/** Persistence for the overlay (loaded lazily after open()). */
	store?: OverlayStore | null;
	/** Host diagnostics; default console.warn. */
	log?: (msg: string) => void;
	/** A save failed (e.g. QuotaExceededError); the flush fails with EIO too. */
	onError?: (err: unknown) => void;
}

export interface CowDiskStats {
	/** Store read requests and the blocks they asked for (readahead included). */
	storeReads: number;
	storeBlocksRead: number;
	/** Blocks fetched ahead of a read, and reads served from them. */
	aheadBlocks: number;
	aheadHits: number;
	/** Committed saves, blocks put and records deleted by them. */
	saves: number;
	blocksSaved: number;
	blocksDeleted: number;
	/** Partial writes of blocks not in memory (read-modify-write). */
	rmw: number;
	saveErrors: number;
}

/**
 * Copy-on-write overlay over a read-only base, optionally persisted.
 *
 * Invariants, per block b:
 *   mem.has(b)     the newest content is in memory (always so without a
 *                  store; with one: written since the last committed save of b)
 *   stored.has(b)  the store has a record for b (used when !mem.has(b))
 *   otherwise      the base has the content.
 * A buffer handed to an in-flight save is frozen: a write copies it first,
 * so the save sees exactly what it was given. A block leaves memory only
 * when the save transaction that contains it has committed and it was not
 * written again meanwhile.
 */
export class CowDisk implements BlockDevice {
	base: DiskBase;
	size: number;
	flags: number;
	store: OverlayStore | null;
	log: (msg: string) => void;
	onError: ((err: unknown) => void) | null;
	/** Block -> Uint8Array(4096) | ZERO_BLOCK. */
	mem: Map<number, Uint8Array> = new Map();
	/** Blocks with a record in the store. */
	stored: Set<number> = new Set();
	/** Blocks in mem not yet handed to a save. */
	dirty: Set<number> = new Set();
	/** Buffers an in-flight save holds. */
	frozen: WeakSet<Uint8Array> = new WeakSet();
	/** Block -> store read in flight. */
	loading: Map<number, Promise<Uint8Array>> = new Map();
	/**
	 * Readahead: store records fetched with a read that missed, for the
	 * blocks after it. A read of one consumes it, a write drops it (so it
	 * always equals the store's record). Each store read is one transaction,
	 * and the guest often reads metadata one block at a time (ext4 reads its
	 * orphan file, 256 blocks, that way at every mount); in WebKit every
	 * IndexedDB transaction is a round trip to another process.
	 */
	ahead: Map<number, Uint8Array> = new Map();
	/** Blocks being fetched ahead; a write removes them, so a stale fetch is not kept. */
	aheadPending: Set<number> = new Set();
	#raEnd = -2;
	#raSize = 0;
	/** Block -> tail of the asynchronous writes on it. */
	busy: Map<number, Promise<void>> = new Map();
	/** The last flush in flight (flushes are chained). */
	saving: Promise<void> | null = null;
	/** detach(): flushes no longer reach the store. */
	saveDisabled = false;
	flushes: FlushTracker = new FlushTracker();
	stats: CowDiskStats = { storeReads: 0, storeBlocksRead: 0, aheadBlocks: 0, aheadHits: 0, saves: 0, blocksSaved: 0, blocksDeleted: 0, rmw: 0, saveErrors: 0 };
	/** Set by openDataDisk: why this disk is not the persistent one (another tab, a format mismatch). */
	notice?: string;
	/** Set by openDataDisk: the store was created from the template in this session. */
	seeded = false;
	/** Set by openDataDisk: the store's identity. */
	identity?: string;
	/** Write generation (snapshotState): bumped by the first write after open() and after each snapshotSeal(). */
	gen = 0;
	/** The generation the store has (StoreIndex.gen, then each committed save). */
	storedGen = 0;
	/** From the store: its id (StoreIndex.uid) and identity. */
	storeUid?: string;
	storeIdentity?: string;
	/** The next write starts a new generation. */
	#sealed = true;

	constructor(base: DiskBase, { store = null, log, onError }: CowDiskOptions = {}) {
		this.base = base;
		this.size = base.size;
		this.flags = F_FLUSH | F_DISCARD | F_WRITE_ZEROES;
		this.store = store;
		this.log = log ?? ((m) => console.warn(m));
		this.onError = onError ?? null;
	}

	/**
	 * Load the store's index (block numbers only, not the data). A store
	 * saved for another base identity is cleared with onMismatch "clear"
	 * (the store logs it), or makes this throw a StoreMismatchError.
	 */
	async open({ onMismatch = "clear" }: { onMismatch?: "clear" | "refuse" } = {}): Promise<this> {
		if (!this.store) return this;
		const st = await this.store.open(this.base.identity ?? "", { onMismatch });
		if (st.mismatch !== undefined) {
			const e = new Error(`saved data belongs to "${st.mismatch}", expected "${this.base.identity ?? ""}"`);
			e.name = "StoreMismatchError";
			throw e;
		}
		this.adoptStore(st, this.base.identity ?? "");
		return this;
	}

	/** Take what the store's open() found (openDataDisk opens the store itself). */
	adoptStore(st: StoreIndex, identity: string): void {
		this.stored = st.keys;
		this.gen = this.storedGen = st.gen ?? 0;
		this.storeUid = st.uid;
		this.storeIdentity = identity;
	}

	/** Is every flush saved somewhere that outlives the page (a store that is attached)? */
	get persistent(): boolean {
		return !!this.store && !this.saveDisabled;
	}

	get flushSeq(): number {
		return this.flushes.flushSeq;
	}

	whenFlushed(after: number): Promise<void> {
		return this.flushes.whenFlushed(after);
	}

	/** Number of blocks that differ from the base (stored or in memory). */
	get overlayBlocks(): number {
		let n = this.stored.size;
		for (const b of this.mem.keys()) if (!this.stored.has(b)) n++;
		return n;
	}

	/** Bytes of block data held in memory. */
	get memBytes(): number {
		let n = 0;
		for (const v of this.mem.values()) n += v.length;
		return n;
	}

	// --- reads ---------------------------------------------------------------

	read(off: number, views: Uint8Array[]): MaybePromise<void> {
		const len = views.reduce((n, v) => n + v.length, 0);
		const b0 = Math.floor(off / BLOCK), b1 = Math.floor((off + len - 1) / BLOCK);
		const out = new Uint8Array(len);
		const fromStore: number[] = [], fromBase: number[] = [];
		// Blocks in memory are copied now: by the time a store or base read
		// returns, a save may have committed them and dropped them from memory.
		for (let b = b0; b <= b1; b++) {
			const blk = this.mem.get(b) ?? this.#takeAhead(b);
			const s = Math.max(off, b * BLOCK), e = Math.min(off + len, (b + 1) * BLOCK);
			if (blk) copyPart(out, off, blk, b, s, e);
			else if (this.stored.has(b)) fromStore.push(b);
			else fromBase.push(b);
		}
		const waits: Promise<void>[] = [];
		if (fromStore.length) {
			waits.push(this.#loadAhead(fromStore).then((m) => {
				for (const b of fromStore) {
					const s = Math.max(off, b * BLOCK), e = Math.min(off + len, (b + 1) * BLOCK);
					copyPart(out, off, m.get(b)!, b, s, e);
				}
			}));
		}
		if (fromBase.length) {
			// One base read covering the base blocks (contiguous for HttpBase's coalescing).
			const lo = Math.max(off, fromBase[0]! * BLOCK), hi = Math.min(off + len, (fromBase.at(-1)! + 1) * BLOCK);
			const put = (buf: Uint8Array) => {
				for (const b of fromBase) {
					const s = Math.max(off, b * BLOCK), e = Math.min(off + len, (b + 1) * BLOCK);
					out.set(buf.subarray(s - lo, e - lo), s - off);
				}
			};
			const r = this.base.read(lo, hi - lo);
			if (r instanceof Promise) waits.push(r.then(put));
			else put(r);
		}
		if (!waits.length) return scatter(views, out);
		return Promise.all(waits).then(() => scatter(views, out));
	}

	/** Store records of the given blocks: Map block -> Uint8Array(BLOCK) | ZERO_BLOCK. */
	#load(blocks: number[]): Promise<Map<number, Uint8Array>> {
		const want = blocks.filter((b) => !this.loading.has(b));
		if (want.length) {
			this.stats.storeReads++;
			this.stats.storeBlocksRead += want.length;
			const p = this.store!.getBlocks(want);
			for (const b of want) {
				const one = p.then((m) => {
					const v = m.get(b);
					if (v === undefined) throw new Error(`block ${b} is missing from the store`);
					return v.length ? v : ZERO;
				});
				one.catch(() => {});
				this.loading.set(b, one);
				const clear = () => { if (this.loading.get(b) === one) this.loading.delete(b); };
				one.then(clear, clear);
			}
		}
		return Promise.all(blocks.map((b) => this.loading.get(b)!)).then((vals) => new Map(blocks.map((b, i) => [b, vals[i]!])));
	}

	static readonly RA_MIN = 8;
	static readonly RA_MAX = 128;
	/** Most blocks kept ahead (4 MiB); the oldest go first. */
	static readonly AHEAD_MAX = 1024;

	/** A block fetched ahead, removed from the readahead buffer. */
	#takeAhead(b: number): Uint8Array | undefined {
		const v = this.ahead.get(b);
		if (v === undefined) return undefined;
		this.ahead.delete(b);
		this.stats.aheadHits++;
		return v;
	}

	/** Drop block b from the readahead buffer (it is being written). */
	#dropAhead(b: number): void {
		this.ahead.delete(b);
		this.aheadPending.delete(b);
	}

	/**
	 * #load(blocks) plus, in the same store request, the stored blocks after
	 * them that are not in memory: RA_MIN of them, doubling up to RA_MAX
	 * while the misses stay sequential (each starts within the last window).
	 */
	#loadAhead(blocks: number[]): Promise<Map<number, Uint8Array>> {
		const first = blocks[0]!, last = blocks.at(-1)!;
		const seq = first > this.#raEnd - this.#raSize && first <= this.#raEnd + 1;
		this.#raSize = seq ? Math.min(this.#raSize * 2, CowDisk.RA_MAX) : CowDisk.RA_MIN;
		this.#raEnd = Math.min(last + this.#raSize, Math.ceil(this.size / BLOCK) - 1);
		const extra: number[] = [];
		for (let b = last + 1; b <= this.#raEnd; b++) {
			if (this.stored.has(b) && !this.mem.has(b) && !this.ahead.has(b) && !this.aheadPending.has(b) && !this.loading.has(b)) extra.push(b);
		}
		if (!extra.length) return this.#load(blocks);
		for (const b of extra) this.aheadPending.add(b);
		this.stats.aheadBlocks += extra.length;
		const all = this.#load([...blocks, ...extra]);
		void all.then((m) => {
			for (const b of extra) {
				if (!this.aheadPending.delete(b)) continue; // written meanwhile
				this.ahead.set(b, m.get(b)!);
			}
			for (const b of this.ahead.keys()) {
				if (this.ahead.size <= CowDisk.AHEAD_MAX) break;
				this.ahead.delete(b);
			}
		}, () => { for (const b of extra) this.aheadPending.delete(b); });
		return all;
	}

	// --- writes --------------------------------------------------------------

	/**
	 * Run fn for blocks [b0, b1] after every pending asynchronous write on
	 * them (a read-modify-write of a block that is not in memory). If fn ends
	 * up asynchronous itself, later writes to those blocks wait for it, so
	 * writes to a block are applied in submission order and a stale fetch
	 * never overwrites a newer write.
	 */
	#serial(b0: number, b1: number, fn: () => MaybePromise<unknown>): MaybePromise<unknown> {
		const waits: Promise<void>[] = [];
		for (let b = b0; b <= b1; b++) {
			const p = this.busy.get(b);
			if (p && waits.at(-1) !== p) waits.push(p);
		}
		const r = waits.length ? Promise.all(waits).then(fn) : fn();
		if (r instanceof Promise) {
			const tail = r.then(() => {}, () => {});
			for (let b = b0; b <= b1; b++) this.busy.set(b, tail);
			void tail.then(() => {
				for (let b = b0; b <= b1; b++) if (this.busy.get(b) === tail) this.busy.delete(b);
			});
		}
		return r;
	}

	/** A write is submitted: the first one after open() or a seal starts a new generation. */
	#touch(): void {
		if (!this.#sealed) return;
		this.#sealed = false;
		this.gen++;
	}

	write(off: number, views: Uint8Array[]): MaybePromise<unknown> {
		this.#touch();
		const data = gather(views);
		const b0 = Math.floor(off / BLOCK), b1 = Math.floor((off + data.length - 1) / BLOCK);
		return this.#serial(b0, b1, () => this.#writeNow(off, data));
	}

	#writeNow(off: number, data: Uint8Array): MaybePromise<unknown> {
		const len = data.length;
		const b0 = Math.floor(off / BLOCK), b1 = Math.floor((off + len - 1) / BLOCK);
		const partial: Array<[number, number, number]> = [];
		for (let b = b0; b <= b1; b++) {
			const s = Math.max(off, b * BLOCK), e = Math.min(off + len, (b + 1) * BLOCK);
			if (e - s === BLOCK || this.mem.has(b)) this.#put(b, data.subarray(s - off, e - off), s - b * BLOCK);
			else partial.push([b, s, e]);
		}
		if (!partial.length) return;
		// Read-modify-write of blocks that are not in memory: their current
		// content comes from the store or the base.
		this.stats.rmw += partial.length;
		const pending: Promise<void>[] = [];
		for (const [b, s, e] of partial) {
			const apply = (cur: Uint8Array) => {
				// Writes to b are serialized (#serial), so nothing put b in memory
				// meanwhile; check anyway rather than lose data.
				if (!this.mem.has(b)) this.mem.set(b, cur);
				this.#put(b, data.subarray(s - off, e - off), s - b * BLOCK);
			};
			const r = this.#current(b);
			if (r instanceof Promise) pending.push(r.then(apply));
			else apply(r);
		}
		if (pending.length) return Promise.all(pending);
	}

	/** A fresh, modifiable copy of block b's current content (from the store or the base). */
	#current(b: number): MaybePromise<Uint8Array> {
		const fresh = (src: Uint8Array) => {
			const blk = new Uint8Array(BLOCK);
			if (src !== ZERO) blk.set(src);
			return blk;
		};
		const ahead = this.#takeAhead(b);
		if (ahead) return fresh(ahead);
		if (this.stored.has(b)) return this.#load([b]).then((m) => fresh(m.get(b)!));
		const r = this.base.read(b * BLOCK, Math.min(BLOCK, this.size - b * BLOCK));
		return r instanceof Promise ? r.then(fresh) : fresh(r);
	}

	/** Put src at byte `at` of block b. A partial put needs b in memory. */
	#put(b: number, src: Uint8Array, at: number): void {
		let blk = this.mem.get(b);
		if (src.length === BLOCK) {
			if (!blk || blk === ZERO || this.frozen.has(blk)) blk = new Uint8Array(BLOCK);
		} else if (blk === undefined) {
			throw new Error("internal: partial put of a block not in memory");
		} else if (blk === ZERO) {
			blk = new Uint8Array(BLOCK);
		} else if (this.frozen.has(blk)) {
			blk = blk.slice(); // an in-flight save holds the old buffer
		}
		blk.set(src, at);
		this.mem.set(b, blk);
		this.dirty.add(b);
		this.loading.delete(b);
		this.#dropAhead(b);
	}

	/** Block b becomes all zeros. */
	#zero(b: number): void {
		this.#dropAhead(b);
		const cur = this.mem.get(b);
		if (this.base.zero && !this.stored.has(b) && !(cur && this.frozen.has(cur))) {
			// Already zeros in the base and not being saved: nothing to store or delete.
			this.mem.delete(b);
			this.dirty.delete(b);
			return;
		}
		this.mem.set(b, ZERO);
		this.dirty.add(b);
		this.loading.delete(b);
	}

	discard(off: number, len: number): MaybePromise<unknown> {
		return this.writeZeroes(off, len);
	}

	writeZeroes(off: number, len: number): MaybePromise<unknown> {
		this.#touch();
		const b0 = Math.floor(off / BLOCK), b1 = Math.floor((off + len - 1) / BLOCK);
		return this.#serial(b0, b1, () => {
			const f0 = Math.ceil(off / BLOCK), f1 = Math.floor((off + len) / BLOCK); // full blocks [f0, f1)
			if (f0 >= f1) return this.#writeNow(off, new Uint8Array(len));
			for (let b = f0; b < f1; b++) this.#zero(b);
			const ps: unknown[] = [];
			if (off < f0 * BLOCK) ps.push(this.#writeNow(off, new Uint8Array(f0 * BLOCK - off)));
			if (off + len > f1 * BLOCK) ps.push(this.#writeNow(f1 * BLOCK, new Uint8Array(off + len - f1 * BLOCK)));
			const p = ps.filter((x) => x instanceof Promise);
			if (p.length) return Promise.all(p);
		});
	}

	// --- flush ---------------------------------------------------------------

	/**
	 * Save every block written so far in one store transaction; the flush
	 * completes when it has committed. Flushes are chained: one issued while
	 * a save is in flight waits for it (even with nothing new to save). On a
	 * failed save the blocks are dirty again (the next flush retries them)
	 * and the flush fails (EIO in the guest).
	 */
	flush(): MaybePromise<unknown> {
		const seq = this.flushes.begin();
		if (!this.store || this.saveDisabled || (!this.saving && !this.#pending())) {
			this.flushes.done(seq);
			return;
		}
		return this.#chain(() => this.#commit(this.#take())).then(() => this.flushes.done(seq));
	}

	/** Something to save: dirty blocks, or a generation the store does not have yet. */
	#pending(): boolean {
		return this.dirty.size > 0 || this.gen !== this.storedGen;
	}

	/** Run fn after the save in flight (failed or not); it becomes the save in flight. */
	#chain(fn: () => Promise<void>): Promise<void> {
		const p = (this.saving ?? Promise.resolve()).catch(() => {}).then(fn);
		this.saving = p;
		const clear = () => { if (this.saving === p) this.saving = null; };
		p.then(clear, clear);
		return p;
	}

	/** Take the dirty blocks (and the generation they belong to) for one save. */
	#take(): { entries: Array<[number, Uint8Array]>; gen: number } {
		const entries: Array<[number, Uint8Array]> = [];
		for (const b of this.dirty) {
			const v = this.mem.get(b)!;
			entries.push([b, v]);
			if (v !== ZERO) this.frozen.add(v);
		}
		this.dirty.clear();
		return { entries, gen: this.gen };
	}

	/** Save taken blocks in one store transaction, with their generation. */
	async #commit({ entries, gen }: { entries: Array<[number, Uint8Array]>; gen: number }): Promise<void> {
		if (!this.store || this.saveDisabled || (!entries.length && gen === this.storedGen)) return;
		const puts: Array<[number, Uint8Array]> = [], dels: number[] = [];
		for (const [b, v] of entries) {
			if (v === ZERO && this.base.zero) dels.push(b); // zeros = no record
			else puts.push([b, v]);                         // (ZERO on another base: an empty record)
		}
		try {
			await this.store.save(puts, dels, gen !== this.storedGen ? { gen } : undefined);
		} catch (e) {
			this.stats.saveErrors++;
			for (const [b, v] of entries) {
				// Written again meanwhile? Then the newer content is dirty already.
				if (this.mem.get(b) === v) this.dirty.add(b);
				if (v !== ZERO) this.frozen.delete(v);
			}
			const err = e as Error;
			this.log(`[host] block: saving ${entries.length} blocks failed: ${err?.name ?? ""} ${err?.message ?? e}`);
			try { this.onError?.(e); } catch {}
			throw e;
		}
		if (gen > this.storedGen) this.storedGen = gen;
		this.stats.saves++;
		this.stats.blocksSaved += puts.length;
		this.stats.blocksDeleted += dels.length;
		for (const [b, v] of entries) {
			if (v === ZERO && this.base.zero) this.stored.delete(b);
			else this.stored.add(b);
			if (v !== ZERO) this.frozen.delete(v);
			this.loading.delete(b); // a later store read must see this record
			// Written again since? Then it stays (and is dirty).
			if (!this.dirty.has(b) && this.mem.get(b) === v) this.mem.delete(b);
		}
	}

	// --- snapshots -----------------------------------------------------------

	snapshotState(): DiskSnapshotState {
		if (this.persistent) {
			const name = this.store!.name ?? "store";
			return { name, identity: `store ${name} ${this.storeIdentity ?? ""} uid=${this.storeUid ?? "-"}`, gen: this.gen };
		}
		// The overlay lives in this process only: fine while there is none.
		const name = this.base.identity || "an in-memory disk";
		if (this.gen || this.mem.size) throw new Error(`${name} keeps its writes in memory only, and a snapshot does not save them`);
		if (!this.base.identity) throw new Error("its base image has no identity to check on restore");
		return { name, identity: `base ${this.base.identity}`, gen: 0 };
	}

	/**
	 * Take the dirty blocks now (no request is in flight, so no flush is
	 * queued) and save them with the current generation; later writes go
	 * to the next generation and later saves.
	 */
	snapshotSeal(): { state: DiskSnapshotState; done: Promise<void> } {
		const state = this.snapshotState();
		if (!this.persistent) return { state, done: Promise.resolve() };
		if (this.saving) throw new Error(`${state.name}: a save is in flight`);
		const taken = this.#take();
		this.#sealed = true;
		return { state, done: this.#chain(() => this.#commit(taken)) };
	}

	/** Stop saving to the store (before replacing or clearing it); the running kernel's further writes stay in memory. */
	detach(): void {
		this.saveDisabled = true;
	}

	/** Drop all local changes (memory and persisted). Only while the kernel is not running. */
	async reset(): Promise<void> {
		this.mem.clear();
		this.dirty.clear();
		this.stored.clear();
		this.ahead.clear();
		this.aheadPending.clear();
		if (this.store) await this.store.clear();
	}

	// --- export --------------------------------------------------------------

	/**
	 * The disk's current content as a kwsparse image (uncompressed), in
	 * parts (Blobs, so a browser can keep large exports out of the JS heap;
	 * gzipBlob() compresses them). Reads the store in batches. The base must
	 * be a ZeroBase or a SparseBase.
	 */
	async exportParts({ batch = 256 }: { batch?: number } = {}): Promise<{ size: number; blocks: number; parts: BlobPart[] }> {
		if (!this.base.zero && !this.base.keys) throw new Error("export needs a zero or sparse base");
		const keys = new Set([...(this.base.keys?.() ?? []), ...this.stored, ...this.mem.keys()]);
		const sorted = [...keys].sort((a, b) => a - b);
		const indices: number[] = [], parts: BlobPart[] = [];
		for (let i = 0; i < sorted.length; i += batch) {
			const part = sorted.slice(i, i + batch);
			const vals = new Map<number, Uint8Array>();
			const fromStore: number[] = [];
			for (const b of part) {
				const m = this.mem.get(b);
				if (m) vals.set(b, m === ZERO ? m : m.slice());
				else if (this.stored.has(b)) fromStore.push(b);
				else vals.set(b, this.base.read(b * BLOCK, BLOCK) as Uint8Array); // zero or sparse: synchronous
			}
			if (fromStore.length) for (const [b, v] of await this.#load(fromStore)) vals.set(b, v);
			const list: Uint8Array<ArrayBuffer>[] = [];
			for (const b of part) {
				const v = vals.get(b);
				if (!v || v === ZERO || !v.length || isZeroBlock(v)) continue;
				indices.push(b);
				list.push(v as Uint8Array<ArrayBuffer>);
			}
			if (list.length) parts.push(new Blob(list));
		}
		const head = kwsparseHeader(this.size, BLOCK, indices) as Uint8Array<ArrayBuffer>;
		return { size: this.size, blocks: indices.length, parts: [head, ...parts] };
	}
}

// ---------------------------------------------------------------------------
// Read-only base fetched lazily with HTTP Range requests.

/** The distro header in the first bytes of an image (format: distro.ts). */
export interface DistroHeader {
	/** The image's size when it was built (a header of another size is ignored). */
	size: number;
	/** Bytes from the start of the image that a boot reads (= size: the whole image; 0: no hint). */
	prefetch: number;
	/** The end of what to fetch in the background once the boot is done, [prefetch, background): the warm set (0: none). */
	background: number;
	/** The distro's name (/usr/lib/kw-distro) and image id (/usr/lib/kw-image). */
	distro: string;
	image: string;
}

const HEADER_MAGIC = "KWDISTRO";

/** The total size in a 206 response's Content-Range. */
const totalOf = (r: Response): number | undefined => {
	const m = /\/(\d+)\s*$/.exec(r.headers.get("content-range") ?? "");
	return m ? Number(m[1]) : undefined;
};

/** The distro header at offset 0 of an image, or null (none, another version, or another size than `size`). */
export function readDistroHeader(head: Uint8Array, size?: number): DistroHeader | null {
	if (head.length < 128) return null;
	for (let i = 0; i < 8; i++) if (head[i] !== HEADER_MAGIC.charCodeAt(i)) return null;
	const dv = new DataView(head.buffer, head.byteOffset, 128);
	const hlen = dv.getUint32(12, true);
	if (dv.getUint32(8, true) !== 1 || hlen < 128) return null;
	const n = Number(dv.getBigUint64(16, true)), prefetch = Math.min(Number(dv.getBigUint64(24, true)), n);
	if (size !== undefined && n !== size) return null;
	// A longer header (136) adds `background` at 128; one that names no more than the prefetch means none.
	const bg = hlen >= 136 && head.length >= 136 ? Math.min(Number(new DataView(head.buffer, head.byteOffset, 136).getBigUint64(128, true)), n) : 0;
	const str = (b: Uint8Array) => new TextDecoder().decode(b.subarray(0, b.indexOf(0) < 0 ? b.length : b.indexOf(0)));
	return { size: n, prefetch, background: bg > prefetch ? bg : 0, distro: str(head.subarray(32, 64)), image: str(head.subarray(64, 128)) };
}

export interface HttpBaseOptions {
	/** Fetch granularity (power of two), default 256 KiB. */
	chunkSize?: number;
	/** Largest single Range request, default 4 MiB. */
	maxRequest?: number;
	/**
	 * Read-ahead for sequential readers: a read that misses right after
	 * chunks already here (or on their way) also fetches the chunks after
	 * it, in a separate request, four chunks at first and doubling while the
	 * reader keeps up, up to this many bytes; the next window is asked for
	 * once the reader is halfway into the last one. Chunks arrive streamed,
	 * so a read waits only for its own bytes, and a failed read-ahead only
	 * leaves its chunks to lazy reads. Default 4 MiB; 0 or false: off.
	 */
	readAhead?: number | false;
	/**
	 * Every range must come from the image open() saw: the same total size
	 * and, when open() got one, the same ETag (or Last-Modified). A range of
	 * a changed image then fails (EIO in the guest) instead of mixing two
	 * images' blocks. Default false.
	 */
	strict?: boolean;
	/**
	 * Fetch the first `prefetch` bytes right after open(), in one streaming
	 * request (the image's size: one plain GET of the whole image, which
	 * HTTP caches keep). Reads inside it wait for its bytes instead of
	 * making their own requests; reads after it are lazy ranges, and so is
	 * everything if it fails. Default: what the image's distro header says
	 * (distro.ts), else nothing; false: nothing.
	 */
	prefetch?: number | false;
	/**
	 * Then fetch [prefetch, background) in the background (the warm set:
	 * what the first commands after the boot read): once the prefetch has
	 * settled, the image has been read from (the guest runs: an image is
	 * often opened while its kernel still loads) and then neither read nor
	 * requested for a second (the boot is done),
	 * in sequential streamed pieces of `maxRequest` bytes, one at a time, so
	 * a read waits at most for its own bytes of the piece in flight and
	 * fetches chunks of a later piece itself. Not with the browser's Save-Data
	 * set. Default: what the image's distro header says, unless `prefetch`
	 * is false; false: nothing.
	 */
	background?: number | false;
	/** Host diagnostics (a failed prefetch); default console.warn. */
	log?: (msg: string) => void;
}

/** What an HttpBase fetched (HttpBase.stats). */
export interface HttpBaseStats {
	/** Requests (open()'s probe included) and the bytes they brought. */
	requests: number;
	bytes: number;
	/** Range requests made for reads (not the probe, the prefetch or read-ahead). */
	lazyRequests: number;
	/** The prefetch: its size (0: none), the bytes it brought, and how it went. */
	prefetch: number;
	prefetchBytes: number;
	prefetchState: "none" | "running" | "done" | "failed";
	/** The background tier [prefetch, background) fetched after the boot settles: its end (0: none), the bytes it brought, and how it went. */
	background: number;
	backgroundBytes: number;
	backgroundState: "none" | "waiting" | "running" | "done" | "failed" | "skipped";
	/** Read-ahead (HttpBaseOptions.readAhead): range requests made ahead of a sequential reader, and the bytes they brought. */
	aheadRequests: number;
	aheadBytes: number;
}

export class HttpBase implements DiskBase {
	url = "";
	size = 0;
	identity = "";
	chunkSize = 0;
	maxChunks = 0;
	/** Chunk index -> data. */
	chunks: Map<number, Uint8Array> = new Map();
	/** Chunk index -> fetch in flight (a prefetched chunk: until its bytes arrived). */
	pending: Map<number, Promise<void>> = new Map();
	/** read() calls so far (the background tier waits for the first, then for a second without one). */
	#reads = 0;
	stats: HttpBaseStats = {
		requests: 0, bytes: 0, lazyRequests: 0, prefetch: 0, prefetchBytes: 0, prefetchState: "none",
		background: 0, backgroundBytes: 0, backgroundState: "none", aheadRequests: 0, aheadBytes: 0,
	};
	/** strict: the ETag or Last-Modified open() saw ("" if none), which every range must carry. */
	validator: string | null = null;
	/** The distro header of the image, if it has one. */
	header: DistroHeader | null = null;
	log: (msg: string) => void = (m) => console.warn(m);

	/**
	 * Open the image: one Range request for its first chunk, which tells the
	 * size, the validator and the distro header (and is kept). Then the
	 * prefetch, if any, starts (see HttpBaseOptions.prefetch), and the
	 * background tier waits for its turn (HttpBaseOptions.background).
	 */
	static async open(url: string, { chunkSize = 256 * 1024, maxRequest = 4 * 1024 * 1024, readAhead = 4 * 1024 * 1024, strict = false, prefetch, background, log }: HttpBaseOptions = {}): Promise<HttpBase> {
		// The one request that asks the server (a cached copy is revalidated):
		// its validator is what every later, cached response is held to.
		const r = await fetch(url, { headers: { range: `bytes=0-${chunkSize - 1}` }, cache: "no-cache" });
		if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
		const cr = r.headers.get("content-range");
		const m = cr && /\/(\d+)\s*$/.exec(cr);
		if (r.status !== 206 || !m) {
			void r.body?.cancel().catch(() => {});
			throw new Error(`${url}: server does not support Range requests`);
		}
		const head = new Uint8Array(await r.arrayBuffer());
		const b = new HttpBase();
		b.url = url;
		b.size = Number(m[1]);
		if (log) b.log = log;
		const validator = r.headers.get("etag") ?? r.headers.get("last-modified") ?? "";
		b.identity = `${url} ${b.size} ${validator}`;
		if (strict) b.validator = validator;
		b.#seen = validator;
		b.chunkSize = chunkSize;
		b.maxChunks = Math.max(1, Math.floor(maxRequest / chunkSize));
		b.#aheadMax = readAhead ? Math.max(1, Math.floor(readAhead / chunkSize)) : 0;
		b.stats.requests++;
		b.stats.bytes += head.length;
		if (head.length === Math.min(chunkSize, b.size)) {
			let c0 = head;
			if (c0.length < chunkSize) {
				c0 = new Uint8Array(chunkSize);
				c0.set(head);
			}
			b.chunks.set(0, c0);
		}
		b.header = readDistroHeader(head, b.size);
		const n = prefetch === false ? 0 : Math.min(b.size, Math.max(0, prefetch ?? b.header?.prefetch ?? 0));
		const boot = n > 0 ? b.#prefetch(n, validator) : Promise.resolve();
		const bg = background === false || (prefetch === false && background === undefined) ? 0
			: Math.min(b.size, Math.max(0, background ?? b.header?.background ?? 0));
		if (bg > n) void b.#background(n, bg, validator, boot);
		return b;
	}

	read(off: number, len: number): MaybePromise<Uint8Array> {
		this.#reads++;
		const cs = this.chunkSize;
		const c0 = Math.floor(off / cs), c1 = Math.floor((off + len - 1) / cs);
		const waits: Promise<void>[] = [];
		let runStart = -1, miss = -1;
		const flushRun = (end: number) => {
			if (runStart >= 0) waits.push(this.#fetchRun(runStart, end));
			runStart = -1;
		};
		for (let c = c0; c <= c1; c++) {
			if (this.chunks.has(c)) { flushRun(c); continue; }
			const p = this.pending.get(c);
			if (p) { flushRun(c); waits.push(p); continue; }
			if (runStart < 0) runStart = c;
			if (miss < 0) miss = c;
			if (c - runStart + 1 >= this.maxChunks) flushRun(c + 1);
		}
		flushRun(c1 + 1);
		if (this.#aheadMax) this.#readAhead(miss, c1);
		const assemble = () => {
			if (c0 === c1) {
				const s = off - c0 * cs;
				return this.chunks.get(c0)!.subarray(s, s + len);
			}
			const out = new Uint8Array(len);
			for (let c = c0; c <= c1; c++) {
				const s = Math.max(off, c * cs), e = Math.min(off + len, (c + 1) * cs);
				out.set(this.chunks.get(c)!.subarray(s - c * cs, e - c * cs), s - off);
			}
			return out;
		};
		if (!waits.length) return assemble();
		// A failed prefetch settles its chunks without data: read them again (lazily).
		return Promise.all(waits).then(() => {
			for (let c = c0; c <= c1; c++) if (!this.chunks.has(c)) return this.read(off, len);
			return assemble();
		});
	}

	/** Check a response against the image open() saw: its size (`total`, if known) and, if given, its validator. */
	#check(r: Response, total: number | undefined, what: string, validator: string | null = this.validator): void {
		const v = r.headers.get("etag") ?? r.headers.get("last-modified") ?? "";
		if ((total === undefined || total === this.size) && !(validator && v && v !== validator)) return;
		void r.body?.cancel().catch(() => {});
		throw new Error(`${this.url}: ${what}: the image changed since it was opened (size ${total ?? "?"}, ${v || "no validator"}; opened as ${this.size}, ${validator || "no validator"})`);
	}

	/** The validator open() saw ("" if the server sends none). */
	#seen = "";

	/**
	 * Fetch a part of the image, from the browser's HTTP cache if it has it,
	 * without asking the server again: open() already did, and `ok` holds
	 * the response to that validator (#check). A cached copy that fails (it
	 * is of another build of the image) is fetched again from the server.
	 * Without a validator nothing could tell a stale copy, so the cache
	 * mode is the browser's default.
	 */
	async #get(headers: Record<string, string> | undefined, ok: (r: Response) => void): Promise<Response> {
		const init: RequestInit = headers ? { headers } : {};
		if (!this.#seen) {
			const r = await fetch(this.url, init);
			ok(r);
			return r;
		}
		const cached = await fetch(this.url, { ...init, cache: "force-cache" });
		try {
			ok(cached);
			return cached;
		} catch {}
		const r = await fetch(this.url, { ...init, cache: "reload" });
		ok(r);
		return r;
	}

	/** Read-ahead (HttpBaseOptions.readAhead): the largest window in chunks (0: off), the chunk after the last window (-1: none) and its size. */
	#aheadMax = 0;
	#aheadEnd = -1;
	#aheadWin = 0;

	/**
	 * After a read of chunks up to `last` that fetched from chunk `miss` on
	 * (-1: it fetched nothing): a miss right after chunks here or on their
	 * way starts a window after the read (or, when the reader caught up with
	 * the last window, a window twice its size); a read halfway into the last
	 * window asks for the next one, twice its size. A window stops before a
	 * chunk that is here or on its way, and at the end of the image.
	 */
	#readAhead(miss: number, last: number): void {
		const max = this.#aheadMax;
		let from: number, win: number;
		if (miss > 0 && (this.chunks.has(miss - 1) || this.pending.has(miss - 1))) {
			win = Math.min(max, miss === this.#aheadEnd ? this.#aheadWin * 2 : 4);
			from = last + 1;
		} else if (miss < 0 && last < this.#aheadEnd && last >= this.#aheadEnd - Math.ceil(this.#aheadWin / 2)) {
			win = Math.min(max, this.#aheadWin * 2);
			from = this.#aheadEnd;
		} else return;
		const n = Math.ceil(this.size / this.chunkSize);
		let to = from;
		while (to < n && to - from < win && !this.chunks.has(to) && !this.pending.has(to)) to++;
		if (to === from) return;
		this.#aheadEnd = to;
		this.#aheadWin = win;
		void this.#fetchRun(from, to, true);
	}

	/**
	 * Fetch chunks [c0, c1) in one Range request, streamed: each chunk is
	 * kept, and its readers resume, as soon as its bytes are in. If the
	 * request fails, a read's chunks reject (the guest gets EIO), while a
	 * read-ahead's (`ahead`) settle without data, so that their reads fetch
	 * them lazily; the returned promise never rejects for a read-ahead.
	 */
	#fetchRun(c0: number, c1: number, ahead = false): Promise<void> {
		const cs = this.chunkSize;
		const start = c0 * cs, end = Math.min(this.size, c1 * cs);
		const settle = new Map<number, { p: Promise<void>; ok: () => void; fail: (e: unknown) => void }>();
		for (let c = c0; c < c1; c++) {
			let ok!: () => void, fail!: (e: unknown) => void;
			const p = new Promise<void>((res, rej) => { ok = res; fail = rej; });
			p.catch(() => {});   // a chunk nobody waits for may reject
			settle.set(c, { p, ok, fail });
			this.pending.set(c, p);
		}
		const done = (c: number, err?: unknown) => {
			const s = settle.get(c);
			if (!s) return;
			settle.delete(c);
			if (this.pending.get(c) === s.p) this.pending.delete(c);
			if (err === undefined || ahead) s.ok();
			else s.fail(err);
		};
		const what = `${ahead ? "read-ahead" : "range"} ${start}-${end - 1}`;
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		return (async () => {
			this.stats.requests++;
			if (ahead) this.stats.aheadRequests++;
			else this.stats.lazyRequests++;
			const r = await this.#get({ range: `bytes=${start}-${end - 1}` }, (r) => {
				if (r.status !== 206) throw new Error(`${this.url}: ${what}: HTTP ${r.status}`);
				if (this.validator !== null || this.#seen)
					this.#check(r, totalOf(r) ?? -1, what, this.validator ?? this.#seen);
			});
			if (!r.body) throw new Error(`${this.url}: ${what}: no response body`);
			reader = r.body.getReader();
			let pos = start, c = c0, cur = new Uint8Array(cs), fill = 0;
			for (;;) {
				const { done: eof, value } = await reader.read();
				if (eof) break;
				if (pos + value.length > end) throw new Error(`${this.url}: ${what}: longer than asked`);
				let o = 0;
				while (o < value.length) {
					const k = Math.min(cs - fill, value.length - o);
					cur.set(value.subarray(o, o + k), fill);
					fill += k;
					o += k;
					if (fill === cs || pos + o === end) {
						this.#put(c, fill === cs ? cur : cur.subarray(0, fill));
						done(c++);
						cur = new Uint8Array(cs);
						fill = 0;
					}
				}
				pos += value.length;
				this.stats.bytes += value.length;
				if (ahead) this.stats.aheadBytes += value.length;
			}
			if (pos !== end) throw new Error(`${this.url}: ${what}: short range read`);
		})().catch((e: unknown) => {
			void reader?.cancel().catch(() => {});
			const err = e ?? new Error(`${this.url}: ${what} failed`);
			for (const c of [...settle.keys()]) done(c, err);
			if (!ahead) throw err;
			this.log(`[host] ${this.url}: ${what} failed (${(e as Error)?.message ?? e}); reading lazily`);
		});
	}

	/** Keep chunk c (the last one padded, so block reads are uniform). */
	#put(c: number, data: Uint8Array): void {
		if (data.length < this.chunkSize) {
			const full = new Uint8Array(this.chunkSize);
			full.set(data);
			data = full;
		}
		this.chunks.set(c, data);
	}

	/**
	 * The boot prefetch: [0, n) in one streamed request (#stream; n = size: a
	 * plain GET of the whole image). A failure leaves its chunks to lazy
	 * reads. The promise settles when it is over, and never rejects.
	 */
	#prefetch(n: number, validator: string): Promise<void> {
		const whole = n >= this.size;
		this.stats.prefetch = whole ? this.size : Math.min(this.size, Math.ceil(n / this.chunkSize) * this.chunkSize);
		this.stats.prefetchState = "running";
		return this.#stream(0, n, validator, "prefetch", (k) => { this.stats.prefetchBytes += k; }).then(() => {
			this.stats.prefetchState = "done";
		}, (e: unknown) => {
			this.stats.prefetchState = "failed";
			this.log(`[host] ${this.url}: prefetch failed (${(e as Error)?.message ?? e}); reading lazily`);
		});
	}

	/**
	 * The background tier (HttpBaseOptions.background): [from, to) once
	 * `boot` (the prefetch) has settled, the first read() has come and then
	 * no read() and no request for a second, in pieces of maxChunks chunks,
	 * one after the other. A failed
	 * piece ends it (what is left is read lazily).
	 */
	async #background(from: number, to: number, validator: string, boot: Promise<void>): Promise<void> {
		this.stats.background = to;
		this.stats.backgroundState = "waiting";
		if ((globalThis as { navigator?: { connection?: { saveData?: boolean } } }).navigator?.connection?.saveData) {
			this.stats.backgroundState = "skipped";
			return;
		}
		await boot;
		const nap = (ms: number) => new Promise<void>((r) => (setTimeout(r, ms) as unknown as { unref?: () => void }).unref?.());
		while (!this.#reads) await nap(250);
		for (let seen = this.stats.requests + this.#reads, quiet = 0; quiet < 1000;) {
			await nap(250);
			const now = this.stats.requests + this.#reads;
			if (now !== seen || this.pending.size) { seen = now; quiet = 0; } else quiet += 250;
		}
		this.stats.backgroundState = "running";
		const piece = this.maxChunks * this.chunkSize;
		try {
			for (let a = from; a < to; a += piece)
				await this.#stream(a, Math.min(to, a + piece), validator, "background", (k) => { this.stats.backgroundBytes += k; });
			this.stats.backgroundState = "done";
		} catch (e) {
			this.stats.backgroundState = "failed";
			this.log(`[host] ${this.url}: background fetch failed (${(e as Error)?.message ?? e}); reading lazily`);
		}
	}

	/**
	 * Fetch [start, end) in one request, streamed: each chunk is kept as soon
	 * as its bytes are in, and reads of a chunk not in yet wait for it. The
	 * request starts at the first chunk not here and ends after the last one
	 * (nothing missing: no request); chunks in between that are here or on
	 * their way are left as they are. [0, size): a plain GET (no Range
	 * header). Every response is checked like a lazy range (size, and the
	 * validator whether strict or not: a cached copy of another image must
	 * not mix in). A failure rejects and settles the chunks that did not
	 * arrive without data, so their reads fall back to lazy ranges.
	 */
	async #stream(start: number, end: number, validator: string, what: string, count: (n: number) => void): Promise<void> {
		const cs = this.chunkSize, whole = start === 0 && end >= this.size;
		let c0 = Math.floor(start / cs), c1 = Math.ceil(Math.min(end, this.size) / cs);
		if (!whole) {
			while (c0 < c1 && (this.chunks.has(c0) || this.pending.has(c0))) c0++;
			while (c1 > c0 && (this.chunks.has(c1 - 1) || this.pending.has(c1 - 1))) c1--;
		}
		if (c0 >= c1) return;
		const settle = new Map<number, () => void>();
		for (let c = c0; c < c1; c++) {
			if (this.chunks.has(c) || this.pending.has(c)) continue;
			const p = new Promise<void>((resolve) => settle.set(c, resolve));
			this.pending.set(c, p);
		}
		const done = (c: number) => {
			const s = settle.get(c);
			if (!s) return;
			settle.delete(c);
			this.pending.delete(c);
			s();
		};
		const from = whole ? 0 : c0 * cs, to = whole ? this.size : Math.min(this.size, c1 * cs);
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		try {
			this.stats.requests++;
			const r = await this.#get(whole ? undefined : { range: `bytes=${from}-${to - 1}` }, (r) => {
				if (whole) {
					if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
					const len = r.headers.get("content-encoding") ? null : r.headers.get("content-length");
					this.#check(r, len === null ? undefined : Number(len), "GET", validator);
				} else {
					if (r.status !== 206) throw new Error(`HTTP ${r.status}`);
					this.#check(r, totalOf(r) ?? -1, `${what} ${from}-${to - 1}`, validator);
				}
			});
			if (!r.body) throw new Error("no response body");
			reader = r.body.getReader();
			let pos = from, cur = new Uint8Array(cs), fill = 0;
			for (;;) {
				const { done: eof, value } = await reader.read();
				if (eof) break;
				let o = 0;
				while (o < value.length) {
					if (pos + o >= to) throw new Error("longer than expected");
					const k = Math.min(cs - fill, value.length - o, to - pos - o);
					cur.set(value.subarray(o, o + k), fill);
					fill += k;
					o += k;
					const at = pos + o;
					if (fill === cs || at === to) {
						const c = Math.floor((at - 1) / cs);
						if (!this.chunks.has(c)) this.#put(c, fill === cs ? cur : cur.subarray(0, fill));
						done(c);
						cur = new Uint8Array(cs);
						fill = 0;
					}
				}
				pos += value.length;
				this.stats.bytes += value.length;
				count(value.length);
			}
			if (pos !== to) throw new Error(`ended at ${pos} of ${to}`);
		} catch (e) {
			void reader?.cancel().catch(() => {});
			throw e;
		} finally {
			for (const c of [...settle.keys()]) done(c);
		}
	}
}

// ---------------------------------------------------------------------------
// A read-only disk straight from a base (no overlay): a distro image.

/**
 * A read-only BlockDevice that reads a DiskBase (e.g. an HttpBase) with no
 * overlay: the guest's writes fail with EROFS. In a snapshot it is the
 * base's identity.
 */
export class BaseDisk implements BlockDevice {
	base: DiskBase;
	size: number;
	readonly readOnly = true;
	readonly flags = F_RO;

	constructor(base: DiskBase) {
		this.base = base;
		this.size = Math.floor(base.size / 512) * 512;
	}

	/** The base's fetch counters (an HttpBase's, see HttpBaseStats), if it keeps any. */
	get stats(): HttpBaseStats | undefined {
		return (this.base as { stats?: HttpBaseStats }).stats;
	}

	read(off: number, views: Uint8Array[]): MaybePromise<void> {
		const len = views.reduce((n, v) => n + v.length, 0);
		const r = this.base.read(off, len);
		return r instanceof Promise ? r.then((buf) => scatter(views, buf)) : scatter(views, r);
	}

	write(): never {
		throw new Error("read-only disk");
	}

	snapshotState(): DiskSnapshotState {
		if (!this.base.identity) throw new Error("its base image has no identity to check on restore");
		return { name: this.base.identity, identity: `base ${this.base.identity}`, gen: 0 };
	}

	snapshotSeal(): { state: DiskSnapshotState; done: Promise<void> } {
		return { state: this.snapshotState(), done: Promise.resolve() };
	}
}
