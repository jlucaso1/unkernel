// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// A Terminal window's tab strip (termtabs.ts; drawn in its title bar, and in
// the compact strip on phones, through wm.ts titleContent): a tab per
// terminal in the window, #term-tab-N on terminal N's tab button, titled con, tty N, the foreground program or the
// app's name (termtabs.ts tabLabel()), faint
// while it opens and red once it ended (why in the tooltip). The console's
// tab has no ×; a tty's × asks first while its shell runs (terminals.ts
// closeTerminal). + (#term-tab-new in the console's window) opens a new tty in this window (while one can open: not
// all MAX_TERMINALS taken, the kernel not stopped; dimmed until the system
// runs, store.ts isRunning); a right click, a
// Shift-click or a long press on it opens a new Terminal window with a new
// tty. While the prefix is armed each tab shows its digit.
import { memo } from "react";
import { keyFor, PREFIX, terminalKey } from "../keys.ts";
import { isRunning, isStopped, useStore } from "../store.ts";
import { closeTerminal, newTerminal, newTerminalWindow, selectTerminal } from "../terminals.ts";
import { CONSOLE_WIN, MAX_TERMINALS, tabLabel, useTermTabs } from "../termtabs.ts";
import { withKey } from "./KeyHint.tsx";
import { Tabs, type TabItem } from "./Tabs.tsx";

export const TerminalTabs = memo(function TerminalTabs({ id }: { id: string }) {
	const tw = useTermTabs((s) => s.windows.find((w) => w.id === id));
	const terms = useTermTabs((s) => s.terms);
	const stopped = useStore(isStopped);
	const running = useStore(isRunning);
	if (!tw) return null;
	const canOpen = terms.length < MAX_TERMINALS && !stopped;
	const items: Array<TabItem & { key: number }> = tw.tabs.map((n) => {
		const l = tabLabel(n, terms);
		const how = l.state === "opening" ? ", starting" : l.state === "ended" ? `, ended${l.note ? `: ${l.note}` : ""}` : "";
		return {
			key: n, id: `term-tab-${n}`, label: l.title, closable: n !== 0, hint: terminalKey(n),
			state: l.state === "opening" ? "busy" : l.state === "ended" ? "error" : undefined,
			title: withKey(`${n === 0 ? "The console" : l.title}, terminal ${n}${how}`, terminalKey(n)),
		};
	});
	return (
		<Tabs label="Terminals" items={items} active={tw.active}
			onSelect={selectTerminal} onClose={(n) => void closeTerminal(n)}
			onNew={canOpen ? () => newTerminal(id) : undefined} onNewAlt={canOpen ? newTerminalWindow : undefined}
			newId={id === CONSOLE_WIN ? "term-tab-new" : undefined} newOff={!running}
			newTitle={`New terminal tab (${PREFIX} ${keyFor("new-tab")}); right click or hold: new window (${PREFIX} ${keyFor("new-window")})`}
		/>
	);
});
