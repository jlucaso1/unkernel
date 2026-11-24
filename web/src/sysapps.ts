// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The page's two system apps as desktop windows (wm.ts), in place of the old
// modal System dialog: Settings (what the user changes or acts on: the
// options grouped as Machine, Distro, Storage, Network, Display and sound and
// Session, the desktop's look (Desktop, applied at once), the data disk's actions, the preview, the keyboard shortcuts,
// About) and System (information only: the state and boot stages,
// the environment checks, the kernel log, the errors and Copy diagnostics).
// Their components are components/Settings.tsx and SystemInfo.tsx, rendered by
// components/Apps.tsx; this module opens and closes their windows (React
// only for its two hooks).
//
// - Sections: each app shows one section at a time (the store's Tab names all
//   of them; the old dialog's tabs keep their names: status, env, log,
//   errors, keys; guest, its Guest tab, is an alias of Settings' storage). SECTION_APP says which app has which; openSection() opens
//   (or focuses: each app is a singleton window) that app on that section;
//   openSettings() and showSystem() open each app where it was.
// - Content: each app renders, through a portal, into one element that lives
//   as long as the page: the window's body while it is open (wm.ts mounts an
//   element content without recreating it, and while the closed window
//   fades out: wmfx.ts's ghost), else a hidden holder (#apps-parked), where
//   the body hands it once it goes (the window's onRelease). So every id the browser tests and ui.ts read (#opt-*,
//   #data-status, #copy-area, #reboot...) is always in the document, as with
//   the old dialog, which was always mounted. System's element is #system and
//   has class `open` while its window is shown (not minimized; in compact
//   mode the top one); Settings' is #settings, with `open` the same way.
// - useFocusedSection(): the section of the app that has the WM's focus
//   (shown), for the pressed state of the top bar's buttons (Errors).
// - Focus: opened from the keyboard (not on touch, unless from a Dock button
//   activated by keyboard) the selected section's tab takes the focus; the
//   Dock or top bar button it was opened from gets it back when Esc closes the window
//   (keys.ts). A window that gets the WM's focus (a click on its title
//   bar, its Dock tile) takes the DOM focus too, so keys stop going to the
//   terminal under it.
import { useSyncExternalStore } from "react";
import type { AppMeta } from "./apps/types.ts";
import { ActivityIcon, SysIcon } from "./components/icons.tsx";
import { hideDisplay } from "./display.ts";
import { inBars } from "./focus.ts";
import { KW } from "./kw.ts";
import { createStore, type Tab } from "./store.ts";
import { isVisible, useWm, wm, wm$ } from "./wm.ts";

export type AppId = "settings" | "system";

export const SECTION_APP: Record<Tab, AppId> = {
	boot: "settings", distro: "settings", storage: "settings", network: "settings", display: "settings", desktop: "settings", session: "settings",
	keys: "settings", about: "settings", guest: "settings",
	status: "system", env: "system", log: "system", errors: "system",
};
/** The two apps' descriptors (their windows' wm.ts meta, and their launcher entries': apps/system/). */
export const SETTINGS: AppMeta = { id: "settings", title: "Settings", glyph: SysIcon, cmd: "settings" };
export const SYSTEM: AppMeta = { id: "system", title: "System", glyph: ActivityIcon, cmd: "system" };
const META: Record<AppId, AppMeta> = { settings: SETTINGS, system: SYSTEM };
/** Old names of sections: the dialog's Guest tab had the data disk. */
const ALIAS: Partial<Record<Tab, Tab>> = { guest: "storage" };
const resolve = (t: Tab): Tab => ALIAS[t] ?? t;

/** The section a first open shows. */
const FIRST: Record<AppId, Tab> = { settings: "boot", system: "status" };
/** A first open's size (cascaded like any window; maximized in compact mode). */
const SIZE: Record<AppId, { w: number; h: number; minW: number; minH: number }> = {
	settings: { w: 860, h: 620, minW: 340, minH: 320 },
	system: { w: 820, h: 580, minW: 340, minH: 300 },
};

/** The WM's window id of an app. */
export const appWinId = (app: AppId): string => `app-${app}`;
const appOfWin = (id: string | null): AppId | null => (id === "app-settings" ? "settings" : id === "app-system" ? "system" : null);

/** Each app's current section. */
export const apps$ = createStore<Record<AppId, Tab>>({ ...FIRST });

/** The holder of a closed app's element: hidden, so nothing in it shows or takes the focus. */
function holder(): HTMLElement {
	let h = document.getElementById("apps-parked");
	if (!h) {
		h = document.createElement("div");
		h.id = "apps-parked";
		h.hidden = true;
		document.body.append(h);
	}
	return h;
}
/** An app's element, #settings or #system (found again after a hot reload of this module, so the window keeps it). */
function element(app: AppId): HTMLElement {
	let el = document.getElementById(app);
	if (!el) {
		el = document.createElement("div");
		el.id = app;
		el.className = "kw-app h-full outline-none";
		el.dataset.app = app;
		el.tabIndex = -1;
		holder().append(el);
	}
	return el;
}
const els: Record<AppId, HTMLElement> = { settings: element("settings"), system: element("system") };
/** The element components/Apps.tsx renders an app into. */
export const appElement = (app: AppId): HTMLElement => els[app];

/** The app's window is shown (re-renders when that changes): what is drawn only while seen (the kernel log) checks it. */
export function useAppVisible(app: AppId): boolean {
	return useWm((s) => { const w = s.windows.find((x) => x.id === appWinId(app)); return !!w && isVisible(w, s); });
}

/** The Dock or top bar button each app was opened from with the keyboard: it gets the focus back on Esc. */
const openers: Record<AppId, HTMLElement | null> = { settings: null, system: null };

/** Focus the app's selected section tab (keyboard users land in the window). */
function focusInto(app: AppId): void {
	const el = els[app];
	if (el.contains(document.activeElement) && document.activeElement !== el) return;
	(el.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ?? el).focus({ preventScroll: true });
}

/** The window got the WM's focus: take the DOM focus too, unless it is in the window already. */
function onFocus(app: AppId): void {
	const el = els[app];
	if (!el.contains(document.activeElement)) el.focus({ preventScroll: true });
}

/** Open (or show and focus) the app that has this section, on it; in any state of the machine. */
export function openSection(section?: Tab): void {
	if (section) section = resolve(section);
	const app = section ? SECTION_APP[section] : "system";
	const id = appWinId(app);
	if (wm.focused() !== id) {
		const a = document.activeElement as HTMLElement | null;
		openers[app] = inBars(a) ? a : null;
	}
	if (section && apps$.get()[app] !== section) apps$.set({ [app]: section });
	// The guest's Display window goes under it (minimized), as for the Browser (preview.ts).
	hideDisplay();
	const size = SIZE[app];
	wm.open({
		id, meta: META[app], dockId: `dock-${app}`, content: els[app],
		...size, onFocus: () => onFocus(app),
		// The window's body went (closed, its close effect over): back to the holder.
		onRelease: (el) => holder().append(el),
	});
	if (!KW.config?.coarse || openers[app]) requestAnimationFrame(() => focusInto(app));
}

/** Settings on the section it last showed (a first open: Machine): what every plain "Settings" control opens. */
export const openSettings = (): void => openSection(apps$.get().settings);
/** Show System's window: open it on the section it last showed, or bring it to the front as it is (Copy diagnostics' fallback). */
export function showSystem(): void {
	if (focusedApp() !== "system") openSection(apps$.get().system);
}

/** Close the app's window; the Dock button it was opened from gets the focus back. */
export function closeApp(app: AppId): void {
	const back = openers[app];
	openers[app] = null;
	if (!wm.get(appWinId(app))) return;
	wm.close(appWinId(app));
	if (back?.isConnected) back.focus({ preventScroll: true });
}

/** The app whose window is focused and shown, or null. */
export function focusedApp(): AppId | null {
	const s = wm$.get(), app = appOfWin(s.focused);
	const w = app && s.windows.find((x) => x.id === appWinId(app));
	return w && isVisible(w, s) ? app : null;
}

/** The top bar's Errors: close the app when that section is the one focused, else open it there. */
export function toggleSection(section: Tab): void {
	section = resolve(section);
	const app = SECTION_APP[section];
	if (focusedApp() === app && apps$.get()[app] === section) closeApp(app);
	else openSection(section);
}

/** Select a section of an app that is open (its own navigation). */
export function selectSection(section: Tab): void {
	section = resolve(section);
	const app = SECTION_APP[section];
	if (apps$.get()[app] !== section) apps$.set({ [app]: section });
}

/** The app an element is in (keys.ts: Esc closes it), or null. */
export function appOf(el: Element | null): AppId | null {
	const a = el?.closest?.<HTMLElement>(".kw-app");
	return a?.dataset.app === "settings" || a?.dataset.app === "system" ? a.dataset.app : null;
}

/** The section of the app whose window is focused and shown, or null. */
export function focusedSection(): Tab | null {
	const app = focusedApp();
	return app ? apps$.get()[app] : null;
}
const subscribeFocused = (l: () => void) => {
	const a = wm$.subscribe(l), b = apps$.subscribe(l);
	return () => { a(); b(); };
};
/** focusedSection(), re-rendering when it changes. */
export const useFocusedSection = (): Tab | null => useSyncExternalStore(subscribeFocused, focusedSection);

// ---- each element's open class: its window is shown -------
function sync(): void {
	const s = wm$.get();
	for (const app of ["settings", "system"] as const) {
		const w = s.windows.find((x) => x.id === appWinId(app));
		els[app].classList.toggle("open", !!w && isVisible(w, s));
	}
}
wm$.subscribe(sync);
