// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Tali: GNOME's dice game (Yahtzee-like, GTK 3) as a window on the page's
// Wayland desktop (wayland.ts; Debian). 4 MiB on top of the GTK 3 base the
// desktop apps share (about 107 MiB installed, 21 MiB to download,
// 2026-11-22). It runs in a session bus of its own (dbus-run-session) so
// that its settings (GSettings, dconf) are kept.
import type { TerminalApp } from "../types.ts";

export default {
	id: "tali",
	title: "Tali",
	desc: "A dice game of poker hands, in a window on the page",
	// A die showing five.
	icon: { svg: '<path fill-rule="evenodd" d="M6 3h12a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Zm.3 4.5a1.7 1.7 0 1 0 3.4 0a1.7 1.7 0 1 0-3.4 0Zm8 0a1.7 1.7 0 1 0 3.4 0a1.7 1.7 0 1 0-3.4 0Zm-4 4.5a1.7 1.7 0 1 0 3.4 0a1.7 1.7 0 1 0-3.4 0Zm-4 4.5a1.7 1.7 0 1 0 3.4 0a1.7 1.7 0 1 0-3.4 0Zm8 0a1.7 1.7 0 1 0 3.4 0a1.7 1.7 0 1 0-3.4 0Z"/>' },
	colors: ["#10b981", "#064e3b"],
	needs: { net: true, wayland: true },
	packages: { debian: ["tali", "dbus-daemon"] },
	commands: ["dbus-run-session -- /usr/games/tali"],
} satisfies TerminalApp;
