// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
/*
 * kwbox: the kw layer's guest tools as one program (static aarch64 musl),
 * /usr/bin/kwbox in the base's kw layer, so that they share one copy of
 * libc. guest/base/build.sh compiles each tool's source as an object of
 * its own with its main renamed (-Dmain=kwtty_main, ...) and links them
 * with this file; each source still builds alone.
 *
 *   kwbox TOOL [ARG...]   run TOOL: tty (kwtty.c), 9p (kw9p.c), vsock
 *                         (kwvsock.c), shm (kwshm.c), wasi (kwwasi.c), cmd
 *                         (kwcmd.c), vtest (gl/bridge/vtest-bridge.c, the
 *                         guest GL forwarder: vtest clients to the host),
 *                         with argv[0] and the process name (comm) the
 *                         program's own (kwtty, ..., vtest-bridge), so ps,
 *                         top and pidof tell the tools apart and their
 *                         messages keep their names
 *   /usr/lib/kw/kwwasi    kwwasi: binfmt_misc's interpreter for WASI
 *                         programs (/usr/lib/kw/rc registers this path,
 *                         and the kernel passes it as argv[0]; it cannot
 *                         pass a TOOL), a link to kwbox
 *   kwbox growfs DEV DIR  grow the ext4 file system on DEV, mounted at DIR,
 *                         to DEV's size (EXT4_IOC_RESIZE_FS, online); says
 *                         so on stdout when it grew it, nothing when it
 *                         already fills DEV. The base's /init runs it on
 *                         /data, whose disk the host may have made larger
 *                         (the page's Disk size setting)
 *   any other name        kwcmd's host command of that name: the links
 *                         /run/kw/bin/NAME -> /usr/bin/kwbox that
 *                         `kwbox cmd sync` makes (kwcmd.c)
 *
 * So a host command may have any name but kwbox and kwcmd
 * (js/core/commands.ts checkCommandName(), kwcmd.c valid_name()), the
 * tools' names included.
 */
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <linux/fs.h>
#include <sys/ioctl.h>
#include <sys/prctl.h>

#ifndef EXT4_IOC_RESIZE_FS
#define EXT4_IOC_RESIZE_FS _IOW('f', 16, uint64_t)
#endif

typedef int tool_main(int argc, char **argv);
tool_main kwtty_main, kw9p_main, kwvsock_main, kwshm_main, kwwasi_main, kwcmd_main, vtest_bridge_main;

/* kwbox's name for each, and the program's own (argv[0], comm). */
static const struct { const char *name, *prog; tool_main *main; } tools[] = {
	{ "tty", "kwtty", kwtty_main }, { "9p", "kw9p", kw9p_main },
	{ "vsock", "kwvsock", kwvsock_main }, { "shm", "kwshm", kwshm_main },
	{ "wasi", "kwwasi", kwwasi_main }, { "cmd", "kwcmd", kwcmd_main },
	{ "vtest", "vtest-bridge", vtest_bridge_main },
};

static uint32_t le32(const unsigned char *p)
{
	return p[0] | p[1] << 8 | p[2] << 16 | (uint32_t)p[3] << 24;
}

/* kwbox growfs DEV DIR: the superblock (offset 1024 on DEV) gives the
 * block size and count, BLKGETSIZE64 the device's size. */
static int growfs_main(int argc, char **argv)
{
	unsigned char sb[1024];
	uint64_t bytes, old, n;
	uint32_t bs;
	int dev, dir;

	if (argc != 3) {
		fprintf(stderr, "usage: kwbox growfs DEV DIR\n");
		return 2;
	}
	dev = open(argv[1], O_RDONLY | O_CLOEXEC);
	if (dev < 0 || ioctl(dev, BLKGETSIZE64, &bytes) < 0 || pread(dev, sb, sizeof(sb), 1024) != sizeof(sb)) {
		fprintf(stderr, "growfs: %s: %s\n", argv[1], strerror(errno));
		return 1;
	}
	close(dev);
	if (sb[56] != 0x53 || sb[57] != 0xef || le32(sb + 24) > 6) {
		fprintf(stderr, "growfs: %s: not an ext4 file system\n", argv[1]);
		return 1;
	}
	bs = 1024u << le32(sb + 24);
	old = le32(sb + 4) | (le32(sb + 96) & 0x80 /* INCOMPAT_64BIT */ ? (uint64_t)le32(sb + 0x150) << 32 : 0);
	n = bytes / bs;
	if (n <= old)
		return 0;
	dir = open(argv[2], O_RDONLY | O_DIRECTORY | O_CLOEXEC);
	if (dir < 0 || ioctl(dir, EXT4_IOC_RESIZE_FS, &n) < 0) {
		fprintf(stderr, "growfs: %s: %s\n", argv[2], strerror(errno));
		return 1;
	}
	close(dir);
	printf("grew %s from %llu MiB to %llu MiB\n", argv[2],
	       (unsigned long long)(old * bs >> 20), (unsigned long long)(n * bs >> 20));
	return 0;
}

int main(int argc, char **argv)
{
	const char *base = argc ? strrchr(argv[0], '/') : NULL;

	base = base ? base + 1 : argc ? argv[0] : "kwbox";
	if (argc && !strcmp(argv[0], "/usr/lib/kw/kwwasi"))
		return kwwasi_main(argc, argv);
	if (strcmp(base, "kwbox"))
		return kwcmd_main(argc, argv);
	for (size_t i = 0; argc >= 2 && i < sizeof(tools) / sizeof(tools[0]); i++) {
		if (!strcmp(argv[1], tools[i].name)) {
			/* kwcmd tells sync and run from a host command by argv[0]. */
			argv[1] = (char *)tools[i].prog;
			prctl(PR_SET_NAME, tools[i].prog);
			return tools[i].main(argc - 1, argv + 1);
		}
	}
	if (argc >= 2 && !strcmp(argv[1], "growfs"))
		return growfs_main(argc - 1, argv + 1);
	fprintf(stderr, "usage: kwbox TOOL [ARG...], TOOL one of tty 9p vsock shm wasi cmd vtest growfs\n");
	return 2;
}
