# The decoded-op tier

`kw_run` (`tier.run`) decodes guest code into blocks of compact ops once
and runs those. The reference loop (`run.runRef`) stays the oracle: unit
tests and the harness's `--lockstep` and `--ref` call it, and
`-Dkwemu-a64-ref` makes it kw_run. Files: `ops.zig` (op format, kinds,
decoder), `opexec.zig` (semantics, `runOps`), `tier.zig` (block hooks,
`run`, coherence), `tier_tests.zig`.

The block cache is ISA-neutral (`src/emu/kwemu.zig`, kwemu.md,
Interpreter): `Cpu.lookupIn(D, pc)` with the 2-way block table, exec-TLB
generations, revalidation, the code-page filter and the op arena. `D` is
the tier's hook type (`tier.Blocks`: `decode`, `validate`, `check` (pc
alignment), `max_slots`). Everything that reads a block's ops goes
through `Cpu.opIndex(b.op)` (tenured ops are numbered, not indexed).

## Blocks

Up to 64 instructions (`max_block`; shorter blocks: a64/performance.md,
Rejected designs) inside one page in execution order. B.cond,
CBZ/CBNZ and TBZ/TBNZ are side exits; B and BL to the same page are
followed (`b_f`, `bl_f`: the op stays, so the instruction count stays
exact, and BL's link is in the op). A block ends at BR/BLR/RET, a branch
to another page or to its own start, SVC, BRK, HVC/SMC/HLT, UDF and the
unallocated space, ISB, or the page end; a block that does not end in a
branch gets a `goto`. In the arena a block's ops are followed by its raw
words, four per 16-byte slot, which `validate` compares.

## Ops

16 bytes: kind, seven field bytes a..g, a 64-bit imm (the raw word is not
in the op). One instruction is always exactly one op, so an op index is a
count of retired instructions, `pcAt` recomputes pc from the ops (pc + 4,
or the target of `b_f`/`bl_f`), and budget, icount and faults need no
table.

- **Register operands** are slot indexes from `&regs.x`: 0..30 X, 31 SP,
  32 XZR, 33 NZCV (low half; FPCR is the high half), 35 TPIDR_EL0, 36 + 2n
  and 37 + 2n the halves of Vn. Register 31 is resolved at decode. Slot 32
  is regs.pc, which holds 0 while ops run (`run` stores 0 before a block,
  a `generic` op puts the real pc there for the reference and 0 back
  after, every way out sets pc), so XZR reads cost nothing. Only
  flag-setting ops write slot 32 (a 0, through a write mask, for
  CMP/CMN/TST); a non-flag op whose Rd is XZR decodes to `nop`, a load
  into XZR to `generic` (it still accesses memory).
- **Immediates** are pre-decoded: bitmask immediates expanded, shifts and
  negations folded, ADR/ADRP and literal addresses absolute (literal loads
  are loads from slot 32 + address), branch targets absolute, conditions
  as 16-bit masks (bit i = the condition holds for NZCV = i).
- **NZCV** stays architectural in regs.nzcv: every flag-setting op writes
  all four bits, and a condition is one shift of its mask by NZCV. A
  32-bit operation computes its flags on its operands shifted left by 32
  (one path for W and X; ADC/SBC's carry-in goes in at bit 32). Lazy flags
  are the JIT's business.
- **No branches in operand transforms.** Shifted and extended register
  operands are `((v << s1) >>a s2) & mask` (every LSL/LSR/ASR and
  UXT*/SXT* with its shift), so one kind covers them; ROR operands of the
  logical ops have their own kind. Bitfield moves are three shifts
  (`ubfm`, `sbfm`, `bfm` with the field mask), covering every alias.
  Variants of an operation are field bits turned into masks (`0 -% bit`):
  AND/ORR/EOR, ADD/SUB, the CSEL family, MADD/MSUB.
- **Precise faults.** Loads go to locals, registers are written last, in
  the reference's order (writeback, Rt, Rt2). A pair or Q access checks
  the TLB once when it lies in one page; else it takes the reference's
  path (loads one after the other; stores probe the whole range first). A
  fault leaves pc at the op and refunds the rest of the block. A store
  that hits decoded code ends the block after it (`.stop`), so
  self-modifying code runs the new instruction next.
- **Budget, interrupts.** `run` charges a block in full and refunds at a
  side exit or early exit; a block that does not fit the budget is
  single-stepped through the reference. A block that branches to its own
  start runs further passes inside `runOps`, each charged when the budget
  covers it. `*irq_pending` (and on SMP the code epoch) is polled at every
  block end and between self-loop passes: at least every 64 instructions
  and at every taken branch out of a block (a followed branch is not a
  poll point). MRS CNTVCT_EL0 is `generic` and returns `.counter`; `run`
  supplies the count as the reference does.
- **`generic`** runs `decode.exec` (the reference) on the raw word with pc
  set. It is what has no op: system instructions (MRS/MSR other than
  TPIDR_EL0, DMB/DSB on SMP (on one CPU they are `nop`), CLREX, DC, IC,
  ISB), exclusives, LDAR/STLR, LSE, all FP and AdvSIMD data processing,
  structure loads and stores, LDP of S/D, crypto, CRC32, and every
  reserved or unallocated encoding (the reference raises ILLEGAL). In
  qemu traces of ash, sort, gzip and apk, 0.6% of executed instructions
  are generic. Optional features are generic only, so decoded blocks do
  not depend on `kw_set_isa`.

### Op set (90 kinds)

| Kinds | Instructions |
| --- | --- |
| `nop`, `movi`, `movk`, `mov` | hints, PRFM, non-flag ops to XZR; MOVZ, MOVN, ADR, ADRP, MOV (bitmask imm); MOVK; MOV (register), MRS/MSR TPIDR_EL0, EXTR #0 |
| `add_i`, `adds_i` | ADD/SUB (immediate, SP forms); ADDS/SUBS/CMP/CMN (immediate) |
| `logic_i`, `ands_i` | AND/ORR/EOR (immediate, SP destination); ANDS/TST (immediate) |
| `add_rr`, `adds_rr` | ADD/SUB, ADDS/SUBS/CMP/CMN, NEG (register, no shift) |
| `addsub_r`, `addsubs_r` | the same with a shifted or extended register |
| `logic_r`, `ands_r`, `logic_ror` | AND/ORR/EOR/BIC/ORN/EON/MVN (shifted register); ANDS/BICS/TST; the logical ops with ROR #n |
| `ubfm`, `sbfm`, `bfm`, `extr` | UBFM, SBFM, BFM and all their aliases; EXTR, ROR (immediate) |
| `lslv`, `lsrv`, `asrv`, `rorv` | variable shifts |
| `csel`, `ccmp`, `adc` | CSEL/CSINC/CSINV/CSNEG and aliases; CCMP/CCMN; ADC/ADCS/SBC/SBCS |
| `madd`, `maddl`, `umulh`, `smulh`, `udiv`, `sdiv`, `rev1` | MADD/MSUB/MUL/MNEG; [SU]MADDL/[SU]MSUBL/[SU]MULL; UMULH; SMULH; UDIV; SDIV; RBIT/REV16/REV32/REV/CLZ/CLS |
| `ldr{8,16,32,64}_{i,w,r}` | LDR/LDRB/LDRH/LDRSB/LDRSH/LDRSW/LDUR*/LDTR* (unsigned and unscaled offset, pre/post index, register offset with every extend), LDR/LDRSW (literal) |
| `str{8,16,32,64}_{i,w,r}` | STR/STRB/STRH/STUR*/STTR*, STR B/H/S/D (the data slot is a V slot) |
| `ldp{32,64}`, `stp{32,64}`, `_w` | LDP/STP W and X (offset, pre/post, no-allocate), LDPSW, STP S and D |
| `ldr_v` | LDR B/H/S/D, all modes and literal |
| `ldr_q_{i,w,r}`, `str_q_{i,w,r}`, `ldp_q`, `stp_q`, `_w` | LDR/STR Q, LDP/STP Q |
| `bcond_x`, `cbz_x`, `tbz_x`, `bcond`, `cbz`, `tbz` | B.cond, CBZ/CBNZ, TBZ/TBNZ as side exits or terminators |
| `b_f`, `bl_f`, `b`, `bl`, `br`, `blr`, `goto` | B/BL followed or terminating; BR and RET; BLR; fall-through |
| `generic` | everything else |

Executed mix (qemu traces of ash, sort, gzip, gunzip, apk): bcond 11.3%,
mov 7.7, ldr64_i 6.9, add_i 6.6, adds_rr 5.2, adds_i 5.2, movi 5.0, cbz
4.6, ldr32_i 3.8, str64_i 3.0, ... generic 0.6.

### Adding an op

1. A kind in `ops.H` with its field layout in the doc comment. Every kind
   costs dispatch code (kwemu.md, Interpreter): share a kind where a field
   selects the variant without a branch.
2. Decode it in `ops.zig` only for encodings the reference accepts with
   exactly that meaning (mirror its checks, resolve register 31);
   everything else stays `generic`.
3. Semantics in `opexec.doOp`. No error union may cross a non-inlined call
   there: on wasm the result slots give `runOps` a stack frame (Rejected
   designs, a64/performance.md).
4. Its JIT family in `jit/` (`kinds`, `supported`, `usage`, `emit`, a
   kindtest line; the comptime check fails otherwise; a64/jit.md).
5. A template in the block fuzz (`tier_tests.zig`, `gen`) and, if no guest
   covers its edge values, a guest form.
6. `zig build test` (the fuzz and `--lockstep` compare with the
   reference, the wasm64 unit tests the JIT), and the bench before and
   after (a64/performance.md).

## Coherence and several CPUs

**One CPU.** Guest stores into decoded code are tracked exactly
(kwemu.zig's code-page filter: a store into a marked 64-byte chunk
retires the page's exec-TLB generations and ends the block), also through
other virtual aliases of the page, so self-modifying code takes effect at
the next instruction without IC IVAU. Writers the tracking does not see
(the kernel, another CPU) are covered by the flushes the kernel does on
any mapping change (every block revalidates against memory) and by IC
IVAU: `tier.icIvau` retires this CPU's exec-TLB entries that map the
line's physical page (cheap when the filter says the page holds no
decoded code, the common case of new code) and ends the running block.

**Several CPUs.** Each has its own `struct kw_cpu`, so another CPU's
store is not tracked here. IC IVAU therefore also bumps `code_epoch`, a
u64 in kwemu's static data (shared by all CPU threads; seq_cst atomic).
Every CPU compares it with the epoch it last saw at kw_run entry and at
every block end (beside the `*irq_pending` poll; compiled code polls it
too) and on a change retires all its generations. Guarantee: once IC IVAU
has retired on one CPU, every other CPU runs the new instructions from
its next block boundary (at most 64 instructions later), no ISB needed
there. The epoch exists only in atomics builds and the unit tests (two
`kw_cpu` on one memory); a UP kernel pays nothing. Cost on SMP: one
plain load per block end (not an atomic one: JavaScriptCore runs a wasm
atomic load as a read-modify-write, and every CPU polling the one word
that way ran user code on 4 CPUs at 0.35x of one, iPhone 15 Pro,
2026-11-23; the word has 128 bytes to itself), and a full retire (512 exec-TLB entries, then
one compare of raw words per block used again) per observed bump.

Alternatives not taken: checking the epoch only at ISB and kw_run entry
(what the architecture requires) lets a user loop without ISB keep stale
code up to a budget slice; with no cross-CPU invalidation at all, kwtest's
`jit: code run on CPU 1, changed on CPU 0` check ran 751695 of 877496
calls stale. A kernel broadcast (IC IVAU returning to the kernel, which
IPIs every CPU) needs a new event kind (ABI change) and an IPI round trip
per 64-byte line. A log of invalidated pages, so other CPUs retire only
those, is worth it only if a guest rewriting code on one CPU measurably
slows the others.

## The op arena

The machinery is kwemu.md, Interpreter (Cache). Why it is shaped so
(stats kernel, 2026-11-18): node's startup (`npm --version`, ~500M
instructions) decodes about once per 480 instructions, and at each arena
reset 84% of the arena was still live (about 12K blocks; a decode takes
about 22 slots). The working set is larger than any arena that fits
`KW_CPU_SIZE`, so compaction would free little; what pays is keeping
countdowns and compiled code across resets:

- A nursery reset keeps every block's table entry (pc, host, countdown;
  ops `op_gone`), and a re-decode of the same pc and host goes on
  counting. Compiled blocks' ops are in the tenured ring, so their code
  survives.
- The block table replaces the way with less countdown progress
  (`jitcore.victim`); the survivor loses half its progress. Without this
  conflict evictions lost 420M instructions of progress per npm command,
  and evicted region members failed their checked entry 1.16M times.
- The tenured part is a ring: a plain area that freed every module when
  full made short apk commands 10-15% slower (about 450 modules freed per
  command). It holds 128K ops, enough for the compiled set of one run of
  claude or bun, so a later process of the same non-PIE binary runs that
  code again instead of recompiling it (a64/performance.md, Tenured
  ring).

**Marking decoded code.** Every decode marks its 64-byte chunks in the
code-page filter (`markCode`). The write TLB (1024 entries) is scanned
only when a filter slot changes state: when a page becomes marked, when a
slot becomes wild (two pages share it: it then marks every page hashing
to it), or gets bits again after stores cleared them all; later fills see
the slot as marked. Scanning on every mark was 12% of npm's busy host
time (node's code spans far more pages than the filter's 4096 slots).

## Invariants (the tests check them)

- After every event (and with the same budget) registers, memory, event
  details and icount equal the reference loop's.
- An op never executes partly: a fault leaves no register, writeback or
  memory change and pc on the instruction.
- A block runs only under the exec-TLB fill it was validated against;
  stores into decoded code end the block at once; IC IVAU on any CPU is
  seen within one block boundary on every CPU.
- The budget is never overrun and a self-loop never skips the poll.

## Tests

- `tier_tests.zig`: stores into the running block and into a cached block,
  through a writable alias of an exec-only mapping, and into pages that
  share a wild mark slot; a kernel rewrite with and without a flush; a COW
  copy; set_pgd; IC IVAU on this CPU, on another `kw_cpu` (fails without
  the epoch) and from another thread while the first CPU spins in kw_run;
  faults in a block and in the second half of a store pair; every budget
  from 1 to 199 over a 40-instruction loop; the doorbell latency (an
  interrupt raised by a store is seen by the end of that block); arena
  resets.
- **The block fuzz** (same file): random instruction soups over two code
  pages (every ALU, bitfield, multiply and memory form with random fields,
  so reserved encodings too; branches of every kind, BR/BLR through ADR,
  SVC, BRK, UDF, FP, AdvSIMD and LSE words, system registers, CNTVCT,
  exclusives, stores of new instructions into the code, IC IVAU, ISB, DMB,
  a doorbell store; edge register values and equal operands) on a tier
  machine and a reference machine, with random budgets (1..5000), a lazily
  mapped page, a read-only one, and between slices kernel flushes, set_pgd,
  rewrites, COW copies and unmaps. 300 programs in `zig build test`; it
  also runs as the JIT fuzz (a64/jit.md, Tests). 2026-11-17: 30000
  programs after the last fixes, no difference.
- `kwemu-harness --lockstep SEED guest.elf ...`: a whole guest on the tier
  and the reference, random slices, compared at every event (memory every
  64 events and at exit); `a64-test.mjs` runs every guest so (seed 1).
