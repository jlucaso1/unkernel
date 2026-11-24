// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// X.Org on the guest's DRM device: the modesetting driver with glamor
// (the kw layer's /etc/X11/kw-kms.conf), then glxgears as a GLX client;
// both render through Mesa's virgl driver and the page's WebGL2 (Debian).
// The script that starts X and follows the page's display size is xkms.ts's.
import type { TerminalApp } from "../types.ts";
import { X_KMS_PACKAGES, X_KMS_SH } from "../xkms.ts";

export default {
	id: "xglamor",
	title: "X + glamor",
	desc: "X.Org with the modesetting driver and glamor on /dev/dri, and glxgears on the GPU",
	icon: "X",
	colors: ["#475569", "#0f172a"],
	needs: { display: true, net: true },
	packages: { debian: [...X_KMS_PACKAGES, "mesa-utils"] },
	files: {
		"start.sh": { content: X_KMS_SH, mode: 0o755 },
		"README": "./start.sh [CLIENT ARGS...] starts X on /dev/dri/card0 with glamor\n" +
			"(Xorg :0 -config kw-kms.conf, /etc/X11/kw-kms.conf) and runs CLIENT on it,\n" +
			"glxgears by default; X stops when the client does, and follows the\n" +
			"page's display size (xrandr) while it runs. Try, after\n" +
			"sudo apt-get install glmark2-x11 xterm:  ./start.sh glmark2   ./start.sh xterm\n",
	},
	commands: ["cat README", "./start.sh"],
} satisfies TerminalApp;
