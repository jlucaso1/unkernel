// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// System (sysapps.ts, components/SystemInfo.tsx): opened on the section it
// last showed, or brought to the front; it works whatever the system's state.
// Its name, chrome icon and key are its window's (sysapps.ts SYSTEM).
import { apps$, appWinId, openSection, SYSTEM } from "../../sysapps.ts";
import type { PageApp } from "../types.ts";

export default {
	kind: "page",
	...SYSTEM,
	desc: "The state, the boot, the environment, the kernel log and errors",
	win: appWinId("system"),
	// A pulse line in a rounded frame.
	icon: { svg: '<path fill-rule="evenodd" d="M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm0 2v6.2h3.1l1.9-4.6a1 1 0 0 1 1.86.02l2.97 7.92 1.24-2.72a1 1 0 0 1 .91-.62H19V5H5Zm14 8.2h-2.38l-1.95 4.3a1 1 0 0 1-1.85-.06l-2.88-7.7-1.21 2.94a1 1 0 0 1-.93.62H5V19h14v-5.8Z"/>' },
	colors: ["#52525b", "#18181b"],
	open: () => openSection(apps$.get().system),
} satisfies PageApp;
