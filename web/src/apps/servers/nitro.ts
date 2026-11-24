// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Nitro: a standalone Nitro v3 server (the `runtime` template of
// `nitro create`: no build step) with its routes as plain ES modules (.mjs)
// and nitro as its only dependency, installed by `bun install` and served
// by `nitro dev` under Bun (`bun --bun`, so the nitro bin's node shebang
// does not pick Node) on port 3000. Nothing to install first: `bun` is the
// kw layer's shim on every distro (guest/base, /usr/lib/kw/shim), which
// fetches Bun on first use.
//
// The app is the scaffold minus its devDependencies (@types/node and
// typescript, for editors only), plus two routes (api/runtime, the guest's
// numbers, and api/echo, a POST) and a page that calls them. The page's
// URLs are relative, since the preview serves it under /vm/<id>/3000/; it
// polls api/runtime with fetch, as the preview relays plain HTTP only.
// `nitro dev` listens on 0.0.0.0 (the guest has no IPv6) and picks up
// edited routes.
import type { TerminalApp } from "../types.ts";

const PACKAGE = `{
  "name": "nitro-app",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "nitro dev",
    "start": "nitro start"
  },
  "dependencies": {
    "nitro": "^3.0.261103-rc"
  }
}
`;

const CONFIG = `import { defineConfig } from "nitro";

export default defineConfig({
  serverDir: "./server",
  builder: false,
});
`;

const TSCONFIG = `{
  "extends": "nitro/tsconfig"
}
`;

const GITIGNORE = `node_modules
dist
.data
.output
.env
.env.local
`;

const HELLO = `import { defineHandler } from "nitro";

export default defineHandler(() => {
  return { message: "Hello from Nitro!" };
});
`;

const RUNTIME = `import os from "node:os";
import { defineHandler } from "nitro";

// The guest's own numbers: Bun on aarch64 Linux, compiled to WebAssembly.
export default defineHandler(() => {
  return {
    runtime: typeof Bun === "undefined" ? "Node " + process.version : "Bun " + Bun.version,
    platform: process.platform,
    arch: os.arch(),
    kernel: os.type() + " " + os.release(),
    hostname: os.hostname(),
    uptime: Math.round(process.uptime()),
    memory: Math.round(process.memoryUsage().rss / 1048576) + " MiB rss",
  };
});
`;

const ECHO = `import { defineHandler } from "nitro";

// POST /api/echo: the method suffix in the file name picks the method.
export default defineHandler(async (event) => {
  const body = await event.req.text();
  let json;
  try {
    json = JSON.parse(body);
  } catch {}
  return {
    method: event.req.method,
    path: event.url.pathname,
    contentType: event.req.headers.get("content-type"),
    body: json ?? body,
    receivedAt: new Date().toISOString(),
  };
});
`;

// Minimal and monochrome, light or dark with the system: hairline borders,
// a sticky top bar with a status dot, the guest's numbers in one row.
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nitro in unkernel</title>
<style>
	:root { color-scheme: dark; --bg: #000; --fg: #ededed; --dim: #a1a1a1; --faint: #707070; --line: #242424; --card: #0a0a0a; --soft: #141414; --ok: #3ecf8e; --err: #ff6166; }
	@media (prefers-color-scheme: light) {
		:root { color-scheme: light; --bg: #fafafa; --fg: #171717; --dim: #5f5f5f; --faint: #8f8f8f; --line: #e8e8e8; --card: #fff; --soft: #f2f2f2; --ok: #12a150; --err: #e5484d; }
	}
	* { box-sizing: border-box; }
	html { -webkit-font-smoothing: antialiased; }
	body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.5 Geist, Inter, system-ui, -apple-system, "Segoe UI", sans-serif; }
	code, pre, .mono { font-family: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }

	nav { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: .65rem; height: 3.5rem; padding: 0 1rem; border-bottom: 1px solid var(--line); background: color-mix(in srgb, var(--bg) 85%, transparent); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); }
	nav svg { flex: none; width: 1.3rem; height: 1.3rem; }
	nav .slash { color: var(--line); font-size: 1.4rem; font-weight: 300; }
	nav .name { font-weight: 500; }
	.tag { padding: .05rem .45rem; border: 1px solid var(--line); border-radius: 99px; font-size: 12px; color: var(--dim); }
	.live { display: inline-flex; align-items: center; gap: .45rem; margin-left: auto; font-size: 13px; color: var(--dim); white-space: nowrap; }
	.live i { width: .5rem; height: .5rem; border-radius: 50%; background: var(--faint); }
	.live.ok i { background: var(--ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 22%, transparent); }
	.live.bad i { background: var(--err); }

	main { max-width: 64rem; margin: 0 auto; padding: 3.5rem 1rem 4rem; }
	h1 { margin: 0; font-size: clamp(1.75rem, 5vw, 2.5rem); font-weight: 600; letter-spacing: -.045em; line-height: 1.15; }
	.lead { margin: .75rem 0 0; max-width: 38rem; color: var(--dim); font-size: 15px; }
	#who { margin-top: 1.25rem; color: var(--faint); font-size: 12px; overflow-wrap: anywhere; }

	.card { border: 1px solid var(--line); border-radius: 12px; background: var(--card); overflow: hidden; min-width: 0; }
	.stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); margin: 2.5rem 0 1.5rem; }
	.stats div { padding: 1rem 1.25rem; border-left: 1px solid var(--line); }
	.stats div:first-child { border-left: 0; }
	.stats span { display: block; font-size: 12px; color: var(--dim); }
	.stats b { display: block; margin-top: .35rem; font: 500 15px/1.3 "Geist Mono", ui-monospace, monospace; overflow-wrap: anywhere; }
	@media (max-width: 40rem) {
		.stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
		.stats div:nth-child(3) { border-left: 0; }
		.stats div:nth-child(n+3) { border-top: 1px solid var(--line); }
	}

	.cols { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap: 1.5rem; align-items: start; }
	@media (max-width: 52rem) { .cols { grid-template-columns: minmax(0, 1fr); } }
	.head { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; padding: .85rem 1.25rem; border-bottom: 1px solid var(--line); }
	h2 { margin: 0; font-size: 14px; font-weight: 600; letter-spacing: -.01em; }
	.head small { color: var(--faint); font: 12px "Geist Mono", ui-monospace, monospace; }

	.route { display: flex; align-items: center; gap: 1rem; padding: .7rem 1.25rem; border-bottom: 1px solid var(--line); transition: background .15s; }
	.route:hover { background: var(--soft); }
	.route .m { flex: none; width: 2.5rem; font: 500 12px "Geist Mono", ui-monospace, monospace; color: var(--dim); }
	.route .p { flex: 1; min-width: 0; }
	.route .p b { display: block; font: 500 13px "Geist Mono", ui-monospace, monospace; }
	.route .p small { color: var(--faint); font-size: 12px; overflow-wrap: anywhere; }
	.payload { padding: .9rem 1.25rem; border-bottom: 1px solid var(--line); }

	button { flex: none; height: 2rem; padding: 0 .85rem; border: 1px solid var(--line); border-radius: 6px; background: var(--card); color: var(--fg); font: inherit; font-size: 13px; font-weight: 500; line-height: 1; cursor: pointer; transition: background .15s, border-color .15s; }
	button:hover { background: var(--soft); border-color: var(--faint); }
	button:focus-visible, textarea:focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; }
	textarea { display: block; width: 100%; min-width: 0; max-width: 100%; margin: 0; min-height: 4.25rem; padding: .55rem .7rem; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--fg); font: 13px "Geist Mono", ui-monospace, monospace; resize: vertical; }

	.bar { display: flex; justify-content: space-between; gap: 1rem; padding: .6rem 1.25rem; border-bottom: 1px solid var(--line); background: var(--soft); font-size: 12px; color: var(--dim); }
	.bar .ok { color: var(--ok); }
	.bar .bad { color: var(--err); }
	#out { margin: 0; padding: 1rem 1.25rem; min-height: 9rem; max-height: 20rem; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--dim); }

	.tree { margin: 0; padding: 1rem 1.25rem; color: var(--faint); line-height: 1.8; overflow-x: auto; }
	.tree b { color: var(--fg); font-weight: 400; }
	.note { margin: 0; padding: 1rem 1.25rem; border-top: 1px solid var(--line); color: var(--dim); }
	code { padding: .05rem .3rem; border: 1px solid var(--line); border-radius: 4px; background: var(--soft); color: var(--fg); font-size: 12px; }

	footer { margin-top: 3rem; padding-top: 1.5rem; border-top: 1px solid var(--line); color: var(--faint); font-size: 13px; }
	footer p { margin: 0; }
</style>
</head>
<body>
<nav>
	<svg viewBox="0 0 40 40" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M35.2166 7.02016C28.0478 -1.38317 15.4241 -2.38397 7.02077 4.78481C-1.38256 11.9536 -2.38336 24.5773 4.78542 32.9806C11.9542 41.3839 24.5779 42.3847 32.9812 35.216C41.3846 28.0472 42.3854 15.4235 35.2166 7.02016ZM25.2525 17.5175C26.0233 17.5175 26.5155 18.3527 26.1287 19.0194L26.0175 19.2111L18.4696 31.6294C18.3293 31.8602 18.0788 32.001 17.8088 32.001H17.0883C16.5946 32.001 16.2336 31.5349 16.3573 31.0569L18.4054 23.1384C18.5691 22.5053 18.0912 21.888 17.4373 21.888H14.2914C13.6375 21.888 13.1596 21.2708 13.3232 20.6377L16.4137 8.68289C16.5261 8.28056 16.8904 7.99734 17.3081 8.00208C17.3587 8.00266 17.4046 8.0035 17.4427 8.0047L20.6109 8.00465C21.217 8.00436 21.684 8.53896 21.6023 9.13949L21.5828 9.28246L20.3746 16.349C20.2702 16.9598 20.7406 17.5175 21.3603 17.5175H25.2525Z"/></svg>
	<span class="slash">/</span>
	<span class="name">nitro-app</span>
	<span class="tag mono">dev</span>
	<span class="live" id="live"><i></i><span id="livetext">Connecting</span></span>
</nav>
<main>
	<h1>Nitro, running in your browser.</h1>
	<p class="lead">A standalone Nitro v3 server. <code>nitro dev</code> runs the ES modules in <code>server/</code> with no build step, on Bun's aarch64 build, on a Linux kernel compiled to WebAssembly.</p>
	<div class="mono" id="who">connecting...</div>

	<div class="card stats">
		<div><span>Runtime</span><b id="h-runtime">-</b></div>
		<div><span>Architecture</span><b id="h-arch">-</b></div>
		<div><span>Kernel</span><b id="h-kernel">-</b></div>
		<div><span>Memory</span><b id="h-mem">-</b></div>
	</div>

	<div class="cols">
		<section class="card">
			<div class="head"><h2>Routes</h2><small>server/api</small></div>
			<div class="route"><span class="m">GET</span><span class="p"><b>/api/hello</b><small>hello.mjs</small></span><button data-get="api/hello">Send</button></div>
			<div class="route"><span class="m">GET</span><span class="p"><b>/api/runtime</b><small>runtime.mjs</small></span><button data-get="api/runtime">Send</button></div>
			<div class="route"><span class="m">POST</span><span class="p"><b>/api/echo</b><small>echo.post.mjs</small></span><button id="echo">Send</button></div>
			<div class="payload"><textarea id="body" spellcheck="false" aria-label="POST body">{ "hello": "from the browser" }</textarea></div>
			<div class="bar mono"><span id="status">Response</span><span id="took"></span></div>
			<pre id="out">Pick a route and press Send.</pre>
		</section>
		<section class="card">
			<div class="head"><h2>Project</h2><small>app/</small></div>
			<pre class="tree">├── <b>package.json</b>
├── <b>nitro.config.ts</b>
├── public/
│   └── <b>index.html</b>
└── server/api/
    ├── <b>hello.mjs</b>
    ├── <b>runtime.mjs</b>
    └── <b>echo.post.mjs</b></pre>
			<p class="note">File paths are URLs: add <code>server/api/time.mjs</code> and <code>api/time</code> answers, no restart. A <code>.post.mjs</code> suffix picks the method, <code>[id].mjs</code> a parameter.</p>
		</section>
	</div>

	<footer><p>Edit <code>server/api/hello.mjs</code> in the terminal and press Send again: the dev server picks the change up. This page is <code>public/index.html</code>, served as a static file.</p></footer>
</main>
<script>
"use strict";
const $ = (id) => document.getElementById(id);
const set = (id, v) => { $(id).textContent = v; };
function dur(s) {
	const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
	return (h ? h + " h " : "") + (h || m ? m + " min " : "") + (s % 60) + " s";
}

async function call(path, init) {
	const t0 = performance.now();
	$("status").className = "";
	set("status", "...");
	set("took", "");
	try {
		const r = await fetch(path, { cache: "no-store", ...init });
		const text = await r.text();
		let shown = text;
		try { shown = JSON.stringify(JSON.parse(text), null, 2); } catch {}
		set("out", shown);
		$("status").className = r.ok ? "ok" : "bad";
		set("status", r.status + " " + (init?.method || "GET") + " /" + path);
	} catch (e) {
		set("out", String(e));
		$("status").className = "bad";
		set("status", "failed: is nitro dev still running?");
	}
	set("took", (performance.now() - t0).toFixed(0) + " ms");
}
for (const b of document.querySelectorAll("[data-get]")) b.onclick = () => call(b.dataset.get);
$("echo").onclick = () => call("api/echo", { method: "POST", headers: { "content-type": "application/json" }, body: $("body").value });

async function poll() {
	if (!document.hidden) {
		try {
			const r = await fetch("api/runtime", { cache: "no-store" });
			if (!r.ok) throw new Error("HTTP " + r.status);
			const s = await r.json();
			set("who", s.hostname + " · " + s.platform + " · up " + dur(s.uptime));
			set("h-runtime", s.runtime);
			set("h-arch", s.arch);
			set("h-kernel", s.kernel);
			set("h-mem", s.memory);
			$("live").className = "live ok";
			set("livetext", "Ready");
		} catch {
			$("live").className = "live bad";
			set("livetext", "Offline");
		}
	}
	setTimeout(poll, 3000);
}
poll();
</script>
</body>
</html>
`;

export default {
	id: "nitro",
	title: "Nitro",
	desc: "A standalone Nitro server, installed and run with Bun, on nitro dev",
	// The Nitro logo: the bolt in a circle from nitro.build/icon.svg (not in
	// Simple Icons), without its blurred arc.
	icon: { svg: '<path fill-rule="evenodd" d="M35.2166 7.02016C28.0478 -1.38317 15.4241 -2.38397 7.02077 4.78481C-1.38256 11.9536 -2.38336 24.5773 4.78542 32.9806C11.9542 41.3839 24.5779 42.3847 32.9812 35.216C41.3846 28.0472 42.3854 15.4235 35.2166 7.02016ZM25.2525 17.5175C26.0233 17.5175 26.5155 18.3527 26.1287 19.0194L26.0175 19.2111L18.4696 31.6294C18.3293 31.8602 18.0788 32.001 17.8088 32.001H17.0883C16.5946 32.001 16.2336 31.5349 16.3573 31.0569L18.4054 23.1384C18.5691 22.5053 18.0912 21.888 17.4373 21.888H14.2914C13.6375 21.888 13.1596 21.2708 13.3232 20.6377L16.4137 8.68289C16.5261 8.28056 16.8904 7.99734 17.3081 8.00208C17.3587 8.00266 17.4046 8.0035 17.4427 8.0047L20.6109 8.00465C21.217 8.00436 21.684 8.53896 21.6023 9.13949L21.5828 9.28246L20.3746 16.349C20.2702 16.9598 20.7406 17.5175 21.3603 17.5175H25.2525Z"/>', viewBox: "0 0 40 40" },
	colors: ["#f27cec", "#31b2f3"],
	needs: { net: true },
	files: {
		"app/package.json": PACKAGE,
		"app/nitro.config.ts": CONFIG,
		"app/tsconfig.json": TSCONFIG,
		"app/.gitignore": GITIGNORE,
		"app/server/api/hello.mjs": HELLO,
		"app/server/api/runtime.mjs": RUNTIME,
		"app/server/api/echo.post.mjs": ECHO,
		"app/public/index.html": PAGE,
	},
	commands: ["cd app", "bun install", "bun --bun run dev --host 0.0.0.0 --port 3000"],
	ports: [3000],
} satisfies TerminalApp;
