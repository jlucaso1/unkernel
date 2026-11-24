// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// A window's own actions, as the Dock's tile menus (components/Dock.tsx) and
// the top bar's app menu (components/TopBar.tsx) both list them, so the two
// agree; each adds its own items around them (the Dock: Show first, Keep in
// Dock and the pin items before Close Window).
// - showWindow(id): restored if minimized, raised and focused; a Terminal
//   window by its shown tab (terminals.ts selectTerminal(), which gives that
//   terminal the keyboard), as a click on its Dock tile does;
// - toggleWayland(): the prefix's w and the Dock's #dock-wayland, between
//   the Wayland apps' windows and the others;
// - windowItems(id): in groups, each after a separator:
//   1. a Terminal window's (termtabs.ts): New Tab, New Window (both dimmed
//      until the system runs) and Close Tab (not the console's);
//   2. Minimize (dimmed while minimized); outside compact mode (wm.ts:
//      there every window is drawn maximized) Maximize, or Restore Size
//      while maximized, then Tile Left and Tile Right (each dimmed while
//      the window is tiled there), and Restore Size while tiled (none of
//      them for a fixed-size window: wm.ts resizable); for any
//      window, framed or not (a Wayland window takes its tile and its
//      maximized state through wland: wayland.ts). Each shows the window
//      too (a minimized one comes back);
//   3. the caller's `more`;
//   4. Close Window, unless the window cannot be closed (wm.close(): the
//      app may ask first, or refuse; a Wayland window's app is sent
//      xdg_toplevel.close: wayland/host.ts).
// - openItem(meta, run): an item that opens an app, from its descriptor
//   (apps/types.ts AppMeta: its name, icon and key), for the top bar's mark
//   menu and the desktop's menu.
// Shortcuts show as in the rest of the chrome (KeyHint.tsx menuKeys(): not
// on touch devices).
import type { AppMeta } from "./apps/types.ts";
import { CloseIcon, MaxIcon, MetaIcon, MinIcon, PlusIcon, PromptIcon, TileIcon, UnmaxIcon } from "./components/icons.tsx";
import { menuKeys } from "./components/KeyHint.tsx";
import type { MenuEntry } from "./components/Menu.tsx";
import { KW } from "./kw.ts";
import { isRunning, ui$ } from "./store.ts";
import { closeTerminal, newTerminal, newTerminalWindow, selectTerminal } from "./terminals.ts";
import { CONSOLE_WIN, termWindow } from "./termtabs.ts";
import { focusWayland, isWaylandWindow, waylandFocused } from "./wayland.ts";
import { wm, wm$ } from "./wm.ts";

/** Show window id: restored, raised, focused (a Terminal window through its shown tab). */
export function showWindow(id: string): void {
	const tw = termWindow(id);
	if (tw) selectTerminal(tw.active);
	else wm.focus(id);
}

/**
 * Ctrl-A w and the Dock's #dock-wayland: to the Wayland apps' windows (the
 * top one, restored if all are minimized), or, when one has the focus, back
 * to the top other window (a Terminal window through its shown tab, which
 * gives that terminal the keyboard).
 */
export function toggleWayland(): void {
	if (!waylandFocused()) {
		if (!focusWayland()) KW.ui!.toast("No Wayland window is open: wland CMD in a terminal starts one (the launcher's foot)");
		return;
	}
	const s = wm$.get();
	showWindow([...s.order].reverse().find((o) => !isWaylandWindow(o) && !wm.get(o)?.minimized) ?? CONSOLE_WIN);
}

/** An item that opens the app with this descriptor: "Name…", its icon, its key. */
export const openItem = (meta: AppMeta, run: () => void): MenuEntry =>
	({ label: `${meta.title}…`, icon: <MetaIcon meta={meta} size={13} />, keys: meta.cmd && menuKeys(meta.cmd), run });

/** Groups of items, a separator between each two that are not empty. */
function groups(...gs: MenuEntry[][]): MenuEntry[] {
	return gs.filter((g) => g.length).flatMap((g, i) => (i ? [null, ...g] : g));
}

/**
 * Window id's items (see the top of this file), read live; `first`: the
 * caller's group before them, `more`: its group before Close Window. Null
 * once the window is gone.
 */
export function windowItems(id: string, { first = [], more = [] }: { first?: MenuEntry[]; more?: MenuEntry[] } = {}): MenuEntry[] | null {
	const w = wm.get(id);
	if (!w) return null;
	const tw = termWindow(id);
	const off = !isRunning(ui$().get());
	const terminal: MenuEntry[] = tw ? [
		{ label: "New Tab", icon: <PlusIcon />, keys: menuKeys("new-tab"), disabled: off, run: () => newTerminal(id) },
		{ label: "New Window", icon: <PromptIcon />, keys: menuKeys("new-window"), disabled: off, run: newTerminalWindow },
		{ label: "Close Tab", icon: <CloseIcon />, keys: menuKeys("close-tab"), disabled: tw.active === 0, run: () => void closeTerminal(tw.active) },
	] : [];
	/** Do it, then show the window. */
	const then = (f: () => void) => () => { f(); showWindow(id); };
	const frame: MenuEntry[] = [{ label: "Minimize", icon: <MinIcon />, disabled: w.minimized, run: () => wm.minimize(id) }];
	if (!wm$.get().compact && w.resizable !== false) {
		frame.push(
			w.maximized
				? { label: "Restore Size", icon: <UnmaxIcon />, run: then(() => wm.maximize(id, false)) }
				: { label: "Maximize", icon: <MaxIcon />, run: then(() => wm.maximize(id, true)) },
			{ label: "Tile Left", icon: <TileIcon side="left" />, disabled: w.snap === "left", run: then(() => wm.snap(id, "left")) },
			{ label: "Tile Right", icon: <TileIcon side="right" />, disabled: w.snap === "right", run: then(() => wm.snap(id, "right")) },
		);
		if (w.snap) frame.push({ label: "Restore Size", icon: <UnmaxIcon />, run: then(() => wm.snap(id, null)) });
	}
	const close: MenuEntry[] = w.closable !== false ? [{ label: "Close Window", icon: <CloseIcon />, run: () => void wm.close(id) }] : [];
	return groups(first, terminal, frame, more, close);
}
