// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// GL windows: a Wayland GL app (es2gears_wayland, Mesa's demo) as a window on
// the page's Wayland desktop (wayland.ts). With guest GL on, Mesa renders
// on the guest's virtio-gpu (virgl, the page's WebGL2) and wland's relay
// names each frame's buffer by its GPU resource, which the page shows
// without reading it back; without guest GL the app renders in software
// (llvmpipe) into shared memory like any other window (Debian).
import type { TerminalApp } from "../types.ts";

export default {
	id: "wlgl",
	title: "GL windows",
	desc: "Wayland GL apps in windows on the page: rendered on the GPU (guest GL), shown without a readback",
	// Two gears (crafted).
	icon: { svg: '<path d="M8 3h2l.4 1.9 1.3.6 1.6-1.1 1.4 1.4-1.1 1.6.6 1.3L16 9v2l-1.9.4-.6 1.3 1.1 1.6-1.4 1.4-1.6-1.1-1.3.6L10 17H8l-.4-1.9-1.3-.6-1.6 1.1-1.4-1.4 1.1-1.6-.6-1.3L2 11V9l1.9-.4.6-1.3-1.1-1.6 1.4-1.4 1.6 1.1 1.3-.6Zm1 4.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5ZM17 14h1.4l.3 1.2.8.4 1-.7 1 1-.7 1 .4.8 1.2.3v1.4l-1.2.3-.4.8.7 1-1 1-1-.7-.8.4-.3 1.2H17l-.3-1.2-.8-.4-1 .7-1-1 .7-1-.4-.8-1.2-.3v-1.4l1.2-.3.4-.8-.7-1 1-1 1 .7.8-.4Zm.7 3a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6Z"/>' },
	colors: ["#8b5cf6", "#0f766e"],
	needs: { net: true, wayland: true },
	packages: { debian: ["mesa-utils"] },
	waylandIds: ["es2gears"],
	files: {
		README: "Wayland apps open as windows on this page (see the foot demo).\n" +
			"With guest GL on (Options), Mesa renders GL apps on the guest's virtio-gpu,\n" +
			"which is the page's WebGL2, and the page shows each frame from there: the\n" +
			"relay's log ($XDG_RUNTIME_DIR/wlandr.log) names the first buffer of each kind\n" +
			"(virtgpu: ... -> resource N). Without guest GL they render in software.\n" +
			"More to try:\n" +
			"  sudo apt-get install glmark2-es2-wayland;  glmark2-es2-wayland\n" +
			"  sudo apt-get install --no-install-recommends gtk-4-examples\n" +
			"  gtk4-widget-factory              (GTK 4 with its GL renderer)\n",
	},
	commands: ["cat README", "eglinfo -B -p wayland | grep -iE 'renderer|version' || true", "es2gears_wayland"],
} satisfies TerminalApp;
