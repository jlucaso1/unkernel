// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The Wayland desktop's shared state (wayland.ts): wland's container
// (#wl-desktop, components/WaylandOutput.tsx), the current wland and its
// toplevels' WM windows (host.ts), with accessors for the modules that set
// them; and what the rest of the page asks of them: whether a WM window is
// a Wayland app's, whether one has the WM's focus (waylandFocused(), and
// its hook), and focusing the top one (Ctrl-A w, the Dock's #dock-wayland).
import { useWm, wm, wm$, type WmState } from "../wm.ts";
import type { Wland } from "wland/client";
import type { Host } from "./host.ts";

/** #wl-desktop (components/WaylandOutput.tsx): wland's container, the output. */
let container: HTMLElement | null = null;
let current: Wland | null = null;
/** The current wland's windows in the WM (createHost()). */
let host: Host | null = null;

/** components/WaylandOutput.tsx: wland's container (null when unmounted). */
export function setWaylandContainer(el: HTMLElement | null): void {
	container = el;
}
export const getContainer = (): HTMLElement | null => container;
/** The running wland (wayland.ts attachWayland()). */
export const getCurrent = (): Wland | null => current;
export function setCurrent(wl: Wland | null): void {
	current = wl;
}
/** The current wland's host (wayland.ts attachWayland()). */
export const getHost = (): Host | null => host;
export function setHost(h: Host | null): void {
	host = h;
}

/** Whether a WM window is a Wayland app's. */
export const isWaylandWindow = (id: string | null): boolean => !!id && !!host?.byId.get(id)?.open;
/** A Wayland app's window has the WM's focus (Ctrl-A w and the Dock's #dock-wayland then go back to the other windows). */
export const waylandFocused = (s: WmState = wm$.get()): boolean => isWaylandWindow(s.focused);
/** waylandFocused(), re-rendering when the WM changes (components/Dock.tsx, WaylandOutput.tsx). */
export const useWaylandFocused = (): boolean => useWm(waylandFocused);

/**
 * Focus the top Wayland window (Ctrl-A w, the Dock's #dock-wayland): the top
 * one shown, else the top minimized one (restored). False: there is none.
 */
export function focusWayland(): boolean {
	const s = wm$.get();
	const ids = [...s.order].reverse().filter(isWaylandWindow);
	const id = ids.find((o) => !wm.get(o)?.minimized) ?? ids[0];
	if (!id) return false;
	wm.focus(id);
	return true;
}
