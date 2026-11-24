// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The desktop's context menu (Menu.tsx, at the pointer): New Terminal (a
// new Terminal window), Settings… (its last section), System… (System's
// Overview; both named and drawn by their descriptors, sysapps.ts), Change Wallpaper… (Settings > Desktop), Apps… (the
// launcher). Opened by a right click or a long press on touch (LONG_PRESS
// without moving more than SLOP) on the bare desktop only: a press whose
// target is #desktop itself or the workspace (#workspace, Workspace.tsx), so not on
// a window (its own right click: the terminals, the Display, the Wayland
// apps), wland's #wl-desktop (no pointer events, so presses go through it),
// the top bar or the Dock (siblings of #desktop, App.tsx). Only there is the
// browser's own menu prevented. The listeners are on #desktop; the menu is a
// portal into the body, so no stacking context of the desktop's holds it. Esc
// gives the focus back to where it was.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toggleLauncher } from "../launcher.ts";
import { newTerminalWindow } from "../terminals.ts";
import { ui$ } from "../store.ts";
import { openSection, openSettings, SETTINGS, SYSTEM } from "../sysapps.ts";
import { openItem } from "../winmenu.tsx";
import { GridIcon, PromptIcon, WallpaperIcon } from "./icons.tsx";
import { menuKeys } from "./KeyHint.tsx";
import { Menu, type MenuClose, type MenuEntry } from "./Menu.tsx";

const LONG_PRESS = 500, SLOP = 8;

function items(): MenuEntry[] {
	return [
		{ label: "New Terminal", icon: <PromptIcon />, keys: menuKeys("new-window"), run: newTerminalWindow },
		openItem(SETTINGS, openSettings),
		openItem(SYSTEM, () => openSection("status")),
		{ label: "Apps…", icon: <GridIcon />, keys: menuKeys("launcher"), run: () => { if (!ui$().get().launcher) toggleLauncher(); } },
		null,
		{ label: "Change Wallpaper…", icon: <WallpaperIcon />, run: () => openSection("desktop") },
	];
}

/** The bare desktop: #desktop itself, or the workspace under no window. */
const bare = (desk: HTMLElement, t: EventTarget | null) => t === desk || (t instanceof HTMLElement && t.id === "workspace" && t.parentElement === desk);

export function DesktopMenu() {
	const [at, setAt] = useState<DOMRect | null>(null);
	const back = useRef<HTMLElement | null>(null);

	useEffect(() => {
		const desk = document.getElementById("desktop");
		if (!desk) return;
		let press: { x: number; y: number; timer: number } | null = null;
		const cancel = () => { if (press) { clearTimeout(press.timer); press = null; } };
		const open = (x: number, y: number) => {
			cancel();
			const a = document.activeElement;
			// Not when it is open already (Android fires contextmenu after a long press too).
			if (!(a instanceof HTMLElement && a.closest("#desktop-menu"))) back.current = a instanceof HTMLElement ? a : null;
			setAt(new DOMRect(x, y, 0, 0));
		};
		const onMenu = (e: MouseEvent) => {
			if (!bare(desk, e.target)) return;
			e.preventDefault();
			open(e.clientX, e.clientY);
		};
		const onDown = (e: PointerEvent) => {
			cancel();
			if (e.pointerType === "mouse" || !e.isPrimary || !bare(desk, e.target)) return;
			const { clientX: x, clientY: y } = e;
			press = { x, y, timer: window.setTimeout(() => open(x, y), LONG_PRESS) };
		};
		const onMove = (e: PointerEvent) => { if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > SLOP) cancel(); };
		desk.addEventListener("contextmenu", onMenu);
		desk.addEventListener("pointerdown", onDown);
		desk.addEventListener("pointermove", onMove);
		desk.addEventListener("pointerup", cancel);
		desk.addEventListener("pointercancel", cancel);
		return () => {
			cancel();
			desk.removeEventListener("contextmenu", onMenu);
			desk.removeEventListener("pointerdown", onDown);
			desk.removeEventListener("pointermove", onMove);
			desk.removeEventListener("pointerup", cancel);
			desk.removeEventListener("pointercancel", cancel);
		};
	}, []);

	if (!at) return null;
	const close = (how: MenuClose) => {
		setAt(null);
		if (how === "key" && back.current?.isConnected) back.current.focus({ preventScroll: true });
		back.current = null;
	};
	return createPortal(<Menu id="desktop-menu" label="Desktop" items={items()} anchor={at} point onClose={close} />, document.body);
}
