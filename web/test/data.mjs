#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Headless-Chromium test of the persistent data disk (web/src/data.ts), via
// the DevTools protocol (no npm dependencies; see lib.mjs).
//
//   node web/test/data.mjs [--dev] [--chrome path] [--mb 4] [--verbose]
//
// Runs against the built output (web/.output, `pnpm build:web` first), or
// with --dev against the Vite dev server. One fresh browser profile, page
// loads of the page with ?distro=alpine (the base bundle, which carries the
// data disk template, with the alpine image; the default is debian):
//   1. first boot: the data disk is created from the template; mount it by
//      label (mount LABEL=kwdata), write a marker and an N MiB file, sync.
//      Also the guest's own /data mount and the overlay root (its changes
//      live on /data/distros/alpine/upper), and that KW.sync() (IRQ 4)
//      alone saves a file written with the guest's writeback slowed down.
//   2. reload: the files are still there, the disk opened lazily (no block
//      data in memory at boot), and a file written under /etc survives
//      another reload. Safe mode (?root=initramfs) boots the plain image
//      (a tmpfs upper) with /data mounted, and the reload after it the
//      overlay on the data disk again.
//   2b. a broken root: /sbin/init deleted, so the base's check of the root
//      with the changes fails and the reload boots safe mode by itself for
//      that boot (the plain image, changes kept; the page explains); after
//      the repair on /data the next boot uses the changes again.
//   2c. ?distro=debian (when the page has the image): its changes live in
//      /data/distros/debian/, apart from Alpine's, and survive a reload.
//   3. a second tab while the first is open: it gets an in-memory snapshot
//      (and says so), with the saved files; its writes are not saved.
//   4. export (KW.exportData, a download) and reset (KW.resetData): the
//      marker is gone; import the exported file (KW.importData): it is back.
//   5. ?data=0: no data disk.
// The other steps mount the disk at /mnt/kwdata and run sync themselves.
// The console runs as the distro's user: the steps that need root (mount,
// findfs, dmesg, writes to /mnt/kwdata, /etc, /proc/sys and the upper layer)
// use sudo.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readKwsparse } from "../../js/core/kwsparse.ts";
import { PROMPT, opt, openPage, sleep, startServer } from "./lib.mjs";

const mb = Number(opt("mb", "4"));
const TEMPLATE_BLOCKS = 554; // non-zero blocks of the empty kwdata file system (kernel/build.sh datadisk)

const results = [];
const check = (name, ok, detail = "") => {
	results.push(ok);
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};

const MOUNT = "sudo mkdir -p /mnt/kwdata; mountpoint -q /mnt/kwdata || sudo mount LABEL=kwdata /mnt/kwdata";
const ROOT = "awk '$2 == \"/\" { t = $3 } END { print t }' /proc/mounts";
/** The upper layer this boot uses (data, tmpfs or none) and why, from the base (guest/base/initramfs/init). */
const BASE = "sed -n 's/^upper=//p; s/^why=//p' /run/kw-base";
const diskInfo = (p) => p.evaluate(`JSON.stringify(KW.dataDisk && { persistent: KW.dataDisk.persistent, seeded: !!KW.dataDisk.seeded,
	stored: KW.dataDisk.stored.size, mem: KW.dataDisk.mem.size, memBytes: KW.dataDisk.memBytes, notice: KW.dataDisk.notice ?? null,
	stats: KW.dataDisk.stats, size: KW.dataDisk.size })`).then((s) => (s ? JSON.parse(s) : null));
/** The data disk's status line in Settings' Storage section (#data-status: in the document while Settings is closed too, sysapps.ts). */
const storageStatus = (p) => p.evaluate("document.getElementById('data-status').textContent");

const port = 23000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}/`;
/** The page on the alpine image (the default is debian): these checks name Alpine's upper layer. */
const home = `${base}?distro=alpine`;
const downloads = mkdtempSync(path.join(tmpdir(), "kw-data-dl-"));
const server = await startServer({ port, host: "127.0.0.1" });
console.log(`server: ${server.kind}, ${base}`);
let a;
try {
	a = await openPage("data");
	await a.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
	const shell = (p) => p.waitScreen(PROMPT, "shell prompt", 180000);
	const load = async (p, url) => {
		await p.goto(url);
		await sleep(500);
		await shell(p);
	};

	console.log("== 1. first boot: the data disk is created from the template");
	await load(a, home);
	let info = await diskInfo(a);
	check("data disk attached persistently, created from the template", info?.persistent && info.seeded && info.size === 4 * 1024 ** 3,
		JSON.stringify(info && { stored: info.stored, size: info.size }));
	const status = await storageStatus(a);
	check("Settings' Storage shows the data disk", /Saved in this browser/.test(status), status);
	let r = await a.run(`sudo dmesg -n 1; sudo findfs LABEL=kwdata; ${MOUNT} && grep ' /mnt/kwdata ' /proc/mounts`);
	check("the guest finds and mounts LABEL=kwdata", r.rc === 0 && /ext4/.test(r.out), r.out.replace(/\n/g, " | "));
	const marker = `marker-${Date.now()}`;
	r = await a.run(`echo ${marker} | sudo tee /mnt/kwdata/marker.txt >/dev/null; sudo dd if=/dev/urandom of=/mnt/kwdata/big bs=1M count=${mb} 2>/dev/null; ` +
		"md5sum /mnt/kwdata/big | cut -d' ' -f1; sync", 300000);
	const md5 = r.out.split("\n").map((l) => l.trim()).find((l) => /^[0-9a-f]{32}$/.test(l));
	check(`write a marker and ${mb} MiB, sync`, r.rc === 0 && !!md5, md5);
	info = await diskInfo(a);
	check("saved: blocks in IndexedDB, little kept in memory", info.stored > TEMPLATE_BLOCKS + mb * 256 && info.memBytes < 1048576,
		`${info.stored} stored blocks, ${info.mem} blocks in memory, ${info.stats.saves} saves`);
	r = await a.run("grep -E ' /data | / ' /proc/mounts | cut -d' ' -f2,3 | tr '\\n' ' '; echo");
	check("the guest mounts /data itself, / is the overlay", /\/data ext4/.test(r.out) && /\/ overlay/.test(r.out), r.out);
	// With the guest's writeback and journal commits slowed down, only the
	// sync request (IRQ 4) gets this file onto the disk before the reload.
	r = await a.run("echo 360000 | sudo tee /proc/sys/vm/dirty_expire_centisecs /proc/sys/vm/dirty_writeback_centisecs >/dev/null; " +
		`sudo mount -o remount,commit=600 /data && echo ${marker} > ~/unsynced.txt`);
	const synced = await a.evaluate("KW.sync({ timeout: 5000 })");
	check("KW.sync() (the SDK's sync()) is confirmed by the kernel", r.rc === 0 && synced === true, String(synced));

	console.log("== 2. reload: the files persist, the disk opens lazily");
	await load(a, home);
	info = await diskInfo(a);
	check("reattached without seeding, nothing loaded at boot", info.persistent && !info.seeded && info.stored > TEMPLATE_BLOCKS + mb * 256,
		`${info.stored} stored, ${info.mem} in memory, ${info.stats.storeBlocksRead} blocks read so far`);
	r = await a.run(`${MOUNT} && cat /mnt/kwdata/marker.txt && md5sum /mnt/kwdata/big | cut -d' ' -f1`);
	check("marker and file survive the reload", r.out.includes(marker) && r.out.includes(md5), r.out.replace(/\n/g, " | "));
	r = await a.run("cat ~/unsynced.txt");
	check("a file written without a guest sync survives (KW.sync)", r.out.includes(marker), r.out);
	r = await a.run(`${ROOT}; echo ${marker} | sudo tee /etc/kw-overlay-test >/dev/null; sync; sudo cat /data/distros/alpine/upper/etc/kw-overlay-test`);
	check("overlay: / is the overlay, /etc/kw-overlay-test lands in /data/distros/alpine/upper", r.rc === 0 && /^overlay$/m.test(r.out) && r.out.includes(marker),
		r.out.replace(/\n/g, " | "));
	await a.evaluate("KW.sync({ timeout: 2000 })");
	await load(a, home);
	r = await a.run(`${ROOT}; cat /etc/kw-overlay-test`);
	check("overlay: /etc/kw-overlay-test survives a reload", /^overlay$/m.test(r.out) && r.out.includes(marker), r.out.replace(/\n/g, " | "));

	await load(a, `${home}&root=initramfs`);
	r = await a.run(`${BASE}; grep ' /data ' /proc/mounts | cut -d' ' -f3; cat /etc/kw-overlay-test 2>&1 | head -1`);
	const safeBtn = await a.evaluate("document.getElementById('data-safe').textContent");
	check("safe mode (?root=initramfs): the plain image (tmpfs upper), /data mounted", /^tmpfs$/m.test(r.out) && /^kw\.root=initramfs$/m.test(r.out) &&
		/^ext4$/m.test(r.out) && !r.out.includes(marker) && safeBtn === "Leave safe mode", `${r.out.replace(/\n/g, " | ")}; button "${safeBtn}"`);
	await load(a, home);
	r = await a.run(`${BASE}; cat /etc/kw-overlay-test`);
	check("after safe mode: the changes on the data disk again", /^data$/m.test(r.out) && r.out.includes(marker), r.out.replace(/\n/g, " | "));

	console.log("== 2b. a broken root: safe mode for that boot, the changes back once repaired");
	r = await a.run("sudo rm /sbin/init; sync");
	await a.evaluate("KW.sync({ timeout: 2000 })");
	await load(a, home);
	const scr = await a.screen();
	check("the reload boots safe mode, with the reason", /SAFE MODE/.test(scr) && /\/sbin\/init is missing/.test(scr),
		scr.split("\n").filter((l) => /kw-overlay|SAFE/.test(l)).join(" | "));
	const note = await a.evaluate("(() => { const n = document.getElementById('data-safe-note'); return n.hidden ? '' : n.textContent; })()");
	check("the page explains safe mode", /\/sbin\/init is missing/.test(note) && note.includes("/data/distros/alpine/upper") && /each boot tries them again/.test(note), note);
	r = await a.run(`${BASE}; sudo cat /data/distros/alpine/upper/etc/kw-overlay-test; sudo rm /data/distros/alpine/upper/sbin/init; sync`);
	check("safe mode: a tmpfs upper, the changes kept on /data", /^tmpfs$/m.test(r.out) && /^safe mode: /m.test(r.out) && r.out.includes(marker),
		r.out.replace(/\n/g, " | "));
	await a.evaluate("KW.sync({ timeout: 2000 })");
	await load(a, home);
	r = await a.run(`${MOUNT}; ${BASE}; cat /etc/kw-overlay-test`); // step 3 uses the mount
	check("after the repair: the changes on the data disk again", /^data$/m.test(r.out) && r.out.includes(marker), r.out.replace(/\n/g, " | "));

	if (await a.evaluate("!!document.getElementById('opt-distro-debian')")) {
		console.log("== 2c. another distro keeps its own changes");
		await load(a, `${base}?distro=debian`);
		r = await a.run(`cat /usr/lib/kw-distro; ${BASE}; cat /etc/kw-overlay-test 2>&1 | head -1; echo deb-${marker} | sudo tee /etc/kw-overlay-test-debian >/dev/null; sync`);
		check("debian: its own upper, Alpine's change not there", /^debian$/m.test(r.out) && /^data$/m.test(r.out) && !r.out.includes(`\n${marker}`), r.out.replace(/\n/g, " | "));
		await a.evaluate("KW.sync({ timeout: 2000 })");
		await load(a, `${base}?distro=debian`);
		r = await a.run("cat /etc/kw-overlay-test-debian; ls /data/distros | tr '\\n' ' '");
		check("debian: its change survives a reload, /data/distros has both", r.out.includes(`deb-${marker}`) && /alpine debian/.test(r.out), r.out.replace(/\n/g, " | "));
		await load(a, home);
		r = await a.run(`${MOUNT}; cat /etc/kw-overlay-test; cat /etc/kw-overlay-test-debian 2>&1 | head -1`);
		check("alpine again: its change, not Debian's", r.out.includes(marker) && !r.out.includes(`deb-${marker}`), r.out.replace(/\n/g, " | "));
	}

	console.log("== 3. a second tab gets an unsaved snapshot");
	const b = await a.newTab("data-tab2");
	try {
		await load(b, home);
		info = await diskInfo(b);
		check("second tab: not persistent, with a notice", info && !info.persistent && /another tab/.test(await b.screen()), info?.notice);
		const chk = await storageStatus(b);
		check("second tab: Settings' Storage says so", /In memory only: open in another tab/.test(chk), chk);
		r = await b.run(`${MOUNT} && cat /mnt/kwdata/marker.txt && echo tab2 | sudo tee /mnt/kwdata/tab2.txt >/dev/null && sync`);
		check("second tab: sees the saved files (a copy)", r.out.includes(marker), r.out.replace(/\n/g, " | "));
		r = await b.run("cat /etc/kw-overlay-test");
		check("second tab: overlay root with the saved changes", r.out.includes(marker), r.out);
	} finally {
		await b.close();
	}
	r = await a.run("ls /mnt/kwdata");
	check("first tab is unaffected", !r.out.includes("tab2.txt") && r.out.includes("marker.txt"), r.out.replace(/\n/g, " "));

	console.log("== 4. export, reset, import");
	const before = new Set(readdirSync(downloads));
	const exp = await a.evaluate("KW.exportData().then((r) => JSON.stringify(r))").then(JSON.parse);
	let file;
	for (let i = 0; i < 40 && !file; i++) {
		await sleep(250);
		file = readdirSync(downloads).find((f) => !before.has(f) && f.endsWith(".kwsparse.gz"));
	}
	let img = null;
	if (file) img = await readKwsparse(readFileSync(path.join(downloads, file)));
	check("export downloads a kwsparse.gz of the disk", !!img && img.size === 4 * 1024 ** 3 && img.indices.length === exp.blocks && exp.blocks > mb * 256,
		file ? `${file}: ${exp.blocks} blocks, ${exp.bytes} bytes` : "no file downloaded");
	await a.evaluate("KW.resetData()").catch(() => {}); // reloads the page
	await sleep(500);
	await shell(a);
	info = await diskInfo(a);
	r = await a.run(`${MOUNT} && ls /mnt/kwdata`);
	check("reset: a fresh disk from the template", info.seeded && !r.out.includes("marker.txt"), r.out.replace(/\n/g, " "));
	if (file) {
		const b64 = readFileSync(path.join(downloads, file)).toString("base64");
		await a.evaluate(`KW.importData(Uint8Array.from(atob(${JSON.stringify(b64)}), (c) => c.charCodeAt(0)))`).catch(() => {});
		await sleep(500);
		await shell(a);
		r = await a.run(`${MOUNT} && cat /mnt/kwdata/marker.txt && md5sum /mnt/kwdata/big | cut -d' ' -f1`);
		check("import restores the exported disk", r.out.includes(marker) && r.out.includes(md5), r.out.replace(/\n/g, " | "));
	}

	console.log("== 5. ?data=0");
	await load(a, `${home}&data=0`);
	info = await diskInfo(a);
	r = await a.run("sudo findfs LABEL=kwdata || echo none");
	check("?data=0: no data disk", info === null && /none/.test(r.out), r.out);
} catch (e) {
	check("exception", false, e.stack ?? e.message);
} finally {
	await a?.close();
	await server.kill();
	try { rmSync(downloads, { recursive: true, force: true }); } catch {}
}

const ok = results.length > 0 && results.every(Boolean);
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
