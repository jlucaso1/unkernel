// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Emilia Pinball: a 3D pinball table, as a window on the page's Wayland
// desktop (wayland.ts; Debian). SDL2 on Wayland (the session's
// SDL_VIDEODRIVER, kw-wayland.sh) with fixed-function OpenGL through EGL,
// inside the GL 2.1 compatibility profile that guest GL offers
// (.agents/gl.md). About 224 MiB installed, 55 MiB to download, Mesa and
// LLVM about 188 MiB of that (the image's package lists, 2026-11-22). Its
// sound plays where the page has a sound card.
// The SDL prefix and packages: sdlwl.ts (the page's window frame; libdecor
// preferred from the start for a compositor that answers client-side).
import type { TerminalApp } from "../types.ts";
import { SDL_WL, SDL_WL_PACKAGES } from "../sdlwl.ts";

export default {
	id: "pinball",
	title: "Pinball",
	desc: "Emilia Pinball, a 3D table (OpenGL, SDL2), in a window on the page",
	// A ball above two flippers (crafted).
	icon: { svg: '<circle cx="12" cy="7" r="3.5"/><path d="M2.5 15.2l1.1-1.6 7.6 4.8-.9 1.6Zm19 0-1.1-1.6-7.6 4.8.9 1.6Z"/>' },
	colors: ["#db2777", "#3b0764"],
	needs: { net: true, wayland: true },
	packages: { debian: ["pinball", ...SDL_WL_PACKAGES] },
	commands: [
		"echo 'Enter launches the ball, left and right Shift flip, Space nudges, Esc is the menu'",
		`${SDL_WL} /usr/games/pinball`,
	],
} satisfies TerminalApp;
