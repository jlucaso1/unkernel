// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Keyboard shortcuts: the key table (COMMANDS, each with a stable id and a
// group), its dispatch (installShortcuts(), runKey()) and what the chrome
// needs to show the keys (keyFor(): a command's key, by id, for the hints on
// the Dock, the top bar, the tabs and the menus, KeyHint.tsx;
// prefixBindings(): every bound key, for the shortcuts HUD, KeysHud.tsx;
// Settings' Keyboard section lists the table). What the terminal commands do
// is terminals.ts's.
// - the prefix: Ctrl-A as in GNU screen, then a key (COMMANDS). Ctrl-A
//   twice sends one Ctrl-A on to the guest (readline's start of line, or a
//   screen or tmux in the guest). On Apple devices ⌘A is the prefix too
//   (in place of the browser's select all), and ⌘ may stay held for the
//   command key: ⌘A ⌘K is ⌘A k. While it is armed, the Dock and the top
//   bar show each item's key on it, and the HUD (KeysHud.tsx) draws the
//   keyboard with what each key does (a click on a key runs it: runKey());
//   the key bar on phones has a key that arms it (Keys.tsx, ui.ts pressKey);
// - digits are terminals, as windows are in screen and tmux: Ctrl-A 0 or
//   Ctrl-Shift-0 is the console, terminal 0; 1 to 9 (after Ctrl-A, and with
//   Ctrl-Shift) are the other terminals (wterms.ts), each a tab of a
//   Terminal window (termtabs.ts): a digit shows its tab and focuses its
//   window. Ctrl-A n or c (as in tmux and screen) opens a new terminal as a
//   tab of the Terminal window that last had the focus, Ctrl-A N one in a
//   new Terminal window, and Ctrl-A x closes the current one; Ctrl-A y
//   copies diagnostics. Terminals send nothing for Ctrl-Shift-digit, and
//   browsers do not use it;
// - Ctrl-A o opens the app launcher (launcher.ts), or closes it; so do
//   ⌘K on Apple devices (free there: the terminal sends nothing for ⌘) and
//   Ctrl-Shift-O everywhere (Ctrl-K is readline's kill-line, so not that);
// - Ctrl-A p opens the guest preview's Browser window (preview.ts), brings
//   it to the front, or minimizes it when it is in front;
//   Ctrl-A d brings the guest's Display window to the front (display.ts
//   toggleDisplay), or minimizes it when it is in front;
//   Ctrl-A w brings the top Wayland app's window to the front (wayland.ts),
//   or, when one has the focus, the window under the Wayland windows
//   (winmenu.tsx toggleWayland);
//   Ctrl-A z suspends at once (session.ts: Resume, or the next load, resumes it);
// - Ctrl-A and an arrow key snaps the focused window (wm.ts snapKey,
//   wmsnap.ts nextTile): left and right to that half, up and down between
//   a half and its quarters, up maximizes, down restores (not in compact
//   mode). The table names them by their arrows (ARROW_KEYS).
// Ctrl-A s, g, i, l, e, ? and , open the system apps (sysapps.ts: System and
// Settings) on a section; in their windows Esc closes the window (DIALOG_KEYS).
//
// The listener is on window in the capture phase and is added before
// display.ts adds its own, so the shortcuts work while a program holds the
// evdev keyboard (X, games) too.
import { openAbout } from "./components/About.tsx";
import { toggleDisplay } from "./display.ts";
import { KW } from "./kw.ts";
import { toggleLauncher } from "./launcher.ts";
import { togglePreview } from "./preview.ts";
import { appOf, closeApp, openSection, openSettings } from "./sysapps.ts";
import { ui$ } from "./store.ts";
import { closeTerminal, newTerminal, newTerminalWindow, selectTerminal } from "./terminals.ts";
import { waylandFocused } from "./wayland.ts";
import { toggleWayland } from "./winmenu.tsx";
import { wm } from "./wm.ts";

/** macOS, iOS, iPadOS: ⌘A is the prefix too. */
export const APPLE = /mac|iphone|ipad|ipod|ios/i.test((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || navigator.userAgent);
export const PREFIX = "Ctrl-A";
/** The prefix as the armed indicator shows it. */
export const PREFIX_SHORT = "^A";
const isCtrlA = (e: KeyboardEvent) => e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.code === "KeyA";
const isCmdA = (e: KeyboardEvent) => APPLE && e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.code === "KeyA";
const isPrefix = (e: KeyboardEvent) => isCtrlA(e) || isCmdA(e);
export const CHORD = "Ctrl-Shift";

/** A command's stable name: the chrome finds its key by it (keyFor()). */
export type CommandId =
	| "console" | "new-tab" | "new-window" | "close-tab"
	| "system" | "settings" | "storage" | "env" | "log" | "errors" | "keys"
	| "display" | "wayland" | "launcher" | "preview" | "copy" | "reboot" | "suspend" | "about"
	| "snap-left" | "snap-right" | "snap-up" | "snap-down";

/**
 * What a command acts on, for the shortcuts HUD's tints (KeysHud.tsx): the
 * terminals, the windows (snap, bring to the front), the apps and the
 * system's views, the machine itself (suspend, reboot).
 */
export type CommandGroup = "term" | "window" | "app" | "machine";

export interface Command {
	id: CommandId;
	group: CommandGroup;
	/** After the prefix; the first is the one the chrome shows. */
	keys: string[];
	/** KeyboardEvent.code of the Ctrl-Shift chord, if it has one. */
	chord?: string;
	/** KeyboardEvent.code that runs it with ⌘ alone on Apple devices (while the prefix is not armed). */
	meta?: string;
	label: string;
	/** Its word on its key in the shortcuts HUD while the prefix is armed (KeysHud.tsx; a short one: it is drawn on a key cap). */
	brief: string;
	/** Left off the HUD (none is, so far); its key still runs it. */
	hidden?: boolean;
	run: () => void;
}

/**
 * After the prefix, and the chords. The runs call through arrows: the
 * modules they call may import this one (KeyHint.tsx), so their bindings
 * are read when a key is pressed, not when this table is made.
 */
export const COMMANDS: Command[] = [
	{ id: "console", group: "term", keys: ["0", "t"], chord: "Digit0", label: "Terminal 0: the console", brief: "console", run: () => selectTerminal(0) },
	{ id: "new-tab", group: "term", keys: ["n", "c"], label: "New terminal tab (1 to 9: its own shell) in the current Terminal window", brief: "new tab", run: () => newTerminal() },
	{ id: "new-window", group: "term", keys: ["N"], label: "New Terminal window, with a new terminal in it", brief: "new window", run: () => newTerminalWindow() },
	{ id: "close-tab", group: "term", keys: ["x"], label: "Close the current terminal tab (asks first)", brief: "close", run: () => void closeTerminal() },
	{ id: "system", group: "app", keys: ["s"], label: "System: the state, the boot, the environment", brief: "system", run: () => openSection("status") },
	{ id: "settings", group: "app", keys: [","], label: "Settings: the machine, distro, storage, network, display, session", brief: "settings", run: () => openSettings() },
	{ id: "storage", group: "app", keys: ["g"], label: "Settings, Storage: the data disk", brief: "disk", run: () => openSection("storage") },
	{ id: "env", group: "app", keys: ["i"], label: "System, Environment: browser, memory, storage, JIT", brief: "memory", run: () => openSection("env") },
	{ id: "log", group: "app", keys: ["l"], label: "System, Kernel log", brief: "log", run: () => openSection("log") },
	{ id: "errors", group: "app", keys: ["e"], label: "System, Errors", brief: "errors", run: () => openSection("errors") },
	{ id: "keys", group: "app", keys: ["?"], chord: "Slash", label: "Settings, Keyboard: this list", brief: "keys", run: () => openSection("keys") },
	{ id: "display", group: "window", keys: ["d"], label: "The display: bring its window to the front, or minimize it", brief: "display", run: () => {
		if (ui$().get().display.attached) toggleDisplay();
		else KW.ui!.toast("No program has the display open");
	} },
	{ id: "wayland", group: "window", keys: ["w"], label: "Switch between the Wayland apps' windows and the other windows", brief: "wayland", run: () => {
		if (ui$().get().wayland.attached || waylandFocused()) toggleWayland();
		else KW.ui!.toast("No Wayland app runs: wland CMD in a terminal starts one (the launcher's foot)");
	} },
	{ id: "launcher", group: "app", keys: ["o"], chord: "KeyO", meta: "KeyK", label: "Apps: the launcher (again closes it)", brief: "apps", run: () => toggleLauncher() },
	{ id: "preview", group: "app", keys: ["p"], label: "Browser: a web server in the guest (the last port, or 8000; in front, minimizes it)", brief: "browser", run: () => togglePreview() },
	{ id: "copy", group: "app", keys: ["y"], label: "Copy diagnostics", brief: "copy", run: () => KW.ui!.copyDiagnostics() },
	{ id: "reboot", group: "machine", keys: ["r"], label: "Reboot (asks first)", brief: "reboot", run: () => KW.ui!.confirmReboot() },
	{ id: "suspend", group: "machine", keys: ["z"], label: "Suspend: save the system in this browser and stop (Resume, or the next load, resumes it)", brief: "suspend", run: () => KW.ui!.suspend() },
	{ id: "about", group: "app", keys: ["a"], label: "About: credits and the build (in Settings)", brief: "about", run: () => openAbout() },
	{ id: "snap-left", group: "window", keys: ["←"], label: "Snap the window to the left half (from a right quarter, the left one)", brief: "snap", run: () => wm.snapKey("left") },
	{ id: "snap-right", group: "window", keys: ["→"], label: "Snap the window to the right half (from a left quarter, the right one)", brief: "snap", run: () => wm.snapKey("right") },
	{ id: "snap-up", group: "window", keys: ["↑"], label: "Maximize the window (a half: its top quarter; a bottom quarter: its half)", brief: "snap", run: () => wm.snapKey("up") },
	{ id: "snap-down", group: "window", keys: ["↓"], label: "Restore the window's own size (a half: its bottom quarter; a top quarter: its half)", brief: "snap", run: () => wm.snapKey("down") },
];

const BY_ID = new Map(COMMANDS.map((c) => [c.id, c]));
/** The command with this id. */
export const command = (id: CommandId): Command => BY_ID.get(id)!;
/** A command's key after the prefix, as the chrome shows it (its first). */
export const keyFor = (id: CommandId): string => command(id).keys[0]!;
/** Terminal n's key after the prefix: its digit (1 to 9 are dispatched apart from the table; 0 is the console's command). */
export const terminalKey = (n: number): string => (n === 0 ? keyFor("console") : String(n));
/** The command's keys without the prefix, as shown: ⌘ and a key on Apple devices, the Ctrl-Shift chord. */
export const directKeys = (c: Command): string[] =>
	[APPLE && c.meta ? `⌘${codeLabel(c.meta)}` : "", c.chord ? `${CHORD}-${codeLabel(c.chord)}` : ""].filter(Boolean);

/**
 * A key bound after the prefix: a command's (`alias`: not its first key),
 * or a digit 1 to 9, terminal `term`.
 */
export type Binding =
	| { key: string; group: CommandGroup; cmd: Command; alias: boolean; term?: undefined }
	| { key: string; group: "term"; term: number; cmd?: undefined; alias?: undefined };

/**
 * Every key bound after the prefix, as the dispatch reads them (runKey()):
 * the table's keys in its order (a key a command before it took is left
 * out, as the dispatch never reaches it), then the digits 1 to 9 that no
 * command takes. Hidden commands are left out, their keys still taken.
 * The shortcuts HUD draws these (components/KeysHud.tsx).
 */
export function prefixBindings(): Binding[] {
	const out: Binding[] = [], taken = new Set<string>();
	for (const c of COMMANDS) {
		c.keys.forEach((key, i) => {
			if (taken.has(key)) return;
			taken.add(key);
			if (!c.hidden) out.push({ key, group: c.group, cmd: c, alias: i > 0 });
		});
	}
	for (let n = 1; n <= 9; n++) if (!taken.has(String(n))) out.push({ key: String(n), group: "term", term: n });
	return out;
}

/**
 * Disarm the prefix and run what `key` does after it (a COMMANDS key, as
 * the table names it: ← for ArrowLeft; a digit 1 to 9: that terminal);
 * false when nothing is bound to it. The one place the prefix's commands
 * run: the key after the prefix (installShortcuts()) and a click on a key
 * of the shortcuts HUD (KeysHud.tsx) both come here.
 */
export function runKey(key: string): boolean {
	KW.ui!.setPrefix(false);
	const cmd = COMMANDS.find((c) => c.keys.includes(key));
	if (cmd) cmd.run();
	else if (/^[1-9]$/.test(key)) selectTerminal(Number(key));
	else return false;
	return true;
}

/** In the system apps' windows (Settings, System), without the prefix. */
export const DIALOG_KEYS: Array<[string, string]> = [
	["↑ ↓  ← →", "Previous, next section (on the section list)"],
	["Home  End", "First, last section"],
	["Tab  ⇧Tab", "Move between the list and the controls"],
	["Esc", "Close the window (focus goes back where it was)"],
];

/** The arrow keys as COMMANDS names them (KeyboardEvent.key to its arrow). */
const ARROW_KEYS: Record<string, string> = { ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓" };
/** A key code as the Keys tab shows it: KeyO is O, Digit0 is 0, Slash is /. */
export const codeLabel = (code: string) => code === "Slash" ? "/" : code.replace(/^(Key|Digit)/, "");
const swallow = (e: KeyboardEvent) => { e.preventDefault(); e.stopImmediatePropagation(); };
const plain = (e: KeyboardEvent) => !e.ctrlKey && !e.altKey && !e.metaKey;

export function installShortcuts(): () => void {
	const ui = KW.ui!, $ = ui$();

	function onKeyDown(e: KeyboardEvent) {
		const s = $.get();
		if (s.ask) return; // the confirm dialog (a modal <dialog>) takes its keys itself
		if (s.prefix) {
			if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
			ui.setPrefix(false);
			if (isCtrlA(e)) return; // send-prefix: this one goes through
			if (isCmdA(e)) { swallow(e); return; } // ⌘A never reaches the guest: it only disarms
			swallow(e);
			if (!runKey(ARROW_KEYS[e.key] ?? e.key) && e.key !== "Escape") ui.toast(`${PREFIX} ${e.key}: not a shortcut (${PREFIX} ${keyFor("keys")} lists them)`);
			return;
		}
		if (APPLE && e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
			const cmd = COMMANDS.find((c) => c.meta === e.code);
			if (cmd) { swallow(e); if (!e.repeat) cmd.run(); return; }
		}
		if (isPrefix(e) && !e.repeat) {
			swallow(e);
			ui.setPrefix(true);
			return;
		}
		if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey) {
			const cmd = COMMANDS.find((c) => c.chord === e.code);
			if (cmd) { swallow(e); if (!e.repeat) cmd.run(); return; }
			const digit = /^Digit([1-9])$/.exec(e.code);
			if (digit) { swallow(e); if (!e.repeat) selectTerminal(Number(digit[1])); return; }
		}
		if (s.pasteOpen) {
			if (e.key === "Escape") { swallow(e); ui.closePaste(); }
			return;
		}
		// In a system app's window (not a terminal's): Esc closes it. Other keys work as usual there
		// (display.ts and boot.ts leave keys typed in .kw-app to it, not to the guest: focus.ts ownsKeys).
		const app = appOf(e.target as Element | null);
		// Not during a window move: its Esc puts the window back (wm.ts).
		if (app && e.key === "Escape" && plain(e) && !e.shiftKey && !(e.target as Element).closest("select") && !document.documentElement.classList.contains("wm-dragging")) { swallow(e); closeApp(app); }
	}
	// Key-ups pass: a guest that saw Ctrl go down must see it come up.
	window.addEventListener("keydown", onKeyDown, true);
	return () => window.removeEventListener("keydown", onKeyDown, true);
}
