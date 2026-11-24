<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<!-- Copyright (C) 2026 Pooya Parsa <pooya@pi0.io> -->

# vtest bridge and page

Carries vtest clients (Mesa's virgl driver, `GALLIUM_DRIVER=virpipe`,
socket named by `VTEST_SOCKET_NAME`) to a renderer that runs in a web page.

```
Mesa -> unix socket -> vtest-bridge bridge -> WebSocket -> page -> renderer
wasm renderer: virglrenderer compiled to wasm (gl/wasm) on the page's WebGL2 context
relay renderer (the stand-in): page -> WebSocket -> vtest-bridge helper
                                    -> unix socket -> virgl_test_server
the stream link (the guest's, over kwvsock):
Mesa -> unix socket -> vtest-bridge bridge --link vsock:2:PORT -> byte stream
     -> StreamHost (js/core/gl-stream.ts) -> renderer
```

| File | What |
| --- | --- |
| `vtest-bridge.c` | `bridge` mode: the vtest socket, fd termination, and the link to the far side: the page's WebSocket (and serves the page), or with `--link unix:PATH` or `vsock:CID:PORT` a byte stream it connects to; `helper` mode: the relay's far end against a real server |
| `build-guest.sh` | the guest's build: static aarch64-linux-musl, stream link only (`-DVTEST_BRIDGE_STREAM_ONLY`: no WebSocket, no helper, libc only); the same build ships in the base's kw layer as `kwbox vtest`, linked into the layer's one program with the other guest tools (`guest/base/build.sh`, `guest/src/kwbox.c`), which the SDK's `gl` option starts |
| `index.html`, `main.js` | the page: connects back to the bridge, hosts one renderer: `?renderer=wasm` (the default; `./virgl.mjs` next to the page, or `?module=URL`) or `relay`; `?glcheck=1` logs every WebGL call that raises an error, `?glcount=1` the calls made most often |
| `mux.js` | the WebSocket framing and a WebSocketStream wrapper |
| `relay.js` | the stand-in renderer |

`test/gl/bridge-check.sh` builds and starts all of it and runs
`test/gl/vtest-check.sh --socket` through it, with `--wasm` against the wasm
renderer (the module from `vendor/build/gl-wasm` served next to the page),
else against the relay. `test/gl/stream-check.sh`
does the same through the stream link (a unix socket,
`test/gl/stream-relay.js` with the relay renderer at its far end), with
`--guest` through the guest's build under qemu-aarch64. The stream link's
far end is the SDK's `StreamHost` (`js/core/gl-stream.ts`:
`StreamHost.serve(readable, writable)` drives a renderer from a bridge's
stream given as web streams, a vsock connection in the SDK), and
`test/gl/unkernel-check.mjs` runs the whole path in unkernel.

## No file descriptors: the inline dialect

vtest from protocol version 2 on hands the client a memfd per resource
(`VCMD_RESOURCE_CREATE2` with `data_size > 0`, `VCMD_RESOURCE_CREATE_BLOB`,
by `SCM_RIGHTS` with one byte), and `TRANSFER_PUT2`/`TRANSFER_GET2` then name
an offset in it instead of carrying data. An fd does not cross a WebSocket,
so the bridge terminates them: it creates the memfd itself, passes it to
Mesa after the create reply, and copies the bytes into and out of the
stream. What goes over the WebSocket, and what the renderer in the page
speaks, is this dialect: **vtest protocol version 3 as virglrenderer 1.3.0's
`vtest/vtest_renderer.c` implements it, multi-client, with these changes**:

1. `VCMD_PROTOCOL_VERSION`: the bridge clamps the client's version to 3; the
   renderer answers 3. Anything else and the bridge drops the client.
2. Create replies carry no fd and no fd byte: `RESOURCE_CREATE2` answers
   `[1, 12, res_id]`, `RESOURCE_CREATE_BLOB` answers `[1, 18, res_id]`. The
   renderer keeps each resource's backing (`data_size` bytes) in its own
   memory, where vtest has its memfd mapping.
3. `TRANSFER_PUT2` carries its data: length `10 + ceil(data_size / 4)`
   dwords, the 10 argument dwords, then `data_size` bytes padded with zeros
   to a multiple of 4. The bytes are `[offset, offset + data_size)` of the
   client's backing; the renderer writes them to its backing at `offset`,
   then transfers as `vtest_transfer_put2` does. (Mesa's own header already
   counts that data but does not send it.)
4. `TRANSFER_GET2` (unchanged, 10 dwords) gets a reply, which vtest does not
   have: `[ceil(data_size / 4), 13]`, then `[offset, offset + data_size)` of
   the renderer's backing after the transfer, padded to 4. It comes in order,
   before the reply to the client's next request (Mesa follows with a
   `RESOURCE_BUSY_WAIT` and reads its memfd after that reply).
5. The `GET_CAPS2` reply (length = bytes + 1, as in vtest) loses
   `VIRGL_CAP_TRANSFER`, `VIRGL_CAP_COPY_TRANSFER` and
   `VIRGL_CAP_ARB_BUFFER_STORAGE` from `capability_bits` (byte 392 of the caps)
   in the bridge. Without the first, Mesa does not encode transfers in the
   command stream, where the host would read the memfd during `SUBMIT_CMD`,
   and so does no staging copies either (Mesa `virgl_context.c`,
   `encoded_transfers`, `supports_staging`); without the last, it maps no
   buffers persistent or coherent and so creates no blobs (`virgl_screen.c`,
   `buffer_map_persistent_coherent`). Mesa then touches the memfd only around
   `TRANSFER_PUT2` and `TRANSFER_GET2`, which is where the bridge copies. A
   renderer without shared memory may as well clear them itself.
6. Not carried: `TRANSFER_GET`/`TRANSFER_PUT` (version 0, raw inline data)
   and commands 19 to 38 (syncs, `SUBMIT_CMD2`, DRM syncobjs, fd export), which
   pass fds. Mesa's vtest winsys sends none of them (`supports_fences = 0`).
   The bridge drops a client that does.

Everything else is vtest version 3 byte for byte: `CREATE_RENDERER` (length
in bytes), `PING_PROTOCOL_VERSION`, `RESOURCE_BUSY_WAIT`, `GET_CAPS`,
`GET_CAPS2`, `RESOURCE_CREATE` (with its version 3 reply), `RESOURCE_UNREF`,
`SUBMIT_CMD`, `GET_PARAM`, `GET_CAPSET`, `CONTEXT_INIT`.

Why not hold the client at version 0, which transfers inline and needs no
fds: there the client picks resource handles (Mesa counts from 1 in every
process), they are virglrenderer's global resource ids and the command
stream names them, so two clients collide in one renderer. vtest refuses
versions below 3 with `--multi-clients` for that reason; the page has one
renderer for every client.

The guest needs the same termination to carry vtest over kwvsock: it runs
the same bridge with the stream link (Stream framing).

## WebSocket framing

The page connects to the bridge at `ws://HOST:PORT/` (the server it was
loaded from) and the relay to the helper. Every message is binary:

```
u32 client id (little-endian) | u8 type | payload
```

| Type | Direction | Payload |
| --- | --- | --- |
| 1 OPEN | bridge -> page, page -> helper | none: a new client |
| 2 DATA | both | the client's bytes in the dialect, any chunking, in order |
| 3 CLOSE | both | none: the client is gone (from the bridge), or the renderer dropped it (from the page) |
| 4 READY | page -> bridge, id 0 | none: the renderer is up; the bridge creates its vtest socket now |
| 5 LOG | page -> bridge, id 0 | UTF-8 text the bridge prints |

The bridge sends each client's requests as they parse, in messages of at
most 1 MiB. Ids are never reused. The vtest socket exists only while a page
is connected and ready; a page that goes away takes its clients with it.

Back pressure: the page reads the bridge through WebSocketStream, which
leaves a message on the socket until the page asks for it, and it does not
ask while the renderer reports itself busy; the bridge stops reading Mesa
clients while it has more than 32 MiB queued for the page. The reply
direction is never held up, so this cannot deadlock. `?transport=websocket`
uses plain WebSocket (no back pressure on receive).

## Stream framing

With `--link`, the bridge connects to `unix:PATH` or `vsock:CID:PORT` (in
the guest: the host, CID 2) and sends the same messages over that one byte
stream, each after its length:

```
u32 length (little-endian, 5 + payload) | u32 client id | u8 type | payload
```

Types, ids, chunking and READY are as on the WebSocket: the far side sends
READY (id 0) when its renderer is up, and only then does the bridge create
its vtest socket (default `/tmp/.virgl_test`, Mesa's default
`VTEST_SOCKET_NAME`; mode 0666, so that any user's clients connect). The
bridge sends its own log lines the other way as LOG messages (id 0), among
them `ready: vtest clients on PATH` once the socket exists, which the SDK
waits for. One bridge per vtest socket: it holds an abstract unix socket
named after it, and another bridge for the same path exits (with
`--daemon`, which forks into a session of its own with stdio on
/dev/null once it holds that lock, with 0, so starting it twice is
harmless). A length below 5 or above 512 MiB ends the link. The
bridge connects again every second until it can, and again a second after
the link closes, which takes its clients with it. Back pressure is the
stream's own: the bridge stops reading Mesa clients while it has more than
32 MiB queued for the link, and `StreamHost` stops reading the stream while
the renderer is busy, so the stream's flow control (vsock credit) holds the
bridge. `StreamHost` maps each stream's client ids to its own, so one
renderer serves several streams.

## The renderer in the page

`main.js` hosts one renderer object of this shape; `relay.js` is the first.

```js
renderer.init(): Promise<string>     // once, before any client; resolves with a description
renderer.open(id)                    // a new client
renderer.feed(id, bytes: Uint8Array) // the client's bytes, any chunking, in order;
                                     // may return a promise: busy, feed no more until it settles
renderer.close(id)                   // the client is gone: free its context and resources
renderer.onreply = (id, bytes) => {} // set by the page: reply bytes, in order
renderer.onclose = (id, why) => {}   // set by the page: the renderer dropped the client
```

A renderer may also have `stats(id)`, `{ parks, parkedMs }`, which the page
logs when the client closes, and `totals()`, counters over all its clients
(the wasm renderer's are `KW_VIRGL_STAT_*` in `gl/wasm/kw_virgl.h`), which
the page logs with it and the SDK passes on in `vm.gl.stats.renderer`.

The wasm renderer is `Module.virgl.Renderer` (`gl/wasm/post.js`) over the
module's C API (`gl/wasm/kw_virgl.h`): `kw_virgl_open(KW_VIRGL_INLINE)` per
client, `kw_virgl_feed` with each chunk (it buffers partial commands and runs
the complete ones; it never blocks and never returns a promise), then the
reply bytes (`kw_virgl_reply_ptr`, `kw_virgl_reply_len`,
`kw_virgl_consume`). A waiting `RESOURCE_BUSY_WAIT` is answered at once
right after a readback of its resource, or ahead of its fences when the
client's previous answer ahead has retired or been followed by a readback
(`.agents/gl.md`, Busy waits); otherwise it parks its client
(`KW_VIRGL_PARKED`): a WebGL fence only signals between tasks, so the
renderer calls `kw_virgl_poll` from later tasks (a message for the first 16
rounds, then 1 ms timeouts) and passes the reply on once the fences it
waits for have retired. `?wait=strict` (the page; `bridge-check.sh
--strict-waits`) parks every waiting busy wait until the fences submitted
before it have retired, as vtest answers it.
