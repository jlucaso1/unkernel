// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// SuperTuxKart: kart racing against the computer, as a window on the page's
// Wayland desktop (wayland.ts; Debian). SDL2 on Wayland (the session's
// SDL_VIDEODRIVER, kw-wayland.sh) with OpenGL ES through EGL: on aarch64
// STK 1.4 builds its GLES renderer (USE_GLES2, on by default there; Debian
// keeps it), which asks for GLES 3.0, the GLES that guest GL offers
// (.agents/gl.md), and gets its shader renderer; with guest GL off Mesa draws
// it in software (llvmpipe), far too slowly to play. It loads GL through
// SDL, which opens libGLESv2.so.2 for a GLES context and makes no window
// without it ("Could not initialize display!"), so libgles2 is listed: the
// game does not depend on it. Started windowed at 1024x768 (--windowed
// --screensize). Online play and add-ons are optional; it asks on its first
// start. The largest of the games: about 680 MiB to download and 1 GiB
// installed, the karts and tracks (supertuxkart-data) 599 and 689 MiB of
// that (estimated from the image's package lists, 2026-11-22). Its sound
// (OpenAL) plays where the page has a sound card.
// Its first configuration is a light one (LIGHT, written only where it has
// none; its Options > Graphics change it): every draw is encoded by Mesa's
// virgl driver on the emulated CPU and every render pass crosses to the
// browser, so it turns off the dynamic lights (the deferred renderer, its
// passes and buffers), light scattering and the detail geometry, and keeps
// textures at 512 px (no HD textures: less to compress on the CPU into
// ~/.cache/supertuxkart on the first start, and to upload). STK reads the
// values it finds and keeps its defaults for the rest (UserConfig::
// loadConfig, config version 8; a group's values are its attributes).
// The SDL prefix and packages: sdlwl.ts (the page's window frame; libdecor
// preferred from the start for a compositor that answers client-side).
import type { TerminalApp } from "../types.ts";
import { SDL_WL, SDL_WL_PACKAGES } from "../sdlwl.ts";

// enable_high_definition_textures is a bit field: 2 = off, set by the user
// (so STK does not turn it back on as its default).
const LIGHT = `<?xml version="1.0"?>
<stkconfig version="8">
    <Video enable_dynamic_lights="false" enable_high_definition_textures="2" max_texture_size="512" />
    <GFX light_scatter="false" geometry_level="1" particles-effecs="1" anisotropic="0" />
</stkconfig>
`;
const CONFIG = "~/.config/supertuxkart/config-0.10/config.xml";

export default {
	id: "supertuxkart",
	title: "SuperTuxKart",
	desc: "Kart racing against the computer (OpenGL ES, SDL2), in a window on the page; a 680 MiB download",
	// A kart, its driver's head above the seat (crafted).
	icon: { svg: '<path opacity=".7" d="M2 15l1.5-3H9l1-2.5h4l1 2.5h5.5L22 15Z"/><circle opacity=".6" cx="12" cy="6" r="2.5"/><circle cx="6.5" cy="17.5" r="3"/><circle cx="17.5" cy="17.5" r="3"/>' },
	colors: ["#f59e0b", "#1e40af"],
	needs: { net: true, wayland: true },
	packages: { debian: ["supertuxkart", "libgles2", ...SDL_WL_PACKAGES] },
	files: {
		README: "SuperTuxKart: Story Mode or Single Player races against the computer.\n" +
			"The arrows drive, Space fires an item, N is nitro, V drifts, B looks back,\n" +
			"Backspace rescues the kart, Esc is the menu. Guest GL (Options) draws it on\n" +
			"the GPU (OpenGL ES 3.0). It starts with light graphics settings (light.xml);\n" +
			"Options > Graphics raises them. The first start is the slowest: it compiles\n" +
			"shaders and caches textures in ~/.cache/supertuxkart. Settings are in\n" +
			"~/.config/supertuxkart.\n",
		"light.xml": LIGHT,
	},
	commands: [
		"cat README",
		`[ -e ${CONFIG} ] || install -D -m 644 light.xml ${CONFIG}`,
		"echo 'Guest GL (Options) draws it on the GPU; without it Mesa draws in software, slowly'",
		`${SDL_WL} /usr/games/supertuxkart --windowed --screensize=1024x768`,
	],
} satisfies TerminalApp;
