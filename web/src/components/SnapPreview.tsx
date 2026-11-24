// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Where a moved window would snap (wm.ts snapPreview$: the zone under the
// pointer during a move): a translucent rounded rectangle over the target, a
// tile or the whole workspace. Workspace.tsx draws it first in #workspace at the
// moved window's z-index, so it is under that window and over the others.
// Always there (no pointer events); it fades and scales in and out (style.css
// .wm-snap: transforms and opacity, none with reduced motion), and keeps its
// last place while it fades out.
import { useRef, useSyncExternalStore } from "react";
import { snapPreview$, useWm } from "../wm.ts";
import { tileRect, type Rect } from "../wmsnap.ts";

export function SnapPreview() {
	const p = useSyncExternalStore(snapPreview$.subscribe, () => snapPreview$.get().preview);
	const area = useWm((s) => s.area);
	const last = useRef<{ r: Rect; z: number } | null>(null);
	if (p) last.current = { r: p.zone === "max" ? { x: 0, y: 0, w: area.w, h: area.h } : tileRect(p.zone, area), z: p.z };
	const at = last.current;
	return (
		<div aria-hidden="true" className="wm-snap" data-on={p ? "" : undefined} data-zone={p?.zone}
			style={at ? { left: at.r.x, top: at.r.y, width: at.r.w, height: at.r.h, zIndex: at.z } : undefined} />
	);
}
