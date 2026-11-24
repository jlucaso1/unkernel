// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The guest's display and input on the page (kwfb, kwinput; on unless
// ?display=0). This module is the part the SDK calls (boot.ts passes it to
// createKernel): the Display window, the mode offered to the guest, the
// display and input state (in the store), and keyboard routing.
// components/Display.tsx draws the window's content: the canvas, mouse and
// touch input, the touch controls, and the page-covering layer.
// - the window: a desktop window (wm.ts; id DISPLAY_WIN, "Display", Dock
//   item #dock-display) opens, focused, when a program attaches the display
//   (onDisplay(mode)) and goes away when it lets go. Its content is one
//   element (#fb-layer, displayHost()) that Display.tsx renders into. Closing
//   or minimizing it only hides the picture: the program keeps running and
//   the Dock item brings it back (setDisplayShown(), toggleDisplay(), the
//   prefix's d: focus or minimize; hideDisplay() when the Browser or a
//   system app opens over it). Whether it is shown is the WM's (wm.ts
//   isVisible(): not minimized; in compact mode the top one). Its geometry is kept for the next
//   program; the first one opens at a 4:3 box (DEFAULT_MODE scaled down to
//   fit the workspace) in its middle;
// - the mode: when a program first opens /dev/fb0 the kernel asks for a
//   size, and gets the Display window's content box in CSS pixels (size());
//   before the window exists, the box it would open at (its last geometry,
//   else the default box; in compact mode the workspace under the window's
//   strip, or the page when it would cover it). The kernel may pick less (at
//   most 1M pixels: divided by an integer), and a program may set its own;
//   the canvas is scaled to fit the box either way. The virtio-gpu device
//   (guest GL) offers the same size as its connector's preferred mode, and
//   when the box settles at another size while shown (the window resized or
//   maximized, the page resized, the rotate option, full screen: a
//   ResizeObserver, 300 ms after the last change) offerSize() tells the
//   running guest (updateDisplaySize(): a hotplug); a KMS client then picks
//   the new mode itself or not (X: a plain xrandr, then xrandr --output NAME
//   --auto), and the canvas follows the mode the guest sets. While the window
//   is hidden the size stays the one it last had shown;
// - covering the page (touch devices, so compact mode, while the window is
//   shown): with the rotate option on and the page portrait the content is
//   drawn a quarter turn clockwise over the whole page, Dock included, so the
//   phone is held sideways; the mode offered is then the page's size turned.
//   In full screen (the touch controls' chip) it covers the page unturned.
//   Turning the phone itself makes the page landscape, and then nothing is
//   rotated (isRotated()). Pointer positions are turned back into the
//   content's own frame (unturn(), localPos());
// - full screen: the Fullscreen API on the page, then a landscape
//   orientation lock where the browser allows one in full screen (Android
//   Chrome). Only after a tap: browsers refuse it without a user gesture.
//   iPhone Safari has no element full screen (iPad does): there the chip
//   says, in a toast, to add the page to the home screen, which opens it
//   without Safari's bars (index.html's apple-mobile-web-app-capable); it
//   is left out once the page runs that way. A refused request is a toast
//   too;
// - keyboard routing: while the Display window is the focused window and a
//   program has the evdev keyboard open, keys go there (by KeyboardEvent.code)
//   and never to a terminal; another focused window (a terminal, a dialog's
//   fields) keeps its keys. Fields outside the terminals (the soft keyboard's
//   input among them) keep theirs too. A release goes to the guest whenever
//   it saw the press, and losing the focus (or the page losing it) releases
//   every held key and button and leaves pointer lock. The page's shortcuts
//   (keys.ts) listen first. On a desktop the focused window's DOM focus
//   stays in (or goes to) the current terminal while no program reads the
//   keyboard, so a program that reads the tty gets the typing as before;
// - worker mode (?worker=1): the same, through the WorkerKernel's mirror of
//   evdev (its open state follows onInput; calls are forwarded in order).
//   The kernel cannot ask this thread for the size when a program opens
//   /dev/fb0, so the SDK asks size() ahead of time: at boot and on every
//   terminal resize; offerSize() covers the rest.
import type { AppMeta } from "./apps/types.ts";
import { DisplayIcon } from "./components/icons.tsx";
import { KernelInstance, domCodeToLinux, type WorkerKernel, type DisplayMode, type InputState } from "./sdk.ts";
import { inTerminal, ownsKeys } from "./focus.ts";
import { useSyncExternalStore } from "react";
import { ui$, type PadLayout, type TouchMode } from "./store.ts";
import { store } from "./prefs.ts";
import { wm, wm$, type Geom, type WmState } from "./wm.ts";

export interface DisplayUiOptions {
	/** The kernel: inline, or in a worker (?worker=1). */
	vm: () => KernelInstance | WorkerKernel | null;
	/** Show the touch overlay (a touch device). */
	touch: boolean;
	/** Type into the guest console. */
	sendTty: (s: string) => void;
	/** The terminal is in application cursor mode (arrows as ESC O x). */
	appCursor: () => boolean;
	/** Give the current terminal the keyboard focus (desktop, while no program reads the keyboard). */
	focusTerminal: () => void;
}

export interface DisplayUi {
	/** The size to offer the guest: the Display window's content box (or the one it would open at), in CSS pixels. */
	size(): { width: number; height: number; dpi: number };
	onDisplay(mode: DisplayMode | null): void;
	onInput(state: InputState): void;
}

/** The Display window's WM id. */
export const DISPLAY_WIN = "display";
/** Its descriptor (wm.ts meta): no launcher app stands for it. */
export const DISPLAY: AppMeta = { id: "display", title: "Display", glyph: DisplayIcon, cmd: "display" };
/** The first window's content box, scaled down to fit the workspace. */
const DEFAULT_MODE = { w: 1024, h: 768 };
/** Room kept round the default box (px, each side). */
const MARGIN_X = 32, MARGIN_Y = 24;
/** The window's border (wm-win in style.css), each side. */
const BORDER = 1;

let current: DisplayUiOptions | null = null;

/** What Display.tsx needs from boot.ts (null until the boot module runs). */
export const displayOpts = (): DisplayUiOptions | null => current;
export const evdev = () => current?.vm()?.evdev;
/** The canvas holds pointer lock (components/Display.tsx). */
export const pointerLocked = (): boolean => (document.pointerLockElement as HTMLElement | null)?.id === "fb";

// ---- the window's content element --------------------------------------------
let hostEl: HTMLElement | null = null;
/** The size the content box last had while shown: offered while the window is hidden. */
let lastShown: { w: number; h: number } | null = null;

/**
 * The Display window's content (#fb-layer): made once, mounted in the
 * window's body (or in the page-covering layer, Display.tsx), and rendered
 * into by Display.tsx. Presses in it never move the DOM focus (the soft
 * keyboard's input aside), so typing stays where onFocus put it.
 */
export function displayHost(): HTMLElement {
	if (hostEl) return hostEl;
	const el = document.createElement("div");
	el.id = "fb-layer";
	el.tabIndex = -1;
	el.className = "absolute inset-0 isolate overflow-hidden bg-black outline-none";
	el.addEventListener("mousedown", (e) => { if (!(e.target as Element | null)?.closest?.("input")) e.preventDefault(); });
	if (typeof ResizeObserver === "function") new ResizeObserver(() => {
		if (!wm.isVisible(DISPLAY_WIN) || !el.clientWidth || !el.clientHeight) return;
		lastShown = { w: el.clientWidth, h: el.clientHeight };
		offerSize();
	}).observe(el);
	return (hostEl = el);
}

/** The page (#app): the area the content covers when rotated or in full screen. */
const appEl = (): HTMLElement | null => document.getElementById("app");

/** The display is drawn a quarter turn round: a touch device, the rotate option on, and a portrait page (w x h). */
export const isRotated = (w: number, h: number): boolean => !!current?.touch && ui$().get().display.rotate && h > w;

// The turned content is a quarter turn clockwise: a vector (x, y) in
// it is (-y, x) on the screen, so one on the screen (x, y) is (y, -x) in it.
/** A screen vector in the content's own frame (rot: drawn turned). */
export const unturn = (rot: boolean, dx: number, dy: number): [number, number] => (rot ? [dy, -dx] : [dx, dy]);

/** A pointer's position on an element of the content (components/Display.tsx, Pad.tsx), 0..1 across its own (untransformed) box. */
export function localPos(el: HTMLElement, rot: boolean, e: { clientX: number; clientY: number }): { x: number; y: number } {
	const r = el.getBoundingClientRect(); // its centre is the same either way
	const [dx, dy] = unturn(rot, e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2));
	return { x: dx / Math.max(1, el.offsetWidth) + 0.5, y: dy / Math.max(1, el.offsetHeight) + 0.5 };
}

/** The Display window is the focused window (keys go to the guest). */
export const displayFocused = (): boolean => wm.focused() === DISPLAY_WIN;

/** A CSS length variable on the root, in px (style.css: --wm-title, --wm-strip). */
const cssPx = (name: string, fallback: number): number =>
	parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)) || fallback;
/** The window's title bar, and in compact mode its strip (hidden while the on-screen keyboard is up). */
const titleH = (): number => cssPx("--wm-title", 34);
const stripH = (): number => (document.documentElement.classList.contains("kb") ? 0 : cssPx("--wm-strip", 30));

/** The workspace's size, or a guess before it is measured (the Dock's strip taken off). */
const areaOf = (s: WmState): { w: number; h: number } => (s.area.w > 0 && s.area.h > 0 ? s.area : { w: innerWidth, h: Math.max(1, innerHeight - 64) });

/** The last Display window's geometry, for the next program. */
let lastGeom: (Geom & { maximized: boolean }) | null = null;

/** Where and how large the window opens: its last geometry, else the default box centred. */
function openGeom(area: { w: number; h: number }): Geom & { maximized: boolean } {
	if (lastGeom) return lastGeom;
	const t = titleH();
	const maxW = area.w - 2 * MARGIN_X - 2 * BORDER, maxH = area.h - 2 * MARGIN_Y - t - 2 * BORDER;
	const s = Math.max(0.2, Math.min(1, maxW / DEFAULT_MODE.w, maxH / DEFAULT_MODE.h));
	const w = Math.floor(DEFAULT_MODE.w * s) + 2 * BORDER, h = Math.floor(DEFAULT_MODE.h * s) + t + 2 * BORDER;
	return { x: Math.max(0, Math.round((area.w - w) / 2)), y: Math.max(0, Math.round((area.h - h) / 2)), w, h, maximized: false };
}

/** The page's size, turned when the content would be drawn rotated over it; null when it would not cover the page. */
function coverSize(): { w: number; h: number } | null {
	if (!current?.touch) return null;
	const app = appEl();
	const w = app?.clientWidth ?? innerWidth, h = app?.clientHeight ?? innerHeight;
	if (isRotated(w, h)) return { w: h, h: w };
	return fsElement() ? { w, h } : null;
}

/** The content box the window would have if it opened now (shown and focused). */
function predicted(): { w: number; h: number } {
	const s = wm$.get(), area = areaOf(s);
	if (s.compact) return coverSize() ?? { w: area.w, h: area.h - stripH() };
	const g = openGeom(area);
	if (g.maximized) return { w: area.w, h: area.h - titleH() };
	return { w: Math.min(g.w, area.w) - 2 * BORDER, h: Math.min(g.h, area.h) - titleH() - 2 * BORDER };
}

/** Wait this long after the last size change before telling the guest: one hotplug per drag, not one per frame. */
const OFFER_MS = 300;
let offerTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * The size to offer changed (or may have): tell the running guest once it
 * has settled. updateDisplaySize() asks size() again (worker mode: here,
 * for the worker; inline the kernel asks it when it needs it) and lets
 * virtio-gpu offer it when it differs from what the guest's driver has.
 */
function offerSize(): void {
	clearTimeout(offerTimer);
	offerTimer = setTimeout(() => {
		const vm = current?.vm();
		if (vm && !(vm instanceof KernelInstance && vm.kernel.result)) vm.updateDisplaySize();
	}, OFFER_MS);
}

/** The rotate option (the touch controls' button). */
export function setRotate(rotate: boolean): void {
	store("fbRotate", rotate ? "1" : "0");
	ui$().set((s) => ({ display: { ...s.display, rotate } }));
	offerSize();
}

/** How touches on the picture move the pointer (the touch controls' button). */
export function setTouchMode(touchMode: TouchMode): void {
	store("touchMode", touchMode);
	ui$().set((s) => ({ display: { ...s.display, touchMode } }));
}

/** Show or hide the stick and buttons (the touch controls' button). */
export function setControls(controls: boolean): void {
	store("padHidden", controls ? "0" : "1");
	ui$().set((s) => ({ display: { ...s.display, controls } }));
}

/** The touch buttons' layout (the touch controls' button). */
export function setPadLayout(layout: PadLayout): void {
	store("padLayout", layout);
	ui$().set((s) => ({ display: { ...s.display, layout } }));
}

// ---- full screen ------------------------------------------------------------
type FsDoc = Document & { webkitFullscreenEnabled?: boolean; webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> | void };
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
const fsDoc = () => document as FsDoc;
const fsElement = (): Element | null => fsDoc().fullscreenElement ?? fsDoc().webkitFullscreenElement ?? null;

/** The browser can put the page in full screen (not iPhone Safari). */
export const canFullscreen = (): boolean => !!(fsDoc().fullscreenEnabled || fsDoc().webkitFullscreenEnabled);

/** Opened from the home screen (no browser bars already). */
const standalone = (): boolean =>
	(navigator as Navigator & { standalone?: boolean }).standalone === true ||
	matchMedia("(display-mode: standalone), (display-mode: fullscreen)").matches;

/** Offer the full screen chip: the browser has full screen, or (iPhone) it can say how to get the nearest thing. */
export const offerFullscreen = (): boolean => canFullscreen() || !standalone();

/**
 * Enter full screen (and lock to landscape where allowed), or leave it.
 * Call from a user gesture. Resolves with a message for the user (no full
 * screen here, or the browser refused it), or null.
 */
export async function toggleFullscreen(): Promise<string | null> {
	if (!canFullscreen())
		return "iPhone Safari has no full screen for pages. Share → Add to Home Screen, then open it from the icon: no Safari bars.";
	try {
		if (fsElement()) {
			await (fsDoc().exitFullscreen?.() ?? fsDoc().webkitExitFullscreen?.());
			return null;
		}
		const el = document.documentElement as FsEl;
		await (el.requestFullscreen?.({ navigationUI: "hide" }) ?? el.webkitRequestFullscreen?.());
	} catch (e) {
		return `Full screen refused: ${(e as Error)?.message || e}`;
	}
	// Android Chrome: allowed in full screen; elsewhere it rejects, and the rotate option covers it.
	await (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> })?.lock?.("landscape").catch(() => {});
	return null;
}

const onFsChange = (l: () => void) => {
	document.addEventListener("fullscreenchange", l);
	document.addEventListener("webkitfullscreenchange", l);
	return () => {
		document.removeEventListener("fullscreenchange", l);
		document.removeEventListener("webkitfullscreenchange", l);
	};
};
/** The page is in full screen (re-renders on change). */
export const useFullscreen = (): boolean => useSyncExternalStore(onFsChange, () => !!fsElement());

// ---- the window ---------------------------------------------------------------
/** Let go of everything the guest holds from the page: keys, buttons, pointer lock. */
function letGo(): void {
	evdev()?.releaseAll();
	if (pointerLocked()) document.exitPointerLock();
}

/**
 * The window got the focus: the DOM focus goes into it (a touch device: the
 * terminal's on-screen keyboard closes), or on a desktop while no program
 * reads the keyboard to the current terminal, so a program reading the tty
 * gets the typing. After the render, since the content may not be mounted yet.
 */
function focusContent(): void {
	setTimeout(() => {
		const host = hostEl;
		if (!host || !displayFocused() || host.contains(document.activeElement)) return;
		if (!current?.touch && !evdev()?.keyboardOpen) current?.focusTerminal();
		else host.focus({ preventScroll: true });
	}, 0);
}

/** Open the Display window (focused), or focus it when it is there. */
function openWindow(): void {
	if (wm.get(DISPLAY_WIN)) { wm.focus(DISPLAY_WIN); return; }
	const g = openGeom(areaOf(wm$.get()));
	wm.open({
		id: DISPLAY_WIN, meta: DISPLAY, dockId: "dock-display",
		content: displayHost(), ...g, minW: 200, minH: 150,
		// Closing only hides the picture: the program keeps the display.
		onClose: () => { wm.minimize(DISPLAY_WIN); return false; },
		onFocus: focusContent,
		onBlur: letGo,
		onVisible: (shown) => {
			if (shown) offerSize();
			else if (pointerLocked()) document.exitPointerLock();
		},
	});
}

/** The program let go of the display: keep the geometry for the next one, and close the window. */
function closeWindow(): void {
	const w = wm.get(DISPLAY_WIN);
	if (!w) return;
	if (w.placed) lastGeom = { x: w.x, y: w.y, w: w.w, h: w.h, maximized: w.maximized };
	letGo();
	wm.remove(DISPLAY_WIN);
	offerSize(); // the next window opens at this geometry (worker mode: the size asked ahead of time)
}

/** Show the picture (focus the window, restoring it) or hide it (minimize it); the program keeps running. */
export function setDisplayShown(shown: boolean): void {
	if (!wm.get(DISPLAY_WIN)) return;
	if (shown) wm.focus(DISPLAY_WIN);
	else wm.minimize(DISPLAY_WIN);
}
/** Ctrl-A d (keys.ts): bring the Display window to the front (restored, focused), or minimize it when it is in front. */
export function toggleDisplay(): void {
	setDisplayShown(!displayFocused() || !wm.isVisible(DISPLAY_WIN));
}
/** Minimize the Display window if it is shown (the Browser and the system apps open over it: preview.ts, sysapps.ts). */
export function hideDisplay(): void {
	if (wm.isVisible(DISPLAY_WIN)) wm.minimize(DISPLAY_WIN);
}

export function createDisplayUi(opts: DisplayUiOptions): DisplayUi {
	current = opts;
	const $ = ui$();

	// ---- keyboard: capture phase, ahead of the terminals ------------------------
	// What is not a terminal's keeps its keys (focus.ts ownsKeys): fields (the soft keyboard's
	// input), dialogs, the Resume card's buttons (Enter or Space on a focused Resume or Continue is theirs),
	// the launcher (focused itself on touch devices, components/Launcher.tsx), the Dock, the top bar
	// and the menus (TopBar.tsx, Menu.tsx).
	function onKey(e: KeyboardEvent) {
		const ev = evdev();
		if (!ev) return;
		const code = domCodeToLinux(e.code);
		const down = e.type === "keydown";
		// A release goes to the guest if the guest saw the press, whatever the state or target now.
		if (!down && code !== undefined && ev.key(code, false)) {
			e.preventDefault();
			e.stopImmediatePropagation();
			return;
		}
		if (ownsKeys(e.target)) return;
		// Only while the Display window has the WM's focus (a focused Wayland window has the keyboard itself: wayland.ts).
		if (!ev.keyboardOpen || !displayFocused()) return;
		e.preventDefault();
		e.stopImmediatePropagation();
		if (down && code !== undefined) ev.key(code, true);
	}
	window.addEventListener("keydown", onKey, true);
	window.addEventListener("keyup", onKey, true);
	window.addEventListener("blur", () => evdev()?.releaseAll());
	// The page or the workspace resized: the box the window would open at (or a maximized one) changes.
	window.addEventListener("resize", offerSize);
	let area = wm$.get().area, compact = wm$.get().compact;
	wm$.subscribe(() => {
		const s = wm$.get();
		if (s.area === area && s.compact === compact) return;
		area = s.area;
		compact = s.compact;
		offerSize();
	});

	return {
		// CSS pixels are 96 to the inch by definition, so the guest can work out a DPI.
		size: () => {
			let box = predicted();
			const host = hostEl;
			if (wm.get(DISPLAY_WIN) && host?.isConnected && host.clientWidth > 0 && host.clientHeight > 0) {
				if (wm.isVisible(DISPLAY_WIN)) box = lastShown = { w: host.clientWidth, h: host.clientHeight };
				else if (lastShown) box = lastShown;
			}
			return { width: Math.max(1, Math.floor(box.w)), height: Math.max(1, Math.floor(box.h)), dpi: 96 };
		},
		onDisplay(mode) {
			if (!mode) {
				$.set((s) => ({ display: { ...s.display, attached: false } }));
				closeWindow();
				return;
			}
			const was = $.get().display.attached;
			$.set((s) => ({ display: { ...s.display, attached: true, width: mode.width, height: mode.height } }));
			if (!was || !wm.get(DISPLAY_WIN)) openWindow();
		},
		onInput(state) {
			$.set((s) => ({ display: { ...s.display, keyboard: state.keyboard, mouse: state.mouse, tablet: state.tablet } }));
			// Absolute wins: no pointer lock while a program reads the tablet.
			if ((!state.mouse || state.tablet) && pointerLocked()) document.exitPointerLock();
			// The keyboard opened or closed while the window has the focus: the DOM focus follows (focusContent()).
			if (displayFocused()) {
				const host = hostEl, active = document.activeElement as HTMLElement | null;
				if (state.keyboard && host && inTerminal(active)) host.focus({ preventScroll: true });
				else if (!state.keyboard && !opts.touch && active && active === host) opts.focusTerminal();
			}
		},
	};
}
