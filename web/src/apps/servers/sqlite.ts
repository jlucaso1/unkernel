// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// SQLite: Alpine's aarch64 sqlite (the sqlite3 shell, main, about 1.4 MB to
// download with readline and ncurses) or Debian's sqlite3, querying the running guest itself:
// SQL over the live Linux in the browser, where the postgres demo has a seeded
// dataset. No server and no ports: sqlite3 is the interface.
//
// snapshot.sh loads a fresh snapshot on every run, in one transaction: the
// installed packages from apk's database (/lib/apk/db/installed: P:, V:, T:,
// L:, o:, I:, D:, p:, i: and R: lines, records separated by blank lines;
// /etc/apk/world), the processes (/proc/<pid>/status and cmdline), the mounts
// (/proc/mounts) and a few facts (uname, /proc/cpuinfo's feature list,
// /proc/meminfo). On Debian the packages come from dpkg's database instead
// (/var/lib/dpkg/status, the info/*.list files for the file counts, the
// machine-readable /usr/share/doc/*/copyright files for a license, and
// apt-mark showmanual for what was asked for; no build times or install_if).
// awk (busybox's or Debian's mawk) turns each into INSERT statements, quoting with
// a q variable since the programs sit in single quotes. The snapshot tables
// are dropped and made again, so a rerun sees packages installed meanwhile;
// the runs table is kept and gets a row per run. The database is system.db
// in the demo's directory, which the data disk keeps (and the runs with it)
// when it keeps the root's changes (upper=data in /run/kw-base).
//
// Dependencies are kept as written (so:libc.musl-aarch64.so.1, cmd:sh,
// /bin/sh), and the needs view resolves them through provides (each package's
// own name plus its p: names, or Debian's Provides) to package-to-package
// edges (every installed alternative of a Debian a | b). tree.sql walks them
// down from a package; remove.sql works out what removing it would take
// with it (apk del, or apt remove then apt autoremove):
// what /etc/apk/world asks for (but that package), closed over needs, plus
// the install_if packages (i:, like ssl_client) whose conditions all stay,
// is kept, and the rest goes. An install_if package that only a kept
// install_if package makes possible is missed: a recursive CTE cannot test
// "all of" over itself.
//
// showcase.sql runs once with .mode box, then sqlite3 opens the database
// with sqliterc (box mode fitted to the window, headers, .timer on, a
// coloured prompt, wrapped in \001 \002 so readline measures it right) and
// prints queries to try. The files are String.raw templates, so the
// backslashes in sqlite3's and awk's strings read as written here.
import type { TerminalApp } from "../types.ts";

const SNAPSHOT = String.raw`#!/bin/sh
# Loads a fresh snapshot of this system into system.db, in one transaction:
# the installed packages, the processes, the mounts and a few facts replace
# the last snapshot's, and the runs table gets a row. Run it any time, even
# from sqlite3 (.shell ./snapshot.sh). snapshot.sql keeps the SQL it ran.
set -e
cd "$(dirname "$0")"
db=$PWD/system.db
if grep -qsx upper=data /run/kw-base; then
	where="on the data disk: the runs table survives reboots"
else
	where="no data disk: lost at reboot"
fi

# awk helpers: a quoted SQL string, or a number or NULL. q is a single quote.
LIB='function s(x) { gsub(q, q q, x); return q x q }
function n(x) { return x == "" ? "NULL" : x + 0 }
function sn(x) { return x == "" ? "NULL" : s(x) }'

packages() {
	if [ -f /lib/apk/db/installed ]; then apk_packages; else dpkg_packages; fi
}

apk_packages() {
	awk -v q="'" "$LIB"'
	function flush() {
		if (name != "")
			print "INSERT INTO packages VALUES (" s(name) ", " s(ver) ", " sn(desc) ", " sn(lic) ", " sn(orig) ", " \
				n(size) ", " files ", " ndeps ", " (built == "" ? "NULL" : "datetime(" built ", " q "unixepoch" q ")") ", " \
				sn(url) ", " sn(maint) ");\nINSERT INTO provides VALUES (" s(name) ", " s(name) ");"
		name = ver = desc = lic = orig = size = built = url = maint = ""
		files = ndeps = 0
	}
	# The names in a D:, p: or i: line, without version constraints.
	function names(v, table, a, i, k, t) {
		k = split(v, a, " ")
		for (i = 1; i <= k; i++) {
			t = a[i]
			if (t ~ /^!/) continue # a conflict, not a dependency
			sub(/[<>=~].*/, "", t)
			print "INSERT INTO " table " VALUES (" s(name) ", " s(t) ");"
			if (table == "deps") ndeps++
		}
	}
	BEGIN { files = ndeps = 0 }
	/^$/ { flush(); next }
	{ k = substr($0, 1, 2); v = substr($0, 3) }
	k == "P:" { name = v }
	k == "V:" { ver = v }
	k == "T:" { desc = v }
	k == "L:" { lic = v }
	k == "o:" { orig = v }
	k == "I:" { size = v }
	k == "t:" { built = v }
	k == "U:" { url = v }
	k == "m:" { maint = v }
	k == "R:" { files++ }
	k == "D:" { names(v, "deps") }
	k == "p:" { names(v, "provides") }
	k == "i:" { names(v, "install_if") }
	END { flush() }' /lib/apk/db/installed
	awk -v q="'" "$LIB"'
	{ for (i = 1; i <= NF; i++) if ($i !~ /^!/) { t = $i; sub(/[@<>=~].*/, "", t); print "INSERT INTO world VALUES (" s(t) ");" } }' /etc/apk/world
}

# Debian: the installed paragraphs of dpkg's status file; the .list files
# (read first) count each package's paths, the copyright files give the
# first License: of those in the machine-readable format.
dpkg_packages() {
	awk -v q="'" "$LIB"'
	# The names in a Depends or Provides value: every alternative, without
	# version constraints or architecture qualifiers.
	function names(v, table, a, b, i, j, k, m, t) {
		k = split(v, a, ",")
		for (i = 1; i <= k; i++) {
			m = split(a[i], b, "|")
			for (j = 1; j <= m; j++) {
				t = b[j]
				sub(/\(.*/, "", t); sub(/:.*/, "", t); gsub(/[ \t]/, "", t)
				if (t != "") print "INSERT INTO " table " VALUES (" s(name) ", " s(t) ");"
			}
		}
	}
	function flush() {
		if (name != "" && status ~ / installed$/) {
			print "INSERT INTO packages VALUES (" s(name) ", " s(ver) ", " sn(desc) ", " sn(lic[name]) ", " sn(orig == "" ? name : orig) ", " \
				(size == "" ? "NULL" : size * 1024) ", " (files[name] + 0) ", " (deps == "" ? 0 : split(deps, tmp, ",")) ", NULL, " \
				sn(url) ", " sn(maint) ");\nINSERT INTO provides VALUES (" s(name) ", " s(name) ");"
			if (deps != "") names(deps, "deps")
			if (prov != "") names(prov, "provides")
		}
		name = ver = desc = orig = size = url = maint = status = deps = prov = ""
	}
	FILENAME ~ /\.list$/ {
		p = FILENAME; sub(/^.*\//, "", p); sub(/\.list$/, "", p); sub(/:.*/, "", p)
		files[p]++
		next
	}
	FILENAME ~ /\/copyright$/ {
		if (FNR == 1) { p = FILENAME; sub(/\/copyright$/, "", p); sub(/^.*\//, "", p); dep5 = $0 ~ /^Format:/ }
		if (dep5 && /^License:/ && !(p in lic)) { v = $0; sub(/^License:[ \t]*/, "", v); lic[p] = v }
		next
	}
	/^$/ { flush(); next }
	/^[ \t]/ { next } # a continuation line
	{ i = index($0, ":"); k = substr($0, 1, i - 1); v = substr($0, i + 1); sub(/^[ \t]+/, "", v) }
	k == "Package" { name = v }
	k == "Status" { status = v }
	k == "Version" { ver = v }
	k == "Description" { desc = v }
	k == "Source" { orig = v; sub(/ .*/, "", orig) }
	k == "Installed-Size" { size = v }
	k == "Homepage" { url = v }
	k == "Maintainer" { maint = v }
	k == "Depends" || k == "Pre-Depends" { deps = deps (deps == "" ? "" : ", ") v }
	k == "Provides" { prov = v }
	END { flush() }' /var/lib/dpkg/info/*.list /usr/share/doc/*/copyright /var/lib/dpkg/status
	apt-mark showmanual | awk -v q="'" "$LIB"'{ print "INSERT INTO world VALUES (" s($1) ");" }'
}

processes() {
	for d in /proc/[0-9]*; do
		{ cat "$d/status" && printf 'Cmdline:\t' && tr '\0' ' ' < "$d/cmdline" && echo; } 2>/dev/null || true
		echo
	done | awk -v q="'" "$LIB"'
	NR == FNR { split($0, f, ":"); user[f[3]] = f[1]; next }
	function flush() {
		if (pid != "")
			print "INSERT INTO processes VALUES (" n(pid) ", " n(ppid) ", " sn((uid in user) ? user[uid] : uid) ", " sn(state) ", " \
				n(rss) ", " n(threads) ", " sn(name) ", " sn(cmd) ");"
		pid = ppid = uid = state = rss = threads = name = cmd = ""
	}
	/^$/ { flush(); next }
	{
		i = index($0, ":"); k = substr($0, 1, i - 1); v = substr($0, i + 1)
		sub(/^[ \t]+/, "", v); sub(/[ \t]+$/, "", v)
	}
	k == "Name" { name = v }
	k == "Pid" { pid = v }
	k == "PPid" { ppid = v }
	k == "Uid" { split(v, f, /[ \t]+/); uid = f[1] }
	k == "State" { state = v; sub(/^.*\(/, "", state); sub(/\).*$/, "", state) }
	k == "VmRSS" { rss = v + 0 }
	k == "Threads" { threads = v }
	k == "Cmdline" { cmd = v }
	END { flush() }' /etc/passwd -
}

mounts() {
	awk -v q="'" "$LIB"'
	{ print "INSERT INTO mounts VALUES (" s($1) ", " s($2) ", " s($3) ", " s($4) ");" }' /proc/mounts
}

facts() {
	{
		printf 'os\t%s\n' "$(. /etc/os-release && echo "$PRETTY_NAME")"
		printf 'kernel\t%s\n' "$(uname -sr)"
		printf 'machine\t%s\n' "$(uname -m)"
		awk -F': *' '{ k = $1; sub(/[ \t]+$/, "", k) }
			k == "Features" && !(k in seen) { seen[k] = 1; print "features\t" $2 }' /proc/cpuinfo
		awk '/^MemTotal:/ { print "memory\t" int($2 / 1024) " MiB" }' /proc/meminfo
		awk '{ printf "uptime\t%d min %d s\n", $1 / 60, $1 % 60 }' /proc/uptime
		printf 'database\t%s\n' "$db"
	} | awk -F '\t' -v q="'" "$LIB"'{ print "INSERT INTO system VALUES (" s($1) ", " s($2) ");" }'
}

{
	cat <<'EOF'
BEGIN;
CREATE TABLE IF NOT EXISTS runs (
	id INTEGER PRIMARY KEY,
	at TEXT NOT NULL,              -- when ./snapshot.sh ran (local time)
	packages INTEGER NOT NULL,     -- how many were installed
	installed_kib INTEGER NOT NULL,
	processes INTEGER NOT NULL
);
DROP VIEW IF EXISTS needs;
DROP TABLE IF EXISTS packages;
DROP TABLE IF EXISTS deps;
DROP TABLE IF EXISTS provides;
DROP TABLE IF EXISTS install_if;
DROP TABLE IF EXISTS world;
DROP TABLE IF EXISTS processes;
DROP TABLE IF EXISTS mounts;
DROP TABLE IF EXISTS system;
-- /lib/apk/db/installed (Debian: /var/lib/dpkg/status), one row per package.
CREATE TABLE packages (
	name TEXT PRIMARY KEY,
	version TEXT NOT NULL,
	description TEXT,
	license TEXT,
	origin TEXT,     -- the source package (aport, Debian source) it was built from
	size INTEGER,    -- installed size in bytes
	files INTEGER,   -- files it installed
	deps INTEGER,    -- dependencies it declares
	built TEXT,      -- build time (UTC; not on Debian)
	url TEXT,
	maintainer TEXT
);
-- Dependencies as declared (D:, Debian's Depends and Pre-Depends): a package,
-- so:libfoo.so.1, cmd:foo, /bin/sh.
CREATE TABLE deps (pkg TEXT NOT NULL, dep TEXT NOT NULL);
-- The names each package answers to: its own, and those it provides (p:, Provides).
CREATE TABLE provides (pkg TEXT NOT NULL, name TEXT NOT NULL);
-- Installed automatically once all of these are (i:; none on Debian).
CREATE TABLE install_if (pkg TEXT NOT NULL, cond TEXT NOT NULL);
-- /etc/apk/world (Debian: apt-mark showmanual): what was asked for; everything
-- else came as a dependency.
CREATE TABLE world (name TEXT NOT NULL);
-- Package-to-package dependency edges: deps resolved through provides.
CREATE VIEW needs AS
	SELECT DISTINCT d.pkg, p.pkg AS dep FROM deps d JOIN provides p ON p.name = d.dep WHERE p.pkg <> d.pkg;
-- /proc/<pid>/status and cmdline. Kernel threads have no RSS and no cmdline.
CREATE TABLE processes (
	pid INTEGER PRIMARY KEY,
	ppid INTEGER,
	user TEXT,
	state TEXT,
	rss_kib INTEGER,
	threads INTEGER,
	name TEXT,
	cmdline TEXT
);
-- /proc/mounts.
CREATE TABLE mounts (device TEXT, mountpoint TEXT, fstype TEXT, options TEXT);
-- A few facts: uname, /proc/cpuinfo, /proc/meminfo, /proc/uptime.
CREATE TABLE system (fact TEXT PRIMARY KEY, value TEXT);
EOF
	packages
	processes
	mounts
	facts
	cat <<'EOF'
INSERT INTO system VALUES ('SQLite', sqlite_version());
INSERT INTO runs (at, packages, installed_kib, processes)
	SELECT datetime('now', 'localtime'), count(*), sum(size) / 1024, (SELECT count(*) FROM processes) FROM packages;
COMMIT;
EOF
} > snapshot.sql
sqlite3 -batch -bail -init /dev/null system.db < snapshot.sql
# The package the sqlite3 shell came in, for showcase.sql's tree.sql and remove.sql.
if [ -f /lib/apk/db/installed ]; then self=sqlite; else self=sqlite3; fi
printf '.parameter set @pkg %s\n' "$self" > self.sql

counts=$(sqlite3 -batch -init /dev/null system.db "SELECT printf('Snapshot %d: %d packages, %d processes, %d mounts',
	(SELECT max(id) FROM runs), (SELECT count(*) FROM packages), (SELECT count(*) FROM processes),
	(SELECT count(*) FROM mounts))")
echo "$counts, in $db ($where)."
`;

const TREE = String.raw`-- Everything the package @pkg pulls in (.param set @pkg sqlite, then .read
-- tree.sql), as a tree: recursive CTEs walk the needs view down from it,
-- keep each package at the shallowest level it is reached, under one parent
-- there, and list its other dependents beside it.
WITH RECURSIVE
	reach(name, depth) AS (
		SELECT @pkg, 0
		UNION
		SELECT n.dep, r.depth + 1 FROM reach r JOIN needs n ON n.pkg = r.name WHERE r.depth < 30
	),
	level(name, depth) AS (SELECT name, min(depth) FROM reach GROUP BY name),
	up(name, parent) AS (
		SELECT l.name, min(n.pkg)
		FROM level l JOIN needs n ON n.dep = l.name JOIN level p ON p.name = n.pkg AND p.depth = l.depth - 1
		GROUP BY l.name
	),
	tree(name, depth, path) AS (
		SELECT @pkg, 0, @pkg
		UNION ALL
		SELECT u.name, t.depth + 1, t.path || ' ' || u.name FROM tree t JOIN up u ON u.parent = t.name
	)
SELECT iif(t.depth > 0, substr('                              ', 1, 3 * (t.depth - 1)) || '└─ ', '') || t.name AS package,
	p.version, p.size / 1024 AS KiB,
	(SELECT group_concat(n.pkg, ' ' ORDER BY n.pkg) FROM needs n JOIN level l ON l.name = n.pkg
		WHERE n.dep = t.name AND n.pkg <> (SELECT parent FROM up WHERE name = t.name)) AS "also needed by"
FROM tree t JOIN packages p ON p.name = t.name
ORDER BY t.path;
`;

const REMOVE = String.raw`-- What removing @pkg would take with it (.param set @pkg sqlite, then .read
-- remove.sql): apk del, or apt remove then apt autoremove (apk del -s <pkg>
-- asks apk itself). Kept: what the world table asks for, but @pkg, with
-- everything it needs, plus the install_if
-- packages whose conditions all stay, with what they need. The rest goes.
WITH RECURSIVE
	kept0(name) AS (
		SELECT p.pkg FROM world w JOIN provides p ON p.name = w.name WHERE w.name <> @pkg
		UNION
		SELECT n.dep FROM kept0 k JOIN needs n ON n.pkg = k.name
	),
	auto(name) AS (
		SELECT i.pkg FROM install_if i
		GROUP BY i.pkg
		HAVING min(EXISTS (SELECT 1 FROM provides p WHERE p.name = i.cond AND p.pkg IN kept0)) = 1
	),
	kept(name) AS (
		SELECT name FROM kept0
		UNION
		SELECT name FROM auto
		UNION
		SELECT n.dep FROM kept k JOIN needs n ON n.pkg = k.name
	),
	gone AS (SELECT name, version, size FROM packages WHERE name NOT IN kept)
SELECT name AS removed, version, size / 1024 AS KiB FROM gone
UNION ALL
SELECT '(nothing: ' || @pkg || ' was not asked for (the world table), or what stays needs it)', NULL, NULL
WHERE NOT EXISTS (SELECT 1 FROM gone)
ORDER BY 1;
`;

const SHOWCASE = String.raw`-- Queries over the snapshot snapshot.sh just took, run by run.sh before
-- the sqlite3 session.
.mode box --sw auto --ww
.headers on
.nullvalue ''

.print
.print '── This system: the system table'
SELECT fact, value FROM system WHERE fact <> 'features' ORDER BY rowid;

.print
.print "── The CPU's features from /proc/cpuinfo, split into a list by a recursive CTE"
WITH RECURSIVE split(i, ext, rest) AS (
	SELECT 0, NULL, (SELECT value FROM system WHERE fact = 'features') || ' '
	UNION ALL
	SELECT i + 1, substr(rest, 1, instr(rest, ' ') - 1), substr(rest, instr(rest, ' ') + 1) FROM split WHERE rest <> ''
)
SELECT CASE
		WHEN ext IN ('fp', 'asimd') THEN 'floating point and SIMD'
		WHEN ext IN ('aes', 'pmull', 'sha1', 'sha2', 'sha3', 'sha512') THEN 'crypto'
		WHEN ext = 'crc32' THEN 'checksums'
		WHEN ext = 'atomics' THEN 'atomics (LSE)'
		ELSE 'other'
	END AS kind,
	count(*) AS n, group_concat(ext, ' ' ORDER BY i) AS extensions
FROM split WHERE ext IS NOT NULL
GROUP BY kind ORDER BY min(i);

.print
.print '── The biggest installed packages: a share of sum() OVER () and a running total'
SELECT name, version, size / 1024 AS KiB, files,
	round(100.0 * size / sum(size) OVER (), 1) AS "%",
	sum(size) OVER (ORDER BY size DESC ROWS UNBOUNDED PRECEDING) / 1024 AS "running KiB"
FROM packages
ORDER BY size DESC
LIMIT 10;

.print
.print '── Licenses by package count, the bars drawn with substr() of a string of blocks'
SELECT license, count(*) AS packages,
	substr('██████████████████████████████', 1, max(1, round(30.0 * count(*) / max(count(*)) OVER ()))) AS chart
FROM packages
GROUP BY license
ORDER BY packages DESC, license
LIMIT 12;

.print
.print '── Packages by origin, the source package each was built from'
SELECT origin, count(*) AS packages, sum(size) / 1024 AS KiB,
	group_concat(name, ' ' ORDER BY name) AS "built from it"
FROM packages
GROUP BY origin
HAVING count(*) > 1
ORDER BY packages DESC, origin;

.read self.sql
.print
.print "── What the sqlite3 shell's package pulls in, its dependencies resolved through provides (tree.sql, recursive CTEs)"
.read tree.sql
.print
.print '── What removing that package would take with it, worked out from what was asked for (remove.sql)'
.read remove.sql
.parameter clear

.print
.print '── Processes by memory: rank(), a share of sum() OVER (), a running total'
SELECT pid, name, user, state, rss_kib AS "RSS KiB",
	rank() OVER (ORDER BY rss_kib DESC) AS rank,
	round(100.0 * rss_kib / sum(rss_kib) OVER (), 1) AS "%",
	sum(rss_kib) OVER (ORDER BY rss_kib DESC ROWS UNBOUNDED PRECEDING) AS "running KiB"
FROM processes
WHERE rss_kib > 0
ORDER BY rss_kib DESC
LIMIT 10;
.print 'Kernel threads, kthreadd (PID 2) and its children, have no memory of their own:'
SELECT count(*) AS n, group_concat(DISTINCT substr(name, 1, instr(name || '/', '/') - 1)) AS "kernel threads (by name, up to a /)"
FROM processes WHERE pid = 2 OR ppid = 2;

.print
.print '── Mounts by file system type, as JSON (json_group_array)'
SELECT fstype, count(*) AS n, json_group_array(mountpoint) AS mountpoints
FROM mounts
GROUP BY fstype
ORDER BY n DESC, fstype;

.print
.print '── The runs table: a row per ./run.sh, lag() for the change in packages'
SELECT * FROM (
	SELECT id AS run, at, packages,
		iif(id > 1, printf('%+d', packages - lag(packages) OVER (ORDER BY id)), '') AS change,
		installed_kib AS "installed KiB", processes
	FROM runs ORDER BY id DESC LIMIT 8
) ORDER BY run;
`;

const SQLITERC = String.raw`-- sqlite3's settings for the demo session (sqlite3 -init sqliterc system.db).
.mode box --sw auto --ww
.headers on
.nullvalue ''
.timer on
.prompt "\001\033[1;34m\002system.db\001\033[0m\002> " "     ...> "
.print
.print "system.db holds a snapshot of this Linux, taken as ./run.sh started. Try:"
.print "  .tables                                  the tables; .schema packages for one's columns"
.print "  SELECT origin, name, max(size) FROM packages GROUP BY origin ORDER BY 3 DESC;"
.print "                                           the biggest package per origin (bare columns)"
.print "  SELECT * FROM needs WHERE dep LIKE '%readline%';  what needs readline"
.print "  .param set @pkg NAME                     then .read tree.sql (what it pulls in)"
.print "                                           or .read remove.sql (what removing it takes)"
.print "  SELECT user, count(*), sum(rss_kib) FROM processes GROUP BY user;"
.print "  SELECT pid, name, rss_kib FROM processes WHERE ppid = 1;     what init started"
.print "  .mode json, .mode markdown or .mode csv, then a query; .mode box goes back"
.print "  .shell ./snapshot.sh                     a fresh snapshot without leaving"
.print "                                           (install something in another window first)"
.print "  .quit leaves; ./run.sh takes a new snapshot, and the runs table grows"
.print
`;

export default {
	id: "sqlite",
	title: "SQLite",
	desc: "SQL over this live Linux: its packages, processes and mounts loaded into SQLite, queried, then sqlite3",
	// The SQLite logo, from Simple Icons (CC0 1.0), slug sqlite.
	icon: { svg: '<path d="M21.678.521c-1.032-.92-2.28-.55-3.513.544a8.71 8.71 0 0 0-.547.535c-2.109 2.237-4.066 6.38-4.674 9.544.237.48.422 1.093.544 1.561a13.044 13.044 0 0 1 .164.703s-.019-.071-.096-.296l-.05-.146a1.689 1.689 0 0 0-.033-.08c-.138-.32-.518-.995-.686-1.289-.143.423-.27.818-.376 1.176.484.884.778 2.4.778 2.4s-.025-.099-.147-.442c-.107-.303-.644-1.244-.772-1.464-.217.804-.304 1.346-.226 1.478.152.256.296.698.422 1.186.286 1.1.485 2.44.485 2.44l.017.224a22.41 22.41 0 0 0 .056 2.748c.095 1.146.273 2.13.5 2.657l.155-.084c-.334-1.038-.47-2.399-.41-3.967.09-2.398.642-5.29 1.661-8.304 1.723-4.55 4.113-8.201 6.3-9.945-1.993 1.8-4.692 7.63-5.5 9.788-.904 2.416-1.545 4.684-1.931 6.857.666-2.037 2.821-2.912 2.821-2.912s1.057-1.304 2.292-3.166c-.74.169-1.955.458-2.362.629-.6.251-.762.337-.762.337s1.945-1.184 3.613-1.72C21.695 7.9 24.195 2.767 21.678.521m-18.573.543A1.842 1.842 0 0 0 1.27 2.9v16.608a1.84 1.84 0 0 0 1.835 1.834h9.418a22.953 22.953 0 0 1-.052-2.707c-.006-.062-.011-.141-.016-.2a27.01 27.01 0 0 0-.473-2.378c-.121-.47-.275-.898-.369-1.057-.116-.197-.098-.31-.097-.432 0-.12.015-.245.037-.386a9.98 9.98 0 0 1 .234-1.045l.217-.028c-.017-.035-.014-.065-.031-.097l-.041-.381a32.8 32.8 0 0 1 .382-1.194l.2-.019c-.008-.016-.01-.038-.018-.053l-.043-.316c.63-3.28 2.587-7.443 4.8-9.791.066-.069.133-.128.198-.194Z"/>' },
	colors: ["#44a8e0", "#003b57"],
	needs: { net: true },
	files: {
		"snapshot.sh": { content: SNAPSHOT, mode: 0o755 },
		"showcase.sql": SHOWCASE,
		"tree.sql": TREE,
		"remove.sql": REMOVE,
		"sqliterc": SQLITERC,
	},
	packages: { alpine: ["sqlite"], debian: ["sqlite3"] },
	commands: ["./snapshot.sh", "sqlite3 system.db '.read showcase.sql'", "sqlite3 -init sqliterc system.db"],
} satisfies TerminalApp;
