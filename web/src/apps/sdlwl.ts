// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// SDL games as windows on the page's Wayland desktop (Debian; the games in
// apps/games that are not on X): what each puts before its command and in
// its packages.
// - libdecor from the start: the page asks wland for server-side
//   decorations (wayland.ts), so an SDL window gets the page's window frame
//   (libdecor takes the server's decorations where it is offered them).
//   The setting and the plugin matter only against a compositor that
//   answers xdg-decoration with client-side (wland's default: it draws no
//   decorations), where SDL 2.32, which asks for it unless libdecor is
//   preferred, then moves the window to libdecor from inside its wait for
//   the first configure, which it never leaves: the window never maps. With
//   SDL_VIDEO_WAYLAND_PREFER_LIBDECOR=1 it makes its windows through libdecor
//   at once, and there libdecor's cairo plugin draws a title bar (the title,
//   minimize, maximize and close buttons). Either way close asks the game to
//   quit (SDL_QUIT), which a game may ignore (Emilia Pinball does), and
//   maximize does nothing for a fixed-size window (most of them).
//   ALLOW_LIBDECOR=1 overrides a session that turned libdecor off. The
//   plugin is 82 KiB, with cairo and pango.
// - Mesa's EGL: SDL's Wayland driver makes its GL contexts through EGL, which
//   the games' packages do not bring (they depend on GLX's libgl1).
// Measured on wland's headless compositor against a Node-booted guest
// (2026-11-22): the window maps, the frame is drawn, a title-bar drag sends
// xdg_toplevel.move and X-Moto quits at its close button.

/** Before an SDL game's command (or an SDL game's line in its script). */
export const SDL_WL = "SDL_VIDEO_WAYLAND_ALLOW_LIBDECOR=1 SDL_VIDEO_WAYLAND_PREFER_LIBDECOR=1";

/** In an SDL game's Debian packages, after the game's own. */
export const SDL_WL_PACKAGES = ["libegl1", "libegl-mesa0", "libgl1-mesa-dri", "libdecor-0-plugin-1-cairo"];
