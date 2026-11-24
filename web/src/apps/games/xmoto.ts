// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// X-Moto: 2D motocross with real physics, as a window on the page's Wayland
// desktop (wayland.ts; Debian). SDL2 on Wayland (the session's
// SDL_VIDEODRIVER, kw-wayland.sh) with OpenGL through EGL, inside the GL 2.1
// compatibility profile that guest GL offers (.agents/gl.md). Started
// windowed at 1280x800 (--windowed, -res; it saves them in its settings).
// About 305 MiB installed, 90 MiB to download, Mesa and LLVM about 188 MiB
// of that (the image's package lists, 2026-11-22). Its sound plays where
// the page has a sound card.
// The SDL prefix and packages: sdlwl.ts (the page's window frame; libdecor
// preferred from the start for a compositor that answers client-side).
import type { TerminalApp } from "../types.ts";
import { SDL_WL, SDL_WL_PACKAGES } from "../sdlwl.ts";

export default {
	id: "xmoto",
	title: "X-Moto",
	desc: "Motocross with real physics (OpenGL, SDL2), in a window on the page",
	// A motorbike (crafted).
	icon: { svg: '<g fill="none" stroke="currentColor" stroke-width="2"><circle cx="5.5" cy="16.5" r="3.5"/><circle cx="18.5" cy="16.5" r="3.5"/></g><path d="M5 16l5-6h5l3.5 6.5-1.6.8-3.1-5.3H11l-4.4 5.2Z"/><path d="M13 6.5h3l1 3h-2Z"/>' },
	colors: ["#eab308", "#7c2d12"],
	needs: { net: true, wayland: true },
	packages: { debian: ["xmoto", ...SDL_WL_PACKAGES] },
	commands: [
		"echo 'Up accelerates, Down brakes, Left and Right lean, Space turns around, Esc is the menu'",
		`${SDL_WL} /usr/games/xmoto --windowed -res 1280x800`,
	],
} satisfies TerminalApp;
