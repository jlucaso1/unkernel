// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Four in a Row: GNOME's connect-four against the computer (GTK 3) as a
// window on the page's Wayland desktop (wayland.ts; Debian). 5 MiB on top of
// the GTK 3 base the desktop apps share (about 107 MiB installed, 21 MiB to
// download, 2026-11-22). It runs in a session bus of its own
// (dbus-run-session) so that its settings (GSettings, dconf) are kept.
import type { TerminalApp } from "../types.ts";

export default {
	id: "four-in-a-row",
	title: "Four in a Row",
	desc: "Connect four against the computer, in a window on the page",
	// The board, a few discs dropped in.
	icon: { svg: '<path fill-rule="evenodd" d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm.4 4a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0-3.2 0Zm4 0a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0-3.2 0Zm4 0a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0-3.2 0Zm4 0a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0-3.2 0Zm-12 4a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0-3.2 0Zm4 0a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0-3.2 0Zm4 0a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0-3.2 0Zm4 0a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0-3.2 0Zm-12 4a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0-3.2 0Zm4 0a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0-3.2 0Zm4 0a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0-3.2 0Zm4 0a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0-3.2 0Z"/><path opacity=".6" d="M8.8 16a1.2 1.2 0 1 0 2.4 0a1.2 1.2 0 1 0-2.4 0Zm4 0a1.2 1.2 0 1 0 2.4 0a1.2 1.2 0 1 0-2.4 0Zm0-4a1.2 1.2 0 1 0 2.4 0a1.2 1.2 0 1 0-2.4 0Zm4 4a1.2 1.2 0 1 0 2.4 0a1.2 1.2 0 1 0-2.4 0Z"/>' },
	colors: ["#3b82f6", "#1e3a8a"],
	needs: { net: true, wayland: true },
	packages: { debian: ["four-in-a-row", "dbus-daemon"] },
	commands: ["dbus-run-session -- /usr/games/four-in-a-row"],
} satisfies TerminalApp;
