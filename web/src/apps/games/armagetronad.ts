// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Armagetron Advanced: 3D light cycles against computer players, as a
// window on the page's Wayland desktop (wayland.ts; Debian). An SDL 1.2
// game, which Debian runs on SDL2 (sdl12-compat), so it takes the session's
// SDL_VIDEODRIVER (kw-wayland.sh) like an SDL2 one; fixed-function OpenGL
// and GLU, inside the GL 2.1 compatibility profile that guest GL offers
// (.agents/gl.md); with guest GL off Mesa draws it in software (llvmpipe).
// Started windowed with -w: 0.2.9.1's long options (--window, --windowed,
// --fullscreen) are refused as unknown, though -h lists them. About 220 MiB
// installed, 51 MiB to download, Mesa and LLVM 188 MiB of that (the image's
// package lists, 2026-11-22). Its sound plays where the page has a sound
// card; it does not need one. The SDL prefix and packages: sdlwl.ts (the
// page's window frame; libdecor preferred from the start for a compositor
// that answers client-side).
import type { TerminalApp } from "../types.ts";
import { SDL_WL, SDL_WL_PACKAGES } from "../sdlwl.ts";

export default {
	id: "armagetronad",
	title: "Armagetron",
	desc: "Light cycles in 3D against the computer (OpenGL), in a window on the page",
	// Two light cycles turning, their walls behind them (crafted).
	icon: { svg: '<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 20h7V8h9"/><path opacity=".6" d="M21 20h-6v-6H6V4"/></g><circle cx="20" cy="8" r="2"/><circle opacity=".6" cx="6" cy="3.5" r="2"/>' },
	colors: ["#f97316", "#0f172a"],
	needs: { net: true, wayland: true },
	packages: { debian: ["armagetronad", ...SDL_WL_PACKAGES] },
	waylandIds: ["armagetronad.real"],
	// Its window 1280x800 (ARMAGETRON_WINDOWSIZE 8), read at every start after
	// its own settings (the var directory's autoexec.cfg).
	files: { "~/.armagetronad/var/autoexec.cfg": "ARMAGETRON_WINDOWSIZE 8\n" },
	commands: [
		"echo 'Guest GL (Options) draws it on the GPU; without it Mesa draws in software, slowly'",
		`${SDL_WL} /usr/games/armagetronad -w`,
	],
} satisfies TerminalApp;
