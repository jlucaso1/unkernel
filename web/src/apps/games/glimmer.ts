// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// glimmer: the framebuffer game every distro image has (guest/src/glimmer.c).
import type { TerminalApp } from "../types.ts";

export default {
	id: "glimmer",
	title: "glimmer",
	desc: "A small game on the guest's framebuffer, keyboard, mouse and sound",
	// A sparkle.
	icon: { svg: '<path d="M10 2c.6 6.1 3 8.4 9 9-6 .6-8.4 2.9-9 9-.6-6.1-3-8.4-9-9 6-.6 8.4-2.9 9-9Z"/><path opacity=".8" d="M19 13.5c.3 3 1.5 4.2 4 4.5-2.5.3-3.7 1.5-4 4.5-.3-3-1.5-4.2-4-4.5 2.5-.3 3.7-1.5 4-4.5Z"/><path opacity=".6" d="M19 1.5c.2 2 1 2.8 2.5 3-1.5.2-2.3 1-2.5 3-.2-2-1-2.8-2.5-3 1.5-.2 2.3-1 2.5-3Z"/>' },
	colors: ["#7c3aed", "#ec4899"],
	needs: { display: true },
	files: {
		"README": "glimmer: a small game in every distro image (/usr/bin/glimmer, guest/src/glimmer.c).\n" +
			"It draws on /dev/fb0 (kwfb), reads the keyboard and mouse through evdev (kwinput)\n" +
			"and plays sound through ALSA when there is a sound card.\n\n" +
			"M or Tab mutes. The picture is in the Display window; this shell stays in its Terminal window.\n" +
			"Try: glimmer --test   (a fixed pattern, a test tone, and every input event printed)\n",
	},
	commands: ["cat README", "glimmer"],
} satisfies TerminalApp;
