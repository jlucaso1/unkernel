// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// /smp-probe.html: why the SMP kernel runs parallel guest work slower on
// several CPUs than on one in some browsers (Safari 27.2: 0.4-0.6x on 4 CPUs
// against one CPU in a worker, 2026-11-19; testing.md, Profiling CPUs and
// worker mode). Two parts, each failure-tolerant and under a timeout, so a
// hang still leaves a partial report:
// - A, engine probes without a kernel: workers and nested workers spinning,
//   how long a timed Atomics.wait / memory.atomic.wait32 really sleeps, how
//   long a notify takes to wake a blocked worker, a hand-assembled wasm
//   module on one shared memory in n workers (plain, atomic RMW, one shared
//   word, fence), compile + instantiate + table.set of many small modules in
//   n workers as kwemu's JIT does (js/core/jit.ts), and GC churn with the
//   large shared memory attached or not.
// - B, kernel experiments: the page's kernel on 1, 2, 4 (8) CPUs in worker
//   mode, with the JIT off, and with the wait parameters (kernel/smp.md,
//   Waiting for another CPU) written to /sys/module/kernel/parameters/ in
//   one boot, running one copy of a workload per CPU of the widest
//   configuration (user compute, syscalls, fork+exec), with /proc/kwmove,
//   /proc/interrupts, /proc/stat and the JIT counters around each.
// The report ends with a heuristic reading of which cause (H1-H5 below) the
// numbers point at. Copy text / Copy JSON give it all, with the browser.
//   H1 timed or blocked waits are slow (oversleep, slow notify-to-wake)
//   H2 an engine-wide lock serialises wasm compile / instantiate / table.set
//   H3 worker threads (nested ones) do not run in parallel at full speed
//   H4 GC pressure from the shared memory counted in every worker's heap
//   H5 wasm on a shared memory in several threads scales badly
import { DEFAULT_DISTRO, DISTROS_OFFERED, MAX_CPUS, smpBlocker, webkitEngine } from "./config.ts";
import { createKernel, kernelSmpUrl, kernelUrl, loadKernelModule, type InstanceStats, type KernelHandle } from "./sdk.ts";
import { execAsRoot } from "./sudo.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const q = new URLSearchParams(location.search);

// --- the environment -----------------------------------------------------------
const hc = navigator.hardwareConcurrency || 1;
const cpuMax = Math.max(1, Math.min(MAX_CPUS, hc));
const smpWhy = smpBlocker();
const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) || location.hostname.endsWith(".localhost");
const originKind = location.protocol === "https:" ? "https" : location.protocol === "http:" ? (local ? "http, localhost" : "plain http, not localhost") : location.protocol;

/** Smallest step of performance.now() on this thread, in µs. */
function timerResUs(): number {
	let m = Infinity;
	for (let i = 0; i < 300; i++) {
		const a = performance.now();
		let b;
		while ((b = performance.now()) === a);
		m = Math.min(m, b - a);
	}
	return Math.round(m * 1000 * 100) / 100;
}

const env = {
	ua: navigator.userAgent,
	hardwareConcurrency: hc,
	deviceMemory: (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? null,
	webkit: webkitEngine(),
	crossOriginIsolated,
	isSecureContext,
	origin: location.origin,
	originKind,
	jspi: typeof (WebAssembly as unknown as { Suspending?: unknown }).Suspending === "function",
	smp: smpWhy ?? "yes",
	timerResUs: timerResUs(),
	build: `linux ${__KW_BUILD__.linux}, kernel ${__KW_BUILD__.kernel}, page ${__KW_BUILD__.commit || "?"} ${__KW_BUILD__.date || ""}`.trim(),
	kernelUrl: kernelUrl.pathname.split("/").pop() ?? "",
	kernelSmpUrl: kernelSmpUrl?.pathname.split("/").pop() ?? null,
};
$("env").textContent = Object.entries(env).map(([k, v]) => `${k.padEnd(20)} ${v}`).join("\n");
const warnings: string[] = [];
if (!isSecureContext) warnings.push(`Not a secure context (${originKind}): Safari runs JS and wasm WITHOUT its JIT here, so every number is meaningless. Open http://localhost:<port>/smp-probe.html on this machine itself, or the page over https.`);
if (!crossOriginIsolated) warnings.push("Not cross-origin isolated: no SharedArrayBuffer, so neither the probes nor several CPUs can run (the dev server and the built server send COOP/COEP).");
if (smpWhy) warnings.push(`No SMP here: ${smpWhy}. Part B runs only the 1-CPU configurations.`);
$("warn").textContent = warnings.join("\n");

// --- small things ----------------------------------------------------------------
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const sorted = (a: number[]) => [...a].sort((x, y) => x - y);
const median = (a: number[]) => { const s = sorted(a); return s.length ? s[s.length >> 1]! : NaN; };
const pct = (a: number[], p: number) => { const s = sorted(a); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : NaN; };
const r0 = (x: number) => Math.round(x);
const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const errText = (e: unknown) => (e as Error)?.message ?? String(e);
const fmt = (x: number | undefined, d = 0) => x == null || !Number.isFinite(x) ? "-" : d === 0 ? String(r0(x)) : d === 1 ? r1(x).toFixed(1) : r2(x).toFixed(2);

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
	let t: ReturnType<typeof setTimeout>;
	return Promise.race([p, new Promise<never>((_, j) => { t = setTimeout(() => j(new Error(`${what}: timed out after ${r1(ms / 1000)} s`)), ms); })]).finally(() => clearTimeout(t));
}

const logEl = $("log");
function log(m: string) {
	logEl.textContent += `${m}\n`;
	logEl.scrollTop = logEl.scrollHeight;
	console.log(`[smp-probe] ${m}`);
}
const status = (m: string) => { $("status").textContent = m; };
document.addEventListener("visibilitychange", () => { if (document.hidden) log("the tab was hidden: timings meanwhile may be off (background throttling)"); });

let stopped = false;
class Stopped extends Error { constructor() { super("stopped"); } }
const check = () => { if (stopped) throw new Stopped(); };

// --- workers ------------------------------------------------------------------------
// One script for every probe worker (a Blob URL). Timed jobs post {ready}
// once set up, spin until the shared go word is set (so all start at once),
// then post their result; a failure posts {error}. "parent" makes this
// worker the parent of n nested workers and relays their messages
// ({i, m} up, {to, m} down), as the kernel worker does for its CPUs.
const WORKER_SRC = `"use strict";
const now = () => performance.now();
const spinJs = (iters) => { let x = 1; for (let i = 0; i < iters; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; } return x; };
const go = (g) => { const t0 = now(); while (Atomics.load(g, 0) === 0) if (now() - t0 > 60000) throw new Error("never released"); };
const resolution = () => { let m = Infinity; for (let i = 0; i < 200; i++) { const a = now(); let b; while ((b = now()) === a); m = Math.min(m, b - a); } return m * 1000; };
const leb = (v) => { const o = []; do { let b = v & 0x7f; v = Math.floor(v / 128); if (v) b |= 0x80; o.push(b); } while (v); return o; };
const sleb = (v) => { v = BigInt(v); const o = []; for (;;) { const b = Number(v & 0x7fn); v >>= 7n; if ((v === 0n && !(b & 0x40)) || (v === -1n && (b & 0x40))) { o.push(b); return o; } o.push(b | 0x80); } };
const sec = (id, body) => [id, ...leb(body.length), ...body];
const str = (s) => [s.length, ...Array.from(s, (c) => c.charCodeAt(0))];
// A module shaped like a kwemu JIT block: imports env.memory (shared) and
// env.table, exports f(x, cpu, irqp, jl: i64) -> i64, which returns at once
// for cpu = 0 (the warm call); k load/xor/add steps, a store every 8. The
// first constant is a padded 5-byte LEB at "at", patched per module so that
// no two modules are the same bytes.
const templates = new Map();
function template(k) {
	let t = templates.get(k);
	if (t) return t;
	const body = [0x01, 0x01, 0x7e, 0x20, 0x01, 0x50, 0x04, 0x40, 0x42, 0x00, 0x0f, 0x0b];
	let at = -1;
	for (let j = 0; j < k; j++) {
		const off = leb((j * 8) & 0xfff8);
		body.push(0x20, 0x04, 0x20, 0x00, 0xa7, 0x29, 0x03, ...off, 0x42);
		if (j === 0) { at = body.length; body.push(0x80, 0x80, 0x80, 0x80, 0x00); } else body.push(...sleb(j * 7919 + k));
		body.push(0x85, 0x7c, 0x21, 0x04);
		if ((j & 7) === 7) body.push(0x20, 0x00, 0xa7, 0x20, 0x04, 0x37, 0x03, ...off);
	}
	body.push(0x20, 0x04, 0x0b);
	const head = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
		...sec(1, [0x01, 0x60, 0x04, 0x7e, 0x7e, 0x7e, 0x7e, 0x01, 0x7e]),
		...sec(2, [0x02, ...str("env"), ...str("memory"), 0x02, 0x03, 0x01, ...leb(65536), ...str("env"), ...str("table"), 0x01, 0x70, 0x00, 0x01]),
		...sec(3, [0x01, 0x00]),
		...sec(7, [0x01, ...str("f"), 0x00, 0x00])];
	const code = sec(10, [0x01, ...leb(body.length), ...body]);
	const bytes = new Uint8Array([...head, ...code]);
	t = { bytes, at: head.length + (code.length - body.length) + at };
	templates.set(k, t);
	return t;
}
function jitModule(seed, k) {
	const t = template(k), b = t.bytes.slice();
	for (let i = 0; i < 5; i++) b[t.at + i] = (Math.floor(seed / Math.pow(2, 7 * i)) & 0x7f) | (i < 4 ? 0x80 : 0);
	return b;
}
function job(d) {
	switch (d.kind) {
	case "ping":
		postMessage({ ok: true, res: resolution() });
		return;
	case "spin": {
		postMessage({ ready: true });
		go(d.go);
		const t0 = now(), x = spinJs(d.iters);
		postMessage({ ms: now() - t0, x });
		return;
	}
	case "busy": {
		postMessage({ ready: true });
		let x = 1;
		while (Atomics.load(d.stop, 0) === 0) x ^= spinJs(100000);
		postMessage({ x });
		return;
	}
	case "tw": {
		const ex = new WebAssembly.Instance(d.mod, { env: { memory: d.memory } }).exports;
		const a = new Int32Array(d.memory.buffer), out = [], end = now() + d.budgetMs;
		for (const c of d.cases) {
			const us = [];
			let odd = 0;
			for (let i = 0; i < c.n && now() < end; i++) {
				const t0 = now();
				const r = c.via === "js" ? Atomics.wait(a, d.word, 0, c.ms) : ex.wait(d.word * 4, 0, BigInt(Math.round(c.ms * 1e6)));
				us.push((now() - t0) * 1000);
				if (r !== "timed-out" && r !== 2) odd++;
			}
			out.push({ via: c.via, ms: c.ms, us, odd });
		}
		postMessage({ out, res: resolution() });
		return;
	}
	case "wake": {
		const a = new Int32Array(d.memory.buffer), W0 = d.base, ACK = d.base + 1, ANN = d.base + 2, STOP = d.base + 3;
		if (d.role === "waiter") {
			const ex = d.via === "wasm" ? new WebAssembly.Instance(d.mod, { env: { memory: d.memory } }).exports : null;
			postMessage({ ready: true });
			outer: for (let r = 1; r <= d.rounds; r++) {
				Atomics.store(a, ANN, r);
				let v;
				while ((v = Atomics.load(a, W0)) !== r) {
					if (Atomics.load(a, STOP)) break outer;
					if (d.via === "js") Atomics.wait(a, W0, v, 2000);
					else if (ex) ex.wait(W0 * 4, v, 2000000000n);
				}
				Atomics.store(a, ACK, r);
			}
			postMessage({ done: true });
			return;
		}
		postMessage({ ready: true });
		go(d.go);
		const lat = [], cost = [], end = now() + d.budgetMs;
		let woke = 0, partial = false;
		for (let r = 1; r <= d.rounds && !partial; r++) {
			while (Atomics.load(a, ANN) !== r) if (now() > end) { partial = true; break; }
			if (partial) break;
			const g = now() + d.gapUs / 1000;
			while (now() < g);
			const t0 = now();
			Atomics.store(a, W0, r);
			if (d.via !== "spin") woke += Atomics.notify(a, W0, 1);
			const t1 = now();
			while (Atomics.load(a, ACK) !== r) if (now() > end) { partial = true; break; }
			if (partial) break;
			lat.push((now() - t0) * 1000);
			cost.push((t1 - t0) * 1000);
		}
		Atomics.store(a, STOP, 1);
		Atomics.store(a, W0, -1);
		Atomics.notify(a, W0);
		postMessage({ lat, cost, woke, partial });
		return;
	}
	case "pong": {
		const a = new Int32Array(d.sab), id = d.id;
		postMessage({ ready: true });
		for (let i = 0; i < d.rounds; i++) {
			let v;
			if (d.wait) while ((v = Atomics.load(a, 0)) !== id) Atomics.wait(a, 0, v);
			else while (Atomics.load(a, 0) !== id);
			Atomics.store(a, 0, 1 - id);
			Atomics.notify(a, 0);
		}
		postMessage({ done: true });
		return;
	}
	case "wasm": {
		const ex = new WebAssembly.Instance(d.mod, { env: { memory: d.memory } }).exports;
		const f = ex[{ shared: "rmw", aload1: "aload", aloadadj: "aload", pload1: "pload" }[d.op] || d.op];
		const call = (n) => d.op === "compute" ? f(n) : f(d.addr, n);
		call(Math.max(1000, d.iters >> 4));
		postMessage({ ready: true });
		go(d.go);
		const t0 = now(), x = call(d.iters);
		postMessage({ ms: now() - t0, x });
		return;
	}
	case "compile": {
		const table = new WebAssembly.Table({ element: "anyfunc", initial: 1024 });
		const memory = d.memory || new WebAssembly.Memory({ initial: 16, maximum: 16, shared: true });
		const one = (seed, k) => { const f = new WebAssembly.Instance(new WebAssembly.Module(jitModule(seed, k)), { env: { memory, table } }).exports.f; f(0n, 0n, 0n, 0n); return f; };
		table.set(1023, one(d.seed - 1, 20));
		for (let k = 10; k < 300; k++) template(k);
		postMessage({ ready: true });
		go(d.go);
		let n = 0, bytes = 0, tc = 0, ti = 0, tf = 0, tt = 0, max = 0, slot = 0, failed = 0, err = "";
		const bins = [0, 0, 0], t0 = now(), end = t0 + d.ms;
		let t = t0;
		while (t < end) {
			const m = jitModule(d.seed + n + failed, 10 + ((n * 37) % 290));
			const a = now();
			try {
				const mod = new WebAssembly.Module(m);
				const b = now();
				const f = new WebAssembly.Instance(mod, { env: { memory, table } }).exports.f;
				const c = now();
				f(0n, 0n, 0n, 0n);
				const e = now();
				table.set(slot, f);
				slot = (slot + 1) % 1023;
				t = now();
				tc += b - a; ti += c - b; tf += e - c; tt += t - e;
				if (t - a > max) max = t - a;
				n++;
				bytes += m.length;
				bins[Math.min(2, Math.floor(((t - t0) / d.ms) * 3))]++;
			} catch (e) {
				failed++;
				err = String((e && e.message) || e);
				t = now();
				if (failed > 20) break;
			}
		}
		postMessage({ n, bytes, tc, ti, tf, tt, max, bins, ms: t - t0, failed, err });
		return;
	}
	case "gc": {
		let keep = null;
		if (d.memory) { keep = new Int32Array(d.memory.buffer); keep[0] |= 0; }
		const ring = new Array(1024);
		postMessage({ ready: true });
		go(d.go);
		const t0 = now(), end = t0 + d.ms;
		let last = t0, t = t0, batches = 0, maxGap = 0, over2 = 0;
		while (t < end) {
			for (let i = 0; i < 1000; i++) { const o = { a: i, b: [i, batches], c: null }; o.c = o.b; ring[(batches * 1000 + i) & 1023] = o; }
			batches++;
			t = now();
			const g = t - last;
			last = t;
			if (g > maxGap) maxGap = g;
			if (g > 2) over2++;
		}
		postMessage({ ops: batches * 1000, ms: t - t0, maxGap, over2, attached: keep ? keep.length * 4 : 0 });
		return;
	}
	}
	throw new Error("unknown job " + d.kind);
}
onmessage = (e) => {
	const d = e.data;
	if (d.kind === "parent") {
		const url = URL.createObjectURL(new Blob([d.src], { type: "text/javascript" }));
		const kids = [];
		for (let i = 0; i < d.n; i++) {
			const w = new Worker(url);
			w.onmessage = (m) => postMessage({ i, m: m.data });
			w.onerror = (ev) => { ev.preventDefault(); postMessage({ i, m: { error: "nested worker: " + (ev.message || "error") } }); };
			kids.push(w);
		}
		onmessage = (m) => kids[m.data.to].postMessage(m.data.m);
		return;
	}
	try { job(d); } catch (err) { postMessage({ error: String((err && err.message) || err) }); }
};`;

let workerUrl: string | null = null;
const getWorkerUrl = () => (workerUrl ??= URL.createObjectURL(new Blob([WORKER_SRC], { type: "text/javascript" })));

type Msg = any;
class Mailbox {
	#q: Msg[] = [];
	#w: { res: (m: Msg) => void; rej: (e: Error) => void } | undefined;
	#err: Error | undefined;
	push(m: Msg) {
		if (m && typeof m === "object" && "error" in m) return this.fail(new Error(String(m.error)));
		if (this.#w) { const w = this.#w; this.#w = undefined; w.res(m); } else this.#q.push(m);
	}
	fail(e: Error) {
		this.#err ??= e;
		if (this.#w) { const w = this.#w; this.#w = undefined; w.rej(e); }
	}
	next(): Promise<Msg> {
		if (this.#q.length) return Promise.resolve(this.#q.shift());
		if (this.#err) return Promise.reject(this.#err);
		return new Promise((res, rej) => { this.#w = { res, rej }; });
	}
}

interface Pool { n: number; nested: boolean; startMs: number; post(i: number, m: Msg): void; next(i: number): Promise<Msg>; all(): Promise<Msg[]>; close(): void }
const livePools = new Set<Pool>();
const closeAll = () => { for (const p of livePools) p.close(); };

/** n probe workers, top-level or nested in one parent worker, each answering a ping. */
async function makePool(n: number, nested: boolean): Promise<Pool> {
	const boxes = Array.from({ length: n }, () => new Mailbox());
	const workers: Worker[] = [];
	const failAll = (e: Error) => boxes.forEach((b) => b.fail(e));
	let post: (i: number, m: Msg) => void;
	const t0 = performance.now();
	if (nested) {
		const p = new Worker(getWorkerUrl());
		workers.push(p);
		p.onerror = (e) => { e.preventDefault(); failAll(new Error(`parent worker: ${e.message || "error"}`)); };
		p.onmessage = (e) => boxes[e.data.i]?.push(e.data.m);
		p.postMessage({ kind: "parent", n, src: WORKER_SRC });
		post = (i, m) => p.postMessage({ to: i, m });
	} else {
		for (let i = 0; i < n; i++) {
			const w = new Worker(getWorkerUrl());
			w.onerror = (e) => { e.preventDefault(); boxes[i]!.fail(new Error(`worker: ${e.message || "error"}`)); };
			w.onmessage = (e) => boxes[i]!.push(e.data);
			workers.push(w);
		}
		post = (i, m) => workers[i]!.postMessage(m);
	}
	const pool: Pool = {
		n, nested, startMs: 0, post,
		next: (i) => boxes[i]!.next(),
		all: () => Promise.all(boxes.map((b) => b.next())),
		close: () => { workers.forEach((w) => w.terminate()); failAll(new Error("closed")); livePools.delete(pool); },
	};
	livePools.add(pool);
	try {
		for (let i = 0; i < n; i++) post(i, { kind: "ping" });
		await withTimeout(pool.all(), 20000, `starting ${n} ${nested ? "nested " : ""}workers`);
	} catch (e) {
		pool.close();
		throw e;
	}
	pool.startMs = r1(performance.now() - t0);
	return pool;
}

/** Post one timed job per worker, wait until all are set up, release them at once, collect the results. */
async function timed(p: Pool, jobs: (go: Int32Array, i: number) => Msg, ms = 60000): Promise<Msg[]> {
	const go = new Int32Array(new SharedArrayBuffer(4));
	for (let i = 0; i < p.n; i++) p.post(i, jobs(go, i));
	await withTimeout(p.all(), ms, "workers getting ready");
	Atomics.store(go, 0, 1);
	return withTimeout(p.all(), ms, "workers running");
}

// --- a tiny wasm module on a shared memory -----------------------------------------
const leb = (v: number): number[] => { const o: number[] = []; do { let b = v & 0x7f; v = Math.floor(v / 128); if (v) b |= 0x80; o.push(b); } while (v); return o; };
const sleb = (v: number): number[] => { const o: number[] = []; for (;;) { const b = v & 0x7f; v >>= 7; if ((v === 0 && !(b & 0x40)) || (v === -1 && b & 0x40)) { o.push(b); return o; } o.push(b | 0x80); } };
const sec = (id: number, body: number[]) => [id, ...leb(body.length), ...body];
const str = (s: string) => [s.length, ...Array.from(s, (c) => c.charCodeAt(0))];
const fn = (locals: number[], code: number[]) => { const b = [...locals, ...code, 0x0b]; return [...leb(b.length), ...b]; };
// Loop skeleton: block loop (i >= iters ? exit) BODY i++ br 0 end end, i in local `i`, iters in local `n`.
const loopOf = (i: number, n: number, body: number[]) => [0x02, 0x40, 0x03, 0x40, 0x20, i, 0x20, n, 0x4f, 0x0d, 0x01, ...body, 0x20, i, 0x41, 0x01, 0x6a, 0x21, i, 0x0c, 0x00, 0x0b, 0x0b];
/**
 * env.memory (shared, any size up to 4 GiB) and:
 * plain(addr, iters): x = x*a + c + load(addr + (i&63)*4); store(addr + ((i+7)&63)*4, x)
 * rmw(addr, iters): i32.atomic.rmw.add(addr, 1) per iteration
 * fence(addr, iters): store(addr, i); atomic.fence per iteration
 * compute(iters): xorshift in locals, no memory
 * wait(addr, expected, timeout_ns: i64): memory.atomic.wait32
 * notify(addr, count): memory.atomic.notify
 */
function probeModuleBytes(): Uint8Array {
	const idx = (l: number) => [0x20, 0, 0x20, l, 0x41, 0x3f, 0x71, 0x41, 0x02, 0x74, 0x6a];
	const plain = fn([0x01, 0x02, 0x7f], [
		0x20, 0, 0x28, 0x02, 0x00, 0x21, 3,
		...loopOf(2, 1, [
			0x20, 3, 0x41, ...sleb(1103515245), 0x6c, 0x41, ...sleb(12345), 0x6a,
			...idx(2), 0x28, 0x02, 0x00, 0x6a, 0x21, 3,
			0x20, 0, 0x20, 2, 0x41, 0x07, 0x6a, 0x41, 0x3f, 0x71, 0x41, 0x02, 0x74, 0x6a, 0x20, 3, 0x36, 0x02, 0x00,
		]),
		0x20, 3,
	]);
	const rmw = fn([0x01, 0x01, 0x7f], [...loopOf(2, 1, [0x20, 0, 0x41, 0x01, 0xfe, 0x1e, 0x02, 0x00, 0x1a]), 0x20, 0, 0xfe, 0x10, 0x02, 0x00]);
	const fence = fn([0x01, 0x01, 0x7f], [...loopOf(2, 1, [0x20, 0, 0x20, 2, 0x36, 0x02, 0x00, 0xfe, 0x03, 0x00]), 0x20, 0, 0x28, 0x02, 0x00]);
	const xs = (sh: number, op: number) => [0x20, 2, 0x20, 2, 0x41, sh, op, 0x73, 0x21, 2];
	const compute = fn([0x01, 0x02, 0x7f], [0x41, 0x01, 0x21, 2, ...loopOf(1, 0, [...xs(13, 0x74), ...xs(17, 0x76), ...xs(5, 0x74)]), 0x20, 2]);
	const wait = fn([0x00], [0x20, 0, 0x20, 1, 0x20, 2, 0xfe, 0x01, 0x02, 0x00]);
	const notify = fn([0x00], [0x20, 0, 0x20, 1, 0xfe, 0x00, 0x02, 0x00]);
	// aload/pload(addr, iters): x += i64.atomic.load(addr) / i64.load(addr) per iteration (kwemu's code-epoch poll at every block end).
	const ld = (op: number[]) => fn([0x01, 0x02, 0x7f], [...loopOf(2, 1, [0x20, 3, 0x20, 0, ...op, 0x03, 0x00, 0xa7, 0x6a, 0x21, 3]), 0x20, 3]);
	const aload = ld([0xfe, 0x11]), pload = ld([0x29]);
	const names = ["plain", "rmw", "fence", "compute", "wait", "notify", "aload", "pload"];
	return new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
		...sec(1, [0x03, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f, 0x60, 0x03, 0x7f, 0x7f, 0x7e, 0x01, 0x7f, 0x60, 0x01, 0x7f, 0x01, 0x7f]),
		...sec(2, [0x01, ...str("env"), ...str("memory"), 0x02, 0x03, 0x01, ...leb(65536)]),
		...sec(3, [0x08, 0x00, 0x00, 0x00, 0x02, 0x01, 0x00, 0x00, 0x00]),
		...sec(7, [0x08, ...names.flatMap((n, i) => [...str(n), 0x00, i])]),
		...sec(10, [0x08, ...plain, ...rmw, ...fence, ...compute, ...wait, ...notify, ...aload, ...pload]),
	]);
}
let probeModule: WebAssembly.Module | null = null;
const getProbeModule = () => (probeModule ??= new WebAssembly.Module(probeModuleBytes() as BufferSource));
const sharedMemory = (mib: number) => new WebAssembly.Memory({ initial: mib * 16, maximum: mib * 16, shared: true });

// --- part A ---------------------------------------------------------------------------
interface Row { n: number; ms: number; runs: number[]; speedup: number }
interface Dist { minUs: number; medUs: number; p95Us: number; maxUs: number; meanUs: number; count: number }
const dist = (us: number[]): Dist => ({ minUs: r1(Math.min(...us)), medUs: r1(median(us)), p95Us: r1(pct(us, 0.95)), maxUs: r1(Math.max(...us)), meanUs: r1(us.reduce((a, x) => a + x, 0) / (us.length || 1)), count: us.length });
interface PartA {
	nested: boolean;
	probeMemMiB?: number;
	spin?: { iters: number; top: (Row & { startMs: number })[]; nested: (Row & { startMs: number })[] };
	timedWait?: { workerResUs: number; cases: ({ load: number; via: string; targetUs: number; unexpected: number } & Dist)[] };
	wake?: { pong: { waitUs?: number; spinUs?: number }; gapUs: number; cases: ({ via: string; pairs: number; rounds: number; notifyUs: number; wokeFrac: number; partial: boolean } & Dist)[] };
	wasm?: { memMiB: number; cases: { op: string; iters: number; rows: (Row & { nsPerOp: number })[] }[] };
	compile?: { cases: { mem: string; rows: { n: number; perSec: number; perWorker: number; speedup: number; usCompile: number; usInstantiate: number; usCall: number; usTable: number; maxMs: number; bytesAvg: number; thirds: number[]; failed: number; err?: string }[] }[] };
	gc?: { memMiB: number; cases: { attached: boolean; rows: { n: number; mops: number; speedup: number; maxPauseMs: number; pausesOver2: number }[] }[] };
	errors: Record<string, string>;
}
interface ACtx { a: PartA; nested: boolean; memory: WebAssembly.Memory | null; memMiB: number; quick: boolean; cancel: boolean }
const ck = (c: ACtx) => { check(); if (c.cancel) throw new Stopped(); };

const counts = [1, 2, 4, 8].filter((n) => n <= Math.max(2, hc));

async function probeSpin(c: ACtx) {
	const iters = c.quick ? 10_000_000 : 100_000_000, runs = c.quick ? 1 : 3;
	const out: NonNullable<PartA["spin"]> = { iters, top: [], nested: [] };
	c.a.spin = out;
	for (const nested of [false, true]) {
		const rows = nested ? out.nested : out.top;
		for (const n of counts) {
			ck(c);
			status(`A spin: ${n} ${nested ? "nested " : ""}workers`);
			const p = await makePool(n, nested);
			try {
				await timed(p, (go) => ({ kind: "spin", iters: iters / 10, go })); // warm up
				const ms: number[] = [];
				for (let r = 0; r < runs; r++) ms.push(Math.max(...(await timed(p, (go) => ({ kind: "spin", iters, go }))).map((m) => m.ms as number)));
				const t = median(ms), t1 = rows[0]?.ms ?? t;
				rows.push({ n, ms: r1(t), runs: ms.map(r1), speedup: r2((n * t1) / t), startMs: p.startMs });
			} finally {
				p.close();
			}
			render();
		}
	}
}

async function probeTimedWait(c: ACtx) {
	const mod = getProbeModule(), memory = sharedMemory(1);
	const cases = [0.02, 0.1, 1].flatMap((ms) => ["js", "wasm"].map((via) => ({ via, ms, n: c.quick ? 40 : ms < 1 ? 200 : 50 })));
	const out: NonNullable<PartA["timedWait"]> = { workerResUs: NaN, cases: [] };
	c.a.timedWait = out;
	const loads = [0, ...(hc >= 3 ? [Math.min(4, hc - 1)] : [])];
	for (const load of loads) {
		ck(c);
		status(`A timed waits${load ? ` beside ${load} busy workers` : ""}`);
		const p = await makePool(1 + load, c.nested);
		const stop = new Int32Array(new SharedArrayBuffer(4));
		try {
			for (let i = 1; i <= load; i++) p.post(i, { kind: "busy", stop });
			for (let i = 1; i <= load; i++) await withTimeout(p.next(i), 20000, "busy worker");
			p.post(0, { kind: "tw", mod, memory, word: 16, cases, budgetMs: c.quick ? 3000 : 10000 });
			const r = await withTimeout(p.next(0), 30000, "timed waits");
			out.workerResUs = r2(r.res);
			for (const x of r.out as { via: string; ms: number; us: number[]; odd: number }[]) {
				if (x.us.length) out.cases.push({ load, via: x.via, targetUs: x.ms * 1000, unexpected: x.odd, ...dist(x.us) });
			}
		} finally {
			Atomics.store(stop, 0, 1);
			p.close();
		}
		render();
	}
}

async function probeWake(c: ACtx) {
	const out: NonNullable<PartA["wake"]> = { pong: {}, gapUs: 200, cases: [] };
	c.a.wake = out;
	// The round trip of profile.html's Host threads (mean over many turns).
	for (const wait of [true, false]) {
		ck(c);
		status(`A wake: ${wait ? "wait/notify" : "spinning"} round trips`);
		const rounds = (wait ? 5000 : 50000) / (c.quick ? 5 : 1);
		const sab = new SharedArrayBuffer(8), a = new Int32Array(sab);
		a[0] = -1;
		const p = await makePool(2, c.nested);
		try {
			p.post(0, { kind: "pong", sab, id: 0, rounds, wait });
			p.post(1, { kind: "pong", sab, id: 1, rounds, wait });
			await withTimeout(p.all(), 20000, "pong workers");
			const t0 = performance.now();
			Atomics.store(a, 0, 0);
			Atomics.notify(a, 0);
			await withTimeout(p.all(), 30000, "pong");
			const us = r2(((performance.now() - t0) * 1000) / rounds);
			if (wait) out.pong.waitUs = us;
			else out.pong.spinUs = us;
		} finally {
			p.close();
		}
	}
	const mod = getProbeModule();
	const pairsList = [1, 2, 4].filter((n) => n === 1 || 2 * n <= hc);
	for (const via of ["js", "wasm", "spin"]) {
		for (const pairs of pairsList) {
			ck(c);
			status(`A wake: ${via}, ${pairs} pair${pairs > 1 ? "s" : ""}`);
			const memory = sharedMemory(1), rounds = c.quick ? 60 : 300;
			const p = await makePool(2 * pairs, c.nested);
			try {
				const res = await timed(p, (go, i) => ({ kind: "wake", role: i % 2 ? "waker" : "waiter", via, base: (i >> 1) * 32, rounds, gapUs: out.gapUs, budgetMs: c.quick ? 3000 : 8000, memory, mod, go }), 30000);
				const wakers = res.filter((_, i) => i % 2) as { lat: number[]; cost: number[]; woke: number; partial: boolean }[];
				const lat = wakers.flatMap((w) => w.lat), cost = wakers.flatMap((w) => w.cost);
				if (lat.length) out.cases.push({ via, pairs, rounds: lat.length, notifyUs: r2(cost.reduce((x, y) => x + y, 0) / cost.length), wokeFrac: r2(wakers.reduce((x, w) => x + w.woke, 0) / lat.length), partial: wakers.some((w) => w.partial), ...dist(lat) });
			} finally {
				p.close();
			}
			render();
		}
	}
}

async function probeWasm(c: ACtx) {
	const mod = getProbeModule();
	const memory = c.memory ?? sharedMemory(16), memMiB = c.memory ? c.memMiB : 16;
	const out: NonNullable<PartA["wasm"]> = { memMiB, cases: [] };
	c.a.wasm = out;
	const runs = c.quick ? 1 : 3, target = c.quick ? 60 : 150;
	const ops = ["compute", "plain", "rmw", "shared", "fence", "aload", "aloadadj", "aload1", "pload1"];
	const addr = (op: string, i: number) => op === "shared" || op === "aload1" || op === "pload1" ? 512 * 1024 : op === "aloadadj" ? 768 * 1024 + i * 8 : 1024 * 1024 + i * 4096;
	// Iterations for about `target` ms on one worker.
	const p1 = await makePool(1, c.nested);
	try {
		for (const op of ops) {
			ck(c);
			status(`A wasm: calibrating ${op}`);
			let iters = 1_000_000, ms = 0;
			for (let k = 0; k < 4; k++) {
				ms = (await timed(p1, (go) => ({ kind: "wasm", mod, memory, op, addr: addr(op, 0), iters, go })))[0].ms;
				if (ms >= 20) break;
				iters *= 10;
			}
			out.cases.push({ op, iters: Math.min(2e9, Math.max(1000, Math.round((iters * target) / Math.max(ms, 0.1)))), rows: [] });
		}
	} finally {
		p1.close();
	}
	for (const n of counts) {
		ck(c);
		const p = await makePool(n, c.nested);
		try {
			for (const cs of out.cases) {
				ck(c);
				status(`A wasm: ${cs.op} in ${n} workers`);
				const ms: number[] = [];
				// One shared word: the same total work split among the workers (contention, not throughput).
				const shared = cs.op === "shared", iters = shared ? Math.ceil(cs.iters / n) : cs.iters;
				for (let r = 0; r < runs; r++) ms.push(Math.max(...(await timed(p, (go, i) => ({ kind: "wasm", mod, memory, op: cs.op, addr: addr(cs.op, i), iters, go }))).map((m) => m.ms as number)));
				const t = median(ms), t1 = cs.rows[0]?.ms ?? t;
				cs.rows.push({ n, ms: r1(t), runs: ms.map(r1), speedup: r2(((shared ? 1 : n) * t1) / t), nsPerOp: r2((t * 1e6) / (shared ? iters * n : iters)) });
				render();
			}
		} finally {
			p.close();
		}
	}
}

let seedBase = 1;
async function probeCompile(c: ACtx) {
	const out: NonNullable<PartA["compile"]> = { cases: [{ mem: c.memory ? `one shared ${c.memMiB} MiB memory (as kwemu)` : "one shared 16 MiB memory", rows: [] }, { mem: "own small shared memory per worker", rows: [] }] };
	c.a.compile = out;
	const memory = c.memory ?? sharedMemory(16), ms = c.quick ? 400 : 1000;
	for (const n of counts) {
		ck(c);
		const p = await makePool(n, c.nested);
		try {
			for (const [k, cs] of out.cases.entries()) {
				ck(c);
				status(`A compile: ${n} workers, ${k ? "own memory" : "one memory"}`);
				seedBase += 10_000_000;
				const res = await timed(p, (go, i) => ({ kind: "compile", memory: k ? null : memory, ms, seed: seedBase + i * 1_000_000, go }), ms + 60000);
				const sum = (f: (m: Msg) => number) => res.reduce((a, m) => a + f(m), 0);
				const total = sum((m) => m.n), perSec = sum((m) => (m.n * 1000) / m.ms);
				const t1 = cs.rows[0]?.perSec ?? perSec;
				const us = (f: (m: Msg) => number) => r1((sum(f) * 1000) / Math.max(1, total));
				const err = res.find((m) => m.err)?.err as string | undefined;
				cs.rows.push({
					n, perSec: r0(perSec), perWorker: r0(perSec / n), speedup: r2(perSec / t1),
					usCompile: us((m) => m.tc), usInstantiate: us((m) => m.ti), usCall: us((m) => m.tf), usTable: us((m) => m.tt),
					maxMs: r1(Math.max(...res.map((m) => m.max as number))), bytesAvg: r0(sum((m) => m.bytes) / Math.max(1, total)),
					thirds: [0, 1, 2].map((b) => sum((m) => m.bins[b])), failed: sum((m) => m.failed), ...(err ? { err } : {}),
				});
				render();
			}
		} finally {
			p.close();
		}
	}
}

async function probeGc(c: ACtx) {
	const memMiB = c.memory ? c.memMiB : 0;
	const out: NonNullable<PartA["gc"]> = { memMiB, cases: [{ attached: false, rows: [] }, ...(c.memory ? [{ attached: true, rows: [] }] : [])] };
	c.a.gc = out;
	const ms = c.quick ? 400 : 1000;
	for (const n of counts) {
		for (const cs of out.cases) {
			ck(c);
			status(`A gc: ${n} workers${cs.attached ? `, ${memMiB} MiB attached` : ""}`);
			// A fresh pool each time: a worker that once held the memory keeps counting it.
			const p = await makePool(n, c.nested);
			try {
				const res = await timed(p, (go) => ({ kind: "gc", memory: cs.attached ? c.memory : null, ms, go }), ms + 60000);
				const mops = res.reduce((a, m) => a + m.ops / m.ms / 1000, 0), t1 = cs.rows[0]?.mops ?? mops;
				cs.rows.push({ n, mops: r2(mops), speedup: r2(mops / t1), maxPauseMs: r1(Math.max(...res.map((m) => m.maxGap as number))), pausesOver2: res.reduce((a, m) => a + m.over2, 0) });
			} finally {
				p.close();
			}
			render();
		}
	}
}

const probes: { id: string; label: string; run: (c: ACtx) => Promise<void>; timeout: number }[] = [
	{ id: "spin", label: "spin workers, top-level and nested", run: probeSpin, timeout: 120000 },
	{ id: "timedWait", label: "timed wait accuracy (20 µs, 100 µs, 1 ms)", run: probeTimedWait, timeout: 90000 },
	{ id: "wake", label: "notify-to-wake latency, round trips", run: probeWake, timeout: 150000 },
	{ id: "wasm", label: "wasm on one shared memory", run: probeWasm, timeout: 150000 },
	{ id: "compile", label: "compile + instantiate + table.set", run: probeCompile, timeout: 120000 },
	{ id: "gc", label: "GC churn, shared memory attached or not", run: probeGc, timeout: 90000 },
];
const probesOn = q.get("probes")?.split(",");
$("probes").innerHTML = probes.map((p) => `<label><input type="checkbox" data-probe="${p.id}"${!probesOn || probesOn.includes(p.id) ? " checked" : ""}> ${p.label}</label>`).join("");

async function runA(): Promise<void> {
	const nested = $<HTMLInputElement>("nested").checked;
	const quick = q.get("quick") === "1";
	const a: PartA = { nested, errors: {} };
	report.a = a;
	report.options.a = { nested, quick, probeMemMiB: Number($<HTMLInputElement>("pmem").value) || 512 };
	// The large shared memory (like the kernel's): halve until it is granted.
	let memory: WebAssembly.Memory | null = null, memMiB = Number($<HTMLInputElement>("pmem").value) || 512;
	while (!memory && memMiB >= 16) {
		try {
			memory = sharedMemory(memMiB);
		} catch {
			log(`A: a shared memory of ${memMiB} MiB was refused`);
			memMiB >>= 1;
		}
	}
	a.probeMemMiB = memory ? memMiB : 0;
	for (const p of probes) {
		if (stopped) break;
		if (!document.querySelector<HTMLInputElement>(`[data-probe="${p.id}"]`)!.checked) continue;
		log(`A: ${p.label}`);
		const t0 = performance.now();
		// A fresh context per probe: one that timed out stops at its next check.
		const c: ACtx = { a, nested, memory, memMiB, quick, cancel: false };
		try {
			const run = p.run(c);
			run.catch(() => {});
			await withTimeout(run, p.timeout, p.id).finally(() => { c.cancel = true; });
		} catch (e) {
			if (!(e instanceof Stopped)) {
				a.errors[p.id] = errText(e);
				log(`A: ${p.id} failed: ${errText(e)}`);
			}
		} finally {
			closeAll();
		}
		log(`A: ${p.id} took ${r1((performance.now() - t0) / 1000)} s`);
		render();
	}
}

// --- part B -----------------------------------------------------------------------------
interface BConf { id: string; label: string; cpus: number; jit: boolean; base: string; scale: number; variants: boolean; on: boolean }
const bconfs: BConf[] = [
	{ id: "1", label: "1 CPU (UP kernel)", cpus: 1, jit: true, base: "1", scale: 1, variants: false, on: true },
	{ id: "2", label: "2 CPUs", cpus: 2, jit: true, base: "1", scale: 1, variants: false, on: true },
	{ id: "4", label: "4 CPUs (+ the parameter variants)", cpus: 4, jit: true, base: "1", scale: 1, variants: true, on: true },
	{ id: "8", label: "8 CPUs", cpus: 8, jit: true, base: "1", scale: 1, variants: false, on: false },
	{ id: "1-nojit", label: "1 CPU, JIT off (0.25x work)", cpus: 1, jit: false, base: "1-nojit", scale: 0.25, variants: false, on: true },
	{ id: "4-nojit", label: "4 CPUs, JIT off (0.25x work)", cpus: 4, jit: false, base: "1-nojit", scale: 0.25, variants: false, on: true },
].filter((c) => c.cpus === 1 || (!smpWhy && c.cpus <= cpuMax));
interface Variant { id: string; label: string; params: Record<string, string> }
const variants: Variant[] = [
	{ id: "default", label: "defaults", params: {} },
	{ id: "spin0", label: "kw_spin_us=0 (spin only)", params: { kw_spin_us: "0" } },
	{ id: "spin2000", label: "kw_spin_us=2000", params: { kw_spin_us: "2000" } },
	{ id: "fair", label: "kw_spin_unfair=0 (ticket locks)", params: { kw_spin_unfair: "0" } },
];
const PARAMS = ["kw_spin_us", "kw_spin_sleep_us", "kw_spin_unfair"];
interface Work { id: string; label: string; n0: number; cmd: (n: number) => string }
const works: Work[] = [
	{ id: "compute", label: "user compute (awk loop)", n0: 100000, cmd: (n) => `awk 'BEGIN{s=0;for(i=0;i<${n};i++)s+=i%7;print s}'` },
	{ id: "syscall", label: "syscalls (dd bs=1)", n0: 20000, cmd: (n) => `dd if=/dev/zero of=/dev/null bs=1 count=${n}` },
	{ id: "fork", label: "fork+exec /bin/true", n0: 20, cmd: (n) => `i=0; while [ $i -lt ${n} ]; do /bin/true; i=$((i+1)); done` },
];
// `copies` copies at once, each timing itself with /proc/uptime (10 ms steps).
const parallel = (cmd: string, copies: number) => `w() { read a _ < /proc/uptime; ${cmd} >/dev/null 2>&1; read b _ < /proc/uptime; echo "T $a $b"; }
j=0; while [ $j -lt ${copies} ]; do w & j=$((j+1)); done; wait`;

const confsOn = q.get("configs")?.split(","), variantsOn = q.get("variants")?.split(",");
$("configs").innerHTML = bconfs.map((c) => `<label><input type="checkbox" data-conf="${c.id}"${(confsOn ? confsOn.includes(c.id) : c.on) ? " checked" : ""}> ${c.label}</label>`).join("") +
	(smpWhy ? `<div class="dim">No SMP: ${smpWhy}</div>` : "");
$("variants").innerHTML = `<span class="dim">variants on 4 CPUs:</span> ` + variants.map((v) => `<label><input type="checkbox" data-variant="${v.id}"${!variantsOn || variantsOn.includes(v.id) ? " checked" : ""}${v.id === "default" ? " disabled" : ""}> ${v.label}</label>`).join("");
$<HTMLSelectElement>("distro").innerHTML = [...DISTROS_OFFERED.map((d) => d.name), "none"].map((n) => `<option${n === (q.get("distro") ?? DEFAULT_DISTRO) ? " selected" : ""}>${n}</option>`).join("");
for (const k of ["mem", "runs", "scale", "sizes", "pmem"]) if (q.has(k)) $<HTMLInputElement>(k).value = q.get(k)!;
if (q.get("nested") === "0") $<HTMLInputElement>("nested").checked = false;

interface Capture { kwmove: Record<string, number>; stat: Record<string, number[]>; irq: Record<string, number[]> }
interface Deltas {
	cpu?: { busy: number; user: number; sys: number; idle: number }[];
	ctxt?: number; processes?: number; intr?: number;
	kwmove?: Record<string, number>;
	irq?: Record<string, number[]>;
	jit?: { compiled: number; compileMs: number; maxCompileMs: number; failed: number; refused: number; retained: number }[];
	kernel?: { switches: number; idles: number; yields: number };
}
interface BCell { variant: string; work: string; copies: number; size: number; cold: number; runs: number[]; median: number; perCopy?: { min: number; max: number }; deltas?: Deltas; error?: string }
interface BBoot { conf: string; label: string; cpus: number; jit: boolean; kernelMs?: number; bootMs?: number; nproc?: string; uname?: string; params?: Record<string, string>; cells: BCell[]; variantParams: Record<string, Record<string, string>>; error?: string }
interface PartB { distro: string; memMiB: number; runs: number; scale: number; copies: number; sizes: Record<string, number>; boots: BBoot[] }

const modules = new Map<string, Promise<WebAssembly.Module>>();
function kernelModule(smp: boolean): Promise<WebAssembly.Module> {
	const url = (smp ? kernelSmpUrl : kernelUrl)!.href;
	let p = modules.get(url);
	if (!p) modules.set(url, p = loadKernelModule(url, { what: "kernel" }));
	return p;
}

/** The JIT and kernel counters: a worker kernel's stats() is a snapshot it sends every 500 ms. */
async function snapStats(vm: KernelHandle): Promise<InstanceStats | undefined> {
	await sleep(600);
	try { return vm.stats(); } catch { return undefined; }
}

/** /proc/kwmove, /proc/interrupts and /proc/stat, read right before and after a timed run. */
async function capture(vm: KernelHandle, signal: AbortSignal): Promise<Capture> {
	const r = await vm.exec("sh", ["-c", "cat /proc/kwmove 2>/dev/null; echo ===; cat /proc/interrupts 2>/dev/null; echo ===; cat /proc/stat"], { signal, timeout: 30000 });
	const [mv = "", irq = "", st = ""] = r.stdout.split("===\n");
	const kwmove: Record<string, number> = {};
	const toks = mv.trim().split(/\s+/);
	for (let i = 0; i + 1 < toks.length; i += 2) kwmove[toks[i]!] = Number(toks[i + 1]);
	const stat: Record<string, number[]> = {};
	for (const l of st.split("\n")) {
		const t = l.trim().split(/\s+/);
		if (t[0] && t.length > 1) stat[t[0]] = t.slice(1).map(Number);
	}
	const irqs: Record<string, number[]> = {};
	const lines = irq.split("\n");
	const ncpu = (lines[0]?.match(/CPU\d+/g) ?? []).length;
	for (const l of lines.slice(1)) {
		const t = l.trim().split(/\s+/);
		if (!t[0]?.endsWith(":")) continue;
		const nums = t.slice(1, 1 + ncpu).map(Number);
		if (nums.some((x) => !Number.isFinite(x))) continue;
		irqs[`${t[0]} ${t.slice(1 + ncpu).join(" ")}`.trim()] = nums;
	}
	return { kwmove, stat, irq: irqs };
}

function deltas(a: Capture | undefined, b: Capture | undefined, sa: InstanceStats | undefined, sb: InstanceStats | undefined): Deltas {
	const d: Deltas = {};
	if (a && b) procDeltas(d, a, b);
	if (sa && sb) {
		const ja = sa.jitCpus ?? [sa.jit], jb = sb.jitCpus ?? [sb.jit];
		d.jit = jb.map((y, i) => {
			const x = ja[i] ?? y;
			return { compiled: y.compiled - x.compiled, compileMs: r1(y.compileMs - x.compileMs), maxCompileMs: r1(y.maxCompileMs), failed: y.failed - x.failed, refused: y.refused - x.refused, retained: y.retained };
		});
		d.kernel = { switches: sb.switches - sa.switches, idles: sb.idles - sa.idles, yields: sb.yields - sa.yields };
	}
	return d;
}

function procDeltas(d: Deltas, a: Capture, b: Capture): void {
	const cpus = Object.keys(b.stat).filter((k) => /^cpu\d+$/.test(k)).sort((x, y) => Number(x.slice(3)) - Number(y.slice(3)));
	d.cpu = cpus.map((k) => {
		const x = a.stat[k] ?? [], y = b.stat[k]!;
		const v = y.map((n, i) => n - (x[i] ?? 0));
		const [user = 0, nice = 0, sys = 0, idle = 0, iowait = 0, irq = 0, softirq = 0] = v;
		const total = Math.max(1, v.slice(0, 8).reduce((s, n) => s + n, 0));
		return { busy: r0((100 * (total - idle - iowait)) / total), user: r0((100 * (user + nice)) / total), sys: r0((100 * (sys + irq + softirq)) / total), idle: r0((100 * (idle + iowait)) / total) };
	});
	const one = (k: string) => (b.stat[k]?.[0] ?? 0) - (a.stat[k]?.[0] ?? 0);
	d.ctxt = one("ctxt");
	d.processes = one("processes");
	d.intr = one("intr");
	if (Object.keys(b.kwmove).length) d.kwmove = Object.fromEntries(Object.entries(b.kwmove).map(([k, v]) => [k, v - (a.kwmove[k] ?? 0)]));
	d.irq = {};
	for (const [k, v] of Object.entries(b.irq)) {
		const dv = v.map((n, i) => n - (a.irq[k]?.[i] ?? 0));
		if (dv.some((n) => n)) d.irq[k] = dv;
	}
}

const readParams = (vm: KernelHandle, signal: AbortSignal) => vm.exec("sh", ["-c", 'cd /sys/module/kernel/parameters 2>/dev/null && for p in ' + PARAMS.join(" ") + '; do [ -e $p ] && echo "$p=$(cat $p)"; done; true'], { signal, timeout: 30000 })
	.then((r) => Object.fromEntries(r.stdout.trim().split("\n").filter(Boolean).map((l) => l.split("=") as [string, string])));
async function writeParams(vm: KernelHandle, kv: Record<string, string>, signal: AbortSignal): Promise<void> {
	const args = Object.entries(kv).map(([k, v]) => `${k}=${v}`);
	if (!args.length) return;
	const r = await execAsRoot(vm, 'for kv in "$@"; do echo "${kv#*=}" > "/sys/module/kernel/parameters/${kv%%=*}" || exit 1; done', args, { signal, timeout: 30000 });
	if (r.exitCode !== 0) throw new Error(`writing ${args.join(" ")} failed: ${r.stderr.trim().slice(0, 200)}`);
}

async function runConf(conf: BConf, b: PartB, vs: Variant[], signal: AbortSignal): Promise<BBoot> {
	const boot: BBoot = { conf: conf.id, label: conf.label, cpus: conf.cpus, jit: conf.jit, cells: [], variantParams: {} };
	const smp = conf.cpus > 1;
	status(`B ${conf.label}: loading the kernel`);
	let vm: KernelHandle | undefined;
	try {
		const kernel = await withTimeout(kernelModule(smp), 180000, "loading the kernel");
		const distro = DISTROS_OFFERED.find((d) => d.name === b.distro)?.url;
		status(`B ${conf.label}: booting`);
		const t0 = performance.now();
		vm = await withTimeout(createKernel({
			kernel, memoryMiB: b.memMiB, jit: conf.jit, distro, vsock: true, worker: true, cpus: smp ? conf.cpus : undefined,
			display: false, sound: false, consoleSize: { cols: 80, rows: 24 }, log: (m: string) => console.log(m),
		}), 180000, "booting");
		boot.kernelMs = r0(performance.now() - t0);
		await vm.exec("true", [], { timeout: 180000, signal });
		boot.bootMs = r0(performance.now() - t0);
		const info = await vm.exec("sh", ["-c", "nproc; uname -rv; cat /run/kw-base 2>/dev/null"], { signal, timeout: 30000 });
		const [nproc = "?", ...rest] = info.stdout.trim().split("\n");
		boot.nproc = nproc;
		boot.uname = rest.join(" | ");
		boot.params = await readParams(vm, signal).catch(() => ({}));
		log(`B ${conf.label}: kernel up in ${boot.kernelMs} ms, shell in ${boot.bootMs} ms, nproc ${boot.nproc}, ${boot.uname}, ${JSON.stringify(boot.params)}`);
		const run = async (cmd: string) => {
			const s = performance.now();
			const r = await vm!.exec("sh", ["-c", cmd], { signal, timeout: 300000 });
			const ms = performance.now() - s;
			if (r.exitCode !== 0) throw new Error(`exit ${r.exitCode ?? `signal ${r.signal}`}: ${r.stderr.trim().slice(0, 200)}`);
			const copies = [...r.stdout.matchAll(/^T ([\d.]+) ([\d.]+)$/gm)].map((m) => (Number(m[2]) - Number(m[1])) * 1000);
			return { ms, copies };
		};
		// Sizes: one copy for about 300 ms (times the size option) on the first configuration, unless given.
		for (const w of works) {
			if (b.sizes[w.id]) continue;
			check();
			status(`B ${conf.label}: calibrating ${w.id}`);
			let n = w.n0, ms = 0;
			for (let k = 0; k < 5; k++) {
				ms = (await run(parallel(w.cmd(n), 1))).ms;
				if (ms >= 150) break;
				n *= ms < 15 ? 10 : 3;
			}
			b.sizes[w.id] = Math.max(1, Math.round((n * 300 * b.scale) / Math.max(ms, 1) / conf.scale));
			log(`B: ${w.id} size ${b.sizes[w.id]} (one copy took ${r0(ms)} ms at ${n})`);
		}
		let statsBefore = await snapStats(vm);
		for (const v of conf.variants ? vs : [variants[0]!]) {
			check();
			if (conf.variants) {
				try {
					await writeParams(vm, { ...boot.params, ...v.params }, signal);
					boot.variantParams[v.id] = await readParams(vm, signal);
				} catch (e) {
					if (e instanceof Stopped || signal.aborted) throw e;
					log(`B ${conf.label}: ${v.label}: ${errText(e)}; skipped`);
					boot.variantParams[v.id] = { error: errText(e) };
					continue;
				}
				statsBefore = await snapStats(vm);
			}
			for (const w of works) {
				check();
				const size = Math.max(1, Math.round(b.sizes[w.id]! * conf.scale));
				const cell: BCell = { variant: v.id, work: w.id, copies: b.copies, size, cold: NaN, runs: [], median: NaN };
				boot.cells.push(cell);
				const all: number[] = [];
				let pa: Capture | undefined, pb: Capture | undefined;
				try {
					for (let i = 0; i <= b.runs; i++) {
						check();
						status(`B ${conf.label}${v.id === "default" ? "" : `, ${v.label}`}: ${w.label} x${b.copies} (${i + 1}/${b.runs + 1})`);
						const last = i === b.runs;
						if (last) pa = await capture(vm, signal).catch(() => undefined);
						const r = await run(parallel(w.cmd(size), b.copies));
						if (last) pb = await capture(vm, signal).catch(() => undefined);
						if (i === 0) cell.cold = r0(r.ms);
						else { cell.runs.push(r0(r.ms)); all.push(...r.copies); }
					}
					cell.median = median(cell.runs);
					if (all.length) cell.perCopy = { min: r0(Math.min(...all)), max: r0(Math.max(...all)) };
				} catch (e) {
					if (e instanceof Stopped) throw e;
					cell.error = errText(e);
					log(`B ${conf.label} ${v.id} ${w.id}: ${cell.error}`);
				}
				const statsAfter = await snapStats(vm);
				cell.deltas = deltas(pa, pb, statsBefore, statsAfter);
				statsBefore = statsAfter;
				render();
			}
		}
	} catch (e) {
		if (e instanceof Stopped || signal.aborted) boot.error ??= "stopped";
		else {
			boot.error = errText(e);
			log(`B ${conf.label}: ${boot.error}`);
		}
	} finally {
		status(`B ${conf.label}: stopping`);
		await withTimeout<unknown>(vm?.stop() ?? Promise.resolve(), 15000, "stopping the kernel").catch((e) => log(`B ${conf.label}: ${errText(e)}`));
	}
	return boot;
}

let abort: AbortController | null = null;
async function runB(): Promise<void> {
	const cs = bconfs.filter((c) => document.querySelector<HTMLInputElement>(`[data-conf="${c.id}"]`)!.checked);
	const vs = variants.filter((v) => v.id === "default" || document.querySelector<HTMLInputElement>(`[data-variant="${v.id}"]`)!.checked);
	const sizes: Record<string, number> = {};
	for (const kv of $<HTMLInputElement>("sizes").value.split(",")) {
		const [k, v] = kv.split(":").map((s) => s.trim());
		if (k && Number(v) > 0) sizes[k] = Number(v);
	}
	const b: PartB = {
		distro: $<HTMLSelectElement>("distro").value,
		memMiB: Number($<HTMLInputElement>("mem").value) || 512,
		runs: Math.max(1, Number($<HTMLInputElement>("runs").value) || 1),
		scale: Number($<HTMLSelectElement>("scale").value) || 1,
		copies: Math.max(4, ...cs.map((c) => c.cpus)),
		sizes,
		boots: [],
	};
	report.b = b;
	report.options.b = { configs: cs.map((c) => c.id), variants: vs.map((v) => v.id) };
	abort = new AbortController();
	for (const c of cs) {
		if (stopped) break;
		const t0 = performance.now();
		b.boots.push(await runConf(c, b, vs, abort.signal));
		log(`B: ${c.label} took ${r1((performance.now() - t0) / 1000)} s`);
		render();
	}
	$<HTMLInputElement>("sizes").value = Object.entries(b.sizes).map(([k, v]) => `${k}:${v}`).join(",");
}

// --- the report ----------------------------------------------------------------------------
interface Report { env: typeof env; date: string; options: Record<string, unknown>; a?: PartA; b?: PartB; reading?: string[]; durationS?: number }
let report: Report = { env, date: new Date().toISOString(), options: {} };

function textA(a: PartA): string[] {
	const L: string[] = [`A. Engine probes (no kernel; workers ${a.nested ? "nested in one worker, as the kernel's CPUs" : "top-level"}; probe memory ${a.probeMemMiB ?? "?"} MiB shared)`];
	const rowList = (rs: Row[], extra?: (r: Row) => string) => rs.map((r) => `n=${r.n} ${fmt(r.ms)} ms ${fmt(r.speedup, 2)}x${extra ? extra(r) : ""}`).join(" | ");
	if (a.spin) {
		L.push(`spin (JS integer loop, ${a.spin.iters / 1e6}M iterations per worker; wall = slowest worker, median; ideal speedup = n):`);
		L.push(`  top-level: ${rowList(a.spin.top)}  (start ${a.spin.top.map((r) => r.startMs).join("/")} ms)`);
		L.push(`  nested:    ${rowList(a.spin.nested)}  (start ${a.spin.nested.map((r) => r.startMs).join("/")} ms)`);
	}
	const d = (x: Dist) => `${fmt(x.minUs)} / ${fmt(x.medUs)} / ${fmt(x.p95Us)} / ${fmt(x.maxUs)}, mean ${fmt(x.meanUs)} (${x.count})`;
	if (a.timedWait) {
		L.push(`timed wait on a word nobody notifies (actual µs: min / median / p95 / max, mean (samples); worker timer step ${a.timedWait.workerResUs} µs):`);
		for (const c of a.timedWait.cases) L.push(`  ${(c.load ? `beside ${c.load} busy` : "idle").padEnd(13)} ${c.via.padEnd(4)} ${String(c.targetUs).padStart(5)} µs: ${d(c)}${c.unexpected ? `  ${c.unexpected} did not time out` : ""}`);
	}
	if (a.wake) {
		L.push(`wake latency: notify -> the waiter's ack seen by the spinning waker, ${a.wake.gapUs} µs after the waiter blocked (µs: min / median / p95 / max, mean; notify call mean; share of notifies that woke a blocked waiter):`);
		for (const c of a.wake.cases) L.push(`  ${c.via.padEnd(4)} ${c.pairs} pair${c.pairs > 1 ? "s" : " "}: ${d(c)}; notify ${fmt(c.notifyUs, 1)} µs; woke ${fmt(c.wokeFrac, 2)}${c.partial ? " (partial: timed out)" : ""}`);
		L.push(`  round trip between two workers (profile.html's Host threads): Atomics.wait/notify ${a.wake.pong.waitUs ?? "?"} µs, spinning ${a.wake.pong.spinUs ?? "?"} µs`);
	}
	if (a.wasm) {
		L.push(`wasm in n workers on one shared memory of ${a.wasm.memMiB} MiB (wall ms, median; speedup n*t1/tn; ns per op per worker; "shared": atomic adds to one word, the same total split among the workers, speedup t1/tn, ns per op overall; "aload": i64.atomic.load in a loop, each worker its own page; "aloadadj": on adjacent words; "aload1": all on one word, as kwemu's code epoch at every block end; "pload1": a plain load of that word):`);
		for (const c of a.wasm.cases) L.push(`  ${c.op.padEnd(8)} ${rowList(c.rows, (r) => ` ${fmt((r as Row & { nsPerOp: number }).nsPerOp, 2)}ns`)}`);
	}
	if (a.compile) {
		L.push("compile + instantiate + first call + table.set of distinct small modules for about 1 s per worker (modules/s in all, speedup; µs per module: compile / instantiate / call / table.set; longest ms; modules in each third of the time):");
		for (const c of a.compile.cases) {
			L.push(`  ${c.mem}:`);
			for (const r of c.rows) L.push(`    n=${r.n} ${r.perSec}/s ${fmt(r.speedup, 2)}x (${r.perWorker}/s each): ${fmt(r.usCompile)} / ${fmt(r.usInstantiate)} / ${fmt(r.usCall)} / ${fmt(r.usTable)} µs, max ${fmt(r.maxMs, 1)} ms, ${r.bytesAvg} B avg, thirds ${r.thirds.join("/")}${r.failed ? `, ${r.failed} failed: ${r.err}` : ""}`);
		}
	}
	if (a.gc) {
		L.push("GC churn, small objects for about 1 s per worker (M objects/s in all, speedup; longest pause; pauses over 2 ms):");
		for (const c of a.gc.cases) L.push(`  ${(c.attached ? `${a.gc.memMiB} MiB attached` : "no memory").padEnd(16)} ${c.rows.map((r) => `n=${r.n} ${fmt(r.mops, 1)} ${fmt(r.speedup, 2)}x ${fmt(r.maxPauseMs, 1)}ms/${r.pausesOver2}`).join(" | ")}`);
	}
	for (const [k, v] of Object.entries(a.errors)) L.push(`error in ${k}: ${v}`);
	return L;
}

/** Median wall time of a cell's base (the base configuration's defaults). */
function baseOf(b: PartB, boot: BBoot, work: string): number | undefined {
	const base = bconfs.find((c) => c.id === boot.conf)?.base ?? "1";
	return b.boots.find((x) => x.conf === base)?.cells.find((c) => c.variant === "default" && c.work === work)?.median;
}
function cellOf(b: PartB, conf: string, variant: string, work: string): BCell | undefined {
	return b.boots.find((x) => x.conf === conf)?.cells.find((c) => c.variant === variant && c.work === work);
}
function speedupOf(b: PartB, conf: string, variant: string, work: string): number | undefined {
	const boot = b.boots.find((x) => x.conf === conf), c = cellOf(b, conf, variant, work);
	const t1 = boot && baseOf(b, boot, work);
	return c && t1 && Number.isFinite(c.median) ? t1 / c.median : undefined;
}

function textB(b: PartB): string[] {
	const L: string[] = [`B. Kernel (distro ${b.distro}, ${b.memMiB} MiB, ${b.copies} copies at once of each workload, sizes ${Object.entries(b.sizes).map(([k, v]) => `${k}:${v}`).join(",")}, ${b.runs} run${b.runs > 1 ? "s" : ""} + a cold one)`];
	L.push(`wall ms of ${b.copies} copies (speedup against the same work on 1 CPU; JIT-off rows against 1 CPU JIT off) [slowest copy ms]; cold run in ()`);
	const w0 = 30;
	L.push(`${"".padEnd(w0)}${works.map((w) => w.id.padEnd(30)).join("")}`);
	for (const boot of b.boots) {
		const vids = [...new Set(boot.cells.map((c) => c.variant))];
		if (!vids.length) L.push(`${boot.label.padEnd(w0)}${boot.error ? `error: ${boot.error}` : "-"}`);
		for (const v of vids) {
			const params = Object.entries(variants.find((x) => x.id === v)?.params ?? {}).map(([k, val]) => `${k}=${val}`).join(" ");
			const name = `${boot.cpus} CPU${boot.cpus > 1 ? "s" : ""}${boot.jit ? "" : " nojit"} ${params}`;
			L.push(name.padEnd(w0) + works.map((w) => {
				const c = boot.cells.find((x) => x.variant === v && x.work === w.id);
				if (!c) return "-".padEnd(30);
				if (c.error) return "error".padEnd(30);
				const s = speedupOf(b, boot.conf, v, w.id);
				return `${fmt(c.median)} ${fmt(s, 2)}x [${c.perCopy?.max ?? "-"}] (${fmt(c.cold)})`.padEnd(30);
			}).join(""));
		}
		if (boot.error && vids.length) L.push(`  ${boot.label}: error: ${boot.error}`);
	}
	L.push("boots: " + b.boots.map((x) => `${x.conf}: shell ${x.bootMs ?? "-"} ms, nproc ${x.nproc ?? "-"}${x.params && Object.keys(x.params).length ? `, ${Object.entries(x.params).map(([k, v]) => `${k}=${v}`).join(" ")}` : ""}`).join("; "));
	const un = b.boots.find((x) => x.uname)?.uname;
	if (un) L.push(`kernel: ${un}`);
	L.push("details per cell (the guest's /proc over the last timed run: CPU busy% (user+sys) per CPU, idle%, context switches, processes, kwmove, IRQs per CPU; the JIT over all the cell's runs: compiles/ms per CPU (longest compile ms)):");
	for (const boot of b.boots) {
		for (const c of boot.cells) {
			const d = c.deltas;
			if (!d) continue;
			const parts: string[] = [];
			if (d.cpu?.length) parts.push(`busy ${d.cpu.map((x) => `${x.busy}(${x.user}+${x.sys})`).join(" ")} idle ${d.cpu.map((x) => x.idle).join("/")}`);
			parts.push(`ctxt ${d.ctxt} procs ${d.processes}`);
			if (d.kwmove) parts.push(`kwmove ${Object.entries(d.kwmove).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(" ") || "0"}`);
			if (d.irq && Object.keys(d.irq).length) parts.push(`irq ${Object.entries(d.irq).map(([k, v]) => `${k.replace(/\s+/g, " ")} ${v.join("/")}`).join("; ")}`);
			if (d.jit) parts.push(`jit ${d.jit.map((j) => `${j.compiled}/${fmt(j.compileMs)}ms(${fmt(j.maxCompileMs, 1)})`).join(" ")}${d.jit.some((j) => j.refused || j.failed) ? ` refused ${d.jit.map((j) => j.refused).join("/")} failed ${d.jit.map((j) => j.failed).join("/")}` : ""}`);
			L.push(`  ${boot.conf} ${c.variant} ${c.work}: ${parts.join("; ")}`);
		}
	}
	return L;
}

/** Heuristic: which hypothesis the numbers point at. Thresholds are rough and stated with each line. */
function reading(r: Report): string[] {
	const L: string[] = ["READING (heuristic: simple thresholds on the numbers above, not a proof)"];
	const a = r.a, b = r.b;
	const at = <T extends { n: number }>(rows: T[] | undefined, n: number) => rows?.find((x) => x.n === n) ?? rows?.filter((x) => x.n <= n).pop();
	const nMax = Math.min(4, Math.max(...counts));
	// H3: threads.
	const sTop = at(a?.spin?.top, nMax)?.speedup, sNest = at(a?.spin?.nested, nMax)?.speedup;
	if (sTop == null && sNest == null) L.push("H3 threads in parallel: no data");
	else {
		const bad = (sTop ?? 99) < nMax * 0.7 || (sNest ?? 99) < nMax * 0.7;
		const nestBad = sTop != null && sNest != null && sNest < sTop * 0.75;
		L.push(`H3 threads in parallel: ${bad || nestBad ? "INDICATED" : "not indicated"} (JS spin speedup at n=${nMax}: top-level ${fmt(sTop, 2)}x, nested ${fmt(sNest, 2)}x; flagged below ${r1(nMax * 0.7)}x, or nested below 0.75x of top-level)`);
	}
	// H1: waits.
	const tw = a?.timedWait?.cases.filter((c) => !c.load);
	const tw100 = tw?.find((c) => c.via === "wasm" && c.targetUs === 100) ?? tw?.find((c) => c.targetUs === 100);
	const tw20 = tw?.find((c) => c.via === "wasm" && c.targetUs === 20) ?? tw?.find((c) => c.targetUs === 20);
	const wk = a?.wake?.cases.find((c) => c.via === "wasm" && c.pairs === 1) ?? a?.wake?.cases.find((c) => c.via === "js" && c.pairs === 1);
	const wkSpin = a?.wake?.cases.find((c) => c.via === "spin" && c.pairs === 1);
	const wkMany = a?.wake?.cases.filter((c) => c.via === wk?.via).pop();
	const kSpin0 = b && avgRatio(b, "spin0"), kSpin2000 = b && avgRatio(b, "spin2000");
	if (!tw100 && !wk && kSpin0 == null) L.push("H1 waits: no data");
	else {
		const over = tw100 ? tw100.medUs > 300 || (tw20?.medUs ?? 0) > 150 : false;
		const slowWake = wk ? wk.medUs > 100 : false;
		const manyWorse = wk && wkMany && wkMany.pairs > 1 ? wkMany.medUs > wk.medUs * 3 : false;
		const kernelSays = (kSpin0 ?? 0) > 1.3 || (kSpin2000 ?? 0) > 1.3;
		L.push(`H1 waits: ${over || slowWake || manyWorse || kernelSays ? "INDICATED" : "not indicated"} (` + [
			tw100 ? `100 µs timed wait sleeps ${fmt(tw100.medUs)} µs at the median (${tw100.via}), 20 µs sleeps ${fmt(tw20?.medUs)} µs; flagged above 300 / 150` : "",
			wk ? `notify-to-wake ${fmt(wk.medUs)} µs median, p95 ${fmt(wk.p95Us)} (${wk.via}; spinning ${fmt(wkSpin?.medUs, 1)}); flagged above 100` : "",
			manyWorse ? `with ${wkMany!.pairs} pairs ${fmt(wkMany!.medUs)} µs, over 3x one pair` : "",
			kSpin0 != null ? `kernel kw_spin_us=0 vs defaults ${fmt(kSpin0, 2)}x faster` : "",
			kSpin2000 != null ? `kw_spin_us=2000 ${fmt(kSpin2000, 2)}x; flagged above 1.3x` : "",
		].filter(Boolean).join("; ") + ")");
	}
	// H2: compile lock.
	const cOne = a?.compile?.cases[0], cOwn = a?.compile?.cases[1];
	const c4 = at(cOne?.rows, nMax), c4own = at(cOwn?.rows, nMax);
	const nojit = b && nojitRatio(b);
	if (!c4 && nojit == null) L.push("H2 compile lock: no data");
	else {
		const serial = c4 ? c4.speedup < nMax * 0.4 : false;
		const memLock = c4 && c4own ? c4own.speedup > c4.speedup * 1.5 : false;
		const decay = c4 ? c4.thirds[2]! < c4.thirds[0]! * 0.6 : false;
		const kernelSays = nojit != null && nojit > 1.5;
		L.push(`H2 compile lock: ${serial || memLock || kernelSays ? "INDICATED" : "not indicated"} (` + [
			c4 ? `compile+instantiate speedup at n=${c4.n} ${fmt(c4.speedup, 2)}x with one memory, ${fmt(c4own?.speedup, 2)}x with own memories; flagged below ${r1(nMax * 0.4)}x, or own memories 1.5x better (a per-memory lock)` : "",
			decay ? `rate falls over the second (thirds ${c4!.thirds.join("/")})` : "",
			nojit != null ? `kernel: 4-CPU speedup with the JIT off is ${fmt(nojit, 2)}x that with it on; flagged above 1.5x` : "",
		].filter(Boolean).join("; ") + ")");
	}
	// H4: GC.
	const gNo = at(a?.gc?.cases.find((c) => !c.attached)?.rows, nMax), gMem = at(a?.gc?.cases.find((c) => c.attached)?.rows, nMax);
	if (!gNo || !gMem) L.push("H4 GC pressure: no data");
	else {
		const slow = gMem.mops < gNo.mops * 0.6, pauses = gMem.maxPauseMs > Math.max(20, gNo.maxPauseMs * 3);
		L.push(`H4 GC pressure: ${slow || pauses ? "INDICATED" : "not indicated"} (n=${gMem.n}: ${fmt(gMem.mops, 1)} vs ${fmt(gNo.mops, 1)} M objects/s with and without the memory, longest pause ${fmt(gMem.maxPauseMs, 1)} vs ${fmt(gNo.maxPauseMs, 1)} ms; flagged below 0.6x or pauses over 3x and 20 ms)`);
	}
	// H5: wasm on a shared memory.
	const w = (op: string) => at(a?.wasm?.cases.find((c) => c.op === op)?.rows, nMax);
	const wc = w("compute"), wp = w("plain"), wr = w("rmw"), wf = w("fence"), ws = w("shared");
	if (!wp) L.push("H5 wasm on a shared memory: no data");
	else {
		const lim = nMax * 0.7;
		const bad = wp.speedup < lim || (wr?.speedup ?? 99) < lim || (wf?.speedup ?? 99) < lim;
		L.push(`H5 wasm on a shared memory: ${bad ? "INDICATED" : "not indicated"} (speedup at n=${wp.n}: compute ${fmt(wc?.speedup, 2)}x, plain ${fmt(wp.speedup, 2)}x, atomic RMW ${fmt(wr?.speedup, 2)}x, fence ${fmt(wf?.speedup, 2)}x on disjoint addresses; one shared word ${fmt(ws?.nsPerOp, 1)} ns/op; flagged below ${r1(lim)}x)`);
	}
	const wa = w("aload"), w1 = w("aload1"), wj = w("aloadadj");
	if (wa && w1) {
		const bad = w1.speedup < 0.6 * wa.speedup;
		L.push(`H6 atomic loads of one word: ${bad ? "INDICATED" : "not indicated"} (i64.atomic.load speedup at n=${w1.n}: own pages ${fmt(wa.speedup, 2)}x, adjacent words ${fmt(wj?.speedup, 2)}x, one word ${fmt(w1.speedup, 2)}x, ${fmt(w1.nsPerOp, 1)} ns/op; flagged when one word scales below 0.6x of own pages: the engine's atomic load takes the cache line as a write would)`);
	}
	// The kernel itself.
	if (b?.boots.length) {
		const parts: string[] = [];
		for (const wk2 of works) {
			const s4 = speedupOf(b, "4", "default", wk2.id), s2 = speedupOf(b, "2", "default", wk2.id);
			if (s4 != null || s2 != null) parts.push(`${wk2.id} ${fmt(s2, 2)}x on 2, ${fmt(s4, 2)}x on 4`);
		}
		if (parts.length) L.push(`kernel speedups (defaults): ${parts.join("; ")}`);
		const fair = avgRatio(b, "fair");
		if (fair != null) L.push(`kernel kw_spin_unfair=0 vs defaults: ${fmt(fair, 2)}x (above 1: ticket locks help)`);
		const c4 = cellOf(b, "4", "default", "compute")?.deltas?.cpu;
		if (c4?.length) {
			const idle = c4.reduce((s, x) => s + x.idle, 0) / c4.length, sys = c4.reduce((s, x) => s + x.sys, 0) / c4.length;
			L.push(`4 CPUs, compute: CPUs ${r0(idle)}% idle and ${r0(sys)}% system on average (the guest's view). Much idle while ${b.copies} copies are runnable: CPUs wait to be woken (H1, wakeups and IPIs); much system time: lock waits or kernel work (H1 blocked lock waits, H2 if the JIT counters are high)`);
		}
	}
	return L;
}
/** Mean over workloads of (defaults time / variant time) on 4 CPUs: above 1, the variant is faster. */
function avgRatio(b: PartB, variant: string): number | undefined {
	const rs = works.map((w) => { const d = cellOf(b, "4", "default", w.id)?.median, v = cellOf(b, "4", variant, w.id)?.median; return d && v ? d / v : NaN; }).filter(Number.isFinite);
	return rs.length ? Math.exp(rs.reduce((s, x) => s + Math.log(x), 0) / rs.length) : undefined;
}
/** Mean over workloads of (4-CPU speedup with the JIT off) / (4-CPU speedup with it on). */
function nojitRatio(b: PartB): number | undefined {
	const rs = works.map((w) => { const on = speedupOf(b, "4", "default", w.id), off = speedupOf(b, "4-nojit", "default", w.id); return on && off ? off / on : NaN; }).filter(Number.isFinite);
	return rs.length ? Math.exp(rs.reduce((s, x) => s + Math.log(x), 0) / rs.length) : undefined;
}

function reportText(): string {
	const r = report;
	const L = [
		"unkernel SMP probe",
		`date ${r.date}${r.durationS ? `, took ${r.durationS} s` : ""}`,
		`ua ${env.ua}`,
		`hardwareConcurrency ${env.hardwareConcurrency}, deviceMemory ${env.deviceMemory ?? "?"}, crossOriginIsolated ${env.crossOriginIsolated}, isSecureContext ${env.isSecureContext}, origin ${env.origin} (${env.originKind}), jspi ${env.jspi}, smp ${env.smp}, timer step ${env.timerResUs} µs`,
		`build ${env.build}; kernels ${env.kernelUrl} / ${env.kernelSmpUrl ?? "-"}`,
		...warnings.map((w) => `WARNING ${w}`),
		"",
	];
	if (r.a) L.push(...textA(r.a), "");
	if (r.b) L.push(...textB(r.b), "");
	L.push(...(r.reading ?? reading(r)));
	return L.join("\n");
}

function render() {
	report.reading = reading(report);
	$("report").textContent = reportText();
	$("report").classList.remove("dim");
	$<HTMLButtonElement>("copytext").disabled = $<HTMLButtonElement>("copyjson").disabled = false;
}

async function copy(text: string) {
	try {
		await navigator.clipboard.writeText(text);
		status("copied");
	} catch {
		// No clipboard (not a secure context): show it to copy by hand.
		$("log").textContent = text;
		status("clipboard unavailable: the log shows it to copy");
	}
}

// --- running -------------------------------------------------------------------------------
const state = { running: false, done: false, report: () => report, text: reportText };
(globalThis as unknown as { smpProbe: typeof state }).smpProbe = state;
const buttons = ["runall", "runa", "runb"];
async function go(a: boolean, b: boolean) {
	if (state.running) return;
	state.running = true;
	state.done = false;
	stopped = false;
	buttons.forEach((id) => ($<HTMLButtonElement>(id).disabled = true));
	$<HTMLButtonElement>("stop").disabled = false;
	logEl.textContent = "";
	report = { env, date: new Date().toISOString(), options: { url: location.search } };
	const t0 = performance.now();
	try {
		if (a) await runA();
		if (b && !stopped) await runB();
	} catch (e) {
		log(`failed: ${errText(e)}`);
	}
	report.durationS = r0((performance.now() - t0) / 1000);
	render();
	try { localStorage.setItem("kw-smp-probe-last", JSON.stringify(report)); } catch {}
	log(report.reading?.join("\n") ?? "");
	status(stopped ? "stopped" : `done in ${report.durationS} s`);
	buttons.forEach((id) => ($<HTMLButtonElement>(id).disabled = false));
	$<HTMLButtonElement>("stop").disabled = true;
	state.running = false;
	state.done = true;
}
$("runall").onclick = () => void go(true, true);
$("runa").onclick = () => void go(true, false);
$("runb").onclick = () => void go(false, true);
$("stop").onclick = () => { stopped = true; abort?.abort(); closeAll(); };
$("copytext").onclick = () => void copy(reportText());
$("copyjson").onclick = () => void copy(JSON.stringify(report, null, 1));

// The last run in this browser, for a look after a reload.
try {
	const last = localStorage.getItem("kw-smp-probe-last");
	if (last && !q.has("auto")) {
		report = JSON.parse(last) as Report;
		$("report").textContent = `(last run, ${report.date})\n${reportText()}`;
		$<HTMLButtonElement>("copytext").disabled = $<HTMLButtonElement>("copyjson").disabled = false;
	}
} catch {}
const auto = q.get("auto");
if (auto === "all" || auto === "a" || auto === "b") void go(auto !== "b", auto !== "a");
