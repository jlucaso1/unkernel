// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Extreme Tux Racer: Tux sliding down snowy slopes, on X in the Display
// window (xkms.ts; Debian). Not a Wayland window: it draws through SFML
// 2.6, whose Linux windows are X11 only, and the page's Xwayland (xwl.ts)
// has no GPU GL.
// Fixed-function OpenGL (GLX) through Mesa's virgl driver with guest GL on
// (Options); without it, X has no DRM device to start on. Its settings are
// ~/.etr/options.txt. About 332 MiB installed, 108 MiB to download, Mesa,
// LLVM and X about 284 MiB of that (the image's package lists,
// 2026-11-22). Its sound plays where the page has a sound card.
import type { TerminalApp } from "../types.ts";
import { X_KMS_PACKAGES, X_KMS_SH } from "../xkms.ts";

export default {
	id: "extremetuxracer",
	title: "Extreme Tux Racer",
	desc: "Slide Tux down snowy slopes (OpenGL), on X in the Display window",
	// Snowy peaks (crafted).
	icon: { svg: '<path opacity=".65" d="M1 21 9 6l4.2 7.6L16 9l7 12Z"/><path d="M9 6l2.6 4.8-1.4-.9-1.2 1.6-1.3-1.6-1.3.9Zm7 3 1.9 3.1-1-.6-.9 1.1-.8-1Z"/>' },
	colors: ["#38bdf8", "#1e3a8a"],
	needs: { display: true, net: true },
	packages: { debian: ["extremetuxracer", ...X_KMS_PACKAGES] },
	files: { "x.sh": { content: X_KMS_SH, mode: 0o755 } },
	commands: [
		"echo 'Extreme Tux Racer on X in the Display window (guest GL on: Options): the arrows steer, paddle and brake, Space jumps, Esc goes back'",
		"./x.sh /usr/games/etr",
	],
} satisfies TerminalApp;
