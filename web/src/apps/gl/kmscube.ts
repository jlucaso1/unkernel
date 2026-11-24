// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// kmscube: a GBM/KMS client on the guest's /dev/dri (virtio-gpu), drawn by
// Mesa's virgl driver through the page's WebGL2 (guest GL, Debian).
import type { TerminalApp } from "../types.ts";

export default {
	id: "kmscube",
	title: "kmscube",
	desc: "A spinning cube on the GPU: Mesa on /dev/dri, rendered through the browser's WebGL2",
	// A cube.
	icon: { svg: '<path d="M12 2 3 7v10l9 5 9-5V7Zm0 2.3 6.5 3.6L12 11.5 5.5 7.9ZM5 9.6l6 3.3v6.5l-6-3.3Zm14 0v6.5l-6 3.3v-6.5Z"/>' },
	colors: ["#0ea5e9", "#6366f1"],
	needs: { display: true, net: true },
	packages: { debian: ["mesa-utils", "kmscube"] },
	commands: [
		"eglinfo -B -p gbm | grep -E 'renderer|OpenGL ES profile version' || true",
		"echo 'kmscube: any key stops it; the Environment tab has the Guest GL row'",
		"kmscube",
	],
} satisfies TerminalApp;
