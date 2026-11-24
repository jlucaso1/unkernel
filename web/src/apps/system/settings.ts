// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Settings (sysapps.ts, components/Settings.tsx): opened on the section it
// last showed, or brought to the front; it works whatever the system's state.
// Its name, chrome icon and key are its window's (sysapps.ts SETTINGS).
import { appWinId, openSettings, SETTINGS } from "../../sysapps.ts";
import type { PageApp } from "../types.ts";

export default {
	kind: "page",
	...SETTINGS,
	desc: "Machine, distro, storage, network, display and sound, session, keyboard",
	win: appWinId("settings"),
	// A gear, generated: eight teeth on r 8.6 to 11.2, a 3.6 hole.
	icon: { svg: '<path fill-rule="evenodd" d="M9.93 3.65 10.16.95h3.68l.23 2.7a8.6 8.6 0 0 1 2.37.98l2.07-1.74 2.6 2.6-1.74 2.07a8.6 8.6 0 0 1 .98 2.37l2.7.23v3.68l-2.7.23a8.6 8.6 0 0 1-.98 2.37l1.74 2.07-2.6 2.6-2.07-1.74a8.6 8.6 0 0 1-2.37.98l-.23 2.7h-3.68l-.23-2.7a8.6 8.6 0 0 1-2.37-.98l-2.07 1.74-2.6-2.6 1.74-2.07a8.6 8.6 0 0 1-.98-2.37l-2.7-.23v-3.68l2.7-.23a8.6 8.6 0 0 1 .98-2.37L2.89 5.49l2.6-2.6 2.07 1.74a8.6 8.6 0 0 1 2.37-.98ZM12 8.4a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2Z"/>' },
	colors: ["#52525b", "#18181b"],
	open: openSettings,
} satisfies PageApp;
