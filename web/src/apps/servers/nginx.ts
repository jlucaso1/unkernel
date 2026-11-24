// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// nginx: installed from the distro's repository, serving a page from the
// demo's directory on port 80, shown in the guest preview.
//
// The distro's default site (Alpine: /etc/nginx/http.d/default.conf;
// Debian: /etc/nginx/sites-enabled/default, a symlink into sites-available)
// also listens on [::]:80, and the guest has no IPv6, so nginx would refuse
// to start. site.sh replaces it with site.conf, which has no such line.
// Debian's package does not start nginx (the image's policy-rc.d). The files live in
// /srv/nginx, not under ~, since nginx's workers (user nginx or www-data)
// need not be able to read the home directory; the launcher makes
// /srv/nginx the session user's, so the page and site.conf can be edited
// without sudo. Installing the site, starting nginx (port 80, its logs and
// pid file) and reading its log need root: those steps run with sudo. The
// access log follows in the window; Ctrl-C stops that, not nginx.
import type { TerminalApp } from "../types.ts";

const SITE = `# The unkernel nginx demo: replaces the distro's default site, which also
# listens on [::]:80 (the guest has no IPv6, so nginx would not start).
server {
	listen 80 default_server;
	root /srv/nginx/www;
	index index.html;
	ssi on;
	location / {
		try_files $uri $uri/ =404;
	}
}
`;

const SITE_SH = `#!/bin/sh
# Installs site.conf as the distro's default site.
set -e
cd "$(dirname "$0")"
if [ -d /etc/nginx/http.d ]; then
	conf=/etc/nginx/http.d/default.conf # Alpine
else
	conf=/etc/nginx/sites-enabled/default # Debian: a symlink into sites-available
	rm -f "$conf"
fi
cp site.conf "$conf"
echo "site.conf is $conf"
`;

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>nginx in unkernel</title>
<style>
	:root { color-scheme: dark; }
	body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #000; color: #ededed; font: 15px/1.6 system-ui, sans-serif; }
	main { max-width: 34rem; padding: 2rem; }
	h1 { margin: 0 0 .5rem; font-size: 1.6rem; }
	code { font: 13px ui-monospace, monospace; background: #1a1a1a; padding: .1rem .35rem; border-radius: 4px; }
	dl { display: grid; grid-template-columns: max-content 1fr; gap: .25rem 1rem; margin: 1.5rem 0; }
	dt { color: #a1a1a1; }
	dd { margin: 0; }
</style>
</head>
<body>
<main>
	<h1>Hello from nginx</h1>
	<p>This page is served by nginx, running on Linux in this browser tab. The kernel is WebAssembly, nginx is the distro's own aarch64 binary, and this request went from the page to the guest over vsock.</p>
	<dl>
		<dt>nginx</dt><dd><!--# echo var="nginx_version" --></dd>
		<dt>Guest time</dt><dd><!--# echo var="date_local" --></dd>
		<dt>Your request</dt><dd><code><!--# echo var="request_method" --> <!--# echo var="request_uri" --></code></dd>
	</dl>
	<p>Edit <code>/srv/nginx/www/index.html</code> in the terminal and reload this preview. The config is <code>/srv/nginx/site.conf</code>: <code>sudo ./site.sh &amp;&amp; sudo nginx -s reload</code> applies changes.</p>
</main>
</body>
</html>
`;

export default {
	id: "nginx",
	title: "nginx",
	desc: "A web server in the guest, its page shown in the preview",
	// The NGINX logo, from Simple Icons (CC0 1.0), slug nginx.
	icon: { svg: '<path d="M12 0L1.605 6v12L12 24l10.395-6V6L12 0zm6 16.59c0 .705-.646 1.29-1.529 1.29-.631 0-1.351-.255-1.801-.81l-6-7.141v6.66c0 .721-.57 1.29-1.274 1.29H7.32c-.721 0-1.29-.6-1.29-1.29V7.41c0-.705.63-1.29 1.5-1.29.646 0 1.38.255 1.83.81l5.97 7.141V7.41c0-.721.6-1.29 1.29-1.29h.075c.72 0 1.29.6 1.29 1.29v9.18H18z"/>' },
	colors: ["#1fae4b", "#00572a"],
	needs: { net: true },
	dir: "/srv/nginx",
	files: {
		"site.conf": SITE,
		"site.sh": { content: SITE_SH, mode: 0o755 },
		"www/index.html": PAGE,
	},
	packages: { alpine: ["nginx"], debian: ["nginx"] },
	commands: [
		"$SUDO ./site.sh",
		"$SUDO mkdir -p /run/nginx",
		"$SUDO nginx -t -q",
		"$SUDO nginx -s reload 2>/dev/null || $SUDO nginx",
		"$SUDO tail -n 0 -f /var/log/nginx/access.log",
	],
	ports: [80],
} satisfies TerminalApp;
