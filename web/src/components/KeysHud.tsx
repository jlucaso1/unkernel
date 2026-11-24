// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The shortcuts HUD: while the prefix (Ctrl-A, keys.ts) is armed, a glass
// panel over the page with a drawn keyboard (Keyboard) on which every key
// bound after the prefix is lit, with its key in the corner and its
// command's icon (icons.tsx, where one fits) and word (Command.brief), a
// thin bar in its group's colour (keys.ts CommandGroup), and the other keys
// dim. The keyboard is a layout of physical keys (ROWS, ARROWS: what each
// key types, plain and with Shift) joined with keys.ts prefixBindings() by
// key; a bound key the layout does not have is drawn in an "other" row, so
// none goes missing. The digits 1 to 9 are the terminals (lit bright for
// those open, termtabs.ts), 0 the console, the arrows snap the window.
// On compact screens (wm.ts compact: phones, narrow viewports) a sheet over
// the Dock or the key bar lists the bound keys instead (KeyList).
// - It shows SHOW_MS after the prefix is armed, so a key pressed at once
//   never flashes it, and goes the moment the prefix is disarmed (a key, a
//   click on it, Esc, a press anywhere else: useOutsidePress here, the only
//   way the HUD itself disarms it). It fades and scales in briefly, not with
//   reduced motion.
// - It takes no focus and no keys: keys.ts dispatch keeps them, the terminal
//   keeps the focus (a press on a key cap does not move it). Only the bound
//   keys take the pointer (the compact sheet takes it whole, to scroll); a
//   click on one runs it through keys.ts runKey(), as its key would.
// Above the windows, the Dock, the guest's display and the launcher, under
// the toast, the menus and the dialogs (style.css --z-hud). Settings'
// Keyboard section draws the same Keyboard, without the clicks.
import { useEffect, useLayoutEffect, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { reducedMotion, useOutsidePress } from "../hooks.ts";
import { KW } from "../kw.ts";
import { APPLE, PREFIX, prefixBindings, runKey, type Binding, type CommandGroup, type CommandId } from "../keys.ts";
import { useStore } from "../store.ts";
import { tabLabel, useTermTabs, type Term } from "../termtabs.ts";
import { useWm } from "../wm.ts";
import {
	ActivityIcon, CloseIcon, CopyIcon, DesktopIcon, DiskIcon, DisplayIcon, ErrIcon, GridIcon, KeysIcon, LogIcon, MaxIcon,
	MemIcon, PauseIcon, PlusIcon, PreviewIcon, PromptIcon, RebootIcon, SysIcon, TileIcon, Triangle, UnmaxIcon,
} from "./icons.tsx";
import { withKey } from "./KeyHint.tsx";

/** How long the prefix stays armed before the HUD shows (ms): a key within it never shows it. */
const SHOW_MS = 180;

/** A physical key: what it types (`k`; with Shift, `s`), its width in units (1), its cap's text when not `k` (`label`), held for the prefix (`held`). */
interface PKey { k?: string; s?: string; w?: number; label?: string; held?: boolean }
const chars = (keys: string, shifted?: string): PKey[] => [...keys].map((k, i) => ({ k, s: shifted ? shifted[i] : k.toUpperCase() }));
const mod = (label: string, w: number, held?: boolean): PKey => ({ label, w, held });
/** The main block, a US layout, 15 units a row; the keys' values are KeyboardEvent.key, as COMMANDS names them. */
const ROWS: PKey[][] = [
	[...chars("`1234567890-=", "~!@#$%^&*()_+"), { k: "Backspace", label: "delete", w: 2 }],
	[{ k: "Tab", label: "tab", w: 1.5 }, ...chars("qwertyuiop"), ...chars("[]", "{}"), { k: "\\", s: "|", w: 1.5 }],
	[mod("caps", 1.75), ...chars("asdfghjkl"), ...chars(";'", ":\""), { k: "Enter", label: "return", w: 2.25 }],
	[mod("shift", 2.25), ...chars("zxcvbnm"), ...chars(",./", "<>?"), mod("shift", 2.75)],
	APPLE
		? [mod("control", 1.5, true), mod("option", 1.25), mod("⌘", 1.5, true), { k: " ", label: "", w: 6.5 }, mod("⌘", 1.5), mod("option", 1.25), mod("control", 1.5)]
		: [mod("ctrl", 1.5, true), mod("super", 1.25), mod("alt", 1.5), { k: " ", label: "", w: 6.5 }, mod("alt", 1.5), mod("super", 1.25), mod("ctrl", 1.5)],
];
/** The arrow keys, an inverted T beside the two bottom rows: [key, column, row]. */
const ARROWS: Array<[string, number, number]> = [["↑", 2, 1], ["←", 1, 2], ["↓", 2, 2], ["→", 3, 2]];

/** A command's icon on its key, where the chrome has one for it (else its word alone). */
const ICONS: Partial<Record<CommandId, ReactNode>> = {
	console: <PromptIcon />, "new-tab": <PlusIcon />, "close-tab": <CloseIcon />,
	system: <ActivityIcon />, settings: <SysIcon />, storage: <DiskIcon />, env: <MemIcon />, log: <LogIcon />, errors: <ErrIcon />, keys: <KeysIcon />,
	display: <DisplayIcon />, wayland: <DesktopIcon />, launcher: <GridIcon />, preview: <PreviewIcon />, copy: <CopyIcon />,
	reboot: <RebootIcon />, suspend: <PauseIcon />, about: <Triangle />,
	"snap-left": <TileIcon side="left" />, "snap-right": <TileIcon side="right" />, "snap-up": <MaxIcon />, "snap-down": <UnmaxIcon />,
};
/** The groups in the compact list's order. */
const GROUPS: CommandGroup[] = ["term", "window", "app", "machine"];

/** A press on a key cap keeps the focus where it is (the terminal). */
const keep = (e: MouseEvent) => e.preventDefault();

/** How a binding shows: lit or faint, its icon, its word, its tooltip. */
function look(b: Binding, terms: Term[]): { lit: "on" | "faint"; icon?: ReactNode; word: string; title: string } {
	if (b.cmd) return { lit: b.alias ? "faint" : "on", icon: ICONS[b.cmd.id], word: b.alias ? "" : b.cmd.brief, title: withKey(b.cmd.label, b.key) };
	const open = terms.some((t) => t.n === b.term);
	const name = open ? tabLabel(b.term, terms).title : "";
	return { lit: open ? "on" : "faint", word: name, title: withKey(open ? `Terminal ${b.term}: ${name}` : `Terminal ${b.term} (not open)`, b.key) };
}

/** A clickable part of a cap (a button that runs `b` through runKey()), or, without `onRun`, its plain face. */
function Hit({ b, title, className, onRun, children }: { b: Binding; title: string; className: string; onRun?: (key: string) => void; children: ReactNode }) {
	if (!onRun) return <span className={className} title={title}>{children}</span>;
	return (
		<button type="button" tabIndex={-1} data-hud-hit="" data-group={className === "kc-shift" ? b.group : undefined} className={className}
			title={title} aria-label={title} onMouseDown={keep} onClick={() => onRun(b.key)}>{children}</button>
	);
}

/** A key cap: dim, or lit with what its key does (`main`; else its shifted key's, `shifted`, which is a chip in the corner when both are bound). */
function Cap({ pk, main, shifted, terms, onRun, style }: {
	pk: PKey; main?: Binding; shifted?: Binding; terms: Term[]; onRun?: (key: string) => void; style?: CSSProperties;
}) {
	const css = { "--w": pk.w ?? 1, ...style } as CSSProperties;
	const b = main ?? shifted;
	const legend = pk.label ?? (b === shifted && shifted ? pk.s : pk.k) ?? "";
	if (!b) return <div className="kc" data-held={pk.held || undefined} style={css}><span className="kc-leg">{legend}</span></div>;
	const v = look(b, terms), chip = main && shifted ? shifted : undefined;
	return (
		<div className="kc" data-lit={v.lit} data-group={b.group} data-icon={v.icon ? "" : undefined} style={css}>
			<Hit b={b} title={v.title} className="kc-hit" onRun={onRun}>
				<span className="kc-leg">{legend}</span>
				{v.icon}
				{v.word && <span className="kc-word">{v.word}</span>}
			</Hit>
			{chip && <Hit b={chip} title={look(chip, terms).title} className="kc-shift" onRun={onRun}>{chip.key}</Hit>}
		</div>
	);
}

/**
 * The drawn keyboard: the main block and the arrows, each key joined with
 * what it does after the prefix (keys.ts prefixBindings(), by its plain
 * and its shifted value), then an "other" row with the bound keys it does
 * not have. Sized by its container's width (style.css .kbd). `onRun`: a
 * click on a lit key runs it (the HUD); without it the keys are only drawn
 * (Settings).
 */
export function Keyboard({ onRun }: { onRun?: (key: string) => void }) {
	const terms = useTermTabs((s) => s.terms);
	const binds = prefixBindings();
	const byKey = new Map(binds.map((b) => [b.key, b]));
	const drawn = new Set<string>();
	const take = (k?: string): Binding | undefined => {
		const b = k === undefined ? undefined : byKey.get(k);
		if (b) drawn.add(b.key);
		return b;
	};
	const cap = (pk: PKey, key: string | number, style?: CSSProperties) =>
		<Cap key={key} pk={pk} main={take(pk.k)} shifted={take(pk.s)} terms={terms} onRun={onRun} style={style} />;
	const rows = ROWS.map((row, r) => <div key={r} className="kbd-row">{row.map((pk, i) => cap(pk, i))}</div>);
	const arrows = ARROWS.map(([k, col, row]) => cap({ k }, k, { gridColumn: col, gridRow: row }));
	const other = binds.filter((b) => !drawn.has(b.key));
	return (
		<div className="kbd">
			<div className="kbd-board">
				<div className="kbd-rows">{rows}</div>
				<div className="kbd-arrows">{arrows}</div>
			</div>
			{other.length > 0 && (
				<div className="kbd-other">
					<span className="kbd-other-label">other</span>
					{other.map((b) => <Cap key={b.key} pk={{ k: b.key }} main={b} terms={terms} onRun={onRun} />)}
				</div>
			)}
		</div>
	);
}

/** The compact list: each bound key (a command's first key; the open terminals) as a cap and a word, by group. */
function KeyList({ onRun }: { onRun: (key: string) => void }) {
	const terms = useTermTabs((s) => s.terms);
	const items = prefixBindings()
		.filter((b) => (b.cmd ? !b.alias : terms.some((t) => t.n === b.term)))
		.sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group));
	return (
		<div className="hud-list">
			{items.map((b) => {
				const v = look(b, terms);
				return (
					<button key={b.key} type="button" tabIndex={-1} data-hud-hit="" data-group={b.group} className="hud-item"
						title={v.title} aria-label={v.title} onMouseDown={keep} onClick={() => onRun(b.key)}>
						<kbd>{b.key}</kbd>
						{v.icon}
						<span className="min-w-0 truncate">{v.word || `terminal ${b.term}`}</span>
					</button>
				);
			})}
		</div>
	);
}

/** The HUD's header: the prefix as key caps, "then…", and Esc (a click on it disarms, as Esc does). */
function Header() {
	return (
		<div className="mb-2.5 flex items-center justify-between gap-3 px-0.5 text-[12px] text-muted">
			<span className="flex items-center gap-1">
				{PREFIX.split("-").map((k) => <kbd key={k} className="hud-k">{k}</kbd>)}
				<span className="ml-1">then…</span>
			</span>
			<button type="button" tabIndex={-1} data-hud-hit="" className="pointer-events-auto flex items-center gap-1.5 text-faint hover:text-muted"
				onMouseDown={keep} onClick={() => runKey("Escape")}>
				<kbd className="hud-k">esc</kbd>cancel
			</button>
		</div>
	);
}

/**
 * Where the compact sheet's bottom edge goes (px from the viewport's
 * bottom): over the key bar or the Dock, whichever is shown and higher,
 * else over the bottom safe area; read again on a resize (the on-screen
 * keyboard).
 */
function useSheetBottom(on: boolean): number | undefined {
	const [bottom, setBottom] = useState<number>();
	useLayoutEffect(() => {
		if (!on) return;
		const read = () => {
			const h = document.documentElement.clientHeight;
			const tops = ["keys", "dock"].map((id) => document.getElementById(id)?.getBoundingClientRect())
				.filter((r): r is DOMRect => !!r && r.height > 0).map((r) => r.top);
			setBottom(tops.length ? Math.max(8, h - Math.min(...tops) + 8) : undefined);
		};
		read();
		visualViewport?.addEventListener("resize", read);
		addEventListener("resize", read);
		return () => { visualViewport?.removeEventListener("resize", read); removeEventListener("resize", read); };
	}, [on]);
	return bottom;
}

export function KeysHud() {
	const armed = useStore((s) => s.prefix);
	const compact = useWm((s) => s.compact);
	const [shown, setShown] = useState(false);
	useEffect(() => {
		if (!armed) { setShown(false); return; }
		const t = setTimeout(() => setShown(true), SHOW_MS);
		return () => clearTimeout(t);
	}, [armed]);
	// A press anywhere but on the HUD's keys (or the key bar's prefix key, which disarms it itself) disarms the prefix.
	useOutsidePress((t) => !!(t as Element | null)?.closest?.('[data-hud-hit], #keys [data-key="prefix"]'), () => KW.ui!.setPrefix(false), armed);
	const visible = armed && shown;
	const bottom = useSheetBottom(visible && compact);
	if (!visible) return null;
	const motion = reducedMotion() ? "" : "transition-[opacity,scale] duration-100 ease-out starting:scale-[.97] starting:opacity-0";
	const label = `${PREFIX}, then a key`;
	if (compact) {
		return (
			<div id="keys-hud" role="group" aria-label={label} data-hud-hit=""
				className={`hud-panel hud-sheet fixed left-1/2 z-(--z-hud) -translate-x-1/2 select-none ${motion}`}
				style={{ bottom: bottom ?? "calc(var(--sb) + 8px)" }}>
				<Header />
				<KeyList onRun={runKey} />
			</div>
		);
	}
	return (
		<div className="pointer-events-none fixed inset-0 z-(--z-hud) flex items-center justify-center px-4 pt-[calc(var(--st)+var(--tb-h)+8px)] pb-[calc(var(--sb)+var(--dock-h))]">
			<div id="keys-hud" role="group" aria-label={label} className={`hud-panel hud-full select-none ${motion}`}>
				<Header />
				<Keyboard onRun={runKey} />
			</div>
		</div>
	);
}
