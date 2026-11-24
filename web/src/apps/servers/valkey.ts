// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Valkey: the BSD-licensed, Redis-compatible key/value server, Alpine's
// aarch64 valkey and valkey-cli from main (about 1.7 MB to download; the
// libssl3 and libcrypto3 they link are already in the image). Alpine's redis
// (about 2.1 MB, AGPL/SSPL) works the same way but is in community, and
// enabling community makes every later apk command in the guest about 2 s
// slower, so the demo uses Valkey. valkey-compat would add redis-* names for
// the commands. No ports: there is no HTTP UI, valkey-cli is the interface.
//
// start.sh starts the server unless it already answers PING. valkey.conf is
// the demo's own, not Alpine's /etc/valkey/valkey.conf: that one binds
// "127.0.0.1 -::1" and logs to syslog. Here the server binds 127.0.0.1 only
// (the guest has no IPv6, and the compiled-in default is "* -::*"), keeps
// protected mode and daemonizes (a new session, so closing the window or
// Ctrl-C leaves it running; ./run.sh reconnects). It runs as the session's
// user, like the rest of the demo (port 6379 needs no privilege), with its
// pid file, log and data in the demo's directory. When the root's changes
// are kept on the data disk (upper=data in /run/kw-base), that directory is
// too, so it keeps its data there as an append-only file (fsync every
// second) plus RDB snapshots, which survive reboots; otherwise it runs in
// memory (no AOF, no snapshots). It listens on loopback only, and nothing
// outside the guest can reach it.
//
// seed.sh loads seed.txt once, in one MULTI/EXEC, so a run cut off halfway
// leaves nothing behind and the marker key demo:seeded is set only with the
// rest. showcase.sh prints a few commands with their replies, each fed to
// valkey-cli on stdin so it parses the quotes as its prompt does, and
// changes a little on every run (a run counter, a stream entry, the match
// queue rotating), which shows what persists.
import type { TerminalApp } from "../types.ts";

const CONF = `# The unkernel Valkey demo's server settings. start.sh adds dir, pidfile,
# logfile and the persistence settings, which depend on whether the data
# disk keeps this directory.
# Loopback only: the guest has no IPv6, so no ::1 (the built-in default is
# "* -::*").
bind 127.0.0.1
port 6379
protected-mode yes
# Fork into a new session: closing the window leaves the server running.
daemonize yes
# A small cap, so a runaway experiment cannot take the guest's memory.
maxmemory 64mb
maxmemory-policy noeviction
appendfsync everysec
`;

const START = String.raw`#!/bin/sh
# Starts the demo's Valkey server unless it already answers. Its data lives
# in ./data when the data disk keeps the root's changes (and so this
# directory), else in memory only.
set -e
cd "$(dirname "$0")"
DIR=$PWD/data PID=$PWD/valkey.pid LOG=$PWD/valkey.log
ping() { [ "$(valkey-cli PING 2>/dev/null)" = PONG ]; }

if ping; then
	echo "Valkey already answers on 127.0.0.1:6379: $(valkey-cli CONFIG GET dir | tail -n 1)."
	exit 0
fi
if grep -qsx upper=data /run/kw-base; then
	set -- --appendonly yes
	echo "Starting Valkey with its data in $DIR (on the data disk, kept across reboots)."
else
	set -- --appendonly no --save ""
	echo "Starting Valkey in memory (no data disk: lost at reboot)."
fi
mkdir -p "$DIR"
valkey-server "$PWD/valkey.conf" --dir "$DIR" --pidfile "$PID" --logfile "$LOG" "$@"
# The daemon answers once it has loaded its data (LOADING until then).
i=0
until ping; do
	i=$((i + 1))
	if [ "$i" -ge 60 ] || { [ "$i" -ge 3 ] && ! pgrep -x valkey-server >/dev/null; }; then
		echo "Valkey did not start; the end of $LOG:" >&2
		tail -n 20 "$LOG" >&2
		exit 1
	fi
	sleep 1
done
echo "Valkey is up (PID $(cat "$PID"))."
`;

const SEED_SH = String.raw`#!/bin/sh
# Loads seed.txt the first time; later runs keep what is there.
# valkey-cli FLUSHALL, then ./run.sh, starts over.
set -e
cd "$(dirname "$0")"
if [ "$(valkey-cli EXISTS demo:seeded)" = 1 ]; then
	echo "The demo data is already there."
	exit 0
fi
echo "Seeding: an arcade's players, leaderboard, badges, cities, match queue and event stream."
out=$(grep -v -e '^#' -e '^$' seed.txt | valkey-cli 2>&1)
if [ "$(valkey-cli EXISTS demo:seeded)" != 1 ]; then
	printf '%s\n' "$out" >&2
	echo "Seeding failed." >&2
	exit 1
fi
`;

const SEED = `# The demo's data, fed to valkey-cli by seed.sh (without these comments) in
# one MULTI/EXEC: all of it or none. An arcade where computing pioneers play.
MULTI

# Sorted set: the leaderboard, by score.
ZADD leaderboard 12040 grace 11110 alan 10230 margaret 9820 ada 8710 linus 7650 ken 6900 yukihiro

# Hashes: one per player.
HSET player:ada name "Ada Lovelace" city london game "Analytical Engine Racer" plays 41
HSET player:alan name "Alan Turing" city manchester game "Enigma Breakout" plays 57
HSET player:grace name "Grace Hopper" city new-york game "COBOL Invaders" plays 88
HSET player:margaret name "Margaret Hamilton" city boston game "Lunar Lander" plays 63
HSET player:linus name "Linus Torvalds" city helsinki game "Kernel Panic" plays 35
HSET player:ken name "Ken Thompson" city san-francisco game "Space Travel" plays 29
HSET player:yukihiro name "Yukihiro Matsumoto" city tokyo game "Ruby Rush" plays 22

# Sets: who earned which badge.
SADD badge:speedrun grace alan linus ada
SADD badge:no-hit margaret grace ken ada
SADD badge:night-owl linus ken yukihiro

# Geo set: the players' cities (longitude, latitude).
GEOADD cities -0.1276 51.5072 london -2.2426 53.4808 manchester -74.0060 40.7128 new-york
GEOADD cities -71.0589 42.3601 boston 24.9384 60.1699 helsinki -122.4194 37.7749 san-francisco 139.6917 35.6895 tokyo

# List: the match queue, oldest first.
RPUSH queue:matches "ada vs alan" "grace vs margaret" "linus vs ken" "yukihiro vs grace"

# Stream: the arcade's event log.
XADD events * player grace action "high score" points 12040
XADD events * player alan action "badge" badge speedrun
XADD events * player linus action "joined"

# HyperLogLog: distinct visitors, counted in 12 KB at most.
PFADD visitors ada alan grace margaret linus ken yukihiro ada grace

SET demo:seeded 1
EXEC
`;

const SHOWCASE = String.raw`#!/bin/sh
# A few commands over the demo data, each printed as at valkey-cli's prompt
# and then run, before the interactive session.
set -e
P='\033[1;31m127.0.0.1:6379>\033[0m'
cmd() {
	printf "$P %s\n" "$1"
	printf '%s\n' "$1" | valkey-cli --no-raw
}
section() { printf '\n\033[1m── %s\033[0m\n' "$1"; }

section "The server: INFO server, on aarch64 Linux in your browser"
printf "$P %s\n" "INFO server   (some of its lines)"
valkey-cli INFO server | tr -d '\r' |
	grep -E '^(valkey_version|os|arch_bits|process_id|tcp_port|uptime_in_seconds|multiplexing_api|config_file):'
cmd "CONFIG GET dir"
cmd "INCR demo:runs"
echo "(the showcase's run counter: with the data disk it keeps counting after a reboot)"

section "Sorted set: the leaderboard's top 3, and ada's rank (0 is first)"
cmd "ZREVRANGE leaderboard 0 2 WITHSCORES"
cmd "ZREVRANK leaderboard ada"

section "Hash: a player"
cmd "HGETALL player:grace"
cmd "HINCRBY player:grace plays 1"

section "Sets: speedrunners who also finished without a hit"
cmd "SINTER badge:speedrun badge:no-hit"

section "Geo: how far apart, and who plays within 1000 km of London"
cmd "GEODIST cities london tokyo km"
cmd "GEOSEARCH cities FROMMEMBER london BYRADIUS 1000 km ASC WITHDIST"

section "List: the next match (LMOVE rotates the queue, so each run shows the next)"
cmd "LMOVE queue:matches queue:matches LEFT RIGHT"

section "A key that expires: TTL counts down"
cmd 'SET happy-hour "double points" EX 15'
cmd "TTL happy-hour"
sleep 2
cmd "TTL happy-hour"

section "Stream: an event per run, and the latest two"
cmd 'XADD events * player margaret action "demo run"'
cmd "XREVRANGE events + - COUNT 2"

section "HyperLogLog: distinct visitors (ada and grace came twice)"
cmd "PFCOUNT visitors"

printf '\n%s\n' "Connected to Valkey on 127.0.0.1:6379 next. Try:
  ZINCRBY leaderboard 6000 ken          then ZREVRANGE leaderboard 0 2 WITHSCORES
  HGETALL player:linus
  GEOSEARCH cities FROMMEMBER boston BYRADIUS 500 km WITHDIST
  XRANGE events - +
  SET greeting hello EX 30, then TTL greeting a few times
  SCAN 0 MATCH player:*
  HELP @sorted-set                      valkey-cli's help for a group of commands
  SUBSCRIBE news                        then from another window: valkey-cli PUBLISH news hi
quit leaves the server running; ./run.sh connects again; valkey-cli SHUTDOWN stops it.
"
`;

export default {
	id: "valkey",
	title: "Valkey",
	desc: "A Valkey (Redis-compatible) server with a seeded leaderboard, geo set and stream, then valkey-cli",
	// A key (Simple Icons has no Valkey logo).
	icon: { svg: '<g transform="rotate(-45 12 12)"><path fill-rule="evenodd" d="M6.5 6.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11Zm-2 5.5a2 2 0 1 0 4 0 2 2 0 0 0-4 0Z"/><path d="M11 10.7h12v2.6H11Zm6.5 2.6h2.2v3.2h-2.2Zm3.3 0H23v2.4h-2.2Z"/></g>' },
	colors: ["#ff4f64", "#5b2a86"],
	needs: { net: true },
	files: {
		"valkey.conf": CONF,
		"start.sh": { content: START, mode: 0o755 },
		"seed.sh": { content: SEED_SH, mode: 0o755 },
		"seed.txt": SEED,
		"showcase.sh": { content: SHOWCASE, mode: 0o755 },
	},
	packages: { alpine: ["valkey", "valkey-cli"], debian: ["valkey-server", "valkey-tools"] },
	commands: ["./start.sh", "./seed.sh", "./showcase.sh", "valkey-cli"],
} satisfies TerminalApp;
