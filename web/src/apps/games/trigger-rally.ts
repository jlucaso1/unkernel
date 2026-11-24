// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Trigger Rally: rally driving against the clock, on X in the Display
// window (xkms.ts; Debian). Not a Wayland window: it stops when GLEW's
// glewInit() fails, which it does under SDL's Wayland driver (no GLX
// display). Fixed-function OpenGL through Mesa's virgl driver with guest GL
// on (Options); without it, X has no DRM device to start on. Its window is
// 800x600 at X's top left (its settings,
// ~/.local/share/trigger-rally/trigger-rally-0.6.6.1.config). About 422 MiB
// installed, 189 MiB to download, Mesa, LLVM and X about 284 MiB of that
// (the image's package lists, 2026-11-22). Its sound (OpenAL) plays where
// the page has a sound card.
import type { TerminalApp } from "../types.ts";
import { X_KMS_PACKAGES, X_KMS_SH } from "../xkms.ts";

export default {
	id: "trigger-rally",
	title: "Trigger Rally",
	desc: "Rally driving against the clock (OpenGL), on X in the Display window",
	// A rally car (crafted).
	icon: { svg: '<path fill-rule="evenodd" d="M3 15l2-5c.3-.6.8-1 1.5-1h9c.7 0 1.2.4 1.5 1l2 5v3h-2a2 2 0 0 1-4 0H9.5a2 2 0 0 1-4 0H3Zm4-4.5h4.5v3H6Zm6 0h4l1 3h-5Z"/>' },
	colors: ["#dc2626", "#78350f"],
	needs: { display: true, net: true },
	packages: { debian: ["trigger-rally", ...X_KMS_PACKAGES] },
	files: { "x.sh": { content: X_KMS_SH, mode: 0o755 } },
	commands: [
		"echo 'Trigger Rally on X in the Display window (guest GL on: Options): the arrows drive, Space is the handbrake, Esc is the menu'",
		"./x.sh /usr/games/trigger-rally",
	],
} satisfies TerminalApp;
