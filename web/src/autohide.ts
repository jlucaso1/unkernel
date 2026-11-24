// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The console after boot: once the system runs, a console nobody uses
// minimizes itself into its Dock tile (the WM's usual minimize effect), so the
// desktop is what the page rests on. Once per load at most, and nothing says
// so: the tile brings it back as always. boot.ts drives it (autoHide below).
//
// The rule:
// - It never applies this load with ?autohide=0, with Settings > Desktop's
//   "Hide the console after boot" off (prefs.ts kw.hideConsole), in a browser
//   driven by automation (navigator.webdriver: the browser tests read and
//   drive the console), with ?showcase, ?verbose=1, safe mode (?root=initramfs)
//   or without a distro (?distro=none: the base shell is the whole page).
//   ?autohide=1 turns it on even so (but for the last four), to try it.
// - Any input on the page from the boot module's start until it hides (a key
//   other than a lone modifier, a press, the wheel, a paste, typed or composed
//   text), and any use of the console through KW.term (focus, paste, send: the
//   key bar, the touch controls), cancel it for this load: the user is there,
//   and the desktop must not change under them. That covers a press in the
//   console (title bar, tabs, body, edges: moving, resizing, selecting,
//   scrolling), the Dock, a menu, the launcher and the prefix.
// - The countdown starts when the system first runs (boot.ts markRunning: user
//   space printed), not on a resumed session (its windows come back as they
//   were), and runs only while the page is shown: AUTO_HIDE_MS of the
//   console being quiet (each output starts it again, so the boot's last
//   lines and the prompt are seen), at least RETURN_MS after the page is
//   shown again; a console still printing after GIVE_UP_MS stays.
// - It is cancelled, or at its end does nothing, unless the console's window
//   is the focused, top window, shown as it opened (not maximized, snapped
//   or minimized), with the console its only tab, no other terminal and no
//   other window shown, outside compact mode (phones and narrow viewports:
//   every window fills the screen there, so the console is the natural view),
//   with the system running (not held, suspending, halted or failed), no
//   launcher, question, paste box or prefix up, no display program, no
//   error reported about the machine (KW.report; the page's own failed
//   resources and script errors aside), and not in safe mode or the base
//   shell (boot.ts says so: needed()).
// - Hidden by it, the console comes back by itself (the WM's restore, and the
//   focus) when the page needs it: a notice printed on it (KW.term.notice:
//   the kernel halted, a failure), the machine stopping (halted, not
//   suspended; failed), safe mode or the base shell showing up after all.
//   Anything that selects it (the Dock tile, the prefix's 0, an app opening a
//   tab in its window) restores it as usual; once it is shown again by any
//   means, this module is done. A minimized window keeps its terminal's grid
//   and size (only its painting pauses: wterms.ts), so output and the API
//   (KW.screenText, KW.windows) work the same while it is hidden.
import { KW } from "./kw.ts";
import { store } from "./prefs.ts";
import { phase, ui$ } from "./store.ts";
import { CONSOLE_WIN, termTabs$ } from "./termtabs.ts";
import { wm, wm$ } from "./wm.ts";

/** How long the console stays up once the system runs, quiet and unused, while the page is shown (ms). */
export const AUTO_HIDE_MS = 3000;
/** The page shown again with less than this left: this much, so the console does not go the moment it is seen. */
const RETURN_MS = 2000;
/** A console still printing this long (shown time) after the system began to run stays. */
const GIVE_UP_MS = 30000;
/** KW.report kinds of the page's own (index.html: a resource that failed to load, a script error): not the machine's, so no reason to keep the console. */
const PAGE_ERRORS = ["resource", "exception", "rejection"];
/** prefs.ts: "0" turns it off (Settings > Desktop). */
const PREF = "hideConsole";

/** Settings > Desktop's "Hide the console after boot" (default on). */
export const hideConsolePref = (): boolean => store(PREF) !== "0";
/** Set it; off also ends a countdown under way. */
export function setHideConsolePref(on: boolean): void {
	store(PREF, on ? "1" : "0");
	if (!on && (step === "waiting" || step === "counting")) finish();
}

/** Why it never applies this load, or null (the first rule at the top of this file). */
function never(): string | null {
	const url = new URLSearchParams(location.search);
	const asked = url.get("autohide");
	if (asked === "0") return "?autohide=0";
	if (asked !== "1") {
		if (!hideConsolePref()) return "off in Settings";
		if (navigator.webdriver) return "automation";
	}
	const showcase = url.get("showcase");
	if (showcase !== null && showcase !== "0") return "?showcase";
	const cfg = KW.config;
	if (cfg.verbose) return "?verbose=1";
	if (cfg.root === "initramfs") return "safe mode";
	if (!cfg.distro) return "the base shell";
	return null;
}

/** Why the console must stay now, or null (the third rule at the top of this file). */
function blocker(): string | null {
	const s = ui$().get();
	if (phase(s) !== "running") return "not running";
	if (s.launcher || s.ask || s.pasteOpen || s.prefix) return "busy";
	if (s.safeNote) return "safe mode";
	if (s.errors.some((e) => !PAGE_ERRORS.includes(e.kind))) return "an error";
	if (s.display.attached) return "a display program";
	const w = wm$.get();
	if (w.compact) return "compact";
	const con = w.windows.find((x) => x.id === CONSOLE_WIN);
	if (!con || con.minimized || con.maximized || con.snap || w.focused !== CONSOLE_WIN || w.order[w.order.length - 1] !== CONSOLE_WIN) return "arranged";
	if (w.windows.some((x) => x.id !== CONSOLE_WIN && !x.minimized)) return "other windows";
	const t = termTabs$.get();
	if (t.terms.length || t.windows.length !== 1 || t.windows[0]!.tabs.length !== 1) return "terminals";
	return null;
}

/**
 * off: not started, or never this load; waiting: the boot runs, input
 * watched; counting: the system runs, the countdown with it; hidden: it
 * minimized the console and brings it back when needed; done.
 */
type Step = "off" | "waiting" | "counting" | "hidden" | "done";
let step: Step = "off";
const INPUT = ["keydown", "pointerdown", "wheel", "paste", "beforeinput", "compositionstart"] as const;
let unsubscribe: Array<() => void> = [];

// The countdown, in time the page was shown: shownBase before the current stretch, which began at visibleSince.
let shownBase = 0, visibleSince: number | null = null, due = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
const shownMs = () => shownBase + (visibleSince === null ? 0 : performance.now() - visibleSince);
function plan() {
	clearTimeout(timer);
	timer = visibleSince === null ? undefined : setTimeout(fire, Math.max(0, due - shownMs()));
}

function onInput(e: Event) {
	if (!e.isTrusted) return;
	if (e instanceof KeyboardEvent && /^(Shift|Control|Alt|Meta|AltGraph|CapsLock|Fn|OS)$/.test(e.key)) return;
	finish();
}
function onVisibility() {
	if (step !== "counting") return;
	const shown = document.visibilityState === "visible";
	if (shown && visibleSince === null) {
		visibleSince = performance.now();
		due = Math.max(due, shownMs() + RETURN_MS);
	} else if (!shown && visibleSince !== null) {
		shownBase = shownMs();
		visibleSince = null;
	}
	plan();
}
function onChange() {
	if (step === "counting") {
		if (blocker()) finish();
	} else if (step === "hidden") {
		const con = wm.get(CONSOLE_WIN);
		if (!con || !con.minimized) { finish(); return; } // shown again, however
		const p = phase(ui$().get());
		if (p === "halted" || p === "error") restore();
	}
}

function fire() {
	timer = undefined;
	if (step !== "counting") return;
	if (shownMs() < due - 1) { plan(); return; } // output moved it on
	if (blocker()) { finish(); return; }
	step = "hidden";
	unlisten();
	wm.minimize(CONSOLE_WIN); // the WM's minimize effect into its Dock tile (wmfx.ts); the stores stay subscribed (onChange)
}

function unlisten() {
	for (const t of INPUT) removeEventListener(t, onInput, true);
	document.removeEventListener("visibilitychange", onVisibility);
	clearTimeout(timer);
	timer = undefined;
}
/** Nothing more this load. */
function finish() {
	if (step === "off" || step === "done") return;
	step = "done";
	unlisten();
	for (const u of unsubscribe) u();
	unsubscribe = [];
}
/** Hidden by it: show it again (raised, focused). */
function restore() {
	finish();
	wm.focus(CONSOLE_WIN);
}

/** boot.ts's side (see the top of this file). */
export const autoHide = {
	/** The boot module starts: watch the input from now on, unless it never applies this load. */
	init(): void {
		if (step !== "off" || never()) return;
		step = "waiting";
		for (const t of INPUT) addEventListener(t, onInput, { capture: true, passive: true });
	},
	/** The system runs (a fresh boot's user space printed, not a resume): the countdown starts. */
	arm(): void {
		if (step !== "waiting") return;
		step = "counting";
		unsubscribe = [ui$().subscribe(onChange), wm$.subscribe(onChange), termTabs$.subscribe(onChange)];
		if (blocker()) { finish(); return; }
		document.addEventListener("visibilitychange", onVisibility);
		shownBase = 0;
		visibleSince = document.visibilityState === "visible" ? performance.now() : null;
		due = AUTO_HIDE_MS;
		plan();
	},
	/** The console printed: the countdown starts again (or gives up on a console that keeps printing). */
	output(): void {
		if (step !== "counting") return;
		const t = shownMs();
		if (t > GIVE_UP_MS) finish();
		else due = t + AUTO_HIDE_MS; // fire() plans again from it
	},
	/** The console was used through the page (KW.term): it stays. */
	used(): void {
		if (step === "waiting" || step === "counting") finish();
	},
	/** The console says something the user must see (a notice, safe mode, the base shell): it stays, or comes back. */
	needed(): void {
		if (step === "hidden") restore();
		else finish();
	},
};
