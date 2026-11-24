// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// wland's container (#wl-desktop, wayland.ts) in the workspace
// (Workspace.tsx: inside #workspace, so its size is the workspace's): the
// output the Wayland apps get (what maximize and fullscreen fill). The
// apps' windows are not in it: each is a window of the window manager
// (wayland.ts). It holds what wland keeps outside them: its hidden
// editable sink (the apps' keyboard), drag-and-drop icons and the cursor
// image, so it lies over the windows and takes no pointer. data-shown
// while a Wayland window has the focus (wayland.ts waylandFocused()). React
// renders it once and never touches its children, which are wland's.
import { memo } from "react";
import { setWaylandContainer, useWaylandFocused } from "../wayland.ts";

export const WaylandOutput = memo(function WaylandOutput() {
	const shown = useWaylandFocused();
	return <div id="wl-desktop" ref={setWaylandContainer} data-shown={shown || undefined} className="pointer-events-none absolute inset-0 z-(--z-wl-desktop)" />;
});
