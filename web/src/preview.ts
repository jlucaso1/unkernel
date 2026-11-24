// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The guest preview: a web server running in the guest (e.g. on port 8000)
// shown in the Browser window (a desktop window, wm.ts; its body is
// components/Preview.tsx) or a tab at /vm/<vmId>/<port>/. The page's service
// worker public/vm-sw.js (sw.ts) relays those requests here; this page
// answers the ones for its vmId (a random id per booted kernel) with
// vm.fetch() on the guest's 127.0.0.1:<port>, and streams the body back in
// chunks. The message format is at the top of vm-sw.js. WebSockets take
// another way (preview-ws.ts). Secure contexts only (service workers), and
// same-origin: the guest's pages can reach this page, so trusted content
// only. .agents/web.md (Guest preview) lists the limits.
//
// The Browser window's actions are at the bottom: openPreview() opens or
// focuses it and navigates, closePreview() closes it (its page unloads),
// togglePreview() (Ctrl-A p) brings it to the front or minimizes it; a
// minimized or hidden one keeps its page loaded. previewState() ({port,
// path, shown}: shown is "open and not minimized") is what the session
// record keeps of it (boot.ts).
import { createElement, useSyncExternalStore } from "react";
import type { AppMeta } from "./apps/types.ts";
import { PreviewIcon } from "./components/icons.tsx";
import { Browser } from "./components/Preview.tsx";
import { hideDisplay } from "./display.ts";
import { closeWebSockets, serveWebSockets, type GuestConnector } from "./preview-ws.ts";
import { createStore } from "./store.ts";
import { serviceWorker, swSupported } from "./sw.ts";
import { store } from "./prefs.ts";
import { wm, wm$, type WindowSpec } from "./wm.ts";

/** What the relay needs of the kernel handle: the SDK's vm.fetch(), and vm.connect() for WebSockets. */
export interface GuestFetcher extends GuestConnector {
	fetch(input: string, init?: RequestInit): Promise<Response>;
}

interface RelayRequest {
	t: "kw-vm-fetch";
	vmId: string;
	port: number;
	method: string;
	/** Path and query. */
	path: string;
	headers: [string, string][];
	body: ArrayBuffer | null;
}

/** Relayed requests running at once; the rest wait. Each guest connection forks a server process. */
const MAX_ACTIVE = 8;
/** Chunks sent ahead of the service worker's asking. */
const CREDITS = 4;
/** Not passed on to the guest: hop-by-hop, and what vm.fetch() sets itself. */
const SKIP = new Set(["host", "connection", "keep-alive", "transfer-encoding", "upgrade", "content-length", "accept-encoding"]);

/** Service workers exist (secure contexts: https, localhost). */
export const previewSupported = swSupported;

let vm: GuestFetcher | null = null;
let vmId = "";
let sw: Promise<void> | null = null;
let attached: () => void = () => {};
const attachedP = new Promise<void>((r) => { attached = r; });
let active = 0;
const waiting: Array<() => void> = [];

/** The preview URL of a guest port on this page's kernel. */
export const previewUrl = (port: number, path = "/"): string => `/vm/${vmId}/${port}${path}`;

/**
 * Serve previews for this kernel handle (boot.ts, once it runs; null once
 * it stopped: requests then get 503). The first call registers the service
 * worker and picks the vmId.
 */
export function attachPreview(handle: GuestFetcher | null): void {
	vm = handle;
	if (!handle) closeWebSockets();
	if (!handle || vmId) return;
	vmId = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, "0")).join("");
	serveWebSockets(vmId, () => vm);
	if (previewSupported()) {
		navigator.serviceWorker.addEventListener("message", onRelay);
		navigator.serviceWorker.startMessages(); // this page is not controlled (the scope is /vm/)
		sw = serviceWorker().then(() => {});
		sw.catch((e: Error) => console.warn(`[preview] the service worker failed: ${e.message}`));
	}
	attached();
}

/** Resolves once previews can load: the kernel runs and the service worker is active. */
export async function previewReady(): Promise<void> {
	if (!previewSupported()) throw new Error("The preview needs a secure context (https or localhost): it runs on a service worker.");
	await attachedP;
	await sw;
}

function onRelay(e: MessageEvent) {
	const d = e.data as Partial<RelayRequest> | null;
	const port = e.ports[0];
	// Another tab's kernel: its own page answers.
	if (!port || d?.t !== "kw-vm-fetch" || !vmId || d.vmId !== vmId) return;
	port.postMessage({ t: "accept" });
	void serve(d as RelayRequest, port);
}

const slot = (): Promise<void> => {
	if (active < MAX_ACTIVE) { active++; return Promise.resolve(); }
	return new Promise((r) => waiting.push(() => { active++; r(); }));
};
const release = () => { active--; waiting.shift()?.(); };

async function serve(r: RelayRequest, port: MessagePort) {
	const abort = new AbortController();
	let cancelled = false, credits = CREDITS;
	let wake: (() => void) | null = null;
	port.onmessage = (e: MessageEvent<{ t?: string }>) => {
		if (e.data?.t === "more") credits++;
		else if (e.data?.t === "cancel") { cancelled = true; abort.abort(); }
		const w = wake;
		wake = null;
		w?.();
	};
	await slot();
	try {
		if (cancelled) return;
		const handle = vm;
		if (!handle) { port.postMessage({ t: "error", status: 503, message: "The kernel is not running: reboot it, then open the preview again." }); return; }
		if (typeof handle.fetch !== "function") { port.postMessage({ t: "error", status: 501, message: "This kernel handle has no fetch()." }); return; }
		const headers = new Headers();
		for (const [k, v] of r.headers) {
			if (SKIP.has(k.toLowerCase())) continue;
			try { headers.append(k, v); } catch { /* a value Headers refuses */ }
		}
		headers.set("accept-encoding", "identity"); // a synthesized response is not decoded by the browser
		const guest = `http://localhost:${r.port}`;
		if (headers.has("origin")) headers.set("origin", guest); // as the guest's server sees itself (CSRF checks)
		let res: Response;
		try {
			res = await handle.fetch(guest + r.path, { method: r.method, headers, body: r.body, redirect: "manual", signal: abort.signal });
		} catch (e) {
			if (!cancelled) port.postMessage({ t: "error", status: 502, message: `Nothing answered on the guest's port ${r.port} (${(e as Error)?.message ?? e}). Is a server listening there?` });
			return;
		}
		port.postMessage({ t: "head", status: res.status, statusText: res.statusText, headers: [...res.headers] });
		const reader = res.body?.getReader();
		if (reader) {
			for (;;) {
				while (credits <= 0 && !cancelled) await new Promise<void>((w) => { wake = w; });
				if (cancelled) { void reader.cancel().catch(() => {}); return; }
				const { done, value } = await reader.read();
				if (done) break;
				if (!value?.byteLength) continue;
				const copy = value.slice(); // its own ArrayBuffer to transfer (the stream's may be shared or reused)
				credits--;
				port.postMessage({ t: "chunk", data: copy.buffer }, [copy.buffer]);
			}
		}
		if (!cancelled) port.postMessage({ t: "end" });
	} catch (e) {
		if (!cancelled) port.postMessage({ t: "error", status: 502, message: `The guest's response failed: ${(e as Error)?.message ?? e}` });
	} finally {
		release();
		port.close();
	}
}

/**
 * A guest page in the preview followed a root-relative link or redirect out
 * of /vm/<id>/<port>/, which the service worker cannot catch (navigations
 * outside its scope reach the server, which sends this page): the way back
 * under the prefix, or null. main.tsx then goes there instead of booting a
 * second kernel. Known from the iframe's data-kw-preview, or in a tab from
 * the referrer.
 */
export function previewEscape(): string | null {
	if (location.pathname.startsWith("/vm/")) return null;
	let from = "";
	try { from = (window.frameElement as HTMLElement | null)?.dataset.kwPreview ?? ""; } catch { /* a cross-origin parent */ }
	if (!from && document.referrer) {
		try {
			const u = new URL(document.referrer);
			if (u.origin === location.origin) from = u.pathname;
		} catch { /* not a URL */ }
	}
	const m = /^\/vm\/[\w-]+\/\d+(?=\/)/.exec(from);
	return m ? m[0] + location.pathname + location.search + location.hash : null;
}

// ---- the Browser window (Ctrl-A p, the Guest tab, the Dock, open, KW.preview) ----
// The preview is a desktop window (wm.ts) whose body is components/Preview.tsx
// Browser: a toolbar (reload, the address, open in a tab) over the iframe.
// Each Browser window's navigation lives in browsers$ under its window id, so
// a second window on another port is one more openBrowser() with another id
// (and dock id); the page's API and the session drive the first one,
// PREVIEW_WIN.

/** The Browser window's WM id (its frame is #win-preview, its body's root #preview). */
export const PREVIEW_WIN = "preview";
/** Its Dock tile's element id. */
const PREVIEW_DOCK = "dock-preview";
/** The Browser windows' descriptor (wm.ts meta), and the Browser page app's (apps/system/browser.ts); a window's title is its page's, else this one's. */
export const BROWSER: AppMeta = { id: "browser", title: "Browser", glyph: PreviewIcon, cmd: "preview" };

/** A guest port and a path on it (with the query and fragment). */
export interface GuestPlace { port: number; path: string }
/** A Browser window's navigation. */
export interface BrowserNav extends GuestPlace {
	/** Where its page is now (Preview.tsx, from the iframe's location: its own links and redirects); the address shows it. */
	here: GuestPlace;
	/** Bumped by each navigation from outside: the iframe is made again (its key) on port and path. */
	nav: number;
	/** The page's title, if it has one (also the window's title). */
	title: string;
}
const browsers$ = createStore<Record<string, BrowserNav>>({});

/** A Browser window's navigation (Preview.tsx). */
export const useBrowser = (id: string): BrowserNav | undefined => useSyncExternalStore(browsers$.subscribe, () => browsers$.get()[id]);
export const browserNav = (id: string): BrowserNav | undefined => browsers$.get()[id];

const setNav = (id: string, nav: BrowserNav | null) => browsers$.set((s) => {
	const next = { ...s };
	if (nav) next[id] = nav;
	else delete next[id];
	return next;
});
/** Send it to port and path: the iframe is made again there. */
const navigate = (id: string, b: BrowserNav | undefined, port: number, path: string) => {
	setNav(id, { port, path, here: { port, path }, nav: (b?.nav ?? -1) + 1, title: "" });
	if (b && wm.get(id)) wm.update(id, { title: BROWSER.title });
};

/** The page in Browser window id is now at port and path, titled title (Preview.tsx, on the iframe's loads and navigations). */
export function browserAt(id: string, port: number, path: string, title: string): void {
	const b = browsers$.get()[id];
	if (!b || (b.here.port === port && b.here.path === path && b.title === title)) return;
	setNav(id, { ...b, here: { port, path }, title });
	if (wm.get(id)) wm.update(id, { title: title || BROWSER.title });
}
/** Load Browser window id again where it is (made again: Preview.tsx tries location.reload() first). */
export function browserReload(id: string): void {
	const b = browsers$.get()[id];
	if (b) navigate(id, b, b.here.port, b.here.path);
}
/** The address field: the same place reloads, another one navigates (the first window's port is remembered, as openPreview() does). */
export function browserGo(id: string, port: number, path: string): void {
	const b = browsers$.get()[id];
	if (b && b.here.port === port && b.here.path === path) { browserReload(id); return; }
	if (id === PREVIEW_WIN) store("previewPort", String(port));
	openBrowser(id, port, path);
}

/** Show Browser window id, the guest's Display window going under it (minimized), and give it the focus. */
function showBrowser(id: string): void {
	hideDisplay();
	wm.focus(id);
}

/** Its first geometry: the right part of the workspace, beside a terminal; the WM places it where the workspace is not measured yet. */
function firstGeom(): Pick<WindowSpec, "w" | "h"> & Partial<Pick<WindowSpec, "x" | "y">> {
	const { area } = wm$.get();
	if (!area.w || !area.h) return { w: 900, h: 640 };
	const w = Math.round(Math.min(1100, area.w - 32, Math.max(480, area.w * 0.5)));
	const h = Math.round(Math.min(area.h - 24, Math.max(360, area.h * 0.86)));
	return { w, h, x: Math.max(0, area.w - w - 16), y: Math.max(0, Math.round((area.h - h) / 2)) };
}

/**
 * Send Browser window id to a guest port and path, opening it if needed
 * (show: focused and over the layers; false: opened minimized, or left as
 * it is). The same place it is on already keeps its page.
 */
function openBrowser(id: string, port: number, path: string, { show = true, dockId }: { show?: boolean; dockId?: string } = {}): void {
	const b = browsers$.get()[id];
	if (!b || b.here.port !== port || b.here.path !== path) navigate(id, b, port, path);
	if (!wm.get(id)) {
		wm.open({
			id, meta: BROWSER, dockId, minW: 320, minH: 220, ...firstGeom(),
			content: createElement(Browser, { id }),
			// Closing it unloads the page (the window's body, and the iframe in it, go).
			onClose: () => { setNav(id, null); },
		}, { focus: show });
		if (!show) wm.minimize(id);
	}
	if (show) showBrowser(id);
}

/**
 * The first Browser window as the session record keeps it (boot.ts): the
 * guest port and the path its page is on, and whether it is shown (open and
 * not minimized); null: closed.
 */
export function previewState(): { port: number; path: string; shown: boolean } | null {
	const b = browsers$.get()[PREVIEW_WIN], w = wm.get(PREVIEW_WIN);
	return b && w ? { port: b.here.port, path: b.here.path, shown: !w.minimized } : null;
}

const portOf = (v: unknown): number | null => {
	const n = Number(v);
	return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
};

/** The port opened last (kept in localStorage), else 8000. */
export const lastPreviewPort = (): number => portOf(store("previewPort")) ?? 8000;

/**
 * Open the Browser window on a guest port, at path, or send it there (shown
 * and focused; show false: opened minimized, as a resumed session had it).
 * False: not a port.
 */
export function openPreview(port: number | string = lastPreviewPort(), path = "/", { show = true }: { show?: boolean } = {}): boolean {
	const n = portOf(port);
	if (n === null) return false;
	store("previewPort", String(n));
	openBrowser(PREVIEW_WIN, n, path.startsWith("/") ? path : `/${path}`, { show, dockId: PREVIEW_DOCK });
	return true;
}

/** Close the Browser window (its page is unloaded). */
export function closePreview(): void {
	if (!wm.close(PREVIEW_WIN)) setNav(PREVIEW_WIN, null);
}

/** Ctrl-A p: open it, else bring it to the front, or minimize it when it is in front already (the page in it stays loaded). */
export function togglePreview(): void {
	const w = wm.get(PREVIEW_WIN);
	if (!w) { openPreview(); return; }
	if (wm.focused() === PREVIEW_WIN && wm.isVisible(PREVIEW_WIN)) wm.minimize(PREVIEW_WIN);
	else showBrowser(PREVIEW_WIN);
}

/**
 * An address as the Browser's field takes it: a port (3000), a port and
 * path (3000/x), the guest's own host with or without the port
 * (localhost:3000/x, http://127.0.0.1/x), or a path on the current port
 * (/x). Null: none of these.
 */
export function parseAddress(text: string, port: number): { port: number; path: string } | null {
	const s = text.trim().replace(/^http:\/\//i, "");
	if (s.startsWith("/")) return { port, path: s };
	const m = /^(?:(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(?::(\d+))?|:?(\d+))([/?#].*)?$/i.exec(s);
	if (!m) return null;
	const p = portOf(m[1] ?? m[2] ?? 80);
	if (p === null) return null;
	const rest = m[3] ?? "/";
	return { port: p, path: rest.startsWith("/") ? rest : `/${rest}` };
}
