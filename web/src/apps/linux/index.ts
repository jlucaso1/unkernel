// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The launcher's Linux folder: the system itself: processes, files, FUSE, an Ubuntu chroot, Docker.
// One file per app in this folder, listed below in the order it shows them.
import { defineGroup } from "../types.ts";
import ubuntu from "./ubuntu.ts";
import docker from "./docker.ts";
import htop from "./htop.ts";
import mc from "./mc.ts";
import sshfs from "./sshfs.ts";

export default defineGroup({
	id: "linux", title: "Linux", desc: "The system itself: processes, files, FUSE, an Ubuntu chroot, Docker",
	// A chip: the system itself.
	icon: { svg: '<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9 2.5V6M15 2.5V6M9 18v3.5M15 18v3.5M2.5 9H6M2.5 15H6M18 9h3.5M18 15h3.5"/></g>' },
	colors: ["#f59e0b", "#78350f"],
}, [docker, ubuntu, htop, mc, sshfs]);
