// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The desktop windows' effects (wm.ts draws the windows, components/Window.tsx
// asks for these): macOS style, transforms and opacity only (the Web
// Animations API on the window's element, one composited layer: the
// terminals' text, the Display's canvas, the Browser's iframe and the
// Wayland windows' canvases, which may reach past the window's box, all ride
// it unpainted).
// - minimize: the window flies into its Dock tile, genie-like: by GENIE.at of
//   the way it is narrower than tall and over the tile, then it drops into
//   the tile (its shape scaled to fit the tile's face) and fades. Ease-in.
//   restore: the same path backwards, ease-out. The tile's rect comes from
//   one provider (setTileRect(): Dock.tsx, which knows its tiles, their
//   magnification and the scrolling strip); none (the Dock is not shown):
//   a scale and fade in place.
// - open: up from OPEN_FROM with a fade-in; close: down to CLOSE_TO with a
//   fade-out; maximize and restore size (framed windows): a FLIP, the box
//   changes once (a terminal refits once) and a transform takes the new box
//   from where the old one was.
// - Timing: MS and EASE below. A running effect interrupted by another one
//   (restore while minimizing, minimize while restoring, a window opened again
//   while it closes) goes on from where the window is drawn now, in the share
//   of the time its way back takes; a window closed on its way to or from the
//   Dock goes into the tile.
// - When an effect ends its animation is cancelled and the element's own
//   style (will-change, transform-origin, data-fx) goes; a closed window's
//   last frame stays until React unmounts it.
// - Off (everything instant, as without effects): with prefers-reduced-motion,
//   in compact mode (phones: one window shows at a time, switching stays
//   instant), during a move or resize (wm-dragging), in a hidden tab, and for
//   the windows of the first render.
//
// State, with the WM's logical state changing at once as always (wm.ts):
// - Minimized, a window is inert at once (no focus, no hits; the next window
//   has the focus and the keys) and its onVisible(false) is called at once (a
//   terminal or the Display stops painting and shows its last frame while it
//   flies); data-hidden (Window.tsx) hides it with visibility, except while
//   data-fx is "out" (style.css), so it stays drawn until the effect ends.
//   It keeps its place in the z-order, so it flies over the window that took
//   the focus. Restored, it is visible and interactive first, then grows.
// - Closed: the WM forgets it at once (its id may be opened again), and this
//   module keeps a ghost of it (its last state, between the windows that were
//   under and over it) that Workspace.tsx draws, inert, in its old place in
//   the DOM until its close effect ends (useWmFx(), drawn()); a window opened
//   again with that id takes the ghost's element back. Only windows that
//   showed (or were flying to the Dock) get a ghost, and GHOST_MS drops a
//   ghost whose effect never ended. The window's body (Window.tsx) hands an
//   app its element only once the ghost goes (onRelease).
import { useSyncExternalStore } from "react";
import { reducedMotion } from "./hooks.ts";
import { createStore } from "./store.ts";
import { isVisible, wm$, type Geom, type WmState, type WmWindow } from "./wm.ts";

type Kind = "open" | "close" | "minimize" | "restore" | "flip";
/** A rect in client (viewport) px. */
interface Rect { x: number; y: number; w: number; h: number }

/** Each effect's length (ms), and the least an interrupted one's way back takes. */
const MS: Record<Kind, number> = { minimize: 300, restore: 280, open: 170, close: 140, flip: 200 };
const MIN_MS = 80;
/** Each effect's curve: minimize eases in (it speeds into the Dock), restore and the others ease out. */
const EASE: Record<Kind, string> = {
	minimize: "cubic-bezier(.4, 0, .7, .4)",
	restore: "cubic-bezier(.3, .6, .6, 1)",
	open: "cubic-bezier(.2, .8, .2, 1)",
	close: "cubic-bezier(.4, 0, 1, 1)",
	flip: "cubic-bezier(.2, .8, .2, 1)",
};
/** Open grows from this scale, close shrinks to it (around the window's centre); no tile: minimize shrinks to INPLACE. */
const OPEN_FROM = 0.94, CLOSE_TO = 0.94, INPLACE = 0.7;
/**
 * The genie's middle, at `at` of the way (in eased progress): how far the
 * width, the height, the centre's x and the bottom edge have gone from the
 * window toward its end rect in the tile.
 */
const GENIE = { at: 0.45, w: 0.62, h: 0.22, x: 0.72, bottom: 0.38 };
/** A ghost whose close effect did not end (a hidden tab, an element that never drew) goes after this long (ms). */
const GHOST_MS = 1500;

// ---- geometry: every effect draws the window's box E at some rect R ----------------
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const scaled = (E: Rect, k: number): Rect => ({ x: E.x + (E.w * (1 - k)) / 2, y: E.y + (E.h * (1 - k)) / 2, w: E.w * k, h: E.h * k });
/** E's shape scaled to fit in tile T, centred on it. */
function into(E: Rect, T: Rect): Rect {
	const s = Math.min(T.w / E.w, T.h / E.h);
	return { x: T.x + T.w / 2 - (E.w * s) / 2, y: T.y + T.h / 2 - (E.h * s) / 2, w: E.w * s, h: E.h * s };
}
/** The genie's middle rect on the way from E into tile T (GENIE). */
function genieMid(E: Rect, T: Rect): Rect {
	const end = into(E, T);
	const w = lerp(E.w, end.w, GENIE.w), h = lerp(E.h, end.h, GENIE.h);
	const cx = lerp(E.x + E.w / 2, end.x + end.w / 2, GENIE.x);
	const bottom = lerp(E.y + E.h, end.y + end.h, GENIE.bottom);
	return { x: cx - w / 2, y: bottom - h, w, h };
}
/**
 * The transform that draws box E at rect R (both in client px), with the
 * transform's origin at E's top-left (transform-origin 0 0): a point (u, v)
 * from E's top-left is drawn at (E.x + tx + sx*u, E.y + ty + sy*v), so E's
 * corners land on R's when tx = R.x - E.x, ty = R.y - E.y, sx = R.w / E.w,
 * sy = R.h / E.h.
 */
const mapTo = (E: Rect, R: Rect): string => `translate(${R.x - E.x}px, ${R.y - E.y}px) scale(${R.w / E.w}, ${R.h / E.h})`;

/**
 * The window element's box without its transform, in client px: its layout
 * offset in the workspace (#workspace, its offset parent; transforms do not move
 * offsets) plus where the workspace is.
 */
function boxOf(el: HTMLElement): Rect {
	const p = el.offsetParent as HTMLElement | null;
	if (!p) { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }
	const r = p.getBoundingClientRect();
	return { x: r.left + p.clientLeft + el.offsetLeft, y: r.top + p.clientTop + el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
}
/** A geometry in the workspace (wm.ts Geom) in client px, where the element's workspace is now. */
function clientOf(el: HTMLElement, g: Geom): Rect {
	const p = el.offsetParent as HTMLElement | null;
	const r = p?.getBoundingClientRect();
	return { x: (r?.left ?? 0) + (p?.clientLeft ?? 0) + g.x, y: (r?.top ?? 0) + (p?.clientTop ?? 0) + g.y, w: g.w, h: g.h };
}

// ---- the Dock's tiles ------------------------------------------------------------
let tileOf: ((id: string) => DOMRect | null) | null = null;
/**
 * Where window id's Dock tile is drawn now (client px; DOMRect), or null
 * when the Dock is not shown: Dock.tsx registers it, so the WM and the Dock
 * know nothing of each other.
 */
export function setTileRect(f: ((id: string) => DOMRect | null) | null): void { tileOf = f; }
function tileRect(id: string): Rect | null {
	let r: DOMRect | null = null;
	try { r = tileOf?.(id) ?? null; } catch { /* the Dock is mid-render */ }
	return r && r.width > 0 && r.height > 0 ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
}

// ---- when effects run ----------------------------------------------------------
/** Off for the windows of the first render: on from the frame after it. */
let armed = false, arming = false;
function arm(): void {
	if (arming) return;
	arming = true;
	requestAnimationFrame(() => { armed = true; });
}
function motion(): boolean {
	return armed && !reducedMotion() &&!wm$.get().compact && document.visibilityState !== "hidden"
		&& !document.documentElement.classList.contains("wm-dragging") && typeof Element.prototype.animate === "function";
}

// ---- running effects --------------------------------------------------------------
interface Run {
	id: string;
	kind: Kind;
	anim: Animation;
	/** The keyframes for the element's box E now: built again when the box changes under the effect (retarget). */
	frames: (E: Rect) => Keyframe[];
	/** The Dock tile it flies into or out of (client px, measured when it started). */
	tile: Rect | null;
	/** The window was closed: its ghost goes when this ends. */
	closing: boolean;
	/** It ended and holds its last frame (a closed window's, until React unmounts it). */
	ended: boolean;
}
const runs = new Map<HTMLElement, Run>();
/** The effect that undoes each one: an interrupted effect's way back takes the share of the time it had gone. */
const OPPOSITE: Partial<Record<Kind, Kind>> = { minimize: "restore", restore: "minimize", open: "close", close: "open" };

const progress = (a: Animation): number => {
	const d = Number(a.effect?.getTiming().duration), t = Number(a.currentTime);
	return d > 0 && Number.isFinite(t) ? Math.min(1, Math.max(0, t / d)) : 1;
};
/** Flying to the Dock now (a window closed meanwhile keeps flying, as a ghost). */
const flying = (id: string): boolean => [...runs.values()].some((r) => r.id === id && r.kind === "minimize" && !r.ended);

/**
 * Dispatched on a window's element (it bubbles) once an effect on it has ended
 * and it is drawn untransformed again: getBoundingClientRect() inside it was
 * scaled until then.
 */
export const FX_END = "wm-fx-end";

function clean(el: HTMLElement): void {
	delete el.dataset.fx;
	el.style.removeProperty("transform-origin");
	el.style.removeProperty("will-change");
	// What measured itself under the effect's transform measures again (FX_END; wterms.ts: a terminal's cell size).
	requestAnimationFrame(() => { if (!runs.has(el)) el.dispatchEvent(new CustomEvent(FX_END, { bubbles: true })); });
}

/** End whatever effect the element has, at once: drawn as it rests (a closed window's ghost goes). */
function stop(el: HTMLElement): void {
	const run = runs.get(el);
	if (!run) return;
	runs.delete(el);
	clean(el);
	run.anim.cancel();
	if (run.closing) dropGhost(run.id);
}

function finished(el: HTMLElement, run: Run): void {
	if (runs.get(el) !== run) return;
	if (run.closing) {
		// Hold the last frame (faded out) until React unmounts the ghost; a reopened window takes it from there.
		run.ended = true;
		dropGhost(run.id);
		return;
	}
	runs.delete(el);
	// Both at once: a minimized window is hidden (data-hidden, no data-fx) in the frame its transform goes.
	clean(el);
	run.anim.cancel();
}

/**
 * Start effect `kind` on the window's element, from where it is drawn now
 * when another effect runs. False: none started (effects are off, or the
 * element has no box); it is drawn as it rests.
 */
function play(el: HTMLElement, id: string, kind: Kind, opt: { from?: Rect; closing?: boolean } = {}): boolean {
	const cur = runs.get(el);
	if (!motion()) { stop(el); return false; }
	const E0 = boxOf(el);
	if (!E0.w || !E0.h) { stop(el); return false; }
	let closing = !!opt.closing;
	let tile: Rect | null = null;
	if (kind === "close" && cur && !cur.ended && (cur.kind === "minimize" || cur.kind === "restore")) {
		// Closed on its way to the Dock: it keeps flying. On its way out of the Dock: back into the tile.
		if (cur.kind === "minimize") { cur.closing = true; return true; }
		kind = "minimize";
		tile = cur.tile;
	} else if (kind === "minimize" || kind === "restore") tile = tileRect(id);
	if (kind === "close") closing = true;

	// From where it is drawn now (an interrupted effect), else from its rest state.
	let start: Keyframe | null = null, share = 1;
	if (cur) {
		const cs = getComputedStyle(el);
		start = { transform: cs.transform, opacity: cs.opacity };
		if (OPPOSITE[cur.kind] === kind) share = progress(cur.anim);
		runs.delete(el);
		cur.anim.cancel();
	}
	const rest: Keyframe = { transform: "none", opacity: 1 };
	let frames: (E: Rect) => Keyframe[];
	switch (kind) {
		case "open":
			frames = (E) => [start ?? { transform: mapTo(E, scaled(E, OPEN_FROM)), opacity: 0 }, rest];
			break;
		case "close":
			frames = (E) => [start ?? rest, { transform: mapTo(E, scaled(E, CLOSE_TO)), opacity: 0 }];
			break;
		case "minimize":
			frames = (E) => {
				const end: Keyframe = { transform: mapTo(E, tile ? into(E, tile) : scaled(E, INPLACE)), opacity: 0 };
				if (start || !tile) return [start ?? rest, end];
				return [{ ...rest, offset: 0 }, { transform: mapTo(E, genieMid(E, tile)), offset: GENIE.at }, { opacity: 1, offset: 0.5 }, { ...end, offset: 1 }];
			};
			break;
		case "restore":
			frames = (E) => {
				const from: Keyframe = { transform: mapTo(E, tile ? into(E, tile) : scaled(E, INPLACE)), opacity: 0 };
				if (start || !tile) return [start ?? from, rest];
				return [{ ...from, offset: 0 }, { opacity: 1, offset: 0.4 }, { transform: mapTo(E, genieMid(E, tile)), offset: 1 - GENIE.at }, { ...rest, offset: 1 }];
			};
			break;
		case "flip": {
			// From the old box (its layout rect: a running effect's start would be relative to the old box, not this one).
			const from = opt.from, opacity = start?.opacity ?? 1;
			frames = (E) => [{ transform: from ? mapTo(E, from) : "none", opacity }, rest];
			break;
		}
	}
	el.dataset.fx = kind === "minimize" || kind === "close" ? "out" : "in";
	el.style.transformOrigin = "0 0";
	el.style.willChange = "transform, opacity";
	const anim = el.animate(frames(E0), { duration: Math.max(MIN_MS, MS[kind] * share), easing: EASE[kind], fill: "both" });
	const run: Run = { id, kind, anim, frames, tile, closing, ended: false };
	runs.set(el, run);
	anim.addEventListener("finish", () => finished(el, run));
	return true;
}

/** The element's box changed under its effect (the workspace resized: the top bar came or went): the same path, from the new box. */
function retarget(el: HTMLElement): void {
	const run = runs.get(el);
	if (!run || run.ended) return;
	(run.anim.effect as KeyframeEffect | null)?.setKeyframes(run.frames(boxOf(el)));
}

// ---- what Window.tsx reports after each render ----------------------------------------
/** A window as drawn (Window.tsx), compared with the last render to pick the effect. */
export interface FxState {
	visible: boolean;
	/** A ghost: the window was closed (drawn by Workspace.tsx until its effect ends). */
	closing: boolean;
	minimized: boolean;
	maximized: boolean;
	/** frame "normal" (only these get the maximize FLIP: a Wayland app redraws at its new size by itself). */
	framed: boolean;
	/** Its drawn geometry in the workspace. */
	g: Geom;
}
const sameGeom = (a: Geom, b: Geom) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

/**
 * After a render of window id (its element el): the effect for what changed
 * since `prev` (null: it was just mounted). Called from a layout effect, so
 * the DOM is final and nothing is painted yet.
 */
export function windowFx(el: HTMLElement, id: string, prev: FxState | null, now: FxState): void {
	if (!armed) arm();
	let started = false;
	if (!prev) {
		started = now.visible && !now.closing && play(el, id, "open");
	} else if (now.closing !== prev.closing) {
		if (now.closing) started = play(el, id, "close", { closing: true });
		else if (now.visible) started = play(el, id, "open"); // opened again while it closed
		else stop(el);
	} else if (now.visible !== prev.visible) {
		if (!now.visible && now.minimized) started = play(el, id, "minimize");
		else if (now.visible && prev.minimized) started = play(el, id, "restore");
		else stop(el); // compact mode's switching, a window hidden or shown otherwise: instant
	} else if (now.visible && !now.closing && now.framed && now.maximized !== prev.maximized) {
		started = play(el, id, "flip", { from: clientOf(el, prev.g) });
	} else if (!sameGeom(prev.g, now.g)) {
		retarget(el);
	}
	// A ghost with no effect to wait for goes now.
	if (now.closing && !started && !runs.get(el)?.closing) dropGhost(id);
}

/** The window's element is unmounted: its effect goes with it. */
export function windowGone(el: HTMLElement): void { stop(el); }

// ---- ghosts of closed windows -----------------------------------------------------------
interface Ghost {
	/** Its last state. */
	win: WmWindow;
	/** Between the windows that were under it and over it (the WM's z-indexes are even: drawn()). */
	z: number;
}
interface FxStore {
	ghosts: Record<string, Ghost>;
	/** Ids in the order their elements are in the DOM: the WM's windows with the ghosts kept in their places. */
	order: string[];
}
export const wmfx$ = createStore<FxStore>({ ghosts: {}, order: wm$.get().windows.map((w) => w.id) });

/** The ghosts and their order (Workspace.tsx); re-renders when they change. */
export function useWmFx(): FxStore {
	return useSyncExternalStore(wmfx$.subscribe, wmfx$.get);
}

function dropGhost(id: string): void {
	const f = wmfx$.get();
	if (!f.ghosts[id]) return;
	const ghosts = { ...f.ghosts };
	delete ghosts[id];
	const live = new Set(wm$.get().windows.map((w) => w.id));
	wmfx$.set({ ghosts, order: f.order.filter((o) => live.has(o) || ghosts[o]) });
}

/** A window drawn by Workspace.tsx: a live one at its z-order, or a ghost. */
export interface Drawn { win: WmWindow; z: number; ghost: boolean }
/**
 * The windows to draw, in a stable DOM order (React never moves an element:
 * a moved iframe would load again): the WM's windows at z-index 2, 4, 6... by
 * their z-order, and the ghosts at the odd z-index between their old
 * neighbours.
 */
export function drawn(s: WmState, f: FxStore): Drawn[] {
	const out: Drawn[] = [];
	const live = new Map(s.windows.map((w) => [w.id, w]));
	const seen = new Set<string>();
	const add = (id: string) => {
		const w = live.get(id);
		if (w) out.push({ win: w, z: 2 * (s.order.indexOf(id) + 1), ghost: false });
		else if (f.ghosts[id]) out.push({ win: f.ghosts[id]!.win, z: f.ghosts[id]!.z, ghost: true });
		else return;
		seen.add(id);
	};
	for (const id of f.order) add(id);
	for (const w of s.windows) if (!seen.has(w.id)) add(w.id); // opened since the order was last kept
	return out;
}

// Keep the order and the ghosts with the WM's every change.
let last = wm$.get();
wm$.subscribe(() => {
	const s = wm$.get(), p = last;
	last = s;
	if (s.windows === p.windows) return;
	const f = wmfx$.get();
	const live = new Set(s.windows.map((w) => w.id));
	let ghosts = f.ghosts;
	const on = motion();
	for (const w of p.windows) {
		if (live.has(w.id) || !on || !(isVisible(w, p) || flying(w.id))) continue;
		const g: Ghost = { win: w, z: 2 * p.order.indexOf(w.id) + 1 };
		ghosts = { ...ghosts, [w.id]: g };
		setTimeout(() => { if (wmfx$.get().ghosts[w.id] === g) dropGhost(w.id); }, GHOST_MS);
	}
	// Opened again: the live window takes the ghost's place (and element).
	for (const id of Object.keys(ghosts)) {
		if (!live.has(id)) continue;
		ghosts = { ...ghosts };
		delete ghosts[id];
	}
	const order = f.order.filter((id) => live.has(id) || ghosts[id]);
	for (const w of s.windows) if (!order.includes(w.id)) order.push(w.id);
	if (ghosts !== f.ghosts || order.join("\n") !== f.order.join("\n")) wmfx$.set({ ghosts, order });
});
