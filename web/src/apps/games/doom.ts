// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Doom: DSDA-Doom (Debian's dsda-doom, the successor of PrBoom+) with
// Freedoom Phase 1 (Debian's freedoom), as a window on the page's Wayland
// desktop (wayland.ts; Debian). SDL2 on Wayland (the session's
// SDL_VIDEODRIVER, kw-wayland.sh) with its OpenGL renderer (-vidmode gl)
// through EGL: fixed-function GL, inside the GL 2.1 compatibility profile
// that guest GL offers (.agents/gl.md); with guest GL off Mesa draws it in
// software (llvmpipe). Started windowed at 640x480 (-geom, not saved in its
// configuration, ~/.dsda-doom). About 310 MiB installed, 79 MiB to
// download, Mesa and LLVM about 188 MiB of that, Freedoom 57 (the image's
// package lists, 2026-11-22). Its sound and music (FluidSynth) play where
// the page has a sound card; it does not need one.
import type { TerminalApp } from "../types.ts";

const README = `Doom in unkernel: DSDA-Doom with Freedoom (Phase 1), in a window on this page,
drawn with OpenGL on the GPU when guest GL is on (Options).

  arrows  move            Ctrl   fire           Space  open doors
  Alt     strafe          Shift  run            Tab    map
  Esc     menu            Enter  select         mouse  turn (click to grab)

Arguments go to dsda-doom; try:
  /usr/games/dsda-doom -iwad freedoom2.wad -vidmode gl -geom 1024x768w
  /usr/games/dsda-doom -iwad freedoom1.wad -warp 1 1 -skill 3
  /usr/games/dsda-doom -vidmode 8      (the software renderer)
Settings and saves are in ~/.dsda-doom.
`;

export default {
	id: "doom",
	title: "Doom",
	desc: "DSDA-Doom with Freedoom (OpenGL, SDL2), in a window on the page",
	// A horned skull (not id Software's logo).
	icon: { svg: '<path fill-rule="evenodd" d="M12 3.5c5 0 8.5 3.4 8.5 7.9 0 2.5-1 4.3-2.8 5.4v1.7H6.3v-1.7c-1.8-1.1-2.8-2.9-2.8-5.4C3.5 6.9 7 3.5 12 3.5ZM5.6 10.4l5 1.4-.4 2.2c-.2 1.1-1.2 1.9-2.4 1.9-1.4 0-2.4-1.1-2.4-2.5Zm12.8 0-5 1.4.4 2.2c.2 1.1 1.2 1.9 2.4 1.9 1.4 0 2.4-1.1 2.4-2.5ZM12 14.8l-1.3 2.3h2.6Z"/><path d="M6.6 19.2h3v3H7.6a1 1 0 0 1-1-1Zm3.9 0h3v3h-3Zm3.9 0h3v2a1 1 0 0 1-1 1h-2ZM5.4 6.6C3.6 5.2 3 3.3 3.4 1.2 4.6 2.9 6 3.8 7.8 4.3Zm13.2 0c1.8-1.4 2.4-3.3 2-5.4-1.2 1.7-2.6 2.6-4.4 3.1Z"/>' },
	colors: ["#dc2626", "#451a03"],
	needs: { net: true, wayland: true },
	packages: { debian: ["dsda-doom", "freedoom", "libegl1", "libegl-mesa0", "libgl1-mesa-dri"] },
	files: { README },
	commands: [
		"cat README",
		"echo 'Guest GL (Options) draws it on the GPU; without it Mesa draws in software, slowly'",
		"/usr/games/dsda-doom -iwad freedoom1.wad -vidmode gl -geom 640x480w",
	],
} satisfies TerminalApp;
