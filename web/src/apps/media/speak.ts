// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Speak: the guest talks through its sound card. eSpeak 1.48 (Alpine's
// aarch64 espeak from main) is a formant synthesizer: no recorded voices,
// about 70 languages in its 1.2 MB package. With portaudio, alsa-lib and
// the JACK client library it pulls in, the download is about 4.9 MB, all
// from main, so community stays off.
//
// speak.sh first introduces the machine briefly in the en+m7 voice (the
// kernel release, uptime and process count, with a whispered en+whisper
// aside about the emulated CPU), printing each sentence as it is said, then
// offers a talking clock (the time every 10 seconds), a prompt that says
// what you type (/f3, /croak, /de... change the voice), and a tour of
// voices and languages.
//
// espeak plays itself: portaudio's ALSA host API opens hw:0 (kwsnd) at
// 22050 Hz mono S16_LE, so no aplay (alsa-utils, 2.2 MB more) is needed. On
// every start portaudio probes each PCM in alsa-lib's default config and
// looks for a JACK server, printing about 30 lines of complaints to stderr;
// they go to /tmp/speak.log, shown only when espeak fails, and
// JACK_NO_START_SERVER keeps the JACK client from trying to start one. That
// probing is most of espeak's start-up: a sentence plays about 0.45 s
// after espeak starts (riscv64 guest, CLI, 2026-11-15; on aarch64 a
// one-word espeak call, playback included, takes about 1.0 s, 2026-11-18). Text goes in on stdin, so a line
// that starts with a dash is not taken as an option.
//
// The INT trap (a handler, reset in children) makes Ctrl-C cut espeak off
// and come back to the menu; the clock swaps it for one that ends its
// loop. At the menu Ctrl-C, 0 or q leaves.
import type { TerminalApp } from "../types.ts";

const SPEAK = String.raw`#!/bin/sh
# The machine speaks: eSpeak, a speech synthesizer, running on aarch64 Linux
# in the browser and playing through the guest's sound card.
export JACK_NO_START_SERVER=1
LOG=/tmp/speak.log
B='\033[1m' D='\033[90m' C='\033[36m' N='\033[0m'
VOICE=en+m7
trap : INT
# The voice variants: /usr/share/espeak-data on Alpine, under
# /usr/lib/<triplet> on Debian.
VARIANTS=
for d in /usr/share/espeak-data /usr/lib/*/espeak-data; do
	if [ -d "$d/voices/!v" ]; then VARIANTS=$d/voices/!v; fi
done

# speak VOICE TEXT. portaudio's device probe writes its findings to stderr
# on every start; they go to the log, shown only when espeak fails.
speak() {
	printf '%s\n' "$2" | espeak -v "$1" -s 165 2>"$LOG" && return
	printf "$D%s$N\n" "espeak failed (voice $1):"
	grep -v -i -e '^ALSA lib' -e jack "$LOG" | tail -n 3
	return 1
}

# say TEXT [SPOKEN]: print TEXT, then speak SPOKEN (default TEXT).
say() {
	printf "$C»$N %s\n" "$1"
	speak "$VOICE" "${"$"}{2:-$1}"
}

# whisper TEXT [SPOKEN]: an aside, printed dim and whispered.
whisper() {
	printf "$D»$N $D%s$N\n" "$1"
	speak en+whisper "${"$"}{2:-$1}"
}

intro() {
	kver=$(uname -r | sed 's/[^0-9.].*//')
	up=$(cut -d. -f1 /proc/uptime)
	if [ "$up" -lt 120 ]; then up="$up seconds"; else up="$((up / 60)) minutes"; fi
	procs=$(ls -d /proc/[0-9]* | wc -l)

	say "Hello! I am Linux $kver, running in your browser."
	whisper "(psst: on an emulated Arm processor, inside WebAssembly)" \
		"psst. on an emulated arm processor, inside WebAssembly."
	say "I have been up for $up, with $procs processes running."
}

# The time in words, the way a speaking clock says it.
clock() {
	stop=
	trap 'stop=1' INT
	printf "\n$B%s$N\n$D%s$N\n" "Talking clock" "The time every 10 seconds. Ctrl-C stops."
	while [ -z "$stop" ]; do
		now=$(date +%s)
		sleep $((10 - now % 10))
		[ -n "$stop" ] && break
		set -- $(date '+%I %M %S %p %H:%M:%S')
		h=${"$"}{1#0} m=${"$"}{2#0} s=${"$"}{3#0}
		case $m in
		0) m="o'clock" ;;
		[1-9]) m="oh $m" ;;
		esac
		[ "$s" = 0 ] && s=exactly || s="and $s seconds"
		say "$5" "It is $h $m $4, $s."
	done
	trap : INT
}

words() {
	printf "\n$B%s$N\n$D%s$N\n" "Say what you type" \
		"Enter says the line. /f3, /m7, /croak, /whisper or a language (/de, /fr, /es...) changes the voice; an empty line goes back."
	while printf "$B%s$N " "say ($VOICE)>" && read -r line; do
		case $line in
		"") return ;;
		/*)
			v=${"$"}{line#/}
			# A variant (in !v) goes on top of English; anything else is a language.
			if [ -e "$VARIANTS/$v" ]; then v="en+$v"; fi
			speak "$v" "$v" && VOICE=$v
			;;
		*) speak "$VOICE" "$line" ;;
		esac
	done
	echo
}

TOUR='en+f3|I can speak in different voices.
en|This is the plain one.
en+croak|This one has a frog in its throat.
en+whisper|I can whisper, too.
en-sc|And I can speak with a Scottish accent.
de|Hallo! Ich bin Linux und laufe in deinem Browser.
fr|Bonjour ! Je suis Linux, et je tourne dans ton navigateur.
es|¡Hola! Soy Linux y funciono en tu navegador.
it|Ciao! Sono Linux e giro nel tuo browser.
pt-br|Olá! Eu sou o Linux, rodando no seu navegador.
ru|Привет! Я Линукс, и я работаю в твоём браузере.'

tour() {
	printf "\n$B%s$N\n" "Voices and languages"
	stop=
	trap 'stop=1' INT
	# A here-document, not a pipe: the loop must run in this shell to see stop.
	while IFS='|' read -r v text; do
		[ -n "$stop" ] && break
		printf "$D%-11s$N %s\n" "$v" "$text"
		speak "$v" "$text"
	done <<EOF
$TOUR
EOF
	trap : INT
	[ -n "$stop" ] && return
	n=$(espeak --voices | tail -n +2 | wc -l)
	printf "$C»$N %s\n" "eSpeak has $n voices in this package: try them with /name in option 3."
	speak "$VOICE" "e speak has $n voices in this package. Try them in option 3."
}

menu() {
	printf "\n$B%s$N\n" "Speak: Linux with a voice"
	printf "  $B%s$N  %s\n" 1 "introduce yourself" 2 "talking clock" 3 "say what I type" 4 "voices and languages" 0 quit
}

printf "$D%s$N\n" "Turn your sound on. Ctrl-C cuts a sentence short."
intro
while :; do
	menu
	printf 'Choice (1-4, 0 quits): '
	read -r n || { echo; exit 0; }
	case $n in
	1) intro ;;
	2) clock ;;
	3) words ;;
	4) tour ;;
	0 | q | Q) exit 0 ;;
	"") ;;
	*) echo "Pick a number from the menu." ;;
	esac
done
`;

export default {
	id: "speak",
	title: "Speak",
	desc: "The guest talks: eSpeak introduces this Linux, tells the time and says what you type, on the sound card",
	// A loudspeaker and its sound waves.
	icon: { svg: '<path d="M3 9.2h3.6L12 4.8v14.4l-5.4-4.4H3z"/><path d="M15.4 9a4.2 4.2 0 0 1 0 6M18.2 6.2a8.2 8.2 0 0 1 0 11.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' },
	colors: ["#8b5cf6", "#1e1b4b"],
	needs: { net: true, sound: true },
	files: { "speak.sh": { content: SPEAK, mode: 0o755 } },
	packages: { alpine: ["espeak"], debian: ["espeak"] },
	commands: ["./speak.sh"],
} satisfies TerminalApp;
