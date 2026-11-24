// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Lugaru: the 3D action game of a rabbit warrior (Wolfire's, open source),
// as a window on the page's Wayland desktop (wayland.ts; Debian). SDL2 on
// Wayland (the session's SDL_VIDEODRIVER, kw-wayland.sh) with
// fixed-function OpenGL through EGL, inside the GL 2.1 compatibility
// profile that guest GL offers (.agents/gl.md). Started windowed. The
// mouse looks (SDL's relative mode: wland has relative pointers and pointer
// locks). About 252 MiB installed, 82 MiB to download, Mesa and LLVM about
// 188 MiB of that (the image's package lists, 2026-11-22). Its sound
// (OpenAL) plays where the page has a sound card.
// The SDL prefix and packages: sdlwl.ts (the page's window frame; libdecor
// preferred from the start for a compositor that answers client-side).
import type { TerminalApp } from "../types.ts";
import { SDL_WL, SDL_WL_PACKAGES } from "../sdlwl.ts";

export default {
	id: "lugaru",
	title: "Lugaru",
	desc: "3D fighting as a rabbit warrior (OpenGL, SDL2), in a window on the page",
	// A rabbit's head, its long ears up (crafted).
	icon: { svg: '<path d="M8.5 2C10 2 11 4.5 11 8v1.6a5.6 5.6 0 0 1 2 0V8c0-3.5 1-6 2.5-6S18 5 17 9l-.7 2.4A6.5 6.5 0 1 1 7.7 11.4L7 9C6 5 7 2 8.5 2Z"/>' },
	colors: ["#a16207", "#1c1917"],
	needs: { net: true, wayland: true },
	packages: { debian: ["lugaru", ...SDL_WL_PACKAGES] },
	commands: [
		"echo 'WASD moves, the mouse looks (click to grab it), Space jumps, Shift crouches, the button attacks'",
		`${SDL_WL} /usr/games/lugaru --windowed`,
	],
} satisfies TerminalApp;
