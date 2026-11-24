// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// WebSocket (RFC 6455) into the guest: websocketOver(connect, url, opts)
// opens one client connection over a byte stream to a server on the
// guest's 127.0.0.1:<port>, the same transport as fetchOver() (http.ts).
// The guest preview's WebSocket relay (web/src/preview.ts) runs on it.
//
// No extensions (permessage-deflate is not offered), no TLS. Messages are
// read only as the consumer pulls them, so vsock credit follows the reader;
// pings are answered while a message is read. Each frame goes out in one
// write, so pongs and close frames never land inside a data frame. A
// protocol error from the server fails the connection (close code 1006 to
// the caller, as browsers report it, after a close frame with the reason).

import { Input, latin1Bytes, readHead, type GuestConnect } from "./http.ts";

/** What websocketOver() takes besides the URL. */
export interface WebSocketOverOptions {
	/** Subprotocols to offer (Sec-WebSocket-Protocol). */
	protocols?: string | string[];
	/** More request headers (Origin, User-Agent, Cookie). The handshake's own are set by websocketOver(). */
	headers?: HeadersInit;
	/** Aborts the connect and the handshake (not an open connection: close() it). */
	signal?: AbortSignal;
	/** The largest message accepted, in bytes; a larger one fails the connection (1009). Default 64 MiB. */
	maxMessage?: number;
	/** How long close() waits for the server's close frame before it drops the connection, in ms. Default 5000. */
	closeTimeout?: number;
}

/** How a connection ended, as a browser's CloseEvent says it. */
export interface WebSocketClose {
	/** The server's close code; 1005 if its close frame had none, 1006 if it ended without one. */
	code: number;
	reason: string;
	/** Both close frames went through. */
	wasClean: boolean;
}

/** One open WebSocket connection to the guest. */
export interface GuestWebSocket {
	/** The subprotocol the server picked, or "". */
	readonly protocol: string;
	/** Always "": no extensions are offered. */
	readonly extensions: string;
	/** Text messages as strings, binary ones as bytes. Ends when the connection closes (never errors); cancelling it closes the connection. */
	readonly messages: ReadableStream<string | Uint8Array>;
	/** Send one message; resolves once its frame is written. Ignored once closing, as by browsers. */
	send(data: string | Uint8Array): Promise<void>;
	/** Start the closing handshake (code 1000 or 3000-4999; reason up to 123 UTF-8 bytes). */
	close(code?: number, reason?: string): void;
	/** Resolves once the connection is closed. */
	readonly closed: Promise<WebSocketClose>;
}

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/** Request headers websocketOver() sets itself, or that would break the handshake. */
const SKIP_REQUEST = new Set(["host", "connection", "upgrade", "content-length", "transfer-encoding", "keep-alive", "te",
	"sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol", "sec-websocket-extensions", "sec-websocket-accept"]);
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const OP_CONT = 0, OP_TEXT = 1, OP_BINARY = 2, OP_CLOSE = 8, OP_PING = 9, OP_PONG = 10;
const enc = new TextEncoder();
const noop = () => {};

const b64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b));

/** A close code an application may send (RFC 6455 7.4). */
export const sendableCloseCode = (code: number): boolean => code === 1000 || (code >= 3000 && code <= 4999);
/** A close code a peer may put in a close frame. */
const receivableCloseCode = (code: number): boolean =>
	(code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) || (code >= 3000 && code <= 4999);

/** A WebSocket handshake the server refused or got wrong. */
export class WebSocketHandshakeError extends Error {
	/** The response's status, or 0 if there was none. */
	readonly status: number;
	constructor(message: string, status = 0) {
		super(message);
		this.name = "WebSocketHandshakeError";
		this.status = status;
	}
}

/** The server broke the protocol: fail the connection with this close code. */
class Fail extends Error {
	readonly code: number;
	constructor(code: number, message: string) {
		super(message);
		this.code = code;
	}
}

/** One frame: masked (client to server), with the payload length in its smallest form. */
function frame(op: number, payload: Uint8Array): Uint8Array {
	const n = payload.length;
	const ext = n < 126 ? 0 : n < 65536 ? 2 : 8;
	const out = new Uint8Array(2 + ext + 4 + n);
	out[0] = 0x80 | op;
	if (ext === 0) out[1] = 0x80 | n;
	else if (ext === 2) {
		out[1] = 0x80 | 126;
		out[2] = n >> 8;
		out[3] = n & 255;
	} else {
		out[1] = 0x80 | 127;
		const v = new DataView(out.buffer);
		v.setUint32(2, Math.floor(n / 2 ** 32));
		v.setUint32(6, n >>> 0);
	}
	const key = out.subarray(2 + ext, 6 + ext);
	crypto.getRandomValues(key);
	const p = 6 + ext;
	for (let i = 0; i < n; i++) out[p + i] = payload[i]! ^ key[i & 3]!;
	return out;
}

function closePayload(code: number | undefined, reason: string): Uint8Array {
	if (code === undefined) return new Uint8Array(0);
	const r = enc.encode(reason);
	const out = new Uint8Array(2 + r.length);
	out[0] = code >> 8;
	out[1] = code & 255;
	out.set(r, 2);
	return out;
}

/**
 * Open a WebSocket to a server in the guest: always the guest's
 * 127.0.0.1:<port>, the URL's port (default 80). ws: or http: URLs (wss:
 * and https: are refused: no TLS). The hostname goes only into the Host
 * header. Rejects with a WebSocketHandshakeError if the server does not
 * switch protocols properly.
 */
export async function websocketOver(connect: GuestConnect, input: string | URL, opts: WebSocketOverOptions = {}): Promise<GuestWebSocket> {
	const url = new URL(input);
	if (url.protocol !== "ws:" && url.protocol !== "http:") throw new TypeError(`websocketOver: only ws: and http: URLs are supported, not ${url.protocol}`);
	if (url.hash) url.hash = "";
	const port = url.port ? Number(url.port) : 80;
	const protocols = opts.protocols === undefined ? [] : typeof opts.protocols === "string" ? [opts.protocols] : [...opts.protocols];
	for (const p of protocols) if (!TOKEN.test(p)) throw new SyntaxError(`websocketOver: invalid subprotocol ${JSON.stringify(p)}`);
	if (new Set(protocols).size !== protocols.length) throw new SyntaxError("websocketOver: a subprotocol is offered twice");
	const maxMessage = opts.maxMessage ?? 64 * 1024 * 1024;
	const closeTimeout = opts.closeTimeout ?? 5000;
	const signal = opts.signal;
	signal?.throwIfAborted();

	const keyBytes = crypto.getRandomValues(new Uint8Array(16));
	const key = b64(keyBytes);
	let head = `GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
		`Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n`;
	if (protocols.length) head += `Sec-WebSocket-Protocol: ${protocols.join(", ")}\r\n`;
	for (const [name, value] of new Headers(opts.headers)) if (!SKIP_REQUEST.has(name)) head += `${name}: ${value}\r\n`;
	head += "\r\n";
	const expected = b64(new Uint8Array(await crypto.subtle.digest("SHA-1", enc.encode(key + GUID))));

	const duplex = await connect(port, { signal });
	const writer = duplex.writable.getWriter();
	const reader = duplex.readable.getReader();
	const input$ = new Input(reader);
	const drop = (e?: unknown) => {
		writer.abort(e).catch(noop);
		reader.cancel(e).catch(noop);
	};
	const onAbort = () => drop(signal!.reason);
	signal?.addEventListener("abort", onAbort, { once: true });

	let protocol = "";
	try {
		await writer.write(latin1Bytes(head));
		const res = await readHead(input$).catch((e: Error) => { throw new WebSocketHandshakeError(`websocketOver: ${e.message.replace(/^fetchOver: /, "")}`); });
		signal?.throwIfAborted();
		const get = (n: string) => res.headers.filter(([k]) => k === n).map(([, v]) => v);
		const tokens = (n: string) => get(n).flatMap((v) => v.split(",")).map((t) => t.trim().toLowerCase()).filter(Boolean);
		if (res.status !== 101) throw new WebSocketHandshakeError(`websocketOver: the server answered ${res.status} ${res.statusText}`.trimEnd() + " instead of switching to WebSocket", res.status);
		if (!tokens("upgrade").includes("websocket")) throw new WebSocketHandshakeError("websocketOver: the 101 response has no Upgrade: websocket", 101);
		if (!tokens("connection").includes("upgrade")) throw new WebSocketHandshakeError("websocketOver: the 101 response has no Connection: upgrade", 101);
		if (get("sec-websocket-accept").join(",") !== expected) throw new WebSocketHandshakeError("websocketOver: wrong Sec-WebSocket-Accept", 101);
		if (tokens("sec-websocket-extensions").length) throw new WebSocketHandshakeError("websocketOver: the server picked an extension that was not offered", 101);
		const picked = get("sec-websocket-protocol").map((v) => v.trim());
		if (picked.length > 1 || (picked.length === 1 && !protocols.includes(picked[0]!))) throw new WebSocketHandshakeError(`websocketOver: the server picked a subprotocol that was not offered (${picked.join(", ")})`, 101);
		protocol = picked[0] ?? "";
	} catch (e) {
		drop(e);
		throw signal?.aborted ? signal.reason : e;
	} finally {
		signal?.removeEventListener("abort", onAbort);
	}

	// ---- open ----
	let state: "open" | "closing" | "closed" = "open";
	let resolveClosed!: (c: WebSocketClose) => void;
	const closed = new Promise<WebSocketClose>((r) => { resolveClosed = r; });
	let closeTimer: ReturnType<typeof setTimeout> | undefined;
	let ctrl: ReadableStreamDefaultController<string | Uint8Array> | null = null;
	let reading: Promise<string | Uint8Array | null> | null = null;
	const decoder = new TextDecoder("utf-8", { fatal: true });

	const write = (op: number, payload: Uint8Array) => writer.write(frame(op, payload));

	/** The connection is over: report it once and release both directions. */
	const finish = (c: WebSocketClose, clean: boolean) => {
		if (state === "closed") return;
		state = "closed";
		clearTimeout(closeTimer);
		if (clean) writer.close().catch(noop);
		else writer.abort().catch(noop);
		reader.cancel().catch(noop);
		try { ctrl?.close(); } catch { /* already closed */ }
		ctrl = null;
		resolveClosed(c);
	};
	const abnormal = () => finish({ code: 1006, reason: "", wasClean: false }, false);
	/** The server broke the protocol: a close frame saying why, then drop the connection. */
	const fail = (code: number, reason: string) => {
		if (state === "closed") return;
		if (state === "open") write(OP_CLOSE, closePayload(code, reason.slice(0, 120))).catch(noop);
		abnormal();
	};

	async function exact(n: number): Promise<Uint8Array> {
		if (input$.buffered >= n) return input$.take(n).slice();
		const out = new Uint8Array(n);
		let off = 0;
		while (off < n) {
			if (!input$.buffered && !(await input$.more())) throw new Fail(1006, "eof");
			const c = input$.take(n - off);
			out.set(c, off);
			off += c.length;
		}
		return out;
	}

	/** The next data message, or null once the connection is closed (control frames handled on the way). */
	async function readMessage(): Promise<string | Uint8Array | null> {
		let op = -1;
		let parts: Uint8Array[] = [];
		let size = 0;
		try {
			for (;;) {
				if (state === "closed") return null;
				const h = await exact(2);
				const b0 = h[0]!, b1 = h[1]!;
				const fin = (b0 & 0x80) !== 0;
				const opcode = b0 & 0x0f;
				if (b0 & 0x70) throw new Fail(1002, "reserved bits set");
				if (b1 & 0x80) throw new Fail(1002, "a masked frame from the server");
				let len = b1 & 0x7f;
				if (len === 126) {
					const e = await exact(2);
					len = (e[0]! << 8) | e[1]!;
				} else if (len === 127) {
					const e = new DataView((await exact(8)).buffer);
					const hi = e.getUint32(0);
					if (hi > 0x1fffff) throw new Fail(1009, "frame too large");
					len = hi * 2 ** 32 + e.getUint32(4);
				}
				if (opcode >= 8) {
					if (!fin || len > 125) throw new Fail(1002, "a fragmented or long control frame");
					const p = await exact(len);
					if (opcode === OP_PING) {
						if (state === "open") await write(OP_PONG, p).catch(noop);
					} else if (opcode === OP_CLOSE) {
						if (len === 1) throw new Fail(1002, "a close frame of one byte");
						const code = len >= 2 ? (p[0]! << 8) | p[1]! : 1005;
						if (len >= 2 && !receivableCloseCode(code)) throw new Fail(1002, "an invalid close code");
						let reason: string;
						try { reason = decoder.decode(p.subarray(2)); } catch { throw new Fail(1007, "a close reason that is not UTF-8"); }
						// Echo it (unless ours went first), then the server closes.
						if (state === "open") await write(OP_CLOSE, len >= 2 ? p.subarray(0, 2) : p).catch(noop);
						finish({ code, reason, wasClean: true }, true);
						return null;
					} else if (opcode !== OP_PONG) throw new Fail(1002, `unknown opcode ${opcode}`);
					continue;
				}
				if (opcode === OP_CONT) {
					if (op < 0) throw new Fail(1002, "a continuation frame with no message");
				} else if (opcode === OP_TEXT || opcode === OP_BINARY) {
					if (op >= 0) throw new Fail(1002, "a new message inside a fragmented one");
					op = opcode;
				} else throw new Fail(1002, `unknown opcode ${opcode}`);
				size += len;
				if (size > maxMessage) throw new Fail(1009, "message too large");
				if (len) parts.push(await exact(len));
				if (!fin) continue;
				const data = parts.length === 1 ? parts[0]! : new Uint8Array(size);
				if (parts.length !== 1) {
					let off = 0;
					for (const p of parts) { data.set(p, off); off += p.length; }
				}
				const kind = op;
				op = -1;
				parts = [];
				size = 0;
				if (state !== "open") continue; // closing: data is dropped, as by browsers
				if (kind === OP_BINARY) return data;
				try { return decoder.decode(data); } catch { throw new Fail(1007, "a text message that is not UTF-8"); }
			}
		} catch (e) {
			if (e instanceof Fail && e.code !== 1006) fail(e.code, e.message);
			else abnormal(); // EOF, a reset, a malformed frame length
			return null;
		}
	}

	/** One reader at a time: a pull and close()'s drain share it. */
	const next = (): Promise<string | Uint8Array | null> => {
		reading ??= readMessage().finally(() => { reading = null; });
		return reading;
	};

	const messages = new ReadableStream<string | Uint8Array>({
		start(c) { ctrl = c; },
		async pull(c) {
			const m = await next();
			if (m === null) { try { c.close(); } catch { /* closed by finish() */ } return; }
			c.enqueue(m);
		},
		cancel() {
			ctrl = null;
			ws.close();
		},
	}, { highWaterMark: 0 });

	const ws: GuestWebSocket = {
		protocol,
		extensions: "",
		messages,
		closed,
		send(data) {
			if (state !== "open") return Promise.resolve();
			const bytes = typeof data === "string" ? enc.encode(data) : data;
			return write(typeof data === "string" ? OP_TEXT : OP_BINARY, bytes).catch(() => { abnormal(); });
		},
		close(code, reason = "") {
			if (code !== undefined && !sendableCloseCode(code)) throw new RangeError(`websocketOver: close code ${code} is not 1000 or 3000-4999`);
			if (enc.encode(reason).length > 123) throw new SyntaxError("websocketOver: close reason over 123 bytes");
			if (state !== "open") return;
			state = "closing";
			write(OP_CLOSE, closePayload(code ?? (reason ? 1000 : undefined), reason)).catch(noop);
			closeTimer = setTimeout(abnormal, closeTimeout);
			// Read on (dropping data) until the server's close frame, whether or not anyone pulls.
			void (async () => { while ((await next()) !== null) { /* dropped */ } })();
		},
	};
	return ws;
}
