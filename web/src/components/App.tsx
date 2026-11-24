// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The page: the desktop (#desktop: its workspace, Workspace.tsx, holds the window manager's
// windows: the terminals, the guest preview's Browser window, wm.ts) on the
// wallpaper (Wallpaper.tsx, under everything in #app), the top bar (TopBar.tsx: the menus, the status icons, the
// clock), the key bar, the Dock at the bottom (Dock.tsx), the layer the guest's display window may
// cover the page with on phones (Display.tsx), and over
// them the paste dialog and the toast; the boot shows in the top bar
// (BootIndicator.tsx) and in the console's window (#app's data-blank: its
// placeholder until the first line); the system apps
// (Settings and System, sysapps.ts) and the Wayland apps (wayland.ts) are windows like the terminals. Also the page-wide behaviour: the keyboard
// shortcuts (keys.ts; the HUD that shows them while the prefix is armed, KeysHud.tsx), following the visual viewport (the on-screen
// keyboard), when the key bar shows, and the pinch that sets the font size
// on phones.
import { useEffect, useRef, type RefObject } from "react";
import { trackBottom } from "../bottom.ts";
import { KW } from "../kw.ts";
import { installShortcuts } from "../keys.ts";
import { ui$, useStore } from "../store.ts";
import { terminalHasFocus } from "../termtabs.ts";
import { useWm } from "../wm.ts";
import { Dock } from "./Dock.tsx";
import { Display } from "./Display.tsx";
import { Keys } from "./Keys.tsx";
import { KeysHud } from "./KeysHud.tsx";
import { Launchpad } from "./Launcher.tsx";
import { useBlank } from "./BootIndicator.tsx";
import { Confirm, PasteDialog, ResumeCard, Toast } from "./Overlays.tsx";
import { Apps } from "./Apps.tsx";
import { TopBar } from "./TopBar.tsx";
import { Wallpaper } from "./Wallpaper.tsx";
import { Workspace } from "./Workspace.tsx";

export function App() {
	const cfg = KW.config;
	const state = useStore((s) => s.state);
	const blank = useBlank();
	const compact = useWm((s) => s.compact);
	const app = useRef<HTMLDivElement>(null);

	useViewport(app);
	useKeyBar(cfg.mobile);
	usePinchFont(cfg.mobile);
	// Before boot.ts adds display.ts's key listener, so the prefix comes first.
	useEffect(installShortcuts, []);

	return (
		<>
			<div id="app" ref={app} data-state={state} data-blank={blank} className={`fixed inset-x-0 top-0 flex h-dvh flex-col ${cfg.mobile ? "mobile" : ""} ${compact ? "compact" : ""}`}>
				{/* Out of the flow, under the rest (the default wallpaper is #app's own background). */}
				<Wallpaper />
				{/* The desktop: the windows. */}
				<div className="relative flex min-h-0 flex-1">
					<main id="desktop" className="relative min-h-0 min-w-0 flex-1">
						<Workspace />
					</main>
					{/* Over the desktop and whatever window is shown on it. */}
					<ResumeCard />
				</div>
				<Keys />
				<Dock />
				{/* Across the top, over the desktop (and the Resume card); the workspace starts below it. */}
				<TopBar />
				{/* The Display window's content while it covers the whole page, the Dock and the top bar included (phones: rotated, full screen). */}
				<Display />
			</div>
			{/* The system apps' content (portals into their windows: sysapps.ts). */}
			<Apps />
			<Launchpad />
			{/* While the shortcut prefix is armed (keys.ts): what each key does. */}
			<KeysHud />
			<PasteDialog />
			<Confirm />
			<Toast />
		</>
	);
}

/**
 * The on-screen keyboard: with interactive-widget=resizes-content Chrome
 * shrinks the layout viewport itself; elsewhere (iOS, older Chrome) follow
 * the visual viewport.
 *
 * And keep the console's terminal at its bottom when it gets shorter (the
 * keyboard, the key bar): bottom.ts, set up here at mount, before boot.ts
 * makes wterm, and run synchronously in the viewport events. wterms.ts
 * does the same for the other terminals.
 */
function useViewport(app: RefObject<HTMLDivElement | null>) {
	useEffect(() => {
		const el = app.current!, bottom = trackBottom(document.getElementById("term")!), vv = visualViewport;
		const apply = () => {
			// The on-screen keyboard is up (not a pinch zoom, which also shrinks the visual viewport): style.css hides the top bar and the Dock.
			document.documentElement.classList.toggle("kb", !!vv && Math.abs(vv.scale - 1) <= 0.01 && vv.height < document.documentElement.clientHeight - 120);
			if (!vv || Math.abs(vv.scale - 1) > 0.01) { el.style.height = ""; el.style.top = ""; }
			else {
				// Whole px, rounded down, so the page never runs past the screen's bottom edge.
				const full = standaloneHeight(vv.height);
				el.style.height = `${Math.floor(full ?? vv.height)}px`;
				el.style.top = `${full ? 0 : Math.floor(vv.offsetTop)}px`;
			}
			bottom.keep();
		};
		const rotate = () => setTimeout(apply, 250);
		// The keyboard going away with the focus (standaloneHeight() asks for it).
		const blur = () => setTimeout(apply, 0);
		vv?.addEventListener("resize", apply);
		vv?.addEventListener("scroll", apply);
		addEventListener("resize", bottom.keep);
		addEventListener("orientationchange", rotate);
		document.addEventListener("focusout", blur);
		apply();
		return () => {
			bottom.dispose();
			vv?.removeEventListener("resize", apply);
			vv?.removeEventListener("scroll", apply);
			removeEventListener("resize", bottom.keep);
			removeEventListener("orientationchange", rotate);
			document.removeEventListener("focusout", blur);
		};
	}, [app]);
}

/**
 * The key bar: phones only, and only while the on-screen keyboard is up: the
 * terminal has the focus and the visual viewport is well below the tallest
 * seen at this width (the keyboard takes that space; a hardware keyboard
 * takes none, and then the bar is not needed). A rotation starts the
 * measuring over.
 */
function useKeyBar(mobile: boolean) {
	useEffect(() => {
		if (!mobile) return;
		let tallest = 0, tallestW = 0;
		const update = () => {
			const h = visualViewport?.height ?? innerHeight;
			if (innerWidth !== tallestW) { tallest = 0; tallestW = innerWidth; }
			tallest = Math.max(tallest, h);
			const on = h < tallest - 120 && terminalHasFocus(); // a terminal itself, never wland's input sink
			if (ui$().get().keysOn !== on) ui$().set({ keysOn: on });
		};
		const later = () => setTimeout(update, 0); // after focus lands elsewhere
		update();
		visualViewport?.addEventListener("resize", update);
		addEventListener("resize", update);
		document.addEventListener("focusin", update);
		document.addEventListener("focusout", later);
		return () => {
			visualViewport?.removeEventListener("resize", update);
			removeEventListener("resize", update);
			document.removeEventListener("focusin", update);
			document.removeEventListener("focusout", later);
		};
	}, [mobile]);
}

/**
 * The page's height in an iOS home screen app (standalone): the layout
 * viewport's (what a fixed element with inset 0 fills), unless the on-screen
 * keyboard is up. The visual viewport can stay short after the keyboard
 * closed, which would leave a dead strip at the bottom. Not the screen's
 * height: the viewport can be shorter (index.html's status bar style), and
 * what is past it is not shown. Undefined elsewhere.
 */
function standaloneHeight(vvHeight: number): number | undefined {
	if ((navigator as Navigator & { standalone?: boolean }).standalone !== true) return;
	const full = document.documentElement.clientHeight;
	// Only a focused field can have the keyboard up, and it takes well over 120 px.
	const el = document.activeElement as HTMLElement | null;
	const editable = !!el && (el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA");
	if (editable && vvHeight < full - 120) return;
	return full;
}

/**
 * Phones: a pinch on the terminal sets the font size (whole px, 9 to 24,
 * kept like the Font size option) and never zooms the page. iOS ignores
 * user-scalable=no: cancelling Safari's gesture events and every two-finger
 * touchmove is what stops its zoom. Linear and damped: 1 px of font per
 * PINCH_STEP px the fingers move apart or together (a ratio of finger
 * distances swings straight to the limits). The start is taken when the
 * second finger lands, not at the first move.
 */
function usePinchFont(mobile: boolean) {
	useEffect(() => {
		if (!mobile) return;
		const PINCH_STEP = 30;
		const span = (t: TouchList) => Math.hypot(t[0]!.clientX - t[1]!.clientX, t[0]!.clientY - t[1]!.clientY);
		let pinch: { d: number; size: number; on: boolean } | null = null;
		const startPinch = (e: TouchEvent) => {
			// Not over the guest's display or its touch controls (a d-pad and a button held at once).
			const onDisplay = [...e.touches].some((t) => !!(t.target as Element | null)?.closest?.("#fb-layer"));
			pinch = { d: span(e.touches), size: ui$().get().fontSize, on: !onDisplay && !!(e.target as Element | null)?.closest?.("#desktop") };
		};
		const start = (e: TouchEvent) => { if (e.touches.length === 2) startPinch(e); };
		const move = (e: TouchEvent) => {
			if (e.touches.length < 2) return;
			if (e.cancelable) e.preventDefault(); // no page zoom
			if (!pinch) startPinch(e);
			if (!pinch!.on) return;
			const n = Math.min(24, Math.max(9, Math.round(pinch!.size + (span(e.touches) - pinch!.d) / PINCH_STEP)));
			if (n !== ui$().get().fontSize) KW.ui!.setFont(String(n));
		};
		const end = (e: TouchEvent) => { if (e.touches.length < 2) pinch = null; };
		const gesture = (e: Event) => e.preventDefault();
		document.addEventListener("touchstart", start, { passive: true });
		document.addEventListener("touchmove", move, { passive: false });
		document.addEventListener("touchend", end);
		document.addEventListener("touchcancel", end);
		for (const type of ["gesturestart", "gesturechange", "gestureend"]) document.addEventListener(type, gesture, { passive: false });
		return () => {
			document.removeEventListener("touchstart", start);
			document.removeEventListener("touchmove", move);
			document.removeEventListener("touchend", end);
			document.removeEventListener("touchcancel", end);
			for (const type of ["gesturestart", "gesturechange", "gestureend"]) document.removeEventListener(type, gesture);
		};
	}, [mobile]);
}
