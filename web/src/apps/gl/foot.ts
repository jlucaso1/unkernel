// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// foot: a Wayland terminal as a window on the page's Wayland desktop
// (wayland.ts): it connects to wland's relay in the guest (started at boot,
// the session is in every shell), whose compositor runs on the page and
// reads foot's buffers in place through kwshm (Debian).
import type { TerminalApp } from "../types.ts";

export default {
	id: "foot",
	title: "foot",
	desc: "A Wayland terminal in a window on the page: wland's compositor runs here, the app's pixels stay in guest memory (kwshm)",
	// A window with a prompt (crafted).
	icon: { svg: '<path d="M4 3h16a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm0 4v12h16V7Zm2.3 3.3 1.4-1.4 3.6 3.6-3.6 3.6-1.4-1.4 2.2-2.2ZM12 15h6v2h-6Z"/>' },
	colors: ["#22c55e", "#0f766e"],
	needs: { net: true, wayland: true },
	packages: { debian: ["foot", "fonts-dejavu-core", "fontconfig"] },
	files: {
		README: "Wayland apps open as windows on this page: just run them (foot). wland's relay\n" +
			"runs in the guest from boot (its log is $XDG_RUNTIME_DIR/wlandr.log) and every\n" +
			"shell has the session (echo $WAYLAND_DISPLAY says wayland-0). Where it is not\n" +
			"(a session saved before, a killed relay), wland CMD starts it and runs CMD.\n" +
			"The Dock's desktop tile (Ctrl-A w) switches between these windows and the\n" +
			"others; Alt+drag moves a window, Alt+F10 maximizes it. More to try:\n" +
			"  sudo apt-get install wl-clipboard wayland-utils\n" +
			"  wayland-info;  echo hi | wl-copy;  wl-paste\n" +
			"GTK 3 apps work too:\n" +
			"  sudo apt-get install --no-install-recommends l3afpad;  l3afpad\n",
	},
	commands: ["cat README", "foot"],
} satisfies TerminalApp;
