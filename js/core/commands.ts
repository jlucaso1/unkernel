// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Host commands: functions of the host that the guest runs as programs:
// createKernel({ commands }) and vm.addCommand(). The reverse of kwtty
// (tty.ts), where the host runs a guest program.
//
//   const vm = await createKernel({ commands: {
//     hello: (c) => `hello ${c.args.join(" ")} from the host\n`,
//     upper: async (c) => { await c.stdin.pipeThrough(upperCase()).pipeTo(c.stdout); },
//   } });
//   await vm.exec("sh", ["-c", "hello world | upper"]);   // spawn() and exec() wait for the commands
//
// In the guest each command is a link /run/kw/bin/NAME to kwbox, which runs
// kwcmd under any name but its own (guest/src/kwcmd.c, kwbox.c; the
// directory is first on PATH), made by `kwbox cmd sync NAME...`, which
// this runs through kwtty whenever the commands change. A guest process
// that runs NAME is kwcmd under that name: a normal process
// with its own pid, arguments, stdio and exit status, which connects to
// vsock port 1020 here and relays. The handler runs on the thread that owns
// the VM (inline and in worker mode alike), once per guest process.
//
// Wire format: kwtty's frames (u8 type, u8 flags, u16 length, payload;
// little-endian). Guest -> host: ARG (10: one argument, the name first),
// ENV (11: KEY=VALUE), then START (1: u16 version, u16 ttys (bit 0 stdin, 1
// stdout, 2 stderr), u16 rows, cols, u32 pid, uid, gid, the working
// directory), DATA (2: stdin) or EOF (7: stdin ended), one per STDIN. Host
// -> guest: STDIN (9: read stdin once), DATA (2: stdout), STDERR (8),
// EXIT (4: u8 how (0 exit, 1 signal), u8 status, a signal's name without
// "SIG"), ERROR (5: a message; the guest exits 127). kwcmd
// catches no signal: when the guest process is killed the connection ends,
// and the handler's `signal` aborts. A change goes in kwcmd.c too.

import { guestRun, KWBOX, noKwbox } from "./mounts.ts";
import { PtyError, TTY_FLAG_CRITICAL, TTY_SIGNALS, TtyFrameParser, encodeTtyFrame, type ExecResult } from "./tty.ts";
import type { Vsock, VsockConnection, VsockListener } from "./vsock.ts";
import { errorText } from "./output.ts";

/** The host port kwcmd connects to (guest/src/kwcmd.c KWCMD_PORT). */
export const CMD_PORT = 1020;
/** The protocol version this host speaks. */
export const CMD_VERSION = 1;

const CMD_START = 1;
const CMD_DATA = 2;
const CMD_EXIT = 4;
const CMD_ERROR = 5;
const CMD_EOF = 7;
const CMD_STDERR = 8;
const CMD_STDIN = 9;
const CMD_ARG = 10;
const CMD_ENV = 11;
const START_SIZE = 20;
/** The most the host puts in one DATA or STDERR frame. */
const MAX_WRITE = 16384;
const BOOT_TIMEOUT_MS = 120000;
const DEFAULT_TIMEOUT_MS = 30000;

/** What a host command gets: the guest process that runs it. */
export interface HostCommandContext {
	/** The name the command was run by. */
	readonly name: string;
	/** Its arguments, without the name. */
	readonly args: readonly string[];
	/** The guest process's environment. */
	readonly env: Readonly<Record<string, string>>;
	/** The guest process's working directory. */
	readonly cwd: string;
	/** The guest process: its pid, and the user and group it runs as. */
	readonly pid: number;
	readonly uid: number;
	readonly gid: number;
	/** Which of the guest process's stdin, stdout and stderr are terminals. */
	readonly isTTY: { readonly stdin: boolean; readonly stdout: boolean; readonly stderr: boolean };
	/** The terminal's size when the command started (0 without a terminal). */
	readonly cols: number;
	readonly rows: number;
	/**
	 * The guest process's stdin. A pull stream: the guest reads its stdin
	 * once for each read here (up to 16 KiB), so a command leaves alone what
	 * it does not read (a terminal's typeahead, the rest of a pipe). It ends
	 * at end of file, or when the guest process is gone.
	 */
	readonly stdin: ReadableStream<Uint8Array>;
	/**
	 * The guest process's stdout and stderr; strings are UTF-8. A write
	 * resolves once the guest took it, and rejects when the guest process
	 * is gone. What was written when the handler returns is still sent.
	 */
	readonly stdout: WritableStream<Uint8Array | string>;
	readonly stderr: WritableStream<Uint8Array | string>;
	/** Aborts when the guest process is gone before the handler returned (killed, Ctrl-C, a closed pipe, the kernel exited). */
	readonly signal: AbortSignal;
}

/** What a host command returns (see HostCommand). */
export type HostCommandResult = number | string | Uint8Array | { exitCode?: number; signal?: string } | void;

/**
 * A host command: called once per guest process that runs it. What it
 * returns ends that process: a number (or { exitCode }) is its exit
 * status (0 to 255), a string or bytes are written to its stdout (status
 * 0), nothing is status 0, and { signal } ("SIGTERM" or "TERM", one of
 * TTY_SIGNALS) makes it die by that signal, as its parent then sees
 * (a shell's $? is 128 + the number). A throw (or rejection) prints the
 * error's message on its stderr and exits 1.
 */
export type HostCommand = (ctx: HostCommandContext) => HostCommandResult | Promise<HostCommandResult>;

export type CommandErrorCode =
	/** The instance has no vsock device. */
	| "ENODEV"
	/** The guest has no kwbox (a base from before it). */
	| "ENOENT"
	/** A name that is not a command name, or a handler that is not a function. */
	| "EINVAL"
	/** vsock port 1020 is taken by another listener of the host. */
	| "EADDRINUSE"
	/** The guest did not finish within the timeout (no kwtty answered). */
	| "ETIMEDOUT"
	/** The kernel exited. */
	| "ECONNABORTED"
	/** The guest failed otherwise (the message has its words). */
	| "EREMOTE";

export class CommandError extends Error {
	readonly code: CommandErrorCode;
	constructor(code: CommandErrorCode, message: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "CommandError";
		this.code = code;
	}
}

/** createKernel's `commands`: names to handlers. */
export type CommandsOption = Record<string, HostCommand>;

/** @internal A command's name (kwcmd.c valid_name()): a file name of letters, digits and ". _ + -", not starting with "." or "-", at most 64 bytes, not "kwcmd" or "kwbox" (the guest runs those names itself). */
export function checkCommandName(name: string): string {
	if (typeof name !== "string" || !/^[A-Za-z0-9_+][A-Za-z0-9._+-]{0,63}$/.test(name) || name === "kwcmd" || name === "kwbox")
		throw new CommandError("EINVAL", `command name ${JSON.stringify(name)}: 1 to 64 letters, digits, ".", "_", "+" or "-", not starting with "." or "-", and not "kwcmd" or "kwbox"`);
	return name;
}

/** @internal createKernel's `commands`, checked before boot. */
export function parseCommands(commands: CommandsOption | undefined, vsock: boolean): Array<[string, HostCommand]> {
	const list = Object.entries(commands ?? {});
	for (const [name, fn] of list) {
		checkCommandName(name);
		if (typeof fn !== "function") throw new CommandError("EINVAL", `command ${name}: the handler is not a function`);
	}
	if (list.length && !vsock) throw new CommandError("ENODEV", "createKernel({ commands }) needs the vsock device (kwcmd and kwtty run over it); it was turned off (vsock: false)");
	return list;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** One guest process running a command: read START, call the handler, relay, send EXIT. */
async function serve(conn: VsockConnection, commands: ReadonlyMap<string, HostCommand>, log: (msg: string) => void): Promise<void> {
	const reader = conn.readable.getReader();
	const writer = conn.writable.getWriter();
	const parser = new TtyFrameParser();
	const dec = new TextDecoder();
	const enc = new TextEncoder();
	let gone = false;
	/** Every frame goes out through here, in call order. */
	let tail: Promise<void> = Promise.resolve();
	const send = (frame: Uint8Array): Promise<void> => {
		const p = tail.then(() => writer.write(frame));
		tail = p.catch(() => {});
		return p;
	};
	/** The next frame, or undefined once the connection ended. */
	const next = async () => {
		for (;;) {
			const f = parser.next();
			if (f) return f;
			let r: ReadableStreamReadResult<Uint8Array>;
			try {
				r = await reader.read();
			} catch {
				return undefined;
			}
			if (r.done) return undefined;
			parser.push(r.value);
		}
	};

	const argv: string[] = [];
	const env: Record<string, string> = {};
	let start: Uint8Array | undefined;
	for (let f = await next(); f; f = await next()) {
		if (f.type === CMD_ARG) argv.push(dec.decode(f.payload));
		else if (f.type === CMD_ENV) {
			const kv = dec.decode(f.payload);
			const eq = kv.indexOf("=");
			if (eq > 0) env[kv.slice(0, eq)] = kv.slice(eq + 1);
		} else if (f.type === CMD_START) {
			start = f.payload;
			break;
		} else if (f.flags & TTY_FLAG_CRITICAL) break;
	}
	const refuse = async (msg: string) => {
		await send(encodeTtyFrame(CMD_ERROR, enc.encode(msg))).catch(() => {});
		conn.close();
	};
	if (!start || start.length < START_SIZE || !argv.length) {
		conn.reset();
		return;
	}
	const dv = new DataView(start.buffer, start.byteOffset, start.length);
	const version = dv.getUint16(0, true);
	if (version < 1) return refuse("kwcmd speaks no protocol version of this host");
	const name = argv[0]!;
	const handler = commands.get(name);
	if (!handler) return refuse("the host does not provide this command");
	const ttys = dv.getUint16(2, true);

	const ac = new AbortController();
	void conn.closed.then(() => {
		gone = true;
		ac.abort(new Error(`${name}: the guest process is gone`));
	});
	let ended = false;
	const stdin = new ReadableStream<Uint8Array>({
		pull: async (c) => {
			if (!ended) send(encodeTtyFrame(CMD_STDIN)).catch(() => {});
			while (!ended) {
				const f = await next();
				if (!f || f.type === CMD_EOF) ended = true;
				else if (f.type === CMD_DATA && f.payload.length) {
					c.enqueue(f.payload);
					return;
				}
			}
			c.close();
		},
	}, { highWaterMark: 0 });
	const output = (type: number) => new WritableStream<Uint8Array | string>({
		write: (chunk) => {
			const bytes = typeof chunk === "string" ? enc.encode(chunk) : chunk;
			if (gone) throw new Error(`${name}: the guest process is gone`);
			let last: Promise<void> = Promise.resolve();
			for (let i = 0; i < bytes.length; i += MAX_WRITE) last = send(encodeTtyFrame(type, bytes.subarray(i, i + MAX_WRITE)));
			return last;
		},
	});
	const stdout = output(CMD_DATA), stderr = output(CMD_STDERR);
	const ctx: HostCommandContext = {
		name, args: argv.slice(1), env, cwd: dec.decode(start.subarray(START_SIZE)) || "/",
		pid: dv.getUint32(8, true), uid: dv.getUint32(12, true), gid: dv.getUint32(16, true),
		isTTY: { stdin: !!(ttys & 1), stdout: !!(ttys & 2), stderr: !!(ttys & 4) },
		rows: dv.getUint16(4, true), cols: dv.getUint16(6, true),
		stdin, stdout, stderr, signal: ac.signal,
	};

	const direct = (type: number, data: Uint8Array | string) => {
		const bytes = typeof data === "string" ? enc.encode(data) : data;
		for (let i = 0; i < bytes.length; i += MAX_WRITE) send(encodeTtyFrame(type, bytes.subarray(i, i + MAX_WRITE))).catch(() => {});
	};
	let code = 0, signal = "";
	try {
		const r = await handler(ctx);
		if (typeof r === "number") code = r & 0xff;
		else if (r && typeof r === "object" && !(r instanceof Uint8Array)) {
			if (r.signal !== undefined) {
				const sig = String(r.signal).replace(/^SIG/, "");
				if (!(TTY_SIGNALS as readonly string[]).includes(sig)) throw new RangeError(`unknown signal ${JSON.stringify(r.signal)}`);
				signal = sig;
			} else code = (r.exitCode ?? 0) & 0xff;
		} else if (typeof r === "string" || r instanceof Uint8Array) {
			// Behind what the handler wrote to the streams without waiting.
			await drain();
			direct(CMD_DATA, r);
		}
	} catch (e) {
		code = 1;
		if (!gone) {
			await drain();
			direct(CMD_STDERR, `${name}: ${(e as Error)?.message ?? e}\n`);
			log(`[host] command ${name} failed: ${errorText(e)}`);
		}
	}
	await drain();
	await send(encodeTtyFrame(CMD_EXIT, signal ? Uint8Array.of(1, 0, ...enc.encode(signal)) : Uint8Array.of(0, code))).catch(() => {});
	conn.close();

	/**
	 * Everything written to stdout and stderr so far is sent: a stream
	 * hands its sink one chunk at a time, so after the frames in flight
	 * went out, give the streams a turn to hand over what they still hold.
	 */
	async function drain(): Promise<void> {
		for (;;) {
			const t = tail;
			await t;
			await tick();
			if (t === tail || gone) return;
		}
	}
}

/** @internal The host commands of one instance (KernelInstance and WorkerKernel each have one). */
export class CommandTable {
	#vsock: Vsock | undefined;
	#log: (msg: string) => void;
	#commands = new Map<string, HostCommand>();
	#listener: VsockListener | undefined;
	/** The guest's links are made to match #commands, one `kwbox cmd sync` at a time. */
	#syncing: Promise<void> = Promise.resolve();
	/** createKernel's commands while their first sync runs: rejects if it failed. */
	#boot: Promise<void> | undefined;
	#down = false;

	constructor(vsock: Vsock | undefined, log: (msg: string) => void) {
		this.#vsock = vsock;
		this.#log = log;
	}

	get commands(): ReadonlyMap<string, HostCommand> {
		return this.#commands;
	}

	/** Run fn once createKernel's commands are linked in the guest; rejects with the CommandError if that failed (spawn() and exec() go through here). */
	gate<T>(fn: () => Promise<T>): Promise<T> {
		return this.#boot ? this.#boot.then(fn) : fn();
	}

	/** createKernel's `commands` (already checked), once the kernel runs. */
	addAll(list: Array<[string, HostCommand]>): void {
		if (!list.length) return;
		const boot = (async () => {
			this.#listen();
			for (const [name, fn] of list) this.#commands.set(name, fn);
			await this.#sync(BOOT_TIMEOUT_MS);
		})().finally(() => {
			if (this.#boot === boot) this.#boot = undefined;
		});
		boot.catch((e) => this.#log(`[host] ${(e as Error)?.message ?? e}`)); // also given to the spawn() and exec() calls that waited
		this.#boot = boot;
	}

	async add(name: string, handler: HostCommand, opts: { timeout?: number } = {}): Promise<void> {
		checkCommandName(name);
		if (typeof handler !== "function") throw new CommandError("EINVAL", `command ${name}: the handler is not a function`);
		this.#listen();
		const had = this.#commands.get(name);
		this.#commands.set(name, handler);
		if (had) return; // the guest has the link already
		try {
			await this.#sync(opts.timeout ?? DEFAULT_TIMEOUT_MS);
		} catch (e) {
			if (this.#commands.get(name) === handler) this.#commands.delete(name);
			throw e;
		}
	}

	async remove(name: string, opts: { timeout?: number } = {}): Promise<void> {
		if (!this.#commands.delete(name) || this.#down) return;
		await this.#sync(opts.timeout ?? DEFAULT_TIMEOUT_MS);
	}

	#listen(): void {
		const vsock = this.#vsock;
		if (!vsock) throw new CommandError("ENODEV", "host commands need the vsock device, which this instance has not: it was created with vsock: false");
		if (this.#down) throw new CommandError("ECONNABORTED", "the kernel exited");
		if (this.#listener) return;
		try {
			this.#listener = vsock.listen(CMD_PORT, (conn) => {
				serve(conn, this.#commands, this.#log).catch((e) => {
					this.#log(`[host] host command: ${errorText(e)}`);
					conn.reset();
				});
			});
		} catch (e) {
			throw new CommandError("EADDRINUSE", `cannot serve host commands on vsock port ${CMD_PORT}: ${(e as Error)?.message ?? e}`, e);
		}
	}

	/** Make the guest's links match #commands as they are when this sync's turn comes. */
	#sync(timeout: number): Promise<void> {
		const run = this.#syncing.then(async () => {
			const vsock = this.#vsock!;
			if (this.#down) throw new CommandError("ECONNABORTED", "the kernel exited");
			let r: ExecResult<string>;
			try {
				r = await guestRun(vsock, KWBOX, ["cmd", "sync", ...this.#commands.keys()], timeout);
			} catch (e) {
				const code = e instanceof PtyError ? e.code : "";
				const msg = (e as Error)?.message ?? String(e);
				if (this.#down || code === "ECONNABORTED" || code === "ECONNRESET") throw new CommandError("ECONNABORTED", "host commands: the kernel exited", e);
				if (code === "ETIMEDOUT") throw new CommandError("ETIMEDOUT", `host commands: ${/killed/.test(msg) ? msg : `no answer from the guest's kwtty within ${timeout} ms (an image without kwtty, or still booting?)`}`, e);
				if (code === "EREMOTE" && noKwbox(msg)) throw new CommandError("ENOENT", `host commands: the guest has no ${KWBOX} (a base from before kwbox)`, e);
				throw new CommandError("EREMOTE", `host commands: ${msg}`, e);
			}
			if (r.exitCode !== 0) {
				// kwcmd's last line is "kwcmd: what: text (errno N)".
				const text = (r.stderr || r.stdout).trim().split("\n").pop() ?? "";
				throw new CommandError("EREMOTE", `host commands: ${text.replace(/^kwcmd: /, "").replace(/\s*\(errno \d+\)\s*$/, "") || `kwbox cmd sync exited with ${r.exitCode ?? `signal ${r.signal}`}`}`);
			}
		});
		this.#syncing = run.catch(() => {});
		return run;
	}

	/** The kernel exited. */
	shutdown(): void {
		if (this.#down) return;
		this.#down = true;
		this.#listener?.close();
		this.#commands.clear();
	}
}
