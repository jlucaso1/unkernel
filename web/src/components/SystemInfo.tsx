// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The System app (sysapps.ts; a desktop window, AppShell.tsx): information
// only. Sections:
// - Overview: the machine at a glance, a resource monitor (its state, live
//   CPU, memory, disk, network, GPU (with guest GL), emulator and process
//   panels, the boot timeline, the machine's facts; components/Overview.tsx),
//   sampled by stats.ts at its full rate only while it shows;
// - Environment: the checks (the browser, memory, storage, JIT...);
// - Kernel log: appended to as lines arrive, never re-rendered (ui.logView),
//   at its end while it is there; only while the window is shown and the
//   section selected (a minimized or closed window renders nothing of it);
// - Errors: the fatal one first with its title (#fatal, #fatal-title,
//   #fatal-msg, #fatal-hint), the others oldest first.
// Footer: Copy diagnostics (#copy), and its fallback where the clipboard
// refuses: the text, selected, in #copy-area.
// Its element is #system (sysapps.ts), with class `open` while the window shows.
import { useEffect, useRef, type RefObject } from "react";
import { useAppVisible } from "../sysapps.ts";
import { KW } from "../kw.ts";
import { useStore, type Check } from "../store.ts";
import { fmtT } from "../format.ts";
import { AppShell, useSection, type SectionDef } from "./AppShell.tsx";
import { ActivityIcon, ErrIcon, LogIcon, MemIcon } from "./icons.tsx";
import { Overview } from "./Overview.tsx";

export function SystemInfo() {
	const ui = KW.ui!;
	const errors = useStore((s) => s.errors.length);
	const visible = useAppVisible("system");
	const section = useSection("system");
	const sections: SectionDef[] = [
		{ id: "status", name: "Overview", icon: <ActivityIcon size={14} /> },
		{ id: "env", name: "Environment", icon: <MemIcon size={14} />, desc: "What this browser offers the kernel." },
		{ id: "log", name: "Kernel log", icon: <LogIcon size={14} /> },
		{ id: "errors", name: "Errors", icon: <ErrIcon size={14} />, badge: errors ? { text: String(errors), id: "err-count", tone: "err" } : undefined },
	];
	const shown = (id: string) => visible && section === id;
	return (
		<AppShell app="system" label="System" sections={sections}
			render={(id, body) => id === "status" ? (shown("status") && <Overview />)
				: id === "env" ? (shown("env") && <Checks />)
				: id === "log" ? (shown("log") ? <LogPane body={body} /> : <pre id="log" />)
				: visible && <Errors />}
			footer={<>
				<CopyArea />
				<p className="mr-auto min-w-0 truncate text-[12px] text-faint max-sm:hidden">The stages, the environment, the errors and the last 300 log lines, as text.</p>
				<button id="copy" type="button" className="btn btn-sm max-sm:flex-1" onClick={() => ui.copyDiagnostics()}>Copy diagnostics</button>
			</>}
		/>
	);
}

/** systemd-style markers. */
const MARK: Record<Check["r"] | "active" | "pending" | "skip", [string, string]> = {
	pass: ["  OK  ", "text-ok"], fail: ["FAILED", "text-err"], warn: [" WARN ", "text-warn"], info: [" INFO ", "text-faint"],
	active: [" .... ", "text-fg"], pending: ["      ", ""], skip: [" SKIP ", "text-faint"],
};
const Marker = ({ r }: { r: keyof typeof MARK }) => (
	<>
		<span className="whitespace-pre text-faint" title={r} aria-hidden="true">[<span className={MARK[r][1]}>{MARK[r][0]}</span>]</span>
		<span className="sr-only">{MARK[r][0].trim() || r}:</span>
	</>
);

function Checks() {
	const checks = useStore((s) => s.checks);
	return (
		<ul id="checks" className="space-y-1.5">
			{checks.map((c) => (
				<li key={c.id} data-r={c.r} className="grid grid-cols-[auto_minmax(88px,32%)_1fr] items-baseline gap-x-3">
					<Marker r={c.r} />
					<span className="text-muted">{c.label}</span>
					<span className="min-w-0 break-words">
						{c.value}
						{c.note && <small className={`block text-[11.5px] text-faint ${c.id === "ua" ? "break-all" : ""}`}>{c.note}</small>}
					</span>
				</li>
			))}
		</ul>
	);
}

/** The kernel log: appended to, not re-rendered, as lines arrive (ui.logView); kept at its end while it is there. */
function LogPane({ body }: { body: RefObject<HTMLDivElement | null> }) {
	const pre = useRef<HTMLPreElement>(null);
	useEffect(() => {
		const el = pre.current!, view = KW.ui!.logView;
		let rendered = 0, empty = false;
		const render = (reset: boolean) => {
			const b = body.current!;
			const stick = b.scrollHeight - b.scrollTop - b.clientHeight < 40;
			if (reset || empty) { el.textContent = ""; rendered = 0; empty = false; }
			if (!view.lines.length) { el.textContent = "Nothing logged yet."; empty = true; return; }
			const frag = document.createDocumentFragment();
			for (let i = rendered; i < view.lines.length; i++) {
				const l = view.lines[i]!;
				if (!l.cls) { frag.append(`${l.line}\n`); continue; }
				const s = document.createElement("span");
				s.className = l.cls === "e" ? "text-err" : "text-fg";
				s.textContent = `${l.line}\n`;
				frag.append(s);
			}
			el.append(frag);
			rendered = view.lines.length;
			if (stick) b.scrollTop = b.scrollHeight;
		};
		render(true);
		body.current!.scrollTop = body.current!.scrollHeight;
		return view.subscribe(render);
	}, [body]);
	return <pre id="log" ref={pre} className="text-[11.5px] leading-normal break-words whitespace-pre-wrap text-muted" />;
}

/** The errors, oldest first; the one that stopped the system (the store's fatal) with its title, and highlighted. */
function Errors() {
	const errors = useStore((s) => s.errors);
	const f = useStore((s) => s.fatal);
	if (!errors.length) return <p id="errors-empty" className="py-10 text-center text-faint">No errors so far.</p>;
	const stop = f ? errors.findIndex((e) => e.fatal) : -1;
	return (
		<ul id="errors" className="space-y-3">
			{errors.map((e, i) => (
				<li key={i} id={i === stop ? "fatal" : undefined} role={i === stop ? "alert" : undefined}
					className={`border-l-2 pl-3 ${i === stop ? "border-err bg-err/10 py-2 pr-3" : e.fatal ? "border-err" : "border-line-strong"}`}>
					<div className="mb-0.5 flex items-center gap-2 text-[11.5px] text-faint">
						<span className={e.fatal ? "text-err" : "text-fg"}>[{e.kind}]</span>
						<span className="tabular-nums">+{fmtT(e.t)}{e.fatal ? " · fatal" : ""}</span>
					</div>
					{i === stop && <b id="fatal-title" className="mb-0.5 block font-semibold text-err">✗ {f!.title}</b>}
					<div id={i === stop ? "fatal-msg" : undefined} className="break-words whitespace-pre-wrap">{e.message}</div>
					{i === stop ? <div id="fatal-hint" hidden={!e.hint} className="mt-1 text-[11.5px] text-muted">{e.hint}</div>
						: e.hint && <div className="mt-1 text-[11.5px] text-faint">{e.hint}</div>}
					{e.detail && (
						<details className="mt-1">
							<summary className="cursor-pointer text-[11.5px] text-faint hover:text-muted">details</summary>
							<pre className="mt-1 max-h-56 overflow-auto text-[11px] leading-[1.4] break-all whitespace-pre-wrap text-muted">{e.detail}</pre>
						</details>
					)}
				</li>
			))}
		</ul>
	);
}

/** Copy diagnostics without the Clipboard API: the text, selected, to copy by hand (over the footer's buttons, the whole width). */
function CopyArea() {
	const text = useStore((s) => s.copyText);
	return (
		<textarea id="copy-area" readOnly hidden={text === null} value={text ?? ""} aria-label="Diagnostics text"
			className="field h-32 w-full basis-full resize-y p-2 text-[11px]" />
	);
}
