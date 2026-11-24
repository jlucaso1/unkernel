// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// X11 apps as one window on the page's Wayland desktop (wayland.ts; Debian):
// Xwayland rootful, a whole X screen in a Wayland window of its own, with
// twm managing the X windows inside it. Rootless Xwayland (each X window a
// Wayland window: xwayland-satellite) needs a binary that neither Debian nor
// upstream ships, so the apps here take the rootful server Debian has
// (xwayland 24.1). -shm: its buffers go through wl_shm, which the page reads
// in place through kwshm like any other window (no glamor, so GL in it is
// software); -decorate: its window is decorated through libdecor, which
// takes the server-side decorations the page asks wland for (the page's
// window frame), else draws a title bar with the cairo plugin (a compositor
// that answers client-side, as wland does by default). It takes the first free display from :1 (:0 is the
// X on the DRM device, xkms.ts), and stops when the client ends.

/** What an app that runs XWL_SH puts in its `packages`. */
export const XWL_PACKAGES = ["xwayland", "twm", "x11-xserver-utils", "libdecor-0-plugin-1-cairo"];

/** Its first command: X's socket directory as X wants it (root's, 1777), where nothing made it yet. */
export const XWL_PREP = "[ -d /tmp/.X11-unix ] || $SUDO install -d -m 1777 /tmp/.X11-unix";

/** The script (as an app file, mode 0o755): `./xwl.sh [-g WxH] CLIENT [ARGS...]`. */
export const XWL_SH = `#!/bin/sh
# Start Xwayland rootful (one window on the page, WxH: -g, default
# 1024x700), twm in it (./twmrc where there is one) unless XWL_NO_WM is
# set (CLIENT runs the window manager itself), then CLIENT with DISPLAY set and the toolkits sent to X; stop X when
# CLIENT ends (Ctrl-C in this terminal, or the client's own quit).
set -e
size=1024x700
[ "\${1-}" = -g ] && { size=$2; shift 2; }
[ -n "\${WAYLAND_DISPLAY:-}" ] || { echo "no Wayland session: X shows as a window in the unkernel page (wland)"; exit 1; }
n=1
while [ -e /tmp/.X11-unix/X$n ] || [ -e /tmp/.X$n-lock ]; do n=$((n + 1)); done
log=\${XDG_RUNTIME_DIR:-/tmp}/xwayland.$n.log
Xwayland :$n -geometry "$size" -decorate -shm -noreset -nolisten tcp >"$log" 2>&1 &
x=$!
trap 'kill $x 2>/dev/null || true' EXIT
trap 'exit 130' INT TERM
i=0
until [ -S /tmp/.X11-unix/X$n ]; do
	kill -0 $x 2>/dev/null || { tail -n 5 "$log"; echo "Xwayland exited ($log)"; exit 1; }
	i=$((i + 1))
	[ $i -gt 150 ] && { echo "Xwayland did not start ($log)"; exit 1; }
	sleep 0.2
done
export DISPLAY=:$n SDL_VIDEODRIVER=x11 GDK_BACKEND=x11 QT_QPA_PLATFORM=xcb XDG_SESSION_TYPE=x11
unset WAYLAND_DISPLAY
# The root window's pointer is the kw layer's (its Xwayland wrapper).
xsetroot -solid '#1e293b' || true
rc=
[ -f twmrc ] && rc="-f twmrc"
[ -n "\${XWL_NO_WM:-}" ] || twm $rc &
echo "$1 on X :$n, in a window on the page: Ctrl-C here stops it and X"
"$@"
`;

/** twm's look and its root menu (left click on the X screen), for ./twmrc. */
export const XWL_TWMRC = `# twm in the page's Xwayland window: flat, dark; a left click on the
# desktop opens the menu. Core fonts: X's built-in "fixed", for each of
# twm's fonts (its default, "variable", is in xfonts-75dpi, and twm exits
# when it cannot open one).
NoGrabServer
RandomPlacement
UsePPosition "on"
DecorateTransients
NoHighlight
BorderWidth 1
TitleFont "fixed"
MenuFont "fixed"
IconFont "fixed"
ResizeFont "fixed"
IconManagerFont "fixed"
Color {
	BorderColor "#475569"
	DefaultBackground "#0f172a"
	DefaultForeground "#e2e8f0"
	TitleBackground "#334155"
	TitleForeground "#f8fafc"
	MenuBackground "#0f172a"
	MenuForeground "#e2e8f0"
	MenuTitleBackground "#2563eb"
	MenuTitleForeground "#ffffff"
	IconBackground "#334155"
	IconForeground "#f8fafc"
}
Button1 = : root : f.menu "x11"
Button3 = : root : f.menu "x11"
Button1 = m : window|icon : f.move
Button3 = m : window|icon : f.lower
menu "x11" {
	"X11"		f.title
	"xterm"		f.exec "xterm -fa Monospace -fs 11 -bg '#0f172a' -fg '#e2e8f0' &"
	"xclock"	f.exec "xclock -update 1 &"
	"xeyes"		f.exec "xeyes &"
	"xcalc"		f.exec "xcalc &"
	"xpaint"	f.exec "command -v xpaint >/dev/null && xpaint &"
	""		f.nop
	"Raise"		f.raise
	"Lower"		f.lower
	"Iconify"	f.iconify
	"Close"		f.delete
	""		f.nop
	"Quit twm"	f.quit
}
`;
