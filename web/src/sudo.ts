// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Root in the guest. On the distro images the console, the terminal windows
// and vm.exec() run as the user `user` (home /home/user), who has sudo
// without a password and without a tty; the base shell (no distro image)
// runs as root and has no sudo. Whatever the page or a demo does as root
// goes through this one test, so that it works in both:
// - SUDO_SH sets $SUDO to "sudo", or to nothing where the shell already
//   runs as root or there is no sudo. run.sh starts with it and runs the
//   steps that need root as `$SUDO cmd` (launcher.ts prints them as
//   `sudo cmd`, or as `cmd` where $SUDO is empty), and so does a script
//   that installs packages itself.
// - execAsRoot() is vm.exec() of a script as root, through `sudo -n` (which
//   fails instead of waiting for a password) where that is needed.
// A redirection in a script run as `$SUDO cmd > file` is the caller's, so
// writing a root-owned file goes through `$SUDO tee` or a whole script run
// as root.
import type { ExecOptions, ExecResult, KernelHandle } from "./sdk.ts";

export const SUDO_SH = `if [ "$(id -u)" != 0 ] && command -v sudo >/dev/null 2>&1; then SUDO=sudo; else SUDO=; fi`;

// sh -c AS_ROOT_SH sh SCRIPT ARGS...: SCRIPT as root, with ARGS and stdin.
const AS_ROOT_SH = `${SUDO_SH}
s=$1
shift
exec \${SUDO:+$SUDO -n} /bin/sh -c "$s" sh "$@"`;

/** Run a shell script as root in the guest (see the top of this file), with args as $1... */
export function execAsRoot(vm: KernelHandle, script: string, args: string[] = [], opts?: ExecOptions & { encoding?: "utf8" }): Promise<ExecResult> {
	return vm.exec("/bin/sh", ["-c", AS_ROOT_SH, "sh", script, ...args], opts);
}
