// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Galculator: a GTK 3 scientific calculator (basic, scientific and paper
// modes, RPN) as a window on the page's Wayland desktop (wayland.ts;
// Debian). 1.5 MiB on top of the GTK 3 base the desktop apps share (about
// 107 MiB installed, 21 MiB to download, 2026-11-22).
import type { TerminalApp } from "../types.ts";

export default {
	id: "galculator",
	title: "Galculator",
	desc: "A scientific calculator, in a window on the page",
	// A calculator: the display and the keys (crafted).
	icon: { svg: '<path fill-rule="evenodd" d="M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm1 2.5v4h8v-4ZM8 11v2h2v-2Zm3 0v2h2v-2Zm3 0v2h2v-2Zm-6 3.5v2h2v-2Zm3 0v2h2v-2Zm3 0V20h2v-5.5ZM8 18v2h2v-2Zm3 0v2h2v-2Z"/>' },
	colors: ["#a855f7", "#3b0764"],
	needs: { net: true, wayland: true },
	packages: { debian: ["galculator"] },
	commands: ["galculator"],
} satisfies TerminalApp;
