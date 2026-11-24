// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// X11 desktop: an X screen in a window on the page's Wayland desktop
// (Xwayland rootful, xwl.ts; Debian), with twm and the classic clients:
// xterm, xclock, xeyes; twm's menu (a click on the desktop) opens more, and
// any X app started from the xterm shows there. twm's Quit ends the session
// and X. Its window (Xwayland's, app id org.freedesktop.Xwayland) stands for
// this app, Xfce's and XPaint's too.
import type { TerminalApp } from "../types.ts";
import { XWL_PACKAGES, XWL_PREP, XWL_SH, XWL_TWMRC } from "../xwl.ts";

export default {
	id: "x11",
	title: "X11",
	desc: "An X desktop (twm, xterm, xclock, xeyes) in a window on the page, through Xwayland",
	// The X: a thick stroke and a thin one (crafted).
	icon: { svg: '<path d="M4 3h4l12 18h-4Z"/><path d="M18.6 3H20L5.4 21H4Z"/>' },
	colors: ["#f97316", "#7c2d12"],
	needs: { net: true, wayland: true },
	packages: { debian: [...XWL_PACKAGES, "xterm", "x11-apps", "fonts-dejavu-core", "fontconfig"] },
	waylandIds: ["org.freedesktop.Xwayland"],
	files: {
		"xwl.sh": { content: XWL_SH, mode: 0o755 },
		twmrc: XWL_TWMRC,
		"session.sh": {
			mode: 0o755,
			content: "#!/bin/sh\n" +
				"# The X11 desktop's session: a few classic X clients, then twm in the\n" +
				"# foreground (its menu's Quit ends the session and X).\n" +
				"xterm -fa Monospace -fs 11 -bg '#0f172a' -fg '#e2e8f0' -geometry 80x24+40+40 &\n" +
				"xclock -update 1 -geometry 160x160-24+24 &\n" +
				"xeyes -geometry 160x110-24+212 &\n" +
				"exec twm -f twmrc\n",
		},
	},
	commands: [XWL_PREP, "XWL_NO_WM=1 ./xwl.sh ./session.sh"],
} satisfies TerminalApp;
