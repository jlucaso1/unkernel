// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Small React hooks the chrome shares, and one media query kept as a value:
// - useOutsidePress(): a press outside an element (or outside what a test
//   accepts), on the document in the capture phase, so a handler that stops
//   the event further down does not hide it (Menu.tsx, the Overview's
//   tapped segment);
// - useSize(): an element's content size, kept up to date (Display.tsx,
//   AppShell.tsx);
// - useTick(): a re-render every so often while a condition holds (a clock);
// - useLongPress(): a press held in place on touch (or with any pointer)
//   for a menu or an alternative action, and the click that ends it
//   swallowed (the Dock's tiles, the launcher's cells, the tab strip's +);
// - reducedMotion(): prefers-reduced-motion, read from a boolean its change
//   event keeps, so a hot path (the Dock's magnification on each pointer
//   move, wmfx.ts per effect) does not query the media each time.
import { useEffect, useLayoutEffect, useReducer, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

/** Inside the element of a ref, or a test of the press's target. */
type Inside = RefObject<Element | null> | ((target: EventTarget | null) => boolean);

/**
 * Calls onPress for each press (pointerdown) outside `inside` while `active`.
 * The latest onPress and `inside` are used; the listener comes and goes with
 * `active` only.
 */
export function useOutsidePress(inside: Inside, onPress: (e: PointerEvent) => void, active = true): void {
	const cb = useRef({ inside, onPress });
	cb.current = { inside, onPress };
	useEffect(() => {
		if (!active) return;
		const down = (e: PointerEvent) => {
			const t = cb.current.inside;
			const within = typeof t === "function" ? t(e.target) : !!t.current?.contains(e.target as Node);
			if (!within) cb.current.onPress(e);
		};
		document.addEventListener("pointerdown", down, true);
		return () => document.removeEventListener("pointerdown", down, true);
	}, [active]);
}

/** The element's content size (clientWidth, clientHeight), kept up to date; measured before paint. */
export function useSize(el: HTMLElement | null): { w: number; h: number } {
	const [size, setSize] = useState({ w: el?.clientWidth ?? 0, h: el?.clientHeight ?? 0 });
	useLayoutEffect(() => {
		if (!el) return;
		const read = () => setSize((s) => (s.w === el.clientWidth && s.h === el.clientHeight ? s : { w: el.clientWidth, h: el.clientHeight }));
		read();
		if (typeof ResizeObserver !== "function") {
			addEventListener("resize", read);
			return () => removeEventListener("resize", read);
		}
		const ro = new ResizeObserver(read);
		ro.observe(el);
		return () => ro.disconnect();
	}, [el]);
	return size;
}

/** Re-renders the component every `ms` while `active`. */
export function useTick(ms: number, active = true): void {
	const [, tick] = useReducer((n: number) => n + 1, 0);
	useEffect(() => {
		if (!active) return;
		const t = setInterval(tick, ms);
		return () => clearInterval(t);
	}, [ms, active]);
}

/** Where a long press happened: the point (client px) and the element it was on. */
export interface LongPressAt { x: number; y: number; el: HTMLElement }

/**
 * A long press: held `ms` without the pointer moving more than `slop` px
 * (Infinity: any move) calls onLong; a lift, a cancel, leaving the element
 * or a scroll (pointercancel) before then ends it. Touch and pen only unless
 * `mouse` (then the main button too). Without onLong nothing starts.
 * Returns the element's handlers; `consumed()`, for its click: true once
 * after a long press fired (that click does nothing else); `context()`, for
 * its contextmenu: ends a pending press, which the browser's own long press
 * (Android) turned into this contextmenu, so its click is consumed too;
 * returns whether the long press had fired already.
 */
export function useLongPress(onLong: ((at: LongPressAt) => void) | undefined, { ms = 500, slop = 8, mouse = false }: { ms?: number; slop?: number; mouse?: boolean } = {}) {
	const press = useRef<{ x: number; y: number; timer: number } | null>(null);
	const fired = useRef(false);
	const fn = useRef(onLong);
	fn.current = onLong;
	const cancel = () => { if (press.current) { clearTimeout(press.current.timer); press.current = null; } };
	useEffect(() => cancel, []);
	const handlers = {
		onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
			fired.current = false;
			cancel();
			if (!fn.current || e.button !== 0 || (e.pointerType === "mouse" && !mouse)) return;
			const at = { x: e.clientX, y: e.clientY, el: e.currentTarget };
			press.current = { x: at.x, y: at.y, timer: window.setTimeout(() => { press.current = null; fired.current = true; fn.current?.(at); }, ms) };
		},
		onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
			const p = press.current;
			if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > slop) cancel();
		},
		onPointerUp: cancel,
		onPointerCancel: cancel,
		onPointerLeave: cancel,
	};
	const consumed = (): boolean => { const f = fired.current; fired.current = false; return f; };
	const context = (): boolean => {
		const was = fired.current;
		if (press.current) fired.current = true;
		cancel();
		return was;
	};
	return { handlers, consumed, context };
}

/** prefers-reduced-motion: reduce, as its change event last left it. */
let reduced = false;
if (typeof matchMedia === "function") {
	const mq = matchMedia("(prefers-reduced-motion: reduce)");
	reduced = mq.matches;
	mq.addEventListener?.("change", (e) => { reduced = e.matches; });
}
/** The user asks for less motion (prefers-reduced-motion). */
export const reducedMotion = (): boolean => reduced;
