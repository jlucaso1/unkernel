// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The page's small preferences in localStorage, each under `kw.<name>` (the
// font size, the Display's touch options, the preview's port, the Dock's
// pins...). A module that only keeps a preference imports this, not ui.ts.
// Storage may be refused (a private window, blocked site data): reads then
// give null and writes do nothing.

/** Read preference k (null: unset or no storage), or with v, write it (returns null). */
export function store(k: string, v?: string): string | null {
	try {
		if (v === undefined) return localStorage.getItem(`kw.${k}`);
		localStorage.setItem(`kw.${k}`, v);
	} catch {}
	return null;
}
