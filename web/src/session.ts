// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The suspended session: Suspend (Ctrl-A z, KW.suspend()) saves the running
// machine with the SDK's snapshot({ commit }) and keeps it here, in
// IndexedDB "kwsnap:session-v2" (its own database, older versions are
// deleted on first use; the data disk's kwdisk:kwdata-v1 is never touched
// here); the next load resumes it where it can
// (boot.ts). One session at a time: "meta" (small, read to decide
// whether it can resume) and "bytes" (the encoded snapshot, a Blob) are written
// in one transaction and deleted together. Suspend writes it while the
// kernel waits at its snapshot point (snapshot({ commit }), boot.ts), and the
// kernel stops only once that transaction committed: a write that fails
// (WebKit aborts the IndexedDB transactions of a page in the background, no
// room) leaves the machine running, and the earlier record as it was (a
// suspend in the background holds the kernel there instead of stopping it,
// and deletes the record if the machine goes on: autosuspend.ts). The
// snapshot is encoded into a Blob before the transaction opens, so it holds
// only the two puts. A session saved on several CPUs
// resumes only on as many (every task resumes on the CPU it ran on), with
// the SMP kernel; its snapshot is bigger (each CPU adds its emulator's 8
// MiB: about 35 MiB on 2 CPUs, 54 on 4, 90 on 8).
//
// Saving at the moment the tab closes is not done: the save needs the kernel to
// park, the memory copied and encoded (about 150 ms with the CLI,
// 2026-11-15) and about 30 MiB committed to IndexedDB, and a page that is
// going away gets no guarantee that a transaction it starts commits. The
// page suspends a hidden tab instead (autosuspend.ts). A snapshot taken
// without stopping would not help: the guest keeps writing /data, which
// makes it unrestorable within seconds.
import { decodeSnapshot, encodeSnapshot, type DiskSnapshotState, type KernelSnapshot } from "./sdk.ts";

const DB_PREFIX = "kwsnap:session-v";
const DB_VERSION = 2;
const DB = `${DB_PREFIX}${DB_VERSION}`;
const STORE = "session";

let oldDropped = false;
/**
 * Delete the databases of older versions (kwsnap:session-v1 up to the one
 * before DB_VERSION), once per page. Not awaited: deleting a missing one is
 * a no-op, and one another tab still holds is deleted when that tab closes.
 */
function dropOldDbs(): void {
	if (oldDropped) return;
	oldDropped = true;
	for (let v = 1; v < DB_VERSION; v++) {
		try { indexedDB.deleteDatabase(`${DB_PREFIX}${v}`); } catch { /* ignore */ }
	}
}

/** What the page needs to decide whether it can resume it. */
export interface SessionMeta {
	/** Date.now() when it was saved. */
	saved: number;
	/** The page's kernel that ran it, UP or SMP (a hashed asset URL in builds: another release cannot resume it). */
	kernelUrl: string;
	/** CPUs it ran on, which a resume needs (KernelSnapshot.cpus); absent in sessions from before SMP ones: 1. */
	cpus?: number;
	/** Linux's banner of the kernel that saved it. */
	fingerprint: string;
	memoryMiB: number;
	/** The options that decide the machine's devices: a restore needs the same. */
	devices: SessionDevices;
	/** The disks as the snapshot recorded them (identity and write generation). */
	disks: DiskSnapshotState[];
	/** Encoded size in bytes. */
	bytes: number;
	/** What the console showed last (the guest's output, from a line start), shown again on resume. */
	screen?: string;
	/** Saved in worker mode (either mode can resume it). */
	worker: boolean;
	/**
	 * The distro image it ran on (its name and URL; a build's URL names the
	 * image's content), or null (?distro=none). A session resumes only on
	 * the same one; inline the image's content is checked too
	 * (snapshotDiskMismatch(), the snapshot's first disk), in worker mode the
	 * worker checks it.
	 */
	distro?: { name: string; url: string } | null;
	/** The guest preview's Browser window open at the suspend (preview.ts previewState()), opened again on resume once its port answers (minimized if it was; fill: from older records, ignored). */
	preview?: { port: number; path?: string; shown: boolean; fill?: boolean } | null;
	/**
	 * The terminals 1-9 open at the suspend whose sessions are in the
	 * snapshot (wterms.ts saved(): number, name, session id; the Terminal
	 * window it was a tab of, from 1 for the console's, and whether it was
	 * that window's shown tab, both absent in older records: the console's
	 * window), opened and attached again on resume; absent in sessions from
	 * before them. Named "windows" (and win below) as records have them.
	 */
	windows?: Array<{ n: number; name: string; tty: boolean; id: string; win?: number; shown?: boolean }>;
	/** The current terminal at the suspend (0: the console), shown again on resume. */
	win?: number;
}

export interface SessionDevices {
	display: boolean;
	sound: boolean;
	net: boolean;
	data: boolean;
	/** Guest GL (the GL option; its kw.gl=1 is in the saved kernel's command line); absent in sessions saved before: off. */
	gl?: boolean;
	/** The virtio-gpu device that comes with guest GL (?gpu=0: none); absent in sessions saved before: off. */
	gpu?: boolean;
	/** kwshm, for the Wayland desktop (wayland.ts); absent in sessions saved before: off. */
	shm?: boolean;
}

const reqP = <T>(r: IDBRequest<T>): Promise<T> =>
	new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

function openDb(): Promise<IDBDatabase> {
	dropOldDbs();
	return new Promise((resolve, reject) => {
		const r = indexedDB.open(DB, 1);
		r.onupgradeneeded = () => { r.result.createObjectStore(STORE); };
		r.onsuccess = () => resolve(r.result);
		r.onerror = () => reject(r.error);
	});
}

/** One transaction; `signal` aborts it (a commit given up: nothing of it is kept). */
async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => Promise<T> | T, signal?: AbortSignal): Promise<T> {
	const db = await openDb();
	const abort = () => { try { tx?.abort(); } catch { /* finished already */ } };
	let tx: IDBTransaction | undefined;
	try {
		signal?.throwIfAborted();
		tx = db.transaction(STORE, mode, mode === "readwrite" ? { durability: "strict" } : undefined);
		const t = tx;
		const done = new Promise<void>((resolve, reject) => {
			t.oncomplete = () => resolve();
			t.onerror = t.onabort = () => reject(t.error ?? (signal?.aborted ? signal.reason : new DOMException("IndexedDB transaction aborted", "AbortError")));
		});
		signal?.addEventListener("abort", abort, { once: true });
		const r = await fn(t.objectStore(STORE));
		await done;
		return r;
	} finally {
		signal?.removeEventListener("abort", abort);
		db.close();
	}
}

/** The saved session's meta, or null (none, or no IndexedDB). */
export async function sessionInfo(): Promise<SessionMeta | null> {
	if (typeof indexedDB === "undefined") return null;
	const m = await run("readonly", (s) => reqP(s.get("meta")));
	return m && typeof m === "object" && typeof (m as SessionMeta).saved === "number" ? m as SessionMeta : null;
}

/** The saved snapshot, decoded. */
export async function loadSession(): Promise<KernelSnapshot> {
	const b = await run("readonly", (s) => reqP(s.get("bytes")));
	if (!(b instanceof Blob)) throw new Error("the suspended session has no snapshot data");
	return decodeSnapshot(new Uint8Array(await b.arrayBuffer()));
}

/**
 * Encode and keep `snap` (replacing any saved session) in one transaction,
 * resolved once it committed (strict durability where the engine has it).
 * `signal` aborts it. Returns the encoded size.
 */
export async function saveSession(snap: KernelSnapshot, meta: Omit<SessionMeta, "fingerprint" | "memoryMiB" | "cpus" | "disks" | "bytes">, signal?: AbortSignal): Promise<number> {
	const bytes = encodeSnapshot(snap);
	const blob = new Blob([bytes as Uint8Array<ArrayBuffer>]);
	const full: SessionMeta = { ...meta, fingerprint: snap.fingerprint, memoryMiB: snap.memory.byteLength / 1048576, cpus: snap.cpus ?? 1, disks: snap.disks, bytes: bytes.length };
	await run("readwrite", (s) => {
		s.put(blob, "bytes");
		s.put(full, "meta");
	}, signal);
	return bytes.length;
}

/** Forget the saved session; with `saved`, only if it is still the one saved then (SessionMeta.saved). */
export async function clearSession(saved?: number): Promise<void> {
	if (typeof indexedDB === "undefined") return;
	await run("readwrite", async (s) => {
		if (saved !== undefined && (await reqP(s.get("meta")) as SessionMeta | undefined)?.saved !== saved) return;
		s.clear();
	});
}

/** The CPUs a session needs (sessions from before SMP ones have none: 1). */
export const sessionCpus = (m: SessionMeta): number => (Number.isInteger(m.cpus) && m.cpus! > 1 ? m.cpus! : 1);

/**
 * Why `m` cannot be resumed with these options, this kernel (the page's UP
 * or SMP one, whichever runs the session's CPU count) and this distro
 * image, or null if it can.
 */
export function sessionMismatch(m: SessionMeta, kernelUrl: string | null, devices: SessionDevices, distro: { name: string; url: string } | null): string | null {
	if (m.kernelUrl !== kernelUrl) return "it was saved by another kernel release";
	const was = m.distro ?? null;
	if ((was?.url ?? null) !== (distro?.url ?? null)) {
		if (was && distro && was.name === distro.name) return `it was saved on another build of the ${was.name} image (${was.url}; now ${distro.url})`;
		return `it was saved on ${was ? `the ${was.name} image` : "no distro image"}, this boot runs ${distro ? `the ${distro.name} image` : "none"} (Options, Distro)`;
	}
	const names: Record<keyof SessionDevices, string> = { display: "Display", sound: "Sound", net: "Network", data: "Data disk", gl: "Guest GL", gpu: "virtio-gpu (?gpu=0)", shm: "kwshm (the Wayland desktop)" };
	for (const k of Object.keys(names) as Array<keyof SessionDevices>)
		if (!!m.devices[k] !== !!devices[k]) return `it was saved with ${names[k]} ${m.devices[k] ? "on" : "off"} (Options)`;
	return null;
}

/**
 * What the console showed of the guest, to show again on resume: the last
 * `max` characters, from a line start.
 */
export class ScreenTail {
	#chunks: string[] = [];
	#length = 0;
	readonly max: number;
	constructor(max = 65536) {
		this.max = max;
	}
	push(t: string): void {
		this.#chunks.push(t);
		this.#length += t.length;
		while (this.#length - this.#chunks[0]!.length >= this.max) this.#length -= this.#chunks.shift()!.length;
	}
	text(): string {
		const all = this.#chunks.join("");
		if (all.length <= this.max) return all;
		const from = all.indexOf("\n", all.length - this.max);
		return from < 0 ? all.slice(-this.max) : all.slice(from + 1);
	}
}
