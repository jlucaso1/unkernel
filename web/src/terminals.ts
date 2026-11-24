// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// What the page does with the terminals (wterms.ts, through KW.windows) and
// their Terminal windows (termtabs.ts), as the prefix's keys (keys.ts), the
// Dock, the tab strips, the window menus and the launcher run it: show a
// terminal (its tab, and its window focused, raised and restored), open one
// (a tab of a given Terminal window, of a new one, or of the one that last
// had the focus), close one (asking first while its shell runs), and a
// Terminal window's close button (all its tabs; the console's window has
// none). Each says why in a toast when it cannot.
import { keyFor, PREFIX } from "./keys.ts";
import { KW } from "./kw.ts";
import { isRunning, ui$ } from "./store.ts";
import { currentTerminal, selectTab, termWindow } from "./termtabs.ts";
import type { OpenError } from "./wterms.ts";

/** Show terminal n (0: the console): its tab, and its Terminal window focused, raised and restored. */
export function selectTerminal(n: number): void {
	const ui = KW.ui!, t = KW.windows;
	if (n !== 0 && !t?.list().some((x) => x.n === n)) {
		ui.toast(`No terminal ${n}: ${KW.config.coarse ? "+ in the Dock" : `${PREFIX} ${keyFor("new-tab")}`} opens one`);
		return;
	}
	if (t) t.select(n);
	else selectTab(n); // before the boot module runs: the console only
}

/**
 * Open a terminal (its own shell over vsock) and show it: a tab of Terminal
 * window `where` (an id), of a new one ("new"), or by default of the one
 * that last had the focus. Only while the system runs (store.ts isRunning;
 * the controls for it are dimmed until then); else a toast says so.
 */
export function newTerminal(where?: string): void {
	const ui = KW.ui!, t = KW.windows;
	if (!t || !isRunning(ui$().get())) { ui.toast("Terminals open once the system is running"); return; }
	// A failure after the tab was made shows in the tab itself.
	t.open({ window: where }).catch((e: OpenError) => { if (e?.term === undefined) ui.toast(e?.message ?? String(e)); });
}

/** Open a new Terminal window with a new terminal in it. */
export const newTerminalWindow = (): void => newTerminal("new");

/** Close terminal n (the current one by default), asking first while its shell runs; terminal 0 stays. */
export async function closeTerminal(n = currentTerminal()): Promise<void> {
	const ui = KW.ui!, t = KW.windows?.list().find((x) => x.n === n);
	if (!t || n === 0) { ui.toast("Terminal 0, the console, cannot be closed"); return; }
	if (t.state === "open" && !await ui.ask({ title: `close terminal ${n}`, msg: "Its shell and the programs started from it are hung up (SIGHUP).", ok: "Close", danger: true })) return;
	await KW.windows!.close(n);
}

/**
 * A Terminal window's close button: close its terminals, asking once while
 * any of their shells runs. The console's window has no close button.
 */
export async function closeTerminalWindow(id: string): Promise<void> {
	const tw = termWindow(id);
	if (!tw) return;
	const ttys = tw.tabs.filter((n) => n !== 0);
	const list = KW.windows?.list() ?? [];
	const running = list.filter((x) => ttys.includes(x.n) && x.state === "open");
	if (running.length && !await KW.ui!.ask({
		title: running.length > 1 ? `close ${running.length} terminals` : `close terminal ${running[0]!.n}`,
		msg: `${running.length > 1 ? "Their shells" : "Its shell"} and the programs started from ${running.length > 1 ? "them" : "it"} are hung up (SIGHUP).`,
		ok: "Close", danger: true,
	})) return;
	await Promise.all(ttys.map((n) => KW.windows?.close(n)));
}
