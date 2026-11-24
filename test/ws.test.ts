// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Unit tests for the WebSocket client (core/ws.ts) without a kernel: its
// GuestConnect dials a local TCP server, and each test plays the guest's
// server frame by frame.
//
//   node --test test/ws.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, connect as tcpConnect, type Server, type Socket } from "node:net";
import { Duplex } from "node:stream";
import type { GuestConnect } from "../js/core/http.ts";
import { WebSocketHandshakeError, websocketOver, type GuestWebSocket } from "../js/core/ws.ts";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** The server's side of one connection, read on demand. */
class Peer {
	readonly socket: Socket;
	#buf = Buffer.alloc(0);
	#wake: (() => void) | null = null;
	ended = false;

	constructor(socket: Socket) {
		this.socket = socket;
		socket.on("data", (c: Buffer) => { this.#buf = Buffer.concat([this.#buf, c]); this.#poke(); });
		socket.on("end", () => { this.ended = true; this.#poke(); });
		socket.on("close", () => { this.ended = true; this.#poke(); });
		socket.on("error", () => {});
	}

	#poke() { const w = this.#wake; this.#wake = null; w?.(); }

	async #need(n: number): Promise<boolean> {
		while (this.#buf.length < n) {
			if (this.ended) return false;
			await new Promise<void>((r) => { this.#wake = r; });
		}
		return true;
	}

	/** The request head; returns its lines. */
	async head(): Promise<{ line: string; headers: Map<string, string> }> {
		for (;;) {
			const i = this.#buf.indexOf("\r\n\r\n");
			if (i >= 0) {
				const lines = this.#buf.subarray(0, i).toString("latin1").split("\r\n");
				this.#buf = this.#buf.subarray(i + 4);
				const headers = new Map<string, string>();
				for (const l of lines.slice(1)) {
					const c = l.indexOf(":");
					headers.set(l.slice(0, c).toLowerCase(), l.slice(c + 1).trim());
				}
				return { line: lines[0]!, headers };
			}
			if (!(await this.#need(this.#buf.length + 1))) throw new Error("EOF in head");
		}
	}

	/** Answer the handshake. */
	accept(key: string, extra = "") {
		const a = createHash("sha1").update(key + GUID).digest("base64");
		this.socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${a}\r\n${extra}\r\n`);
	}

	/** The next client frame (unmasked), or null at EOF; asserts it is masked. */
	async frame(): Promise<{ fin: boolean; op: number; payload: Buffer } | null> {
		if (!(await this.#need(2))) return null;
		const b0 = this.#buf[0]!, b1 = this.#buf[1]!;
		assert.ok(b1 & 0x80, "client frames are masked");
		let len = b1 & 127, off = 2;
		if (len === 126) { await this.#need(4); len = this.#buf.readUInt16BE(2); off = 4; }
		else if (len === 127) { await this.#need(10); len = Number(this.#buf.readBigUInt64BE(2)); off = 10; }
		if (!(await this.#need(off + 4 + len))) return null;
		const mask = this.#buf.subarray(off, off + 4);
		const payload = Buffer.from(this.#buf.subarray(off + 4, off + 4 + len));
		for (let i = 0; i < len; i++) payload[i] = payload[i]! ^ mask[i & 3]!;
		this.#buf = this.#buf.subarray(off + 4 + len);
		return { fin: (b0 & 0x80) !== 0, op: b0 & 15, payload };
	}

	/** Send a server frame (unmasked unless asked). */
	send(op: number, payload: Uint8Array | string = new Uint8Array(0), { fin = true, mask = false, rsv = 0 } = {}) {
		const p = typeof payload === "string" ? Buffer.from(payload) : Buffer.from(payload);
		const n = p.length;
		const h = n < 126 ? Buffer.from([0, n]) : n < 65536 ? Buffer.from([0, 126, n >> 8, n & 255]) : Buffer.alloc(10);
		if (n >= 65536) { h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
		h[0] = (fin ? 0x80 : 0) | rsv | op;
		if (mask) { h[1] = h[1]! | 0x80; this.socket.write(Buffer.concat([h, Buffer.alloc(4), p])); }
		else this.socket.write(Buffer.concat([h, p]));
	}

	close(code: number, reason = "") {
		const p = Buffer.alloc(2 + Buffer.byteLength(reason));
		p.writeUInt16BE(code);
		p.write(reason, 2);
		this.send(8, p);
	}
}

/** A server whose connections go to `serve`, and a GuestConnect that dials it whatever the port. */
async function setup(serve: (peer: Peer) => Promise<void> | void): Promise<{ connect: GuestConnect; ports: number[]; done: Promise<void>; server: Server }> {
	let resolveDone!: () => void, rejectDone!: (e: unknown) => void;
	const done = new Promise<void>((res, rej) => { resolveDone = res; rejectDone = rej; });
	const server = createServer((s) => { Promise.resolve(serve(new Peer(s))).then(resolveDone, rejectDone); });
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const at = (server.address() as { port: number }).port;
	const ports: number[] = [];
	const connect: GuestConnect = async (port) => {
		ports.push(port);
		const s = tcpConnect(at, "127.0.0.1");
		await new Promise<void>((r, j) => { s.once("connect", r); s.once("error", j); });
		return Duplex.toWeb(s) as unknown as { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };
	};
	return { connect, ports, done, server };
}

async function read(ws: GuestWebSocket): Promise<string | Uint8Array | undefined> {
	const r = ws.messages.getReader();
	try { return (await r.read()).value; } finally { r.releaseLock(); }
}

test("handshake headers, text and binary both ways, fragments with a ping between", async () => {
	let req!: { line: string; headers: Map<string, string> };
	const { connect, ports, done, server } = await setup(async (p) => {
		req = await p.head();
		p.accept(req.headers.get("sec-websocket-key")!, "Sec-WebSocket-Protocol: b\r\n");
		const f1 = await p.frame();
		assert.deepEqual([f1!.op, f1!.payload.toString()], [1, "héllo"]);
		const f2 = await p.frame();
		assert.deepEqual([f2!.op, [...f2!.payload]], [2, [1, 2, 3]]);
		p.send(1, "frag", { fin: false });
		p.send(9, "pp");
		p.send(0, "mented ✓");
		const pong = await p.frame();
		assert.deepEqual([pong!.op, pong!.payload.toString()], [10, "pp"]);
		p.send(2, new Uint8Array([9, 8]));
		const big = await p.frame();
		assert.equal(big!.payload.length, 200_000);
		p.send(2, big!.payload);
		p.close(1000, "done");
		const echo = await p.frame();
		assert.deepEqual([echo!.op, echo!.payload.readUInt16BE()], [8, 1000]);
	});
	const ws = await websocketOver(connect, "ws://localhost:5173/path?token=x#frag", {
		protocols: ["a", "b"], headers: { origin: "http://localhost:5173", upgrade: "nope", "Sec-WebSocket-Key": "nope" },
	});
	assert.deepEqual(ports, [5173]);
	assert.equal(req.line, "GET /path?token=x HTTP/1.1");
	assert.equal(req.headers.get("host"), "localhost:5173");
	assert.equal(req.headers.get("upgrade"), "websocket");
	assert.equal(req.headers.get("sec-websocket-version"), "13");
	assert.equal(req.headers.get("sec-websocket-protocol"), "a, b");
	assert.equal(req.headers.get("origin"), "http://localhost:5173");
	assert.notEqual(req.headers.get("sec-websocket-key"), "nope");
	assert.equal(ws.protocol, "b");
	await ws.send("héllo");
	await ws.send(new Uint8Array([1, 2, 3]));
	assert.equal(await read(ws), "fragmented ✓");
	assert.deepEqual(await read(ws), new Uint8Array([9, 8]));
	const big = new Uint8Array(200_000).map((_, i) => i & 255);
	await ws.send(big);
	assert.deepEqual(await read(ws), big);
	assert.equal(await read(ws), undefined); // the close ends the stream
	assert.deepEqual(await ws.closed, { code: 1000, reason: "done", wasClean: true });
	await done;
	server.close();
});

test("close() from the client: close frame, the server's answer, a clean close", async () => {
	const { connect, done, server } = await setup(async (p) => {
		const r = await p.head();
		p.accept(r.headers.get("sec-websocket-key")!);
		p.send(1, "dropped after close"); // arrives while closing
		const f = await p.frame();
		assert.equal(f!.op, 8);
		assert.equal(f!.payload.readUInt16BE(), 4001);
		assert.equal(f!.payload.subarray(2).toString(), "bye");
		p.close(4001, "ok");
		p.socket.end();
	});
	const ws = await websocketOver(connect, "ws://localhost/");
	assert.throws(() => ws.close(1001), RangeError);
	ws.close(4001, "bye");
	await ws.send("ignored");
	assert.deepEqual(await ws.closed, { code: 4001, reason: "ok", wasClean: true });
	assert.equal(await read(ws), undefined);
	await done;
	server.close();
});

test("close() with no answer: 1006 after the timeout", async () => {
	const { connect, server } = await setup(async (p) => {
		const r = await p.head();
		p.accept(r.headers.get("sec-websocket-key")!);
	});
	const ws = await websocketOver(connect, "ws://localhost/", { closeTimeout: 100 });
	ws.close();
	assert.deepEqual(await ws.closed, { code: 1006, reason: "", wasClean: false });
	server.close();
});

test("EOF without a close frame: 1006", async () => {
	const { connect, server } = await setup(async (p) => {
		const r = await p.head();
		p.accept(r.headers.get("sec-websocket-key")!);
		p.send(1, "last");
		p.socket.end();
	});
	const ws = await websocketOver(connect, "ws://localhost/");
	assert.equal(await read(ws), "last");
	assert.equal(await read(ws), undefined);
	assert.deepEqual(await ws.closed, { code: 1006, reason: "", wasClean: false });
	server.close();
});

for (const [name, answer, status] of [
	["a 404", (_k: string) => "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n", 404],
	["a wrong accept", (_k: string) => "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: AAAA\r\n\r\n", 101],
	["a subprotocol not offered", (k: string) => `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${createHash("sha1").update(k + GUID).digest("base64")}\r\nSec-WebSocket-Protocol: zz\r\n\r\n`, 101],
	["an extension not offered", (k: string) => `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${createHash("sha1").update(k + GUID).digest("base64")}\r\nSec-WebSocket-Extensions: permessage-deflate\r\n\r\n`, 101],
] as const) {
	test(`handshake refused: ${name}`, async () => {
		const { connect, server } = await setup(async (p) => {
			const r = await p.head();
			p.socket.write(answer(r.headers.get("sec-websocket-key")!));
		});
		await assert.rejects(websocketOver(connect, "ws://localhost/", { protocols: "a" }), (e: unknown) => e instanceof WebSocketHandshakeError && e.status === status);
		server.close();
	});
}

test("bad arguments", async () => {
	const connect: GuestConnect = () => { throw new Error("not reached"); };
	await assert.rejects(websocketOver(connect, "wss://localhost/"), TypeError);
	await assert.rejects(websocketOver(connect, "ws://localhost/", { protocols: ["a b"] }), SyntaxError);
	await assert.rejects(websocketOver(connect, "ws://localhost/", { protocols: ["a", "a"] }), SyntaxError);
	await assert.rejects(websocketOver(connect, "ws://localhost/", { signal: AbortSignal.abort() }));
});

for (const [name, play, code] of [
	["a masked server frame", (p: Peer) => p.send(1, "x", { mask: true }), 1002],
	["reserved bits", (p: Peer) => p.send(1, "x", { rsv: 0x40 }), 1002],
	["text that is not UTF-8", (p: Peer) => p.send(1, new Uint8Array([0xff, 0xfe])), 1007],
	["a message over maxMessage", (p: Peer) => p.send(2, new Uint8Array(2000)), 1009],
	["a continuation with no message", (p: Peer) => p.send(0, "x"), 1002],
	["an unknown opcode", (p: Peer) => p.send(3, "x"), 1002],
] as const) {
	test(`protocol error: ${name} fails with close ${code}, reported as 1006`, async () => {
		let sent = -1;
		const { connect, done, server } = await setup(async (p) => {
			const r = await p.head();
			p.accept(r.headers.get("sec-websocket-key")!);
			play(p);
			const f = await p.frame();
			sent = f && f.op === 8 ? f.payload.readUInt16BE() : -1;
		});
		const ws = await websocketOver(connect, "ws://localhost/", { maxMessage: 1000 });
		assert.equal(await read(ws), undefined);
		assert.deepEqual(await ws.closed, { code: 1006, reason: "", wasClean: false });
		await done;
		assert.equal(sent, code);
		server.close();
	});
}

test("cancelling messages closes the connection", async () => {
	const { connect, done, server } = await setup(async (p) => {
		const r = await p.head();
		p.accept(r.headers.get("sec-websocket-key")!);
		const f = await p.frame();
		assert.equal(f!.op, 8);
		p.close(1000);
	});
	const ws = await websocketOver(connect, "ws://localhost/");
	await ws.messages.cancel();
	assert.deepEqual(await ws.closed, { code: 1000, reason: "", wasClean: true });
	await done;
	server.close();
});
