// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The Display window's touch controls (Display.tsx renders them on touch
// devices): an overlay (#pad) over the picture: a stick bottom
// left (a knob that follows the thumb; 8-way arrow keys); game controller
// buttons bottom right, in a layout picked with the chip at the top right
// (ABXY with Select and Start, or a grid of keys); face buttons show the
// letter and, tiny, the key they send;
// a chip brings up the phone's keyboard (a hidden input; what it gains
// and loses is typed: key presses while a program reads the keyboard,
// else into the terminal), with the terminal's key bar (Keys.tsx) above
// it, its keys pressed the same way;
// a chip hides the stick and buttons (a demo, or a desktop driven by
// touch; kept in localStorage), leaving the chips;
// at the top right also full screen (iPhone Safari has none: the chip
// says how to add the page to the home screen instead, see display.ts),
// the rotate toggle (portrait pages), "tty" while covering the page (the
// Dock is covered: it hides the window), and the touch mode chip while a
// program has the tablet open (Display.tsx). The Keys layout has every key.
// With no program reading evdev, the buttons type the equivalent terminal
// input instead (arrows, Enter, Esc, Space, Tab, y, n), with key repeat,
// for programs that read the tty.
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
	evdev, localPos, offerFullscreen, setControls, setDisplayShown, setPadLayout, setRotate, setTouchMode, toggleFullscreen, useFullscreen, type DisplayUiOptions,
} from "../display.ts";
import { KW } from "../kw.ts";
import { domCodeToLinux } from "../sdk.ts";
import { ui$, useStore, type PadLayout, type TouchMode } from "../store.ts";
import { FullscreenIcon, GamepadIcon, KeyboardIcon, PointerIcon, RotateIcon, TrackpadIcon } from "./icons.tsx";
import { Keys } from "./Keys.tsx";

/**
 * The soft keyboard: the key, and whether Shift is held, for each character
 * (a US layout, as DOM_CODE_TO_LINUX assumes). Others reach only the terminal.
 */
const CHAR_KEY: ReadonlyMap<string, [number, boolean]> = (() => {
	const m = new Map<string, [number, boolean]>();
	const pair = (code: number, plain: string, shifted: string) => { m.set(plain, [code, false]); m.set(shifted, [code, true]); };
	"1234567890".split("").forEach((d, i) => pair(2 + i, d, "!@#$%^&*()"[i]!));
	for (const c of "abcdefghijklmnopqrstuvwxyz") pair(domCodeToLinux(`Key${c.toUpperCase()}`)!, c, c.toUpperCase());
	for (const [code, a, b] of [[12, "-", "_"], [13, "=", "+"], [26, "[", "{"], [27, "]", "}"], [39, ";", ":"], [40, "'", '"'], [41, "`", "~"], [43, "\\", "|"], [51, ",", "<"], [52, ".", ">"], [53, "/", "?"]] as const) pair(code, a, b);
	m.set(" ", [57, false]).set("\t", [15, false]).set("\n", [28, false]);
	return m;
})();
/** What the soft keyboard's input holds between edits, so a Backspace always has something to delete. */
const SENTINEL = "__";

const KEY = { up: 103, down: 108, left: 105, right: 106, ctrl: 29, space: 57, enter: 28, esc: 1, shift: 42, alt: 56, tab: 15, y: 21, n: 49 };

/** Overlay keys: label, Linux key code, terminal input when evdev is closed. */
interface PadKey {
	label: string;
	code: number;
	tty?: string | (() => string);
}

type KeyId = "esc" | "tab" | "shift" | "ctrl" | "alt" | "space" | "enter" | "y" | "n";

/** A face button: the key it presses, and its label's colour. */
/** A face button: its letter, the letter's colour, and the key it presses (shown small under the letter). */
interface FaceDef { letter: string; color: string; key: KeyId }

/**
 * The right side's layouts, which the chip toggles between. Face buttons
 * carry a controller's letters, with the key they send (there is no gamepad
 * device: programs read the keyboard) in tiny type under it. Keys has every
 * key ABXY leaves out (Shift, Y, N).
 * - gamepad: A B X Y in a diamond (Y top Alt, X left Ctrl, B right Esc,
 *   A bottom Space), with Tab and Enter above, where a controller has
 *   Select and Start;
 * - keys: every key in a 3x3 grid.
 */
const LAYOUTS: Record<PadLayout, { name: string; next: PadLayout; select?: KeyId; start?: KeyId; faces?: FaceDef[]; grid?: KeyId[] }> = {
	gamepad: {
		name: "ABXY", next: "keys", select: "tab", start: "enter",
		faces: [
			{ letter: "Y", color: "text-warn", key: "alt" }, { letter: "X", color: "text-accent", key: "ctrl" },
			{ letter: "B", color: "text-err", key: "esc" }, { letter: "A", color: "text-ok", key: "space" },
		],
	},
	keys: { name: "Keys", next: "gamepad", grid: ["esc", "tab", "y", "ctrl", "alt", "n", "shift", "space", "enter"] },
};

const NO_TOUCH_UI = "touch-none select-none [-webkit-touch-callout:none] [-webkit-tap-highlight-color:transparent]";
const GLASS = "border border-white/35 bg-white/12 backdrop-blur-sm";
const LIT = "data-on:border-white/60 data-on:bg-white/25";
/** A key cap (the Keys layout). */
const CAP = `pointer-events-auto grid h-11 place-items-center rounded-lg p-0 text-[13px] font-medium text-white/85 ${GLASS} ${LIT} ${NO_TOUCH_UI}`;
/** A small chip in the top strip. */
const CHIP = `pointer-events-auto inline-flex h-8 min-w-8 items-center justify-center gap-1 rounded-md px-2 font-mono text-[11px] text-white/80 ${GLASS} aria-pressed:bg-white/20 aria-pressed:text-white ${NO_TOUCH_UI}`;

/** The stick (viewBox 0 0 100 100): how far the knob's centre travels, and the dead zone, as fractions of the base's radius. */
const KNOB_TRAVEL = 30, STICK_DEAD = 0.25;
/** The stick's chevrons, one per direction, near the rim. */
const CHEVRON = { up: "M42 16l8-7 8 7", down: "M42 84l8 7 8-7", left: "M16 42l-7 8 7 8", right: "M84 42l7 8-7 8" } as const;

export function Pad({ opts, rot, covering, portrait, rotate, layout, tablet, touchMode, controls, pads }: {
	opts: DisplayUiOptions; rot: boolean; covering: boolean; portrait: boolean; rotate: boolean; layout: PadLayout; tablet: boolean; touchMode: TouchMode; controls: boolean; pads: CSSProperties;
}) {
	const full = useFullscreen();
	// Each pointer holds the keys it pressed; a release, a cancel or a lost
	// capture releases them, so a key never sticks. `lit` mirrors them for
	// the pressed look (:active is unreliable with pointer capture on iOS).
	const held = useRef(new Map<number, Set<PadKey>>());
	const [lit, setLit] = useState<ReadonlySet<PadKey>>(() => new Set());
	const repeat = useRef(new Map<PadKey, ReturnType<typeof setTimeout>>());
	const stickRef = useRef<HTMLDivElement>(null);
	// The knob's offset from the base's centre (-1..1 at the rim), null at rest.
	const [knob, setKnob] = useState<{ x: number; y: number } | null>(null);

	const press = (k: PadKey) => {
		const ev = evdev();
		if (ev?.keyboardOpen) return void ev.key(k.code, true);
		const tty = typeof k.tty === "function" ? k.tty() : k.tty;
		if (!tty) return;
		opts.sendTty(tty);
		const again = (ms: number) => repeat.current.set(k, setTimeout(() => {
			opts.sendTty(typeof k.tty === "function" ? k.tty() : tty);
			again(80);
		}, ms));
		again(400);
	};
	const release = (k: PadKey) => {
		evdev()?.key(k.code, false);
		clearTimeout(repeat.current.get(k));
		repeat.current.delete(k);
	};
	const setHeld = (id: number, keys: Set<PadKey>) => {
		const old = held.current.get(id) ?? new Set();
		for (const k of old) if (!keys.has(k)) release(k);
		for (const k of keys) if (!old.has(k)) press(k);
		if (keys.size) held.current.set(id, keys);
		else held.current.delete(id);
		setLit(new Set([...held.current.values()].flatMap((s) => [...s])));
	};
	// Pointers that are down on a control, holding keys or not (a stick
	// touched in its dead zone holds none yet, but its moves still count).
	const down = useRef(new Set<number>());
	const track = (keysAt: (e: ReactPointerEvent) => Set<PadKey>) => {
		const end = (e: ReactPointerEvent) => {
			down.current.delete(e.pointerId);
			setHeld(e.pointerId, new Set());
		};
		return {
			onPointerDown: (e: ReactPointerEvent) => {
				e.preventDefault(); // no focus change, so no on-screen keyboard
				e.currentTarget.setPointerCapture(e.pointerId);
				down.current.add(e.pointerId);
				setHeld(e.pointerId, keysAt(e));
			},
			onPointerMove: (e: ReactPointerEvent) => { if (down.current.has(e.pointerId)) setHeld(e.pointerId, keysAt(e)); },
			onPointerUp: end,
			onPointerCancel: end,
			onLostPointerCapture: end,
		};
	};
	const releaseAll = () => {
		down.current.clear();
		for (const id of [...held.current.keys()]) setHeld(id, new Set());
	};
	useEffect(() => releaseAll, []);

	const arrow = (c: string) => () => (opts.appCursor() ? `\x1bO${c}` : `\x1b[${c}`);
	// Stable across renders: held keys are compared by identity.
	const [keys] = useState(() => ({
		dirs: {
			up: { label: "▲", code: KEY.up, tty: arrow("A") }, down: { label: "▼", code: KEY.down, tty: arrow("B") },
			left: { label: "◀", code: KEY.left, tty: arrow("D") }, right: { label: "▶", code: KEY.right, tty: arrow("C") },
		} satisfies Record<string, PadKey>,
		named: {
			esc: { label: "Esc", code: KEY.esc, tty: "\x1b" }, tab: { label: "Tab", code: KEY.tab, tty: "\t" },
			shift: { label: "Shift", code: KEY.shift }, ctrl: { label: "Ctrl", code: KEY.ctrl }, alt: { label: "Alt", code: KEY.alt },
			space: { label: "Space", code: KEY.space, tty: " " }, enter: { label: "Enter", code: KEY.enter, tty: "\r" },
			y: { label: "Y", code: KEY.y, tty: "y" }, n: { label: "N", code: KEY.n, tty: "n" },
		} satisfies Record<KeyId, PadKey>,
	}));
	const { dirs, named } = keys;
	const L = LAYOUTS[layout];

	// The soft keyboard: a hidden input the chip focuses (the phone's keyboard
	// comes up) and blurs. Phone keyboards send no usable keydowns (Android's
	// compose words), so what the input gains or loses is what was typed:
	// Backspaces for what went, the new text after. While a program has the
	// guest keyboard open the characters become key presses, else they go to
	// the terminal.
	const guestKeyboard = useStore((s) => s.display.keyboard);
	const kbdRef = useRef<HTMLInputElement>(null);
	const [kbd, setKbd] = useState(false);
	const composing = useRef(false);
	const was = useRef(SENTINEL);
	const tapKey = (code: number, shift = false, ctrl = false) => {
		const ev = evdev()!;
		if (ctrl) ev.key(KEY.ctrl, true);
		if (shift) ev.key(KEY.shift, true);
		ev.key(code, true);
		ev.key(code, false);
		if (shift) ev.key(KEY.shift, false);
		if (ctrl) ev.key(KEY.ctrl, false);
	};
	/** The key bar's Ctrl is latched: it applies to the next key, then lets go. */
	const takeCtrl = () => {
		const on = ui$().get().ctrl;
		if (on) KW.ui?.setCtrl(false);
		return on;
	};
	const typeText = (text: string, backspaces: number) => {
		if (evdev()?.keyboardOpen) {
			for (let i = 0; i < backspaces; i++) tapKey(14);
			for (const c of text) { const k = CHAR_KEY.get(c); if (k) tapKey(k[0], k[1], takeCtrl()); }
		} else {
			// The terminal's own Ctrl rule, on the first character.
			if (text && ui$().get().ctrl) text = (KW.ui?.applyCtrl(text[0]!) ?? text[0]!) + text.slice(1);
			opts.sendTty("\x7f".repeat(backspaces) + text.replace(/\n/g, "\r"));
		}
	};
	// The key bar over the keyboard (Keys.tsx): the terminal's, but while a
	// program reads the keyboard its keys are key presses (^C is Ctrl-C).
	const BAR_KEY: Record<string, number> = { esc: KEY.esc, tab: KEY.tab, up: KEY.up, down: KEY.down, left: KEY.left, right: KEY.right };
	const barPress = (k: string) => {
		if (!evdev()?.keyboardOpen) return KW.ui?.pressKey(k);
		if (k === "ctrl") return KW.ui?.setCtrl(!ui$().get().ctrl);
		if (k === "^c") return void (takeCtrl(), tapKey(domCodeToLinux("KeyC")!, false, true));
		const c = CHAR_KEY.get(k);
		const code = BAR_KEY[k] ?? c?.[0];
		if (code !== undefined) tapKey(code, c?.[1] ?? false, takeCtrl());
	};
	const kbdInput = () => {
		const el = kbdRef.current!, now = el.value, old = was.current;
		let same = 0;
		while (same < now.length && same < old.length && now[same] === old[same]) same++;
		typeText(now.slice(same), old.length - same);
		was.current = now;
		if (!composing.current) el.value = was.current = SENTINEL;
	};
	// Keys a phone keyboard does send as keys (Enter; a hardware keyboard's
	// Tab, Esc and arrows): sent as themselves, not typed into the input.
	const kbdKeyDown = (e: ReactKeyboardEvent) => {
		if (e.nativeEvent.isComposing || e.keyCode === 229) return;
		const k = ({ Enter: named.enter, Tab: named.tab, Escape: named.esc, ArrowUp: dirs.up, ArrowDown: dirs.down, ArrowLeft: dirs.left, ArrowRight: dirs.right } as Record<string, PadKey>)[e.key];
		if (!k) return;
		e.preventDefault();
		if (evdev()?.keyboardOpen) tapKey(k.code);
		else { const t = typeof k.tty === "function" ? k.tty() : k.tty; if (t) opts.sendTty(t); }
	};
	const toggleKbd = () => {
		const el = kbdRef.current!;
		if (document.activeElement === el) el.blur();
		else { el.value = was.current = SENTINEL; el.focus(); } // in the tap, or iOS shows no keyboard
	};
	const on = (k: PadKey) => (lit.has(k) ? "" : undefined);

	// Stick: the knob follows the finger, held inside the rim; the direction
	// from the base's centre presses the arrows, 8-way (each 135 degrees wide,
	// so a diagonal presses two keys).
	const stickKeys = (e: ReactPointerEvent) => {
		const p = localPos(stickRef.current!, rot, e);
		const x = (p.x - 0.5) * 2, y = (p.y - 0.5) * 2;
		const r = Math.hypot(x, y);
		setKnob(r > 1 ? { x: x / r, y: y / r } : { x, y });
		const out = new Set<PadKey>();
		if (r < STICK_DEAD) return out;
		const a = Math.atan2(y, x) * 180 / Math.PI; // 0 = right, 90 = down
		if (a > -67.5 && a < 67.5) out.add(dirs.right);
		if (a > 22.5 && a < 157.5) out.add(dirs.down);
		if (a > 112.5 || a < -112.5) out.add(dirs.left);
		if (a > -157.5 && a < -22.5) out.add(dirs.up);
		return out;
	};
	const stickTrack = track(stickKeys);
	// Hidden mid-press: the controls unmount without a pointerup.
	useEffect(() => { if (!controls) { releaseAll(); setKnob(null); } }, [controls]);
	const stickEnd = (h: (e: ReactPointerEvent) => void) => (e: ReactPointerEvent) => { h(e); setKnob(null); };
	const stick = {
		...stickTrack,
		onPointerUp: stickEnd(stickTrack.onPointerUp),
		onPointerCancel: stickEnd(stickTrack.onPointerCancel),
		onLostPointerCapture: stickEnd(stickTrack.onLostPointerCapture),
	};
	const chev = (k: PadKey) => (lit.has(k) ? "stroke-white" : "stroke-white/45");

	// Plain render helpers, not components: a component defined here would
	// remount on every render and lose its pointer capture mid-press.
	const face = (f: FaceDef, size: string, extraClass = "") => {
		const k = named[f.key];
		return (
			<button key={f.letter} type="button" aria-label={`${f.letter} (${k.label})`} data-on={on(k)}
				className={`pointer-events-auto flex flex-col items-center justify-center rounded-full p-0 ${size} ${GLASS} ${LIT} ${NO_TOUCH_UI} ${extraClass}`}
				{...track(() => new Set([k]))}>
				<span className={`text-xl leading-none font-bold ${f.color}`}>{f.letter}</span>
				<span className="mt-0.5 text-[7px] leading-none font-medium tracking-wide text-white/45 uppercase">{k.label}</span>
			</button>
		);
	};
	const pill = (id: KeyId) => {
		const k = named[id];
		return (
			<button key={id} type="button" data-on={on(k)}
				className={`pointer-events-auto h-7 min-w-15 rounded-full px-3 text-[10px] font-medium tracking-wider text-white/80 uppercase ${GLASS} ${LIT} ${NO_TOUCH_UI}`}
				{...track(() => new Set([k]))}>{k.label}</button>
		);
	};
	const cap = (id: KeyId) => {
		const k = named[id];
		return <button key={id} type="button" data-on={on(k)} className={CAP} {...track(() => new Set([k]))}>{k.label}</button>;
	};
	const chip = (label: ReactNode, title: string, run: () => void, pressed?: boolean) => (
		<button type="button" title={title} aria-label={title} aria-pressed={pressed} className={CHIP}
			onPointerDown={(e) => e.preventDefault() /* no focus, no keyboard */} onClick={run}>{label}</button>
	);

	let right: ReactNode;
	if (L.grid) right = <div className="grid grid-cols-[repeat(3,56px)] gap-1.5">{L.grid.map(cap)}</div>;
	else {
		const f = L.faces!;
		right = (
			<div className="flex flex-col items-center gap-3">
				<div className="flex gap-2">{L.select && pill(L.select)}{L.start && pill(L.start)}</div>
				<div className="grid grid-cols-[repeat(3,52px)] grid-rows-[repeat(3,52px)] place-items-center">
					{face(f[0]!, "size-[52px]", "col-start-2 row-start-1")}
					{face(f[1]!, "size-[52px]", "col-start-1 row-start-2")}
					{face(f[2]!, "size-[52px]", "col-start-3 row-start-2")}
					{face(f[3]!, "size-[52px]", "col-start-2 row-start-3")}
				</div>
			</div>
		);
	}

	return (
		<div id="pad" className="pointer-events-none absolute inset-0 z-4 flex flex-col justify-between pt-(--pt) pr-(--pr) pb-(--pb) pl-(--pl)" style={pads}>
			{/* The soft keyboard's input: invisible, at the top so focusing it scrolls nothing; 16px so iOS does not zoom. */}
			<input ref={kbdRef} aria-label="Keyboard input" type="text" defaultValue={SENTINEL} autoCapitalize="off" autoComplete="off" autoCorrect="off" spellCheck={false}
				className="pointer-events-none absolute top-0 left-0 size-px border-0 p-0 text-[16px] opacity-0"
				onInput={kbdInput} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; kbdInput(); }}
				onKeyDown={kbdKeyDown} onFocus={() => setKbd(true)} onBlur={() => setKbd(false)} />
			<div className="flex flex-col items-end gap-1.5">
				<div className="flex gap-1.5">
					{covering && chip("tty", "Hide the display: back to the windows", () => setDisplayShown(false))}
					{offerFullscreen() && chip(<FullscreenIcon on={full} />, full ? "Leave full screen" : "Full screen", () => void toggleFullscreen().then((m) => m && KW.ui?.toast(m)), full)}
					{portrait && chip(<RotateIcon />, rotate ? "Rotated: hold the phone sideways (tap to turn back)" : "Rotate the display", () => setRotate(!rotate), rotate)}
					{tablet && chip(touchMode === "mouse" ? <PointerIcon /> : <TrackpadIcon />, touchMode === "mouse" ? "Touch: the pointer goes to your finger (tap for trackpad)" : "Touch: drag to move the pointer (tap for mouse)", () => setTouchMode(touchMode === "mouse" ? "trackpad" : "mouse"))}
					{controls && chip(L.name, `Buttons: ${L.name} (tap for ${LAYOUTS[L.next].name})`, () => setPadLayout(L.next))}
					{chip(<KeyboardIcon />, kbd ? "Hide the keyboard" : "Show the keyboard", toggleKbd, kbd)}
					{chip(<GamepadIcon />, controls ? "Hide the stick and buttons" : "Show the stick and buttons", () => setControls(!controls), controls)}
				</div>
			</div>
			{controls && <div className={`flex items-end justify-between gap-3 ${kbd ? "mb-[52px]" : ""}`}>
				<div ref={stickRef} aria-label="Direction stick" className={`pointer-events-auto relative size-36 flex-none ${NO_TOUCH_UI}`} {...stick}>
					<svg viewBox="0 0 100 100" className="absolute inset-0 size-full overflow-visible" aria-hidden="true">
						<circle cx="50" cy="50" r="48" className="fill-black/25 stroke-white/35" strokeWidth="1.5" />
						<circle cx="50" cy="50" r="24" className="fill-none stroke-white/15" strokeWidth="1" />
						{/* CSS transform in user units; it eases back only on release. */}
						<g style={{ transform: `translate(${(knob?.x ?? 0) * KNOB_TRAVEL}px, ${(knob?.y ?? 0) * KNOB_TRAVEL}px)` }} className={knob ? "" : "transition-transform duration-150 ease-out"}>
							<circle cx="50" cy="50" r="21" className={knob ? "fill-white/40 stroke-white/80" : "fill-white/25 stroke-white/55"} strokeWidth="1.5" />
							<circle cx="50" cy="50" r="13" className="fill-none stroke-white/25" strokeWidth="1" />
						</g>
						{/* Over the knob, so a pushed knob does not hide the lit one. */}
						{(Object.keys(CHEVRON) as (keyof typeof CHEVRON)[]).map((d) => (
							<path key={d} d={CHEVRON[d]} className={`fill-none ${chev(dirs[d])}`} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
						))}
					</svg>
				</div>
				<div className="flex-none">{right}</div>
			</div>}
			{/* Flush with the content's bottom, so just above the phone's keyboard (the page follows the visual viewport). */}
			<Keys show={kbd} onPress={barPress} omit={guestKeyboard ? ["paste"] : undefined}
				className="pointer-events-auto absolute inset-x-0 bottom-0 z-1" />
		</div>
	);
}
