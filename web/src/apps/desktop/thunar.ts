// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Thunar: Xfce's file manager (GTK 3) as a window on the page's Wayland
// desktop (wayland.ts), opened on the home directory (Debian). The GTK 3
// apps share one base (GTK, its icons and fonts: about 107 MiB installed,
// 21 MiB to download, from the image's package lists, 2026-11-22); Thunar
// adds 17 MiB. Without recommends: no gvfs (trash, network places), no
// tumbler (thumbnails), which keeps it light here. librsvg2-common, a
// recommends of GTK and Adwaita, is asked for by name (2 MiB to download,
// 6 MiB installed): Adwaita 48's file and folder icons are SVG with only a
// 16 px PNG beside each, and without librsvg's gdk-pixbuf loader GTK
// stretches that PNG to the icon's size (blurry, worse at scale 2). It runs
// in a session bus of its own (dbus-run-session) so that xfconf keeps its
// settings.
import type { TerminalApp } from "../types.ts";

export default {
	id: "thunar",
	title: "Thunar",
	desc: "Xfce's file manager, in a window on the page",
	// A folder (crafted).
	icon: { svg: '<path opacity=".7" d="M3 6a2 2 0 0 1 2-2h4.2a2 2 0 0 1 1.4.6L12 6h7a2 2 0 0 1 2 2v1H3Z"/><path d="M3 10.5h18V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>' },
	colors: ["#facc15", "#a16207"],
	needs: { net: true, wayland: true },
	packages: { debian: ["thunar", "dbus-daemon", "librsvg2-common"] },
	commands: ["dbus-run-session -- thunar \"$HOME\""],
} satisfies TerminalApp;
