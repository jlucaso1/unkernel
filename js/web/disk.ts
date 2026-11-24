// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Browser disks: an image served over HTTP (read lazily with Range
// requests) under a copy-on-write overlay that is saved in IndexedDB, and
// the persistent data disk (an ext4 file system kept in IndexedDB).
import { BaseDisk, CowDisk, HttpBase, SparseBase, ZeroBase, type OverlayStore, type StoreIndex } from "../core/block.ts";
import { DistroDisk } from "../core/distro.ts";
import { decodeKwsparse, gunzipIfNeeded, type KwsparseImage } from "../core/kwsparse.ts";

const BLOCK = 4096;

// ---------------------------------------------------------------------------
// Overlay persistence in IndexedDB (one database per disk name).
//
// Object stores: "blocks" (block number -> Uint8Array(4096), or an empty
// Uint8Array for a block of zeros over a non-zero base) and "meta"
// ("identity": what the blocks belong to; "initialized": a seeded data disk;
// "uid": a random id, new whenever the store is created, seeded or cleared;
// "gen": the disk's write generation, saved in the same transaction as the
// blocks, which machine snapshots check, see core/block.ts).
//
// Every save is one readwrite transaction, so the stored state is always
// the state after some complete flush. Transactions use durability
// "strict": the kernel issues a flush where it needs data to be durable
// (fsync, sync, an ext4 journal commit every 5 s), and a strict commit is
// flushed to the device before it completes, so it also survives an OS crash
// or power loss, not only a closed tab or a browser crash. The cost is one
// device flush per guest flush; "relaxed" would still keep each flush atomic
// and in order, but could lose the newest ones.

const reqP = <T>(r: IDBRequest<T>): Promise<T> =>
	new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

// Not crypto.randomUUID(): that needs a secure context, and the page also runs on plain http.
const newUid = (): string => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

export interface IdbStoreOptions {
	log?: ((msg: string) => void) | null;
	durability?: IDBTransactionDurability;
}

/** Overlay persistence in IndexedDB: database "kwdisk:<name>". */
export class IdbStore implements OverlayStore {
	readonly name: string;
	log: (msg: string) => void;
	durability: IDBTransactionDurability;
	dbp: Promise<IDBDatabase> | null = null;

	constructor(name: string, { log = null, durability = "strict" }: IdbStoreOptions = {}) {
		this.name = `kwdisk:${name}`;
		this.log = log ?? ((m) => console.warn(m));
		this.durability = durability;
	}

	/** The open connection, reopened if the browser closed it or another version needs it. */
	#open(): Promise<IDBDatabase> {
		if (this.dbp) return this.dbp;
		const p: Promise<IDBDatabase> = new Promise((resolve, reject) => {
			const r = indexedDB.open(this.name, 1);
			r.onupgradeneeded = () => {
				r.result.createObjectStore("blocks");
				r.result.createObjectStore("meta");
			};
			r.onsuccess = () => {
				const db = r.result;
				db.onversionchange = () => {
					// Another tab deletes or upgrades the database: let it.
					this.log(`[host] ${this.name}: closing the IndexedDB connection (version change requested elsewhere)`);
					db.close();
					if (this.dbp === p) this.dbp = null;
				};
				// The browser closed it (storage cleared, disk error): reopen on next use.
				db.onclose = () => { if (this.dbp === p) this.dbp = null; };
				resolve(db);
			};
			r.onerror = () => reject(r.error);
			r.onblocked = () => this.log(`[host] ${this.name}: waiting for another tab to release IndexedDB`);
		});
		this.dbp = p;
		p.catch(() => { if (this.dbp === p) this.dbp = null; });
		return p;
	}

	static #done(tx: IDBTransaction): Promise<void> {
		return new Promise((resolve, reject) => {
			tx.oncomplete = () => resolve();
			tx.onerror = tx.onabort = () => reject(tx.error ?? new DOMException("IndexedDB transaction aborted", "AbortError"));
		});
	}

	/**
	 * Run fn(tx) in a transaction and wait for it to commit; returns what fn
	 * returned (awaited). A failure other than a full quota is retried once
	 * on a fresh connection (fn must be idempotent).
	 */
	async #run<T>(stores: string | string[], mode: IDBTransactionMode, fn: (tx: IDBTransaction) => T | Promise<T>, retry = true): Promise<T> {
		try {
			const db = await this.#open();
			const tx = db.transaction(stores, mode, mode === "readwrite" ? { durability: this.durability } : undefined);
			const done = IdbStore.#done(tx);
			let r: Promise<T>;
			try {
				r = Promise.resolve(fn(tx));
			} catch (e) {
				done.catch(() => {});
				tx.abort();
				throw e;
			}
			r.catch(() => {});
			await done;
			return await r;
		} catch (e) {
			const err = e as Error;
			if (!retry || err?.name === "QuotaExceededError") throw e;
			this.log(`[host] ${this.name}: ${err?.name ?? "error"}: ${err?.message ?? e}; reopening and retrying once`);
			if (this.dbp) {
				try { (await this.dbp).close(); } catch {}
				this.dbp = null;
			}
			return this.#run(stores, mode, fn, false);
		}
	}

	/**
	 * Read the index: the numbers of all stored blocks (not their data).
	 * If the database belongs to another identity: onMismatch "clear" drops
	 * the blocks (logged loudly), "refuse" leaves everything alone and
	 * returns {mismatch: storedIdentity}. With write: false nothing is
	 * written (a read-only transaction; a fresh database stays unmarked).
	 */
	async open(identity: string, { onMismatch = "refuse", write = true }: { onMismatch?: "clear" | "refuse"; write?: boolean } = {}): Promise<StoreIndex> {
		const res = await this.#run<StoreIndex>(["blocks", "meta"], write ? "readwrite" : "readonly", async (tx) => {
			const blocks = tx.objectStore("blocks"), meta = tx.objectStore("meta");
			let [id, init, gen, uid0] = await Promise.all([reqP(meta.get("identity")), reqP(meta.get("initialized")),
				reqP(meta.get("gen")), reqP(meta.get("uid"))]);
			// A reset that was cut off before its blocks were deleted (clear()):
			// the disk is empty, and a writer finishes the job here.
			if (await reqP(meta.get("reset"))) {
				if (!write) return { keys: new Set(), initialized: false, gen: 0 };
				blocks.clear();
				meta.clear();
				id = init = gen = uid0 = undefined;
			}
			if (id !== undefined && id !== identity) {
				if (onMismatch !== "clear" || !write) return { keys: new Set(), initialized: !!init, mismatch: String(id) };
				blocks.clear();
				meta.delete("initialized");
				meta.delete("gen");
				const uid = newUid();
				meta.put(uid, "uid");
				meta.put(identity, "identity");
				return { keys: new Set(), initialized: false, cleared: String(id), gen: 0, uid };
			}
			if (id === undefined && write) meta.put(identity, "identity");
			let uid = typeof uid0 === "string" ? uid0 : undefined;
			if (uid === undefined && write) meta.put(uid = newUid(), "uid");
			const keys = await reqP(blocks.getAllKeys());
			return { keys: new Set(keys as number[]), initialized: !!init, gen: typeof gen === "number" ? gen : 0, uid };
		});
		if (res.cleared !== undefined) {
			this.log(`[host] ${this.name}: THE SAVED CHANGES WERE DROPPED: they belong to another image ` +
				`("${res.cleared}", now "${identity}")`);
		}
		return res;
	}

	/** Records for the given block numbers: Map block -> Uint8Array (missing blocks are absent). */
	async getBlocks(blocks: number[]): Promise<Map<number, Uint8Array>> {
		if (!blocks.length) return new Map();
		let lo = Infinity, hi = -Infinity;
		for (const b of blocks) { if (b < lo) lo = b; if (b > hi) hi = b; }
		const want = new Set(blocks);
		return this.#run("blocks", "readonly", async (tx) => {
			const s = tx.objectStore("blocks");
			const out = new Map<number, Uint8Array>();
			if (want.size === 1) {
				const v = await reqP(s.get(lo));
				if (v !== undefined) out.set(lo, v as Uint8Array);
				return out;
			}
			const range = IDBKeyRange.bound(lo, hi);
			const [keys, vals] = await Promise.all([reqP(s.getAllKeys(range)), reqP(s.getAll(range))]);
			for (let i = 0; i < keys.length; i++) {
				const k = keys[i] as number;
				if (want.has(k)) out.set(k, vals[i] as Uint8Array);
			}
			return out;
		});
	}

	/** One transaction: put [block, data] pairs, delete block numbers, and record the write generation if given. */
	async save(puts: Array<[number, Uint8Array]>, dels: number[] = [], meta?: { gen: number }): Promise<void> {
		await this.#run(meta ? ["blocks", "meta"] : "blocks", "readwrite", (tx) => {
			const s = tx.objectStore("blocks");
			for (const [b, v] of puts) s.put(v, b); // structured clone happens here
			for (const b of dels) s.delete(b);
			if (meta) tx.objectStore("meta").put(meta.gen, "gen");
		});
	}

	/** One transaction: replace everything with these blocks and mark the store initialized (a new uid, generation 0). Returns the uid. */
	async seed(entries: Iterable<[number, Uint8Array]>, identity: string): Promise<string> {
		const uid = newUid();
		await this.#run(["blocks", "meta"], "readwrite", (tx) => {
			const s = tx.objectStore("blocks"), meta = tx.objectStore("meta");
			s.clear();
			for (const [b, v] of entries) s.put(v, b);
			meta.put(identity, "identity");
			meta.put(true, "initialized");
			meta.put(uid, "uid");
			meta.delete("gen");
			meta.delete("reset");
		});
		return uid;
	}

	/** All records, read in one transaction (a consistent snapshot). */
	async readAll(): Promise<Map<number, Uint8Array>> {
		return this.#run("blocks", "readonly", async (tx) => {
			const s = tx.objectStore("blocks");
			const [keys, vals] = await Promise.all([reqP(s.getAllKeys()), reqP(s.getAll())]);
			return new Map(keys.map((k, i) => [k as number, vals[i] as Uint8Array]));
		});
	}

	async count(): Promise<number> {
		return this.#run("blocks", "readonly", (tx) => reqP(tx.objectStore("blocks").count()));
	}

	/**
	 * Forget everything. Deleting a large disk's blocks takes a while, and a
	 * page that reloads meanwhile aborts the transaction, so a marker is
	 * committed first (a small transaction): open() treats a marked store
	 * as empty and finishes the deletion.
	 */
	async clear(): Promise<void> {
		await this.#run("meta", "readwrite", (tx) => { tx.objectStore("meta").put(true, "reset"); });
		await this.#run(["blocks", "meta"], "readwrite", (tx) => {
			tx.objectStore("blocks").clear();
			tx.objectStore("meta").clear();
		});
	}

	/** The stored identity, without reading the index (undefined: none, or a reset that was cut off). */
	async identity(): Promise<string | undefined> {
		return this.#run("meta", "readonly", async (tx) => {
			const meta = tx.objectStore("meta");
			const [id, reset] = await Promise.all([reqP(meta.get("identity")), reqP(meta.get("reset"))]);
			return reset || id === undefined ? undefined : String(id);
		});
	}

	/** Replace the identity `from` with `to` (one transaction; false if the stored identity is not `from`). The blocks stay. */
	async relabel(from: string, to: string): Promise<boolean> {
		return this.#run("meta", "readwrite", async (tx) => {
			const meta = tx.objectStore("meta");
			if (await reqP(meta.get("reset")) || await reqP(meta.get("identity")) !== from) return false;
			meta.put(to, "identity");
			return true;
		});
	}

	async close(): Promise<void> {
		const p = this.dbp;
		this.dbp = null;
		if (p) try { (await p).close(); } catch {}
	}
}

// ---------------------------------------------------------------------------
// HTTP disks.

export interface HttpDiskOptions {
	/** Name of the saved overlay (default: the URL). */
	name?: string;
	/** Save the overlay in IndexedDB on each flush (default true, if IndexedDB exists). */
	persist?: boolean;
	chunkSize?: number;
	log?: (msg: string) => void;
	/** A save failed (e.g. QuotaExceededError). */
	onError?: (err: unknown) => void;
}

/**
 * A disk image served over HTTP, read lazily with Range requests, written to
 * a copy-on-write overlay, optionally persisted in IndexedDB under `name`.
 * A saved overlay that belongs to another version of the image (size, ETag)
 * is dropped, loudly (it would corrupt the file system).
 */
export async function openHttpDisk(url: string, { name = url, persist = true, chunkSize, log, onError }: HttpDiskOptions = {}): Promise<CowDisk> {
	const base = await HttpBase.open(url, { chunkSize });
	const store = persist && typeof indexedDB !== "undefined" ? new IdbStore(name, { log }) : null;
	return new CowDisk(base, { store, log, onError }).open({ onMismatch: "clear" });
}

/** Drop the persisted overlay of a disk opened with openHttpDisk(…, {name}). */
export async function resetHttpDisk(name: string): Promise<void> {
	if (typeof indexedDB === "undefined") return;
	const s = new IdbStore(name);
	try {
		await s.clear();
	} finally {
		await s.close();
	}
}

/**
 * A distro image served over HTTP (relative to the page) as the read-only
 * disk createKernel({ distro }) takes: read lazily with Range requests,
 * after the prefetch its distro header asks for (`prefetch` overrides it,
 * false turns it off; HttpBaseOptions.prefetch), which starts here;
 * nothing kept in IndexedDB, every range checked against the image first
 * seen (HttpBase strict). For a caller that needs the disk before
 * booting (snapshotDiskMismatch(); the distro is the snapshot's first disk);
 * createKernel({ distro: url }) opens it the same way. The disk's `stats`
 * say what was fetched.
 */
export async function openDistroDisk(url: string, { chunkSize, prefetch, log }: { chunkSize?: number; prefetch?: number | false; log?: (msg: string) => void } = {}): Promise<DistroDisk> {
	const abs = typeof location === "object" && location?.href ? new URL(url, location.href).href : url;
	return DistroDisk.open(new BaseDisk(await HttpBase.open(abs, { chunkSize, prefetch, log, strict: true })), { name: abs, log });
}

// ---------------------------------------------------------------------------
// The data disk: an ext4 file system (label kwdata) that persists across
// page loads. Its template (kernel/build.sh datadisk, a kwsparse image,
// bundled as the custom section "unkernel.datadisk") is copied into the
// store on first use; after that the store alone holds the disk (over a
// ZeroBase), and is never reset implicitly: it is keyed by the format
// version, not by the template.
//
// Its size is in the store's identity. The template is 4 GiB; a larger
// disk (openDataDisk's `size`) is the template's blocks on a larger zero
// base, and the guest's /init grows the file system to the device at boot
// (`kwbox growfs`). A saved disk grows to a larger `size` (its identity is
// relabelled; the new space reads as zeros) and never shrinks.

export const DATA_DISK_NAME = "kwdata";
export const DATA_DISK_VERSION = "v1";

export interface DataDiskNameOptions {
	/** Default "kwdata". */
	name?: string;
	/** Format version, default DATA_DISK_VERSION. */
	version?: string;
	log?: (msg: string) => void;
}

/** The store of a data disk: database "kwdisk:<name>-<version>" and its identity. */
export function dataDiskStore(size: number, { name = DATA_DISK_NAME, version = DATA_DISK_VERSION, log }: DataDiskNameOptions = {}): { store: IdbStore; identity: string } {
	const id = `${name}-${version}`;
	return { store: new IdbStore(id, { log }), identity: `${id} size=${size} bs=${BLOCK}` };
}

/** The size in a data disk identity of this name and version (dataDiskStore()), else undefined. */
function identitySize(identity: string | undefined, name: string, version: string): number | undefined {
	const m = identity?.match(/^(.*) size=(\d+) bs=(\d+)$/);
	return m && m[1] === `${name}-${version}` && Number(m[3]) === BLOCK ? Number(m[2]) : undefined;
}

export interface OpenDataDiskOptions extends DataDiskNameOptions {
	/** The template: a kwsparse image (gzipped or not), or a decoded one. */
	template: Uint8Array | ArrayBuffer | KwsparseImage;
	/**
	 * "persistent" (default): the IndexedDB store, seeded from the template
	 * on first use. "snapshot": memory only, starting from a consistent copy
	 * of the saved disk if it is at most snapshotLimit bytes, else from the
	 * template (e.g. another tab owns the disk).
	 */
	mode?: "persistent" | "snapshot";
	/** Default 64 MiB. */
	snapshotLimit?: number;
	/**
	 * The disk's size in bytes (rounded down to 4 KiB, at least the
	 * template's): a new disk is made this large, a saved disk smaller than
	 * this grows to it, a larger one keeps its size (a disk never shrinks).
	 * The guest's /init grows the file system to the device. Default: the
	 * saved disk's size, or the template's for a new one. Snapshot mode never
	 * grows a saved disk.
	 */
	size?: number;
	onError?: (err: unknown) => void;
}

/**
 * Open the data disk. The result has .persistent, and .notice when it is
 * not the persistent disk. Throws a DataDiskFormatError if the saved disk
 * has another identity (format); nothing is cleared, the caller decides (the
 * page runs a snapshot of the template and says why).
 */
export async function openDataDisk({ name = DATA_DISK_NAME, version = DATA_DISK_VERSION, template, mode = "persistent",
	snapshotLimit = 64 * 1048576, size, log = (m) => console.warn(m), onError }: OpenDataDiskOptions): Promise<CowDisk> {
	const tpl = "indices" in template ? template : decodeKwsparse(await gunzipIfNeeded(template));
	if (tpl.blockSize !== BLOCK) throw new Error(`data disk template: block size ${tpl.blockSize}, need ${BLOCK}`);
	const haveIdb = typeof indexedDB !== "undefined";
	const want = size !== undefined && size > 0 ? Math.max(tpl.size, Math.floor(size / BLOCK) * BLOCK) : undefined;
	const { store } = dataDiskStore(0, { name, version, log });
	const idOf = (n: number) => dataDiskStore(n, { name, version }).identity;

	if (mode !== "persistent" || !haveIdb) {
		let base = new SparseBase(want ?? tpl.size, tpl.map()), from = "the template";
		if (haveIdb) {
			try {
				const saved = identitySize(await store.identity(), name, version);
				const st = saved === undefined ? null : await store.open(idOf(saved), { onMismatch: "refuse", write: false });
				if (saved !== undefined && st?.initialized && st.mismatch === undefined) {
					if (snapshotLimit > 0 && st.keys.size * BLOCK <= snapshotLimit) {
						base = new SparseBase(saved, await store.readAll());
						from = "a copy of the saved disk";
					} else {
						from = `the template (the saved disk, ${(st.keys.size * BLOCK / 1048576).toFixed(0)} MiB, is too large to copy)`;
					}
				}
			} catch (e) {
				log(`[host] data disk: cannot read the saved disk for a snapshot: ${(e as Error)?.message ?? e}`);
			} finally {
				await store.close();
			}
		}
		const d = new CowDisk(base, { log });
		d.notice = `in memory only, started from ${from}`;
		return d;
	}

	await warnOtherVersions(name, version, log);
	// The saved size (another format's identity: none, and the open below refuses it), grown to `want`.
	const savedId = await store.identity();
	let eff = identitySize(savedId, name, version) ?? want ?? tpl.size;
	if (savedId !== undefined && want !== undefined && want > eff && await store.relabel(savedId, idOf(want))) {
		log(`[host] data disk: grew from ${eff / 1073741824} GiB to ${want / 1073741824} GiB (the guest grows its file system at boot)`);
		eff = want;
	}
	const identity = idOf(eff);
	const st = await store.open(identity, { onMismatch: "refuse" });
	if (st.mismatch !== undefined) {
		await store.close();
		const e = new Error(`the saved data disk is "${st.mismatch}", this page expects "${identity}"; it was left untouched`);
		e.name = "DataDiskFormatError";
		throw e;
	}
	const d = new CowDisk(new ZeroBase(eff), { store, log, onError });
	if (!st.initialized) {
		const uid = await store.seed(tpl.indices.map((b, i) => [b, tpl.block(i).slice()]), identity);
		d.adoptStore({ keys: new Set(tpl.indices), initialized: true, gen: 0, uid }, identity);
		d.seeded = true;
		log(`[host] data disk: created from the template (${tpl.indices.length} blocks) in IndexedDB ${store.name}`);
	} else {
		d.adoptStore(st, identity);
	}
	d.identity = identity;
	return d;
}

/** Log saved data disks of other format versions (kept, never attached). */
async function warnOtherVersions(name: string, version: string, log: (msg: string) => void): Promise<void> {
	if (typeof indexedDB?.databases !== "function") return;
	try {
		for (const db of await indexedDB.databases()) {
			if (db.name?.startsWith(`kwdisk:${name}-`) && db.name !== `kwdisk:${name}-${version}`)
				log(`[host] data disk: IndexedDB also has ${db.name}, saved by another format version; it is kept but not attached`);
		}
	} catch {}
}

/**
 * Replace the persisted data disk with a kwsparse image (gzipped or not).
 * The disk must not be attached (or be detached, followed by a reload).
 */
export async function importDataDisk(bytes: Uint8Array | ArrayBuffer, { name = DATA_DISK_NAME, version = DATA_DISK_VERSION, size, log }: DataDiskNameOptions & { size?: number } = {}): Promise<{ size: number; blocks: number }> {
	const img = decodeKwsparse(await gunzipIfNeeded(bytes));
	if (img.blockSize !== BLOCK) throw new Error(`block size ${img.blockSize}, need ${BLOCK}`);
	if (size !== undefined && img.size !== size)
		throw new Error(`the image is ${img.size} bytes, the data disk is ${size}`);
	const { store, identity } = dataDiskStore(img.size, { name, version, log });
	try {
		await store.seed(img.indices.map((b, i) => [b, img.block(i).slice()]), identity);
	} finally {
		await store.close();
	}
	return { size: img.size, blocks: img.indices.length };
}

/** Forget the persisted data disk; the next boot starts again from the template. */
export async function resetDataDisk({ name = DATA_DISK_NAME, version = DATA_DISK_VERSION }: DataDiskNameOptions = {}): Promise<void> {
	if (typeof indexedDB === "undefined") return;
	const { store } = dataDiskStore(0, { name, version });
	try {
		await store.clear();
	} finally {
		await store.close();
	}
}
