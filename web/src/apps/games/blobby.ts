// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Blobby Volley 2: beach volleyball between two blobs, against the computer
// or a second player on the same keyboard, as a window on the page's
// Wayland desktop (wayland.ts; Debian). SDL2 on Wayland (the session's
// SDL_VIDEODRIVER, kw-wayland.sh) with its OpenGL renderer (GL 1.x
// immediate mode, well inside the GL 2.1 that guest GL offers: .agents/
// gl.md); with guest GL off Mesa draws it in software (llvmpipe). The
// smallest of the GL games: about 215 MiB installed, 50 MiB to download,
// Mesa and LLVM 188 MiB of that (the image's package lists, 2026-11-22).
// Its sound plays where the page has a sound card; it does not need one.
// The SDL prefix and packages: sdlwl.ts (the page's window frame; libdecor
// preferred from the start for a compositor that answers client-side).
import type { TerminalApp } from "../types.ts";
import { SDL_WL, SDL_WL_PACKAGES } from "../sdlwl.ts";

export default {
	id: "blobby",
	title: "Blobby Volley",
	desc: "Beach volleyball between two blobs (OpenGL, SDL2), in a window on the page",
	// A blob with its eyes, and the ball (crafted).
	icon: { svg: '<path fill-rule="evenodd" d="M6 21c-1.5 0-2-1-2-2.5C4 13 7.5 9 12 9s8 4 8 9.5c0 1.5-.5 2.5-2 2.5Zm2.9-7a1.1 1.1 0 1 0 2.2 0a1.1 1.1 0 1 0-2.2 0Zm4 0a1.1 1.1 0 1 0 2.2 0a1.1 1.1 0 1 0-2.2 0Z"/><circle opacity=".8" cx="17.5" cy="4.5" r="2.5"/>' },
	colors: ["#fbbf24", "#0369a1"],
	needs: { net: true, wayland: true },
	packages: { debian: ["blobby", ...SDL_WL_PACKAGES] },
	commands: [
		"echo 'Guest GL (Options) draws it on the GPU; without it Mesa draws in software, slowly'",
		`${SDL_WL} /usr/games/blobby`,
	],
} satisfies TerminalApp;
