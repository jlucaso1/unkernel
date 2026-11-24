// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
/*
 * kwcmd: run a command the host provides (static aarch64 musl),
 * `kwbox cmd` in the base's kw layer (kwbox.c, which also runs kwcmd
 * under any name but its own). The reverse of kwtty: there the host runs
 * a guest program, here a guest process stands for a function of the host
 * (js/core/commands.ts: createKernel({ commands }), vm.addCommand()).
 *
 *   NAME [ARG...]            through a link /run/kw/bin/NAME -> /usr/bin/kwbox
 *                            (the directory is first on PATH: kw-path.sh,
 *                            kwtty.c): the host's command NAME
 *   kwbox cmd run NAME [ARG...]
 *                            the same without a link
 *   kwbox cmd sync [NAME...]
 *                            make /run/kw/bin hold a link for each NAME and
 *                            no other link to kwbox (the SDK runs this
 *                            through kwtty whenever its commands change)
 *
 * This process is the command as far as the guest can tell: its name, its
 * arguments, its stdin, stdout and stderr, its exit status. It connects to
 * the host (AF_VSOCK, CID 2, port 1020), sends its arguments, environment
 * and working directory, then writes what the host sends to stdout and
 * stderr, sends its stdin as the host asks for it, and exits with the
 * status the host gives, or dies by the signal it names. Signals are not
 * caught: one that kills it (Ctrl-C,
 * SIGTERM, SIGPIPE from a closed stdout) closes the connection, which is
 * how the host learns the command is gone.
 *
 * Frames, both directions, as kwtty's: u8 type, u8 flags (bit 0 critical:
 * a receiver that does not know the type fails; unknown other types are
 * skipped), u16 payload length, payload. Integers are little-endian.
 *
 *   guest -> host  10 ARG    one argument; the first is NAME
 *                  11 ENV    one KEY=VALUE (one longer than a frame is
 *                            left out)
 *                  1 START   after every ARG and ENV: u16 version (1), u16
 *                            ttys (bit 0 stdin, 1 stdout, 2 stderr is a
 *                            terminal), u16 rows, cols (of the first
 *                            terminal among stdout, stderr, stdin; else
 *                            0), u32 pid, uid, gid, then the working
 *                            directory
 *                  2 DATA    bytes from stdin (after STDIN)
 *                  7 EOF     stdin ended (or cannot be read)
 *   host -> guest  9 STDIN   read stdin once: answered by one DATA or by EOF
 *                            (stdin is read only for these, so a command
 *                            leaves alone what it does not ask for: a
 *                            terminal's typeahead, the rest of a pipe)
 *                  2 DATA    bytes for stdout
 *                  8 STDERR  bytes for stderr
 *                  4 EXIT    u8 how (0 exit, 1 signal), u8 status, then for
 *                            a signal its name without "SIG" ("TERM"): the
 *                            guest exits with the status, or resets that
 *                            signal's disposition and raises it (128 + its
 *                            number if that does not end it, 128 for a
 *                            name it does not know)
 *                  5 ERROR   a message for stderr; the guest exits 127
 *                            (the host has no such command)
 *
 * Exit: the host's status; 127 with a message when the host does not
 * provide the command (no vsock device, nothing listening, ERROR); 126 when
 * the connection is lost before EXIT or an argument does not fit a frame;
 * 1 when stdout cannot be written (EPIPE with SIGPIPE ignored).
 */
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>
#include <linux/vm_sockets.h>

/* The host's port; js/core/commands.ts has it as CMD_PORT. */
#define KWCMD_PORT	1020
#define KWCMD_VERSION	1
#define KWCMD_PATH	"/usr/bin/kwbox"	/* the links' target: kwbox.c */
#define KWCMD_DIR	"/run/kw/bin"
#define NAME_MAX_LEN	64

#define T_START		1
#define T_DATA		2
#define T_EXIT		4
#define T_ERROR		5
#define T_EOF		7
#define T_STDERR	8
#define T_STDIN		9
#define T_ARG		10
#define T_ENV		11
#define F_CRITICAL	0x01

#define HDR		4
#define MAX_PAYLOAD	0xffff
#define IN_MAX		16384		/* stdin per DATA frame */

static const char *name = "kwcmd";

static void __attribute__((noreturn, format(printf, 2, 3))) die(int code, const char *fmt, ...)
{
	va_list ap;

	fprintf(stderr, "%s: ", name);
	va_start(ap, fmt);
	vfprintf(stderr, fmt, ap);
	va_end(ap);
	fputc('\n', stderr);
	exit(code);
}

static void put16(unsigned char *p, unsigned int v)
{
	p[0] = v;
	p[1] = v >> 8;
}

static void put32(unsigned char *p, uint32_t v)
{
	put16(p, v);
	put16(p + 2, v >> 16);
}

/* A command's name: a file name that is no option and not kwcmd's or kwbox's own. */
static int valid_name(const char *n)
{
	size_t len = strlen(n);

	if (!len || len > NAME_MAX_LEN || n[0] == '.' || n[0] == '-' || !strcmp(n, "kwcmd") || !strcmp(n, "kwbox"))
		return 0;
	for (; *n; n++)
		if (!((*n >= 'a' && *n <= 'z') || (*n >= 'A' && *n <= 'Z') || (*n >= '0' && *n <= '9') || strchr("._+-", *n)))
			return 0;
	return 1;
}

static int is_link(const char *path)
{
	char t[sizeof(KWCMD_PATH) + 1];
	ssize_t n = readlink(path, t, sizeof(t));

	return n == (ssize_t)sizeof(KWCMD_PATH) - 1 && !memcmp(t, KWCMD_PATH, n);
}

/* sync: errors as "kwcmd: what: text (errno N)", which the SDK reads. */
static int do_sync(int n, char **names)
{
	char path[sizeof(KWCMD_DIR) + 1 + 256];
	struct dirent *e;
	DIR *d;

	for (int i = 0; i < n; i++) {
		if (!valid_name(names[i])) {
			errno = EINVAL;
			die(1, "%s: not a command name (errno %d)", names[i], errno);
		}
	}
	if ((mkdir("/run/kw", 0755) && errno != EEXIST) || (mkdir(KWCMD_DIR, 0755) && errno != EEXIST))
		die(1, "mkdir %s: %s (errno %d)", KWCMD_DIR, strerror(errno), errno);
	d = opendir(KWCMD_DIR);
	if (!d)
		die(1, "%s: %s (errno %d)", KWCMD_DIR, strerror(errno), errno);
	while ((e = readdir(d))) {
		int keep = 0;

		for (int i = 0; i < n && !keep; i++)
			keep = !strcmp(e->d_name, names[i]);
		snprintf(path, sizeof(path), "%s/%s", KWCMD_DIR, e->d_name);
		if (!keep && is_link(path))
			unlink(path);
	}
	closedir(d);
	for (int i = 0; i < n; i++) {
		snprintf(path, sizeof(path), "%s/%s", KWCMD_DIR, names[i]);
		if (is_link(path))
			continue;
		unlink(path);
		if (symlink(KWCMD_PATH, path))
			die(1, "link %s: %s (errno %d)", path, strerror(errno), errno);
	}
	return 0;
}

static int s = -1;
static unsigned char out[HDR + IN_MAX];		/* the frame being sent */
static size_t olen, ooff;
static unsigned char in[2 * (HDR + MAX_PAYLOAD)];	/* socket bytes not yet handled */
static size_t ilen;

static void __attribute__((noreturn)) lost(void)
{
	die(126, "lost the connection to the host");
}

/* Before the loop: the whole frame, waiting where the socket is full. */
static void send_frame(unsigned int type, const void *p, size_t len)
{
	unsigned char h[HDR] = { type, 0 };
	struct iovec iov[2] = { { h, HDR }, { (void *)p, len } };
	size_t off = 0;

	put16(h + 2, len);
	while (off < HDR + len) {
		struct msghdr m = { 0 };
		struct pollfd pf = { .fd = s, .events = POLLOUT };
		ssize_t n;

		if (off < HDR) {
			iov[0].iov_base = h + off;
			iov[0].iov_len = HDR - off;
			m.msg_iov = iov;
			m.msg_iovlen = 2;
		} else {
			iov[1].iov_base = (char *)p + (off - HDR);
			iov[1].iov_len = len - (off - HDR);
			m.msg_iov = iov + 1;
			m.msg_iovlen = 1;
		}
		n = sendmsg(s, &m, MSG_NOSIGNAL);
		if (n > 0) {
			off += n;
			continue;
		}
		if (errno != EAGAIN && errno != EINTR)
			lost();
		poll(&pf, 1, -1);
	}
}

static void flush_out(void)
{
	while (ooff < olen) {
		ssize_t n = send(s, out + ooff, olen - ooff, MSG_NOSIGNAL);

		if (n < 0) {
			if (errno == EAGAIN || errno == EINTR)
				return;
			lost();
		}
		ooff += n;
	}
	olen = ooff = 0;
}

/* The payload is in out + HDR already. */
static void queue(unsigned int type, size_t len)
{
	out[0] = type;
	out[1] = 0;
	put16(out + 2, len);
	olen = HDR + len;
	ooff = 0;
	flush_out();
}

/* Output for fd 1 or 2, all of it. A stdout that cannot be written ends the command; stderr's errors are ignored. */
static void write_all(int fd, const unsigned char *p, size_t len)
{
	while (len) {
		ssize_t n = write(fd, p, len);

		if (n >= 0) {
			p += n;
			len -= n;
		} else if (errno == EAGAIN) {
			struct pollfd pf = { .fd = fd, .events = POLLOUT };

			poll(&pf, 1, -1);
		} else if (errno != EINTR) {
			if (fd == 1)
				_exit(1);
			return;
		}
	}
}

static int want_stdin, in_eof, resend_eof;

/* As kwtty's (js/core/tty.ts TTY_SIGNALS). */
static const struct { const char *name; int sig; } signals[] = {
	{ "HUP", SIGHUP }, { "INT", SIGINT }, { "QUIT", SIGQUIT }, { "ILL", SIGILL },
	{ "TRAP", SIGTRAP }, { "ABRT", SIGABRT }, { "BUS", SIGBUS }, { "FPE", SIGFPE },
	{ "KILL", SIGKILL }, { "USR1", SIGUSR1 }, { "SEGV", SIGSEGV }, { "USR2", SIGUSR2 },
	{ "PIPE", SIGPIPE }, { "ALRM", SIGALRM }, { "TERM", SIGTERM }, { "CHLD", SIGCHLD },
	{ "CONT", SIGCONT }, { "STOP", SIGSTOP }, { "TSTP", SIGTSTP }, { "TTIN", SIGTTIN },
	{ "TTOU", SIGTTOU }, { "URG", SIGURG }, { "XCPU", SIGXCPU }, { "XFSZ", SIGXFSZ },
	{ "VTALRM", SIGVTALRM }, { "PROF", SIGPROF }, { "WINCH", SIGWINCH }, { "IO", SIGIO },
	{ "PWR", SIGPWR }, { "SYS", SIGSYS },
};

/* EXIT by signal: die by it, as the shell's wait() should see it. */
static void __attribute__((noreturn)) die_by(const unsigned char *n, size_t len)
{
	for (size_t i = 0; i < sizeof(signals) / sizeof(signals[0]); i++) {
		if (strlen(signals[i].name) == len && !memcmp(signals[i].name, n, len)) {
			sigset_t set;

			signal(signals[i].sig, SIG_DFL);
			sigemptyset(&set);
			sigaddset(&set, signals[i].sig);
			sigprocmask(SIG_UNBLOCK, &set, NULL);
			raise(signals[i].sig);
			_exit(128 + signals[i].sig);
		}
	}
	_exit(128);
}

/* Handles the whole frames in `in`. */
static void handle_input(void)
{
	size_t off = 0;

	while (ilen - off >= HDR) {
		const unsigned char *f = in + off;
		size_t len = f[2] | f[3] << 8;

		if (ilen - off < HDR + len)
			break;
		off += HDR + len;
		switch (f[0]) {
		case T_DATA:
			write_all(1, f + HDR, len);
			break;
		case T_STDERR:
			write_all(2, f + HDR, len);
			break;
		case T_STDIN:
			if (in_eof)
				resend_eof = 1;
			else
				want_stdin = 1;
			break;
		case T_EXIT:
			if (len >= 2 && f[HDR] == 1)
				die_by(f + HDR + 2, len - 2);
			_exit(len >= 2 ? f[HDR + 1] : 0);
		case T_ERROR:
			die(127, "%.*s", (int)len, f + HDR);
		default:
			if (f[1] & F_CRITICAL)
				die(126, "unknown frame type %u from the host", f[0]);
		}
	}
	memmove(in, in + off, ilen - off);
	ilen -= off;
}

static int run(int argc, char **argv)
{
	struct sockaddr_vm a = { .svm_family = AF_VSOCK, .svm_cid = VMADDR_CID_HOST, .svm_port = KWCMD_PORT };
	unsigned char start[20 + 4096];
	struct winsize ws = { 0 };
	unsigned int ttys = 0;
	int fd;
	size_t cwdlen;

	fd = socket(AF_VSOCK, SOCK_STREAM | SOCK_CLOEXEC, 0);
	/* Above 0-2, also where the caller closed one of them. */
	if (fd >= 0 && fd < 3) {
		s = fcntl(fd, F_DUPFD_CLOEXEC, 3);
		close(fd);
	} else {
		s = fd;
	}
	if (s < 0 || connect(s, (struct sockaddr *)&a, sizeof(a)))
		die(127, "the host does not provide this command (kwcmd: %s)", strerror(errno));
	fcntl(s, F_SETFL, fcntl(s, F_GETFL) | O_NONBLOCK);

	for (int i = 0; i < argc; i++) {
		size_t len = strlen(argv[i]);

		if (len > MAX_PAYLOAD)
			die(126, "argument %d is longer than %d bytes", i, MAX_PAYLOAD);
		send_frame(T_ARG, argv[i], len);
	}
	for (char **e = environ; e && *e; e++) {
		size_t len = strlen(*e);

		if (len <= MAX_PAYLOAD)
			send_frame(T_ENV, *e, len);
	}
	for (int i = 0; i < 3; i++)
		if (isatty(i))
			ttys |= 1 << i;
	if (ioctl(1, TIOCGWINSZ, &ws) && ioctl(2, TIOCGWINSZ, &ws) && ioctl(0, TIOCGWINSZ, &ws))
		memset(&ws, 0, sizeof(ws));
	put16(start, KWCMD_VERSION);
	put16(start + 2, ttys);
	put16(start + 4, ws.ws_row);
	put16(start + 6, ws.ws_col);
	put32(start + 8, getpid());
	put32(start + 12, getuid());
	put32(start + 16, getgid());
	if (!getcwd((char *)start + 20, sizeof(start) - 20))
		strcpy((char *)start + 20, "/");
	cwdlen = strlen((char *)start + 20);
	send_frame(T_START, start, 20 + cwdlen);

	for (;;) {
		/* stdin is read once per STDIN, so the host's reading paces it. */
		struct pollfd p[2];

		/* STDIN after the end: EOF again. */
		if (resend_eof && !olen) {
			resend_eof = 0;
			queue(T_EOF, 0);
		}
		p[0] = (struct pollfd){ .fd = s, .events = POLLIN | (olen ? POLLOUT : 0) };
		p[1] = (struct pollfd){ .fd = want_stdin && !in_eof && !olen ? 0 : -1, .events = POLLIN };
		if (poll(p, 2, -1) < 0) {
			if (errno == EINTR)
				continue;
			lost();
		}
		if (p[0].revents & POLLOUT)
			flush_out();
		if (p[1].revents && !olen) {
			ssize_t n = read(0, out + HDR, IN_MAX);

			if (n > 0) {
				want_stdin = 0;
				queue(T_DATA, n);
			} else if (n == 0 || (errno != EAGAIN && errno != EINTR)) {
				in_eof = 1;
				queue(T_EOF, 0);
			}
		}
		if (p[0].revents & (POLLIN | POLLHUP | POLLERR)) {
			ssize_t n = recv(s, in + ilen, sizeof(in) - ilen, 0);

			if (n == 0 || (n < 0 && errno != EAGAIN && errno != EINTR))
				lost();	/* EXIT comes before the host's close */
			if (n > 0) {
				ilen += n;
				handle_input();
			}
		}
	}
}

int main(int argc, char **argv)
{
	const char *base = argc ? strrchr(argv[0], '/') : NULL;

	base = base ? base + 1 : argc ? argv[0] : "kwcmd";
	if (strcmp(base, "kwcmd")) {
		/* Through a link: the command is the name this was called by. */
		name = argv[0] = (char *)base;
		return run(argc, argv);
	}
	if (argc >= 2 && !strcmp(argv[1], "sync"))
		return do_sync(argc - 2, argv + 2);
	if (argc >= 3 && !strcmp(argv[1], "run")) {
		name = argv[2];
		prctl(PR_SET_NAME, name);
		return run(argc - 2, argv + 2);
	}
	fprintf(stderr, "usage: kwbox cmd run NAME [ARG...]\n       kwbox cmd sync [NAME...]\n");
	return 2;
}
