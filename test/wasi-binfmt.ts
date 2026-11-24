// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Prototype check of WASI programs run by the guest on the host's wasm
// engine (guest/src/kwwasi.c, js/core/wasi-exec.ts), on Alpine. Builds
// kwwasi and the test programs in test/wasi/ with zig (aarch64-linux-musl
// and wasm32-wasi), mounts them in the guest, copies kwwasi to /usr/lib/kw,
// registers it with the guest's binfmt_misc (the kw layer does that at
// boot), and runs the programs by path.
//
//   node test/wasi-binfmt.ts [--worker] [--messages]
//   --messages                      requests as messages and JSPI (the fallback),
//                                   not through a SharedArrayBuffer
//   UNKERNEL_TEST_KERNEL=path ...   another bundle instead of the bundled kernel
//   UNKERNEL_TEST_DISTRO_DIR=dir    where alpine.erofs is (default vendor/build/distro)
//   UNKERNEL_TEST_CPUS=n ...        CPUs for an SMP kernel (implies a worker)
//
// Exit 0 when every check passes. It checks argv[0], paths against the cwd
// and "/" (KWWASI_CWD), preview 0 calls, and that a module is sent only
// when the host has not compiled it for that file (rewrites in the guest
// and on the host). Each program runs in a worker of its own:
// it checks that the guest and its console go on while one computes, that
// a kill ends the worker at once, and two programs at a time. It prints the
// time of a compute loop as wasm on the host (cold, then with the compiled
// module cached) and as aarch64 in the guest, how fast a small program
// starts with and without idle workers, a 16 MiB copy through kwwasi and
// what one small request costs.
// With one CPU it also saves a snapshot with three programs running (one
// computing, one waiting for its stdin, one blocked writing to a full pipe),
// stops, resumes it and checks that kwwasi tells them they are gone. A host
// of its own on kwwasi's port checks kwwasi's side of the protocol's ends.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createKernel, nodeFs, serveWasiPrograms, type VsockConnection } from "../js/node.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const worker = process.argv.includes("--worker");
const messages = process.argv.includes("--messages");
const kernel = process.env.UNKERNEL_TEST_KERNEL ? path.resolve(process.env.UNKERNEL_TEST_KERNEL) : undefined;
const distro = path.join(path.resolve(process.env.UNKERNEL_TEST_DISTRO_DIR ?? path.join(root, "vendor/build/distro")), "alpine.erofs");
if (!existsSync(distro)) {
	console.log(`FAIL: no ${distro} (kernel/build.sh distro alpine)`);
	process.exit(1);
}
const cpus = Number(process.env.UNKERNEL_TEST_CPUS) || undefined;
const zig = process.env.ZIG ?? "zig";

const dir = mkdtempSync(path.join(tmpdir(), "kwwasi-"));
const cc = (target: string, src: string, out: string, flags: string[] = []) =>
	execFileSync(zig, ["cc", "-target", target, "-O2", "-s", ...(target.startsWith("aarch64") ? ["-mcpu=generic", "-static"] : []), ...flags, "-o", path.join(dir, out), src]);
cc("aarch64-linux-musl", path.join(root, "guest/src/kwwasi.c"), "kwwasi");
for (const t of ["hello", "cat", "ls", "loop", "trap", "calls", "put"]) cc("wasm32-wasi", path.join(root, "test/wasi", `${t}.c`), `${t}.wasm`);
cc("wasm32-wasi", path.join(root, "test/wasi/p0.c"), "p0.wasm", ["-nostdlib", "-fno-builtin"]);
// Two modules of the same size that print different things.
for (const v of ["A", "B"]) cc("wasm32-wasi", path.join(root, "test/wasi/ver.c"), `ver${v}.wasm`, [`-DVARIANT="${v}"`]);
assert.equal(statSync(path.join(dir, "verA.wasm")).size, statSync(path.join(dir, "verB.wasm")).size);
cc("aarch64-linux-musl", path.join(root, "test/wasi/loop.c"), "loop.a64");

const mounts = () => ({ "/mnt/kw": { fs: nodeFs(dir), readOnly: true } });
const hostLog = (m: string) => process.stderr.write(`${m}\n`);
const vm = await createKernel({ kernel, distro, worker, cpus, log: () => {}, mounts: mounts() });
const serve = (v: typeof vm, opts: { idleWorkers?: number } = {}) => serveWasiPrograms(v.vsock!, { log: hostLog, sharedMemory: !messages, ...opts });
let wasi = serve(vm);
assert.equal(wasi.shared, !messages);
console.log(`     requests ${wasi.shared ? "through a SharedArrayBuffer" : "as messages (JSPI)"}`);
const sh = (cmd: string, input?: string) => vm.exec("sh", ["-c", cmd], { input });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Wait until `cond` holds (at most `ms`); the time it took, in ms. */
async function until(cond: () => boolean, ms: number, what: string): Promise<number> {
	const t = performance.now();
	while (!cond()) {
		if (performance.now() - t > ms) throw new Error(`timed out after ${ms} ms waiting for ${what} (stats ${JSON.stringify(wasi.stats)})`);
		await sleep(2);
	}
	return performance.now() - t;
}
/** No program running, no worker but the idle ones, no shared channel served. */
const quiet = () => wasi.stats.running === 0 && wasi.stats.workers === wasi.stats.idle && wasi.stats.channels === 0;
let failed = 0;
async function check(name: string, cmd: string, want: { stdout?: string | RegExp; stderr?: RegExp; code: number }, input?: string) {
	const r = await sh(cmd, input);
	try {
		if (typeof want.stdout === "string") assert.equal(r.stdout, want.stdout);
		else if (want.stdout) assert.match(r.stdout, want.stdout);
		if (want.stderr) assert.match(r.stderr, want.stderr);
		assert.equal(r.exitCode, want.code);
		console.log(`ok   ${name}`);
	} catch (e) {
		failed++;
		console.log(`FAIL ${name}: ${(e as Error).message}\n  stdout: ${JSON.stringify(r.stdout)}\n  stderr: ${JSON.stringify(r.stderr)}\n  exit: ${r.exitCode}`);
	}
}

try {
	const setup = await sh(`set -e
		install -m 755 /mnt/kw/kwwasi /usr/lib/kw/kwwasi
		d=/proc/sys/fs/binfmt_misc
		[ -e $d/wasi ] || printf '%s\\n' ':wasi:M::\\x00asm\\x01\\x00\\x00\\x00::/usr/lib/kw/kwwasi:P' > $d/register || :
		mkdir -p /root/work/sub /tmp/w /root/bin
		cp /mnt/kw/*.wasm /mnt/kw/loop.a64 /root/work/ && chmod 755 /root/work/*.wasm /root/work/loop.a64
		cp /root/work/hello.wasm /root/bin/ && ln -s /root/work/hello.wasm /root/bin/hello-link
		echo "file in work dir" > /root/work/sub/data.txt
		cat /proc/sys/fs/binfmt_misc/wasi`);
	assert.match(setup.stdout, /interpreter \/usr\/lib\/kw\/kwwasi/, setup.stderr);

	await check("argv, env, exit status", "cd /root/work && KW_GREETING=hola ./hello.wasm one 'two words'",
		{ stdout: "argv[0]=./hello.wasm\nargv[1]=one\nargv[2]=two words\nKW_GREETING=hola\ngetcwd=/\n", code: 43 });
	// argv[0] as given, except a name found through $PATH: then the path exec ran (a symlink's own name).
	await check("argv[0] by ./, absolute path, $PATH and a $PATH symlink",
		"cd /root/work && { ./hello.wasm; /root/work/hello.wasm; PATH=/root/bin:$PATH hello.wasm; PATH=/root/bin:$PATH hello-link; cd /root/bin && ./hello-link; } | grep '^argv'",
		{ stdout: "argv[0]=./hello.wasm\nargv[0]=/root/work/hello.wasm\nargv[0]=/root/bin/hello.wasm\nargv[0]=/root/bin/hello-link\nargv[0]=./hello-link\n", code: 0 });
	await check("stdin from a pipe", "cd /root/work && echo hi | ./cat.wasm", { stdout: "hi\n", code: 0 });
	await check("stdin from the host", "/root/work/cat.wasm", { stdout: "from the host\n", code: 0 }, "from the host\n");
	await check("stdout redirected to a file", "cd /root/work && ./cat.wasm /etc/alpine-release > /tmp/w/out && cat /tmp/w/out",
		{ stdout: /^\d+\.\d+\.\d+\n$/, code: 0 });
	await check("absolute path in a non-root cwd", "cd /root/work/sub && ../cat.wasm /etc/hostname", { stdout: /\S/, code: 0 });
	await check("relative path in a non-root cwd", "cd /root/work && ./cat.wasm sub/data.txt", { stdout: "file in work dir\n", code: 0 });
	await check("relative path, cwd one deeper", "cd /root/work/sub && ../cat.wasm data.txt", { stdout: "file in work dir\n", code: 0 });
	await check("relative path in /", "cd / && /root/work/cat.wasm root/work/sub/data.txt", { stdout: "file in work dir\n", code: 0 });
	await check("missing file", "cd /root/work && ./cat.wasm nope", { stderr: /nope: No such file or directory/, code: 1 });
	await check("readdir and stat", "cd /root/work/sub && ../ls.wasm", { stdout: /^\. dir \d+\n\.\. dir \d+\ndata\.txt file 17\n$/, code: 0 });
	await check("pipeline of two programs", "/root/work/cat.wasm /etc/os-release | /root/work/cat.wasm | cmp - /etc/os-release", { code: 0 });
	await check("the caller's credentials", "cp /root/work/cat.wasm /tmp/w/ && su nobody -s /bin/sh -c '/tmp/w/cat.wasm /etc/shadow'",
		{ stderr: /\/etc\/shadow: Permission denied/, code: 1 });
	await check("a cwd the caller may not search",
		"mkdir -p /tmp/w/priv/sub && echo x > /tmp/w/priv/sub/f && chmod 700 /tmp/w/priv && cd /tmp/w/priv && su nobody -s /bin/sh -c '/tmp/w/cat.wasm sub/f'",
		{ stderr: /sub\/f: Permission denied/, code: 1 });
	await cwdChecks();
	await moduleChecks();
	await check("preview 0 (wasi_unstable): fd_seek's whence, filestat, poll_oneoff", "cd / && /root/work/p0.wasm", { stdout: "p0 ok\n", code: 0 });
	await check("trap", "/root/work/trap.wasm", { stdout: "before trap\n", stderr: /wasm trap: unreachable/, code: 134 });
	await check("not a module", "printf '\\0asm\\1\\0\\0\\0xx' > /tmp/w/bad.wasm && chmod +x /tmp/w/bad.wasm && /tmp/w/bad.wasm",
		{ stderr: /not a valid WebAssembly module/, code: 126 });
	await check("killed while waiting for stdin", "(sleep 2; echo) | timeout -s INT 0.5 /root/work/cat.wasm", { code: 130 });
	await check("SIGKILL while waiting for stdin",
		"mkfifo /tmp/w/in && { sleep 3 > /tmp/w/in & } && timeout -s KILL 0.5 /root/work/cat.wasm < /tmp/w/in; rc=$?; kill $! 2>/dev/null; rm /tmp/w/in; exit $rc",
		{ code: 137 });
	console.log(`ok   its worker gone ${(await until(quiet, 2000, "the killed program's worker to end")).toFixed(0)} ms after the guest saw it exit`);
	await check("many small requests", "/root/work/calls.wasm write 1000 | wc -c", { stdout: "1000\n", code: 0 });
	await check("small preads and stats", "/root/work/calls.wasm pread 100 /etc/hostname && /root/work/calls.wasm stat 100 /etc/hostname", { code: 0 });
	await check("large reads and writes", "head -c 3000000 /dev/urandom > /tmp/w/big && /root/work/calls.wasm copy 4000000 < /tmp/w/big | cmp - /tmp/w/big", { code: 0 });
	await check("large reads and writes of regular files",
		"/root/work/calls.wasm copy 4000000 < /tmp/w/big > /tmp/w/big.out && cmp /tmp/w/big /tmp/w/big.out && rm /tmp/w/big /tmp/w/big.out", { code: 0 });
	await check("small reads of a regular file, each after a seek", "/root/work/calls.wasm reread 200 /etc/hostname", { code: 0 });
	await check("nonblocking stdin, an empty pipe: EAGAIN", "sleep 0.3 | /root/work/calls.wasm nbread", { stdout: "EAGAIN\n", code: 0 });
	await check("nonblocking stdin, a pipe with data", "printf hi | { sleep 0.3; /root/work/calls.wasm nbread; }", { stdout: "read 2\n", code: 0 });
	await check("nonblocking stdin, a tty: EAGAIN", "/root/work/calls.wasm nbread < /dev/console", { stdout: "EAGAIN\n", code: 0 });
	await check("SIGPIPE", "/root/work/cat.wasm /dev/zero | head -c 100000 | wc -c", { stdout: "100000\n", code: 0 });
	await until(quiet, 2000, "no program and no busy worker");
	console.log(`ok   instances dropped (stats ${JSON.stringify(wasi.stats)})`);
	await fakeHostChecks();

	const secs = async (cmd: string, code = 0) => {
		const t = performance.now();
		const r = await sh(cmd);
		assert.equal(r.exitCode, code, r.stderr);
		return (performance.now() - t) / 1000;
	};
	// While a program computes (no WASI calls), the guest and its console go on.
	const console0 = { text: "" };
	const unsubscribe = vm.onOutput((b) => (console0.text += new TextDecoder().decode(b)));
	const marker = async (n: number) => {
		const t = performance.now();
		await sh(`echo kw-marker-${n} > /dev/console`);
		await until(() => console0.text.includes(`kw-marker-${n}`), 20000, `console marker ${n}`);
		return (performance.now() - t) / 1000;
	};
	const idleSleep = await secs("sleep 0.5"), idleMarker = await marker(1);
	await check("a program computing in the background", "/root/work/loop.wasm 100000000000 >/dev/null 2>&1 & echo $! > /tmp/w/bg.pid", { code: 0 });
	await until(() => wasi.stats.running === 1, 5000, "the background program");
	await sleep(300); // well into the loop
	const busySleep = await secs("sleep 0.5"), busyMarker = await marker(2);
	unsubscribe();
	console.log(`     sleep 0.5 took ${idleSleep.toFixed(2)} s idle, ${busySleep.toFixed(2)} s next to the loop; console marker ${(idleMarker * 1000).toFixed(0)} ms idle, ${(busyMarker * 1000).toFixed(0)} ms next to the loop`);
	if (busySleep < idleSleep + 0.3 && busyMarker < idleMarker + 0.3) console.log("ok   the guest and its console go on while a program computes");
	else {
		failed++;
		console.log("FAIL the guest or its console stalled while a program computed");
	}
	await check("kill -9 of a computing program", "kill -9 $(cat /tmp/w/bg.pid) && sleep 0.1 && ! kill -0 $(cat /tmp/w/bg.pid) 2>/dev/null", { code: 0 });
	console.log(`ok   its worker gone ${(await until(quiet, 2000, "the killed program's worker to end")).toFixed(0)} ms after the guest saw it die`);

	// Killed in the middle of a computation: the status, and the worker ends at once.
	for (const [sig, code] of [["INT", 130], ["KILL", 137]] as const) {
		await check(`SIG${sig} mid-compute`, `timeout -s ${sig} 1 /root/work/loop.wasm 100000000000; exit $?`, { code });
		console.log(`ok   its worker gone ${(await until(quiet, 2000, "the killed program's worker to end")).toFixed(0)} ms after the guest saw it exit`);
	}

	// Two at a time: each in its own worker, same answers as one alone.
	const one = await sh("/root/work/loop.wasm 300000000");
	let most = 0;
	const watch = setInterval(() => (most = Math.max(most, wasi.stats.running)), 5);
	const t2 = performance.now();
	await check("two programs at a time", "/root/work/loop.wasm 300000000 > /tmp/w/a & /root/work/loop.wasm 300000000 > /tmp/w/b & wait; cat /tmp/w/a /tmp/w/b",
		{ stdout: one.stdout + one.stdout, code: 0 });
	const both = (performance.now() - t2) / 1000;
	clearInterval(watch);
	console.log(`     3e8 rounds: ${(await secs("/root/work/loop.wasm 300000000 >/dev/null")).toFixed(2)} s alone, two at a time ${both.toFixed(2)} s (most running at once: ${most})`);
	await until(quiet, 2000, "no busy worker");

	const time = async (cmd: string) => (await secs(cmd)).toFixed(2);
	// loop.wasm with an empty custom section added: another module, not compiled yet, so its first run is cold.
	await sh("cp /root/work/loop.wasm /tmp/w/loop2.wasm && printf '\\000\\004\\003kwx' >> /tmp/w/loop2.wasm");
	console.log(`loop 1e9: wasm cold ${await time("/tmp/w/loop2.wasm 1000000000")} s, wasm cached ${await time("/tmp/w/loop2.wasm 1000000000")} s, aarch64 ${await time("/root/work/loop.a64 1000000000")} s`);
	const hellos = "for i in $(seq 20); do /root/work/hello.wasm >/dev/null; done; true";
	const hello = await time(hellos);
	await sh("head -c 16777216 /dev/urandom > /tmp/w/z16");
	const req0 = wasi.stats.requests;
	const copy = await time("/root/work/cat.wasm /tmp/w/z16 > /tmp/w/z16.out");
	const reqs = wasi.stats.requests - req0;
	await check("16 MiB copied intact", "cmp /tmp/w/z16 /tmp/w/z16.out && rm /tmp/w/z16.out", { code: 0 });
	console.log(`16 MiB cat.wasm copy: ${copy} s (${reqs} requests to kwwasi; exec() of true takes ${((await secs("true")) * 1000).toFixed(1)} ms)`);
	const small = await secs("/root/work/calls.wasm pread 10000 /etc/hostname");
	console.log(`10000 16-byte preads: ${small.toFixed(2)} s (${(small * 100).toFixed(0)} us per request)`);
	// The same without idle workers: a new worker for every program.
	wasi.close();
	await until(quiet, 2000, "the idle workers to end");
	wasi = serve(vm, { idleWorkers: 0 });
	console.log(`20 x hello.wasm: ${hello} s with idle workers, ${await time(hellos)} s with a new worker each`);
	await until(quiet, 2000, "every worker to end");
	console.log(`ok   no worker left (stats ${JSON.stringify(wasi.stats)})`);

	if (!cpus) await snapshotCheck();
	else console.log("skip snapshot (an SMP kernel has none: KW_PARK needs !SMP)");
} finally {
	await vm.stop();
	rmSync(dir, { recursive: true, force: true });
}

/**
 * A WASI program has no cwd (wasi-libc's is "/"), so "/etc/x" and "etc/x"
 * reach kwwasi alike; it resolves each by what exists (kwwasi.c, resolve()).
 */
async function cwdChecks() {
	const host = (await sh("cat /etc/hostname")).stdout;
	await sh(`mkdir -p /tmp/w/col/etc /tmp/w/col/lib /tmp/w/half/etc && echo fake-hostname > /tmp/w/col/etc/hostname
		echo mine > /tmp/w/col/lib/x && echo other > /tmp/w/half/etc/other && cat /etc/hostname /etc/hostname > /tmp/w/hh`);
	const warning = (p: string, used: string) =>
		new RegExp(`^kwwasi: warning: "${p}" may mean \\./${p} or /${p} \\(a WASI program cannot say which\\); used ${used}\\. KWWASI_CWD=auto, root or off chooses and silences this\n`);
	await check("cwd and / both have the file: the cwd's, one warning", "cd /tmp/w/col && /root/work/cat.wasm /etc/hostname etc/hostname",
		{ stdout: "fake-hostname\nfake-hostname\n", stderr: new RegExp(`${warning("etc/hostname", "\\./etc/hostname").source}$`), code: 0 });
	await check("KWWASI_CWD=auto: the same, no warning", "cd /tmp/w/col && KWWASI_CWD=auto /root/work/cat.wasm /etc/hostname",
		{ stdout: "fake-hostname\n", stderr: /^$/, code: 0 });
	await check("KWWASI_CWD=root: such a collision goes to /", "cd /tmp/w/col && KWWASI_CWD=root /root/work/cat.wasm /etc/hostname",
		{ stdout: host, stderr: /^$/, code: 0 });
	await check("KWWASI_CWD=off: every path from /", "cd /tmp/w/col && KWWASI_CWD=off /root/work/cat.wasm /etc/hostname etc/hostname | cmp - /tmp/w/hh",
		{ stderr: /^$/, code: 0 });
	await check("cwd and / both have the first component: where the file is", "cd /tmp/w/half && /root/work/cat.wasm etc/other /etc/hostname",
		{ stdout: `other\n${host}`, stderr: warning("etc/other", "\\./etc/other"), code: 0 });
	await check("relative under a name / has too", "cd /tmp/w/col && /root/work/cat.wasm lib/x", { stdout: "mine\n", stderr: warning("lib/x", "\\./lib/x"), code: 0 });
	await check("./ from a program without chdir(): the cwd's", "cd /tmp/w/col && /root/work/cat.wasm ./etc/hostname", { stdout: "fake-hostname\n", stderr: /^$/, code: 0 });
	await check("new files and directories go to the cwd",
		"cd /tmp/w/col && /root/work/put.wasm newf hi && /root/work/put.wasm -d out && /root/work/put.wasm out/f there && cat newf out/f",
		{ stdout: "hi\nthere\n", stderr: /^$/, code: 0 });
	await check("a new entry named like one in /: that one, and a warning", "cd /tmp/w/col && /root/work/put.wasm -d tmp",
		{ stderr: new RegExp(`${warning("tmp", "/tmp").source}put\\.wasm: mkdir tmp: File exists\n$`), code: 1 });
	await check("the cwd is /", "cd / && /root/work/cat.wasm etc/hostname /etc/hostname | cmp - /tmp/w/hh", { stderr: /^$/, code: 0 });
	await check("absolute paths from a cwd the caller may not search", "cd /tmp/w/priv && su nobody -s /bin/sh -c '/tmp/w/cat.wasm /etc/hostname'",
		{ stdout: host, stderr: /^$/, code: 0 });
}

/**
 * kwwasi against a host of this test's own on its port (the server closed
 * meanwhile): the host's EXIT while a request is in flight (as when the
 * program's worker fails), and a reset in the middle of regular-file reads.
 */
async function fakeHostChecks() {
	wasi.close();
	await until(quiet, 2000, "the idle workers to end");
	const frame = (op: number, ...words: number[]) => {
		const b = new Uint8Array(8 + words.length * 4), dv = new DataView(b.buffer);
		dv.setUint32(0, op, true);
		dv.setUint32(4, words.length * 4, true);
		words.forEach((w, i) => dv.setUint32(8 + i * 4, w, true));
		return b;
	};
	const cat = (...parts: Uint8Array[]) => {
		const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
		let at = 0;
		for (const p of parts) {
			out.set(p, at);
			at += p.length;
		}
		return out;
	};
	const exitFrame = (code: number, msg: string) => {
		const m = new TextEncoder().encode(msg), b = new Uint8Array(12 + m.length), dv = new DataView(b.buffer);
		dv.setUint32(0, 3, true);
		dv.setUint32(4, 4 + m.length, true);
		dv.setUint32(8, code, true);
		b.set(m, 12);
		return b;
	};
	const MODULE0 = frame(4, 0), R_READ = 16, R_FSTAT = 22;
	/** The ops of the frames kwwasi sends on conn, one at a time. */
	const frames = (conn: VsockConnection) => {
		const reader = conn.readable.getReader();
		let have = new Uint8Array(0);
		return async () => {
			for (;;) {
				const dv = new DataView(have.buffer, have.byteOffset, have.byteLength);
				if (have.length >= 8 && have.length >= 8 + dv.getUint32(4, true)) {
					const op = dv.getUint32(0, true);
					have = have.slice(8 + dv.getUint32(4, true));
					return op;
				}
				const { value, done } = await reader.read();
				if (done) throw new Error("kwwasi closed the connection");
				have = cat(have, value);
			}
		};
	};
	const listener = vm.vsock!.listen(1021);
	try {
		for (const [what, req] of [["a read of a regular file", frame(R_READ, 0, 16)], ["an fstat", frame(R_FSTAT, 0)]] as const) {
			const run = sh("/root/work/hello.wasm < /etc/hostname");
			const conn = (await listener.accept())!;
			assert.equal(await frames(conn)(), 1); // START
			// MODULE 0, the request and EXIT at once, then the connection closed both ways.
			void conn.writable.getWriter().write(cat(MODULE0, req, exitFrame(77, "kwwasi: the fake host ended it"))).catch(() => {});
			conn.close();
			const r = await run;
			if (r.exitCode === 77 && /the fake host ended it/.test(r.stderr)) console.log(`ok   the host's EXIT during ${what}: kwwasi exits as it says`);
			else {
				failed++;
				console.log(`FAIL the host's EXIT during ${what}: exit ${r.exitCode}, ${JSON.stringify(r.stderr)}`);
			}
		}
		// Replies read back for 50 reads of a regular stdin, then a 51st and a reset.
		const run = sh("/root/work/hello.wasm < /etc/hostname");
		const conn = (await listener.accept())!;
		const w = conn.writable.getWriter();
		const next = frames(conn);
		assert.equal(await next(), 1); // START
		void w.write(MODULE0);
		for (let i = 0; i < 50; i++) {
			void w.write(frame(R_READ, 0, 16));
			assert.equal(await next(), 2); // REPLY
		}
		void w.write(frame(R_READ, 0, 16)).catch(() => {});
		conn.reset();
		const r = await run;
		if (r.exitCode === 126 && /^kwwasi: (lost the connection to the host|the host closed the connection)/.test(r.stderr))
			console.log("ok   a reset in the middle of regular-file reads: kwwasi exits 126");
		else {
			failed++;
			console.log(`FAIL a reset in the middle of regular-file reads: exit ${r.exitCode}, ${JSON.stringify(r.stderr)}`);
		}
	} finally {
		listener.close();
		wasi = serve(vm);
	}
}

/**
 * kwwasi sends the module's identity and the bytes only when the host has
 * not compiled them for that identity, and never for a file changed less
 * than 2 s ago (kwwasi.c, UNSETTLED).
 */
async function moduleChecks() {
	const runs = async (name: string, cmd: string, stdout: string, sent: number) => {
		const r0 = wasi.stats.received;
		const r = await sh(cmd);
		const got = wasi.stats.received - r0;
		if (r.stdout === stdout && r.exitCode === 0 && got === sent) console.log(`ok   ${name}`);
		else {
			failed++;
			console.log(`FAIL ${name}: ${JSON.stringify(r.stdout)} ${JSON.stringify(r.stderr)} exit ${r.exitCode}, ${got} modules sent, want ${JSON.stringify(stdout)} and ${sent}`);
		}
	};
	const A = "variant A\n", B = "variant B\n";
	const v = "/tmp/w/v.wasm";
	await sh(`cp /root/work/verA.wasm ${v} && chmod +x ${v}`);
	await runs("a module changed just now is sent each time", `${v} && ${v}`, A + A, 2);
	await sleep(2100);
	await runs("one that has not changed for 2 s is sent once", `${v} && ${v} && ${v}`, A + A + A, 1);
	await runs("rewritten in place three times in a row, same size: sent each time",
		`cat /root/work/verB.wasm > ${v} && ${v} && cat /root/work/verA.wasm > ${v} && ${v} && cat /root/work/verB.wasm > ${v} && ${v}`, B + A + B, 3);
	await runs("replaced by a rename", `cp /root/work/verA.wasm /tmp/w/n.wasm && chmod +x /tmp/w/n.wasm && mv /tmp/w/n.wasm ${v} && ${v}`, A, 1);
	const cached = wasi.stats.cached;
	await runs("another file with the same bytes", `cp ${v} /tmp/w/w.wasm && /tmp/w/w.wasm`, A, 1);
	if (wasi.stats.cached === cached) console.log(`ok   ... shares the compiled module (${cached} kept)`);
	else {
		failed++;
		console.log(`FAIL a copy compiled again: ${cached} modules kept before, ${wasi.stats.cached} after`);
	}
	// A host file system: the host's edits show once the mount's attribute cache (1 s) expires.
	const hv = path.join(dir, "v9.wasm"), g = "/mnt/kw/v9.wasm";
	copyFileSync(path.join(dir, "verA.wasm"), hv);
	await sleep(2100);
	await runs("on a 9p mount: sent once", `${g} && ${g}`, A + A, 1);
	writeFileSync(hv, readFileSync(path.join(dir, "verB.wasm")));
	await sleep(1100);
	await runs("rewritten in place by the host", g, B, 1);
	copyFileSync(path.join(dir, "verA.wasm"), path.join(dir, "n9.wasm"));
	renameSync(path.join(dir, "n9.wasm"), hv);
	await sleep(1100);
	await runs("replaced by a rename on the host", g, A, 1);
}

/**
 * Snapshots with a program computing, one waiting for its stdin and one
 * blocked writing to a full pipe: they are not blocked, one without stop
 * leaves the three running, the programs' workers end when the machine
 * stops, and in the resumed machine kwwasi
 * finds its connection reset and exits 126.
 */
async function snapshotCheck() {
	await sh(`rm -f /tmp/w/*.rc
		(/root/work/loop.wasm 100000000000 >/tmp/w/l.out 2>/tmp/w/l.err; echo $? > /tmp/w/l.rc) >/dev/null 2>&1 &
		sleep 100000 | (/root/work/cat.wasm >/tmp/w/c.out 2>/tmp/w/c.err; echo $? > /tmp/w/c.rc) >/dev/null 2>&1 &
		(/root/work/calls.wasm copy 4096 </dev/zero 2>/tmp/w/p.err; echo $? > /tmp/w/p.rc) | sleep 100000 >/dev/null 2>&1 &`);
	await until(() => wasi.stats.running === 3, 5000, "three programs running");
	await sleep(300);
	// In a worker a snapshot may not have host file systems (they resume inline only).
	if (worker) await vm.mounts.get("/mnt/kw")!.unmount();
	const old = wasi;
	// One without stop: the guest and the programs go on.
	await vm.snapshot();
	await sleep(200);
	if (old.stats.running === 3 && old.stats.workers - old.stats.idle === 3) console.log("ok   a snapshot without stop leaves the three programs running");
	else {
		failed++;
		console.log(`FAIL a snapshot without stop: ${JSON.stringify(old.stats)}`);
	}
	const t = performance.now();
	const snap = await vm.snapshot({ stop: true });
	console.log(`ok   snapshot with three programs running, in ${((performance.now() - t) / 1000).toFixed(2)} s`);
	await until(() => old.stats.running === 0 && old.stats.workers === 0 && old.stats.channels === 0, 2000, "the stopped machine's program workers to end");
	console.log(`ok   the stopped machine's program workers ended (stats ${JSON.stringify(old.stats)})`);
	const vm2 = await createKernel({ kernel, distro, worker, log: () => {}, ...(worker ? {} : { mounts: mounts() }), restore: snap });
	try {
		wasi = serve(vm2);
		for (let i = 0; ; i++) {
			const r = await vm2.exec("sh", ["-c", "cat /tmp/w/l.rc /tmp/w/c.rc /tmp/w/p.rc 2>/dev/null"]);
			if (r.stdout.split("\n").filter(Boolean).length === 3) break;
			if (i > 100) {
				const ps = await vm2.exec("sh", ["-c", "ps; cat /tmp/w/*.err"]);
				throw new Error(`kwwasi still running after the restore: ${r.stdout}\n${ps.stdout}`);
			}
			await sleep(100);
		}
		const r = await vm2.exec("sh", ["-c", "cat /tmp/w/l.rc /tmp/w/c.rc /tmp/w/p.rc /tmp/w/l.err /tmp/w/c.err /tmp/w/p.err"]);
		try {
			const lost = "kwwasi: lost the connection to the host \\([^)]+\\): [^\\n]*snapshot[^\\n]*\\n";
			assert.match(r.stdout, new RegExp(`^126\\n126\\n126\\n${lost}${lost}${lost}$`));
			console.log(`ok   after the restore the three kwwasi exit 126 (computing, waiting for stdin, blocked writing to a full pipe): ${JSON.stringify(r.stdout.split("\n")[3])}`);
		} catch (e) {
			failed++;
			console.log(`FAIL after the restore: ${(e as Error).message}`);
		}
		const h = await vm2.exec("sh", ["-c", "/root/work/hello.wasm"]);
		if (h.exitCode === 41) console.log("ok   a program runs in the resumed machine");
		else {
			failed++;
			console.log(`FAIL a program in the resumed machine: exit ${h.exitCode}, ${JSON.stringify(h.stderr)}`);
		}
	} finally {
		await vm2.stop();
	}
}
console.log(failed ? `${failed} failure(s)` : "all passed");
process.exit(failed ? 1 : 0);
