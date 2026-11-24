// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// A Wayland app's own icon from the guest, by its app id (host.ts: for a
// window that stands for no launcher app). Wayland's core protocol carries
// no icon (wland offers no xdg-toplevel-icon-v1), so this does what desktops
// do: the app id names a .desktop file (<app_id>.desktop in the XDG data
// dirs, any case, else one whose StartupWMClass is the app id), its Icon=
// names a file in the icon themes (hicolor, then Adwaita: scalable SVG,
// else the largest PNG up to 128 px, else a larger one), in
// /usr/share/pixmaps, or is a path; without a .desktop file the app id is
// the icon's name.
// - guestIcon(appId): the icon's blob: URL; null while it is not known (its
//   read runs, or waits for the machine); false: the guest has none. The
//   first call starts the read: one vm.exec() of ICON_SH, never while the
//   machine is held (store.ts isHeld; a later call tries again), never
//   blocking the caller; onGuestIcon() listeners hear when one is known.
// - Guest content is untrusted: only an SVG or a PNG (checked by its first
//   bytes) of at most MAX bytes is taken, as a blob of that type shown in an
//   <img> (components/icons.tsx MetaIcon: an SVG there runs no script and
//   loads nothing); the app id is passed as an argument, and only one made
//   of the characters app ids use is looked up.
// - Kept in memory for the page's life (a few KiB each, at most MAX_IDS).
import { KW } from "../kw.ts";
import type { KernelHandle } from "../sdk.ts";
import { isHeld, isRunning, ui$ } from "../store.ts";

/** The largest icon file taken. */
const MAX = 256 * 1024;
/** App ids looked up at most (a guest that makes up new ones is not followed further). */
const MAX_IDS = 64;
/** After a read that failed (a timeout, the kernel gone): not again before this long. */
const RETRY_MS = 30_000;
/** What an app id may be made of (reverse-DNS names, executables' names). */
const APP_ID = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;

/** The icon's file for app id $1 (see the top), printed as its extension ("svg" or "png") on a line, then its bytes; nothing when there is none. */
const ICON_SH = `id=$1 lc=$(printf %s "$1" | tr A-Z a-z) d= icon= f=
for a in "\${XDG_DATA_HOME:-$HOME/.local/share}" /usr/local/share /usr/share; do
	for n in "$id" "$lc"; do
		[ -f "$a/applications/$n.desktop" ] && { d=$a/applications/$n.desktop; break 2; }
	done
done
[ -n "$d" ] || d=$(grep -ilFx "StartupWMClass=$id" /usr/share/applications/*.desktop 2>/dev/null | head -n 1)
[ -n "$d" ] && icon=$(sed -n 's/^Icon=//p' "$d" | head -n 1)
[ -n "$icon" ] || icon=$id
case $icon in
/*) f=$icon ;;
*)
	for a in "\${XDG_DATA_HOME:-$HOME/.local/share}/icons" /usr/share/icons; do
		for t in hicolor Adwaita; do
			for s in scalable/apps/$icon.svg 128x128/apps/$icon.png 96x96/apps/$icon.png 64x64/apps/$icon.png 48x48/apps/$icon.png 256x256/apps/$icon.png 512x512/apps/$icon.png 32x32/apps/$icon.png; do
				[ -f "$a/$t/$s" ] && { f=$a/$t/$s; break 3; }
			done
		done
	done
	[ -n "$f" ] || for x in .svg .png ""; do [ -f "/usr/share/pixmaps/$icon$x" ] && { f=/usr/share/pixmaps/$icon$x; break; }; done
esac
case $f in *.svg | *.png) ;; *) exit 0 ;; esac
[ -f "$f" ] && [ "$(wc -c <"$f")" -le ${MAX} ] || exit 0
printf '%s\\n' "\${f##*.}"
exec cat "$f"`;

/** Known icons by app id: a blob: URL, or false (none). */
const icons = new Map<string, string | false>();
const reading = new Set<string>();
/** App ids whose read failed, and when they may be tried again. */
const retryAt = new Map<string, number>();
const listeners = new Set<() => void>();

/** App id's icon (see the top): its blob: URL, null while not known, false when there is none. */
export function guestIcon(appId: string): string | null | false {
	const known = icons.get(appId);
	if (known !== undefined) return known;
	if (!APP_ID.test(appId) || icons.size >= MAX_IDS) return false;
	void read(appId);
	return null;
}

/** Call f when an icon becomes known (or known to be missing). Returns the unsubscribe. */
export function onGuestIcon(f: () => void): () => void {
	listeners.add(f);
	return () => { listeners.delete(f); };
}

function settle(appId: string, icon: string | false): void {
	icons.set(appId, icon);
	for (const f of listeners) {
		try { f(); } catch (e) { queueMicrotask(() => { throw e; }); }
	}
}

/** The icon's bytes as a blob of its type, or null when they are not what the extension says. */
function blobOf(ext: string, bytes: Uint8Array): Blob | null {
	if (!bytes.length || bytes.length > MAX) return null;
	if (ext === "png") return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 ? new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "image/png" }) : null;
	if (ext === "svg") return /<svg[\s>]/.test(new TextDecoder().decode(bytes.subarray(0, 4096))) ? new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "image/svg+xml" }) : null;
	return null;
}

async function read(appId: string): Promise<void> {
	const vm = KW.vm as KernelHandle | undefined, s = ui$().get();
	if (reading.has(appId) || (retryAt.get(appId) ?? 0) > Date.now() || !vm || !isRunning(s) || isHeld(s)) return;
	reading.add(appId);
	try {
		const r = await vm.exec("/bin/sh", ["-c", ICON_SH, "sh", appId], { encoding: "buffer", timeout: 8000, signal: AbortSignal.timeout(15_000), maxBuffer: MAX + 16 });
		const out = r.stdout, nl = out.indexOf(10);
		const blob = nl > 0 && nl < 8 ? blobOf(new TextDecoder().decode(out.subarray(0, nl)), out.subarray(nl + 1)) : null;
		settle(appId, blob ? URL.createObjectURL(blob) : false);
	} catch {
		retryAt.set(appId, Date.now() + RETRY_MS);
	} finally {
		reading.delete(appId);
	}
}
