# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# Pinned inputs of the base initramfs (build.sh), sourced. Static busybox:
# Alpine's busybox-static package (armv8-a, what kwemu runs), from its own
# Alpine release, independent of the Alpine distro image's.
BUSYBOX_ALPINE=3.24
BUSYBOX_STATIC_APK="busybox-static-1.37.0-r31.apk"
BUSYBOX_STATIC_URL="https://dl-cdn.alpinelinux.org/alpine/v$BUSYBOX_ALPINE/main/aarch64/$BUSYBOX_STATIC_APK"
BUSYBOX_STATIC_SHA256=965777e06b94bf11981d5f4ecdfcd577879f4b0dda544294d1dd3f72b217bc75
