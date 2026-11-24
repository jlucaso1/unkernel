// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Who owns the keyboard: whether an element (a key press's target, the
// focused element) belongs to a terminal, and so to the guest, or to some
// other part of the page that takes its keys itself. One selector list per
// question, so the places that ask agree:
// - inTerminal(): a terminal (its wterm, its hidden input). termtabs.ts
//   isTerminalEl() narrows it (never anything of wland's);
// - isField(): a text field or a select outside the terminals (the soft
//   keyboard's input, the Browser's address, a Settings field);
// - inSurface(): a part of the page with its own keyboard handling: the
//   system apps' windows (Settings, System), the modal dialogs (confirm,
//   paste), the launcher;
// - inBars(): the Dock, the top bar, their menus, the Dock's group stack and
//   the top bar's popovers (the Control Center, Resources);
// - ownsKeys(): keys typed here are the page's, not the guest's: any of the
//   above but a terminal, or a notification's button (the toast, the Resume
//   card). boot.ts (a key that ends a pause) and display.ts (evdev routing)
//   leave such keys alone;
// - isPageChrome(): an event here is a use of the page, not of the machine
//   (boot.ts: whether the user has used this machine).
// Elements without closest() (the document, the window) are none of these.

/** A terminal: the console's #term, a tab's .term-pty, the wterm, a Terminal window's body. */
const TERMINALS = '#term, .term-pty, .wterm, [data-app="terminal"]';
const FIELDS = "input, select, textarea, [contenteditable]";
/** The system apps (sysapps.ts .kw-app), every modal <dialog> (#confirm, #paste: Dialog.tsx), the launcher. */
const SURFACES = ".kw-app, dialog, #launcher";
/** The Dock (#dock), the top bar, an open menu (Menu.tsx), the Dock's group stack (DockStack.tsx) or the top bar's popovers (ControlCenter.tsx), all in portals on <body>. */
const BARS = "#dock, #topbar, [role=menu], #dock-stack, #tb-cc, #tb-res";
/** The toast's button, the Resume card's. */
const CARDS = "#toast, #resume-card";
/**
 * The page's own controls: the system apps, the bars, the confirm dialog.
 * Not the paste dialog, the launcher, the cards or fields: they lead into the
 * machine (a paste, a launch, Continue, the Display's soft keyboard).
 */
const CHROME = `.kw-app, #confirm, ${BARS}`;

type Target = EventTarget | Element | null | undefined;
const el = (t: Target): Element | null => (t && typeof (t as Element).closest === "function" ? (t as Element) : null);

/** In a terminal (see TERMINALS). */
export const inTerminal = (t: Target): boolean => !!el(t)?.closest(TERMINALS);
/** A field outside the terminals (a terminal's hidden input is the guest's). */
export const isField = (t: Target): boolean => !!el(t)?.closest(FIELDS) && !inTerminal(t);
/** In the system apps, a modal dialog or the launcher. */
export const inSurface = (t: Target): boolean => !!el(t)?.closest(SURFACES);
/** In the Dock, the top bar, a menu, the group stack or a top bar popover. */
export const inBars = (t: Target): boolean => !!el(t)?.closest(BARS);
/** Keys typed here are the page's: a field, a surface, the bars, a card's button; never a terminal. */
export const ownsKeys = (t: Target): boolean => !inTerminal(t) && (!!el(t)?.closest(`${SURFACES}, ${BARS}, ${CARDS}`) || isField(t));
/** An event here is a use of the page's controls, not of the machine (see CHROME). */
export const isPageChrome = (t: Target): boolean => !!el(t)?.closest(CHROME);
