// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The showcase: a fast scripted tour of the demos, hands off. It
// starts once the guest is up (showcaseFromUrl in launcher.ts) when the URL has
// ?showcase, and needs nothing clicked: each step puts a caption
// near the bottom of the page, clear of the typing at the top (the title
// cards sit in the middle), launches a demo through launcher.ts (or types
// into a shell window), waits until it shows what it is about, plays it (keys typed into
// its terminal, or the evdev keyboard for the display's game), holds it,
// closes it and goes on. A thin bar along the top shows the progress. It
// ends on a title card that stays.
//
//   ?showcase                   the whole tour (STEPS below, in order)
//   ?showcase=htop,nvim,git     only those steps, in the tour's order (step ids:
//                               the demo ids, and intro, shell, launcher, outro)
//   ?showcase=warm              no captions and no holds: launch each demo, wait
//                               (up to 15 min) until it is ready, close it. apk
//                               packages and npm installs persist on the data
//                               disk, so a later tour does not wait on them.
//                               Combine as warm,nvim,git.
//
// While it runs, KW.showcase has skip() (the current step), pause() and
// resume() (between steps), for the devtools console. The tour does not
// wait: a demo not ready within 30 s (its packages not installed yet, say)
// is skipped and logged ([showcase] in the Kernel log tab), and so is a
// step that fails.
import LOGO_URL from "../../assets/logo.svg";
import { REPO } from "./config.ts";
import { APPS } from "./apps/index.ts";
import { isPageApp } from "./apps/types.ts";
import { evdev } from "./display.ts";
import { KW } from "./kw.ts";
import { appTerminal, launch, setLauncher, unavailable } from "./launcher.ts";
import type { KernelHandle } from "./sdk.ts";
import { ui$ } from "./store.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const log = (m: string) => KW.ui?.log(`[showcase] ${m}`, "h");
const vm = () => KW.vm as KernelHandle;

// --- skipping and pausing --------------------------------------------------------

/** Aborted when the current step is skipped; every wait in a step races it. */
let stepAbort = new AbortController();
let paused: (() => void) | null = null;
let pause: Promise<void> | null = null;

class Skipped extends Error {}

/** sleep() that ends early (throwing Skipped) when the step is skipped. */
function wait(ms: number): Promise<void> {
	const signal = stepAbort.signal;
	if (signal.aborted) return Promise.reject(new Skipped());
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
		const onAbort = () => { clearTimeout(t); reject(new Skipped()); };
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

// --- the caption and the progress bar -------------------------------------------

const CSS = `
#showcase-cap {
	position: fixed; left: 50%; bottom: calc(48px + var(--sb, 0px)); z-index: 2147483000; pointer-events: none;
	transform: translate(-50%, 12px); opacity: 0; max-width: min(92vw, 1100px);
	padding: 16px 30px 18px; border-radius: 16px; text-align: center; color: #fff;
	background: rgba(10, 10, 12, .8); backdrop-filter: blur(14px) saturate(1.4);
	-webkit-backdrop-filter: blur(14px) saturate(1.4);
	border: 1px solid rgba(255, 255, 255, .12); box-shadow: 0 20px 60px rgba(0, 0, 0, .55);
	transition: opacity .22s ease, transform .22s ease;
}
#showcase-cap[data-show] { opacity: 1; transform: translate(-50%, 0); }
#showcase-cap[data-card] { top: 50%; bottom: auto; transform: translate(-50%, -46%); padding: 40px 60px 44px; }
#showcase-cap[data-card][data-show] { transform: translate(-50%, -50%); }
#showcase-cap .logo { display: block; width: clamp(96px, 13vw, 176px); height: auto; image-rendering: pixelated; margin: 0 auto 22px; filter: drop-shadow(0 12px 40px rgba(122, 104, 200, .45)); }
#showcase-cap .n { font: 500 12px/1 var(--font-mono); letter-spacing: .14em; color: #71717a; margin-bottom: 10px; }
#showcase-cap .t { font: 600 clamp(22px, 3.4vw, 44px)/1.15 var(--font-sans); letter-spacing: -.02em; }
#showcase-cap[data-card] .t { font-size: clamp(36px, 6.4vw, 92px); }
#showcase-cap .s { margin-top: 8px; font: 400 clamp(13px, 1.5vw, 20px)/1.4 var(--font-mono); color: #a1a1aa; }
#showcase-cap .t b { background: linear-gradient(90deg, #22d3ee, #a78bfa, #f472b6); -webkit-background-clip: text; background-clip: text; color: transparent; }
#showcase-dim { position: fixed; inset: 0; z-index: 2147482999; pointer-events: none; background: #000; opacity: 0; transition: opacity .3s ease; }
#showcase-dim[data-show] { opacity: .62; }
#showcase-bar { position: fixed; left: 0; top: 0; height: 3px; width: 0; z-index: 2147483001; pointer-events: none;
	background: linear-gradient(90deg, #22d3ee, #a78bfa, #f472b6); transition: width .8s ease, opacity .6s ease; }
`;

let capEl: HTMLDivElement | null = null;
let dimEl: HTMLDivElement | null = null;
let barEl: HTMLDivElement | null = null;

function mount(): void {
	if (capEl) return;
	const style = document.createElement("style");
	style.textContent = CSS;
	document.head.append(style);
	const div = (id: string) => Object.assign(document.createElement("div"), { id });
	dimEl = div("showcase-dim");
	capEl = div("showcase-cap");
	barEl = div("showcase-bar");
	capEl.setAttribute("aria-live", "polite");
	document.body.append(dimEl, capEl, barEl);
}

/** Show a caption (title may hold <b> for the gradient); card: a centred title card over a dimmed page. */
async function caption(title: string, sub = "", opts: { card?: boolean; chapter?: string; logo?: boolean } = {}): Promise<void> {
	if (warmOnly) return;
	mount();
	if (capEl!.hasAttribute("data-show")) await hideCaption();
	capEl!.innerHTML = `${opts.logo ? `<img class="logo" src="${LOGO_URL}" alt="">` : ""}${opts.chapter ? `<div class="n">${opts.chapter}</div>` : ""}<div class="t">${title}</div>${sub ? `<div class="s">${sub}</div>` : ""}`;
	capEl!.toggleAttribute("data-card", !!opts.card);
	dimEl!.toggleAttribute("data-show", !!opts.card);
	capEl!.getBoundingClientRect(); // start the transition from the hidden state
	capEl!.setAttribute("data-show", "");
}

async function hideCaption(): Promise<void> {
	if (!capEl?.hasAttribute("data-show")) return;
	capEl.removeAttribute("data-show");
	dimEl!.removeAttribute("data-show");
	await sleep(220);
}

function progress(done: number, total: number): void {
	if (warmOnly) return;
	mount();
	barEl!.style.width = `${(done / total) * 100}%`;
	barEl!.style.opacity = done >= total ? "0" : "1";
}

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

// --- driving terminal windows ----------------------------------------------------

const K = { up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", enter: "\r", tab: "\t", esc: "\x1b" };

/** The last non-empty line of window n's text. */
const lastLine = (n: number) => KW.windows!.text(n).trimEnd().split("\n").pop() ?? "";

/** Resolves true once test passes (polled every 120 ms), or false after timeout ms. */
async function until(test: () => boolean | Promise<boolean>, timeout: number): Promise<boolean> {
	const end = performance.now() + timeout;
	while (performance.now() < end) {
		try { if (await test()) return true; } catch {}
		await wait(120);
	}
	return false;
}

/** Is a process whose command line matches `name` running in the guest (busybox pgrep -f)? */
async function running(name: string): Promise<boolean> {
	// "[h]top" matches htop but not this sh's own command line.
	const r = await vm().exec("/bin/sh", ["-c", 'pgrep -f "$1" >/dev/null', "sh", `[${name[0]}]${name.slice(1)}`]);
	return r.exitCode === 0;
}

/** Type text into window n a key at a time, a little unevenly, as a person would; "\n" is Enter. */
async function type(n: number, text: string, cps = 45): Promise<void> {
	for (const ch of text) {
		KW.windows!.send(n, ch === "\n" ? "\r" : ch);
		await wait(ch === "\n" ? 150 : (1000 / cps) * (0.55 + Math.random() * 0.9));
	}
}

/** Send keys (each an item: a character or an escape sequence) with a gap between them. */
async function keys(n: number, seq: string[], gap = 180): Promise<void> {
	for (const k of seq) {
		KW.windows!.send(n, k);
		await wait(gap);
	}
}
const times = (k: string, count: number) => Array<string>(count).fill(k);

/** Wait for `prompt` on window n's last line, then type each command, waiting for the prompt again after each. */
async function typeAt(n: number, prompt: RegExp, cmds: string[], after = 300): Promise<void> {
	for (const c of cmds) {
		await until(() => prompt.test(lastLine(n)), 8000);
		await type(n, `${c}\n`);
		await wait(after);
	}
	await until(() => prompt.test(lastLine(n)), 8000);
}

/**
 * Close terminal n without waiting on its programs. close() removes the terminal
 * at once, before it hangs up: this runs in the background while the next
 * step opens its own terminal, which may get the same number, so nothing here
 * may go by n after this first call. (Closing by n after the kill below
 * closed the next step's terminal: its shell "killed by signal 1".) A hangup
 * alone can leave a program running (Ubuntu's chroot in its own mount
 * namespace kept the terminal's connection open), so the terminal's whole
 * session, found by the shell's pid, then gets SIGHUP and SIGKILL. Neither
 * is waited on for more than 2 s.
 */
async function closeTerminal(n: number): Promise<void> {
	const pid = KW.windows!.list().find((w) => w.n === n)?.pid;
	const closed = KW.windows!.close(n);
	if (pid) {
		await Promise.race([
			vm().exec("/bin/sh", ["-c", 'pkill -HUP -s "$1"; sleep 0.3; pkill -KILL -s "$1"; true', "sh", String(pid)]).catch(() => {}),
			sleep(2000),
		]);
	}
	await Promise.race([closed, sleep(2000)]);
}

// --- driving the display's keyboard (evdev) --------------------------------------

/** Linux input key codes (linux/input-event-codes.h). */
const KEY = { enter: 28, space: 57, up: 103, left: 105, right: 106, down: 108 };

async function press(code: number, ms = 90): Promise<void> {
	const ev = evdev();
	ev?.key(code, true);
	try { await wait(ms); } finally { ev?.key(code, false); }
}

/** Glimmer: start a game, then wander about, blooming now and then, for ms. */
async function playGlimmer(ms: number): Promise<void> {
	await press(KEY.enter);
	const end = performance.now() + ms;
	const dirs = [KEY.up, KEY.down, KEY.left, KEY.right];
	while (performance.now() < end) {
		const a = dirs[Math.floor(Math.random() * 4)]!, b = Math.random() < 0.5 ? dirs[Math.floor(Math.random() * 4)]! : 0;
		const ev = evdev();
		ev?.key(a, true); if (b) ev?.key(b, true);
		try { await wait(250 + Math.random() * 450); } finally { ev?.key(a, false); if (b) ev?.key(b, false); }
		if (Math.random() < 0.3) await press(KEY.space);
	}
}

// --- steps -----------------------------------------------------------------------

interface DemoStep {
	/** A terminal app's id (apps/); also the step's id. */
	demo: string;
	title: string;
	sub?: string;
	/** Ready once a process matching this runs in the guest (pgrep -f). */
	proc?: string;
	/** Ready once this matches the window's text (history and screen). */
	ready?: RegExp;
	/** Ready once a program has the display open. */
	display?: boolean;
	/** Run once ready, with the window's number; takes the place of part of the hold. */
	play?: (n: number) => Promise<void>;
	/** How long to show it once ready and played (ms). Default 2.5 s. */
	hold?: number;
	/** How long to wait for ready before skipping it (ms). Default 30 s; ?showcase=warm waits 15 min. */
	timeout?: number;
}

interface FnStep {
	id: string;
	run: () => Promise<void>;
}

type Step = DemoStep | FnStep;
const stepId = (s: Step) => ("demo" in s ? s.demo : s.id);

let warmOnly = false;

/** Launch a demo (keeping the URL as it is), wait for it, play it, hold it, close it. */
async function demo(s: DemoStep, chapter: string): Promise<void> {
	const d = APPS.find((x) => x.id === s.demo && !isPageApp(x));
	if (!d) return log(`no demo ${s.demo}, skipped`);
	const why = unavailable(d);
	if (why) return log(`${s.demo}: ${why}, skipped`);
	await caption(s.title, s.sub, { chapter });
	const t0 = performance.now();
	let launched: Promise<void> = Promise.resolve();
	try {
		// With ports this resolves once the preview is open (or failed); else once the window runs.
		const timeout = warmOnly ? 900_000 : s.timeout ?? 30_000;
		await Promise.race([launched = launch(d), wait(timeout)]);
		const term = appTerminal(d);
		if (!term) return log(`${s.demo}: no window, skipped`);
		const ok = await until(async () =>
			(!s.ready || s.ready.test(KW.windows!.text(term.n))) &&
			(!s.display || ui$().get().display.attached) &&
			(!s.proc || await running(s.proc)), timeout);
		log(`${s.demo}: ${ok ? "ready" : "not ready, skipped (run ?showcase=warm first)"} after ${((performance.now() - t0) / 1000).toFixed(1)} s`);
		if (ok && !warmOnly) {
			await wait(s.display ? 300 : 100); // let it draw
			if (s.play) await s.play(term.n);
			await wait(s.hold ?? 2500);
		}
	} finally {
		evdev()?.releaseAll();
		await hideCaption();
		KW.preview?.close();
		// Closed in the background: the next step starts at once.
		const term = appTerminal(d);
		if (term) void closeTerminal(term.n);
		// Still launching (a download, say): close its terminal once it opens, so it never lingers.
		else void launched.then(() => { const t = appTerminal(d); if (t) void closeTerminal(t.n); });
	}
}

/** Open a shell window, type commands into it, close it. */
async function shell(title: string, sub: string, chapter: string, cmds: string[], hold = 800): Promise<void> {
	if (warmOnly) return;
	const w = await KW.windows!.open();
	try {
		await caption(title, sub, { chapter });
		await typeAt(w.n, SH, ["clear", ...cmds]);
		await wait(hold);
	} finally {
		await hideCaption();
		void closeTerminal(w.n);
	}
}

/** Alpine's prompt in this image is "~ ⇒ " (kw-prompt.sh); "#" and "$" for other shells. */
const SH = /[⇒#$] ?$/;
const SQLITE = /system\.db> ?$/;

const STEPS: Step[] = [
	{
		id: "intro", run: async () => {
			if (warmOnly) return;
			await caption("unkernel", "Linux in a browser tab.<br>Here's what it can run.", { card: true, logo: true });
			await wait(3000);
		},
	},
	{
		id: "shell", run: () => shell("A shell, <b>a real one</b>", "Alpine Linux, the same packages you'd run on a server", "", [
			"uname -a",
			"cat /etc/alpine-release; nproc; free -m | head -2",
			"ls -C /dev | head -8",
		]),
	},
	{
		id: "launcher", run: async () => {
			if (warmOnly) return;
			await caption(`${APPS.filter((d) => !d.hidden && !isPageApp(d)).length} apps, <b>ready to run</b>`);
			setLauncher(true);
			try { await wait(1600); } finally { setLauncher(false); await hideCaption(); }
		},
	},

	// The display first: a game on the framebuffer, keyboard and sound
	{
		demo: "glimmer", title: "It plays <b>games</b>, with sound", sub: "keyboard, mouse and audio, right in the page", display: true, hold: 800,
		play: () => playGlimmer(6000),
	},

	// Terminal apps
	{ demo: "htop", title: "<b>htop</b>", sub: "every process here runs inside this tab", proc: "htop", play: async (n) => { await wait(1000); await keys(n, ["t"]); await wait(1500); await keys(n, ["t"]); } },
	{ demo: "tmux", title: "<b>tmux</b>", sub: "a shell, htop and live stats, side by side", proc: "tmux attach", hold: 3500 },
	{
		demo: "nvim", title: "<b>Neovim</b>", sub: "tree-sitter, fuzzy finding and a terminal, no plugins", proc: "nvim", hold: 1750,
		play: async (n) => { await wait(800); await keys(n, [" ", "f"], 60); await wait(700); await type(n, "init", 14); await wait(600); await keys(n, [K.enter]); await wait(1500); await keys(n, times("\x04", 3), 500); },
	},
	{
		demo: "git", title: "<b>git</b> clone over the network", sub: "then a look through the history in tig", proc: "tig", hold: 1500,
		play: async (n) => { await keys(n, times("j", 6), 220); await keys(n, [K.enter]); await wait(800); await keys(n, times("j", 10), 90); },
	},

	// Databases
	{
		demo: "sqlite", title: "Run real <b>databases</b>", sub: "here SQLite, querying this Linux's own packages as a table", ready: SQLITE, hold: 2000,
		play: (n) => typeAt(n, SQLITE, ["SELECT name, version, size FROM packages ORDER BY size DESC LIMIT 8;"]),
	},

	// Sound to finish
	{
		demo: "radio", title: "Tune in to <b>internet radio</b>", sub: "mpg123 streaming SomaFM, network and sound from the guest", ready: /Station \(1-\d+/, hold: 4500,
		play: async (n) => { await type(n, "1\n"); await until(() => running("mpg123"), 30_000); },
	},
	{
		id: "outro", run: async () => {
			if (warmOnly) return;
			await caption("unkernel", `Try every demo yourself.<br>${esc(REPO.replace(/^https:\/\//, ""))}`, { card: true, logo: true });
			// stays up: the end of the video
		},
	},
];

let started = false;

/** Run the showcase (once per page). `spec` is ?showcase's value (see the top of this file). */
export async function runShowcase(spec = ""): Promise<void> {
	if (started) return;
	started = true;
	const words = spec.split(",").map((w) => w.trim()).filter((w) => w && w !== "1" && w !== "-");
	warmOnly = words.includes("warm");
	const only = words.filter((w) => w !== "warm");
	const unknown = only.filter((w) => !STEPS.some((s) => stepId(s) === w));
	if (unknown.length) KW.ui?.toast(`showcase: no step ${unknown.join(", ")}`);
	const steps = STEPS.filter((s) => (!only.length || only.includes(stepId(s))) && (!warmOnly || "demo" in s));
	const demos = steps.filter((s) => "demo" in s).length;

	KW.showcase = {
		skip: () => stepAbort.abort(),
		pause: () => { pause ??= new Promise((r) => { paused = r; }); },
		resume: () => { paused?.(); paused = pause = null; },
	};
	log(`${warmOnly ? "warming" : "starting"}: ${steps.map(stepId).join(", ")}`);
	if (warmOnly) KW.ui?.toast(`Showcase warm-up: ${demos} demos, one at a time`);
	await sleep(200); // let the boot summary settle on screen
	const t0 = performance.now();
	let k = 0;
	for (const [i, s] of steps.entries()) {
		if (pause) { log("paused"); await pause; }
		stepAbort = new AbortController();
		progress(i, steps.length);
		const chapter = "demo" in s ? `${String(++k).padStart(2, "0")} / ${demos}` : "";
		try {
			await ("demo" in s ? demo(s, chapter) : s.run());
		} catch (e) {
			if (!(e instanceof Skipped)) log(`${stepId(s)} failed: ${(e as Error)?.message ?? e}`);
			else log(`${stepId(s)} skipped`);
			evdev()?.releaseAll();
			await hideCaption();
		}
	}
	progress(steps.length, steps.length);
	const secs = ((performance.now() - t0) / 1000).toFixed(0);
	log(`done in ${secs} s`);
	if (warmOnly) KW.ui?.toast(`Showcase warm-up done in ${secs} s: reload with ?showcase`);
}
