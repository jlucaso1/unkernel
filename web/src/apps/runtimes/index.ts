// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The launcher's Runtimes folder: language runtimes with their REPLs.
// One file per app in this folder, listed below in the order it shows them.
import { defineGroup } from "../types.ts";
import node from "./node.ts";
import bun from "./bun.ts";
import python from "./python.ts";

export default defineGroup({
	id: "runtimes", title: "Runtimes", desc: "Language runtimes with their REPLs",
	// Braces.
	icon: { svg: '<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 4C6.5 4 6 5 6 7v2c0 1.5-.8 2.5-2.5 3 1.7.5 2.5 1.5 2.5 3v2c0 2 .5 3 2.5 3M15.5 4c2 0 2.5 1 2.5 3v2c0 1.5.8 2.5 2.5 3-1.7.5-2.5 1.5-2.5 3v2c0 2-.5 3-2.5 3"/></g>' },
	colors: ["#22c55e", "#14532d"],
}, [bun, node, python]);
