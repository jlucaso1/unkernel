// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The Browser window (preview.ts, components/Preview.tsx): a web server in
// the guest, shown in a window. Hidden from the launcher: it opens when an
// app with ports or the guest's `open` asks for it. Its name, chrome icon and
// key are its window's (preview.ts BROWSER).
import { BROWSER, PREVIEW_WIN, openPreview } from "../../preview.ts";
import type { PageApp } from "../types.ts";

export default {
	kind: "page",
	...BROWSER,
	hidden: true,
	desc: "A web server in the guest, in a window",
	win: PREVIEW_WIN,
	// A globe: a circle, the equator and a meridian.
	icon: { svg: '<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z"/></g>' },
	colors: ["#0ea5e9", "#0c4a6e"],
	open: () => { openPreview(); },
} satisfies PageApp;
