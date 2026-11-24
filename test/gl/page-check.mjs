#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The page's GL option in headless Chromium: starts the page's Vite dev
// server (web/, on --port, default 8091; never 8080, the one used by hand),
// loads it with ?gl=1 on Debian without a data disk (?data=0: nothing is
// written to any IndexedDB store but this fresh browser profile's) and
// checks, in the real page:
//
//   1  guest GL is on with the page's default URL (no ?gl=1; Debian), vm.gl.ready
//      resolves (the guest's forwarder linked), the renderer is not loaded
//      (vm.gl.status "idle") and the Environment tab's Guest GL row says so,
//      and the page has fetched neither virgl.mjs nor virgl.wasm (every
//      request the page made, seen through the DevTools protocol's Network
//      domain); with --eager (?glload=eager) the renderer is loaded instead
//      and the row names the WebGL2 renderer
//   2  the guest has the virtio-gpu device (/dev/dri/renderD128) and a login
//      shell sets no GALLIUM_DRIVER (kw-gl.sh, for the page's kw.gl=1, leaves
//      Mesa to find /dev/dri); with --gpu0 (?gpu=0) there is no device and
//      the shell has GALLIUM_DRIVER=virpipe; /tmp/.virgl_test exists either way
//   R  with the device, unless --no-resize: a display size change reaches the
//      guest's DRM mode. test/gpu/kms-hotplug.c (built here, written into
//      the guest) holds the display at the size the page offers: the
//      Display window's content box (#fb-layer, display.ts size()). The
//      window maximized (KW.wm), so that it follows the page: one hotplug
//      whose preferred mode is the new box, which the client sets; then the
//      page is resized (DevTools Emulation, the window's size) five times
//      60 ms apart: the guest gets one more hotplug (the page waits for the
//      box to settle), with the new box, which the client sets; the page's
//      canvas then has that size, #fb-layer is that box and wland's
//      container (#wl-desktop) covers the workspace (#workspace); a third
//      size, a third hotplug and mode; and (unless --eager) the renderer is
//      still not loaded: a dumb-buffer KMS client needs none
//   3  unless --no-apt: apt-get installs Mesa over the page's network (the
//      default Wisp server, deb.debian.org through the page's CORS mirror:
//      needs the internet), then in a login shell `eglinfo -B -p gbm` (the
//      device; with --gpu0 `eglinfo -B -p surfaceless`, the vtest link)
//      reports the renderer `virgl (...)`; with the device also kmscube
//      (120 frames, KMS page flips onto the page's display), after which the
//      Guest GL row shows the device's counters (vm.gl.stats.gpu) with its
//      presents; the renderer was fetched only after the first GL program
//      started, and the row names the WebGL2 renderer and the load's time
//   S  with --suspend: before any GL use (the renderer not loaded), Suspend
//      (KW.suspend()) and a plain load of the same URL resume the session,
//      with the renderer still not loaded and the forwarder linked again;
//      after step 3, Suspend while kmscube runs (3D contexts) is refused
//      with the page's message about the GPU; last, a session suspended
//      with ?gl=0 (its devices without GL, as every session saved before
//      GL was on by default) is resumed by a load of the default URL,
//      with GL off for that resume
//   L  with --lose (and the device, after step 3): the renderer's WebGL2
//      context lost while kmscube runs (WEBGL_lose_context; .agents/gl.md,
//      Context loss): the Guest GL row warns "WebGL context lost"; restored,
//      the kmscube ends; a new kmscube renders, and the row is back, counting
//      the loss and the new renderer
//   4  with --xorg (and the device; untested packages, reported, not judged):
//      X.Org's modesetting driver with glamor on /dev/dri/card0 (Debian's
//      xserver-xorg-core), then glxinfo -B and eglinfo on that X server
//
//   node test/gl/page-check.mjs [--port N] [--gpu0] [--eager] [--suspend] [--lose] [--xorg] [--no-apt] [--no-resize] [--inline] [--server URL] [--chrome BIN] [--timeout S] [--cpus N]
//
// --cpus N: ?cpus=N (default 1); --cpus 0 leaves it out (the page's default).
// --inline: ?worker=0 (the kernel on the page's thread; default the page's worker mode).
// --server URL: load the page from a server that already runs (only read
// from; e.g. the dev server used by hand) instead of starting one.
//
// WebGL2 here is ANGLE on SwiftShader (software). Exit 0 when every check
// run passed, 1 on a failure, 2 when it could not run.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome, sleep, startServer } from "../../web/test/lib.mjs";

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const port = Number(opt("--port", "8091"));
const timeout = Number(opt("--timeout", "1800")) * 1000;
const apt = !args.includes("--no-apt");
const gpu = !args.includes("--gpu0");
const xorg = gpu && args.includes("--xorg");
const eager = args.includes("--eager");
const suspendTest = args.includes("--suspend");
const loseTest = gpu && args.includes("--lose");
const resizeTest = gpu && !args.includes("--no-resize");
const cpus = opt("--cpus", "1");
const inline = args.includes("--inline");
const chromeBin = opt("--chrome", process.env.CHROME || findChrome());
const t0 = performance.now();
const secs = () => ((performance.now() - t0) / 1000).toFixed(1);
const say = (s) => console.log(`[${secs()}] ${s}`);

let fails = 0;
const report = (name, ok, detail) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}  ${detail}`);
	if (!ok) fails++;
};

// --server URL: a page server that already runs (e.g. the dev server used by hand), only read from.
const serverUrl = opt("--server");
const base = serverUrl ? serverUrl.replace(/\/$/, "") : `http://127.0.0.1:${port}`;
say(serverUrl ? `the running server ${base}` : `dev server on 127.0.0.1:${port}`);
const server = serverUrl ? { kill: async () => {} } : await startServer({ port, host: "127.0.0.1", dev: true }).catch((e) => {
	console.error(`the dev server did not start: ${e.message}`);
	process.exit(2);
});
const profile = mkdtempSync(join(tmpdir(), "kw-glpage-"));
const dport = 30000 + Math.floor(Math.random() * 20000);
const chrome = spawn(chromeBin, [
	"--headless=new", "--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--hide-scrollbars",
	`--remote-debugging-port=${dport}`, `--user-data-dir=${profile}`, "about:blank",
], { stdio: ["ignore", "ignore", "ignore"] });
const cleanup = async () => {
	chrome.kill("SIGKILL");
	await server.kill();
	rmSync(profile, { recursive: true, force: true });
};
const watchdog = setTimeout(async () => {
	console.error(`no result within ${timeout / 1000} s`);
	await cleanup();
	process.exit(2);
}, timeout);

try {
	let target;
	for (let i = 0; i < 100 && !target; i++) {
		await sleep(100);
		try { target = (await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json()).find((t) => t.type === "page"); } catch {}
	}
	if (!target) throw new Error(`${chromeBin} did not start`);
	const ws = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
	let id = 0;
	const pending = new Map();
	const virglRequests = [];
	ws.onmessage = (m) => {
		const msg = JSON.parse(m.data);
		if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
		// Every request of the page (the renderer's files: when, against the guest's first GL use).
		if (msg.method === "Network.requestWillBeSent" && /virgl[^/]*\.(mjs|wasm)(\?|$)/.test(msg.params.request.url)) {
			virglRequests.push({ url: msg.params.request.url.replace(/^https?:\/\/[^/]+/, ""), at: Number(secs()) });
			say(`page requests ${msg.params.request.url}`);
		}
		if (msg.method === "Runtime.consoleAPICalled") {
			const line = msg.params.args.map((a) => a.value ?? a.description).join(" ");
			if (/guest GL|\[gl\]|gl:/.test(line)) say(`page: ${line}`);
		}
	};
	const send = (method, params = {}) => new Promise((r) => {
		pending.set(++id, r);
		ws.send(JSON.stringify({ id, method, params }));
	});
	const evaluate = async (expression) => {
		const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
		if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
		return r.result?.result?.value;
	};
	await send("Runtime.enable");
	await send("Network.enable");
	// Guest GL by default: no ?gl=1.
	const url = `${base}/?distro=debian&data=0${cpus !== "0" ? `&cpus=${cpus}` : ""}&mem=1024&autosuspend=0&askleave=0&autohide=0${inline ? "&worker=0" : ""}${gpu ? "" : "&gpu=0"}${eager ? "&glload=eager" : ""}`;
	say(`open ${url}`);
	await send("Page.navigate", { url });
	for (let i = 0; i < 600 && !(await evaluate("typeof globalThis.KW?.ready === 'function' && !!globalThis.KW.config").catch(() => false)); i++) await sleep(200);

	// 1: GL on by default, the forwarder linked, the renderer not loaded (or, --eager, loaded)
	const cfgGl = await evaluate(`JSON.stringify({ gl: KW.config.gl, gpu: KW.config.gpu, asked: KW.config.glAsked, eager: KW.config.glEager, cpus: KW.config.cpus, worker: KW.config.worker })`);
	say(`config: ${cfgGl}`);
	const ready = await evaluate(`KW.ready().then((vm) => vm.gl ? vm.gl.ready : Promise.reject(new Error("no vm.gl (GL off?)")))`);
	say(`vm.gl.ready: ${ready}`);
	const status = JSON.parse(await evaluate("JSON.stringify(KW.vm.gl.status)"));
	// The Environment tab's row, as Copy diagnostics lists it ("  [info] Guest GL: on, not loaded yet (...)").
	const rowAt = (re) => evaluate(`(async () => { for (let i = 0; i < 50; i++) { const l = KW.ui.diagText().split("\\n").find((x) => / Guest GL: /.test(x)); if (l && ${re}.test(l)) return l.trim(); await new Promise((r) => setTimeout(r, 100)); } return KW.ui.diagText().split("\\n").find((x) => / Guest GL: /.test(x))?.trim() ?? ""; })()`);
	const row = await rowAt(eager ? "/^\\s*\\[(pass|warn)\\] Guest GL: /" : "/ Guest GL: on, not loaded yet/");
	say(`row: ${row}`);
	const bootFetches = virglRequests.length;
	const at = Number(secs());
	report("gl on by default", JSON.parse(cfgGl).gl === true && JSON.parse(cfgGl).asked === false && typeof ready === "string", cfgGl);
	if (eager) report("gl ready (eager)", status.state === "ready" && /^\[(pass|warn)\] Guest GL: /.test(row), `status ${JSON.stringify(status)}; ${row.slice(0, 200)}`);
	else report("gl ready, renderer not loaded", status.state === "idle" && bootFetches === 0 && / Guest GL: on, not loaded yet/.test(row),
		`status ${status.state}; ${bootFetches} renderer requests by ${at} s; ${row.slice(0, 200)}`);

	const openPage = async (u) => {
		say(`open ${u}`);
		await send("Page.navigate", { url: u });
		await sleep(500);
		for (let i = 0; i < 600 && !(await evaluate("typeof globalThis.KW?.ready === 'function'").catch(() => false)); i++) await sleep(200);
		await evaluate("KW.ready().then(() => 1)");
	};
	const rowOf = (name) => evaluate(`KW.ui.diagText().split("\\n").find((x) => / ${name}: /.test(x))?.trim() ?? ""`);
	const resumedRow = async () => {
		for (let i = 0; i < 100; i++) {
			const r = await rowOf("Suspended session");
			if (/ resumed/.test(r) || /not resumed/.test(r)) return r;
			await sleep(200);
		}
		return rowOf("Suspended session");
	};

	// S: suspend before any GL use, resume with a plain load
	if (suspendTest) {
		const sv = await evaluate("KW.suspend().then((r) => JSON.stringify(r), (e) => 'failed: ' + e.message)");
		say(`suspend: ${sv}`);
		await openPage(url);
		const sr = await resumedRow();
		const r2 = await evaluate(`KW.vm.gl ? KW.vm.gl.ready : Promise.reject(new Error("no vm.gl"))`).catch((e) => `rejected: ${e.message}`);
		const st2 = JSON.parse(await evaluate("JSON.stringify(KW.vm.gl.status)"));
		const echo = await evaluate(`KW.vm.exec("sh", ["-c", "echo alive; ls /dev/dri"], { timeout: 60000 }).then((r) => r.stdout.trim().replace(/\\n/g, " "))`);
		report("suspend and resume before GL use", !/^failed/.test(sv) && / resumed/.test(sr) && !/not resumed/.test(sr) && st2.state === "idle" && virglRequests.length === 0 && /alive/.test(echo) && !/^rejected/.test(r2),
			`suspend ${sv}; ${sr.slice(0, 120)}; renderer ${st2.state}, ${virglRequests.length} renderer requests; vm.gl.ready ${r2}; guest: ${echo}`);
	}

	// 2: the guest's shells
	const env = await evaluate(`KW.vm.exec("bash", ["-lc", 'echo "GALLIUM_DRIVER=$GALLIUM_DRIVER LIBGL_ALWAYS_SOFTWARE=$LIBGL_ALWAYS_SOFTWARE"; grep -o "kw.gl=1" /proc/cmdline; test -S /tmp/.virgl_test && echo socket; ls -l /dev/dri 2>&1'], { timeout: 60000 }).then((r) => r.stdout)`);
	const envOk = gpu
		? /GALLIUM_DRIVER= LIBGL_ALWAYS_SOFTWARE=\n/.test(env) && /renderD128/.test(env)
		: /GALLIUM_DRIVER=virpipe LIBGL_ALWAYS_SOFTWARE=1/.test(env) && !/renderD128/.test(env);
	report("guest env", envOk && /kw\.gl=1/.test(env) && /socket/.test(env), env.trim().replace(/\n/g, "; "));

	// R: the page resized, the guest's DRM mode follows
	if (resizeTest) {
		await resizeCheck(evaluate, send);
		// kms-hotplug is a dumb-buffer KMS client: its DRM file makes a 3D context, which needs no renderer.
		if (!eager) {
			const st = JSON.parse(await evaluate("JSON.stringify(KW.vm.gl.status)"));
			report("resize: a dumb-buffer KMS client leaves the renderer unloaded", st.state === "idle" && virglRequests.length === 0,
				`status ${st.state}; renderer requests ${JSON.stringify(virglRequests)}`);
		}
	}

	// 3: Mesa from apt, then eglinfo on virgl
	if (apt) {
		const pkgs = `mesa-utils libegl-mesa0 libgles2${gpu ? " kmscube" : ""}${xorg ? " xserver-xorg-core xserver-xorg-input-evdev libgl1-mesa-dri libglx-mesa0" : ""}`;
		say(`apt-get install ${pkgs} (over the page's network)`);
		const inst = await evaluate(`KW.vm.exec("bash", ["-c", 'export DEBIAN_FRONTEND=noninteractive; i() { apt-get install -y -q --no-install-recommends ${pkgs} </dev/null; }; i || { apt-get update -q && i; }'], { user: "root", timeout: 1500000 }).then((r) => ({ code: r.exitCode, tail: (r.stdout + r.stderr).slice(-600) }))`);
		say(`apt-get: exit ${inst.code}`);
		if (inst.code !== 0) report("apt-get", false, inst.tail);
		else {
			const cmd = `eglinfo -B -p ${gpu ? "gbm" : "surfaceless"}`;
			const firstUse = Number(secs());
			say(`first GL program: ${cmd}`);
			const e = await evaluate(`KW.vm.exec("bash", ["-lc", "${cmd}"], { timeout: 300000 }).then((r) => ({ code: r.exitCode, out: r.stdout + r.stderr }))`);
			const es = /OpenGL ES profile renderer: (.*)/.exec(e.out)?.[1] ?? "?";
			const ver = /OpenGL ES profile version: (.*)/.exec(e.out)?.[1] ?? "?";
			report(cmd, e.code === 0 && /^virgl \(/.test(es), `GLES renderer "${es}", version "${ver}"`);
			const st = JSON.parse(await evaluate("JSON.stringify(KW.vm.gl.status)"));
			const loadedRow = await rowAt("/^\\s*\\[(pass|warn)\\] Guest GL: /");
			if (!eager) report("renderer loaded on first use", st.state === "ready" && virglRequests.length > 0 && virglRequests.every((r) => r.at >= firstUse) && / loaded in /.test(loadedRow),
				`requests ${JSON.stringify(virglRequests)} (the first GL program at ${firstUse} s); status: loaded in ${(st.loadMs / 1000).toFixed(2)} s, ${(st.startedAt / 1000).toFixed(1)} s after the page opened; row: ${loadedRow.slice(0, 260)}`);
			if (gpu) {
				// kmscube stops at EOF on stdin: a fifo held open (gl.md, The DRM path).
				const k = await evaluate(`KW.vm.exec("bash", ["-lc", 'mkfifo /tmp/h && exec 3<>/tmp/h && timeout 120 kmscube -c 120 <&3 2>&1 | tail -3'], { timeout: 200000 }).then((r) => ({ code: r.exitCode, out: r.stdout + r.stderr }))`);
				report("kmscube", /Rendered \d+ frames/.test(k.out), k.out.trim().replace(/\n/g, "; "));
				await sleep(2500); // the row's next update
				const row2 = await evaluate(`KW.ui.diagText().split("\\n").find((x) => / Guest GL: /.test(x))?.trim() ?? ""`);
				const counters = /.*(virtio-gpu: (last|\d).*? errors)/.exec(row2)?.[1] ?? "";
				say(`row: ${row2}`);
				report("row's virtio-gpu counters", /\d+ commands/.test(counters) && !/ 0 presents/.test(counters), counters);
			}
			if (loseTest) {
				// L: the context lost under kmscube, restored; a new kmscube after it
				await evaluate(`(globalThis.__lose = KW.vm.exec("bash", ["-lc", 'mkfifo /tmp/hl && exec 3<>/tmp/hl && timeout 120 kmscube -c 600 <&3 2>&1 | tail -2'], { timeout: 200000 }).then((r) => ({ code: r.exitCode, out: r.stdout + r.stderr })), 1)`);
				const lost = JSON.parse(await evaluate(`(async () => {
					const gpu = KW.vm.gl.gpu;
					for (let i = 0; i < 600 && !(gpu.scanout?.seq > 10); i++) await new Promise((r) => setTimeout(r, 100));
					const t = gpu.scanout && gpu.texture(gpu.scanout.resource);
					globalThis.__loseExt = t?.gl.getExtension("WEBGL_lose_context");
					globalThis.__loseExt?.loseContext();
					for (let i = 0; i < 50 && !gpu.stats.contextLost; i++) await new Promise((r) => setTimeout(r, 50));
					return JSON.stringify({ lost: !!globalThis.__loseExt, contextLost: gpu.stats.contextLost, state: KW.vm.gl.status.state });
				})()`));
				const lostRow = await rowAt("/\\[warn\\] Guest GL: WebGL context lost/");
				await evaluate("globalThis.__loseExt?.restoreContext(), 1");
				const k1 = await evaluate("globalThis.__lose");
				const k2 = await evaluate(`KW.vm.exec("bash", ["-lc", 'rm -f /tmp/hl; mkfifo /tmp/hl && exec 3<>/tmp/hl && timeout 120 kmscube -c 120 <&3 2>&1 | tail -2'], { timeout: 200000 }).then((r) => ({ code: r.exitCode, out: r.stdout + r.stderr }))`);
				const after = JSON.parse(await evaluate("JSON.stringify({ ...KW.vm.gl.status, gpu: KW.vm.gl.stats.gpu })"));
				const backRow = await rowAt("/^\\s*\\[(pass|warn)\\] Guest GL: (?!WebGL context lost).*lost once and a new renderer made once/");
				report("context lost: the row warns, the running kmscube ends, a new one renders, the row counts it",
					lost.lost && lost.contextLost && lost.state === "lost" && /WebGL context lost/.test(lostRow) && /Rendered \d+ frames/.test(k1.out) && /Rendered 1[12]\d frames/.test(k2.out) &&
						after.state === "ready" && after.gpu.renewals === 1 && !after.gpu.contextLost && after.gpu.presents > 0 && /lost once and a new renderer made once/.test(backRow),
					`at the loss ${JSON.stringify(lost)}; row then: ${lostRow.slice(0, 200)}; kmscube at the loss: ${k1.out.trim().replace(/\n/g, "; ")}; after: ${k2.out.trim().replace(/\n/g, "; ")}; ` +
						`status ${after.state}, losses ${after.losses}, renewals ${after.renewals}; row after: ${backRow.slice(0, 300)}`);
			}
			if (xorg) {
				const script = [
					"Xorg :0 -config kw-kms.conf -nolisten tcp -logfile /tmp/Xorg.0.log &",
					"for i in $(seq 60); do [ -e /tmp/.X11-unix/X0 ] && break; sleep 0.5; done; sleep 1",
					"echo '== glxinfo -B'; DISPLAY=:0 timeout 60 glxinfo -B 2>&1 | head -20",
					"echo '== eglinfo -B -p x11'; DISPLAY=:0 timeout 60 eglinfo -B -p x11 2>&1 | grep -E 'renderer|version' | head -6",
					"echo '== glxgears, 12 s'; DISPLAY=:0 timeout 12 glxgears 2>&1 | tail -3",
					"kill -0 %1 2>/dev/null && echo '== X still runs' || echo '== X has exited'",
					"echo '== Xorg log'; grep -E 'glamor|\\(EE\\)' /tmp/Xorg.0.log | head -20",
					"kill %1; wait; echo \"== X exit status $?\"",
				].join("\n");
				const x = await evaluate(`KW.vm.exec("bash", ["-c", ${JSON.stringify(script)}], { user: "root", timeout: 300000 }).then((r) => ({ code: r.exitCode, out: r.stdout + r.stderr }))`);
				console.log(`--- Xorg (modesetting, glamor) exit ${x.code}:\n${x.out}`);
			}
		}
	}
	const stats = await evaluate("JSON.stringify(KW.vm.gl.stats)");
	say(`vm.gl.stats ${stats}`);

	if (suspendTest && apt && gpu) {
		// S: refused while a GL client holds 3D contexts, with the page's words
		await evaluate(`(globalThis.__kms = KW.vm.exec("bash", ["-lc", 'mkfifo /tmp/h2 && exec 3<>/tmp/h2 && timeout 60 kmscube -c 400 <&3 >/dev/null 2>&1'], { timeout: 120000 }), 1)`);
		await sleep(4000);
		const refused = await evaluate(`KW.suspend().then(() => "suspended", (e) => "refused: " + e.message)`);
		report("suspend refused while kmscube runs", /^refused: a program is using the GPU/.test(refused), refused);
		await evaluate("globalThis.__kms.then(() => 1)");
	}
	if (suspendTest) {
		// S: a session without GL (as saved before GL was on by default) resumes with GL off on a default load
		await openPage(`${url}&gl=0`);
		await evaluate(`KW.vm.exec("true", [], { timeout: 60000 }).then(() => 1)`);
		const sv = await evaluate("KW.suspend().then((r) => JSON.stringify(r), (e) => 'failed: ' + e.message)");
		say(`suspend with ?gl=0: ${sv}`);
		await openPage(url);
		const sr = await resumedRow();
		const c = JSON.parse(await evaluate(`JSON.stringify({ gl: KW.config.gl, gpu: KW.config.gpu, vmGl: !!KW.vm.gl })`));
		const glRow = await rowOf("Guest GL");
		const echo = await evaluate(`KW.vm.exec("sh", ["-c", "echo alive; ls /dev/dri 2>&1"], { timeout: 60000 }).then((r) => r.stdout.trim().replace(/\\n/g, " "))`);
		report("a session saved without GL resumes on the default URL, GL off", / resumed/.test(sr) && !/not resumed/.test(sr) && !c.gl && !c.gpu && !c.vmGl && /alive/.test(echo),
			`${sr.slice(0, 120)}; ${JSON.stringify(c)}; ${glRow.slice(0, 160)}; guest: ${echo}`);
	}
} catch (e) {
	console.error(`could not run: ${e?.stack || e}`);
	clearTimeout(watchdog);
	await cleanup();
	process.exit(2);
}
clearTimeout(watchdog);
await cleanup();
console.log(fails ? `${fails} check(s) failed` : "all checks passed");
process.exit(fails ? 1 : 0);

/**
 * R: the size offered (the Display window's content box, #fb-layer) reaches the guest's DRM
 * mode, one hotplug per burst of changes; the window maximized follows the page, and the
 * page's layers follow the mode.
 */
async function resizeCheck(evaluate, send) {
	const bin = join(profile, "kms-hotplug");
	const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
	const cc = spawnSync(process.env.ZIG ?? "zig", ["cc", "-target", "aarch64-linux-musl", "-mcpu=generic", "-static", "-O2", "-s", "-o", bin, join(root, "test/gpu/kms-hotplug.c")], { stdio: "inherit" });
	if (cc.status !== 0) return report("resize", false, "building test/gpu/kms-hotplug.c failed");
	const b64 = readFileSync(bin).toString("base64");
	await evaluate(`KW.vm.exec("sh", ["-c", "base64 -d >/tmp/kms-hotplug && chmod 755 /tmp/kms-hotplug"], { input: ${JSON.stringify(b64)}, timeout: 60000 }).then(() => 1)`);
	const metrics = (w, h) => send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
	// The size the page offers: the Display window's content box (display.ts size(); not rotated on a desktop). Null until the window opens.
	const box = () => evaluate(`(() => { const e = document.getElementById("fb-layer"); return e?.isConnected && e.clientWidth ? e.clientWidth + "x" + e.clientHeight : null; })()`);
	const log = () => evaluate(`KW.vm.exec("cat", ["/tmp/kh.log"]).then((r) => r.stdout)`);
	/** Poll the client's log until `done` says it has what is waited for (or the time is up); returns it. */
	const until = async (done, ms = 60000) => {
		const end = Date.now() + ms;
		let text = "";
		while (Date.now() < end) {
			text = await log();
			if (/FAILED/.test(text) || done(text)) break;
			await sleep(300);
		}
		return text;
	};
	/** The modes the client set, in order (one per hotplug: its STEPS are all "s"). */
	const sets = (text) => [...text.matchAll(/set (\d+x\d+)/g)].map((m) => m[1]);
	const hotplug = (text, n) => new RegExp(`hotplug ${n}: preferred (\\d+x\\d+)`).exec(text)?.[1];
	const layers = () => evaluate(`JSON.stringify((() => {
		const q = (id) => document.getElementById(id), box = (e) => e ? e.offsetWidth + "x" + e.offsetHeight : null;
		const c = q("fb");
		return { canvas: c ? c.width + "x" + c.height : null, canvasCss: box(c), fbLayer: box(q("fb-layer")), workspace: box(q("workspace")), wlDesktop: box(q("wl-desktop")) };
	})())`).then(JSON.parse);
	await metrics(1000, 700);
	await sleep(1500);
	// Three hotplugs: the window maximized, a burst of page sizes, one more page size.
	await evaluate(`(globalThis.__kh = KW.vm.exec("sh", ["-c", "/tmp/kms-hotplug /dev/dri/card0 120 sss 3 >/tmp/kh.log 2>&1"], { user: "root", timeout: 200000 }), 1)`);
	let text = await until((t) => /ready/.test(t));
	const r0 = /ready (\d+x\d+)/.exec(text)?.[1];
	// The Display window opens once the client has set its mode (display.ts onDisplay()).
	let b0 = null;
	for (let i = 0; i < 50 && !(b0 = await box()); i++) await sleep(100);
	report("resize: the guest's mode is the size offered, the Display window's content box", !!r0 && r0 === b0, `kms-hotplug ready ${r0}, #fb-layer ${b0}`);
	// Maximized, the window's box is the workspace's (less its title bar) and follows the page. The page's
	// first Display window opens at the default box, not maximized (display.ts openGeom()).
	const wasMax = await evaluate(`!!KW.wm.get("display")?.maximized`);
	await evaluate(`(KW.wm.maximize("display", true), 1)`);
	text = await until((t) => sets(t).length >= 1);
	await sleep(500);
	const bm = await box(), hotM = hotplug(text, 1), setM = sets(text)[0];
	report("resize: the Display window maximized, its new box reaches the guest (a hotplug, the mode set)", !wasMax && hotM === bm && setM === bm,
		`maximized before ${wasMax}; hotplug 1 preferred ${hotM}, set ${setM}, #fb-layer ${bm}`);
	// A burst: five sizes 60 ms apart, one hotplug when it settles.
	for (const [w, h] of [[960, 680], [940, 660], [920, 650], [910, 645], [900, 640]]) {
		await metrics(w, h);
		await sleep(60);
	}
	text = await until((t) => sets(t).length >= 2);
	await sleep(1500);
	text = await log();
	const b1 = await box();
	const set1 = sets(text)[1], hot1 = hotplug(text, 2);
	const uevents = (text.match(/uevent /g) ?? []).length;
	const l1 = await layers();
	report("resize: one hotplug for a burst of page resizes, the window's new box", uevents === 2 && hot1 === b1 && set1 === b1,
		`${uevents} uevent(s), one of them the maximize's; hotplug 2 preferred ${hot1}, set ${set1}, #fb-layer ${b1}`);
	report("resize: the canvas has the guest's new mode, filling the Display window's box; wland's container covers the workspace",
		l1.canvas === b1 && l1.fbLayer === b1 && l1.canvasCss === b1 && !!l1.workspace && l1.wlDesktop === l1.workspace, JSON.stringify(l1));
	// Another size: another hotplug and mode.
	await metrics(1100, 760);
	text = await until((t) => /done/.test(t));
	const b2 = await box();
	const hot2 = hotplug(text, 3), set2 = sets(text)[2];
	const code = await evaluate("globalThis.__kh.then((r) => r.exitCode)");
	report("resize: another page size, another hotplug and mode", hot2 === b2 && set2 === b2 && code === 0, `hotplug 3 preferred ${hot2}, set ${set2}, #fb-layer ${b2}, exit ${code}`);
	console.log(`--- kms-hotplug:\n${text.trim()}`);
	await send("Emulation.clearDeviceMetricsOverride");
	await sleep(1000);
}
