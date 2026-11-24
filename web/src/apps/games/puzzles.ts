// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Puzzles: Simon Tatham's Portable Puzzle Collection (Debian's sgt-puzzles,
// GTK 3), 40 one-window logic games in /usr/games/sgt-*, as windows on the
// page's Wayland desktop (wayland.ts; Debian). 12 MiB on top of the GTK 3
// base the desktop apps share (about 107 MiB installed, 21 MiB to download,
// 2026-11-22). The app opens Mines; the README names a few others.
import type { TerminalApp } from "../types.ts";

export default {
	id: "puzzles",
	title: "Puzzles",
	desc: "Simon Tatham's 40 small logic puzzles, in windows on the page",
	// A puzzle grid with three cells filled.
	icon: { svg: '<path fill-rule="evenodd" d="M3 3h18v18H3Zm2 2v4h4V5Zm5 0v4h4V5Zm5 0v4h4V5ZM5 10v4h4v-4Zm5 0v4h4v-4Zm5 0v4h4v-4ZM5 15v4h4v-4Zm5 0v4h4v-4Zm5 0v4h4v-4Z"/><path opacity=".7" d="M5 5h4v4H5Zm10 5h4v4h-4Zm-5 5h4v4h-4Z"/>' },
	colors: ["#06b6d4", "#164e63"],
	needs: { net: true, wayland: true },
	packages: { debian: ["sgt-puzzles"] },
	files: {
		README: "40 puzzles, one command each (ls /usr/games/sgt-*). Try:\n" +
			"  sgt-net  sgt-loopy  sgt-untangle  sgt-solo  sgt-bridges  sgt-pattern\n",
	},
	commands: ["cat README", "/usr/games/sgt-mines"],
} satisfies TerminalApp;
