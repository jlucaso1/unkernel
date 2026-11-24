// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
/*
 * kwshm: export a shmem file to the host through /dev/kwshm (static aarch64
 * musl), `kwbox shm` in the base's kw layer (kwbox.c). The SDK's shm
 * test (test/api.test.ts) drives it.
 *
 *   kwshm memfd SIZE [SEED]     a memfd of SIZE bytes filled with the test
 *                               pattern (byte i: x = x * 1103515245 + 12345,
 *                               x >> 24, x starting at SEED, default 1)
 *   kwshm export FILE [-u] [-r] [-o OFFSET] [-l LENGTH]
 *                               an existing file; -u unlinks it after opening
 *                               it, -r exports it read-only for the host,
 *                               -o/-l export a range (page-aligned offset)
 *
 * It prints "kwshm: id=N size=BYTES pages=N fnv=XXXXXXXX" (FNV-1a 32 of the
 * exported bytes), then reads commands from stdin, one per line:
 *   (empty line)     print "kwshm: fnv=XXXXXXXX size=BYTES" of the file now
 *   truncate N       ftruncate the file to N bytes
 *   release          KWSHM_IOC_RELEASE, prints "kwshm: released"
 *   q, or EOF        exit 0 (closing /dev/kwshm releases the export)
 * Errors print "kwshm: WHAT: strerror" and exit 1.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/sysmacros.h>
#include <unistd.h>

/* From the kernel's include/uapi/linux/kwshm.h. */
#define KWSHM_EXPORT_RDONLY	(1U << 0)
struct kwshm_export {
	int32_t fd;
	uint32_t flags;
	uint64_t offset;
	uint64_t length;
	uint64_t size;
	uint32_t id;
	uint32_t pages;
};
#define KWSHM_IOC_EXPORT	_IOWR(0xBB, 0x00, struct kwshm_export)
#define KWSHM_IOC_RELEASE	_IOW(0xBB, 0x01, uint32_t)

static int fail(const char *what)
{
	fprintf(stderr, "kwshm: %s: %s\n", what, strerror(errno));
	return 1;
}

static int usage(void)
{
	fprintf(stderr, "usage: kwbox shm memfd SIZE [SEED] | kwbox shm export FILE [-u] [-r] [-o OFFSET] [-l LENGTH]\n");
	return 2;
}

/* /dev/kwshm, or a node made from /proc/misc when /dev has no devtmpfs. */
static int open_kwshm(void)
{
	const char *node = "/tmp/.kwshm-dev";
	char buf[4096], *p;
	unsigned int minor;
	int fd = open("/dev/kwshm", O_RDWR | O_CLOEXEC), n;

	if (fd >= 0 || errno != ENOENT)
		return fd;
	fd = open("/proc/misc", O_RDONLY);
	n = fd < 0 ? -1 : read(fd, buf, sizeof(buf) - 1);
	if (fd >= 0)
		close(fd);
	buf[n > 0 ? n : 0] = 0;
	p = strstr(buf, " kwshm\n");
	while (p && p > buf && p[-1] != '\n')
		p--;
	if (!p || sscanf(p, "%u kwshm", &minor) != 1) {
		errno = ENODEV;
		return -1;
	}
	unlink(node);
	if (mknod(node, S_IFCHR | 0600, makedev(10, minor)))
		return -1;
	fd = open(node, O_RDWR | O_CLOEXEC);
	unlink(node);
	return fd;
}

static uint32_t fnv(int fd, uint64_t off, uint64_t len)
{
	static unsigned char buf[65536];
	uint32_t h = 2166136261u;

	while (len) {
		ssize_t n = pread(fd, buf, len < sizeof(buf) ? len : sizeof(buf), off);

		if (n <= 0)
			break;
		for (ssize_t i = 0; i < n; i++)
			h = (h ^ buf[i]) * 16777619u;
		off += n;
		len -= n;
	}
	return h;
}

int main(int argc, char **argv)
{
	struct kwshm_export e = { 0 };
	char line[256];
	int dev, fd;

	if (argc < 3)
		return usage();
	if (!strcmp(argv[1], "memfd")) {
		uint64_t size = strtoull(argv[2], NULL, 0);
		uint32_t x = argc > 3 ? strtoul(argv[3], NULL, 0) : 1;
		static unsigned char buf[65536];

		fd = memfd_create("kwshm", MFD_CLOEXEC | MFD_ALLOW_SEALING);
		if (fd < 0)
			return fail("memfd_create");
		if (ftruncate(fd, size))
			return fail("ftruncate");
		for (uint64_t at = 0; at < size;) {
			size_t n = size - at < sizeof(buf) ? size - at : sizeof(buf);

			for (size_t i = 0; i < n; i++)
				buf[i] = (x = x * 1103515245u + 12345u) >> 24;
			if (pwrite(fd, buf, n, at) != (ssize_t)n)
				return fail("write");
			at += n;
		}
	} else if (!strcmp(argv[1], "export")) {
		int unl = 0, opt;

		optind = 3;
		while ((opt = getopt(argc, argv, "uro:l:")) != -1) {
			switch (opt) {
			case 'u': unl = 1; break;
			case 'r': e.flags |= KWSHM_EXPORT_RDONLY; break;
			case 'o': e.offset = strtoull(optarg, NULL, 0); break;
			case 'l': e.length = strtoull(optarg, NULL, 0); break;
			default: return usage();
			}
		}
		fd = open(argv[2], O_RDWR | O_CLOEXEC);
		if (fd < 0)
			return fail("open");
		if (unl && unlink(argv[2]))
			return fail("unlink");
	} else {
		return usage();
	}
	dev = open_kwshm();
	if (dev < 0)
		return fail("open /dev/kwshm");
	e.fd = fd;
	if (ioctl(dev, KWSHM_IOC_EXPORT, &e))
		return fail("export");
	printf("kwshm: id=%u size=%llu pages=%u fnv=%08x\n", e.id, (unsigned long long)e.size,
	       e.pages, fnv(fd, e.offset, e.size));
	fflush(stdout);
	while (fgets(line, sizeof(line), stdin)) {
		struct stat st;

		line[strcspn(line, "\r\n")] = 0;
		if (!strcmp(line, "q"))
			break;
		if (!strncmp(line, "truncate ", 9)) {
			if (ftruncate(fd, strtoull(line + 9, NULL, 0)))
				return fail("ftruncate");
		} else if (!strcmp(line, "release")) {
			if (ioctl(dev, KWSHM_IOC_RELEASE, &e.id))
				return fail("release");
			printf("kwshm: released\n");
		} else if (!line[0]) {
			if (fstat(fd, &st))
				return fail("fstat");
			printf("kwshm: fnv=%08x size=%llu\n", fnv(fd, 0, st.st_size), (unsigned long long)st.st_size);
		} else {
			fprintf(stderr, "kwshm: unknown command: %s\n", line);
		}
		fflush(stdout);
	}
	return 0;
}
