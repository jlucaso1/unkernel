// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// l3afpad: a small GTK 3 text editor (a Leafpad fork) as a window on the
// page's Wayland desktop (wayland.ts; Debian). Under 1 MiB on top of the
// GTK 3 base the desktop apps share (about 107 MiB installed, 21 MiB to
// download, 2026-11-22); test/wland/page-check.mjs drives it (typing, its
// context menu, the clipboard).
import type { TerminalApp } from "../types.ts";

export default {
	id: "l3afpad",
	title: "l3afpad",
	desc: "A small text editor, in a window on the page",
	// A page with lines of text and a folded corner (crafted).
	icon: { svg: '<path fill-rule="evenodd" d="M6 2h7v6h6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm1 9.5h10v1.6H7Zm0 3.4h10v1.6H7Zm0 3.4h6v1.6H7Z"/><path opacity=".6" d="M14.5 2 19 6.5h-4.5Z"/>' },
	colors: ["#84cc16", "#365314"],
	needs: { net: true, wayland: true },
	packages: { debian: ["l3afpad"] },
	commands: ["l3afpad"],
} satisfies TerminalApp;
