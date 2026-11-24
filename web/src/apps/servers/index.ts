// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The launcher's Servers folder: web servers and databases, the web ones shown in the Browser.
// One file per app in this folder, listed below in the order it shows them.
import { defineGroup } from "../types.ts";
import nginx from "./nginx.ts";
import nitro from "./nitro.ts";
import postgres from "./postgres.ts";
import valkey from "./valkey.ts";
import sqlite from "./sqlite.ts";

export default defineGroup({
	id: "servers", title: "Servers", desc: "Web servers and databases, the web ones shown in the Browser",
	// Two server units with their lights.
	icon: { svg: '<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4" width="17" height="7" rx="2"/><rect x="3.5" y="13" width="17" height="7" rx="2"/><path d="M7.5 7.5h.01M7.5 16.5h.01" stroke-width="3"/></g>' },
	colors: ["#0ea5e9", "#0c4a6e"],
}, [postgres, nginx, nitro, valkey, sqlite]);
