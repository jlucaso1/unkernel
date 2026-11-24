// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Neverball: tilt the floor to roll a ball to the goal, as a window on the
// page's Wayland desktop (wayland.ts; Debian). SDL2 on Wayland (the
// session's SDL_VIDEODRIVER, kw-wayland.sh) with desktop OpenGL through
// EGL: fixed-function GL with vertex buffers, inside the GL 2.1
// compatibility profile that guest GL offers (.agents/gl.md); with guest GL
// off Mesa draws it in software (llvmpipe), too slowly to play. The mouse
// tilts the floor (SDL's relative mode: wland has relative pointers and
// pointer locks). About 334 MiB installed, 85 MiB to download, Mesa and
// LLVM 188 MiB of that, the levels 119 (the image's package lists,
// 2026-11-22). Its sound plays where the page has a sound card; it does
// not need one. The SDL prefix and packages: sdlwl.ts (the page's window
// frame; libdecor preferred from the start for a compositor that answers
// client-side).
import type { TerminalApp } from "../types.ts";
import { SDL_WL, SDL_WL_PACKAGES } from "../sdlwl.ts";

export default {
	id: "neverball",
	title: "Neverball",
	desc: "Tilt the floor, roll the ball to the goal (OpenGL, SDL2), in a window on the page",
	// A ball on a tilted floor (crafted).
	icon: { svg: '<circle cx="11" cy="8" r="4.5"/><path opacity=".7" d="M2.5 17.5 19.5 12.5 21.5 15 4.5 20Z"/>' },
	colors: ["#38bdf8", "#312e81"],
	needs: { net: true, wayland: true },
	packages: { debian: ["neverball", ...SDL_WL_PACKAGES] },
	commands: [
		"echo 'Guest GL (Options) draws it on the GPU; without it Mesa draws in software, slowly'",
		// 1280x800 the first time (its settings file, which it then keeps).
		"[ -e ~/.neverball/neverballrc ] || { mkdir -p ~/.neverball && printf 'width 1280\\nheight 800\\n' >~/.neverball/neverballrc; }",
		`${SDL_WL} /usr/games/neverball`,
	],
} satisfies TerminalApp;
