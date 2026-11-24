// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// X.Org on the guest's DRM device, for the apps that need X (Debian): the
// X + glamor demo (gl/xglamor.ts) and the games without a Wayland backend
// that works here (SFML's, and GLEW's glewInit(), which fails without a
// GLX display). The modesetting driver with glamor (the kw layer's
// /etc/X11/kw-kms.conf) shows on the page's Display window, through Mesa's
// virgl driver and the page's WebGL2; there is no window manager, so a
// client's window sits at the top left (KW_X_SIZE, the screen's size, lets a
// client fill it). X follows the page's display size: X hears of a hotplug
// only from udev, which the guest does not have, so the script runs a
// follower that reads the kernel's uevents (perl on netlink) and, on a drm
// hotplug, probes the outputs (a plain xrandr: xrandr's mode changes use
// the outputs' modes as last probed) and sets each connected one's
// preferred mode (xrandr --output NAME --auto; a bare --auto turned the
// output off here).

/** What X needs: an app that runs X_KMS_SH puts these in its `packages`. */
export const X_KMS_PACKAGES = ["xserver-xorg-core", "xserver-xorg-input-evdev", "x11-xserver-utils", "libgl1-mesa-dri", "libglx-mesa0"];

/** The script (as an app file, mode 0o755): `./x.sh CLIENT [ARGS...]`. */
export const X_KMS_SH = `#!/bin/sh
# Start X on /dev/dri/card0 (modesetting + glamor), run CLIENT on it
# (glxgears by default), and stop X when the client ends (Ctrl-C in this
# window, or the client's own quit). The client gets DISPLAY=:0, SDL and
# the toolkits sent to X instead of Wayland, and KW_X_SIZE (WxH).
set -e
stop() { [ -z "$follow" ] || kill "$follow" 2>/dev/null || true; sudo pkill -x Xorg 2>/dev/null || true; }
trap stop EXIT
trap 'exit 130' INT TERM
if [ ! -S /tmp/.X11-unix/X0 ]; then
	sudo sh -c 'Xorg :0 -config kw-kms.conf -nolisten tcp >/tmp/Xorg.kms.out 2>&1 &'
	i=0
	while [ ! -S /tmp/.X11-unix/X0 ]; do
		i=$((i + 1))
		[ $i -gt 120 ] && { echo "X did not start: /var/log/Xorg.0.log, /tmp/Xorg.kms.out"; exit 1; }
		sleep 0.5
	done
	sleep 1
fi
export DISPLAY=:0 SDL_VIDEODRIVER=x11 GDK_BACKEND=x11 QT_QPA_PLATFORM=xcb XDG_SESSION_TYPE=x11
unset WAYLAND_DISPLAY
# Follow the page's display size: X hears of a hotplug only from udev, which
# this guest does not have, so read the kernel's uevents and, on a drm
# hotplug, probe the outputs (a plain xrandr) and give each its preferred mode.
perl -MSocket -e '
socket(my $s, 16, SOCK_DGRAM, 15) or die "uevent socket: $!\\n";  # AF_NETLINK, NETLINK_KOBJECT_UEVENT
bind($s, pack("S S L L", 16, 0, 0, 1)) or die "uevent bind: $!\\n"; # the kernel group
while (defined recv($s, my $m, 8192, 0)) {
	my %e = map { split /=/, $_, 2 } grep { /=/ } split /\\0/, $m;
	next unless ($e{SUBSYSTEM} // "") eq "drm" && ($e{HOTPLUG} // "") eq "1";
	for my $o (map { /^(\\S+) connected/ ? $1 : () } \`xrandr\`) { system("xrandr", "--output", $o, "--auto") }
}' &
follow=$!
KW_X_SIZE=$(xrandr 2>/dev/null | sed -n 's/.* current \\([0-9]*\\) x \\([0-9]*\\),.*/\\1x\\2/p')
export KW_X_SIZE
grep -E 'glamor X acceleration|\\(EE\\) modeset' /var/log/Xorg.0.log || true
! command -v glxinfo >/dev/null || glxinfo -B | grep -E 'OpenGL renderer|OpenGL version|direct rendering' || true
echo "\${1:-glxgears} on X (\${KW_X_SIZE:-?}), in the Display window: Ctrl-C here stops it and X"
"\${@:-glxgears}"
`;
