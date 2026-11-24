// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Suspend in the background and the question when the page closes: when to
// take the Suspend button's snapshot by itself, and when to ask before the
// tab goes away. boot.ts wires it to the page (visibilitychange,
// beforeunload, KW.suspend()); this module only decides, so
// web/test/autosuspend.test.ts runs it without a DOM or a kernel (no
// imports at run time).
//
// - ?autosuspend= (config.ts): after the tab has been hidden this long the
//   page saves the machine's session (snapshot({ commit, hold }), session.ts)
//   and keeps the kernel held at its snapshot point, using nothing, while the
//   tab stays hidden. Shown again with the page still alive, the machine
//   simply goes on (every terminal window, connection to the guest, the
//   preview and the guest's state as they were; nothing reloads) and the
//   saved session, stale from then on, is deleted. A page the browser kills
//   or discards meanwhile lost nothing: the session is stored, and the next
//   load resumes it quietly (RESUME_AUTO). After AUTO_SUSPEND_HOLD_MS held (where the
//   page's timers still run) the hold becomes a stop, which frees the
//   machine's memory; the tab, when shown, then resumes it (a reload, as the
//   Resume button). Everything is quiet: no terminal lines, no Resume card,
//   and a resume restores the screen as it was, without the boot lines; the
//   Kernel log and the Environment row say what happened.
//   A phone or tablet freezes or discards a background tab whenever it
//   likes, which loses a running machine; iOS stops a hidden page's scripts
//   within seconds, so a timer there may never fire: on phones the default
//   is to start at once. On desktops it is off by default: a machine left
//   running in a background tab (a build, a server used from another tab)
//   is the user's work, and stopping it would be the loss.
// - Only a machine worth keeping is suspended or asked about: one the user
//   has typed into, tapped or clicked since it booted (page chrome aside),
//   or a resumed one. A machine nobody touched boots again in about a
//   second, so saving 30 to 90 MiB for it would be waste.
// - The machine is given up only once its session is stored: the kernel
//   waits at its snapshot point while the page writes the session
//   (snapshot({ commit }), boot.ts), and is held (or stopped) only after
//   that transaction committed. A refusal before the copy (a task that does
//   not park, I/O in flight) leaves the machine running and is tried again while the tab
//   stays hidden, at most AUTO_SUSPEND_TRIES times. A save that fails (an
//   aborted IndexedDB transaction, a page frozen past the commit's timeout,
//   no room) leaves it running too (SuspendSaveError); it is tried again the
//   next time the tab is hidden, and after AUTO_SUSPEND_SAVE_FAILURES such
//   failures not again in this page load. Shown again before the snapshot
//   started, nothing happens; while it runs, it finishes and then goes on.
// - ?askleave=0 turns off the question on close (beforeunload): asked while
//   such a machine runs or is being saved (not while held: its session is
//   stored), never for the page's own reloads (allowLeave()). Browsers show
//   their own text, only after the user interacted with the page, and mostly
//   not on phones; nothing can be saved from inside it. A user who stays
//   (Cancel, Stay) may just want to go on working, so nothing happens by
//   itself: a small notification offers Pause for LEAVE_OFFER_MS.
// - Pause (Pause, by hand): the same save and hold as in the background,
//   with the tab shown. It stays paused until Continue (or a key typed into
//   a terminal), whether the tab is hidden and shown or not; the tab can be
//   closed meanwhile without a question, and the next load resumes it
//   quietly. After AUTO_SUSPEND_HOLD_MS paused the hold becomes a stop, as
//   in the background, and the page offers Resume.

/** The ?autosuspend= value that turns it off. */
export const AUTO_SUSPEND_OFF = "0";
/** The ?autosuspend= value that starts as soon as the tab is hidden. */
export const AUTO_SUSPEND_NOW = "now";
/** The Options choices besides a ?autosuspend= of other seconds: off, at once, 30 s, 5 min. */
export const AUTO_SUSPEND_CHOICES: readonly string[] = [AUTO_SUSPEND_OFF, AUTO_SUSPEND_NOW, "30", "300"];
/** A refused suspend is tried again this long after, while the tab stays hidden (hidden tabs run timers at most once a second). */
export const AUTO_SUSPEND_RETRY_MS = 1000;
/** Tries per hidden spell. */
export const AUTO_SUSPEND_TRIES = 3;
/** Failed saves (SuspendSaveError) after which it stays off for this page load. */
export const AUTO_SUSPEND_SAVE_FAILURES = 2;
/**
 * How long a machine stays held at its snapshot point in a hidden tab
 * before the hold becomes a stop (its session is stored already). Held, it
 * keeps all its memory (256 to 512 MiB and more), which makes a phone more
 * likely to kill the page; stopped, the tab is cheap and the next show
 * resumes it in about a second. A short switch to another app is far
 * shorter. Counted by the page's timers, which a frozen page does not run:
 * on iOS the page is usually frozen, then killed or shown again.
 */
export const AUTO_SUSPEND_HOLD_MS = 10 * 60 * 1000;

/** The default ?autosuspend=: at once on phones and tablets, off elsewhere. */
export const autoSuspendDefault = (mobile: boolean): string => (mobile ? AUTO_SUSPEND_NOW : AUTO_SUSPEND_OFF);

/**
 * A ?autosuspend= value: "0" (off), "now", or whole seconds (1 or more).
 * Returns the option's value (anything else: this device's default) and the
 * delay in seconds (null: off).
 */
export function parseAutoSuspend(v: string | null | undefined, mobile: boolean): { value: string; delayS: number | null } {
	const value = v === AUTO_SUSPEND_OFF || v === AUTO_SUSPEND_NOW || (v && /^[1-9]\d{0,5}$/.test(v)) ? v : autoSuspendDefault(mobile);
	return { value, delayS: value === AUTO_SUSPEND_OFF ? null : value === AUTO_SUSPEND_NOW ? 0 : Number(value) };
}

/** How an Options choice reads. */
export function autoSuspendLabel(value: string): string {
	if (value === AUTO_SUSPEND_OFF) return "Off";
	if (value === AUTO_SUSPEND_NOW) return "At once";
	const s = Number(value);
	return s % 60 === 0 ? `After ${s / 60} min` : `After ${s} s`;
}

/**
 * Free storage a suspended session needs before the page tries to suspend a
 * machine by itself: twice its usual size (kernel/parking.md: about 28 MiB
 * on one CPU, 35 on 2, 54 on 4, 90 on 8 for a 512 MiB machine; a busy page
 * cache adds to it). A save without room would only fail (the machine runs
 * on), after parking it and writing tens of MiB for nothing.
 */
export const sessionRoom = (cpus: number): number => 2 * (32 + 8 * Math.max(1, cpus)) * 1048576;

/** sessionStorage kw-resume (ui.ts) after the Resume button: the next load resumes. */
export const RESUME_BY_HAND = "1";
/** The same after a suspend in the background (also for a reload after the browser discarded the tab). */
export const RESUME_AUTO = "auto";
/** After Reboot (ui.ts): the next load boots fresh, whatever session is saved (resumeChoice()). */
export const RESUME_FRESH = "fresh";
/** What the last load asked of this one (sessionStorage kw-resume): null for a plain load. */
export type ResumeRequest = "auto" | "hand" | "fresh" | null;
/** What a kw-resume value asks of the load: "auto" (quietly), "hand" (as after the Resume button), "fresh" (after Reboot), or null (a plain load). */
export function resumeRequestKind(v: string | null | undefined): ResumeRequest {
	return v === RESUME_AUTO ? "auto" : v === RESUME_BY_HAND ? "hand" : v === RESUME_FRESH ? "fresh" : null;
}
/** The last load asked for the resume (the Resume button, a suspend in the background): no question, also on another CPU count. */
export const resumeAskedFor = (request: ResumeRequest): boolean => request === "auto" || request === "hand";
/**
 * A load starts quiet (boot.ts: the boot indicator says "Resuming" and the host's
 * boot lines are held back, so the first thing the terminal shows is the
 * screen as it was): every load that may resume, whether asked for or a
 * plain load (until it knows it can), the same way; not the load after
 * Reboot, nor with ?verbose=1, which shows every line. Each resume then
 * ends in the same toast, "Resumed the session suspended …".
 */
export const quietStart = (request: ResumeRequest, verbose: boolean): boolean => request !== "fresh" && !verbose;
/** What every resume of a saved session says, once the machine is back (boot.ts sayResumed()); `when`: "just now", "5 min ago", … */
export const resumedNote = (when: string): string => `Resumed the session suspended ${when}`;
/**
 * What a load does with a saved session it can resume as it is (its CPU
 * count, kernel, image and devices; boot.ts offerResume()): "resume" after
 * the Resume button or a suspend in the background, and on a plain load.
 * The load after Reboot boots fresh: "keep" without a data disk (the
 * session stays, and the next plain load resumes it), "ask" with one,
 * since that boot changes the disk, which makes the session useless.
 */
export function resumeChoice(request: ResumeRequest, dataDisk: boolean): "resume" | "keep" | "ask" {
	if (request !== "fresh") return "resume";
	return dataDisk ? "ask" : "keep";
}

/** The page's own reloads (Reboot, Resume, the fallbacks to one CPU, data disk import and reset) set this: no question then. */
let leaving = false;
export function allowLeave(): void { leaving = true; }
export const pageLeaving = (): boolean => leaving;

/** What the page knows when it decides. */
export interface SuspendFacts {
	/** The system runs (user space up, not stopped or suspended). */
	running: boolean;
	/** A Suspend (by hand or by itself) is saving now, or holds the machine. */
	suspending: boolean;
	/** The session is saved and the machine held at its snapshot point (in the background, or paused by hand): nothing to lose. */
	held?: boolean;
	/** Worth keeping: the user's input since boot, or a resumed session. */
	interacted: boolean;
	/** The tab is hidden. */
	hidden: boolean;
}

/** Ask before the page goes away (beforeunload)? */
export function wantLeavePrompt(f: SuspendFacts, o: { enabled: boolean; leaving: boolean }): boolean {
	return o.enabled && !o.leaving && f.interacted && !f.held && (f.running || f.suspending);
}

/**
 * Timers wait while Chrome and Safari ask on leaving, so one this long after
 * the question runs once the user stayed (or, briefly, while a navigation
 * commits). Firefox asks from its parent process: boot.ts also waits for the
 * page to have the focus again.
 */
export const LEAVE_STAYED_MS = 500;
/** After the user stayed, the notification that offers Pause shows this long (a key typed into a terminal dismisses it sooner). */
export const LEAVE_OFFER_MS = 9000;

/** Why the page does not suspend by itself now, or null. */
export function autoSuspendBlocker(f: SuspendFacts, delayS: number | null): string | null {
	if (delayS === null) return "off";
	if (!f.hidden) return "the tab is shown";
	if (f.held) return "paused";
	if (f.suspending) return "a suspend is in progress";
	if (!f.running) return "the system is not running";
	if (!f.interacted) return "nothing to keep: no input since it booted";
	return null;
}

/**
 * The session could not be stored after the snapshot (the commit failed or
 * timed out): the machine was not given up and runs on. Thrown by the
 * page's suspend (boot.ts).
 */
export class SuspendSaveError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SuspendSaveError";
	}
}

/** A reason not to suspend that trying again will not change (a kept session, too little storage, the tab shown again). */
export class AutoSuspendSkip extends Error {
	/** The tab was shown again before the snapshot started: not worth a message. */
	readonly cancelled: boolean;
	constructor(message: string, cancelled = false) {
		super(message);
		this.cancelled = cancelled;
	}
}

export interface AutoSuspendDeps {
	/** Seconds hidden before it starts (0: at once), or null: off. */
	delayS: number | null;
	facts(): SuspendFacts;
	/**
	 * Suspend (the snapshot, the session saved, then the kernel held, or
	 * stopped); rejects if it did not (SuspendSaveError: the save failed, the
	 * machine runs on). Resolves "held" once saved and held (the kernel waits
	 * at its snapshot point until continued or stopped), else it stopped.
	 */
	suspend(): Promise<"held" | "stopped" | void>;
	/** Reload and resume the saved session (ui.resume()). */
	resume(): void;
	/**
	 * End the hold: the machine goes on as it was, and the saved session is
	 * deleted. Resolves false if the machine is gone (the kernel or its worker
	 * ended meanwhile): its saved session then resumes instead.
	 */
	continue(): Promise<boolean>;
	/** The hold becomes a stop (the session stays saved; a show resumes it). */
	stopHeld(): Promise<void>;
	/** How long a hold lasts while hidden before it becomes a stop (ms), or null: as long as the page lives. */
	holdMs: number | null;
	/** A line for the Kernel log. */
	log(msg: string): void;
	/** It gave up while hidden, or was refused while shown (a toast once shown). */
	failed(msg: string): void;
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(t: unknown): void;
}

/**
 * The page's side: hidden() and shown() from visibilitychange, update()
 * when the system starts running, heldEnded() when the kernel ended while
 * held. States: idle, armed (the timer runs), saving, held (saved, the
 * kernel waits at its snapshot point: shown again, it goes on), releasing
 * (going on), done (saved and stopped: shown again, it resumes), off (too
 * many failed saves in this page load), stopped (the system ended: nothing
 * to do).
 */
export class AutoSuspend {
	state: "idle" | "armed" | "saving" | "held" | "releasing" | "done" | "off" | "stopped" = "idle";
	#d: AutoSuspendDeps;
	#timer: unknown = null;
	#tries = 0;
	/** Failed saves in this page load (SuspendSaveError). */
	#saveFailures = 0;
	/** This hidden spell has been decided (started, armed, refused for good or given up). */
	#settled = false;
	constructor(deps: AutoSuspendDeps) {
		this.#d = deps;
	}

	/**
	 * The tab was hidden. True when a suspend starts now (the caller then
	 * skips its sync: the snapshot seals the disks at a consistent point).
	 */
	hidden(): boolean {
		if (this.state !== "idle") return this.state === "saving";
		this.#settled = false;
		this.#tries = 0;
		return this.#consider();
	}

	/** The tab is shown again. */
	shown(): void {
		this.#cancelTimer();
		if (this.state === "armed") this.state = "idle";
		this.#settled = false;
		if (this.state === "held") this.#release();
		else if (this.state === "done") this.#d.resume();
	}

	/** The kernel ended while held (its worker died, the page stopped it): its saved session resumes when shown. */
	heldEnded(): void {
		if (this.state !== "held" && this.state !== "releasing") return;
		this.#cancelTimer();
		const releasing = this.state === "releasing";
		this.state = "done";
		this.#d.log("the held system ended; its saved session resumes when the tab is shown");
		if (!releasing && !this.#d.facts().hidden) this.#d.resume(); // (releasing: #release() resumes it)
	}

	/** Shown again while held: the machine goes on. */
	#release(): void {
		this.state = "releasing";
		const gone = (why: string) => {
			if (this.state !== "releasing" && this.state !== "done") return;
			this.state = "done";
			this.#d.log(`could not go on (${why}); resuming its saved session`);
			this.#d.resume();
		};
		this.#d.continue().then((ok) => {
			if (!ok) return gone("the system ended while held");
			this.state = "idle";
			// Hidden again meanwhile: a new hidden spell.
			if (this.#d.facts().hidden) { this.#settled = false; this.#tries = 0; this.#consider(); }
		}, (e: unknown) => gone((e as Error)?.message ?? String(e)));
	}

	/** Something changed (the system now runs): reconsider a hidden tab not decided yet. */
	update(): void {
		if (this.state === "idle" && !this.#settled && this.#d.facts().hidden) this.#consider();
	}

	#consider(): boolean {
		const why = autoSuspendBlocker(this.#d.facts(), this.#d.delayS);
		if (why) {
			// Not running: booting (update() reconsiders once it runs), or stopped or suspended already.
			if (why === "the system is not running") return false;
			if (why !== "off" && why !== "the tab is shown" && why !== "paused") this.#d.log(`not suspending: ${why}`);
			this.#settled = true;
			return false;
		}
		this.#settled = true;
		if (this.#d.delayS) {
			this.state = "armed";
			this.#d.log(`suspending after ${this.#d.delayS} s hidden`);
			this.#timer = this.#d.setTimeout(() => { this.#timer = null; this.#start(); }, this.#d.delayS * 1000);
			return false;
		}
		this.#start();
		return true;
	}

	#start(): void {
		const why = autoSuspendBlocker(this.#d.facts(), this.#d.delayS);
		if (why) {
			this.state = "idle";
			if (why !== "the tab is shown") this.#d.log(`not suspending: ${why}`);
			return;
		}
		this.state = "saving";
		this.#tries++;
		this.#d.suspend().then((how) => {
			if (how === "held" && this.state === "saving") {
				this.state = "held";
				this.#d.log("saved in the background and held; it goes on when the tab is shown");
				if (!this.#d.facts().hidden) { this.#release(); return; } // shown while it saved
				const ms = this.#d.holdMs;
				if (ms !== null) this.#timer = this.#d.setTimeout(() => {
					this.#timer = null;
					if (this.state !== "held") return;
					this.state = "done";
					this.#d.log(`held ${Math.round(ms / 60000)} min in the background: stopped to free its memory; it resumes when the tab is shown`);
					this.#d.stopHeld().catch((x: unknown) => this.#d.log(`stopping the held system failed: ${(x as Error)?.message ?? x}`));
				}, ms);
				return;
			}
			if (this.state === "done") return; // held, and it ended meanwhile (heldEnded())
			this.state = "done";
			this.#d.log("suspended in the background; it resumes when the tab is shown");
			if (!this.#d.facts().hidden) this.#d.resume(); // shown while it saved
		}, (e: unknown) => {
			const msg = (e as Error)?.message ?? String(e);
			const f = this.#d.facts();
			if (!f.running) { // the system ended meanwhile
				this.state = "stopped";
				this.#d.log(`the system ended while it was being suspended: ${msg}`);
				return;
			}
			this.state = "idle";
			if (e instanceof SuspendSaveError) { // not stored: the machine was kept and runs on
				this.#saveFailures++;
				if (this.#saveFailures >= AUTO_SUSPEND_SAVE_FAILURES) {
					this.state = "off";
					this.#d.log(`${msg}; off for this page load after ${this.#saveFailures} failed saves`);
					this.#d.failed(`Not suspended in the background: ${msg}. After ${this.#saveFailures} failed saves it is off until the page is loaded again`);
				} else {
					this.#d.log(`${msg}; tried again the next time the tab is hidden`);
					this.#d.failed(`Not suspended in the background: ${msg}`);
				}
				return;
			}
			if (e instanceof AutoSuspendSkip) {
				if (!e.cancelled) { this.#d.log(`not suspending: ${msg}`); this.#d.failed(`Not suspended in the background: ${msg}`); }
				return;
			}
			if (f.hidden && this.#tries < AUTO_SUSPEND_TRIES) {
				this.#d.log(`refused (${msg}); trying again in ${AUTO_SUSPEND_RETRY_MS} ms`);
				this.state = "armed";
				this.#timer = this.#d.setTimeout(() => { this.#timer = null; this.#start(); }, AUTO_SUSPEND_RETRY_MS);
				return;
			}
			this.#d.log(`refused (${msg})${f.hidden ? `; gave up after ${this.#tries} tries` : ""}; the system runs on`);
			this.#d.failed(`Not suspended in the background: ${msg}`);
		});
	}

	#cancelTimer(): void {
		if (this.#timer !== null) this.#d.clearTimeout(this.#timer);
		this.#timer = null;
	}
}

export interface PauseDeps {
	/**
	 * Save the session and hold the kernel at its snapshot point
	 * (KW.suspend({ hold: true }), which also sets kw-resume to "auto" once
	 * stored). Resolves "held", else it stopped; rejects if it did not save
	 * (the machine runs on).
	 */
	suspend(): Promise<"held" | "stopped" | void>;
	/** End the hold: the machine goes on and the saved session is deleted; false if the machine is gone. */
	continue(): Promise<boolean>;
	/** The hold becomes a stop (the session stays saved). */
	stopHeld(): Promise<void>;
	/** How long a pause lasts before it becomes a stop (ms), or null: as long as the page lives. */
	holdMs: number | null;
	/** The notice that says it is paused, with Continue (true), or none (false). */
	notice(paused: boolean): void;
	/** A line for the Kernel log. */
	log(msg: string): void;
	/** Not saved: why (the machine runs on). */
	failed(msg: string): void;
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(t: unknown): void;
}

/**
 * Pause by hand (the notification after the user stayed on the page): the
 * same save and hold as AutoSuspend's, with the tab shown. Unlike that hold,
 * showing or hiding the tab does not end it (boot.ts does not pass
 * visibilitychange here, and AutoSuspend leaves a held machine alone:
 * autoSuspendBlocker()): only continue() does (Continue, a key typed into a
 * terminal), or the stop after holdMs. States: idle, saving, paused,
 * releasing (going on), stopped (the hold became a stop, or the kernel ended
 * while paused: the session stays saved, and the page offers Resume).
 */
export class Pause {
	state: "idle" | "saving" | "paused" | "releasing" | "stopped" = "idle";
	#d: PauseDeps;
	#timer: unknown = null;
	constructor(deps: PauseDeps) {
		this.#d = deps;
	}

	/** Pause: save the session and hold the machine. */
	pause(): void {
		if (this.state !== "idle") return;
		this.state = "saving";
		this.#d.suspend().then((how) => {
			if (this.state !== "saving") return; // the kernel ended meanwhile (ended())
			if (how !== "held") { this.state = "stopped"; return; }
			this.state = "paused";
			this.#d.notice(true);
			this.#d.log("saved and held by hand; Continue goes on (closed meanwhile, the next load resumes it)");
			const ms = this.#d.holdMs;
			if (ms !== null) this.#timer = this.#d.setTimeout(() => {
				this.#timer = null;
				if (this.state !== "paused") return;
				this.state = "stopped";
				this.#d.notice(false);
				this.#d.log(`paused ${Math.round(ms / 60000)} min: stopped to free its memory; Resume restores it`);
				this.#d.stopHeld().catch((x: unknown) => this.#d.log(`stopping the paused system failed: ${(x as Error)?.message ?? x}`));
			}, ms);
		}, (e: unknown) => {
			if (this.state !== "saving") return;
			this.state = "idle";
			const msg = (e as Error)?.message ?? String(e);
			this.#d.log(`not paused: ${msg}`);
			this.#d.failed(msg);
		});
	}

	/** Continue: the machine goes on where it was, and its saved session is deleted. */
	continue(): void {
		if (this.state !== "paused") return;
		this.#cancelTimer();
		this.state = "releasing";
		this.#d.notice(false);
		const gone = (why: string) => {
			if (this.state !== "releasing") return;
			this.state = "stopped";
			this.#d.log(`could not go on (${why}); its saved session stays`);
		};
		this.#d.continue().then((ok) => {
			if (!ok) return gone("the system ended while paused");
			if (this.state === "releasing") this.state = "idle";
		}, (e: unknown) => gone((e as Error)?.message ?? String(e)));
	}

	/**
	 * The kernel ended while paused (the stop after holdMs, Suspend, its
	 * worker died) or while it saved or went on: true if this pause held it
	 * (the session stays saved; boot.ts then offers Resume).
	 */
	ended(): boolean {
		if (this.state === "idle" || this.state === "stopped") return this.state === "stopped";
		this.#cancelTimer();
		if (this.state === "paused") this.#d.notice(false);
		this.state = "stopped";
		return true;
	}

	#cancelTimer(): void {
		if (this.#timer !== null) this.#d.clearTimeout(this.#timer);
		this.#timer = null;
	}
}
