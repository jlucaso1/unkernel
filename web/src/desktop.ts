// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The desktop's appearance (Settings > Desktop, components/DesktopSettings.tsx;
// drawn by components/Wallpaper.tsx): the wallpaper and how dim and soft a
// photo is under the top bar and the Dock. Applied at once, no reboot.
//
// - Wallpapers: Random (the default: a photo of PHOTOS on each load, never
//   the one before; Next rolls again, Keep pins it), the built-in default
//   (style.css: the gradient on #app and the mark on #desktop, no request), CSS
//   presets (PRESETS), and a chosen photo. Photos are Lorem Picsum's
//   (picsum.photos: Unsplash photos under the Unsplash License, no key; its
//   responses, the 302 to fastly.picsum.photos included, send
//   Access-Control-Allow-Origin: *, so they load with CORS under COEP
//   require-corp; vm-sw.js leaves cross-origin requests alone). PHOTOS is a
//   curated list of stable Picsum ids; morePhotos() pages through its
//   /v2/list. Requests carry no credentials and no referrer. With Random
//   (or a photo) the page contacts picsum.photos on every load; otherwise
//   only while Settings > Desktop shows its thumbnails.
// - Preferences: localStorage `kw.desktop` (JSON, with the page's other
//   immediate preferences, prefs.ts store()), not a boot option.
// - A photo: fetched at the viewport's size in device pixels (PHOTO_MAX
//   wide or tall at most, the photo's own size at most; Picsum crops to that
//   aspect), decoded before it is shown, so what is shown stays until it is
//   ready, and stays if it fails (silently on load, a quiet line in Settings
//   for a pick). The photo shown last is the one entry of the Cache API's
//   CACHE_NAME (with its credit in a header): a chosen photo shows from it
//   at once and offline, and Random shows it as the placeholder while the
//   next one loads.
// - First paint: HINT_KEY (localStorage `kw.wallpaper-hint`, JSON
//   WallpaperHint) is what is shown, for an inline script to paint before
//   any module runs: `css`, a ready CSS `background` value (a photo: the dim,
//   a tiny blurry data-URL copy, its average colour; a preset: its CSS),
//   `light` and `luma` (the root hook below). No key: the default.
// - Legibility: the luma of the photo's top band (where the top bar is, which
//   has no backdrop of its own; the Dock has its glass), sampled once from a small canvas, after the dim,
//   sets data-wallpaper="light|dark" and --wallpaper-luma (0 to 1) on the
//   root for the chrome's styles; data-wallpaper-kind (default, preset or
//   photo) is what is drawn (style.css hides the default's mark under the
//   others).
// The helpers above the runtime part need no DOM.
import { useSyncExternalStore } from "react";
import { createStore } from "./store.ts";

export const PICSUM = "https://picsum.photos";
/** The Cache API's cache of the photo shown last (one entry). */
export const CACHE_NAME = "kw-wallpaper-v1";
const CACHE_PATH = "/__kw/wallpaper";
/** localStorage keys (prefs.ts store()'s `kw.` prefix). */
const PREFS_KEY = "kw.desktop";
export const HINT_KEY = "kw.wallpaper-hint";
/** The longest side of a photo fetched for the wallpaper, in device pixels. */
export const PHOTO_MAX = 2560;
/** The thumbnails' size (Settings' grid: about 100 css px wide, at 2x). */
const THUMB_W = 240, THUMB_H = 150;
/** At or above this luma (0 to 1, after the dim) the wallpaper is light under the chrome. */
export const LIGHT_LUMA = 0.5;

export interface Photo {
	/** Picsum's id. */
	id: string;
	author: string;
	/** The photo's Unsplash id (https://unsplash.com/photos/<src>), for the credit. */
	src: string;
	/** Its full size in px. */
	w: number;
	h: number;
}
export interface Preset { id: string; name: string; css: string; luma: number }
export type Wallpaper = { kind: "random" } | { kind: "default" } | { kind: "preset"; id: string } | { kind: "photo"; photo: Photo };
export interface Prefs {
	wallpaper: Wallpaper;
	/** The black overlay over a photo, 0 to DIM_MAX. */
	dim: number;
	/** A photo is shown blurred. */
	blur: boolean;
	/** Random's last pick (the next load picks another). */
	last: string | null;
}
/** HINT_KEY's value: what an inline first-paint script may draw. */
export interface WallpaperHint { css: string; light: boolean; luma: number }

export const DIM_MAX = 0.7;
export const DIM_DEFAULT = 0.25;
const DEFAULT_LUMA = 0.04;

/** Built-in wallpapers, drawn in CSS. */
export const PRESETS: Preset[] = [
	{ id: "graphite", name: "Graphite", css: "linear-gradient(165deg, #2a2a2a 0%, #131313 45%, #050505 100%)", luma: 0.08 },
	{ id: "midnight", name: "Midnight", css: "radial-gradient(120% 90% at 15% 0%, #1d2c52 0%, #0a1328 45%, #03050b 100%)", luma: 0.06 },
	{ id: "aurora", name: "Aurora", css: "radial-gradient(80% 60% at 82% 8%, rgb(30 170 135 / 50%), transparent 70%), radial-gradient(90% 70% at 8% 35%, rgb(80 64 190 / 50%), transparent 70%), linear-gradient(#06080f, #020305)", luma: 0.1 },
	{ id: "dusk", name: "Dusk", css: "linear-gradient(160deg, #432150 0%, #1e1336 42%, #0a0912 100%)", luma: 0.08 },
	{ id: "ember", name: "Ember", css: "radial-gradient(120% 85% at 85% 110%, #74300f 0%, #261108 50%, #070404 100%)", luma: 0.05 },
	{ id: "forest", name: "Forest", css: "linear-gradient(170deg, #1a382f 0%, #0c1c17 50%, #040807 100%)", luma: 0.07 },
	{ id: "black", name: "Black", css: "#000", luma: 0 },
];

/** Curated Picsum photos, Random's pool (stable ids; author and Unsplash id from /v2/list). */
export const PHOTOS: Photo[] = [
	{ id: "1022", author: "Vashishtha Jogi", w: 5000, h: 2813, src: "bClr95glx6k" },
	{ id: "1042", author: "Jeremy Thomas", w: 3333, h: 5000, src: "rMmibFe4czY" },
	{ id: "1019", author: "Patrick Fore", w: 5000, h: 3333, src: "V6s1cmE39XM" },
	{ id: "1015", author: "Alexey Topolyanskiy", w: 5000, h: 3333, src: "-oWyJoSqBRM" },
	{ id: "1018", author: "Andrew Ridley", w: 3914, h: 2935, src: "Kt5hRENuotI" },
	{ id: "1016", author: "Philippe Wuyts", w: 3844, h: 2563, src: "_h7aBovKia4" },
	{ id: "1036", author: "Wolfgang Lutz", w: 4608, h: 3072, src: "yOujaSETXlo" },
	{ id: "1043", author: "Christian Joudrey", w: 5000, h: 3333, src: "mWRR1xj95hg" },
	{ id: "1041", author: "Tim Marshall", w: 5000, h: 2813, src: "yEOCA6oiVqg" },
	{ id: "1051", author: "Ales Krivec", w: 4928, h: 3264, src: "HkTMcmlMOUQ" },
	{ id: "10", author: "Paul Jarvis", w: 2500, h: 1667, src: "6J--NXulQCs" },
	{ id: "1002", author: "NASA", w: 4312, h: 2868, src: "6-jTZysYY_U" },
	{ id: "1039", author: "Andrew Coelho", w: 5000, h: 3337, src: "VB-w_3dnyvI" },
	{ id: "1044", author: "Steve Carter", w: 4032, h: 2268, src: "Ixp4YhCKZkI" },
	{ id: "1050", author: "Joseph Barrientos", w: 5000, h: 3333, src: "xcC5ozHk_N8" },
	{ id: "1037", author: "Jordan McQueen", w: 5000, h: 3333, src: "93g2k8D1Mi8" },
	{ id: "122", author: "Vadim Sherbakov", w: 4147, h: 2756, src: "xS_RzdD5CFE" },
	{ id: "28", author: "Jerry Adney", w: 4928, h: 3264, src: "_WiFMBRT7Aw" },
	{ id: "29", author: "Go Wild", w: 4000, h: 2670, src: "V0yAek6BgGk" },
	{ id: "1053", author: "Anna Popović", w: 3596, h: 2393, src: "x7HJdJZqplo" },
	{ id: "110", author: "Kenneth Thewissen", w: 5000, h: 3333, src: "D76DklsG-5U" },
	{ id: "124", author: "Anton Sulsky", w: 3504, h: 2336, src: "fj0tFloTPGQ" },
	{ id: "15", author: "Paul Jarvis", w: 2500, h: 1667, src: "NYDo21ssGao" },
	{ id: "16", author: "Paul Jarvis", w: 2500, h: 1667, src: "gkT4FfgHO5o" },
];

export const DEFAULT_PREFS: Prefs = { wallpaper: { kind: "random" }, dim: DIM_DEFAULT, blur: false, last: null };

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length < 200;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A photo's fields checked (a Picsum id is digits), or null. */
export function parsePhoto(v: unknown): Photo | null {
	const p = v as Partial<Photo> | null;
	if (!p || !isStr(p.id) || !/^\d+$/.test(p.id) || !isStr(p.author) || !isStr(p.src)) return null;
	return { id: p.id, author: p.author, src: p.src, w: isNum(p.w) && p.w > 0 ? p.w : 5000, h: isNum(p.h) && p.h > 0 ? p.h : 5000 };
}

/** The saved preferences (the defaults for anything missing or malformed). */
export function parsePrefs(raw: string | null): Prefs {
	let v: Partial<Record<keyof Prefs, unknown>>;
	try { v = JSON.parse(raw ?? "{}") ?? {}; } catch { return { ...DEFAULT_PREFS }; }
	const w = v.wallpaper as { kind?: unknown; id?: unknown; photo?: unknown } | undefined;
	let wallpaper: Wallpaper = { kind: "random" };
	if (w?.kind === "default") wallpaper = { kind: "default" };
	else if (w?.kind === "preset" && PRESETS.some((p) => p.id === w.id)) wallpaper = { kind: "preset", id: w.id as string };
	else if (w?.kind === "photo") { const photo = parsePhoto(w.photo); if (photo) wallpaper = { kind: "photo", photo }; }
	return {
		wallpaper,
		dim: isNum(v.dim) ? clamp(v.dim, 0, DIM_MAX) : DIM_DEFAULT,
		blur: v.blur === true,
		last: isStr(v.last) && /^\d+$/.test(v.last) ? v.last : null,
	};
}

/** A wallpaper's identity: "random", "default", "preset:<id>", "photo:<id>". */
export function wallpaperKey(w: Wallpaper): string {
	return w.kind === "random" || w.kind === "default" ? w.kind : w.kind === "preset" ? `preset:${w.id}` : `photo:${w.photo.id}`;
}

/** Random's pick: a photo of the pool not in `not` (any, if that leaves none). */
export function pickRandom(pool: Photo[], not: (string | null | undefined)[], rnd: () => number = Math.random): Photo {
	const left = pool.filter((p) => !not.includes(p.id));
	const from = left.length ? left : pool;
	return from[Math.min(from.length - 1, Math.floor(rnd() * from.length))]!;
}

/** The size (px) to fetch a photo at for a viewport: its device pixels, at most PHOTO_MAX and the photo's own size, in steps of 8. */
export function photoSize(vw: number, vh: number, dpr: number, photo?: { w: number; h: number }): { w: number; h: number } {
	const w = Math.max(1, vw) * Math.max(1, dpr || 1), h = Math.max(1, vh) * Math.max(1, dpr || 1);
	const k = Math.min(1, PHOTO_MAX / Math.max(w, h), photo ? photo.w / w : 1, photo ? photo.h / h : 1);
	const step = (n: number) => Math.max(64, Math.floor((n * k) / 8) * 8);
	return { w: step(w), h: step(h) };
}

export const photoUrl = (id: string, w: number, h: number): string => `${PICSUM}/id/${encodeURIComponent(id)}/${w}/${h}.webp`;
export const thumbUrl = (id: string): string => photoUrl(id, THUMB_W, THUMB_H);
/** The photo's page on Unsplash (the credit's link). */
export const photoLink = (p: Photo): string => `https://unsplash.com/photos/${encodeURIComponent(p.src)}`;

/** Picsum's /v2/list entries as photos: landscape ones only, the malformed dropped. */
export function parseList(list: unknown): Photo[] {
	if (!Array.isArray(list)) return [];
	const out: Photo[] = [];
	for (const e of list as { id?: unknown; author?: unknown; width?: unknown; height?: unknown; url?: unknown }[]) {
		const src = typeof e?.url === "string" ? e.url.split("/").filter(Boolean).pop() : undefined;
		const p = parsePhoto({ id: e?.id, author: e?.author, src, w: e?.width, h: e?.height });
		if (p && p.w >= p.h) out.push(p);
	}
	return out;
}

/** Mean luma (0 to 1, Rec. 709 weights on the encoded values) of RGBA pixels, rows [y0, y1) of a w-wide image. */
export function lumaOf(data: ArrayLike<number>, w: number, y0 = 0, y1 = Math.floor(data.length / 4 / w)): number {
	let sum = 0, n = 0;
	for (let y = y0; y < y1; y++)
		for (let x = 0; x < w; x++) {
			const i = (y * w + x) * 4;
			sum += 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!;
			n++;
		}
	return n ? sum / n / 255 : 0;
}

/** The mean colour of RGBA pixels as #rrggbb. */
export function meanColor(data: ArrayLike<number>): string {
	const s = [0, 0, 0], n = Math.floor(data.length / 4) || 1;
	for (let i = 0; i + 3 < data.length; i += 4) { s[0]! += data[i]!; s[1]! += data[i + 1]!; s[2]! += data[i + 2]!; }
	return `#${s.map((v) => Math.round(v / n).toString(16).padStart(2, "0")).join("")}`;
}

/** The luma the chrome sees (after the dim) and whether that is light. */
export function tone(luma: number, dim: number): { luma: number; light: boolean } {
	const l = clamp(luma, 0, 1) * (1 - clamp(dim, 0, 1));
	return { luma: Math.round(l * 100) / 100, light: l >= LIGHT_LUMA };
}

/** A photo's first-paint background: the dim over a tiny copy of it (data URL), over its mean colour. */
export function photoHintCss(tiny: string, color: string, dim: number): string {
	const d = `rgb(0 0 0 / ${Math.round(clamp(dim, 0, 1) * 100)}%)`;
	return `linear-gradient(${d}, ${d}), url("${tiny}") center / cover no-repeat, ${color}`;
}

// ---- runtime ------------------------------------------------------------

/** What Wallpaper.tsx draws: a CSS background, or a decoded photo (object URLs). */
export interface Shown {
	key: string;
	css?: string;
	url?: string;
	/** The photo pre-blurred (a small canvas, scaled up), while blur is on. */
	blurUrl?: string;
	/** The photo's credit. */
	photo?: Photo;
	/** Its luma under the top bar, before the dim. */
	luma: number;
	/** A photo's tiny copy (data URL) and mean colour, for HINT_KEY. */
	tiny?: string;
	color?: string;
}
interface State {
	prefs: Prefs;
	shown: Shown | null;
	/** The wallpaper being loaded (its key: "random" while Random rolls), or null. */
	pending: string | null;
	/** Why the last pick did not load (cleared by the next pick). */
	error: string | null;
	/** More photos from the list (Settings' More), this load only. */
	more: Photo[];
	moreBusy: boolean;
}

function readPrefs(): Prefs {
	try { return parsePrefs(localStorage.getItem(PREFS_KEY)); } catch { return { ...DEFAULT_PREFS }; }
}
function savePrefs(p: Prefs): void {
	try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* kept for this load only */ }
}
function readHint(): WallpaperHint | null {
	try {
		const h = JSON.parse(localStorage.getItem(HINT_KEY) ?? "null") as WallpaperHint | null;
		return h && typeof h.css === "string" && isNum(h.luma) ? h : null;
	} catch { return null; }
}

export const desktop$ = createStore<State>({ prefs: readPrefs(), shown: null, pending: null, error: null, more: [], moreBusy: false });
export function useDesktop<T>(pick: (s: State) => T): T {
	return useSyncExternalStore(desktop$.subscribe, () => pick(desktop$.get()));
}

const presetOf = (id: string) => PRESETS.find((p) => p.id === id);

/** The root's hooks and the first-paint hint, from what is shown (before anything is: the last hint). */
function applyRoot(writeHint = true): void {
	if (typeof document === "undefined") return;
	const { prefs, shown } = desktop$.get();
	const root = document.documentElement;
	const kind = !shown ? (readHint() ? "photo" : "default") : shown.key === "default" ? "default" : shown.url ? "photo" : "preset";
	const t = shown ? tone(shown.luma, shown.url ? prefs.dim : 0) : (() => { const h = readHint(); return h ? { luma: h.luma, light: h.light } : tone(DEFAULT_LUMA, 0); })();
	root.dataset.wallpaper = t.light ? "light" : "dark";
	root.style.setProperty("--wallpaper-luma", String(t.luma));
	if (shown) root.dataset.wallpaperKind = kind;
	if (!writeHint || !shown) return;
	try {
		if (shown.key === "default") localStorage.removeItem(HINT_KEY);
		else {
			const css = shown.url && shown.tiny && shown.color ? photoHintCss(shown.tiny, shown.color, prefs.dim) : shown.css;
			if (css) localStorage.setItem(HINT_KEY, JSON.stringify({ css, light: t.light, luma: t.luma } satisfies WallpaperHint));
		}
	} catch { /* no first-paint hint */ }
}

/** A photo decoded and ready to show. */
interface Ready { key: string; url: string; img: HTMLImageElement; photo: Photo; luma: number; tiny?: string; color?: string }
/** The decoded image of what is shown (for blur). */
let shownImg: HTMLImageElement | null = null;
let loadSeq = 0;

/** Drop object URLs once the fade that hides them is over. */
function revokeLater(...urls: (string | undefined)[]): void {
	setTimeout(() => { for (const u of urls) if (u) URL.revokeObjectURL(u); }, 1500);
}

async function openCache(): Promise<Cache | null> {
	try { return typeof caches === "undefined" ? null : await caches.open(CACHE_NAME); } catch { return null; }
}
const cacheKey = () => new URL(CACHE_PATH, location.href).href;

/** Decode a blob; sample its luma under the top bar (the top eighth), its mean colour and a tiny copy. */
async function decode(photo: Photo, blob: Blob): Promise<Ready> {
	const url = URL.createObjectURL(blob);
	try {
		const img = new Image();
		img.src = url;
		await img.decode();
		const r: Ready = { key: `photo:${photo.id}`, url, img, photo, luma: 0.5 };
		try {
			const c = document.createElement("canvas");
			c.width = 32; c.height = 32;
			const ctx = c.getContext("2d", { willReadFrequently: true })!;
			ctx.drawImage(img, 0, 0, 32, 32);
			const d = ctx.getImageData(0, 0, 32, 32).data;
			r.luma = lumaOf(d, 32, 0, 4);
			r.color = meanColor(d);
			c.width = 32; c.height = Math.max(1, Math.round((32 * img.naturalHeight) / img.naturalWidth));
			c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
			r.tiny = c.toDataURL("image/jpeg", 0.6);
		} catch { /* unknown: taken as mid-grey, no hint */ }
		return r;
	} catch (e) {
		URL.revokeObjectURL(url);
		throw e;
	}
}

/** A plain request: CORS, no credentials, no referrer. */
const plain = (ms: number): RequestInit => ({ mode: "cors", credentials: "omit", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(ms) });

/** The photo from the network at this viewport's size; low priority on load (`low`), so the kernel's downloads go first. */
async function fetchPhoto(photo: Photo, low = false): Promise<Blob> {
	const { w, h } = photoSize(innerWidth, innerHeight, devicePixelRatio, photo);
	const r = await fetch(photoUrl(photo.id, w, h), { ...plain(30_000), ...(low ? { priority: "low" } : {}) } as RequestInit);
	if (!r.ok) throw new Error(`HTTP ${r.status}`);
	const blob = await r.blob();
	if (!blob.type.startsWith("image/")) throw new Error("not an image");
	return blob;
}

/** The cached photo (this one only, if `key`), with its credit, or null. */
async function cachedPhoto(key?: string): Promise<{ photo: Photo; blob: Blob } | null> {
	try {
		const r = await (await openCache())?.match(cacheKey());
		if (!r || (key && r.headers.get("x-kw-wallpaper") !== key)) return null;
		const photo = parsePhoto(JSON.parse(decodeURIComponent(r.headers.get("x-kw-photo") ?? "")));
		return photo ? { photo, blob: await r.blob() } : null;
	} catch { return null; }
}
/** Keep this photo as the cache's one entry (none: empty it). */
async function cachePhoto(photo: Photo | null, blob?: Blob): Promise<void> {
	try {
		const c = await openCache();
		if (!c) return;
		if (photo && blob) {
			await c.put(cacheKey(), new Response(blob, { headers: {
				"content-type": blob.type, "x-kw-wallpaper": `photo:${photo.id}`, "x-kw-photo": encodeURIComponent(JSON.stringify(photo)),
			} }));
		} else await c.delete(cacheKey());
	} catch { /* storage full or refused: the network next time */ }
}

/** The photo pre-blurred: drawn small (with a canvas blur where there is one) and shown scaled up, a still image. */
async function blurred(img: HTMLImageElement): Promise<string | undefined> {
	try {
		const c = document.createElement("canvas");
		const ctx = c.getContext("2d")!;
		const filter = "filter" in ctx;
		const w = filter ? 192 : 48, h = Math.max(1, Math.round((w * img.naturalHeight) / img.naturalWidth));
		c.width = w; c.height = h;
		const m = filter ? 8 : 0; // past the edges, so the blur does not fade them
		if (filter) ctx.filter = "blur(3px)";
		ctx.drawImage(img, -m, -m, w + 2 * m, h + 2 * m);
		const blob = await new Promise<Blob | null>((res) => c.toBlob(res, "image/webp", 0.9));
		return blob ? URL.createObjectURL(blob) : undefined;
	} catch { return undefined; }
}

function show(next: Shown, img: HTMLImageElement | null): void {
	const prev = desktop$.get().shown;
	shownImg = img;
	desktop$.set({ shown: next });
	if (prev && prev.url !== next.url) revokeLater(prev.url, prev.blurUrl);
	applyRoot();
}

/** Show a decoded photo, blurred if blur is on. */
async function showPhoto(r: Ready): Promise<void> {
	const blurUrl = desktop$.get().prefs.blur ? await blurred(r.img) : undefined;
	show({ key: r.key, url: r.url, blurUrl, photo: r.photo, luma: r.luma, tiny: r.tiny, color: r.color }, r.img);
}

function commit(patch: Partial<Prefs>): void {
	const prefs = { ...desktop$.get().prefs, ...patch };
	desktop$.set({ prefs });
	savePrefs(prefs);
}

/** Load, decode and show a photo (and cache it); false if it was overtaken by another load. */
async function loadPhoto(photo: Photo, seq: number, opts: { cached?: Blob; low?: boolean } = {}): Promise<boolean> {
	const blob = opts.cached ?? (await fetchPhoto(photo, opts.low));
	const r = await decode(photo, blob);
	if (seq !== loadSeq) { URL.revokeObjectURL(r.url); return false; }
	await showPhoto(r);
	if (!opts.cached) void cachePhoto(photo, blob);
	return true;
}

/** Random: another photo of the pool (not the one shown, not the last pick). `quiet`: on load, no error line. */
async function roll(quiet = false): Promise<void> {
	const seq = ++loadSeq, { shown, prefs } = desktop$.get();
	const photo = pickRandom(PHOTOS, [prefs.last, shown?.photo?.id]);
	desktop$.set({ pending: quiet ? null : "random", error: null });
	try {
		if (await loadPhoto(photo, seq, { low: quiet })) commit({ last: photo.id });
	} catch {
		if (seq === loadSeq && !quiet) desktop$.set({ error: "No new photo now." });
	} finally {
		if (seq === loadSeq) desktop$.set({ pending: null });
	}
}

/**
 * Set the wallpaper: a preset or the default at once, a photo once it has
 * loaded (what is shown stays until then, and stays if it fails), Random by
 * rolling a photo.
 */
export async function setWallpaper(w: Wallpaper): Promise<void> {
	const key = wallpaperKey(w);
	if (w.kind === "random") { commit({ wallpaper: w }); return roll(); }
	if (w.kind !== "photo") {
		++loadSeq;
		desktop$.set({ pending: null, error: null });
		commit({ wallpaper: w });
		const p = w.kind === "preset" ? presetOf(w.id) : undefined;
		show(p ? { key, css: p.css, luma: p.luma } : { key, luma: DEFAULT_LUMA }, null);
		void cachePhoto(null);
		return;
	}
	// The photo shown (Random's pick): pinned as it is.
	if (desktop$.get().shown?.key === key) { ++loadSeq; desktop$.set({ pending: null, error: null }); commit({ wallpaper: w }); return; }
	const seq = ++loadSeq;
	desktop$.set({ pending: key, error: null });
	try {
		const cached = await cachedPhoto(key);
		if (await loadPhoto(w.photo, seq, { cached: cached?.blob })) commit({ wallpaper: w });
	} catch {
		if (seq === loadSeq) desktop$.set({ error: "That photo did not load." });
	} finally {
		if (seq === loadSeq) desktop$.set({ pending: null });
	}
}

/** Random: roll again (Settings' Next). */
export const nextRandom = (): Promise<void> => roll();
/** Random: pin the photo shown (Settings' Keep). */
export function keepRandom(): void {
	const p = desktop$.get().shown?.photo;
	if (p) void setWallpaper({ kind: "photo", photo: p });
}

/** The dim over a photo (0 to DIM_MAX). */
export function setDim(dim: number): void {
	commit({ dim: clamp(dim, 0, DIM_MAX) });
	applyRoot();
}

/** Blur a photo or not. */
export async function setBlur(on: boolean): Promise<void> {
	commit({ blur: on });
	const s = desktop$.get().shown;
	if (!s?.url || !shownImg || on === !!s.blurUrl) return;
	if (!on) { show({ ...s, blurUrl: undefined }, shownImg); revokeLater(s.blurUrl); return; }
	const blurUrl = await blurred(shownImg);
	if (desktop$.get().shown === s && desktop$.get().prefs.blur) show({ ...s, blurUrl }, shownImg);
	else if (blurUrl) URL.revokeObjectURL(blurUrl);
}

/** Another page of Picsum's list (Settings' More): a dozen landscape photos not in PHOTOS. */
export async function morePhotos(): Promise<void> {
	if (desktop$.get().moreBusy) return;
	desktop$.set({ moreBusy: true, error: null });
	try {
		const page = 1 + Math.floor(Math.random() * 33); // about 990 photos, 30 a page
		const r = await fetch(`${PICSUM}/v2/list?page=${page}&limit=30`, plain(20_000));
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		const known = new Set(PHOTOS.map((p) => p.id));
		desktop$.set({ more: parseList(await r.json()).filter((p) => !known.has(p.id)).slice(0, 12) });
	} catch {
		desktop$.set({ error: "Could not reach picsum.photos." });
	} finally {
		desktop$.set({ moreBusy: false });
	}
}

let started = false;
/**
 * The saved wallpaper, on load (Wallpaper.tsx, at mount), never holding up
 * the boot: a preset at once; a chosen photo from the cache, else the
 * network; Random: the photo shown last (the cache) as the placeholder
 * while the next one loads (low priority), which fades in once decoded.
 * Failures are silent: the placeholder (or the default) stays.
 */
export function startDesktop(): void {
	if (started) return;
	started = true;
	const w = desktop$.get().prefs.wallpaper;
	applyRoot(false);
	if (w.kind === "preset") {
		const p = presetOf(w.id)!;
		show({ key: wallpaperKey(w), css: p.css, luma: p.luma }, null);
	} else if (w.kind === "default") {
		show({ key: "default", luma: DEFAULT_LUMA }, null);
	} else if (w.kind === "photo") {
		const seq = ++loadSeq;
		void (async () => {
			try { await loadPhoto(w.photo, seq, { cached: (await cachedPhoto(wallpaperKey(w)))?.blob, low: true }); } catch { /* the default stays; the next load tries again */ }
		})();
	} else {
		void (async () => {
			// The placeholder, unless the next photo (or a pick) is shown first.
			const cached = await cachedPhoto();
			if (!cached || desktop$.get().shown) return;
			try {
				const r = await decode(cached.photo, cached.blob);
				const blurUrl = desktop$.get().prefs.blur ? await blurred(r.img) : undefined;
				if (desktop$.get().shown) { revokeLater(r.url, blurUrl); return; }
				show({ key: r.key, url: r.url, blurUrl, photo: r.photo, luma: r.luma, tiny: r.tiny, color: r.color }, r.img);
			} catch { /* none */ }
		})();
		void roll(true);
	}
}
