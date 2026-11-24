// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The launcher's Tools folder: Git, an editor, tmux and the Go and Rust toolchains.
// One file per app in this folder, listed below in the order it shows them.
import { defineGroup } from "../types.ts";
import git from "./git.ts";
import nvim from "./nvim.ts";
import tmux from "./tmux.ts";
import go from "./go.ts";
import rust from "./rust.ts";

export default defineGroup({
	id: "tools", title: "Tools", desc: "Git, an editor, tmux and compilers",
	// Code brackets and a slash.
	icon: { svg: '<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m8 7-5 5 5 5M16 7l5 5-5 5M13.5 4.5l-3 15"/></g>' },
	colors: ["#6366f1", "#1e1b4b"],
}, [git, nvim, tmux, go, rust]);
