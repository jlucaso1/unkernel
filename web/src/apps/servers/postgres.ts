// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// PostgreSQL: Alpine's aarch64 postgresql18 (main, about 13 MB to download
// with what it pulls in) or Debian's postgresql (17), a real server in the tab: a small seeded database,
// a few showcase queries, then an interactive psql. No ports: there is no
// HTTP UI, psql is the interface.
//
// start.sh does the server side, idempotently. The cluster lives in
// /data/postgres when the data disk is mounted (so initdb runs once and the
// data survives reboots), else in /var/lib/postgresql/data. initdb builds
// into <dir>.new and is renamed into place only when it succeeds, so a run
// cut off halfway (Ctrl-C, a closed tab) never leaves a broken cluster that
// the next run would try to start. initdb is kept lean for the emulator
// (--no-sync, the builtin C.UTF-8 locale instead of ICU). The settings are
// small and quiet: 10 connections, 16 MB of shared buffers, io_method=sync
// (no I/O worker processes; 18 and later), synchronous_commit off, and TCP on 127.0.0.1
// only, since the guest has no IPv6. Trust auth is safe because nothing
// outside the guest can connect. The kernel has SysV IPC, POSIX shared memory
// on /dev/shm (tmpfs) and Unix sockets, so the default shared memory
// settings work. start.sh runs as root (sudo ./start.sh: the cluster
// directory, /run/postgresql and the log are postgres's), but postgres
// refuses to run as root, so the server runs as the
// postgres user (created by the package) through su-exec (Alpine) or
// runuser (Debian); seed.sh and psql run as the session's user, connecting
// as the database user postgres (trust auth); /run/postgresql
// (the socket) is on tmpfs and is made on every run. A postmaster.pid left
// by a reboot can name a PID that something else now has, which postgres
// takes for a running server, so start.sh removes it unless that PID is a
// postgres process. pg_ctl detaches the server, so quitting psql, Ctrl-C or
// closing the window leaves it running; ./run.sh reconnects.
//
// Debian: the server's programs are in /usr/lib/postgresql/<major>/bin,
// which start.sh and seed.sh put first on PATH (psql in /usr/bin is
// Debian's pg_wrapper, which works without a cluster of its own), and the
// package would create and start a cluster of its own (17/main) at install:
// createcluster.d/kw-demo.conf, written before the install (as root: the
// launcher writes a file the user cannot write with sudo), turns that off.
//
// seed.sh creates the demo database and its tables (planets and space
// missions, with a JSONB column) only once, in one transaction. The file
// contents are String.raw templates, so psql's backslash commands read as
// written here.
import type { TerminalApp } from "../types.ts";

const START = String.raw`#!/bin/sh
# Starts the demo's PostgreSQL server: creates the cluster the first time
# (initdb), then starts the server unless it already runs. Run it as root
# (sudo ./start.sh): the server itself runs as the postgres user.
set -e
if grep -qs ' /data ' /proc/mounts; then
	PGDATA=/data/postgres
	where="on the data disk, kept across reboots"
else
	PGDATA=/var/lib/postgresql/data
	where="no data disk: lost at reboot"
fi
LOG=/var/log/postgresql/postgresql.log
# Debian keeps initdb and pg_ctl in /usr/lib/postgresql/<major>/bin.
for d in /usr/lib/postgresql/*/bin; do if [ -x "$d/initdb" ]; then PATH=$d:$PATH; fi; done
if command -v su-exec >/dev/null; then
	pg() { su-exec postgres "$@"; }
else
	pg() { runuser -u postgres -- "$@"; }
fi
# io_method (no I/O worker processes) is new in PostgreSQL 18.
major=$(pg_ctl --version | sed 's/[^0-9]*\([0-9]*\).*/\1/')
aio=
[ "$major" -lt 18 ] || aio="-c io_method=sync"

install -d -o postgres -g postgres -m 2775 /run/postgresql
install -d -o postgres -g postgres -m 750 /var/log/postgresql

if [ ! -f "$PGDATA/PG_VERSION" ]; then
	if [ -e "$PGDATA" ] && ! rmdir "$PGDATA" 2>/dev/null; then
		echo "$PGDATA exists but holds no cluster: move it away and run this again." >&2
		exit 1
	fi
	echo "First run: creating the cluster in $PGDATA ($where)."
	echo "initdb is slower under the emulator than natively; it runs only this once."
	rm -rf "$PGDATA.new"
	install -d -o postgres -g postgres -m 700 "$PGDATA.new"
	pg initdb -D "$PGDATA.new" --username=postgres --auth=trust \
		--encoding=UTF8 --locale-provider=builtin --locale=C.UTF-8 \
		--no-sync --no-instructions \
		-c listen_addresses=127.0.0.1 \
		-c max_connections=10 \
		-c shared_buffers=16MB \
		-c huge_pages=off $aio \
		-c synchronous_commit=off
	mv "$PGDATA.new" "$PGDATA"
	sync
else
	echo "Cluster: $PGDATA ($where)."
fi

pid=$(head -n 1 "$PGDATA/postmaster.pid" 2>/dev/null || true)
if [ -n "$pid" ] && [ "$(cat "/proc/$pid/comm" 2>/dev/null)" = postgres ]; then
	echo "The server is already running (PID $pid)."
	exit 0
fi
rm -f "$PGDATA/postmaster.pid"
if ! pg pg_ctl -D "$PGDATA" -l "$LOG" -w -t 300 start; then
	tail -n 20 "$LOG"
	exit 1
fi
`;

const SEED_SH = String.raw`#!/bin/sh
# Creates the demo database and its tables the first time; later runs keep
# what is there. dropdb -U postgres demo, then ./run.sh, starts over.
set -e
cd "$(dirname "$0")"
for d in /usr/lib/postgresql/*/bin; do if [ -x "$d/psql" ]; then PATH=$d:$PATH; fi; done
export PGUSER=postgres
[ "$(psql -XtAc "SELECT 1 FROM pg_database WHERE datname = 'demo'" postgres)" = 1 ] || createdb demo
if [ "$(psql -XtAc "SELECT to_regclass('public.missions') IS NOT NULL" demo)" = t ]; then
	echo "The demo database is already seeded."
else
	echo "Seeding the demo database: planets and space missions."
	psql -X -q -1 -v ON_ERROR_STOP=1 -f seed.sql demo
fi
`;

const SEED_SQL = String.raw`-- The demo's data: the Sun's planets (and Pluto) and some of the missions
-- sent to them. Run once by seed.sh, in one transaction.
CREATE TYPE world_kind AS ENUM ('terrestrial', 'gas giant', 'ice giant', 'dwarf planet');

CREATE TABLE planets (
	name text PRIMARY KEY,
	kind world_kind NOT NULL,
	moons int NOT NULL,                 -- known moons (2025; the count keeps growing)
	distance_au numeric(6, 3) NOT NULL, -- mean distance from the Sun
	orbit_days numeric(8, 1) NOT NULL,  -- one year there, in Earth days
	radius_km int NOT NULL
);

INSERT INTO planets VALUES
	('Mercury', 'terrestrial',    0,  0.387,    88.0,  2440),
	('Venus',   'terrestrial',    0,  0.723,   224.7,  6052),
	('Earth',   'terrestrial',    1,  1.000,   365.3,  6371),
	('Mars',    'terrestrial',    2,  1.524,   687.0,  3390),
	('Jupiter', 'gas giant',     97,  5.203,  4332.6, 69911),
	('Saturn',  'gas giant',    274,  9.537, 10759.2, 58232),
	('Uranus',  'ice giant',     29, 19.191, 30688.5, 25362),
	('Neptune', 'ice giant',     16, 30.069, 60195.0, 24622),
	('Pluto',   'dwarf planet',   5, 39.482, 90560.0,  1188);

CREATE TABLE missions (
	id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	name text NOT NULL UNIQUE,
	agency text NOT NULL,
	launched date NOT NULL,
	target text NOT NULL REFERENCES planets, -- the main target
	details jsonb NOT NULL DEFAULT '{}'      -- type, firsts, also (other worlds visited), carried
);

INSERT INTO missions (name, agency, launched, target, details) VALUES
	('Mariner 2',      'NASA',  '1962-08-27', 'Venus',   '{"type": "flyby", "firsts": ["first successful planetary flyby"]}'),
	('Mariner 4',      'NASA',  '1964-11-28', 'Mars',    '{"type": "flyby", "firsts": ["first close-up photos of another planet"]}'),
	('Venera 7',       'USSR',  '1970-08-17', 'Venus',   '{"type": "lander", "firsts": ["first soft landing on another planet", "first data sent from another planet''s surface"]}'),
	('Pioneer 10',     'NASA',  '1972-03-03', 'Jupiter', '{"type": "flyby", "firsts": ["first spacecraft through the asteroid belt", "first Jupiter flyby"]}'),
	('Viking 1',       'NASA',  '1975-08-20', 'Mars',    '{"type": "orbiter", "carried": ["Viking 1 lander"], "firsts": ["first Mars landing to complete its mission"]}'),
	('Voyager 2',      'NASA',  '1977-08-20', 'Neptune', '{"type": "flyby", "also": ["Jupiter", "Saturn", "Uranus"], "firsts": ["first Uranus flyby", "first Neptune flyby"]}'),
	('Voyager 1',      'NASA',  '1977-09-05', 'Saturn',  '{"type": "flyby", "also": ["Jupiter"], "firsts": ["first spacecraft in interstellar space"]}'),
	('Galileo',        'NASA',  '1989-10-18', 'Jupiter', '{"type": "orbiter", "also": ["Venus", "Earth"], "carried": ["Galileo probe"], "firsts": ["first Jupiter orbiter", "first probe into a giant planet''s atmosphere"]}'),
	('Cassini',        'NASA',  '1997-10-15', 'Saturn',  '{"type": "orbiter", "partners": ["ESA", "ASI"], "also": ["Venus", "Earth", "Jupiter"], "carried": ["Huygens probe"], "firsts": ["first Saturn orbiter", "first landing in the outer solar system (Titan)"]}'),
	('MESSENGER',      'NASA',  '2004-08-03', 'Mercury', '{"type": "orbiter", "also": ["Earth", "Venus"], "firsts": ["first Mercury orbiter"]}'),
	('New Horizons',   'NASA',  '2006-01-19', 'Pluto',   '{"type": "flyby", "also": ["Jupiter"], "firsts": ["first Pluto flyby"]}'),
	('Akatsuki',       'JAXA',  '2010-05-20', 'Venus',   '{"type": "orbiter"}'),
	('Juno',           'NASA',  '2011-08-05', 'Jupiter', '{"type": "orbiter", "also": ["Earth"], "firsts": ["first solar-powered spacecraft at Jupiter"]}'),
	('Curiosity',      'NASA',  '2011-11-26', 'Mars',    '{"type": "rover"}'),
	('Mangalyaan',     'ISRO',  '2013-11-05', 'Mars',    '{"type": "orbiter"}'),
	('Hope',           'UAESA', '2020-07-19', 'Mars',    '{"type": "orbiter", "firsts": ["first Arab interplanetary mission"]}'),
	('Tianwen-1',      'CNSA',  '2020-07-23', 'Mars',    '{"type": "orbiter", "carried": ["Zhurong rover"]}'),
	('Perseverance',   'NASA',  '2020-07-30', 'Mars',    '{"type": "rover", "carried": ["Ingenuity helicopter"], "firsts": ["first powered flight on another planet (Ingenuity)", "first oxygen made on Mars (MOXIE)"]}'),
	('JUICE',          'ESA',   '2023-04-14', 'Jupiter', '{"type": "orbiter", "also": ["Earth", "Venus"]}'),
	('Europa Clipper', 'NASA',  '2024-10-14', 'Jupiter', '{"type": "orbiter", "also": ["Mars"]}');
`;

const SHOWCASE = String.raw`-- A few queries over the demo database, run by run.sh before the psql session.
\pset linestyle unicode
\pset border 2
\pset format wrapped

\echo
\echo '── The server: version() and where it keeps its data'
\x on
SELECT version(),
	current_setting('data_directory') AS data_directory,
	pg_size_pretty(pg_database_size(current_database())) AS database_size,
	date_trunc('second', now() - pg_postmaster_start_time()) AS server_uptime;
\x off

\echo
\echo '── Window functions: rank(), a share of sum() OVER (), lag() to the previous planet'
SELECT name, kind, moons,
	rank() OVER (ORDER BY moons DESC) AS moon_rank,
	round(100.0 * moons / sum(moons) OVER (), 1) AS "% of moons",
	distance_au - lag(distance_au) OVER (ORDER BY distance_au) AS "AU past previous"
FROM planets
ORDER BY distance_au;

\echo
\echo '── JSONB: every "first" in the missions'' details, unnested'
SELECT m.name, extract(year FROM m.launched)::int AS year, m.details->>'type' AS type, f.achievement AS first
FROM missions m, jsonb_array_elements_text(m.details->'firsts') AS f(achievement)
ORDER BY m.launched;

\echo
\echo '── generate_series(): launches per decade, the empty 1950s included'
SELECT d.year || 's' AS decade, count(m.id) AS launches, repeat('■', count(m.id)::int) AS chart
FROM generate_series(1950, 2020, 10) AS d(year)
LEFT JOIN missions m ON extract(year FROM m.launched)::int / 10 * 10 = d.year
GROUP BY d.year
ORDER BY d.year;

\echo
\echo '── A CTE: visits to each world, counting the flybys on the way to another target'
WITH visits AS (
	SELECT target AS world, name, launched FROM missions
	UNION ALL
	SELECT a.world, m.name, m.launched
	FROM missions m, jsonb_array_elements_text(m.details->'also') AS a(world)
)
SELECT p.name AS world, count(v.name) AS visits,
	string_agg(v.name, ', ' ORDER BY v.launched) AS missions
FROM planets p
LEFT JOIN visits v ON v.world = p.name
GROUP BY p.name, p.distance_au
ORDER BY visits DESC, p.distance_au;
`;

const PSQLRC = String.raw`-- psql's settings for the demo session (run.sh sets PSQLRC=psqlrc).
\set QUIET 1
\pset linestyle unicode
\pset border 2
\pset format wrapped
\pset null '∅'
\timing on
\unset QUIET
\echo
\echo 'Connected to the demo database as postgres. Try:'
\echo '  \\dt+                                     the tables'
\echo '  \\d missions                              a table''s columns'
\echo '  SELECT name, target FROM missions WHERE details @> ''{"type": "rover"}'';'
\echo '  SELECT name, round((current_date - date ''2000-01-01'') / orbit_days, 1) AS age FROM planets;'
\echo '                                           your age on each planet, if born in 2000'
\echo '  \\i mandelbrot.sql                        a fractal drawn by a recursive CTE'
\echo '  \\q quits; the server keeps running, and ./run.sh connects again'
\echo
`;

const MANDELBROT = String.raw`-- The Mandelbrot set, 60 x 25 characters, in SQL: a recursive CTE iterates
-- z = z² + c for every point, up to 30 times. \i mandelbrot.sql in psql.
WITH RECURSIVE z(ix, iy, cx, cy, x, y, i) AS (
	SELECT ix, iy, (-2.1 + ix * 0.045)::float8, (-1.2 + iy * 0.1)::float8, 0::float8, 0::float8, 0
	FROM generate_series(0, 59) AS ix, generate_series(0, 24) AS iy
	UNION ALL
	SELECT ix, iy, cx, cy, x * x - y * y + cx, 2 * x * y + cy, i + 1
	FROM z
	WHERE x * x + y * y < 4 AND i < 30
),
points AS (
	SELECT ix, iy, max(i) AS n FROM z GROUP BY ix, iy
)
SELECT string_agg(CASE WHEN n = 30 THEN '@' ELSE substr(' .:-=+*#%', n / 4 + 1, 1) END, '' ORDER BY ix) AS mandelbrot
FROM points
GROUP BY iy
ORDER BY iy;
`;

export default {
	id: "postgres",
	title: "PostgreSQL",
	desc: "A PostgreSQL server with a seeded database, showcase queries and a psql session",
	// The PostgreSQL elephant, from Simple Icons (CC0 1.0), slug postgresql.
	icon: { svg: '<path d="M23.5594 14.7228a.5269.5269 0 0 0-.0563-.1191c-.139-.2632-.4768-.3418-1.0074-.2321-1.6533.3411-2.2935.1312-2.5256-.0191 1.342-2.0482 2.445-4.522 3.0411-6.8297.2714-1.0507.7982-3.5237.1222-4.7316a1.5641 1.5641 0 0 0-.1509-.235C21.6931.9086 19.8007.0248 17.5099.0005c-1.4947-.0158-2.7705.3461-3.1161.4794a9.449 9.449 0 0 0-.5159-.0816 8.044 8.044 0 0 0-1.3114-.1278c-1.1822-.0184-2.2038.2642-3.0498.8406-.8573-.3211-4.7888-1.645-7.2219.0788C.9359 2.1526.3086 3.8733.4302 6.3043c.0409.818.5069 3.334 1.2423 5.7436.4598 1.5065.9387 2.7019 1.4334 3.582.553.9942 1.1259 1.5933 1.7143 1.7895.4474.1491 1.1327.1441 1.8581-.7279.8012-.9635 1.5903-1.8258 1.9446-2.2069.4351.2355.9064.3625 1.39.3772a.0569.0569 0 0 0 .0004.0041 11.0312 11.0312 0 0 0-.2472.3054c-.3389.4302-.4094.5197-1.5002.7443-.3102.064-1.1344.2339-1.1464.8115-.0025.1224.0329.2309.0919.3268.2269.4231.9216.6097 1.015.6331 1.3345.3335 2.5044.092 3.3714-.6787-.017 2.231.0775 4.4174.3454 5.0874.2212.5529.7618 1.9045 2.4692 1.9043.2505 0 .5263-.0291.8296-.0941 1.7819-.3821 2.5557-1.1696 2.855-2.9059.1503-.8707.4016-2.8753.5388-4.1012.0169-.0703.0357-.1207.057-.1362.0007-.0005.0697-.0471.4272.0307a.3673.3673 0 0 0 .0443.0068l.2539.0223.0149.001c.8468.0384 1.9114-.1426 2.5312-.4308.6438-.2988 1.8057-1.0323 1.5951-1.6698zM2.371 11.8765c-.7435-2.4358-1.1779-4.8851-1.2123-5.5719-.1086-2.1714.4171-3.6829 1.5623-4.4927 1.8367-1.2986 4.8398-.5408 6.108-.13-.0032.0032-.0066.0061-.0098.0094-2.0238 2.044-1.9758 5.536-1.9708 5.7495-.0002.0823.0066.1989.0162.3593.0348.5873.0996 1.6804-.0735 2.9184-.1609 1.1504.1937 2.2764.9728 3.0892.0806.0841.1648.1631.2518.2374-.3468.3714-1.1004 1.1926-1.9025 2.1576-.5677.6825-.9597.5517-1.0886.5087-.3919-.1307-.813-.5871-1.2381-1.3223-.4796-.839-.9635-2.0317-1.4155-3.5126zm6.0072 5.0871c-.1711-.0428-.3271-.1132-.4322-.1772.0889-.0394.2374-.0902.4833-.1409 1.2833-.2641 1.4815-.4506 1.9143-1.0002.0992-.126.2116-.2687.3673-.4426a.3549.3549 0 0 0 .0737-.1298c.1708-.1513.2724-.1099.4369-.0417.156.0646.3078.26.3695.4752.0291.1016.0619.2945-.0452.4444-.9043 1.2658-2.2216 1.2494-3.1676 1.0128zm2.094-3.988-.0525.141c-.133.3566-.2567.6881-.3334 1.003-.6674-.0021-1.3168-.2872-1.8105-.8024-.6279-.6551-.9131-1.5664-.7825-2.5004.1828-1.3079.1153-2.4468.079-3.0586-.005-.0857-.0095-.1607-.0122-.2199.2957-.2621 1.6659-.9962 2.6429-.7724.4459.1022.7176.4057.8305.928.5846 2.7038.0774 3.8307-.3302 4.7363-.084.1866-.1633.3629-.2311.5454zm7.3637 4.5725c-.0169.1768-.0358.376-.0618.5959l-.146.4383a.3547.3547 0 0 0-.0182.1077c-.0059.4747-.054.6489-.115.8693-.0634.2292-.1353.4891-.1794 1.0575-.11 1.4143-.8782 2.2267-2.4172 2.5565-1.5155.3251-1.7843-.4968-2.0212-1.2217a6.5824 6.5824 0 0 0-.0769-.2266c-.2154-.5858-.1911-1.4119-.1574-2.5551.0165-.5612-.0249-1.9013-.3302-2.6462.0044-.2932.0106-.5909.019-.8918a.3529.3529 0 0 0-.0153-.1126 1.4927 1.4927 0 0 0-.0439-.208c-.1226-.4283-.4213-.7866-.7797-.9351-.1424-.059-.4038-.1672-.7178-.0869.067-.276.1831-.5875.309-.9249l.0529-.142c.0595-.16.134-.3257.213-.5012.4265-.9476 1.0106-2.2453.3766-5.1772-.2374-1.0981-1.0304-1.6343-2.2324-1.5098-.7207.0746-1.3799.3654-1.7088.5321a5.6716 5.6716 0 0 0-.1958.1041c.0918-1.1064.4386-3.1741 1.7357-4.4823a4.0306 4.0306 0 0 1 .3033-.276.3532.3532 0 0 0 .1447-.0644c.7524-.5706 1.6945-.8506 2.802-.8325.4091.0067.8017.0339 1.1742.081 1.939.3544 3.2439 1.4468 4.0359 2.3827.8143.9623 1.2552 1.9315 1.4312 2.4543-1.3232-.1346-2.2234.1268-2.6797.779-.9926 1.4189.543 4.1729 1.2811 5.4964.1353.2426.2522.4522.2889.5413.2403.5825.5515.9713.7787 1.2552.0696.087.1372.1714.1885.245-.4008.1155-1.1208.3825-1.0552 1.717-.0123.1563-.0423.4469-.0834.8148-.0461.2077-.0702.4603-.0994.7662zm.8905-1.6211c-.0405-.8316.2691-.9185.5967-1.0105a2.8566 2.8566 0 0 0 .135-.0406 1.202 1.202 0 0 0 .1342.103c.5703.3765 1.5823.4213 3.0068.1344-.2016.1769-.5189.3994-.9533.6011-.4098.1903-1.0957.333-1.7473.3636-.7197.0336-1.0859-.0807-1.1721-.151zm.5695-9.2712c-.0059.3508-.0542.6692-.1054 1.0017-.055.3576-.112.7274-.1264 1.1762-.0142.4368.0404.8909.0932 1.3301.1066.887.216 1.8003-.2075 2.7014a3.5272 3.5272 0 0 1-.1876-.3856c-.0527-.1276-.1669-.3326-.3251-.6162-.6156-1.1041-2.0574-3.6896-1.3193-4.7446.3795-.5427 1.3408-.5661 2.1781-.463zm.2284 7.0137a12.3762 12.3762 0 0 0-.0853-.1074l-.0355-.0444c.7262-1.1995.5842-2.3862.4578-3.4385-.0519-.4318-.1009-.8396-.0885-1.2226.0129-.4061.0666-.7543.1185-1.0911.0639-.415.1288-.8443.1109-1.3505.0134-.0531.0188-.1158.0118-.1902-.0457-.4855-.5999-1.938-1.7294-3.253-.6076-.7073-1.4896-1.4972-2.6889-2.0395.5251-.1066 1.2328-.2035 2.0244-.1859 2.0515.0456 3.6746.8135 4.8242 2.2824a.908.908 0 0 1 .0667.1002c.7231 1.3556-.2762 6.2751-2.9867 10.5405zm-8.8166-6.1162c-.025.1794-.3089.4225-.6211.4225a.5821.5821 0 0 1-.0809-.0056c-.1873-.026-.3765-.144-.5059-.3156-.0458-.0605-.1203-.178-.1055-.2844.0055-.0401.0261-.0985.0925-.1488.1182-.0894.3518-.1226.6096-.0867.3163.0441.6426.1938.6113.4186zm7.9305-.4114c.0111.0792-.049.201-.1531.3102-.0683.0717-.212.1961-.4079.2232a.5456.5456 0 0 1-.075.0052c-.2935 0-.5414-.2344-.5607-.3717-.024-.1765.2641-.3106.5611-.352.297-.0414.6111.0088.6356.1851z"/>' },
	colors: ["#4a83d4", "#1b3566"],
	needs: { net: true },
	files: {
		"start.sh": { content: START, mode: 0o755 },
		"seed.sh": { content: SEED_SH, mode: 0o755 },
		"seed.sql": SEED_SQL,
		"showcase.sql": SHOWCASE,
		"psqlrc": PSQLRC,
		"mandelbrot.sql": MANDELBROT,
		// Debian: no cluster of the package's own at install (postgresql-common).
		"/etc/postgresql-common/createcluster.d/kw-demo.conf": "# The unkernel PostgreSQL demo makes its own cluster (start.sh).\ncreate_main_cluster = false\n",
	},
	packages: { alpine: ["postgresql18", "su-exec"], debian: ["postgresql"] },
	commands: [
		"$SUDO ./start.sh",
		"./seed.sh",
		"psql -U postgres -X -q -P pager=off -f showcase.sql demo",
		"PSQLRC=psqlrc psql -U postgres demo",
	],
} satisfies TerminalApp;
