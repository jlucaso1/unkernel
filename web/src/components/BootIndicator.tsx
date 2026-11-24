// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The boot indicator (#tb-boot, the id the browser tests read): in the top
// bar's app slot, right of the mark (TopBar.tsx wraps the focused app's name
// in BootSlot), from the first paint (index.html draws the same markup before
// the page module runs) until user space first prints. A small ring filled
// with the boot's progress and the current step (#tb-boot-msg; ui.ts derives
// both from the boot stages and the kernel download, "Resuming" on a
// resume); the ring's arc breathes once the boot has taken a second
// (style.css), so a fast boot never shows it moving. Then it fades out and
// the slot shows the focused app. A failure before then turns it red with
// the failure's title (#tb-boot-title, data-error; #tb-boot-msg keeps the
// message for screen readers and the tooltip). A press opens System: its
// Errors on a failure (ui.ts opens them by itself too), else its Overview,
// which has the stages.
//
// useBlank(): while the console has nothing to show (before boot.ts writes
// its first line, during a quiet resume), App.tsx sets #app's data-blank,
// which style.css turns into a faint "Starting…" or "Resuming…" in the
// console's window (index.html's copy of that window has it too).
import type { CSSProperties, ReactNode } from "react";
import { useEffect, useState } from "react";
import { reducedMotion } from "../hooks.ts";
import { useStore } from "../store.ts";
import { openSection } from "../sysapps.ts";

/** The fade-out, as in style.css's .tb-boot transition. */
const FADE_MS = 180;

/** The ring: a faint track and an arc filled clockwise from the top to p (0 to 1), in the text's colour. */
function Ring({ p }: { p: number }) {
	return (
		<svg className="tb-boot-ring" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ "--p": p } as CSSProperties}>
			<circle cx="8" cy="8" r="6" strokeWidth="2" className="tb-boot-track" />
			<circle cx="8" cy="8" r="6" strokeWidth="2" pathLength="100" transform="rotate(-90 8 8)" className="tb-boot-arc" />
		</svg>
	);
}

/** The boot indicator until the boot is over (and its fade), then `children` (the focused app's name). */
export function BootSlot({ children }: { children: ReactNode }) {
	const b = useStore((s) => s.boot);
	const fatal = useStore((s) => s.fatal);
	const [gone, setGone] = useState(b.done);
	useEffect(() => {
		if (!b.done) return;
		const t = setTimeout(() => setGone(true), reducedMotion() ? 0 : FADE_MS + 20);
		return () => clearTimeout(t);
	}, [b.done]);
	if (gone) return <>{children}</>;
	const err = !b.done ? fatal : null;
	const label = b.resuming ? "Resuming" : b.label;
	const pct = Math.round(b.progress * 100);
	const step = b.detail ? `${label}, ${b.detail}` : `${label}…`;
	return (
		<div id="tb-boot" role="status" aria-live="polite" className="tb-boot" data-error={err ? "" : undefined} data-hide={b.done || undefined}>
			<button type="button" className="tb-btn tb-boot-btn"
				title={err ? `${err.title}: ${err.msg}\n(System, Errors)` : `${step} (${pct} %)\n(System, Overview)`}
				aria-label={err ? `${err.title}: show the errors` : `${step} ${pct} %: show the boot stages`}
				onMouseDown={(e) => e.preventDefault()} onClick={() => openSection(err ? "errors" : "status")}>
				<Ring p={err ? 1 : b.progress} />
				{err && <span id="tb-boot-title" className="tb-boot-title">{err.title}</span>}
				<span id="tb-boot-msg" className={err ? "sr-only" : "tb-boot-msg"}>
					{err ? err.msg : b.detail ? <>{label}<span aria-hidden="true" className="tb-boot-detail"> · {b.detail}</span></> : `${label}…`}
				</span>
			</button>
		</div>
	);
}

/** The console's placeholder (#app's data-blank): "start" or "resume" while it has nothing to show; not on a failure. */
export function useBlank(): "start" | "resume" | undefined {
	return useStore((s) => (s.boot.blank && s.state !== "error" ? (s.boot.resuming ? "resume" : "start") : undefined));
}
