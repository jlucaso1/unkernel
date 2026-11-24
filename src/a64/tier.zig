// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//! The A64 decoded-op tier behind kw_run (a64/tier.md): the
//! block hooks of kwemu.Cpu's block cache (decode, validate), `run`, and
//! code coherence (IC IVAU and the cross-CPU code epoch).
//!
//! A block is up to `max_block` instructions inside one page in execution
//! order: conditional branches (B.cond, CBZ/CBNZ, TBZ/TBNZ) are side exits,
//! B and BL inside the page are followed; it ends at an indirect branch, a
//! branch to another page or back to its own start, SVC/BRK/ISB and
//! unallocated space, or the page end. Its ops sit in the op arena at
//! b.op, followed by the raw words (4 per slot) that `validate` compares.
//! Budget and icount are exact (a block that does not fit the budget is
//! single-stepped through the reference interpreter), faults are precise
//! (pc from `pcAt`, the op had no effect), *irq_pending is polled at every
//! block end.

const std = @import("std");
const builtin = @import("builtin");
const c = @import("common.zig");
const ops = @import("ops.zig");
const opexec = @import("opexec.zig");
const decode = @import("decode.zig");
const branch = @import("branch.zig");
const core = @import("../cpu/core.zig");
const kwemu = @import("../emu/kwemu.zig");
const jc = @import("../emu/jitcore.zig");
const jit = @import("jit/emit.zig");
const Op = ops.Op;
const Cpu = kwemu.Cpu;
const Block = kwemu.Block;
const Regs = c.Regs;

pub const max_block = 64;
const page_mask: u64 = 0xfff;

// ---- block hooks (kwemu.Cpu.lookupIn) ------------------------------------------

/// The hooks kwemu's block cache calls for A64 blocks.
pub const Blocks = struct {
    /// Ops, a trailing goto, and the raw words (4 per slot).
    pub const max_slots = max_block + 1 + max_block / 4;
    pub const LookupError = core.Error || error{Misaligned};

    pub inline fn check(pc: u64) LookupError!void {
        if (pc & 3 != 0) return error.Misaligned;
    }

    /// Same raw words at the same pcs (pc, host address: checked by the caller).
    pub fn validate(cpu: *Cpu, b: *const Block) bool {
        const page = b.host & ~page_mask;
        const arena = cpu.opArena(Op);
        const at = cpu.opIndex(b.op);
        const o = arena[at..][0..b.ninsn];
        const raw: [*]const u32 = @ptrCast(arena + at + b.n);
        var pc = b.pc;
        for (o, 0..) |op, k| {
            if (Cpu.hostRead(u32, page + (pc & page_mask)) != raw[k]) return false;
            pc = ops.nextPc(op, pc);
        }
        return true;
    }

    pub fn decode(cpu: *Cpu, b: *Block, pc: u64, host: u64) void {
        const start: u32 = @intCast(cpu.priv.ops_used);
        const arena = cpu.opArena(Op);
        const o = arena[start..][0 .. max_block + 1];
        var raw: [max_block]u32 = undefined;
        const page = host & ~page_mask;
        const vpage = pc & ~page_mask;
        var n: usize = 0;
        var cur = pc;
        var end = false;
        var mask: u64 = 0;
        while (n < max_block) {
            const inst = Cpu.hostRead(u32, page + (cur & page_mask));
            var d = ops.decode(inst, cur);
            raw[n] = inst;
            mask |= @as(u64, 1) << @intCast((cur & page_mask) >> 6);
            const next = cur +% 4;
            cur = next;
            end = d.ends;
            // Superblock: keep going past conditional branches (side exits)
            // and direct branches that stay in this page, except towards
            // the block's own start: those end it, so a loop re-enters it
            // without a lookup (see `run`).
            if (end and n + 1 < max_block) {
                if (ops.sideExit(d.op.h)) |hx| {
                    if (d.op.imm != pc) {
                        d.op.h = hx;
                        end = false;
                    }
                } else if (d.op.h == .b or d.op.h == .bl) {
                    const t = d.op.imm;
                    if (t & ~page_mask == vpage and t != pc) {
                        if (d.op.h == .bl) {
                            const link = (next -% vpage); // 4..4096: may be the next page
                            d.op = .{ .h = .bl_f, .d = @truncate(link), .e = @truncate(link >> 8), .imm = t };
                        } else d.op = .{ .h = .b_f, .imm = t };
                        cur = t;
                        end = false;
                    }
                }
            }
            o[n] = d.op;
            n += 1;
            if (end or cur & page_mask == 0 or cur & ~page_mask != vpage) break;
        }
        const ninsn = n;
        if (!end or o[n - 1].h == .generic) {
            o[n] = .{ .h = .goto, .imm = cur };
            n += 1;
        }
        // Volatile: a plain copy loop becomes a memcpy call (an import).
        const words: [*]volatile u32 = @ptrCast(arena + start + n);
        for (0..ninsn) |k| words[k] = raw[k];
        cpu.priv.ops_used += n + (ninsn + 3) / 4;
        ar(cpu, Ar.dec_slots, n + (ninsn + 3) / 4);
        b.* = .{
            .pc = pc,
            .tgen = 0,
            .host = host,
            .end_pc = cur,
            .op = start,
            .n = @intCast(n),
            .ninsn = @intCast(ninsn),
            .mask = mask,
        };
    }
};

/// pc of the op `k` instructions into block `b`.
pub fn pcAt(cpu: *Cpu, b: *const Block, k: usize) u64 {
    var pc = b.pc;
    for (cpu.opArena(Op)[cpu.opIndex(b.op)..][0..k]) |o| pc = ops.nextPc(o, pc);
    return pc;
}

// ---- code coherence ------------------------------------------------------------
//
// One CPU: stores into decoded code are tracked exactly (kwemu.zig: code-page
// marks and code_flag write-TLB entries), so self-modifying code takes effect
// at the next instruction; IC IVAU (`icIvau`) drops what this CPU decoded
// from the line's page, which covers writers it does not see (the kernel).
//
// Several CPUs (an SMP kernel, each CPU with its own struct kw_cpu): a store
// by one CPU is not seen by another's tracking. On hardware IC IVAU is
// broadcast to the inner-shareable domain. Here it bumps `code_epoch`, the
// one word of kwemu's static data besides excl.zig's pair_lock (all CPU
// threads share the linear memory), and every CPU compares the epoch with
// the one it last saw at each kw_run entry (every exception return) and at
// every block end, where it also polls *irq_pending; on a change it retires
// all its exec-TLB generations (each block is revalidated against memory
// before it runs again). Guarantee: once IC IVAU has retired on one CPU,
// every other CPU runs the new instructions from its next block boundary
// on, that is within 64 instructions (or at once if it is not in kw_run),
// without an ISB of its own; that is stronger than the architecture asks
// (the other PE must context-synchronise), and what a guest that skips the
// ISB still gets on hardware in practice.

/// Whether the cross-CPU epoch exists: atomics builds (several CPUs) and the
/// unit tests (two struct kw_cpu on one memory, one thread).
pub const multi_cpu = c.smp or builtin.is_test;

/// The epoch has two cache lines' worth of bytes to itself (128 on Apple's
/// cores), so that polling it never waits for a neighbour's writer.
var code_epoch: extern struct { v: u64 align(128) = 0, pad: [120]u8 = @splat(0) } = .{};

/// A plain load, not an atomic one: every CPU polls this one word at every
/// block end, and JavaScriptCore runs a wasm atomic load as a
/// read-modify-write, which made the CPUs take the cache line from each
/// other (iPhone 15 Pro, 2026-11-23: 4 CPUs ran user code at 0.35x of one).
/// A CPU sees a bump at the latest at its next poll after the store reaches
/// it; should an engine hoist the load out of a compiled self-loop, that is
/// the loop's next exit (an interrupt, so within a tick).
inline fn epochNow() u64 {
    return @as(*const volatile u64, &code_epoch.v).*;
}

/// Called by kw_cpu_init and kw_host_reset: this CPU has seen every change
/// so far; compiled code finds the epoch through a64.epoch_ptr.
pub fn epochInit(cpu: *Cpu) void {
    if (!multi_cpu) return;
    cpu.priv.a64.seen_epoch = epochNow();
    cpu.priv.a64.epoch_ptr = @intFromPtr(&code_epoch.v);
}

/// Retire everything if another CPU invalidated code since this one last
/// looked; true if it did.
inline fn epochCheck(cpu: *Cpu) bool {
    if (!multi_cpu) return false;
    const e = epochNow();
    if (e == cpu.priv.a64.seen_epoch) return false;
    epochCatchUp(cpu, e);
    return true;
}
noinline fn epochCatchUp(cpu: *Cpu, e: u64) void {
    cpu.priv.a64.seen_epoch = e;
    cpu.retireAll();
}

/// No interrupt pending and no code changed by another CPU (the poll at a
/// block end inside a self-loop; runOps): the loop may go on.
pub inline fn quiet(cpu: *Cpu) bool {
    if (cpu.irq_pending) |p| if (p.* != 0) return false;
    return !epochCheck(cpu);
}

/// IC IVAU of `va` (branch.icIvau, the reference and `generic` ops alike).
pub fn icIvau(cpu: *Cpu, va: u64) void {
    if (multi_cpu) {
        const old = @atomicRmw(u64, &code_epoch.v, .Add, 1, .seq_cst);
        // This CPU is current if it was before: it invalidates here.
        if (old == cpu.priv.a64.seen_epoch) cpu.priv.a64.seen_epoch = old +% 1;
    }
    cpu.icInvalidate(va);
}

// ---- run -----------------------------------------------------------------------

fn event(cpu: *Cpu, kind: core.Kind, access: u32, addr: u64, insn: u64) u32 {
    cpu.ev = .{ .kind = @intFromEnum(kind), .access = access, .addr = addr, .insn = insn };
    return @intFromEnum(kind);
}

/// Where kw_run saw the interrupt or the budget it returns for (a64.Priv
/// stop_tier, kw_debug_last_stop; the kernel's profiler, arch/wasm/kernel/
/// prof.c, has the same numbers): pending at entry, after a single step or
/// in the reference loop, after decoded ops, after compiled code, or the
/// budget ran out. The pc of an interrupt stop is the start of the block
/// that would run next, so a sampler that wants the code that used the time
/// takes `stop_block`, the block that ran before.
pub const StopTier = enum(u32) { none = 0, entry = 1, reference = 2, decoded = 3, compiled = 4, budget = 5 };

/// Record the stop (only on these returns, off the hot path) and return its event.
pub fn stopEvent(cpu: *Cpu, kind: core.Kind, tier_: StopTier, block_pc: u64) u32 {
    cpu.priv.a64.stop_tier = @intFromEnum(tier_);
    cpu.priv.a64.stop_block = block_pc;
    return event(cpu, kind, 0, 0, 0);
}

/// The event of a trapped instruction (Hart.trap; pc on it). SVC retires:
/// pc moves past it (the caller charges it).
pub fn trapEvent(cpu: *Cpu, regs: *Regs) u32 {
    const h = &cpu.priv.hart;
    cpu.priv.smc = 0;
    return switch (h.trap) {
        .syscall => blk: {
            regs.pc +%= 4;
            break :blk event(cpu, .syscall, 0, 0, 0);
        },
        .breakpoint => event(cpu, .breakpoint, 0, regs.pc, h.trap_val),
        .misaligned => event(cpu, .misaligned, 0, h.trap_val, 0),
        else => event(cpu, .illegal, 0, regs.pc, h.trap_val),
    };
}

/// kw_run: blocks run compiled (`-Dkwemu-jit`, once hot: jit.C.ready) or
/// through `runOps`. Compiled code returns "done" (pc set; a side exit
/// refunds the rest of its block here, a region's own side exits did it
/// themselves) or hands op k of `lastBlock` back: `runOps` then finishes
/// that pass from op k of the same decode, with slot 32 set back to 0 first
/// (compiled code stores pc there at its exit, and the ops read the slot as
/// XZR). A compiled block's further self-loop passes enter its code again,
/// so after a hand-back runOps runs no further pass; a block counting
/// towards its compile threshold runs at most the countdown's worth of
/// passes in runOps, so its next pass compiles it.
pub fn run(cpu: *Cpu, regs: *Regs) u32 {
    const start = cpu.budget;
    var left = start;
    defer {
        cpu.budget = left;
        cpu.icount +%= start - left;
    }
    _ = epochCheck(cpu); // an exception return: a context synchronisation
    const irq = cpu.irq_pending;
    if (irq) |p| if (p.* != 0) return stopEvent(cpu, .interrupt, .entry, 0);
    const x: [*]u64 = @ptrCast(&regs.x);
    const h = &cpu.priv.hart;
    const s: c.St = .{ .r = regs, .h = h, .m = cpu };
    const arena = cpu.opArena(Op);
    // JIT: pool entry of the region entered last, and whether its code left
    // through an exit (not a hand-back) towards the block looked up next.
    var xs: u32 = 0;
    var left_region = false;
    // -Dkwemu-stats: how the last compiled pass left (jit.C.countExit), and
    // from which block, for jit.C.countNext.
    var xk: u32 = 0;
    var xb: *const Block = undefined;
    while (true) {
        if (left == 0) return stopEvent(cpu, .budget, .budget, 0);
        const b = cpu.lookupIn(Blocks, regs.pc) catch |e| return switch (e) {
            error.Misaligned => event(cpu, .misaligned, 0, regs.pc, 0),
            error.PageFault => event(cpu, .fault, cpu.priv.fault_access, cpu.priv.fault_addr, 0),
        };
        if (jc.enabled and left_region) {
            if (kwemu.stats_on) jit.C.countNext(cpu, xk, xb, b, xs);
            left_region = false;
            // A grow compiled, and a flush came during the compile: look b
            // up again (jitcore.zig, windowClose).
            if (jit.C.noteExit(cpu, xs, b)) continue;
        }
        if (b.ninsn > left) {
            // Single-step: the budget ends inside this block.
            kwemu.count(cpu, "single_steps", 1);
            const e = decode.step(s) catch {
                cpu.priv.smc = 0;
                return event(cpu, .fault, cpu.priv.fault_access, cpu.priv.fault_addr, 0);
            };
            cpu.priv.smc = 0;
            switch (e) {
                .next => left -= 1,
                .jump => {
                    left -= 1;
                    if (irq) |p| if (p.* != 0) return stopEvent(cpu, .interrupt, .reference, b.pc);
                },
                .trap => {
                    if (h.trap == .counter) {
                        branch.finishCounter(s, cpu.icount +% (start - left));
                        left -= 1;
                        continue;
                    }
                    if (h.trap == .syscall) left -= 1; // SVC retires
                    return trapEvent(cpu, regs);
                },
            }
            continue;
        }
        kwemu.count(cpu, "blocks", 1);
        kwemu.count(cpu, "block_insns", b.ninsn);
        left -= b.ninsn;
        var blk = b;
        var first: [*]const Op = arena + cpu.opIndex(blk.op);
        var o = first;
        // Budget runOps may spend on further self-loop passes.
        var cap = left;
        if (kwemu.stats_on) axReason(cpu, Ax.never);
        if (jc.enabled) {
            const go = jit.C.ready(cpu, blk);
            if (go == .again) {
                // It compiled, and a flush came during the compile: blk may
                // be gone. Nothing of it ran; take it back and look it up
                // again (jitcore.zig, windowClose).
                left += blk.ninsn;
                continue;
            }
            if (go == .compiled) {
                const jl = @min(left, jc.max_jl);
                xs = jc.slotIndex(blk);
                const ret = jc.enter(cpu, blk, x, jl);
                left = left - jl + (ret >> 8);
                // A region charges every further member in full before it
                // runs (like blk above); `code` refers to the last one.
                blk = jc.lastBlock(cpu);
                first = arena + cpu.opIndex(blk.op);
                const code: u32 = @intCast(ret & 0xff);
                if (kwemu.stats_on) {
                    xk = jitStats(cpu, b, blk, jl -% (ret >> 8), code);
                    xb = blk;
                }
                if (code >= jc.code_done) {
                    if (code >= jc.code_side) left += blk.ninsn - (code - jc.code_side + 1);
                    left_region = true;
                    if (irq) |p| if (p.* != 0) return stopEvent(cpu, .interrupt, .compiled, blk.pc);
                    _ = epochCheck(cpu);
                    continue;
                }
                // Handed back before op `code`: the ops finish the pass.
                jc.handedBack(cpu);
                o = first + code;
                cap = 0;
                if (kwemu.stats_on) {
                    const dyn = jit.supported(first[code]);
                    axReason(cpu, if (dyn) Ax.tail_dyn else Ax.tail_static);
                    ax(cpu, if (dyn) Ax.hb_dyn else Ax.hb_static, 1);
                    if (first[code].h == .generic) ax(cpu, Ax.hb_class + genClass(first[code].aux()), 1);
                }
            } else if (blk.jx.st != jc.never) {
                cap = @min(left, blk.jx.st);
                if (kwemu.stats_on) axReason(cpu, Ax.countdown);
            }
        }
        x[ops.zr] = 0; // XZR while the ops run (compiled code left pc there)
        // Self-loop passes that fit `cap` run inside runOps.
        const r = opexec.runOps(o, x, cpu, blk.end_pc, blk.pc, blk.ninsn, cap);
        const passes = cap - r.left;
        left -= passes;
        if (jc.enabled and passes != 0) jc.loopDone(blk, passes);
        if (r.next == .done or r.next == .side) {
            if (r.next == .side) {
                // Side exit after k + 1 instructions: refund the rest.
                const k = (@intFromPtr(r.op) - @intFromPtr(first)) / @sizeOf(Op);
                left += blk.ninsn - (k + 1);
            }
            if (irq) |p| if (p.* != 0) return stopEvent(cpu, .interrupt, .decoded, blk.pc);
            _ = epochCheck(cpu);
            continue;
        }
        // Left the block early: k instructions before r.op retired.
        const k: usize = (@intFromPtr(r.op) - @intFromPtr(first)) / @sizeOf(Op);
        left += blk.ninsn - k;
        cpu.priv.smc = 0;
        switch (r.next) {
            .done, .cont, .side => unreachable,
            .fault => {
                regs.pc = pcAt(cpu, blk, k);
                return event(cpu, .fault, cpu.priv.fault_access, cpu.priv.fault_addr, 0);
            },
            .trap => {
                regs.pc = pcAt(cpu, blk, k);
                if (h.trap == .syscall) left -= 1; // SVC retires
                return trapEvent(cpu, regs);
            },
            .counter => {
                // MRS CNTVCT_EL0: retires with the instructions retired before it.
                regs.pc = pcAt(cpu, blk, k);
                branch.finishCounter(s, cpu.icount +% (start - left));
                left -= 1;
            },
            .stop => {
                left -= 1;
                regs.pc = pcAt(cpu, blk, k + 1);
            },
        }
        if (irq) |p| if (p.* != 0) return stopEvent(cpu, .interrupt, .decoded, blk.pc);
        _ = epochCheck(cpu);
    }
}

/// -Dkwemu-stats, A64: why instructions ran outside compiled code, in
/// JitStats.hb_gen. Interpreted instructions (ops other than `goto`) by the state of
/// their block: never compiled (`never`: its first op is not translated, its
/// compile failed, or no JIT), counting towards the threshold (`countdown`),
/// the rest of a pass after compiled code handed back an op that is not
/// translated (`tail_static`) or a translated one (`tail_dyn`: a data-TLB
/// miss, a store into a code page); the hand-backs of each kind; countdown
/// progress (instructions) and blocks lost when a counting block is
/// replaced in the block table (`lost_drop`) or by an arena reset
/// (`lost_reset`); the core's compile counters (copied by kw_debug_stats).
pub const Ax = struct {
    pub const never = 0;
    pub const countdown = 1;
    pub const tail_static = 2;
    pub const tail_dyn = 3;
    pub const hb_static = 4;
    pub const hb_dyn = 5;
    pub const lost_drop = 6;
    pub const lost_reset = 7;
    pub const blocks_lost_drop = 8;
    pub const blocks_lost_reset = 9;
    /// jc.State: compiles, skips, fails, shortened, evictions, frees,
    /// grows + exit_grows, members_total.
    pub const core = 10;
    /// Hand-backs of `generic` ops by class (`genClass`), then generic ops
    /// executed by class.
    pub const hb_class = 19;
    pub const gen_class = 29;
    /// Index of the reason runOps counts its ops under.
    pub const cur = 39;
};

/// -Dkwemu-stats: class of a `generic` op's raw word (Ax.hb_class + i):
/// 0 scalar FP, 1 AdvSIMD copy/immediate/permute, 2 AdvSIMD arithmetic,
/// 3 AdvSIMD structure loads/stores, 4 crypto, 5 exclusives and
/// load-acquire/store-release, 6 other loads/stores (LSE, ...), 7 system
/// (MRS, MSR, barriers, DC, IC), 8 data-processing register (CRC32), 9 other.
pub fn genClass(raw: u32) usize {
    return switch (decode.route(raw)) {
        .fp => 0,
        .simd_move => 1,
        .simd_arith => 2,
        .simd_ldst => 3,
        .crypto => 4,
        .ldst => if (raw & 0x3f00_0000 == 0x0800_0000) 5 else 6,
        .branch => 7,
        .dp_reg => 8,
        else => 9,
    };
}

inline fn ax(cpu: *Cpu, i: usize, n: u64) void {
    if (kwemu.stats_on) cpu.priv.stats.jit.hb_gen[i] += n;
}
inline fn axReason(cpu: *Cpu, r: usize) void {
    if (kwemu.stats_on) cpu.priv.stats.jit.hb_gen[Ax.cur] = r;
}

/// -Dkwemu-stats: a counting block is about to be discarded.
pub fn axLost(cpu: *Cpu, b: *const Block, reset: bool) void {
    if (!kwemu.stats_on or !jc.enabled) return;
    const s = b.jx.st;
    if (b.pc == std.math.maxInt(u64) or s == jc.never or s >= jc.compiled) return;
    ax(cpu, if (reset) Ax.lost_reset else Ax.lost_drop, cpu.priv.jit.threshold -| s);
    ax(cpu, if (reset) Ax.blocks_lost_reset else Ax.blocks_lost_drop, 1);
}

/// -Dkwemu-stats: arena counters, in the unused tail of Stats.op_hist
/// (`Ar.base + i`).
pub const Ar = struct {
    pub const base = 150;
    /// Nursery resets; at each: blocks and slots still live in the nursery,
    /// blocks in the tenured part, tenured slots in use, compiled blocks.
    pub const nursery_resets = 0;
    pub const live_blocks = 1;
    pub const live_slots = 2;
    pub const ten_blocks = 3;
    pub const ten_slots = 4;
    pub const ten_resets = 5;
    /// Decodes by what the block-table way held: the same pc and host with
    /// its ops discarded by a reset, the same pc and host with other
    /// contents, the same pc at another host, another block, nothing.
    pub const dec_gone = 6;
    pub const dec_changed = 7;
    pub const dec_host = 8;
    pub const dec_evict = 9;
    pub const dec_empty = 10;
    pub const dec_slots = 11;
    /// Countdown progress a re-decode took over (charged instructions).
    pub const heat_kept = 12;
    pub const compiled_blocks = 13;
    /// Tenured blocks dropped to make room, and how many were compiled.
    pub const ten_evicted = 14;
    pub const ten_evicted_compiled = 15;
};

inline fn ar(cpu: *Cpu, i: usize, n: u64) void {
    if (kwemu.stats_on) cpu.priv.stats.op_hist[Ar.base + i] += n;
}

/// -Dkwemu-stats: `generic` ops executed, by FP form, in Stats.op_hist
/// from `fp_base` (`fpForm`; 26 forms up to the end of op_hist).
pub const fp_base = 166;
/// 0..7 FADD/FSUB/FMUL/FDIV (D, S each), 8 FSQRT, 9 FABS/FNEG, 10 FMOV
/// (register), 11 FCVT, 12 FRINT*, 13 FMAX/FMIN*, 14 FNMUL, 15 SCVTF, 16
/// UCVTF, 17 FCVTZS, 18 FCVTZU, 19 other conversions, 20 FCSEL, 21 FMOV
/// (immediate), 22 FMADD and friends, 23 FCMP, FCCMP, 24 loads and stores
/// (ldst group), 25 anything else (AdvSIMD, system, ...).
pub fn fpForm(raw: u32) usize {
    switch (decode.route(raw)) {
        .fp => {},
        .ldst => return 24,
        else => return 25,
    }
    const dbl = c.bits(raw, 23, 22) == 1;
    if (c.bit(raw, 24)) return 22;
    if (!c.bit(raw, 21) or c.bits(raw, 15, 10) == 0) {
        const op = c.bits(raw, 20, 16); // rmode:opcode
        return switch (op) {
            0b00_010 => 15,
            0b00_011 => 16,
            0b11_000 => 17,
            0b11_001 => 18,
            else => 19,
        };
    }
    if (c.bits(raw, 14, 10) == 0b10000) {
        const op = c.bits(raw, 20, 15);
        return switch (op) {
            0 => 10,
            1, 2 => 9,
            3 => 8,
            4...7 => 11,
            else => 12,
        };
    }
    if (c.bits(raw, 13, 10) == 0b1000) return 23;
    if (c.bits(raw, 12, 10) == 0b100) return 21;
    return switch (c.bits(raw, 11, 10)) {
        0b01 => 23,
        0b11 => 20,
        else => switch (c.bits(raw, 15, 12)) {
            0 => if (dbl) 4 else 5,
            1 => if (dbl) 6 else 7,
            2 => if (dbl) 0 else 1,
            3 => if (dbl) 2 else 3,
            8 => 14,
            else => 13,
        },
    };
}

/// -Dkwemu-stats: a nursery reset is about to happen.
pub fn axReset(cpu: *Cpu) void {
    if (!kwemu.stats_on) return;
    ar(cpu, Ar.nursery_resets, 1);
    for (&cpu.priv.blocks) |*b| {
        if (b.pc == std.math.maxInt(u64) or b.op == kwemu.op_gone) continue;
        const n = @as(u64, b.n) + (@as(u64, b.ninsn) + 3) / 4;
        if (b.op < cpu.priv.nursery) {
            ar(cpu, Ar.live_blocks, 1);
            ar(cpu, Ar.live_slots, n);
        } else ar(cpu, Ar.ten_blocks, 1);
        if (jc.enabled and b.jx.st >= jc.compiled) ar(cpu, Ar.compiled_blocks, 1);
    }
    ar(cpu, Ar.ten_slots, cpu.priv.ten_head - cpu.priv.ten_tail);
}

pub fn axTenReset(cpu: *Cpu) void {
    ar(cpu, Ar.ten_resets, 1);
}

/// -Dkwemu-stats: block b's tenured ops make room for newer ones.
pub fn axTenEvict(cpu: *Cpu, b: *const Block) void {
    ar(cpu, Ar.ten_evicted, 1);
    if (jc.enabled and b.jx.st >= jc.compiled) ar(cpu, Ar.ten_evicted_compiled, 1);
}

/// -Dkwemu-stats: block-table way `b` is about to receive a decode of pc
/// at host.
pub fn axDecode(cpu: *Cpu, b: *const Block, pc: u64, host: u64) void {
    if (!kwemu.stats_on) return;
    const i: usize = if (b.pc == std.math.maxInt(u64))
        Ar.dec_empty
    else if (b.pc != pc)
        Ar.dec_evict
    else if (b.host != host)
        Ar.dec_host
    else if (b.op == kwemu.op_gone)
        Ar.dec_gone
    else
        Ar.dec_changed;
    ar(cpu, i, 1);
    if (jc.enabled and b.pc == pc and b.host == host and b.jx.st != jc.never and b.jx.st < jc.compiled)
        ar(cpu, Ar.heat_kept, cpu.priv.jit.threshold -| b.jx.st);
}

/// -Dkwemu-stats: copy the core's compile counters into the Ax words.
pub fn axCore(cpu: *Cpu) void {
    if (!kwemu.stats_on or !jc.enabled) return;
    const j = &cpu.priv.jit;
    const g = &cpu.priv.stats.jit.hb_gen;
    g[Ax.core + 0] = j.compiles;
    g[Ax.core + 1] = j.skips;
    g[Ax.core + 2] = j.fails;
    g[Ax.core + 3] = j.shortened;
    g[Ax.core + 4] = j.evictions;
    g[Ax.core + 5] = j.frees;
    g[Ax.core + 6] = j.grows + j.exit_grows;
    g[Ax.core + 7] = j.members_total;
}

/// -Dkwemu-stats: account one call into compiled code that entered block
/// `entry` (charged by `run`) and left from `b` (`lastBlock`), `extra` =
/// what it charged against its budget beyond `entry` (wraps when a side
/// exit of `entry` refunded into it), `code` its exit code. Returns how
/// it left (jit.C.countExit), for countNext.
noinline fn jitStats(cpu: *Cpu, entry: *const Block, b: *const Block, extra: u64, code: u32) u32 {
    const st = &cpu.priv.stats.jit;
    const charged = entry.ninsn +% extra;
    if (code >= jc.code_side) {
        st.insns += charged - (b.ninsn - (code - jc.code_side + 1));
    } else if (code >= jc.code_done) {
        st.insns += charged;
    } else {
        st.insns += charged - (b.ninsn - code);
        st.handbacks += 1;
        st.hb[@intFromEnum(cpu.opArena(Op)[cpu.opIndex(b.op + code)].h)] += 1;
    }
    return jit.C.countExit(cpu, b, code);
}
