// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The toplevels of one wland as windows of the page's window manager
// (wayland.ts: createHost(), whose mount, unmount, interactive and event
// it hands createWland; attach() once wland runs):
// - the WM window (id wl-<key>, appId wayland) holds wland's window element
//   at its body's origin. wland answers xdg-decoration with server-side
//   (decorations 'server'): an app that asks for it (SDL, foot) is
//   `decorated` and gets the WM's frame ("normal": its title bar, with move,
//   maximize and close); one that does not (GTK) draws its own and its WM
//   window is frame "none". It may change after the window maps (the
//   `decoration` event): the frame follows, the element keeping its size.
//   style.css drops a frameless window's border and background, and every
//   Wayland window's clipping, so shadows and popups (menus: canvases
//   inside the element) reach past it, over the other windows. The WM
//   owns the position and the z-order (shared with the terminals); the app
//   owns its size: the element's size (the window geometry wland applies)
//   is copied into the WM window, plus the frame (keeping the edge a WM
//   resize moved), and a size the WM gives it (its edges, the workspace
//   shrinking) is asked of the app (requestResize). Snapped to a tile, the
//   app is told it is tiled on the tile's outer sides, with the tile's size
//   (setTiled; 0 edges when it leaves the tile), and the size it takes goes
//   to wm.fitTile (drawn against the tile's outer side and corner) while its
//   own geometry stays. Maximized, it fills what setBounds() gave wland:
//   the workspace, less the title bar for a decorated window. An app that
//   commits another size (a fixed-size game) does not reach past the frame
//   (contain(): centred on black, or clipped; never its popups).
//   Each request's token says when the app answered (`pending`: the ack
//   of that request's configure, or a later one): until then the sizes it
//   commits are not taken (a stale answer is not taken for a newer request).
//   xdg_toplevel.move/resize requests (a press on the app's title bar or
//   its borders) and Alt+drag come through wland's `interactive` hook and
//   become wm.startMove/startResize, the pointer taken from the apps with
//   input.grab() meanwhile; wland's window manager keeps the rest (popup
//   grabs, drag and drop, the Alt+F9/F10/F11 bindings), and the states it
//   sets are mirrored. Where the window is (its element's origin in the
//   workspace, which is wland's output) goes to wland at each WM change
//   (setWindowPosition), so popups near the output's edges flip or slide.
// - States both ways: minimized (the Dock, Alt+F9, the app) and maximized
//   (Alt+F10, the app's own button, the title bar) follow each other;
//   compact mode configures every Wayland window maximized to the
//   workspace (and back after); a fullscreen app maximizes its WM window
//   while it lasts. The element stays displayed (manageDisplay off), so a
//   minimized window flies into the Dock with its last frame (wmfx.ts); a
//   window the WM does not show (minimized; in compact mode, not the top
//   one) is not rendered for (setVisible).
// - The output is #wl-desktop, which covers the workspace (what maximize
//   and fullscreen fill), above the windows and taking no pointer: it
//   holds wland's hidden editable sink (the keyboard), drag icons and
//   the cursor image.
// - Focus: the WM's focus is the authority (autoFocus off: wland moves its
//   keyboard only when told). A Wayland window focused (a press in it, the
//   Dock, Ctrl-A w) is raised in wland and gets its keyboard (input.focus);
//   any other window focused takes it away (input.blur), so keys typed in a
//   terminal never reach an app and the reverse. A press in the focused
//   Wayland window whose keyboard went (the page's focus taken outside the
//   windows) gives it back before the press reaches the app. A press on
//   a surface never moves the DOM focus (its mousedown is cancelled: iOS
//   sends one even after wland cancelled the pointerdown), so the sink
//   keeps it and the on-screen keyboard it raised stays up.
// - What the chrome shows of it (describe(): wm.ts meta and title), by its
//   app id (xdg_toplevel.set_app_id: ViewWindow.appId): a launcher app's
//   (appwindows.ts waylandApp(): foot, thunar, chromium, the games), whose
//   descriptor it then takes, so it is drawn as that app's pinned tile (its
//   running dot, a click shows it) or with its icon, and gets Keep in Dock;
//   else the guest's own icon for the app id (icons.ts guestIcon(): the
//   generic icon until it is read), its letter when the guest has none, the
//   generic icon without an app id. Its title is the app's (the Dock tile's
//   label and the top bar's detail: appwindows.ts windowName()), else its
//   launcher app's name, its app id, "Wayland window".
// - Close: a close (the title bar's button, the Dock's and the top bar's
//   Close Window, the compact strip's button) sends xdg_toplevel.close: the
//   app decides (it may ask first), and the window goes when it unmaps.
// - The store's Wayland windows (store.ts wayland): wland's list.
import { appMeta, WAYLAND, waylandApp } from "../appwindows.ts";
import type { AppMeta } from "../apps/types.ts";
import { DesktopIcon } from "../components/icons.tsx";
import { ui$, type WaylandWindow } from "../store.ts";
import { DEFAULT_H, DEFAULT_W, snapGeom, wm, wm$, type Edge, type WmState, type WmWindow } from "../wm.ts";
import { tileRect, type Snap } from "../wmsnap.ts";
import type { Event as WlEvent } from "wland/engine";
import type { InteractiveEvent, PointerGrab, PointerPress, ViewWindow, Wland } from "wland/client";
import { guestIcon, onGuestIcon } from "./icons.ts";

/** A size change asked of the app: the call's token, the serial of the configure it made (-1 until known), the size asked. */
interface Pending { token: number; serial: number; w: number; h: number }

/** A toplevel's element, and its WM window while it is mapped. */
interface Hosted {
	key: string;
	conn: number;
	surface: number;
	/** The WM window's id: wl-<key>. */
	id: string;
	element: HTMLElement;
	ro: ResizeObserver;
	/** It has a WM window (mapped; an unmapped toplevel keeps its element and loses its window). */
	open: boolean;
	/** What describe() gave the WM window last (its title, app id and icon, as a key). */
	sig: string;
	/** Decorated (the WM's frame) as the WM window has it. */
	deco: boolean;
	/** wland's states as last seen. */
	max: boolean;
	fs: boolean;
	min: boolean;
	/** The WM window's minimized as last seen. */
	wmMin: boolean;
	/** Maximized as asked of wland: the WM window maximized, or compact mode. */
	wantMax: boolean;
	/** The WM window is maximized only while the app is fullscreen. */
	fsMax: boolean;
	/** The WM window's size last copied from the app's (its element and the frame). */
	synced: { w: number; h: number } | null;
	/** The size change last asked of the app, until it answered (see the top). */
	pending: Pending | null;
	/** The tile wland was last told of: its edges and size ("" untiled). */
	tileKey: string;
	/** The WM window's geometry as last seen, and which edges its last resize moved (the app's own size keeps the others). */
	g: { x: number; y: number; w: number; h: number };
	anchorR: boolean;
	anchorB: boolean;
	/** The WM window was drawn maximized (maximized, or compact mode) as last seen. */
	drawnMax: boolean;
	/** Where wland was last told the window is (setWindowPosition), or null. */
	pos: { x: number; y: number } | null;
	/** The WM window's body (the box the element is in) as last measured (onResize), or null. */
	body: { w: number; h: number } | null;
	/** What contain() last set: the element's margins and the backdrop, as a key ("" nothing). */
	fit: string;
}

export interface Host {
	byId: Map<string, Hosted>;
	/** createWland's mount and unmount: a toplevel's element comes and goes. */
	mount(win: ViewWindow): void;
	unmount(win: ViewWindow): void;
	/** wland runs: the windows are reconciled from now on. */
	attach(wl: Wland): void;
	/** The view's window list or a focus changed: reconcile at the next microtask. */
	schedule(): void;
	/** createWland's interactive: an app's move or resize request, or Alt+drag, which the page's WM takes. */
	interactive(ev: InteractiveEvent, press: PointerPress): boolean;
	/** Every engine event (configures and acks: the answers to the size changes asked). */
	event(ev: WlEvent): void;
	dispose(): void;
}

/** xdg_toplevel.resize edges (wland's EDGE_*: 1 top, 2 bottom, 4 left, 8 right) as the WM names them. */
const EDGES: Record<number, Edge> = { 1: "n", 2: "s", 4: "w", 8: "e", 5: "nw", 9: "ne", 6: "sw", 10: "se" };
/** A tile's outer sides, as setTiled's edges (EDGE_TOP 1, EDGE_BOTTOM 2, EDGE_LEFT 4, EDGE_RIGHT 8). */
const TILE_EDGES: Record<Snap, number> = { left: 1 | 2 | 4, right: 1 | 2 | 8, tl: 1 | 4, tr: 1 | 8, bl: 2 | 4, br: 2 | 8 };
const keyOf = (conn: number, surface: number) => `c${conn}s${surface}`;

/** The element's size as wland set it (the window geometry, CSS px), or null (fullscreen: 100%; not known yet). */
function elementSize(el: HTMLElement): { w: number; h: number } | null {
	const { width, height } = el.style;
	if (!width.endsWith("px") || !height.endsWith("px")) return null;
	const w = Math.round(parseFloat(width)), h = Math.round(parseFloat(height));
	return w > 0 && h > 0 ? { w, h } : null;
}

/** A length custom property of the root (style.css), px. */
const cssPx = (name: string, or: number): number => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)) || or;
/** The WM frame around a decorated window's element (Window.tsx: a 1 px border and the title bar, style.css --wm-title), CSS px; none around the others. */
const chrome = (deco: boolean): { w: number; h: number } => (deco ? { w: 2, h: cssPx("--wm-title", 34) + 2 } : { w: 0, h: 0 });
/** A WM window's own geometry's size less the frame: the element's size there. */
const inner = (w: WmWindow, c: { w: number; h: number }) => ({ w: Math.max(1, w.w - c.w), h: Math.max(1, w.h - c.h) });

/** A px length as wland writes it on its elements' styles (0 for anything else). */
const px = (v: string): number => parseFloat(v) || 0;
/** The clip-path contain() last set on a canvas (its own value: the browser may spell it back differently). */
const clips = new WeakMap<HTMLElement, string>();

/** The toplevels of one wland as WM windows (see the top). `popupRole`: wland's ROLE_POPUP (its engine is not loaded with this module). */
export function createHost(popupRole: number): Host {
	const hosts = new Map<string, Hosted>();
	const byId = new Map<string, Hosted>();
	/** WM windows whose toplevel went: removed at the next reconcile (after the event's dispatch). */
	const removing = new Set<string>();
	let wl: Wland | null = null;
	let queued = false, disposed = false;
	const ours = (id: string | null) => !!id && !!byId.get(id)?.open;

	const schedule = () => {
		if (queued || disposed) return;
		queued = true;
		queueMicrotask(() => { queued = false; reconcile(); });
	};
	// An icon read from the guest: the windows are described again.
	const unIcon = onGuestIcon(schedule);

	/** What the chrome shows of the toplevel (see the top), and a key that changes with it. */
	function describe(w: ViewWindow): { title: string; meta: AppMeta; sig: string } {
		const appId = w.appId, app = appId ? waylandApp(appId) : undefined;
		// wland names an untitled window by its key.
		const title = (w.title && w.title !== w.key ? w.title : "") || app?.title || appId || "Wayland window";
		if (app) return { title, meta: appMeta(app), sig: `${title}\n${app.id}` };
		if (!appId) return { title, meta: { id: WAYLAND, title, glyph: DesktopIcon }, sig: title };
		const icon = guestIcon(appId);
		const glyph = icon ? { src: icon } : icon === null ? DesktopIcon : (appId.split(".").pop() || appId)[0]!.toUpperCase();
		return { title, meta: { id: WAYLAND, title, glyph }, sig: `${title}\n${appId}\n${icon}` };
	}
	/** The WM window takes what describe() gives, when it changed. */
	function described(h: Hosted, w: ViewWindow): void {
		const d = describe(w);
		if (d.sig === h.sig) return;
		h.sig = d.sig;
		wm.update(h.id, { title: d.title, meta: d.meta });
	}

	// ---- size changes asked of the app, and its answers ------------------------------
	/** Configure serials by the token that caused them, for a configure dispatched before its call returned the token. */
	const causes = new Map<number, number>();
	/** A size change was asked of the app (the call's token; 0: the link is not open, nothing was sent): its sizes are taken again once it answered. */
	function asked(h: Hosted, token: number, size: { w: number; h: number }): void {
		if (!token) { h.pending = null; return; }
		const serial = causes.get(token);
		causes.delete(token);
		h.pending = { token, serial: serial ?? -1, w: size.w, h: size.h };
	}
	function answers(ev: WlEvent): void {
		if (ev.type === "commit") {
			// (wland's view has laid it out: it takes each event first)
			const h = ev.role === popupRole ? undefined : hosts.get(keyOf(ev.conn, ev.root));
			if (h) containSoon(h);
		} else if (ev.type === "position") {
			for (const h of hosts.values()) if (h.conn === ev.conn) containSoon(h);
		} else if (ev.type === "configure") {
			if (!ev.cause) return;
			const h = hosts.get(keyOf(ev.conn, ev.surface));
			if (h?.pending?.token === ev.cause) h.pending.serial = ev.serial;
			else {
				causes.set(ev.cause, ev.serial);
				if (causes.size > 64) causes.delete(causes.keys().next().value!);
			}
		} else if (ev.type === "acked") {
			const h = hosts.get(keyOf(ev.conn, ev.surface)), p = h?.pending;
			// Answered: the ack names our configure or a later one (an app acks only the latest it saw).
			// A call whose configure never came (it changed nothing) is answered by the next ack.
			if (!h || !p || (p.serial >= 0 && ev.serial < p.serial)) return;
			h.pending = null;
			// The commit after the ack sized the element (during this dispatch): the WM window takes it.
			queueMicrotask(() => appResized(h));
		} else if (ev.type === "open") {
			// A fresh compositor: its area again.
			boundsKey = "";
			bounds(wm$.get());
		}
	}

	// ---- the WM's side: focus, size, states, where windows are --------------------------
	function focused(h: Hosted): void {
		const w = wl?.view.window(h.conn, h.surface);
		if (!wl || !h.open || !w || w.minimized) return; // a minimized one is restored first (applyWm), then focused
		wl.view.raise(h.conn, h.surface);
		wl.input.focus(h.conn, h.surface);
	}
	function blurred(): void {
		if (!ours(wm.focused())) wl?.input.blur();
	}
	/** Whether the app takes sizes from the WM now: shown, floating, its own size. */
	function sizing(h: Hosted, w: WmWindow | undefined, vw: ViewWindow | undefined): w is WmWindow {
		return !!w && !!vw && h.open && !w.minimized && !w.maximized && !wm$.get().compact && !vw.maximized && !vw.fullscreen && !vw.minimized;
	}
	/** The WM window's body (the element's box) has this size: ask the app for it, unless it has it or was asked it. Not snapped (applyWm asks for tiles). */
	function wmResized(h: Hosted, size: { w: number; h: number }): void {
		if (!wl) return;
		const w = wm.get(h.id);
		if (!sizing(h, w, wl.view.window(h.conn, h.surface)) || w.snap) return;
		const p = h.pending, cur = elementSize(h.element);
		if (p ? p.w === size.w && p.h === size.h : cur && cur.w === size.w && cur.h === size.h) return;
		asked(h, wl.engine.requestResize(h.conn, h.surface, size.w, size.h), size);
	}
	/** The app's window geometry changed (the element's size): the WM window takes it with the frame, keeping the edge its last resize moved. Not while a request is unanswered. */
	function appResized(h: Hosted): void {
		if (!wl || h.pending) return;
		const w = wm.get(h.id), size = elementSize(h.element);
		if (!sizing(h, w, wl.view.window(h.conn, h.surface)) || !size) return;
		const c = chrome(h.deco), full = { w: size.w + c.w, h: size.h + c.h };
		h.synced = full;
		// Snapped: the size it took for its tile, drawn against the tile's outer side and corner; its own geometry stays.
		if (w.snap) return void wm.fitTile(h.id, full);
		if (full.w === w.w && full.h === w.h) return;
		wm.resize(h.id, { x: h.anchorR ? w.x + w.w - full.w : w.x, y: h.anchorB ? w.y + w.h - full.h : w.y, ...full });
	}

	/**
	 * The app's own surfaces (the toplevel and its subsurfaces, never its popups) stay inside its WM window's body, whatever
	 * size it commits. Maximized (or compact mode) the frame keeps the WM's size: a window smaller than the body (a fixed-size
	 * game ignores the maximized configure) is centred on black, a larger one is clipped at the body's right and bottom. A
	 * decorated window that is not maximized is clipped too: its frame follows the app's size, but not past the workspace
	 * (wm.resize clamps it), nor before the app answered a WM resize. A frameless one that is not maximized is left alone
	 * (its shadows reach past its geometry), and so is a fullscreen one (wland fills and clips the workspace). A canvas's
	 * input region (wland's hit element, clipped to the region) is not clipped: presses there still reach the app.
	 */
	function contain(h: Hosted): void {
		const body = h.element.parentElement, origin = h.element.firstElementChild;
		if (!wl || !body || !(origin instanceof HTMLElement)) return;
		const w = h.open ? wm.get(h.id) : undefined, vw = wl.view.window(h.conn, h.surface);
		const max = !!w && (w.maximized || wm$.get().compact);
		const on = !!w && !!vw && !vw.fullscreen && (max || h.deco);
		// Measured once when not reported yet (a layout read; onResize keeps it from then on).
		if (on && !h.body) h.body = { w: body.clientWidth, h: body.clientHeight };
		const bw = on ? h.body!.w : 0, bh = on ? h.body!.h : 0;
		// Centred where it is smaller (margins: wland keeps a maximized element's left and top at 0).
		const size = max && on ? elementSize(h.element) : null;
		const ml = size ? Math.max(0, Math.floor((bw - size.w) / 2)) : 0, mt = size ? Math.max(0, Math.floor((bh - size.h) / 2)) : 0;
		const fit = on ? `${ml},${mt},${max}` : "";
		if (fit !== h.fit) {
			h.fit = fit;
			h.element.style.marginLeft = ml ? `${ml}px` : "";
			h.element.style.marginTop = mt ? `${mt}px` : "";
			body.style.background = on && max ? "#000" : "";
			positions();
		}
		// Each canvas against the body: its box there is the margins, the origin's offset (minus the geometry's position) and its own.
		const ox = ml + px(origin.style.left), oy = mt + px(origin.style.top);
		for (const c of origin.children) {
			if (!(c instanceof HTMLCanvasElement)) continue; // a hit element: wland's own clip-path (the input region)
			let clip = "";
			const role = on ? wl.view.surfaceOf(c)?.role : undefined;
			if (role !== undefined && role !== popupRole) {
				const x = ox + px(c.style.left), y = oy + px(c.style.top);
				const l = Math.max(0, -x), t = Math.max(0, -y);
				const r = Math.max(0, x + px(c.style.width) - bw), b = Math.max(0, y + px(c.style.height) - bh);
				if (l || t || r || b) clip = `inset(${t}px ${r}px ${b}px ${l}px)`;
			}
			if ((clips.get(c) ?? "") === clip) continue;
			clips.set(c, clip);
			c.style.clipPath = clip;
		}
	}
	/** The windows whose surfaces changed (commits, a subsurface moved), contained again before the frame is drawn. */
	const touched = new Set<Hosted>();
	let containQueued = false;
	function containSoon(h: Hosted): void {
		touched.add(h);
		if (containQueued) return;
		containQueued = true;
		queueMicrotask(() => {
			containQueued = false;
			for (const t of touched) contain(t);
			touched.clear();
		});
	}

	/** The area wland configures windows in (setBounds): the workspace, and less the title bar (the compact strip) for decorated ones, maximized. */
	let boundsKey = "";
	function bounds(s: WmState): void {
		if (!wl || !s.area.w || !s.area.h) return;
		const top = s.compact ? cssPx("--wm-strip", 30) : cssPx("--wm-title", 34);
		const key = `${s.area.w}x${s.area.h}-${top}`;
		if (key === boundsKey) return;
		boundsKey = key;
		wl.engine.setBounds(s.area.w, s.area.h, s.area.w, Math.max(1, s.area.h - top));
	}

	/** Where each window's element is in the workspace (wland's output), told to wland after the WM's change is drawn. */
	let posRaf = 0;
	const positions = () => { if (!posRaf && !disposed) posRaf = requestAnimationFrame(place); };
	function place(): void {
		posRaf = 0;
		if (!wl) return;
		for (const h of byId.values()) {
			const body = h.element.parentElement, win = body?.parentElement;
			if (!h.open || !body || !win) continue;
			// Offsets, not rects: an effect's transform is not where the window is.
			const x = win.offsetLeft + win.clientLeft + body.offsetLeft + h.element.offsetLeft;
			const y = win.offsetTop + win.clientTop + body.offsetTop + h.element.offsetTop;
			if (h.pos?.x === x && h.pos.y === y) continue;
			h.pos = { x, y };
			wl.engine.setWindowPosition(h.conn, h.surface, x, y);
		}
	}

	/** The WM changed: minimized, maximized (or compact) and tiles go to wland; resize anchors; where the windows are. */
	function applyWm(): void {
		if (disposed || !wl) return;
		const s = wm$.get(), { view, engine } = wl;
		bounds(s);
		for (const h of byId.values()) {
			const w = h.open ? s.windows.find((o) => o.id === h.id) : undefined;
			if (!w) continue;
			const vw = view.window(h.conn, h.surface), c = chrome(h.deco);
			if (w.minimized !== h.wmMin) {
				h.wmMin = w.minimized;
				if (vw && vw.minimized !== w.minimized) (w.minimized ? wl.wm.minimize : wl.wm.restore)(h.conn, h.surface);
			}
			if (!h.fs && !h.fsMax) {
				const want = w.maximized || s.compact;
				if (want !== h.wantMax) {
					h.wantMax = want;
					if (vw && vw.maximized !== want) {
						const token = engine.setMaximized(h.conn, h.surface, want);
						if (!want) asked(h, token, inner(w, c));
					}
				}
			}
			const drawnMax = w.maximized || s.compact;
			if (h.drawnMax && !drawnMax) {
				// Restored: the app goes back to its own size (wland's configure, answered by its next ack), which the
				// WM window then takes; the WM's own geometry is not asked of it meanwhile.
				const size = inner(w, c);
				if (h.pending) Object.assign(h.pending, size);
				else h.pending = { token: -1, serial: -1, ...size };
				h.anchorR = h.anchorB = false;
			}
			h.drawnMax = drawnMax;
			// Tiled: the tile's outer sides and size, in one configure; out of it (floating again: its own geometry's size).
			const edges = w.snap && !drawnMax ? TILE_EDGES[w.snap] : 0;
			const r = w.snap && edges ? tileRect(w.snap, s.area) : null;
			const tileKey = r ? `${edges}:${r.w}x${r.h}` : "";
			if (tileKey !== h.tileKey && vw && !vw.fullscreen) {
				h.tileKey = tileKey;
				if (r) {
					const size = { w: Math.max(1, r.w - c.w), h: Math.max(1, r.h - c.h) };
					asked(h, engine.setTiled(h.conn, h.surface, edges, size.w, size.h), size);
				} else if (drawnMax) engine.setTiled(h.conn, h.surface, 0);
				else {
					const size = inner(w, c);
					asked(h, engine.setTiled(h.conn, h.surface, 0, size.w, size.h), size);
				}
			}
			// Snapped, it is drawn at its tile (a resize by hand starts from there).
			const d = w.snap ? snapGeom(w, s.area) : w;
			if (h.g.w >= 0 && (d.w !== h.g.w || d.h !== h.g.h) && !(h.synced && d.w === h.synced.w && d.h === h.synced.h)) {
				if (d.w !== h.g.w) h.anchorR = d.x !== h.g.x;
				if (d.h !== h.g.h) h.anchorB = d.y !== h.g.y;
			}
			h.g = { x: d.x, y: d.y, w: d.w, h: d.h };
			contain(h);
		}
		positions();
	}
	const unsubscribe = wm$.subscribe(applyWm);

	// ---- wland's side: windows come and go, change title, decoration and state ------------
	function openWindow(h: Hosted, w: ViewWindow): void {
		const c = chrome(w.decorated);
		// Mapped maximized, its own size is not known yet: the WM's default until it is restored.
		const own = !w.maximized && !w.fullscreen && elementSize(h.element);
		const size = own ? { w: own.w + c.w, h: own.h + c.h } : { w: DEFAULT_W, h: DEFAULT_H };
		const d = describe(w);
		Object.assign(h, {
			open: true, sig: d.sig, deco: w.decorated, max: w.maximized, fs: w.fullscreen, min: w.minimized,
			wmMin: w.minimized, wantMax: w.maximized, fsMax: w.fullscreen && !w.maximized,
			// g unknown (-1) until the WM placed it: placing is no resize.
			synced: size, pending: null, tileKey: "", g: { x: 0, y: 0, w: -1, h: -1 }, anchorR: false, anchorB: false,
			drawnMax: w.maximized || w.fullscreen || wm$.get().compact, pos: null,
			// A new body: contain() sets it all again (its size: wm.reportSize reports only changes, so the last one stays).
			fit: "?",
		});
		wm.open({
			id: h.id, appId: WAYLAND, meta: d.meta, title: d.title, frame: w.decorated ? "normal" : "none", content: h.element,
			w: size.w, h: size.h, minW: 1, minH: 1, maximized: w.maximized || w.fullscreen, dockId: `dock-${h.id}`,
			// The app decides (the window stays until it unmaps).
			onClose: () => { wl?.engine.close(h.conn, h.surface); return false; },
			onFocus: () => focused(h), onBlur: blurred, onResize: (sz) => { h.body = sz; wmResized(h, sz); contain(h); },
			onVisible: (visible) => wl?.engine.setVisible(h.conn, h.surface, visible),
		}, { focus: !w.minimized });
		if (w.minimized) wm.minimize(h.id);
	}
	/** The app chose its decorations again: the WM window takes the frame or drops it, the element keeping its size. */
	function redecorate(h: Hosted, deco: boolean): void {
		const was = chrome(h.deco), now = chrome(deco), win = wm.get(h.id);
		h.deco = deco;
		h.synced = null;
		wm.update(h.id, { frame: deco ? "normal" : "none" });
		if (win && !win.maximized && !win.snap && !wm$.get().compact) wm.resize(h.id, { x: win.x, y: win.y, w: win.w - was.w + now.w, h: win.h - was.h + now.h });
	}
	/** wland's states changed (the app, wland's bindings): the WM window follows. */
	function follow(h: Hosted, w: ViewWindow): void {
		const win = wm.get(h.id);
		if (!win) return;
		described(h, w);
		if (w.decorated !== h.deco) redecorate(h, w.decorated);
		if (w.minimized !== h.min) {
			h.min = w.minimized;
			if (w.minimized !== win.minimized) {
				h.wmMin = w.minimized;
				if (w.minimized) wm.minimize(h.id);
				else wm.focus(h.id);
			}
		}
		if (w.fullscreen !== h.fs) {
			h.fs = w.fullscreen;
			if (w.fullscreen) {
				if (!win.maximized) { h.fsMax = true; wm.maximize(h.id, true); }
				if (!w.minimized) wm.focus(h.id);
			} else if (h.fsMax) {
				h.fsMax = false;
				wm.maximize(h.id, false);
			}
		}
		if (w.maximized !== h.max) {
			h.max = w.maximized;
			if (h.fs) {
				// Back from fullscreen it is as the app says now.
				h.wantMax = w.maximized;
				h.fsMax = !w.maximized;
			} else if (w.maximized !== h.wantMax) {
				// The app's own request (ours match wantMax). In compact mode applyWm then configures it maximized again.
				h.wantMax = w.maximized;
				wm.maximize(h.id, w.maximized);
			}
		}
		contain(h);
	}
	function reconcile(): void {
		if (disposed || !wl) return;
		for (const id of removing) { removing.delete(id); wm.remove(id); }
		const { view, input } = wl;
		const listed = view.windows();
		const keys = new Set(listed.map((w) => w.key));
		for (const h of hosts.values()) {
			if (h.open && !keys.has(h.key)) { h.open = false; wm.remove(h.id); }
		}
		for (const w of listed) {
			const h = hosts.get(w.key);
			if (!h) continue;
			if (!h.open) openWindow(h, w);
			else follow(h, w);
		}
		const list: WaylandWindow[] = listed.map((w) => ({ key: w.key, title: w.title, focused: input.focused(w.conn, w.surface), minimized: w.minimized }));
		if (JSON.stringify(list) !== JSON.stringify(ui$().get().wayland.windows)) ui$().set((s) => ({ wayland: { ...s.wayland, windows: list } }));
	}

	// ---- moves and resizes: the app's requests and Alt+drag ------------------------
	/** The pointer taken from the apps for the WM's move or resize. */
	let grabbing: PointerGrab | null = null;
	function interactive(ev: InteractiveEvent, p: PointerPress): boolean {
		// Taken either way: wland's own grab would move the element inside its WM window.
		if (!wl || grabbing?.active) return true;
		const h = hosts.get(keyOf(ev.conn, ev.surface));
		const edge = ev.type === "resize" ? EDGES[ev.edges] : undefined;
		const body = h?.element.parentElement, w = h && wm.get(h.id), vw = wl.view.window(ev.conn, ev.surface);
		if (!h?.open || !body || !w || !vw || (ev.type === "resize" && !edge) || vw.fullscreen || wm$.get().compact || (edge && w.maximized)) return true;
		// As wland's own grab: the app sees the pointer leave and nothing until the release.
		const g = wl.input.grab(p.pointerId, { onEnd: () => { if (grabbing === g) grabbing = null; } });
		if (!g.active) return true;
		grabbing = g;
		wm.focus(h.id);
		// The WM follows the pointer from the press (its capture on the window's body, which is no surface).
		const at = { pointerId: p.pointerId, clientX: p.clientX, clientY: p.clientY, button: p.button, target: body };
		if (edge) wm.startResize(h.id, edge, at);
		else wm.startMove(h.id, at);
		return true;
	}
	/** A press in the WM's focused Wayland window whose keyboard went (the page's focus taken outside the windows): given back before the press reaches the app. */
	const onDown = (ev: PointerEvent) => {
		const s = wl?.view.surfaceOf(ev.target), h = s && hosts.get(keyOf(s.conn, s.root));
		if (wl && h?.open && wm.focused() === h.id && !wl.input.focused(h.conn, h.surface)) focused(h);
	};
	addEventListener("pointerdown", onDown, true);
	/**
	 * A press on an app's surface never moves the DOM focus: the keyboard sink keeps it. wland cancels
	 * the pointerdown, which keeps Chrome and Firefox from sending the mousedown, but iOS WebKit sends
	 * its tap's mousedown anyway, after the touchend. On an input region (a div that cannot take the
	 * focus) that mousedown cleared the focus: the sink lost it right after the tap's pointerup had
	 * raised the on-screen keyboard for the app's text field, so the app lost its keyboard and the
	 * on-screen keyboard closed again.
	 */
	const onMouseDown = (ev: MouseEvent) => {
		if (wl?.view.surfaceOf(ev.target as Element | null)) ev.preventDefault();
	};
	addEventListener("mousedown", onMouseDown, true);

	return {
		byId,
		mount(win) {
			const h: Hosted = {
				key: win.key, conn: win.conn, surface: win.surface, id: `wl-${win.key}`, element: win.element,
				ro: new ResizeObserver(() => { appResized(h); contain(h); }),
				open: false, sig: "", deco: false, max: win.maximized, fs: win.fullscreen, min: win.minimized,
				wmMin: false, wantMax: false, fsMax: false, synced: null, pending: null, tileKey: "",
				g: { x: 0, y: 0, w: 0, h: 0 }, anchorR: false, anchorB: false, drawnMax: false, pos: null, body: null, fit: "?",
			};
			hosts.set(h.key, h);
			byId.set(h.id, h);
			h.ro.observe(h.element);
			schedule();
		},
		unmount(win) {
			win.element.remove();
			const h = hosts.get(win.key);
			if (!h) return;
			h.ro.disconnect();
			hosts.delete(h.key);
			if (byId.get(h.id) === h) byId.delete(h.id);
			if (h.open) removing.add(h.id);
			h.open = false;
			schedule();
		},
		attach(w) {
			if (disposed) return;
			wl = w;
			applyWm();
			schedule();
		},
		schedule,
		interactive,
		event: answers,
		dispose() {
			if (disposed) return;
			disposed = true;
			unsubscribe();
			unIcon();
			removeEventListener("pointerdown", onDown, true);
			removeEventListener("mousedown", onMouseDown, true);
			cancelAnimationFrame(posRaf);
			grabbing?.end();
			for (const h of hosts.values()) {
				h.ro.disconnect();
				if (h.open) removing.add(h.id);
			}
			for (const id of removing) wm.remove(id);
			removing.clear();
			hosts.clear();
			byId.clear();
			wl = null;
		},
	};
}
