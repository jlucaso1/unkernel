// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Chromium B.S.U.: the top-down arcade space shooter, as a window on the
// page's Wayland desktop (wayland.ts; Debian). SDL2 on Wayland (the
// session's SDL_VIDEODRIVER, kw-wayland.sh) with fixed-function OpenGL
// through EGL, inside the GL 2.1 compatibility profile that guest GL offers
// (.agents/gl.md). Started windowed (--window) at
// 1024x768 (--vidmode 3; the game is 4:3). About 228 MiB installed,
// 55 MiB to download, Mesa and LLVM about 188 MiB of that (the image's
// package lists, 2026-11-22). Its sound (OpenAL) plays where the page has a
// sound card.
// The SDL prefix and packages: sdlwl.ts (the page's window frame; libdecor
// preferred from the start for a compositor that answers client-side).
import type { TerminalApp } from "../types.ts";
import { SDL_WL, SDL_WL_PACKAGES } from "../sdlwl.ts";

export default {
	id: "chromium-bsu",
	title: "Chromium B.S.U.",
	desc: "The top-down arcade space shooter (OpenGL, SDL2), in a window on the page",
	// A fighter ship (crafted).
	icon: { svg: '<path d="M12 2l2.5 8 6.5 5.5V18l-6.5-2.2L13.5 20h-3l-1-4.2L3 18v-2.5L9.5 10Z"/><path opacity=".6" d="M5.5 9h1.5v4H5.5Zm11.5 0h1.5v4H17Z"/>' },
	colors: ["#0ea5e9", "#1e1b4b"],
	needs: { net: true, wayland: true },
	packages: { debian: ["chromium-bsu", ...SDL_WL_PACKAGES] },
	commands: [
		"echo 'The mouse flies the ship, its button fires, Esc is the menu'",
		`${SDL_WL} /usr/games/chromium-bsu --window --vidmode 3`,
	],
} satisfies TerminalApp;
