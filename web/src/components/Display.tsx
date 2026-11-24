// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The Display window's content (display.ts has the window, the state and
// the keyboard routing), rendered into its element (#fb-layer,
// displayHost()) while a program has the display open:
// - #fb-layer sits in the window's body. On touch devices while the window
//   is shown it may cover the whole page instead, Dock included (#fb-cover,
//   over the page): turned a quarter turn clockwise while the page is
//   portrait and the rotate option is on (off by default: display.ts), so
//   the phone is held sideways, or unturned in full screen. The element is
//   moved between the two, never remade, so the picture and the controls
//   keep their state. Pointer positions are turned back into its own frame
//   (display.ts unturn(), localPos());
// - a canvas (#fb) in it, scaled to fit the content box with the aspect
//   ratio kept (by an integer when that loses little, so pixels stay sharp;
//   letterboxed on the black backdrop), relaid out when the box changes size
//   (the window resized, rotation: the mode stays), and repainted from the
//   guest's pixels once per animation frame while the window is shown (the
//   SDK's frame(); the guest is suspended whenever this runs). In worker
//   mode frame() is the latest frame the worker sent (or put in the shared
//   frame buffer): it is painted only when frameSeq says it is new, and each
//   animation frame asks for the next. While a GL client has virtio-gpu's
//   scanout (gl and gpu: the Guest GL option), the picture is the renderer's
//   latest frame (gl.gpu.drawFrame(): an ImageBitmap of its WebGL2 canvas,
//   no readback), in both modes;
// - mouse, absolute: while a program has the tablet (event2) open, e.g. X,
//   the pointer over the canvas is sent as absolute positions (the canvas's
//   on-screen rectangle is the whole picture), buttons and the wheel go to
//   the tablet, the host cursor is hidden over the picture (the guest draws
//   its own), and nothing locks. A drag keeps going outside it (pointer
//   capture) and ends at the release. This wins when a program has both
//   mice open;
// - mouse, relative: otherwise, with the evdev mouse open (games), a click
//   on the canvas takes pointer lock (desktop); motion, buttons and the
//   wheel then go to the guest. Esc leaves pointer lock, as the browser
//   does it, and so does the window losing the focus, hiding or closing.
//   The window's title bar and edges are outside the content, and a move or
//   resize keeps canvases from taking pointer events (wm.ts follow()), so
//   they send the guest nothing;
// - on touch devices an overlay (#pad) over the picture: the stick, the
//   buttons and the chips (Pad.tsx).
//   While a program reads a mouse, the whole content under the
//   controls (#fb-touch, letterbox included) takes touches: with the
//   tablet open in "mouse" mode the pointer goes where the finger is (tap =
//   left click there), in "trackpad" mode a drag moves it from where it is
//   (tap = left click); the chip at the top right switches, and is kept in
//   localStorage. With only the relative mouse open it is always a
//   trackpad.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import {
	DISPLAY_WIN, displayHost, displayOpts, evdev, isRotated, localPos, pointerLocked, unturn, useFullscreen, type DisplayUiOptions,
} from "../display.ts";
import { useSize } from "../hooks.ts";
import { BTN_LEFT, BTN_MIDDLE, BTN_RIGHT, KernelInstance, domButtonToLinux } from "../sdk.ts";
import { useStore, type DisplayState, type TouchMode } from "../store.ts";
import { isVisible, useWm } from "../wm.ts";
import { Pad } from "./Pad.tsx";
import { adoptContent } from "./Window.tsx";

/** PointerEvent.buttons bits and their evdev buttons. */
const BUTTON_BITS: Array<[number, number]> = [[1, BTN_LEFT], [2, BTN_RIGHT], [4, BTN_MIDDLE]];

// ---- pointer helpers ----------------------------------------------------------
/** Where the absolute pointer is, 0..1: trackpad mode moves it from here. */
const tabletPos = { x: 0.5, y: 0.5 };
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const aim = (x: number, y: number) => {
	tabletPos.x = x;
	tabletPos.y = y;
	evdev()?.moveTo(x, y);
};
/** A short left click: the tablet's while a program reads it, else the mouse's. */
function tapClick(): void {
	const ev = evdev();
	if (ev?.tabletOpen) {
		if (ev.tabletButton(BTN_LEFT, true)) setTimeout(() => ev.tabletButton(BTN_LEFT, false), 40);
	} else if (ev?.button(BTN_LEFT, true)) setTimeout(() => ev.button(BTN_LEFT, false), 40);
}
/** A finger that moved less than this (px) within TAP_MS is a tap. */
const TAP_PX = 10, TAP_MS = 250;
/** Trackpad speed: picture pixels per CSS pixel the finger moves, times the picture's scale. */
const TRACK_GAIN = 1.5;

/** The touch controls' padding: the safe areas of the page edges each side is on while covering the page, else a plain margin. */
const PAD_IN_WINDOW = { "--pl": "12px", "--pr": "12px", "--pt": "8px", "--pb": "12px" };
const PAD_COVER = { "--pl": "max(12px, var(--sl))", "--pr": "max(12px, var(--sr))", "--pt": "max(8px, var(--st))", "--pb": "max(12px, var(--sb))" };
const PAD_TURNED = { "--pl": "max(12px, var(--st))", "--pr": "max(12px, var(--sb))", "--pt": "max(8px, var(--sr))", "--pb": "max(12px, var(--sl))" };

/**
 * Rendered once in the page (App.tsx): the page-covering layer (#fb-cover,
 * empty unless it holds #fb-layer), and while a program has the display open
 * the content, through a portal into #fb-layer wherever that is.
 */
export function Display() {
	const d = useStore((s) => s.display);
	const opts = displayOpts();
	const host = displayHost();
	const [cover, setCover] = useState<HTMLDivElement | null>(null);
	const app = cover?.parentElement ?? null;
	const ap = useSize(app);
	const full = useFullscreen();
	// Re-render when the window comes and goes, so the element goes back where it belongs (below).
	const win = useWm((s) => s.windows.some((w) => w.id === DISPLAY_WIN));
	// The window is shown (not minimized; in compact mode the top one).
	const shown = useWm((s) => { const w = s.windows.find((x) => x.id === DISPLAY_WIN); return !!w && isVisible(w, s); });
	const live = !!opts && d.attached && win;
	const rot = live && isRotated(ap.w, ap.h);
	const covering = live && shown && !!opts?.touch && (rot || full);
	const turned = covering && rot;
	// The content's place: the page-covering layer, or the window's body (which mounts it at first, and takes it back: Window.tsx adoptContent()).
	useLayoutEffect(() => {
		if (covering) { if (cover && host.parentElement !== cover) cover.appendChild(host); }
		else if (cover && host.parentElement === cover) adoptContent(DISPLAY_WIN);
		const st = host.style;
		if (turned) {
			st.width = `${ap.h}px`; st.height = `${ap.w}px`;
			st.transformOrigin = "0 0"; st.transform = `translateX(${ap.w}px) rotate(90deg)`;
			host.dataset.rotated = "";
		} else {
			st.width = st.height = st.transformOrigin = st.transform = "";
			delete host.dataset.rotated;
		}
	});
	const pads = (turned ? PAD_TURNED : covering ? PAD_COVER : PAD_IN_WINDOW) as unknown as CSSProperties;
	return (
		<>
			{/* Over the whole page, the Dock included, while it holds the content. */}
			<div id="fb-cover" ref={setCover} className={covering ? "absolute inset-0 z-(--z-cover) overflow-hidden bg-black" : "hidden"} />
			{live && opts && createPortal(
				<Content opts={opts} host={host} d={d} shown={shown} turned={turned} covering={covering} portrait={ap.h > ap.w} pads={pads} />,
				host,
			)}
		</>
	);
}

function Content({ opts, host, d, shown, turned, covering, portrait, pads }: {
	opts: DisplayUiOptions; host: HTMLElement; d: DisplayState; shown: boolean;
	turned: boolean; covering: boolean; portrait: boolean; pads: CSSProperties;
}) {
	const box = useSize(host);
	return (
		<>
			<Backdrop />
			<Picture opts={opts} aw={box.w} ah={box.h} rot={turned} live={shown} width={d.width} height={d.height} mouse={d.mouse} tablet={d.tablet} touchMode={d.touchMode} />
			{opts.touch && (
				<Pad opts={opts} rot={turned} covering={covering} portrait={portrait} rotate={d.rotate} layout={d.layout} tablet={d.tablet} touchMode={d.touchMode} controls={d.controls} pads={pads} />
			)}
		</>
	);
}

// ---- backdrop -----------------------------------------------------------------
// Behind the canvas (and the touch controls), filling the content box: it
// takes every pointer, touch and wheel event that misses the picture or a
// control, so nothing scrolls, selects or takes the focus (which would bring
// up a phone's keyboard).
function Backdrop() {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const b = ref.current!;
		const cancel = (e: Event) => { if (e.cancelable) e.preventDefault(); };
		// Native listeners: React's wheel and touchmove listeners are passive.
		b.addEventListener("wheel", cancel, { passive: false });
		b.addEventListener("touchmove", cancel, { passive: false });
		b.addEventListener("selectstart", cancel);
		return () => {
			b.removeEventListener("wheel", cancel);
			b.removeEventListener("touchmove", cancel);
			b.removeEventListener("selectstart", cancel);
		};
	}, []);
	return (
		<div
			ref={ref}
			id="fb-backdrop"
			className="absolute inset-0 z-2 touch-none bg-black select-none [-webkit-tap-highlight-color:transparent] [-webkit-touch-callout:none]"
			onPointerDown={(e) => e.preventDefault() /* no selection, no focus change */}
			onContextMenu={(e) => e.preventDefault()}
			onDoubleClick={(e) => e.preventDefault()}
		/>
	);
}

// ---- picture ------------------------------------------------------------------
function Picture({ opts, aw, ah, rot, live, width, height, mouse, tablet, touchMode }: {
	opts: DisplayUiOptions; aw: number; ah: number; rot: boolean; live: boolean; width: number; height: number; mouse: boolean; tablet: boolean; touchMode: TouchMode;
}) {
	const ref = useRef<HTMLCanvasElement>(null);
	const absolute = () => !!evdev()?.tabletOpen;

	// Repaint once per animation frame while the guest has the display open and the window is shown.
	useEffect(() => {
		if (!live) return;
		const c = ref.current!;
		const image = new ImageData(width, height);
		const ctx = c.getContext("2d")!;
		let raf = 0, shown = -1, glForce = true;
		const paint = () => {
			raf = 0;
			const vm = opts.vm();
			if (!vm) return;
			// A GL client on virtio-gpu's scanout (gl and gpu): its latest frame
			// comes from the renderer on this thread, drawn without a readback;
			// null when no 3D resource is on the scanout.
			const gl = vm.gl?.gpu?.drawFrame(ctx, glForce);
			if (gl !== undefined && gl !== null) {
				if (gl) glForce = false;
			} else if (vm instanceof KernelInstance) {
				if (vm.kernel.result) return;
				if (!vm.frame(image.data)) return;
				ctx.putImageData(image, 0, 0);
			} else if (vm.frameSeq !== shown) {
				// Worker mode: paint a frame once (frame() also asks for the next).
				const f = vm.frame(image.data);
				if (f && f.width === width && f.height === height) {
					ctx.putImageData(image, 0, 0);
					shown = vm.frameSeq;
				}
			} else vm.requestFrame();
			raf = requestAnimationFrame(paint);
		};
		raf = requestAnimationFrame(paint);
		return () => cancelAnimationFrame(raf);
	}, [opts, width, height, live]);

	// Document-wide mouse input while the canvas holds pointer lock, and
	// releases anywhere, so no button stays down.
	useEffect(() => {
		const c = ref.current!;
		const scale = () => c.width / Math.max(1, c.offsetWidth);
		const onMove = (e: MouseEvent) => { if (pointerLocked()) evdev()?.move(e.movementX * scale(), e.movementY * scale()); };
		const onDown = (e: MouseEvent) => {
			const b = domButtonToLinux(e.button);
			if (pointerLocked() && b !== undefined) { e.preventDefault(); evdev()?.button(b, true); }
		};
		const onUp = (e: MouseEvent) => {
			const b = domButtonToLinux(e.button);
			if (b !== undefined) evdev()?.button(b, false);
		};
		const onPointerUp = (e: PointerEvent) => {
			if (e.pointerType !== "touch" && !e.buttons) for (const [, code] of BUTTON_BITS) evdev()?.tabletButton(code, false);
		};
		const onLockChange = () => { if (!pointerLocked()) for (const b of [BTN_LEFT, BTN_RIGHT, BTN_MIDDLE]) evdev()?.button(b, false); };
		const onWheel = (e: WheelEvent) => {
			if (absolute()) {
				e.preventDefault();
				if (e.deltaY) evdev()?.tabletWheel(e.deltaY < 0 ? 1 : -1);
				return;
			}
			if (!pointerLocked()) return;
			e.preventDefault();
			if (e.deltaY) evdev()?.wheel(e.deltaY < 0 ? 1 : -1);
		};
		document.addEventListener("mousemove", onMove);
		document.addEventListener("mousedown", onDown);
		document.addEventListener("mouseup", onUp);
		document.addEventListener("pointerup", onPointerUp);
		document.addEventListener("pointerlockchange", onLockChange);
		c.addEventListener("wheel", onWheel, { passive: false }); // React's is passive
		return () => {
			document.removeEventListener("mousemove", onMove);
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("mouseup", onUp);
			document.removeEventListener("pointerup", onPointerUp);
			document.removeEventListener("pointerlockchange", onLockChange);
			c.removeEventListener("wheel", onWheel);
			evdev()?.releaseAll();
			if (pointerLocked()) document.exitPointerLock();
		};
	}, []);

	/**
	 * The pointer's position on the picture, 0..1, snapped to the centre of
	 * the guest pixel under it (the canvas is the picture at the mode's size),
	 * so the guest's scaling to its screen (X: the mode) cannot round it to a
	 * neighbour; outside the picture it clamps to the edge.
	 */
	const to = (e: ReactPointerEvent) => {
		const c = ref.current!, p = localPos(c, rot, e);
		const px = Math.min(c.width - 1, Math.max(0, Math.floor(p.x * c.width)));
		const py = Math.min(c.height - 1, Math.max(0, Math.floor(p.y * c.height)));
		aim((px + 0.5) / c.width, (py + 0.5) / c.height);
	};
	/** Tablet buttons follow e.buttons, so chords (a second button during a drag) work too. */
	const syncButtons = (e: ReactPointerEvent) => {
		for (const [bit, code] of BUTTON_BITS) evdev()?.tabletButton(code, !!(e.buttons & bit));
	};
	const scale = () => { const c = ref.current!; return c.width / Math.max(1, c.offsetWidth); };

	// Touch: with the tablet open in mouse mode a touchscreen (the pointer
	// follows the finger, a tap clicks where it is); otherwise a trackpad
	// (drags move the pointer from where it is, a short tap clicks). On the
	// canvas, and on touch devices on the whole content box (#fb-touch).
	const touches = useRef(new Map<number, { x: number; y: number; t: number; moved: number }>());
	const direct = () => absolute() && touchMode === "mouse";
	const touchDown = (e: ReactPointerEvent) => {
		e.preventDefault();
		e.currentTarget.setPointerCapture(e.pointerId);
		touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now(), moved: 0 });
		if (direct()) to(e);
	};
	const touchMove = (e: ReactPointerEvent) => {
		const t = touches.current.get(e.pointerId);
		if (!t) return;
		const [dx, dy] = unturn(rot, e.clientX - t.x, e.clientY - t.y);
		t.x = e.clientX;
		t.y = e.clientY;
		t.moved += Math.abs(dx) + Math.abs(dy);
		const c = ref.current!;
		if (direct()) to(e);
		else if (absolute()) aim(clamp01(tabletPos.x + dx * TRACK_GAIN / Math.max(1, c.offsetWidth)), clamp01(tabletPos.y + dy * TRACK_GAIN / Math.max(1, c.offsetHeight)));
		else evdev()?.move(dx * scale() * TRACK_GAIN, dy * scale() * TRACK_GAIN);
	};
	const touchEnd = (e: ReactPointerEvent) => {
		const s = touches.current.get(e.pointerId);
		if (!s) return;
		touches.current.delete(e.pointerId);
		if (e.type === "pointerup" && s.moved < TAP_PX && performance.now() - s.t < TAP_MS) tapClick();
	};

	// Fit into the content box: centred, aspect kept, an integer scale if that keeps >= 90% of the size.
	let s = Math.min(aw / width, ah / height);
	const whole = Math.floor(s);
	const sharp = whole >= 1 && whole / s >= 0.9;
	if (sharp) s = whole;
	const cw = Math.round(width * s), ch = Math.round(height * s);

	return (
		<>
			<canvas
				ref={ref}
				id="fb"
				width={width}
				height={height}
				className="absolute z-3 touch-none bg-black"
				style={{
					width: cw, height: ch, left: Math.floor((aw - cw) / 2), top: Math.floor((ah - ch) / 2),
					imageRendering: sharp ? "pixelated" : "auto",
					// Pointer input only while a program reads a mouse (relative or the
					// tablet); otherwise taps go through. With the tablet the guest
					// draws the cursor, so the host's is hidden there.
					pointerEvents: mouse || tablet ? "auto" : "none",
					cursor: tablet ? "none" : undefined,
				}}
				onDoubleClick={(e) => e.preventDefault()}
				onContextMenu={(e) => { if (pointerLocked() || absolute() || opts.touch) e.preventDefault(); }}
				onClick={() => {
					if (!opts.touch && !absolute() && evdev()?.mouseOpen && !pointerLocked()) void ref.current!.requestPointerLock?.();
				}}
				onPointerDown={(e) => {
					if (e.pointerType === "touch") return touchDown(e);
					if (!absolute()) return;
					e.preventDefault();
					e.currentTarget.setPointerCapture(e.pointerId); // a drag keeps going outside the picture
					to(e);
					syncButtons(e);
				}}
				onPointerMove={(e) => {
					if (e.pointerType !== "touch") {
						if (!absolute()) return;
						to(e);
						syncButtons(e);
						return;
					}
					touchMove(e);
				}}
				onPointerUp={(e) => {
					if (e.pointerType !== "touch") syncButtons(e);
					else touchEnd(e);
				}}
				onPointerCancel={touchEnd}
				onLostPointerCapture={(e) => {
					if (e.pointerType !== "touch" && !e.buttons) for (const [, code] of BUTTON_BITS) evdev()?.tabletButton(code, false);
				}}
			/>
			{/* Touch devices: the whole content box is the pointer surface, letterbox included (the controls sit above it). */}
			{opts.touch && (mouse || tablet) && (
				<div id="fb-touch" className="absolute inset-0 z-3 touch-none select-none [-webkit-touch-callout:none]"
					onPointerDown={touchDown} onPointerMove={touchMove} onPointerUp={touchEnd} onPointerCancel={touchEnd}
					onContextMenu={(e) => e.preventDefault()} onDoubleClick={(e) => e.preventDefault()} />
			)}
		</>
	);
}
