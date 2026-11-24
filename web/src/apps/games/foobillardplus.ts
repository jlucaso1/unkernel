// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// FooBillard++: 3D billiards (8-ball, 9-ball, snooker, carom), as a window
// on the page's Wayland desktop (wayland.ts; Debian). An SDL 1.2 game,
// which Debian runs on SDL2 (sdl12-compat), so it takes the session's
// SDL_VIDEODRIVER (kw-wayland.sh) like an SDL2 one; fixed-function OpenGL
// and GLU through EGL, inside the GL 2.1 compatibility profile that guest
// GL offers (.agents/gl.md). Started windowed at 1280x800. About 284 MiB
// installed, 84 MiB to download, Mesa and LLVM about 188 MiB of that (the
// image's package lists, 2026-11-22). Its sound plays where the page has a
// sound card.
// The SDL prefix and packages: sdlwl.ts (the page's window frame; libdecor
// preferred from the start for a compositor that answers client-side).
import type { TerminalApp } from "../types.ts";
import { SDL_WL, SDL_WL_PACKAGES } from "../sdlwl.ts";

export default {
	id: "foobillardplus",
	title: "FooBillard++",
	desc: "3D billiards: 8-ball, 9-ball, snooker, carom (OpenGL), in a window on the page",
	// The 8-ball (crafted).
	icon: { svg: '<path fill-rule="evenodd" d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z"/><path fill-rule="evenodd" d="M12 8.1a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8Zm0 .8a.6.6 0 1 1 0 1.2.6.6 0 0 1 0-1.2Zm0 2.4a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2Zm0 .8a.8.8 0 1 1 0 1.6.8.8 0 0 1 0-1.6Z"/>' },
	colors: ["#15803d", "#052e16"],
	needs: { net: true, wayland: true },
	packages: { debian: ["foobillardplus", ...SDL_WL_PACKAGES] },
	commands: [`${SDL_WL} /usr/games/foobillardplus --geometry 1280x800`],
} satisfies TerminalApp;
