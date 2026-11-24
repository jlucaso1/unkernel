// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The terminals' state, and the Terminal windows and their tabs, as plain
// state (its own store, read with useTermTabs()). The terminals themselves,
// numbered 0 to 9 (0 the console on hvc0, 1 to 9 kwtty sessions), are
// wterms.ts's, which publishes what the page shows of them here (setTerms():
// number, name, state, why it ended, the foreground program) and which one
// is current (setCurrent()); the tab strips, the Dock, the launcher and the
// top bar read them from here only. The rest is where each one is shown:
// - A Terminal window is a desktop window (wm.ts, appId "terminal", id
//   terminal-K, its Dock tile #dock-terminal-K) holding an ordered set of
//   tabs, one per terminal, and one active tab. A terminal is a tab of
//   exactly one window. The console's window is CONSOLE_WIN, opened by
//   components/Workspace.tsx when it loads, and it never goes: the console
//   tab cannot be closed or moved, and the window has no close button (it
//   minimizes). Closing any other window closes its tabs (the close action,
//   terminals.ts closeTerminalWindow); it goes once its last tab does.
// - The window's content is a box (.term-stack) holding the terminal elements
//   of its tabs (#term, .term-pty) stacked in it (style.css), so they all
//   share its size and refit together; only the active one is visible, the
//   others are hidden with visibility and inert (they keep their grid and
//   their size). Its title bar shows the tab strip (wm.ts titleContent: the
//   strip factory given to configureTerminals(), components/TerminalTabs.tsx)
//   and its title is the active tab's ("Console" for the console). The
//   chrome shows it as Terminal (TERMINAL, its wm.ts meta), or, while its
//   only tab is a terminal app's terminal (named after the app: launcher.ts),
//   as that app (the app's AppMeta, from configureTerminals()'s appMeta).
// - Shown: a terminal is shown while it is its window's active tab and the WM
//   shows that window; hooks.shown(n, visible) says when that changes, so
//   wterms.ts pauses its painting. hooks.activated(n): terminal n became the
//   one with the focus (its window got the WM's focus, or the focused window
//   switched to its tab); wterms.ts makes it the current one.
// - Tab labels (title, state, note): tabLabel(), from the terminals' state
//   (the foreground program of a tty N one, else its name; the console's is
//   fixed).
// - targetWindow(): where a new tab goes by default, the Terminal window that
//   last had the WM's focus (else the console's).
import type { ReactNode } from "react";
import { useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import type { AppMeta } from "./apps/types.ts";
import { PromptIcon } from "./components/icons.tsx";
import { inTerminal } from "./focus.ts";
import { createStore } from "./store.ts";
import { wm, wm$ } from "./wm.ts";

/** The Terminal windows' descriptor (wm.ts meta), and the Terminal page app's (apps/system/terminal.ts). */
export const TERMINAL: AppMeta = { id: "terminal", title: "Terminal", glyph: PromptIcon };

/** A Terminal window: its WM id, its tabs (terminal numbers, in strip order) and the one shown. */
export interface TermWindow { id: string; tabs: number[]; active: number }
/** Terminals 1 to 9 (the digits; 0 is the console). */
export const MAX_TERMINALS = 9;

/**
 * opening: waiting for the guest's server; open: the shell runs; ended: the
 * session failed or was lost, and the terminal shows why until it is closed.
 */
export type TermState = "opening" | "open" | "ended";
/**
 * A terminal besides the console (terminal 0, hvc0): a kwtty session over
 * vsock with its own pty and shell (wterms.ts). name: "tty N", or the app
 * it runs (launcher.ts); note: why it ended; fg: the program in the
 * foreground of a tty N one, when it is not the shell, else "".
 */
export interface Term { n: number; name: string; state: TermState; note: string; fg: string }
/** What a tab shows: its title (con, tty N, the foreground program, an app's name) and state; note: why it ended. */
export interface TabLabel { title: string; state: TermState; note: string }

export interface TermTabsState {
	/** In the order they opened; the console's first. */
	windows: TermWindow[];
	/** The Terminal window that last had the WM's focus. */
	last: string;
	/** The terminals besides the console, by number (wterms.ts). */
	terms: Term[];
	/**
	 * The current terminal (0: the console): the one that last had the focus,
	 * however it got it (the Dock, a tab, a click on its window, another tab
	 * or window closing); the key bar, paste, KW.term and the prefix's x act on it.
	 */
	current: number;
}

/** The console's Terminal window. */
export const CONSOLE_WIN = "terminal-1";
const CONSOLE_LABEL: TabLabel = { title: "con", state: "open", note: "" };

const $ = createStore<TermTabsState>({ windows: [], last: CONSOLE_WIN, terms: [], current: 0 });
export const termTabs$ = $;

/** A field of the tabs' state; the component re-renders when it changes. */
export function useTermTabs<U>(select: (s: TermTabsState) => U): U {
	return useSyncExternalStore($.subscribe, () => select($.get()));
}

/** The Terminal window with this WM id. */
export const termWindow = (id: string | null | undefined): TermWindow | undefined => (id ? $.get().windows.find((w) => w.id === id) : undefined);
/** The Terminal window terminal n is a tab of. */
export const windowOf = (n: number): TermWindow | undefined => $.get().windows.find((w) => w.tabs.includes(n));
/** Its window's place among the Terminal windows, from 1 (the console's); 0: none. */
export const windowIndex = (n: number): number => $.get().windows.findIndex((w) => w.tabs.includes(n)) + 1;
/** Where a new tab goes: the Terminal window that last had the WM's focus, else the console's. */
export const targetWindow = (): TermWindow | undefined => termWindow($.get().last) ?? $.get().windows[0];

/** Terminal n besides the console, if it is open. */
export const findTerm = (n: number, terms = $.get().terms): Term | undefined => terms.find((t) => t.n === n);
/** Terminal n's tab label (see the top of this file); `terms`: a render's own copy of the state's. */
export function tabLabel(n: number, terms = $.get().terms): TabLabel {
	if (n === 0) return CONSOLE_LABEL;
	const t = findTerm(n, terms);
	return t ? { title: t.fg || t.name, state: t.state, note: t.note } : { title: `tty ${n}`, state: "opening", note: "" };
}
/** The current terminal (see TermTabsState.current). */
export const currentTerminal = (): number => $.get().current;

/** el is in a terminal (its wterm, or its hidden input: focus.ts inTerminal()): never anything of wland's (#wl-desktop, a Wayland window). */
export function isTerminalEl(el: Element | null | undefined): boolean {
	return inTerminal(el) && !el!.closest('#wl-desktop, [data-app="wayland"]');
}
/** A terminal has the DOM focus. */
export const terminalHasFocus = (): boolean => isTerminalEl(document.activeElement);

// ---- what the page plugs in ---------------------------------------------------
interface Config {
	/** The tab strip for a window's title bar. */
	strip?: (id: string) => ReactNode;
	/** A window's close button (WM onClose; the console's has none): close its tabs, asking first. */
	close?: (id: string) => void;
	/** The descriptor of the terminal app a terminal is named after (appwindows.ts terminalAppMeta), if any. */
	appMeta?: (name: string) => AppMeta | undefined;
}
let cfg: Config = {};
/** components/Workspace.tsx, before it opens the console's window. */
export function configureTerminals(c: Config): void { cfg = c; }

interface Hooks {
	activated?(n: number): void;
	shown?(n: number, visible: boolean): void;
}
let hooks: Hooks = {};
/** wterms.ts, once the terminals exist. */
export function setTermHooks(h: Hooks): void { hooks = h; }

// ---- windows and tabs ---------------------------------------------------------
/** The terminal elements and the windows' boxes. */
const els = new Map<number, HTMLElement>();
const boxes = new Map<string, HTMLElement>();

function setWindow(id: string, patch: Partial<TermWindow>): void {
	$.set((s) => ({ windows: s.windows.map((w) => (w.id === id ? { ...w, ...patch } : w)) }));
}

const windowTitle = (tw: TermWindow): string => (tw.active === 0 ? "Console" : tabLabel(tw.active).title);
/** What the chrome shows of it: the terminal app its only tab runs, else Terminal. */
function windowMeta(tw: TermWindow): AppMeta {
	const name = tw.tabs.length === 1 ? findTerm(tw.tabs[0]!)?.name : undefined;
	return (name && cfg.appMeta?.(name)) || TERMINAL;
}
function windowStatus(tw: TermWindow): "busy" | "error" | undefined {
	if (tw.tabs.some((n) => tabLabel(n).state === "ended")) return "error";
	return tabLabel(tw.active).state === "opening" ? "busy" : undefined;
}

/** The window got the WM's focus: it is the last one, and its active tab has the focus. */
function focused(id: string): void {
	const tw = termWindow(id);
	if (!tw) return;
	if ($.get().last !== id) $.set({ last: id });
	hooks.activated?.(tw.active);
}

/** The lowest free terminal-K (the console's is 1). */
function freeId(): string {
	for (let k = 2; ; k++) if (!termWindow(`terminal-${k}`)) return `terminal-${k}`;
}

/** Open a Terminal window holding terminal `first` (its element `el`), behind the others unless `focus`. */
function openWindow(id: string, first: number, el: HTMLElement, geom: { w?: number; h?: number } = {}, focus = false): void {
	const box = document.createElement("div");
	box.className = "term-stack";
	box.appendChild(el);
	boxes.set(id, box);
	$.set((s) => ({ windows: [...s.windows, { id, tabs: [first], active: first }] }));
	const tw = termWindow(id)!;
	const spec = {
		id, appId: TERMINAL.id, meta: windowMeta(tw), title: windowTitle(tw), dockId: `dock-${id}`, content: box, ...geom,
		titleContent: cfg.strip?.(id), status: windowStatus(tw),
		closable: id !== CONSOLE_WIN, // the console's: minimize only
		onFocus: () => focused(id),
		onClose: () => {
			cfg.close?.(id);
			return false; // the close action removes it, its tabs gone
		},
	};
	// Mounted at once (flushSync), so the terminal measures its box in place; where React cannot render now, it mounts on the next render.
	try { flushSync(() => wm.open(spec, { focus })); } catch { wm.open(spec, { focus }); }
	sync();
}

/** The console's window, with `el` (#term) as its tab 0 (components/Workspace.tsx; once). */
export function openConsoleWindow(el: HTMLElement, geom: { w: number; h: number }): void {
	if (termWindow(CONSOLE_WIN)) return;
	els.set(0, el);
	el.classList.add("term-tab");
	openWindow(CONSOLE_WIN, 0, el, geom, true);
}

/**
 * Add terminal n (its element el) as a tab: of window `where` (an id), of a
 * new window ("new"), or of targetWindow(). It is not shown unless it is
 * the first tab of a new window (showTab(), selectTab()). Returns the
 * window's id. el is in the window's box when this returns.
 */
export function addTab(n: number, el: HTMLElement, where?: string): string {
	els.set(n, el);
	el.classList.add("term-tab");
	const tw = where === "new" ? undefined : where ? termWindow(where) ?? targetWindow() : targetWindow();
	if (!tw) {
		const id = freeId();
		openWindow(id, n, el);
		return id;
	}
	boxes.get(tw.id)!.appendChild(el);
	setWindow(tw.id, { tabs: [...tw.tabs.filter((t) => t !== n), n] });
	sync();
	return tw.id;
}

/** Terminal n is gone: its tab goes (the next one is shown), and its window with it when that was the last. */
export function removeTab(n: number): void {
	const tw = windowOf(n);
	els.delete(n);
	if (!tw) return;
	const i = tw.tabs.indexOf(n), tabs = tw.tabs.filter((t) => t !== n);
	if (!tabs.length) {
		boxes.delete(tw.id);
		$.set((s) => ({ windows: s.windows.filter((w) => w.id !== tw.id), last: s.last === tw.id ? CONSOLE_WIN : s.last }));
		wm.remove(tw.id); // the WM focuses the next one down
		sync();
		return;
	}
	const active = tw.active === n ? tabs[Math.min(i, tabs.length - 1)]! : tw.active;
	setWindow(tw.id, { tabs, active });
	sync();
	if (tw.active === n && wm.focused() === tw.id) hooks.activated?.(active);
}

/** Show terminal n in its window (the window is not raised); in the focused window it gets the focus. */
export function showTab(n: number): boolean {
	const tw = windowOf(n);
	if (!tw) return false;
	if (tw.active !== n) {
		setWindow(tw.id, { active: n });
		sync();
	}
	if (wm.focused() === tw.id) hooks.activated?.(n);
	return true;
}

/** Show terminal n and focus, raise and restore its window. */
export function selectTab(n: number): boolean {
	const tw = windowOf(n);
	if (!tw || !showTab(n)) return false;
	wm.focus(tw.id);
	return true;
}

/** The terminals besides the console (wterms.ts, on each change); the tabs' titles and states follow. */
export function setTerms(terms: Term[]): void {
	$.set({ terms });
}

/** Terminal n is the current one now (wterms.ts). */
export function setCurrent(n: number): void {
	if ($.get().current !== n) $.set({ current: n });
}

/** Terminal n is shown (its window's active tab, and the WM shows the window). */
export const isTabShown = (n: number): boolean => shownMap.get(n) ?? false;

// ---- keeping the DOM, the shown state and the WM's titles in step -----------------
const shownMap = new Map<number, boolean>();
function sync(): void {
	const { windows } = $.get();
	for (const tw of windows) {
		const windowShown = wm.isVisible(tw.id);
		for (const n of tw.tabs) {
			const el = els.get(n), on = n === tw.active;
			if (el && el.inert === on) {
				el.inert = !on;
				el.classList.toggle("term-hidden", !on);
			}
			const v = on && windowShown;
			if (shownMap.get(n) !== v) {
				shownMap.set(n, v);
				hooks.shown?.(n, v);
			}
		}
	}
	for (const n of [...shownMap.keys()]) if (!windows.some((w) => w.tabs.includes(n))) shownMap.delete(n);
}
wm$.subscribe(sync);

$.subscribe(() => {
	for (const tw of $.get().windows) {
		const cur = wm.get(tw.id);
		if (!cur) continue;
		const title = windowTitle(tw), status = windowStatus(tw), meta = windowMeta(tw);
		if (cur.title !== title || cur.status !== status || cur.meta !== meta) wm.update(tw.id, { title, status, meta });
	}
});
