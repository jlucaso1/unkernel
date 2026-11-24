// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The terminals: their wterms and sessions. Terminal 0 is the console (hvc0,
// boot.ts); terminals 1 to 9 are sessions over vsock (the SDK's spawn(),
// served by the guest's kwtty), each with its own pty, size and login shell,
// and its own wterm (.term-pty#term-N). Each is a tab of a Terminal window
// (termtabs.ts: the windows and their tabs; the console's window is opened
// by components/Workspace.tsx with #term in it); a new one goes into the
// window asked for, else the one that last had the focus. This module
// publishes them to termtabs.ts (setTerms(), setCurrent()), whose state the
// tab strips, the Dock and the launcher read; the prefix opens (n; N in a
// new window), switches (digits) and closes (x) them (terminals.ts), and
// KW.windows is the API for both and for the browser tests (named so for
// them: its "windows" are the terminals).
// - Selecting terminal N shows its tab and focuses and raises its Terminal
//   window (restored if minimized). The current terminal (termtabs.ts) is
//   the one that last had the focus, however it got it (the Dock, a tab, a
//   click on its window, another tab or window closing): the key bar, paste,
//   KW.term and the prefix's x act on it.
// - A tab's × asks as the prefix's x does (terminals.ts closeTerminal) and
//   closes its session; the console's tab has none. A Terminal window's
//   close button closes all its tabs (terminals.ts closeTerminalWindow);
//   the console's window has none.
//
// - Opening waits until user space runs (the first console output), then
//   spawn() retries for up to 30 s while kwtty is not listening.
//   Typing while it opens is kept (64 KiB at most) and sent once it runs.
//   A failure (no kwtty: an older kernel, or a root on the data disk whose
//   own /etc/inittab hides the image's) stays in the terminal as a message.
// - Output: each terminal reads its session's output all the time, shown or
//   not, since a session nobody reads blocks its programs (vsock credit
//   follows the reads). wterm's write() parses at once into its grid and
//   bounded scrollback, so nothing queues up on this side: a hidden one
//   only has its painting paused (setRenderingPaused: while it is not
//   shown, termtabs.ts: not its window's active tab, or the WM does not
//   show its window: minimized, or not the top one on a phone). The next chunk is
//   read only after write() returned, and the reader yields a task every
//   16 ms or 256 KiB, so a flood in one terminal cannot freeze the page.
// - The shell exiting closes its tab: its window shows the next tab (and
//   goes with its last one; the WM focuses the next one down). A lost
//   session or a failed one keeps the tab with a message until it is closed
//   (Enter in it, or the prefix, x). The kernel stopping (halt, power off,
//   reboot, panic) closes them all.
// - Suspend and resume: every terminal's session is detachable (kwtty's
//   DETACH, js.md), so the restore's reset of its connection leaves its
//   shell and programs running in the guest. The suspend records the open
//   ones (saved(): number, name, session id, which Terminal window they were
//   tabs of and whether shown there) in the session record, and the resume
//   opens them again with the same numbers and names, as tabs grouped as
//   they were (older records: all in the console's window), and
//   attach()es each (reattach()); kwtty replays the session's recent
//   output into the fresh terminal and makes a full-screen program redraw.
//   A session that is gone (not attached within kwtty's 60 s) gives a tty N
//   terminal a new shell, with a gray line saying so; a named one (an app)
//   shows that it ended.
// - Each has its own size, its Terminal window's box (shared by its tabs;
//   hidden ones keep it, since they are hidden with visibility): wterm
//   refits to it, and it goes to the shell with resize() (SIGWINCH).
// - A tty N one (opened without a name) shows the program in the
//   foreground of its terminal as its tab's title (vim, top) while it is
//   not the shell itself. Every second while such a terminal runs, one
//   vm.exec() reads them all from /proc (FG_SH); not while the page is
//   hidden or the system paused or suspended, nor while the last one still runs.
import { WTerm } from "@wterm/dom";
import { trackBottom, type Bottom } from "./bottom.ts";
import { keyFor, PREFIX } from "./keys.ts";
import { KW, type TerminalInfo, type TerminalsApi } from "./kw.ts";
import { PtyError, type KernelHandle, type Pty } from "./sdk.ts";
import { isHeld, ui$ } from "./store.ts";
import { FX_END } from "./wmfx.ts";
import {
	addTab, CONSOLE_WIN, currentTerminal, isTabShown, MAX_TERMINALS, removeTab, selectTab, setCurrent, setTermHooks, setTerms, showTab,
	targetWindow, terminalHasFocus, windowIndex, windowOf, type Term, type TermState,
} from "./termtabs.ts";

/** How long spawn() waits for the guest's server once user space runs. */
const OPEN_TIMEOUT = 30000;
/** Typing kept while a terminal opens. */
const PENDING_MAX = 65536;
/** The output reader yields a task after this long or this much. */
const SLICE_MS = 16, SLICE_BYTES = 262144;
const SGR = { gray: "\x1b[90m", red: "\x1b[1;31m", off: "\x1b[0m" };
/** How often the foreground programs of the tty N terminals are read. */
const FG_MS = 1000;
/**
 * A line per shell pid: the name of its terminal's foreground process group
 * leader (tpgid, the 6th field after the name in /proc/<pid>/stat), or an
 * empty line while the shell itself is in front or it cannot be read.
 */
const FG_SH = 'for p; do t=; c=; read -r s 2>/dev/null </proc/$p/stat && { set -- ${s##*\\) }; t=$6; }; ' +
	'[ "$t" -gt 0 ] 2>/dev/null && [ "$t" != "$p" ] && read -r c 2>/dev/null </proc/$t/comm; echo "$c"; done';

/** wterm's font: it takes the row height from --term-row-height, not from the font, so set both, at wterm's own ratio. */
export function setTermFont(el: HTMLElement, px: number): void {
	el.style.setProperty("--term-font-size", `${px}px`);
	el.style.setProperty("--term-row-height", `${Math.round(px * 1.2)}px`);
}

/** The options every terminal on the page has (the console's in boot.ts too). */
export const TERM_OPTIONS = { scrollbackLines: 5000, cursorBlink: true } as const;

/** History and screen as text, a line per row (wterm's own readText() is async). */
export function termText(term: WTerm): string {
	const c = term.bridge;
	if (!c) return "";
	const hist = c.getScrollbackCount(), out: string[] = [];
	for (let r = 0; r < hist + c.getRows(); r++) {
		const old = r < hist, off = hist - r - 1; // scrollback offset 0 is the newest line
		const n = old ? c.getScrollbackLineLen(off) : c.getCols();
		let s = "";
		for (let col = 0; col < n; col++) {
			const cell = old ? c.getScrollbackCell(off, col) : c.getCell(r - hist, col);
			if (cell.width === 0 || cell.spacerHead) continue;
			s += cell.chars ?? String.fromCodePoint(cell.char || 32);
		}
		out.push(s.trimEnd());
	}
	return out.join("\n");
}

/**
 * Text pasted as a terminal pastes it (newlines become CR), bracketed when the
 * application asked for it, without ESC bytes (as wterm's own paste: no way out early).
 */
export function pasteText(term: WTerm, t: string): string {
	const s = t.replace(/\r?\n/g, "\r");
	return term.bridge?.bracketedPaste() ? `\x1b[200~${s.replace(/\x1b/g, "")}\x1b[201~` : s;
}

/** A task boundary that background tabs do not throttle (unlike setTimeout). */
function yieldTask(): Promise<void> {
	return new Promise((resolve) => {
		const ch = new MessageChannel();
		ch.port1.onmessage = () => { ch.port1.close(); resolve(); };
		ch.port2.postMessage(0);
	});
}

/** A terminal besides the console, as this module runs it. */
interface OpenTerm {
	n: number;
	/** Its name: "tty N", or what the launcher runs in it. */
	name: string;
	/** A tty N terminal (no name given): its title shows its foreground program (fg). */
	tty: boolean;
	/** The program in the foreground of its terminal when it is not the shell, else "" (pollFg). */
	fg: string;
	el: HTMLElement;
	term: WTerm;
	bottom: Bottom;
	state: TermState;
	note: string;
	session: Pty | null;
	abort: AbortController;
	pending: Array<string | Uint8Array>;
	pendingBytes: number;
	gone: boolean;
}

export interface TerminalsOptions {
	/** Terminal 0: the console's. */
	term0: WTerm;
	/** Type into the console. */
	send0: (data: string | Uint8Array) => void;
	/** The kernel once user space runs; rejects if it never does (the boot failed, the kernel stopped). */
	ready: () => Promise<KernelHandle>;
	/** The kernel is starting or running: false once it stopped or the boot failed. */
	alive: () => boolean;
	/** Give the current terminal the focus after a switch or a click on its frame (not on touch devices, where it raises the keyboard). */
	autoFocus: boolean;
}

/** A terminal as the session record keeps it across a suspend (SessionMeta.windows: the record's names stay, so saved sessions load). */
export interface SavedTerminal {
	n: number;
	name: string;
	/** A tty N terminal (no name given). */
	tty: boolean;
	/** Its session's id (Pty.sessionId), for attach(). */
	id: string;
	/** The Terminal window it was a tab of, from 1 (the console's); absent in older records: 1. */
	win?: number;
	/** It was that window's shown tab. */
	shown?: boolean;
}

export interface Terminals extends TerminalsApi {
	/** The current terminal's wterm. */
	currentTerm(): WTerm;
	/** Type into the current terminal. */
	sendCurrent(data: string | Uint8Array): void;
	/** Focus the current terminal. */
	focus(): void;
	/** The font size of every terminal. */
	setFont(px: number): void;
	/** The kernel stopped: close every terminal (the console stays). */
	closeAll(): void;
	/** The open terminals whose sessions can be reattached after a restore (those among `ttys`, a snapshot's, when given). */
	saved(ttys?: readonly { id: string }[]): SavedTerminal[];
	/** After a resume: open the saved terminals again and attach their sessions; `current` is shown. */
	reattach(list: readonly SavedTerminal[], current?: number): void;
}

/** An error from open() after the terminal was made (term: its number): the terminal shows it. */
export type OpenError = Error & { term?: number };

export function createTerminals(opts: TerminalsOptions): Terminals {
	const $ = ui$();
	const terms = new Map<number, OpenTerm>();
	const el0 = opts.term0.element;
	const current = currentTerminal;
	const termOf = (n: number): WTerm | null => (n === 0 ? opts.term0 : terms.get(n)?.term ?? null);
	/** The terminals' font size (setFont follows the setting). */
	let fontPx = KW.config.fontSize;
	// A window effect ended (wmfx.ts FX_END): a terminal in that window that measured its cells while the
	// window was drawn scaled (wterm measures with getBoundingClientRect()) has the wrong cell width and
	// row height, so its text overlaps or its grid has the wrong size. Set the row height again and refit.
	document.addEventListener(FX_END, (e) => {
		const w = e.target as Node;
		const again = (el: HTMLElement, term: WTerm) => { if (w.contains(el)) { setTermFont(el, fontPx); term.fit(); } };
		again(el0, opts.term0);
		for (const t of terms.values()) if (!t.gone && t.term) again(t.el, t.term);
	});

	/** Terminal n got the focus (termtabs.ts: its window got the WM's focus, or showed its tab while focused): it is the current one. */
	function activated(n: number) {
		setCurrent(n);
		const el = n === 0 ? el0 : terms.get(n)?.el;
		if (opts.autoFocus && el && !el.contains(document.activeElement)) termOf(n)?.focus();
	}
	/** Shown or not (termtabs.ts): paint only while shown; focus inside a hidden one would type into it unseen. */
	function shownChanged(term: WTerm | null, el: HTMLElement, visible: boolean) {
		term?.setRenderingPaused(!visible);
		if (!visible && el.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
	}
	setTermHooks({
		activated,
		shown: (n, v) => { const el = n === 0 ? el0 : terms.get(n)?.el; if (el) shownChanged(termOf(n), el, v); },
	});
	opts.term0.setRenderingPaused(!isTabShown(0));

	/** Into termtabs.ts: the tabs' titles and states, the Dock and the launcher follow. */
	function publish() {
		setTerms([...terms.values()].sort((a, b) => a.n - b.n).map((t): Term => ({ n: t.n, name: t.name, state: t.state, note: t.note, fg: t.fg })));
	}

	/** The tty N terminals whose shell runs: those pollFg() reads. */
	const ttys = () => [...terms.values()].filter((t) => t.tty && t.state === "open" && t.session);
	let fgTimer: ReturnType<typeof setTimeout> | undefined;
	/** Poll while there is a tty N terminal to read (see the top of this file). */
	function scheduleFg() {
		if (fgTimer === undefined && ttys().length) fgTimer = setTimeout(() => void pollFg(), FG_MS);
	}
	async function pollFg() {
		const list = ttys();
		try {
			if (!list.length || document.hidden || isHeld($.get()) || !opts.alive()) return;
			const vm = await opts.ready();
			const r = await vm.exec("/bin/sh", ["-c", FG_SH, "sh", ...list.map((t) => String(t.session!.pid))]);
			const lines = r.stdout.split("\n");
			let changed = false;
			list.forEach((t, i) => {
				const fg = (lines[i] ?? "").trim();
				if (!t.gone && t.fg !== fg) { t.fg = fg; changed = true; }
			});
			if (changed) publish();
		} catch {
			// The kernel stopped or the guest could not run it: try again next time.
		} finally {
			fgTimer = undefined;
			scheduleFg();
		}
	}

	function focus() {
		termOf(current())?.focus();
	}

	/** Show terminal n: its tab, and its Terminal window focused, raised and restored (activated() makes it current). */
	function select(n: number): boolean {
		if (!termOf(n)) return false;
		const had = terminalHasFocus();
		selectTab(n);
		if (opts.autoFocus || had) focus();
		return true;
	}

	function info(t: OpenTerm): TerminalInfo {
		return { n: t.n, name: t.name, state: t.state, current: current() === t.n, pid: t.session?.pid, pts: t.session?.pts, note: t.note || undefined, window: windowOf(t.n)?.id };
	}

	function list(): TerminalInfo[] {
		return [{ n: 0, name: "con", state: "open", current: current() === 0, window: windowOf(0)?.id }, ...[...terms.values()].sort((a, b) => a.n - b.n).map(info)];
	}

	function pixels(t: OpenTerm) {
		const cell = parseFloat(t.el.style.getPropertyValue("--term-cell-width")) || 0;
		const row = parseFloat(t.el.style.getPropertyValue("--term-row-height")) || 0;
		return { x: Math.min(0xffff, Math.round(t.term.cols * cell)), y: Math.min(0xffff, Math.round(t.term.rows * row)) };
	}

	function write(t: OpenTerm, s: string) {
		if (!t.gone) t.term.write(s);
	}

	/** The terminal stays, showing why its session is over, until it is closed. */
	function endWith(t: OpenTerm, msg: string) {
		if (t.gone) return;
		t.state = "ended";
		t.note = msg;
		t.session = null;
		t.pending = [];
		write(t, `\r\n${SGR.red}[host] ${msg.replace(/\n/g, "\r\n")}${SGR.off}\r\n${SGR.gray}[host] Enter or ${PREFIX} ${keyFor("close-tab")} closes this tab${SGR.off}\r\n`);
		publish();
	}

	/**
	 * Remove terminal t and its tab: its window shows the next tab (current if
	 * the window has the focus), or goes with its last one (the WM focuses
	 * the next one down); else the current terminal falls back to the tab
	 * shown in the Terminal window that last had the focus.
	 */
	function remove(t: OpenTerm) {
		if (t.gone) return;
		t.gone = true;
		t.abort.abort();
		const had = t.el.contains(document.activeElement);
		terms.delete(t.n);
		removeTab(t.n); // may call activated() for the next one
		if (current() === t.n) setCurrent(targetWindow()?.active ?? 0);
		if (had) focus();
		t.term.destroy();
		t.bottom.dispose();
		t.el.remove();
		publish();
	}

	function input(t: OpenTerm, d: string | Uint8Array) {
		if (t.state === "open" && t.session) t.session.write(d).catch(() => {});
		else if (t.state === "ended" && typeof d === "string" && d.includes("\r")) void close(t.n);
		else if (t.state === "opening" && t.pendingBytes + d.length <= PENDING_MAX) {
			t.pending.push(d);
			t.pendingBytes += d.length;
		}
	}

	/** Read the session's output for as long as it lasts (see the top of this file). */
	async function pump(t: OpenTerm, s: Pty) {
		const reader = s.output.getReader();
		let since = performance.now(), bytes = 0;
		try {
			for (;;) {
				const r = await reader.read();
				if (r.done) return;
				if (t.gone) { void reader.cancel(); return; } // closed: discard the rest, so `ended` settles
				t.term.write(r.value);
				bytes += r.value.length;
				if (bytes >= SLICE_BYTES || performance.now() - since >= SLICE_MS) {
					await yieldTask();
					since = performance.now();
					bytes = 0;
				}
			}
		} catch {
			// The session failed: `ended` rejects with why.
		}
	}

	function watch(t: OpenTerm, s: Pty) {
		s.ended.then((end) => {
			if (t.gone) return;
			if (end.type === "exit" || end.type === "closed") remove(t);
			else if (end.type === "signal") {
				KW.ui?.toast(`Window ${t.n}: the shell was killed by signal ${end.signal}${end.coreDumped ? " (core dumped)" : ""}`);
				remove(t);
			} else if (!opts.alive()) remove(t); // the kernel stopped: closeAll()
			else endWith(t, "The session was lost: its connection closed without an exit status.");
		}, (e: unknown) => {
			if (!t.gone) endWith(t, `The session failed: ${(e as Error)?.message ?? e}`);
		});
	}

	/** Why spawn() failed, for the terminal; null: nothing to show (closed, or the kernel stopped). */
	function openFailure(e: unknown): string | null {
		const code = e instanceof PtyError ? e.code : undefined;
		if (code === "ABORTED" || code === "ECONNABORTED" || !opts.alive()) return null;
		if (code === "ETIMEDOUT")
			return `No terminal server answered in the guest within ${OPEN_TIMEOUT / 1000} s (kwtty on vsock port 1022). Window 0 still works.\n` +
				"The distro's init must keep /usr/bin/kwbox tty serve running (Alpine: the line ::respawn:/usr/bin/kwbox tty serve in /etc/inittab). " +
				"A root changed on the data disk can hide the image's init files (kw-overlay status says where the changes are).";
		if (code === "ENODEV") return "This kernel was started without the vsock device, so it has no terminal sessions.";
		if (code === "ENOENT") return `The session did not survive the suspend: ${(e as Error).message.replace(/^kwtty: /, "")}`;
		if (code === "EREMOTE") return `The guest refused the session: ${(e as Error).message.replace(/^kwtty: /, "")}`;
		return `The terminal session could not open: ${(e as Error)?.message ?? e}`;
	}

	/** Settle with p, or reject when the signal aborts. */
	const abortable = <T>(p: Promise<T>, signal: AbortSignal): Promise<T> => new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(new PtyError("ABORTED", "the window was closed"));
		if (signal.aborted) return onAbort();
		signal.addEventListener("abort", onAbort, { once: true });
		p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});

	/** attach: the session to take over (a resume), as terminal `at` if it is free; window: the Terminal window's id, or "new" (termtabs.ts addTab()). */
	async function open({ select: sel = true, name, file, args, at, attach, window: where }: { select?: boolean; name?: string; file?: string; args?: string[]; at?: number; attach?: string; window?: string } = {}): Promise<TerminalInfo> {
		if (!opts.alive()) throw new Error("The kernel is not running: reboot to open terminal windows");
		let n = at !== undefined && !terms.has(at) ? at : 1;
		while (terms.has(n)) n++;
		if (n > MAX_TERMINALS) throw new Error(`All ${MAX_TERMINALS} terminal windows are open`);
		const tty = name === undefined;
		name ??= `tty ${n}`;
		const el = document.createElement("div");
		el.id = `term-${n}`;
		el.className = "term-pty";
		setTermFont(el, fontPx);
		const t: OpenTerm = {
			n, name, tty, fg: "", el, bottom: null as unknown as Bottom, term: null as unknown as WTerm, state: "opening", note: "", session: null,
			abort: new AbortController(), pending: [], pendingBytes: 0, gone: false,
		};
		// Its tab, not shown (select() shows it), in its window's box (a new window is behind the others
		// and mounted at once), so wterm measures it in place. Where React cannot render now, the box waits until it can.
		addTab(n, el, where);
		terms.set(n, t);
		publish();
		t.bottom = trackBottom(el); // before wterm's own ResizeObserver
		t.term = new WTerm(el, {
			...TERM_OPTIONS,
			onData: (d) => input(t, KW.ui ? KW.ui.applyCtrl(d) : d),
			onBinary: (d) => input(t, d),
			onResize: (cols, rows) => { const px = pixels(t); t.session?.resize(cols, rows, px.x, px.y); },
		});
		t.term.setRenderingPaused(!isTabShown(n));
		if (sel) select(n);
		const failed = (msg: string): OpenError => Object.assign(new Error(msg), { term: n });
		try {
			await t.term.init();
		} catch (e) {
			const msg = `The terminal failed to start: ${(e as Error)?.message ?? e}`;
			endWith(t, msg);
			throw failed(msg);
		}
		if (t.gone) throw failed("The window was closed");
		// wterm's init() measured a row with getBoundingClientRect() and wrote it to --term-row-height: under a
		// window effect's transform (a Terminal window coming out of the Dock) that is a fraction of a row, and
		// every line would draw on top of the last. The row height is the font's (setTermFont), never measured.
		setTermFont(el, fontPx);
		el.querySelector("textarea")?.setAttribute("enterkeyhint", "enter");
		if (current() === n && (opts.autoFocus || el.contains(document.activeElement))) focus();
		// A line while it waits (the guest may still be booting), cleared once the shell runs.
		let waiting = false;
		const waitTimer = setTimeout(() => { waiting = true; write(t, `${SGR.gray}[host] window ${n}: waiting for the guest's terminal server…${SGR.off}`); }, 300);
		let s: Pty;
		try {
			const vm = await abortable(opts.ready(), t.abort.signal);
			// The size spawn() gives is the one the program starts with: the guest runs the
			// login shell and the program before OPENED reaches the page, so the resize()
			// after it comes too late for a program that checks its size once at start (fx
			// exits 0 with "fx needs at least 5 terminal rows."). Fit to the box as it is
			// laid out now (wterm's ResizeObserver may not have run yet, e.g. in a hidden
			// tab); a guard, nothing changes when the grid already fits.
			t.term.fit();
			const px = pixels(t);
			const size = { cols: t.term.cols, rows: t.term.rows, xpixel: px.x, ypixel: px.y, timeout: OPEN_TIMEOUT, signal: t.abort.signal };
			// Detachable: the session outlives a suspend (see the top).
			const spawn = () => vm.spawn(file, args ?? [], { ...size, detachable: true });
			if (attach === undefined) s = await spawn();
			else {
				try {
					s = await vm.attach(attach, size);
				} catch (e) {
					// Gone (kwtty hung it up, or the guest cannot reattach): a tty N terminal gets a new shell.
					if (!(e instanceof PtyError && e.code === "ENOENT") || !tty || t.gone) throw e;
					clearTimeout(waitTimer);
					if (waiting) write(t, "\r\x1b[2K");
					waiting = false;
					write(t, `${SGR.gray}[host] window ${n}: the suspended session is gone (${e.message.replace(/^kwtty: /, "")}); a new shell${SGR.off}\r\n`);
					s = await spawn();
				}
			}
		} catch (e) {
			clearTimeout(waitTimer);
			const msg = openFailure(e);
			if (msg === null || t.gone) {
				remove(t);
				throw failed((e as Error)?.message ?? "The window was closed");
			}
			if (waiting) write(t, "\r\x1b[2K");
			endWith(t, msg);
			throw failed(msg);
		}
		clearTimeout(waitTimer);
		if (t.gone) {
			void s.close().catch(() => {});
			throw failed("The window was closed");
		}
		if (waiting) write(t, "\r\x1b[2K");
		t.session = s;
		t.state = "open";
		const px = pixels(t);
		s.resize(t.term.cols, t.term.rows, px.x, px.y); // it may have changed while opening
		for (const d of t.pending) s.write(d).catch(() => {});
		t.pending = [];
		t.pendingBytes = 0;
		publish();
		void pump(t, s);
		watch(t, s);
		scheduleFg();
		return info(t);
	}

	async function close(n: number): Promise<void> {
		const t = terms.get(n);
		if (!t) return;
		const s = t.session;
		remove(t);
		// Hang up: the shell gets SIGHUP. remove() already let go of the output.
		if (s) await s.close().catch(() => {});
	}

	return {
		list,
		open,
		select,
		close,
		text: (n) => { const t = termOf(n); return t ? termText(t) : ""; },
		send(n, data) {
			if (n === 0) opts.send0(data);
			else { const t = terms.get(n); if (t) input(t, data); }
		},
		currentTerm: () => termOf(current()) ?? opts.term0,
		sendCurrent(data) {
			const n = current();
			if (n === 0) opts.send0(data);
			else { const t = terms.get(n); if (t) input(t, data); }
		},
		focus,
		setFont(px) { fontPx = px; for (const t of terms.values()) setTermFont(t.el, px); },
		closeAll() {
			for (const t of [...terms.values()]) {
				const s = t.session;
				remove(t);
				if (s) void s.close().catch(() => {});
			}
		},
		saved(ttys) {
			const ids = ttys && new Set(ttys.map((t) => t.id));
			// In window order, then tab order, so the resume adds the tabs back as they were.
			const order = (t: OpenTerm) => windowIndex(t.n) * 100 + (windowOf(t.n)?.tabs.indexOf(t.n) ?? 0);
			return [...terms.values()].sort((a, b) => order(a) - order(b))
				.filter((t) => t.state === "open" && t.session?.sessionId !== undefined && (!ids || ids.has(t.session.sessionId)))
				.map((t) => ({ n: t.n, name: t.name, tty: t.tty, id: t.session!.sessionId!, win: windowIndex(t.n) || 1, shown: windowOf(t.n)?.active === t.n }));
		},
		reattach(list, current) {
			/** Saved Terminal window number (2 and up) to the Terminal window opened for it now; 1 (and older records) is the console's. */
			const made = new Map<number, string>();
			for (const sw of list) {
				if (!Number.isInteger(sw?.n) || sw.n < 1 || sw.n > MAX_TERMINALS || terms.has(sw.n) || typeof sw.id !== "string") continue;
				const k = Number.isInteger(sw.win) && sw.win! > 1 ? sw.win! : 1;
				const where = k === 1 ? CONSOLE_WIN : made.get(k) ?? "new";
				// A failure stays in its tab (open() shows it).
				open({ at: sw.n, name: sw.tty ? undefined : String(sw.name), attach: sw.id, select: sw.n === current, window: where }).catch(() => {});
				const tw = windowOf(sw.n);
				if (where === "new" && tw) made.set(k, tw.id);
			}
			for (const sw of list) if (sw?.shown && sw.n !== current && terms.has(sw.n)) showTab(sw.n);
		},
	};
}
