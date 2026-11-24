// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
/*
 * kwvsock: a byte pipe over AF_VSOCK (static aarch64 musl), `kwbox
 * vsock` in the base's kw layer (kwbox.c). The SDK's vsock test
 * (test/api.test.ts) drives it.
 *
 *   kwvsock connect PORT [CID]   connect to CID (default 2, the host), PORT
 *   kwvsock listen PORT          accept one connection on PORT (any CID); says
 *                                "kwvsock: listening on port PORT" on stderr first
 *
 * Then stdin goes to the socket and the socket to stdout, both at once (the
 * socket is non-blocking, so a peer that waits for us to read never stalls
 * our writes): stdin's EOF shuts down the socket's sending side
 * (shutdown(SHUT_WR)), and it ends once the peer has done the same. Exit 0,
 * or 1 with the failed call and errno's text on stderr, e.g.
 * "kwvsock: connect: Connection reset by peer" or "kwvsock: send: Broken pipe".
 */
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>
#include <linux/vm_sockets.h>

static int fail(const char *what)
{
	fprintf(stderr, "kwvsock: %s: %s\n", what, strerror(errno));
	return 1;
}

static int usage(void)
{
	fprintf(stderr, "usage: kwbox vsock connect PORT [CID] | kwbox vsock listen PORT\n");
	return 2;
}

static int pipe_loop(int s)
{
	static char in[65536], out[65536];
	size_t have = 0, at = 0;
	int in_eof = 0, sock_eof = 0, shut = 0;

	fcntl(s, F_SETFL, fcntl(s, F_GETFL) | O_NONBLOCK);
	while (!sock_eof || !shut) {
		struct pollfd p[2] = { { .fd = 0, .events = 0 }, { .fd = s, .events = 0 } };

		if (in_eof && have == at && !shut) {
			if (shutdown(s, SHUT_WR))
				return fail("shutdown");
			shut = 1;
			continue;
		}
		if (!in_eof && have == at)
			p[0].events = POLLIN;
		if (have > at)
			p[1].events |= POLLOUT;
		if (!sock_eof)
			p[1].events |= POLLIN;
		/* POLLHUP is reported even when nothing is asked: leave the fd out then. */
		for (int i = 0; i < 2; i++)
			if (!p[i].events)
				p[i].fd = -1;
		if (poll(p, 2, -1) < 0) {
			if (errno == EINTR)
				continue;
			return fail("poll");
		}
		if (p[0].revents & (POLLIN | POLLHUP | POLLERR)) {
			ssize_t n = read(0, in, sizeof(in));

			if (n < 0 && errno != EINTR && errno != EAGAIN)
				return fail("read stdin");
			if (n == 0)
				in_eof = 1;
			if (n > 0) {
				have = n;
				at = 0;
			}
		}
		if (p[1].revents & POLLOUT || (have > at && p[1].revents & (POLLERR | POLLHUP))) {
			ssize_t n = send(s, in + at, have - at, MSG_NOSIGNAL);

			if (n < 0 && errno != EAGAIN && errno != EINTR)
				return fail("send");
			if (n > 0)
				at += n;
		}
		if (p[1].revents & (POLLIN | POLLHUP | POLLERR) && !sock_eof) {
			ssize_t n = recv(s, out, sizeof(out), 0);

			if (n < 0 && errno != EAGAIN && errno != EINTR)
				return fail("recv");
			if (n == 0)
				sock_eof = 1;
			for (ssize_t done = 0; n > 0 && done < n;) {
				ssize_t w = write(1, out + done, n - done);

				if (w < 0)
					return fail("write stdout");
				done += w;
			}
		}
	}
	return 0;
}

int main(int argc, char **argv)
{
	struct sockaddr_vm a = { .svm_family = AF_VSOCK };
	int s, rc;

	if (argc < 3)
		return usage();
	a.svm_port = strtoul(argv[2], NULL, 0);
	s = socket(AF_VSOCK, SOCK_STREAM, 0);
	if (s < 0)
		return fail("socket");
	if (!strcmp(argv[1], "connect")) {
		a.svm_cid = argc > 3 ? strtoul(argv[3], NULL, 0) : VMADDR_CID_HOST;
		if (connect(s, (struct sockaddr *)&a, sizeof(a)))
			return fail("connect");
	} else if (!strcmp(argv[1], "listen")) {
		int c;

		a.svm_cid = VMADDR_CID_ANY;
		if (bind(s, (struct sockaddr *)&a, sizeof(a)))
			return fail("bind");
		if (listen(s, 1))
			return fail("listen");
		fprintf(stderr, "kwvsock: listening on port %u\n", a.svm_port);
		c = accept(s, NULL, NULL);
		if (c < 0)
			return fail("accept");
		close(s);
		s = c;
	} else {
		return usage();
	}
	rc = pipe_loop(s);
	close(s);
	return rc;
}
