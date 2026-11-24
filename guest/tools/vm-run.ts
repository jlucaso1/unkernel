#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Boot a distro image on the distroless kernel bundle (the Node SDK, from
// source) and run a shell script in it: for build steps that need the
// image's own programs (distro/debian/build.sh: apt's source cache).
//
//   node vm-run.ts KERNEL IMAGE [--mem MiB] [--net] [--shm] [--append ARGS] [--data FILE]
//                  [--timeout s] [--shell PROGRAM] [--get GUESTFILE=HOSTFILE]... [--trace FILE] SCRIPT
//
// SCRIPT runs as `sh -c SCRIPT` (or PROGRAM -c SCRIPT) as root through the
// base's kwtty, with no network unless --net; its output is passed on, and a
// non-zero exit fails the run. --shm gives the guest kwshm (/dev/kwshm), --append
// adds ARGS to the bundle's kernel command line (the page's boot: --shm --append
// "kw.gl=1 kw.wayland=1", which starts wland's relay at boot).
// Then each --get copies a guest file out, binary-safe (exec's stdout as
// bytes), checked against the size and SHA-256 the guest reports. The VM is
// powered off at the end (the root's changes are in memory, unless --data).
// --trace FILE writes the image reads of the boot and SCRIPT to FILE, one
// "OFFSET LENGTH" line each (bytes, in the order the guest made them);
// SCRIPT then starts once the console shows the shell's prompt (output
// ending in "# ", "$ " or the distros' "⇒ "), so that the trace holds a
// whole boot whatever the timing.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { bundledBoot, createKernel, directBackend, FileDisk, NetStack, type BlockDevice } from "../../js/node.ts";

const args = process.argv.slice(2);
const pos: string[] = [];
const gets: Array<[string, string]> = [];
let mem = 512, net = false, shm = false, append = "", data: string | undefined, timeout = 600, shell = "sh", trace: string | undefined;
while (args.length) {
	const a = args.shift()!;
	if (a === "--mem") mem = Number(args.shift());
	else if (a === "--net") net = true;
	else if (a === "--shm") shm = true;
	else if (a === "--append") append = args.shift()!;
	else if (a === "--data") data = args.shift();
	else if (a === "--timeout") timeout = Number(args.shift());
	else if (a === "--shell") shell = args.shift()!;
	else if (a === "--trace") trace = args.shift();
	else if (a === "--get") {
		const g = args.shift()!, i = g.indexOf("=");
		if (i <= 0) throw new Error(`--get ${g}: want GUESTFILE=HOSTFILE`);
		gets.push([g.slice(0, i), g.slice(i + 1)]);
	} else pos.push(a);
}
if (pos.length !== 3) {
	console.error("usage: vm-run.ts KERNEL IMAGE [--mem MiB] [--net] [--shm] [--append ARGS] [--data FILE] [--timeout s] [--shell PROGRAM] [--get GUESTFILE=HOSTFILE]... [--trace FILE] SCRIPT");
	process.exit(2);
}
const [kernel, image, script] = pos as [string, string, string];

const module = await WebAssembly.compile(readFileSync(kernel));
let reads: string[] | null = null, distro: string | BlockDevice = image;
if (trace) {
	const file = new FileDisk(image, { readOnly: true });
	const log: string[] = reads = [];
	distro = {
		size: file.size, readOnly: true,
		read(off: number, views: Uint8Array[]) {
			log.push(`${off} ${views.reduce((n, v) => n + v.length, 0)}`);
			return file.read(off, views);
		},
		write() { throw new Error("read-only"); },
	};
}
// The console shell's prompt (--trace): the end of the output, without
// escape sequences, is "# ", "$ " or "⇒ ".
let tail = "", prompted = () => {};
const prompt = new Promise<void>((r) => (prompted = r));
const dec = new TextDecoder();
const onOutput = trace ? (b: Uint8Array) => {
	tail = (tail + dec.decode(b, { stream: true })).slice(-512);
	if (/[#$⇒] $/.test(tail.replace(/\x1b\][^\x07]*\x07|\x1b\[[0-9;?]*[A-Za-z]/g, ""))) prompted();
} : undefined;
const vm = await createKernel({
	kernel: module, memoryMiB: mem, distro, log: () => {}, onOutput, shm,
	...(append ? { cmdline: `${bundledBoot(module).cmdline} ${append}` } : {}),
	// A traced boot is a boot as the page and the CLI make it: with a console size, the
	// login shell also reads the kernel console's terminfo entry (linux).
	...(trace ? { consoleSize: { cols: 120, rows: 30 } } : {}),
	disks: data ? [{ kind: "file", path: data }] : [],
	net: net ? new NetStack({ backend: directBackend(), hostLoopback: false, log: () => {} }) : undefined,
});
const ms = timeout * 1000;
let code = 0;
try {
	if (trace) {
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([prompt, new Promise((_, no) => {
			timer = setTimeout(() => no(new Error("no shell prompt on the console")), ms);
		})]).finally(() => clearTimeout(timer));
	}
	const r = await vm.exec(shell, ["-c", script], { timeout: ms, user: "root" });
	process.stdout.write(r.stdout);
	process.stderr.write(r.stderr);
	if (r.exitCode !== 0) throw new Error(`script: exit ${r.exitCode ?? `signal ${r.signal}`}`);
	if (trace) writeFileSync(trace, reads!.join("\n") + "\n");
	for (const [g, h] of gets) {
		const q = `'${g.replaceAll("'", "'\\''")}'`;
		const sum = (await vm.exec("sh", ["-c", `stat -c %s ${q} && sha256sum < ${q}`], { timeout: ms, user: "root" }));
		if (sum.exitCode !== 0) throw new Error(`${g}: ${sum.stderr.trim()}`);
		const [size, hash] = sum.stdout.trim().split(/\s+/);
		const r = await vm.exec("cat", [g], { timeout: ms, encoding: "buffer", maxBuffer: 1 << 30, user: "root" });
		if (r.exitCode !== 0) throw new Error(`cat ${g}: exit ${r.exitCode}`);
		const got = createHash("sha256").update(r.stdout).digest("hex");
		if (r.stdout.length !== Number(size) || got !== hash)
			throw new Error(`${g}: copied ${r.stdout.length} bytes (sha256 ${got}), the guest has ${size} (${hash})`);
		writeFileSync(h, r.stdout);
	}
} catch (e) {
	console.error(`vm-run: ${(e as Error).message}`);
	code = 1;
}
vm.write("\npoweroff\n");
const end = await Promise.race([vm.exited, new Promise((r) => setTimeout(r, 30000))]);
if (!end) vm.stop({ reason: "vm-run: no poweroff" });
process.exit(code);
