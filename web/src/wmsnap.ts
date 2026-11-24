// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Window snapping's geometry (wm.ts uses it; pure, no DOM): the tiles, the
// zones a dragged window's pointer snaps it to, and the keyboard's moves
// between tiles.
// - Tiles: the left and right halves of the workspace, and its four
//   quarters (tl, tr, bl, br). They keep SNAP_GAP px from the workspace's
//   edges and between each other (maximized stays edge to edge: "max").
// - Zones, by the pointer's place in workspace px (zoneAt): within
//   SNAP_EDGE of the left or right edge a half, or a quarter within
//   SNAP_CORNER of the top or bottom there; within SNAP_EDGE of the page's
//   top edge (the top bar's, while it shows: the workspace starts below it)
//   "max", or a top quarter within SNAP_CORNER of a side; within SNAP_EDGE
//   of the bottom edge (the Dock's) a bottom quarter near a side, nothing
//   between. The pointer may be past an edge (over the top bar or the Dock).
// - Keys (nextTile): left and right go to that half (from a quarter, the
//   quarter across; from the other half, back to the window's own
//   geometry); up and down move between a half and its quarters, up from
//   the own geometry maximizes, down from maximized restores.
// - A frameless app may take another size than its tile's (a terminal
//   rounds to its cells): anchorTile puts that size against the tile's
//   outer side and corner.

/** A tile. */
export type Snap = "left" | "right" | "tl" | "tr" | "bl" | "br";
/** Where a drop or a key puts a window: a tile, or maximized. */
export type Zone = Snap | "max";
export interface Rect { x: number; y: number; w: number; h: number }
export interface Size { w: number; h: number }

/** The gap (px) between tiles and between a tile and the workspace's edges. */
export const SNAP_GAP = 8;
/** How near (px) an edge the pointer snaps. */
export const SNAP_EDGE = 10;
/** How far (px) from a corner along an edge the pointer snaps to that corner's quarter. */
export const SNAP_CORNER = 56;

const isLeft = (s: Snap) => s === "left" || s === "tl" || s === "bl";
const isBottom = (s: Snap) => s === "bl" || s === "br";

/** Tile s's rect in a workspace of this size. */
export function tileRect(s: Snap, area: Size, gap = SNAP_GAP): Rect {
	const lw = Math.floor((area.w - 3 * gap) / 2), rw = area.w - 3 * gap - lw;
	const th = Math.floor((area.h - 3 * gap) / 2), bh = area.h - 3 * gap - th;
	const x = isLeft(s) ? gap : 2 * gap + lw, w = isLeft(s) ? lw : rw;
	if (s === "left" || s === "right") return { x, y: gap, w, h: area.h - 2 * gap };
	return isBottom(s) ? { x, y: 2 * gap + th, w, h: bh } : { x, y: gap, w, h: th };
}

/** A window of this size in tile s (rect r): against the tile's outer side and corner, inside the workspace where it fits. */
export function anchorTile(s: Snap, r: Rect, size: Size, area: Size): Rect {
	const x = isLeft(s) ? r.x : r.x + r.w - size.w;
	const y = isBottom(s) ? r.y + r.h - size.h : r.y;
	return { x: Math.max(0, Math.min(x, area.w - size.w)), y: Math.max(0, Math.min(y, area.h - size.h)), w: size.w, h: size.h };
}

/**
 * The zone under the pointer (p, workspace px), or null. pageTop: the
 * page's top edge in workspace px (0 or less: the workspace may start
 * below the top bar).
 */
export function zoneAt(p: { x: number; y: number }, area: Size, pageTop: number): Zone | null {
	if (area.w <= 0 || area.h <= 0) return null;
	const left = p.x < SNAP_EDGE, right = p.x >= area.w - SNAP_EDGE;
	if (left || right) {
		if (p.y < SNAP_CORNER) return left ? "tl" : "tr";
		if (p.y >= area.h - SNAP_CORNER) return left ? "bl" : "br";
		return left ? "left" : "right";
	}
	if (p.y < pageTop + SNAP_EDGE) return p.x < SNAP_CORNER ? "tl" : p.x >= area.w - SNAP_CORNER ? "tr" : "max";
	if (p.y >= area.h - SNAP_EDGE) return p.x < SNAP_CORNER ? "bl" : p.x >= area.w - SNAP_CORNER ? "br" : null;
	return null;
}

export type Arrow = "left" | "right" | "up" | "down";

/** Where an arrow key takes a window that is now at `cur` (null: its own geometry); null: back to its own geometry. */
export function nextTile(cur: Zone | null, key: Arrow): Zone | null {
	switch (key) {
		case "left": return cur === "tr" ? "tl" : cur === "br" ? "bl" : cur === "right" ? null : cur === "tl" || cur === "bl" ? cur : "left";
		case "right": return cur === "tl" ? "tr" : cur === "bl" ? "br" : cur === "left" ? null : cur === "tr" || cur === "br" ? cur : "right";
		case "up": return cur === "left" ? "tl" : cur === "right" ? "tr" : cur === "bl" ? "left" : cur === "br" ? "right" : cur === "tl" || cur === "tr" ? cur : "max";
		case "down": return cur === "max" ? null : cur === "left" ? "bl" : cur === "right" ? "br" : cur === "tl" ? "left" : cur === "tr" ? "right" : cur;
	}
}
