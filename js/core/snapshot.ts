// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Machine snapshots: what Kernel.snapshot() returns and KernelConfig.restore
// takes, and a compact byte encoding of it.
//
// The kernel parks every task at a point where all of its state is in
// memory (arch/wasm/kernel/park.c), so a snapshot is the memory plus a few
// host values. Disks are not copied: the snapshot records each disk's
// identity and write generation (BlockDevice.snapshotState, core/block.ts),
// and a restore refuses disks that changed since. The other devices keep
// their host side's state (DeviceSnapshots): what the kernel told the host
// once (an attachment, an open mask, a stream state), which a restored
// kernel does not tell again. Connections do not survive: the kernel
// resets its vsock connections after a restore (kwvsock), and the network
// stack answers TCP segments of flows it does not know with RST. Detachable
// terminal sessions (tty.ts) do: the guest keeps them through that reset,
// and the snapshot lists them (`ttys`) for attach().

import type { BlockDevice, DiskSnapshotState } from "./block.ts";
import type { DisplaySnapshot } from "./display.ts";
import type { InputSnapshot } from "./input.ts";
import type { ShmSnapshot } from "./shm.ts";
import type { SoundSnapshot } from "./sound.ts";
import type { TtySessionSnapshot } from "./tty.ts";
import type { VirtioTransportSnapshot } from "./virtio.ts";
import type { VsockSnapshot } from "./vsock.ts";

/**
 * The host side of each device the machine had. A key is present when the
 * device was configured; its value is null if the kernel had not started
 * its driver yet (it then starts it after the restore, as at boot).
 */
export interface DeviceSnapshots {
	display?: DisplaySnapshot | null;
	input?: InputSnapshot | null;
	sound?: SoundSnapshot | null;
	vsock?: VsockSnapshot | null;
	shm?: ShmSnapshot | null;
	/** The MAC the guest's kwnet got. */
	network?: { mac: number[] } | null;
	/**
	 * virtio-gpu (kwvirtio): the transport's state. A snapshot is refused
	 * while the device holds resources or commands (virtio-gpu.ts), so the
	 * model itself has nothing to keep.
	 */
	gpu?: { transport: VirtioTransportSnapshot[] } | null;
}

/** The devices of DeviceSnapshots that a restore must find configured, or not, as saved. */
export type DeviceKind = "display" | "sound" | "vsock" | "shm" | "network" | "gpu";
const DEVICE_KINDS: readonly DeviceKind[] = ["display", "sound", "vsock", "shm", "network", "gpu"];

/** A saved machine (Kernel.snapshot()). */
export interface KernelSnapshot {
	version: 1;
	/** The kernel build it came from (Kernel.fingerprint); restore refuses another. */
	fingerprint: string;
	/**
	 * CPUs the machine had (absent: 1, as in snapshots from before SMP
	 * ones). A restore needs the same number: each task is held on its CPU.
	 */
	cpus?: number;
	memory64: boolean;
	/**
	 * All of the kernel's memory; the pages it reported free are zero. One of
	 * 2 GiB or more is on a SharedArrayBuffer where there is one.
	 */
	memory: Uint8Array;
	/** Bytes of free pages left out of `memory` (0 if the kernel reported none). */
	freeBytes?: number;
	/** The guest's monotonic clock at the snapshot, in ms; a restore continues from it. */
	monotonicMs: number;
	/** rows << 16 | cols, 0 = unknown. */
	consoleSize: number;
	/** Console input the guest had not read yet. */
	input: Uint8Array;
	/** The disks, in order (/dev/wda, wdb, ...); a restore needs the same ones, unchanged. */
	disks: DiskSnapshotState[];
	/** The other devices (empty in snapshots from before devices were saved). */
	devices: DeviceSnapshots;
	/**
	 * The detachable terminal sessions (PtyOptions.detachable) the host had
	 * open at the snapshot point; attach() each in the restored machine
	 * within its detachTimeout. Absent when there were none (and in
	 * snapshots from before them).
	 */
	ttys?: TtySessionSnapshot[];
}

/**
 * Options of snapshot() (Kernel, KernelInstance, WorkerKernel).
 *
 * `commit` saves a machine without the risk of `stop: true`, whose stop
 * comes before the caller has stored the snapshot (a failed store then loses
 * the machine). The kernel waits at its consistent point (every task parked,
 * on SMP every other CPU held) while the host makes the disks durable and
 * then runs `commit(snapshot, signal)`, which stores the snapshot. Resolved:
 * the kernel stops there (exit kind "stopped", as with `stop`), and
 * snapshot() resolves. Rejected, or still pending after `commitTimeoutMs` of
 * awake time (awakeTimeout(): a frozen page does not count), or a disk that
 * did not become durable: the kernel goes on as after a snapshot without
 * `stop`, and snapshot() rejects with a SnapshotCommitError. `signal` aborts
 * when the snapshot is given up (the timeout, or the kernel ended); a commit
 * that stored something should then remove it, since the machine runs on
 * past it. Implies `stop`. In worker mode `commit` and `hold` run on the
 * owner's thread with the memory transferred there.
 *
 * `hold` (with `commit`) decides after a successful commit instead of the
 * stop: the kernel stays at its consistent point, the snapshot stored,
 * until the value `hold(snapshot, signal)` returns settles. "continue": the
 * kernel goes on as after a snapshot without `stop` (the stored snapshot is
 * then stale: remove it, since the guest writes its disks again); "stop" (or
 * anything else, a rejection too: the stored snapshot is safe to resume):
 * it stops there, as without `hold`. No timeout applies: the caller bounds
 * the hold. snapshot() resolves with the snapshot once it ends, also when
 * the kernel ended meanwhile (stop(), a worker that died: `signal` aborts
 * then; the snapshot was stored and the kernel never ran past it).
 *
 * Time: nothing runs in the guest while it waits, and when it goes on (a
 * failed commit, or a hold's "continue") its clocks have advanced by the
 * wait, as for a virtual machine paused by its hypervisor: its monotonic
 * clock (the host's) jumps by it, timers that expired meanwhile fire, and
 * its wall clock stays the host's. Should the host's monotonic clock have
 * fallen behind its wall clock over the wait (it may stop while a device
 * sleeps), the guest's monotonic clock is advanced by the difference, so
 * its wall clock stays right. A restore instead continues the monotonic
 * clock from the saved value and steps the wall clock (kernel/parking.md).
 */
export interface SnapshotOptions {
	/** Stop the kernel right after the copy (no task runs after it). */
	stop?: boolean;
	/** Store the snapshot before the kernel is given up (above). */
	commit?: (snapshot: KernelSnapshot, signal: AbortSignal) => unknown;
	/** How long `commit` may take, in ms of awake time (default SNAPSHOT_COMMIT_TIMEOUT_MS). */
	commitTimeoutMs?: number;
	/** After a successful commit: keep the kernel at its consistent point until this decides (above). */
	hold?: (snapshot: KernelSnapshot, signal: AbortSignal) => SnapshotHoldDecision | PromiseLike<SnapshotHoldDecision>;
	/**
	 * Have the guest write back its dirty file data and drop its clean file
	 * cache (page cache, unused dentries and inodes) on the way to the
	 * snapshot, so that the cache is not saved: the pages are free then and
	 * left out. The guest reads the files again when it next needs them.
	 * Default: true with `stop` or `commit` (a snapshot the machine stops
	 * at), false for one it runs on from. A kernel that cannot ignores it.
	 */
	dropCaches?: boolean;
}

/** How a snapshot({ commit, hold }) hold ends: the kernel goes on, or stops at the snapshot. */
export type SnapshotHoldDecision = "stop" | "continue";

/**
 * The host's wall clock ran ahead of its monotonic clock by this much over
 * a hold (ms) before the guest's monotonic clock is advanced to match (a
 * device that slept; smaller differences are clock noise and NTP slewing).
 */
export const HOLD_CLOCK_LAG_MS = 1000;

/** snapshot({ commit })'s default commitTimeoutMs. */
export const SNAPSHOT_COMMIT_TIMEOUT_MS = 30000;

/**
 * snapshot({ commit }) gave the snapshot up after the copy (the commit
 * rejected or timed out, or a disk did not become durable): the kernel runs
 * on, unless it ended meanwhile for another reason.
 */
export class SnapshotCommitError extends Error {
	/** The commit took longer than commitTimeoutMs. */
	readonly timedOut: boolean;
	constructor(message: string, opts: { timedOut?: boolean; cause?: unknown } = {}) {
		super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
		this.name = "SnapshotCommitError";
		this.timedOut = !!opts.timedOut;
	}
}

/**
 * Call `fn` once `ms` of awake time has passed: counted in steps of `step`
 * ms, each adding at most two steps however late its timer fired, so a page
 * or worker frozen in the background (iOS, a discarded tab) does not use the
 * time up while it sleeps, and the timers that fire late and all at once
 * when it wakes do not beat the I/O it was waiting for. Returns a cancel
 * function.
 */
export function awakeTimeout(fn: () => void, ms: number, step = 1000): () => void {
	let left = ms, last = performance.now(), timer: ReturnType<typeof setTimeout> | undefined;
	const tick = () => {
		const now = performance.now();
		left -= Math.min(now - last, 2 * step);
		last = now;
		if (left <= 0) fn();
		else timer = setTimeout(tick, Math.min(step, left));
	};
	timer = setTimeout(tick, Math.min(step, ms));
	return () => clearTimeout(timer);
}

/**
 * Why a machine with the devices `present` (and the network MAC `mac`, if
 * set) cannot resume `saved`, or null if it can: the restored kernel has
 * exactly the drivers it had, so each device must be configured, or not,
 * as it was.
 */
export function snapshotDeviceMismatch(saved: DeviceSnapshots, present: Record<DeviceKind, boolean>, mac?: Uint8Array): string | null {
	for (const kind of DEVICE_KINDS) {
		const had = kind in saved && saved[kind] !== undefined;
		if (had && !present[kind]) return `the snapshot has a ${kind} device, which this machine is not given`;
		if (!had && present[kind]) return `the snapshot has no ${kind} device, but this machine is given one`;
	}
	const m = saved.network?.mac;
	if (m && mac && (m.length !== mac.length || m.some((b, i) => b !== mac[i])))
		return "the network device has another MAC than in the snapshot";
	return null;
}

/**
 * Why a machine with `cpus` CPUs cannot resume `saved`, or null if it can:
 * a task stays on the CPU it ran on (kernel/smp.md), so a restore needs
 * every CPU the snapshot had, and no more (an SMP kernel never starts CPUs
 * after its boot).
 */
export function snapshotCpuMismatch(saved: KernelSnapshot, cpus: number): string | null {
	const had = saved.cpus ?? 1;
	if (had === cpus) return null;
	return `the snapshot has ${had} CPU${had === 1 ? "" : "s"}, this machine has ${cpus}`;
}

const diskName = (i: number) => `wd${String.fromCharCode(97 + i)}`;

/**
 * Why `disks` cannot resume `saved` (a snapshot's disks), or null if they
 * can: the same number of disks, each with the same identity, write
 * generation and stamp. A disk that changed after the snapshot would not match the
 * restored kernel's caches (its file systems would be corrupted).
 */
export function snapshotDiskMismatch(saved: DiskSnapshotState[], disks: BlockDevice[]): string | null {
	for (let i = 0; i < Math.max(saved.length, disks.length); i++) {
		const s = saved[i], d = disks[i];
		if (!d) return `disk ${diskName(i)} (${s!.name}) is missing: the snapshot has ${saved.length} disk(s), ${disks.length} given`;
		if (!s) return `disk ${diskName(i)} was not in the snapshot: it has ${saved.length} disk(s), ${disks.length} given`;
		if (typeof d.snapshotState !== "function") return `disk ${diskName(i)} cannot be checked against the snapshot (no snapshotState)`;
		let now: DiskSnapshotState;
		try {
			now = d.snapshotState();
		} catch (e) {
			return `disk ${diskName(i)}: ${(e as Error).message}`;
		}
		if (now.identity !== s.identity)
			return `disk ${diskName(i)} (${now.name}) is not the disk of the snapshot (${s.name})`;
		if (now.gen !== s.gen)
			return `disk ${diskName(i)} (${now.name}) was written after the snapshot (generation ${now.gen}, the snapshot has ${s.gen})`;
		if ((now.stamp ?? "") !== (s.stamp ?? ""))
			return `disk ${diskName(i)} (${now.name}) was changed by another program after the snapshot (${s.stamp ?? "-"}, now ${now.stamp ?? "-"})`;
	}
	return null;
}

const PAGE = 4096;
const CHUNK = 65536;

/**
 * For a snapshot memory this module filled (copySnapshotMemory,
 * decodeSnapshot, a copy for a worker): one byte per 64 KiB chunk, 0 where
 * the chunk is known to be zero. Encoding and restoring then look at the
 * used chunks only instead of scanning the machine's whole size (about
 * 250 ms per scan of 2 GiB, Node 24, 2026-11-22). Snapshot memories are
 * not written after they are made.
 */
const usedChunks = new WeakMap<Uint8Array, Uint8Array>();

function usedOf(mem: Uint8Array): Uint8Array | undefined {
	const used = usedChunks.get(mem);
	return used && used.length === Math.ceil(mem.byteLength / CHUNK) ? used : undefined;
}

/** Snapshot memories this large or larger are shared (newSnapshotMemory). */
export const SHARED_SNAPSHOT_BYTES = 2 ** 31;

/**
 * A zeroed buffer for a snapshot memory of `bytes`. One of
 * SHARED_SNAPSHOT_BYTES or more is on a SharedArrayBuffer where there is
 * one (Node, a cross-origin isolated page): Chrome neither allocates a plain
 * ArrayBuffer of 2 GiB nor posts one ("The ArrayBuffer/ArrayBufferView size
 * exceeds the supported range"), but allocates a growable
 * SharedArrayBuffer of up to 4 GiB (a fixed-size one of 2 GiB fails too) and
 * posts it, shared rather than copied (Chrome 151, 2026-11-22). A shared
 * memory crosses threads as it is: snapshot memories are not written after
 * they are made.
 */
export function newSnapshotMemory(bytes: number): Uint8Array {
	if (bytes >= SHARED_SNAPSHOT_BYTES && typeof SharedArrayBuffer === "function")
		return new Uint8Array(new SharedArrayBuffer(bytes, { maxByteLength: bytes }), 0, bytes);
	return new Uint8Array(bytes);
}

/** What to transfer when posting snapshot memory `m`: its buffer, or nothing for a shared one. */
export function snapshotTransfer(m: Uint8Array): ArrayBuffer[] {
	return m.buffer instanceof ArrayBuffer ? [m.buffer] : [];
}

/** A snapshot to post to another thread: with its used chunks, which receivedSnapshot() takes back. */
export function sentSnapshot(s: KernelSnapshot): KernelSnapshot {
	const used = usedOf(s.memory);
	return used ? { ...s, usedChunks: used } as KernelSnapshot : s;
}

/**
 * Copy the kernel's memory for a snapshot, leaving out the pages the kernel
 * reported free (`free`: one bit per 4 KiB page, least significant bit
 * first, for the first `bits` pages): they stay zero in the copy, which
 * is what a restore gives them. Without `free` it is a plain copy.
 * Returns the copy and the bytes left out.
 */
export function copySnapshotMemory(mem: Uint8Array, free: Uint8Array | null, bits: number): { memory: Uint8Array; freeBytes: number } {
	const out = newSnapshotMemory(mem.byteLength); // zero, and untouched pages cost nothing
	if (!free || !bits) {
		out.set(mem);
		return { memory: out, freeBytes: 0 };
	}
	const used = new Uint8Array(Math.ceil(mem.byteLength / CHUNK));
	const pages = Math.min(bits, Math.floor(mem.byteLength / PAGE), free.length * 8);
	let runStart = -1, skipped = 0;
	const flush = (end: number) => {
		if (runStart >= 0) {
			out.set(mem.subarray(runStart * PAGE, end * PAGE), runStart * PAGE);
			used.fill(1, Math.floor((runStart * PAGE) / CHUNK), Math.ceil((end * PAGE) / CHUNK));
		}
		runStart = -1;
	};
	for (let p = 0; p < pages;) {
		const b = free[p >> 3]!;
		if ((p & 7) === 0 && p + 8 <= pages && (b === 0 || b === 0xff)) {
			if (b === 0) { if (runStart < 0) runStart = p; } else { flush(p); skipped += 8; }
			p += 8;
			continue;
		}
		if (b & (1 << (p & 7))) { flush(p); skipped++; } else if (runStart < 0) runStart = p;
		p++;
	}
	flush(pages);
	if (pages * PAGE < mem.byteLength) {
		out.set(mem.subarray(pages * PAGE), pages * PAGE);
		used.fill(1, Math.floor((pages * PAGE) / CHUNK));
	}
	usedChunks.set(out, used);
	return { memory: out, freeBytes: skipped * PAGE };
}

const MAGIC = "KWSNAP1\n";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Int32 words: about 4x faster than BigUint64 (no BigInt per word).
function isZero(u8: Uint8Array, off: number): boolean {
	const w = new Int32Array(u8.buffer, u8.byteOffset + off, CHUNK / 4);
	for (let i = 0; i < w.length; i += 8) if (w[i]! | w[i + 1]! | w[i + 2]! | w[i + 3]! | w[i + 4]! | w[i + 5]! | w[i + 6]! | w[i + 7]!) return false;
	return true;
}

/**
 * A snapshot as it arrived from another thread. Node 24's structured clone
 * gives a view of exactly 4 GiB a length of 0 (its buffer arrives whole,
 * 2026-11-22): take the buffer's length then.
 */
export function receivedSnapshot(s: KernelSnapshot): KernelSnapshot {
	const { usedChunks: used, ...rest } = s as KernelSnapshot & { usedChunks?: Uint8Array };
	const m = s.memory;
	const memory = m.byteLength === 0 && m.buffer.byteLength > 0 ? new Uint8Array(m.buffer) : m;
	if (used instanceof Uint8Array) usedChunks.set(memory, used);
	return memory === m && used === undefined ? s : { ...rest, memory };
}

/**
 * Copy a snapshot's memory over a fresh instance's (the same size), leaving
 * alone every 64 KiB chunk that is zero on both sides: an untouched page of
 * either buffer stays uncommitted, so a restore costs the host the
 * snapshot's used memory, not the machine's size. A chunk that is zero in
 * the snapshot and not in `dst` (a data segment instantiation applied) is
 * cleared; `dstUsedEnd` is the end of what `dst` may hold (the kernel
 * image's `_end`; 0 for a new buffer), everything above it being zero.
 * `dst` gets the snapshot's used chunks, as a snapshot memory of its own.
 */
export function restoreSnapshotMemory(dst: Uint8Array, src: Uint8Array, dstUsedEnd = dst.byteLength): void {
	if (dst.byteLength !== src.byteLength || src.byteLength % CHUNK || src.byteOffset % 4 || dst.byteOffset % 4) {
		dst.set(src);
		return;
	}
	const known = usedOf(src);
	const used = new Uint8Array(src.byteLength / CHUNK);
	let runStart = -1;
	const flush = (end: number) => {
		if (runStart >= 0) dst.set(src.subarray(runStart, end), runStart);
		runStart = -1;
	};
	for (let off = 0, c = 0; off < src.byteLength; off += CHUNK, c++) {
		if ((!known || known[c]) && !isZero(src, off)) {
			if (runStart < 0) runStart = off;
			used[c] = 1;
			continue;
		}
		flush(off);
		if (off < dstUsedEnd && !isZero(dst, off)) dst.fill(0, off, off + CHUNK);
	}
	flush(src.byteLength);
	usedChunks.set(dst, used);
}

/**
 * Encode a snapshot: MAGIC, a u32 header length, the JSON header (everything
 * but the memory and the input), the input, then each non-zero 64 KiB chunk
 * of the memory as a u32 chunk index and its bytes. Little-endian. A header
 * without `cpus` (files from before SMP snapshots) decodes as one CPU.
 */
export function encodeSnapshot(s: KernelSnapshot): Uint8Array {
	const mem = s.memory;
	if (mem.byteLength % CHUNK || mem.byteOffset % 4) throw new Error("snapshot memory must be whole 64 KiB pages");
	const chunks: number[] = [];
	const known = usedOf(mem);
	for (let off = 0, c = 0; off < mem.byteLength; off += CHUNK, c++) if ((!known || known[c]) && !isZero(mem, off)) chunks.push(c);
	const header = encoder.encode(JSON.stringify({
		version: s.version, fingerprint: s.fingerprint, cpus: s.cpus ?? 1, memory64: s.memory64, memoryBytes: mem.byteLength,
		freeBytes: s.freeBytes ?? 0, monotonicMs: s.monotonicMs, consoleSize: s.consoleSize, inputBytes: s.input.length, chunks: chunks.length,
		disks: s.disks, devices: s.devices, ...(s.ttys?.length ? { ttys: s.ttys } : {}),
	}));
	const out = new Uint8Array(MAGIC.length + 4 + header.length + s.input.length + chunks.length * (4 + CHUNK));
	const dv = new DataView(out.buffer);
	let p = 0;
	out.set(encoder.encode(MAGIC), p);
	p += MAGIC.length;
	dv.setUint32(p, header.length, true);
	p += 4;
	out.set(header, p);
	p += header.length;
	out.set(s.input, p);
	p += s.input.length;
	for (const c of chunks) {
		dv.setUint32(p, c, true);
		out.set(mem.subarray(c * CHUNK, (c + 1) * CHUNK), p + 4);
		p += 4 + CHUNK;
	}
	return out;
}

export function decodeSnapshot(bytes: Uint8Array): KernelSnapshot {
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (decoder.decode(bytes.subarray(0, MAGIC.length)) !== MAGIC) throw new Error("not an unkernel snapshot");
	let p = MAGIC.length;
	const hlen = dv.getUint32(p, true);
	p += 4;
	const h = JSON.parse(decoder.decode(bytes.subarray(p, p + hlen)));
	p += hlen;
	if (h.version !== 1) throw new Error(`unsupported snapshot version ${h.version}`);
	const input = bytes.slice(p, p + h.inputBytes);
	p += h.inputBytes;
	const memory = newSnapshotMemory(h.memoryBytes);
	const used = new Uint8Array(Math.ceil(h.memoryBytes / CHUNK));
	for (let i = 0; i < h.chunks; i++) {
		const c = dv.getUint32(p, true);
		memory.set(bytes.subarray(p + 4, p + 4 + CHUNK), c * CHUNK);
		used[c] = 1;
		p += 4 + CHUNK;
	}
	usedChunks.set(memory, used);
	const ttys = Array.isArray(h.ttys) ? (h.ttys as TtySessionSnapshot[]).filter((t) => t && typeof t.id === "string") : [];
	return { version: 1, fingerprint: h.fingerprint, cpus: Number.isInteger(h.cpus) && h.cpus > 1 ? h.cpus : 1, memory64: h.memory64, memory, freeBytes: h.freeBytes ?? 0, monotonicMs: h.monotonicMs, consoleSize: h.consoleSize, input,
		disks: Array.isArray(h.disks) ? h.disks : [], devices: h.devices && typeof h.devices === "object" ? h.devices : {}, ...(ttys.length ? { ttys } : {}) };
}
