// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
/*
 * kw9p: mount a file system the host serves over 9P2000.L on AF_VSOCK
 * (static aarch64 musl), `kwbox 9p` in the base's kw layer (kwbox.c).
 * The host side is js/core/9p.ts (the SDK's vm.mount() and
 * createKernel({ mounts }) run kw9p through kwtty).
 *
 *   kw9p NAME MOUNTPOINT [ro]
 *
 * Creates MOUNTPOINT (and its parents) if missing, refuses one that is
 * already a mount point (EBUSY), connects to the host (CID 2, port 564) and
 * mounts 9p with trans=fd on that socket, source "kw9p:NAME":
 *
 *   trans=fd,rfdno=S,wfdno=S,version=9p2000.L,aname=NAME,
 *   cache=readahead,metatimeout=1000,noxattr,access=client,msize=131072
 *
 * metatimeout (kernel patch "9p: add metatimeout") lets the guest reuse
 * names and attributes it has looked up for 1 s before it asks the host
 * again; writes still go to the host at each write(2). The kernel's 9p
 * client holds its own references to the socket, so kw9p exits after the
 * mount; unmounting closes the connection. Exit 0, or 1 with
 * "kw9p: <what>: <error> (errno N)" on stderr (the SDK maps N), 2 for bad
 * usage.
 */
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>
#include <linux/vm_sockets.h>

#define KW9P_PORT 564
#define KW9P_OPTIONS "cache=readahead,metatimeout=1000,noxattr,access=client,msize=131072"

static int fail(const char *what, const char *arg)
{
	int e = errno;

	fprintf(stderr, "kw9p: %s%s%s: %s (errno %d)\n", what, arg ? " " : "", arg ? arg : "", strerror(e), e);
	return 1;
}

/* mkdir -p */
static int mkdirs(char *path)
{
	struct stat st;
	char *p;

	for (p = path + 1; *p; p++) {
		if (*p != '/')
			continue;
		*p = 0;
		if (mkdir(path, 0755) && errno != EEXIST)
			return -1;
		*p = '/';
	}
	if (mkdir(path, 0755) && errno != EEXIST)
		return -1;
	if (stat(path, &st))
		return -1;
	if (!S_ISDIR(st.st_mode)) {
		errno = ENOTDIR;
		return -1;
	}
	return 0;
}

int main(int argc, char **argv)
{
	struct sockaddr_vm a = { .svm_family = AF_VSOCK, .svm_cid = VMADDR_CID_HOST, .svm_port = KW9P_PORT };
	const char *name, *dir;
	char data[256], source[128], path[4096];
	unsigned long flags = 0;
	struct stat st, pst;
	int s;

	if (argc < 3 || argc > 4 || (argc == 4 && strcmp(argv[3], "ro")) || !*argv[1] ||
	    strchr(argv[1], ',') || strlen(argv[1]) > 64 || argv[2][0] != '/' || strlen(argv[2]) >= sizeof(path) - 4) {
		fprintf(stderr, "usage: kwbox 9p NAME MOUNTPOINT [ro]\n");
		return 2;
	}
	name = argv[1];
	dir = argv[2];
	if (argc == 4)
		flags |= MS_RDONLY;

	strcpy(path, dir);
	if (mkdirs(path))
		return fail("mkdir", dir);
	snprintf(path, sizeof(path), "%s/..", dir);
	if (stat(dir, &st) || stat(path, &pst))
		return fail("stat", dir);
	if (st.st_dev != pst.st_dev || st.st_ino == pst.st_ino) {
		errno = EBUSY;
		return fail("already a mount point:", dir);
	}

	s = socket(AF_VSOCK, SOCK_STREAM | SOCK_CLOEXEC, 0);
	if (s < 0)
		return fail("socket", NULL);
	if (connect(s, (struct sockaddr *)&a, sizeof(a)))
		return fail("connect to the host's 9p server", NULL);
	snprintf(data, sizeof(data), "trans=fd,rfdno=%d,wfdno=%d,version=9p2000.L,aname=%s," KW9P_OPTIONS, s, s, name);
	snprintf(source, sizeof(source), "kw9p:%s", name);
	if (mount(source, dir, "9p", flags, data))
		return fail("mount", name);
	return 0;
}
