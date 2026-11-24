// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Minecraft: Mojang's Minecraft: Java Edition through portablemc (a
// command-line launcher, 4.x from PyPI with pipx), on X in the Display window
// (xkms.ts; Debian). Not a Wayland window: the GLFW that LWJGL bundles is
// X11 only, and the page's Xwayland (xwl.ts) has no GPU GL. Version 1.16.5 by default: the
// last that runs on OpenGL 2 (1.17 and later ask for a 3.2 core profile,
// and guest GL offers 2.1, .agents/gl.md). Mojang ships no aarch64
// natives for it, so portablemc swaps in LWJGL 3.3.1 (--lwjgl), which has
// them; Debian's OpenJDK 21 runs it (Mojang's Java runtimes are x86 only).
// The game, its libraries and assets come from Mojang's servers on the
// first start (a few hundred MiB, into ~/.minecraft); OpenJDK and X are
// the packages. Offline by default (a local player name, single player);
// `-l EMAIL` signs in with a Microsoft account that owns the game.
import type { TerminalApp } from "../types.ts";
import { X_KMS_PACKAGES, X_KMS_SH } from "../xkms.ts";

const README = `Minecraft: Java Edition through portablemc, on X in the Display window.
It runs Minecraft 1.16.5: guest GL is OpenGL 2.1 and 1.17 and later need 3.2.
Turn guest GL on first (Options); without it X has no DRM device to start on.

The first start downloads the game from Mojang (a few hundred MiB, ~/.minecraft)
and is slow: a JVM on an emulated CPU. Single player works offline; servers need
a signed-in account:

  ./x.sh ./mc.sh                     offline, player name "Player"
  MC_USER=Steve ./x.sh ./mc.sh       another name
  ./x.sh ./mc.sh -l you@example.com  sign in with your Microsoft account
  MC_VERSION=1.14.4 ./x.sh ./mc.sh   another version (1.13 to 1.16.5)
  MC_MEM=1536M ./x.sh ./mc.sh        the Java heap (default 1G; the page has 2 GiB)

Arguments to mc.sh go to "portablemc start". F11 toggles full screen, Esc is
the menu; Ctrl-C in this terminal stops the game and X.
`;

const MC_SH = `#!/bin/sh
# Start Minecraft with portablemc: aarch64 LWJGL natives (--lwjgl), the
# system's Java, X's screen size (KW_X_SIZE, from x.sh).
set -e
# The venv's own entry point, not pipx's link in ~/.local/bin: an install cut
# short leaves the venv without either, which a plain pipx install then
# refuses to touch ("already seems to be installed"), hence --force.
PMC="\${PIPX_HOME:-$HOME/.local/share/pipx}/venvs/portablemc/bin/portablemc"
[ -x "$PMC" ] || pipx install --force "portablemc<5"   # 4.x: the CLI this script speaks
JAVA=$(readlink -f "$(command -v java)")
set -- --jvm "$JAVA" --jvm-args="-Xmx\${MC_MEM:-1G} -Xms512M" --lwjgl 3.3.1 \\
	\${KW_X_SIZE:+--resolution "$KW_X_SIZE"} "$@"
case " $* " in *" -l "*|*" --login "*) ;; *) set -- "$@" -u "\${MC_USER:-Player}" ;; esac
exec "$PMC" start "$@" "\${MC_VERSION:-1.16.5}"
`;

export default {
	id: "minecraft",
	title: "Minecraft",
	desc: "Minecraft: Java Edition 1.16.5 through the portablemc launcher (OpenGL, OpenJDK), on X in the Display window",
	// A block, three faces shaded (crafted).
	icon: { svg: '<path d="M12 2 21 7l-9 5-9-5Z"/><path opacity=".75" d="M3 7l9 5v10l-9-5Z"/><path opacity=".5" d="M21 7v10l-9 5V12Z"/>' },
	colors: ["#65a30d", "#422006"],
	needs: { display: true, net: true },
	packages: { debian: ["openjdk-21-jre", "pipx", ...X_KMS_PACKAGES] },
	files: {
		README,
		"x.sh": { content: X_KMS_SH, mode: 0o755 },
		"mc.sh": { content: MC_SH, mode: 0o755 },
	},
	commands: [
		"cat README",
		"./x.sh ./mc.sh",
	],
} satisfies TerminalApp;
