// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// glmark2: the GLES 2 benchmark on the guest's /dev/dri (glmark2-es2-drm),
// through Mesa's virgl driver and the page's WebGL2 (guest GL, Debian).
import type { TerminalApp } from "../types.ts";

export default {
	id: "glmark2",
	title: "glmark2",
	desc: "The OpenGL ES benchmark on the GPU (KMS on /dev/dri); frames above 60 a second are drawn but not shown",
	// A gauge.
	icon: { svg: '<path d="M12 4a10 10 0 0 0-8.7 14.9l1.8-1A8 8 0 1 1 18.9 17.9l1.8 1A10 10 0 0 0 12 4Zm4.6 4.3-5.7 4a2 2 0 1 0 2.3 2.3Z"/>' },
	colors: ["#f59e0b", "#dc2626"],
	needs: { display: true, net: true },
	packages: { debian: ["mesa-utils", "glmark2-es2-drm"] },
	files: {
		"README": "glmark2-es2-drm draws on /dev/dri/card0 (virtio-gpu) with Mesa's virgl driver.\n" +
			"  ./run.sh                       every scene (a key stops it)\n" +
			"  glmark2-es2-drm $V -b jellyfish  one scene (V is the visual below)\n" +
			"  glmark2-es2-drm $V --off-screen   without the 60 Hz page flips\n" +
			"The --visual-config works around glmark2 2023.01 picking RGB565 and then\n" +
			"refusing its own surface; do not pass -s or --fullscreen.\n",
	},
	commands: [
		"cat README",
		"eglinfo -B -p gbm | grep -E 'renderer' || true",
		"glmark2-es2-drm --visual-config red=8:green=8:blue=8:alpha=0",
	],
} satisfies TerminalApp;
