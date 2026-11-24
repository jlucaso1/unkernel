// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The system apps' content (sysapps.ts): Settings and System, each rendered
// through a portal into its own element, which is the window's body while
// the window is open and a hidden holder while it is not. So they are
// rendered once for the page's life, keep their state when closed, and
// their ids are always in the document.
import { createPortal } from "react-dom";
import { appElement } from "../sysapps.ts";
import { Settings } from "./Settings.tsx";
import { SystemInfo } from "./SystemInfo.tsx";

export function Apps() {
	return (
		<>
			{createPortal(<Settings />, appElement("settings"))}
			{createPortal(<SystemInfo />, appElement("system"))}
		</>
	);
}
