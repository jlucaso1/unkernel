// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The page's formatters: sizes, rates, durations, counts and names, as the
// diagnostics, the terminal's boot lines and the system UI print them. The
// variants differ on purpose (tests read the diagnostics and the terminal),
// so each keeps its own output.

const KiB = 1024, MiB = KiB * 1024, GiB = MiB * 1024;

// ---- sizes and rates -------------------------------------------------------------

/** Bytes as MiB with one decimal: 0.5 MiB, 23.6 MiB, 1024.0 MiB. */
export const fmtMiB = (n: number): string => `${(n / MiB).toFixed(1)} MiB`;

/** Bytes, for the diagnostics: 37 KiB, 1.5 MiB, 2.0 GiB (one decimal from MiB up). */
export const fmtSize = (n: number): string =>
	n >= GiB ? `${(n / GiB).toFixed(1)} GiB` : n >= MiB ? `${(n / MiB).toFixed(1)} MiB` : `${Math.round(n / KiB)} KiB`;

/** Bytes, short: 0 B, 512 B, 37 KiB, 1.5 MiB, 2.0 GiB (no decimal from 100 MiB or GiB up). */
export function fmtBytes(n: number): string {
	if (n >= GiB) return `${(n / GiB).toFixed(n >= 100 * GiB ? 0 : 1)} GiB`;
	if (n >= MiB) return `${(n / MiB).toFixed(n >= 100 * MiB ? 0 : 1)} MiB`;
	if (n >= KiB) return `${Math.round(n / KiB)} KiB`;
	return `${Math.round(n)} B`;
}

/** Bytes per second, as fmtBytes() writes bytes: 37 KiB/s. */
export const fmtRate = (n: number): string => `${fmtBytes(n)}/s`;

/** Bytes, shortest (the top bar): 512K, 37M, 1.5G. */
export const fmtSizeShort = (n: number): string =>
	n >= GiB ? `${+(n / GiB).toFixed(1)}G` : n >= MiB ? `${Math.round(n / MiB)}M` : `${Math.round(n / KiB)}K`;

/** Bytes per second, short (the top bar): 12 B/s, 37 KB/s, 1.5 MB/s. */
export const fmtRateShort = (n: number): string =>
	n >= MiB ? `${(n / MiB).toFixed(1)} MB/s` : n >= KiB ? `${Math.round(n / KiB)} KB/s` : `${Math.round(n)} B/s`;

// ---- durations -------------------------------------------------------------------

/** A duration in ms: 850 ms, 3.25 s, 12.5 s (one decimal from 10 s up); "" for none. */
export const fmtT = (ms: number | null | undefined): string =>
	ms == null ? "" : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;

/** A duration in ms, always two decimals in seconds (the boot's lines): 850 ms, 12.50 s. */
export const fmtS = (ms: number): string => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`);

/** An uptime in seconds: 45 s, 12 m 04 s, 2 h 05 m, 3 d 4 h. */
export function fmtUptime(s: number): string {
	s = Math.floor(s);
	const d = Math.floor(s / 86400), h = Math.floor(s / 3600) % 24, m = Math.floor(s / 60) % 60, sec = s % 60;
	const two = (n: number) => String(n).padStart(2, "0");
	return d ? `${d} d ${h} h` : h ? `${h} h ${two(m)} m` : m ? `${m} m ${two(sec)} s` : `${sec} s`;
}

/** How long ago a sample was, from its age in ms: now, 12 s ago. */
export const agoSeconds = (ms: number): string => (ms < 1500 ? "now" : `${Math.round(ms / 1000)} s ago`);

/** How long ago a time (Date.now() ms) was, coarsely: just now, 5 min ago, 3 h ago, 4 days ago. */
export const agoSince = (t: number): string => {
	const m = Math.round((Date.now() - t) / 60000);
	return m < 1 ? "just now" : m < 120 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};

// ---- shares and counts (the Overview, the top bar's Resources) -------------------

/** A share 0 to 1 as a percentage: <1%, 37%. */
export const fmtPct = (f: number): string => (f > 0 && f < 0.005 ? "<1%" : `${Math.round(f * 100)}%`);

/** A count, short from 10 000 up: 950, 9,999, 12.3k, 123k. */
export const fmtCount = (n: number): string => (n >= 10000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : Math.round(n).toLocaleString("en-US"));

/** Frames per second: 0.5 fps, 9.8 fps, 60 fps. */
export const fmtFps = (n: number): string => `${n < 10 ? n.toFixed(1) : Math.round(n)} fps`;

// ---- words -----------------------------------------------------------------------

/** A count and its noun: 1 CPU, 2 CPUs, 0 CPUs. */
export const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;

/** The first letter in upper case: a distro's name (debian: Debian), a sentence. */
export const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
