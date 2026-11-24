// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// WebSockets for the guest preview, the page's side. A WebSocket never
// reaches the service worker, so preview documents get the shim
// public/vm-ws.js (vm-sw.js puts it in), whose WebSocket asks this page
// over the BroadcastChannel "kw-vm-<vmId>"; the message format is at the
// top of vm-ws.js. Each socket is websocketOver() (js/core/ws.ts) over
// vm.connect() to the guest's 127.0.0.1:<port>.
//
// The guest's messages go out only while the document has credits (it
// acks each one it delivered), so a slow document holds the guest back
// through vsock credit instead of growing a queue here. Web Locks tell
// each side when the other is gone: the document holds "kw-ws-<id>" while
// its socket lives, this page "kw-vm-<vmId>" for as long as it runs.
import type { ByteDuplex } from "../../js/core/http.ts";
import { websocketOver, type GuestWebSocket } from "../../js/core/ws.ts";

/** What the relay needs of the kernel handle: the SDK's vm.connect(). */
export interface GuestConnector {
	connect(port: number, opts?: { signal?: AbortSignal }): Promise<ByteDuplex>;
}

/** Sockets open at once over all preview documents: each is a guest connection and often a server process. */
const MAX_SOCKETS = 32;
/** Messages sent ahead of the document's acks. */
const CREDITS = 16;
/** The guest's server must finish the handshake within this. */
const HANDSHAKE_MS = 30_000;

interface Sock {
	readonly abort: AbortController;
	ws: GuestWebSocket | null;
	credits: number;
	wake: (() => void) | null;
	/** The document is gone or closed it before it opened: nothing more goes to it. */
	dropped: boolean;
}

type FromDoc =
	| { t: "ws-open"; id: string; port: number; path: string; protocols: string[] }
	| { t: "ws-send"; id: string; data: string | ArrayBuffer }
	| { t: "ws-ack"; id: string }
	| { t: "ws-close"; id: string; code?: number; reason?: string };

let chan: BroadcastChannel | null = null;
let getVm: () => GuestConnector | null = () => null;
const socks = new Map<string, Sock>();

const post = (m: object) => { try { chan?.postMessage(m); } catch { /* closed */ } };
const wake = (s: Sock) => { const w = s.wake; s.wake = null; w?.(); };

/** Answer the preview documents' WebSockets for this vmId (once per page; preview.ts). */
export function serveWebSockets(vmId: string, handle: () => GuestConnector | null): void {
	getVm = handle;
	if (chan || typeof BroadcastChannel !== "function") return;
	chan = new BroadcastChannel(`kw-vm-${vmId}`);
	chan.onmessage = (e: MessageEvent<FromDoc | null>) => onDoc(e.data);
	// Held as long as this page runs: documents waiting for it learn that it is gone.
	navigator.locks?.request(`kw-vm-${vmId}`, () => new Promise<never>(() => {})).catch(() => {});
}

/** The kernel stopped: every socket ends (1006 to the documents). */
export function closeWebSockets(): void {
	for (const [id, s] of socks) {
		post({ t: "ws-closed", id, code: 1006, reason: "", wasClean: false });
		drop(s);
	}
	socks.clear();
}

/** The document no longer listens: end the guest side. */
function drop(s: Sock) {
	if (s.dropped) return;
	s.dropped = true;
	wake(s);
	if (s.ws) s.ws.close();
	else s.abort.abort();
}

function onDoc(d: FromDoc | null) {
	if (!d || typeof d.id !== "string") return;
	const s = socks.get(d.id);
	switch (d.t) {
		case "ws-open":
			if (!s) void open(d);
			break;
		case "ws-send":
			if (!s?.ws) break;
			if (typeof d.data === "string") void s.ws.send(d.data).then(() => post({ t: "ws-sent", id: d.id, n: new TextEncoder().encode(d.data as string).length }));
			else if (d.data instanceof ArrayBuffer) { const n = d.data.byteLength; void s.ws.send(new Uint8Array(d.data)).then(() => post({ t: "ws-sent", id: d.id, n })); }
			break;
		case "ws-ack":
			if (s) { s.credits++; wake(s); }
			break;
		case "ws-close":
			if (!s) break;
			if (s.ws && d.code !== undefined && !s.dropped) {
				try { s.ws.close(d.code, d.reason ?? ""); } catch { s.ws.close(); }
			} else if (s.ws && !s.dropped) s.ws.close();
			else drop(s); // before it opened: the document already reported the failure
			break;
	}
}

async function open(d: Extract<FromDoc, { t: "ws-open" }>) {
	const { id } = d;
	const vm = getVm();
	const fail = (message: string) => post({ t: "ws-error", id, message });
	if (!Number.isInteger(d.port) || d.port < 1 || d.port > 65535 || typeof d.path !== "string" || !d.path.startsWith("/")) return fail("a bad WebSocket request");
	if (!vm || typeof vm.connect !== "function") return fail("the kernel is not running: reboot it, then reload the preview");
	if (socks.size >= MAX_SOCKETS) return fail(`too many WebSockets into the guest (at most ${MAX_SOCKETS} at once)`);
	const s: Sock = { abort: new AbortController(), ws: null, credits: CREDITS, wake: null, dropped: false };
	socks.set(id, s);
	post({ t: "ws-accept", id });
	// Granted once the document lets go of it: it closed the socket, or it is gone.
	navigator.locks?.request(`kw-ws-${id}`, () => drop(s)).catch(() => {});

	const guest = `http://localhost:${d.port}`;
	let ws: GuestWebSocket;
	try {
		ws = await websocketOver((port, o) => vm.connect(port, o), `ws://localhost:${d.port}${d.path}`, {
			protocols: Array.isArray(d.protocols) ? d.protocols.map(String) : [],
			headers: { origin: guest }, // as the guest's server sees itself (origin checks)
			signal: AbortSignal.any([s.abort.signal, AbortSignal.timeout(HANDSHAKE_MS)]),
		});
	} catch (e) {
		socks.delete(id);
		if (!s.dropped) fail(`${(e as Error)?.message ?? e}`.replace(/^websocketOver: /, "") + ` (the guest's port ${d.port})`);
		return;
	}
	if (s.dropped) { ws.close(); socks.delete(id); return; }
	s.ws = ws;
	post({ t: "ws-opened", id, protocol: ws.protocol });

	const reader = ws.messages.getReader();
	try {
		for (;;) {
			while (s.credits <= 0 && !s.dropped) await new Promise<void>((r) => { s.wake = r; });
			if (s.dropped) break;
			const { done, value } = await reader.read();
			if (done) break;
			s.credits--;
			const data = typeof value === "string" ? value
				: value.byteOffset === 0 && value.byteLength === value.buffer.byteLength ? value.buffer : value.slice().buffer;
			post({ t: "ws-msg", id, data });
		}
	} catch { /* the stream does not error; a closed one ends the loop */ }
	const c = await ws.closed;
	if (socks.get(id) === s) socks.delete(id);
	if (!s.dropped) post({ t: "ws-closed", id, ...c });
}
