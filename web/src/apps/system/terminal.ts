// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Terminal: a new terminal tab (its own shell) in the Terminal window that
// last had the focus, as the Dock's + does (terminals.ts newTerminal()). Its
// name and chrome icon are the Terminal windows' (termtabs.ts TERMINAL).
import { ui$ } from "../../store.ts";
import { newTerminal } from "../../terminals.ts";
import { MAX_TERMINALS, TERMINAL, termTabs$ } from "../../termtabs.ts";
import type { PageApp } from "../types.ts";

/** Once the kernel has stopped (halted, failed), there is no guest to open it on. */
const stopped = () => (["halted", "error"].includes(ui$().get().state) ? "the system is not running" : null);

export default {
	kind: "page",
	...TERMINAL,
	desc: "A new terminal tab with its own shell",
	// A prompt, as the Dock's terminal tiles show it.
	icon: { svg: '<path d="m5.5 7 5 5-5 5M12.5 17.5H19" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>' },
	colors: ["#3f3f46", "#000000"],
	open: () => newTerminal(),
	unavailable: () => stopped() ?? (termTabs$.get().terms.length >= MAX_TERMINALS ? `${MAX_TERMINALS} terminals are open, the most there can be` : null),
} satisfies PageApp;
