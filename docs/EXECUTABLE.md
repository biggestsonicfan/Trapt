# Trapt (SLUS-21255) — executable (`SLUS_212.55`) architecture

Reverse-engineering notes for the **code** in the retail US ELF. Companion to
[`tools/README.md`](../tools/README.md), which documents the **data** formats
(`AFS`, `RPS`/`.ARC`, `.SMI`, `.TM2`).

All addresses are EE virtual addresses. `vaddr 0x00100000` = file offset `0x80`.
Everything below was read out of the Ghidra database over the GhidraMCP HTTP
bridge (`http://127.0.0.1:8080`); nothing here is guessed from the disc alone.
Where a name is an inference rather than a fact it is marked *(inferred)*.

---

## 1. Binary facts

| | |
|---|---|
| Program | `SLUS_212.55`, MIPS R5900 (EE), one big `PT_LOAD` |
| Loaded range | `0x00100000` – `0x004827FF` (Ghidra block `SECTION4`) |
| Entry point | `0x00100008` |
| `.bss` | `0x00482800` – `0x0048FE80` (zeroed by the entry stub) |
| `_gp` | **`0x0048A0F0`** (`lui a0,0x49; addiu a0,a0,-0x5f10; move gp,a0` at `0x00100148`) |
| Initial stack | `0x2000` bytes, thread prio `0x100`, arg block `0x00482B00` |
| Functions recovered | 7832 (106 named — all of them SDK syscall stubs) |
| Build date | **2003-08-22, ~12:13** (identical across every CRI middleware banner) |

`_gp`-relative names Ghidra prints as `xxxGpffffNNNN` convert to an absolute
address with `0x0048A0F0 + (int32)0xffffNNNN`. Example: `iGpffff8768` →
`0x00482858`, which is the same global `main` reads as `iRam00482858`.

### Address-space layout

```
0x00100000 .. ~0x0011F000   custom C++ runtime + cooperative task kernel   (~760 fn)
~0x0011F000 .. ~0x00168000  Sony EE SDK + CRI middleware                   (~1900 fn)
~0x00168000 .. ~0x00342000  game code                                      (~5100 fn)
 0x00342000 .. 0x0042xxxx   data: VU/DMA blobs, TOC, pointer tables
 0x0042xxxx .. 0x0045xxxx   string pool (15506 defined strings)
 0x0046C790 .. 0x00471EF0   29 late functions — static C++ constructors
 0x00472BC0 .. 0x00472D04   __CTOR_LIST__ (81 entries)
 0x00473000 .. 0x0047Axxx   C++ vtables
 0x00482800 .. 0x0048FE80   .bss
```

Ghidra also maps the PS2 hardware windows (`registers.io`, `vu0.code/data`,
`vu1.code/data`, `registers.gs`, `iop_ram`, `scratchpad`, BIOS) and the two
mirrors of main RAM at `0x20000000` (uncached) and `0x30100000`
(uncached+accelerated). **Every string and xref therefore shows up three
times** — once per mirror. Filter to `^00`.

---

## 2. Startup

### 2.1 CRT

```
entry @0x00100008
  ├─ zero .bss 0x482800..0x48FE80
  ├─ syscall 0x3C / 0x3D          (SetupThread / SetupHeap)
  ├─ FUN_0012b7e8(...)            _InitSys: heap 0x48FE80 + 0x2000, prio 0x100
  ├─ FlushCache(0); EI()
  └─ FUN_00100760(argc, argv)     "main" wrapper
       ├─ FUN_001005e0()          reset runtime globals at 0x00482800
       ├─ FUN_001006a0(4)         operator new
       ├─ FUN_00100730()          __do_global_ctors → FUN_00100c10(0x472BC0, 0x472D04, ...)
       ├─ FUN_00108d30(&x, 0x100, 0x30, 0x4000)   ← system singleton (see §3)
       ├─ FUN_0010bad0(sys+0x70)  start the main task, then SleepThread()
       └─ thunk_FUN_00100b80()    __do_global_dtors
```

`FUN_00100730` is `__do_global_ctors`: the ctor table is `[0x00472BC0,
0x00472D04)` = **81 function pointers**, spanning `0x0046A500` … `0x00472B70`.
The dtor/atexit list head is `0x004820E0`. The static-ctor cluster at
`0x0046C790`–`0x00471EF0` is where most module-level tables (including the
debug room-select tables, §9) get filled in.

### 2.2 Hardware / IOP bring-up

`FUN_001466d0` (called once from `FUN_00108d30`) is the boot sequence:

| order | function | what it does |
|---|---|---|
| 1 | `FUN_00106dc0` | SIF RPC init; installs an object with vtable `0x00473148` |
| 2 | `FUN_0010e5e0` | **IOP reboot** with `cdrom0:\MODULES\IOPRP270.IMG;1` (`0x00425FB0`), then re-init SIF / cdvd / mc |
| 3 | `FUN_00106e60` | load `SIO2MAN.IRX` |
| 4 | `FUN_00233e70` | load `MCMAN.IRX`, `MCSERV.IRX` |
| 5 | `FUN_001055f0(2,1,0)` | load `PADMAN.IRX`, then `FUN_0013e118(0)` = pad init |
| 6 | `FUN_00181ea0` | load `LIBSD.IRX`, `SSD.IRX`, `RSSD.IRX` from the table at `0x00369A40` (5 retries each) |
| 7 | `FUN_0019e000(1)` | load `CRI_ADXI.IRX` (also `LIBSD.IRX` when the arg is 0) |
| 8 | `FUN_0010aa30` | allocate the 0x1000-byte task pool: 127 free-list nodes, vtables `0x00472D48` / `0x00473490` |

Then `FUN_001466a0` runs subsystem init:

* `FUN_001820d0` — sound: `FUN_00163b58` (Ssd-EE / RSSD driver) with a
  0x20000-byte IOP buffer, 10 slots, 0x40 voices; then `FUN_00165d80(0, 0x2b)`.
* `FUN_0019df10` — ADX/streaming server task (waits on VBLANK, §3).
* `FUN_0019dda0(0x28, 0x80)` — ADX stream pool.

**Full IRX set on disc:** `IOPRP270.IMG`, `SIO2MAN`, `PADMAN`, `MCMAN`,
`MCSERV`, `LIBSD`, `SSD`, `RSSD`, `CRI_ADXI`.

---

## 3. The task kernel (`0x00100000`–`0x0011F000`)

This range is **not** Sony SDK code — it is the developer's own C++ runtime:
`operator new` (`FUN_001006a0`), string/memory helpers, and a cooperative
multitasking kernel layered on EE threads and INTC handlers. The singleton is
created by `FUN_00108d30` and cached in `iGpffff8768` = **`0x00482858`**.

The singleton is a 0x160-byte object. Known fields:

| offset | meaning |
|---|---|
| `+0x70` | the main task object (started by `FUN_0010bad0`) |
| `+0xA0` / `+0xA4` | INTC 2 — **VBLANK_START** event + waiter list |
| `+0xC0` / `+0xC4` | INTC 3 — VBLANK_END |
| `+0xE0` / `+0xE4` | INTC 0 — GS |
| `+0x100` / `+0x104` | INTC 1 — SBUS |

The four `AddIntcHandler` registrars, each installed lazily on first wait:

| function | INTC cause | trampoline |
|---|---|---|
| `FUN_001099d0` | 0 (GS) | `0x00109B90` |
| `FUN_00109700` | 1 (SBUS) | `0x001098A0` |
| `FUN_00109F90` | 2 (VBLANK_START) | `0x0010A130` |
| `FUN_00109CC0` | 3 (VBLANK_END) | `0x00109E60` |

`FUN_0010b650(cbset)` registers all four at once from a single 16-byte callback
block — that is how a subsystem hooks the whole frame. `FUN_00109640` /
`FUN_001095f0` are the kernel lock/unlock around `gp0xffff8770` =
`0x00482860`. `RCNT0` is programmed (mode `0x83`, count 0) at the end of
`FUN_00108d30` as the free-running frame timer.

---

## 4. Middleware inventory

Version banners are all dated **Aug 22 2003**. The `code around` column is a
function that references the banner or an error string, i.e. roughly where that
library sits.

| library | version | code around |
|---|---|---|
| `PsIIlibpad` | 2700 | `0x0013E000` |
| `PsIIlibdma` | 2700 | `0x00120FA8` (channel table `0x003482F0`: `0x10008000` … `0x1000D400`) |
| libgraph / `sceGs*` | — | `0x0011F6B8` – `0x0011FCB4` |
| libcdvd | — | `0x00130358` |
| libmc | — | `0x00131548` |
| CRI **SKG**/PS2EE | 0.64 | — |
| CRI **ADXF**/PS2EE | 7.10 | object `0x0034D288` |
| CRI **ADXT**/PS2EE | 8.92 | `0x0014E2F8` |
| CRI **ADXPS2** | 2.45 | `0x0014F548` |
| CRI **ADXRT** | 2700 | `0x00152910` |
| CRI **CVFS**/PS2EE | 2.34 | object `0x00359FA8` |
| CRI **SRD**/PS2EE | 2.18a | object `0x00359FF0` |
| CRI **LSC**/PS2EE | 2.14 | object `0x0035C520` |
| CRI **SJ**/PS2EE | 6.18 | object `0x00363050` |
| CRI **SJRMT** | 1.01 | — |
| CRI **SJX** | 1.05 | — |
| CRI **SVM**/PS2EE | 1.51 | — |
| CRI **PS2RNA** | 1.21 | `0x0015F5A0` |
| Sony **Ssd-EE** (RSSD) | "Spu memory check ver 1.1" | `0x00163B58` |

In short: **CRI for streamed audio and the AFS filesystem, Sony SD/SSD for
sampled SE**, stock Sony libs for everything else.

---

## 5. File system

### 5.1 The baked-in TOC

`DATA/GAME.DAT` is a CRI AFS container with no filename table of its own. The
names live in the ELF, in a flat array at **`0x0036A0F0` … `0x003751CC`**:

```c
struct TocEntry {          /* 12 bytes */
    const char *name;      /* e.g. "DATA/AI/RC.ARC" */
    u32         size;      /* bytes */
    u32         afs_id;    /* index into GAME.DAT */
};                         /* 3773 entries (0x0EBD) */
```

First entry: `{"DATA/AI/RC.ARC", 0x12DC, 0}`. Last: `{name@0x0044E430,
0x0637C0, 0xEBC}`. The count `0xEBD` appears literally in `FUN_001B8450`, which
builds the lookup index; `FUN_001B8300` is the name→index search and
`FUN_001B7E90` wraps it. The stream open `FUN_001ABA90` reads the size straight
out of `DAT_0036A0F4 + idx*12` and rounds it up to a 0x800 multiple.

`FUN_001AC490` opens `"DATA/GAME.DAT"` (`0x0042E3D0`) and parks the stream
object in `0x004828F0`.

`FUN_001ABA90` also has an `sdif://` branch (string at `0x0042E3C8`) that
bypasses the TOC entirely — a leftover host/dev-kit virtual filesystem.

### 5.2 Asynchronous load requests

```c
long FUN_00309840(const char *path, u16 group, u32 flags,
                  void *user, void (*done)(...), void *arg);
```

Allocates a 0x138-byte job (ctor `FUN_001ABCA0`), opens `path` with a 0x2000
read granule, bails if the size is ≤ 0, otherwise stores `(group << 16) | flags`
and starts the job. `done` defaults to `0x00309340`. 59 call sites. Observed
groups: `1` common, `3` traps/gimmicks, `5` title UI, `0x20` characters,
`0x26` trap/gimmick async.

The pending-job list lives at `0x004828CC` and is pumped once per frame by
**`FUN_001B8550`** from the top-level tick (§6).

---

## 6. Top-level game state machine

> **Correction (verified live in PCSX2):** `FUN_0016B870` is *not* the
> application-level flow. A breakpoint on it never fires during boot -> logo ->
> title -> attract, so it is the **in-room / gameplay** machine. The real
> per-frame application state machine is **`FUN_00178520`** (0x2D states, state
> word at `[0x004828A8]`), driven from the frame component list in
> `FUN_00140A00`. It owns the logo/title/attract loop and every cutscene
> transition. See [`CUTSCENES.md`](CUTSCENES.md) sections 1.1-1.2.

`FUN_0016B870(this)` is the master `switch` — 23 states read from `this+8`. It
is the tail of every frame: after the handler runs it calls
`(*this->vtbl_1C[3])(this + 0x14)`, then pumps the room streamer
(`FUN_0017C650`, if `0x004828BC` is live) and the file-load queue
(`FUN_001B8550`, if `0x004828CC` is live). The state setter is
`FUN_00167210(this, newState)`.

| state | handler | notes |
|---|---|---|
| 0 | `FUN_0016B610` | first-run setup; allocates a 0x5A0 object (`FUN_00177660`) |
| **1** | `FUN_0016B320` | **boot load** — issues `data/common/free.arc` and `data/common/common.arc` (group 1, heap 3) and `data/common/occupation.arc` (group 1, heap 1), then advances to state 2 |
| 2 | `FUN_0016AE00` | actor / camera bring-up |
| 3, 0xD | — | no-op (idle / hold) |
| 4 | `FUN_0016AD40` | sub-modes 0 and 4 |
| 5 | `FUN_0016AC90` | sub-mode 1 |
| 6 | `FUN_0016ABC0` | sub-mode 2 |
| 7 | `FUN_0016AA40` | sub-mode 3 |
| 8 | `FUN_0016A780` | |
| 9 | `FUN_0016A240` | |
| 0xA | `FUN_00169D60` | largest handler — in-game/gameplay *(inferred)* |
| 0xB | `FUN_00168CA0` | |
| 0xC | `FUN_00168690` | |
| 0xE | `FUN_001685B0` | |
| 0xF | `FUN_00169A60` | |
| 0x10 | `FUN_001697A0` | |
| 0x11 | `FUN_00168FC0` | |
| 0x12 | `FUN_00168B50` | |
| 0x13 | `FUN_001687E0` | teardown — releases nearly every subsystem singleton |
| 0x14 | `FUN_001687A0` | |
| 0x16 | `FUN_0016AD40` (thunk) | |

States 4–7 share a sub-dispatcher: `FUN_00336800` allocates a 0x1C-byte object
into `iGpffff89E0` with vtable `0x00474738`; `FUN_003367D0(obj, n)` arms
sub-mode *n*; `FUN_00336710` runs it (`FUN_003362B0`, `FUN_00335BA0`,
`FUN_003355E0`, `FUN_00334EF0`) and reports the next top-level state.

`FUN_0016B870` is invoked from three places: `FUN_00173908` (inside
`FUN_00173520`, the scene-sequence driver), and `FUN_00328680` / `FUN_0032A8E0`
on the staff-roll / ending path.

`FUN_00173520` is the scene **sequencer** — a 13-state flow (`case 0..0xC`)
that creates a scene object (`FUN_00323DF0`, 0x14 bytes), calls its init
(`vtbl+0x0C`), polls update (`vtbl+0x10`) until it returns 0, then exit
(`vtbl+0x14`) and release (`vtbl+0x08`). This is the machinery behind every
title/menu/movie transition.

---

## 7. Content subsystems

### 7.1 Data tree (unique path shapes from the TOC)

Counts are distinct path strings in the ELF, case-normalised.

| dir | paths | contents |
|---|---|---|
| `DATA/SOUND` | 1343 | `BGM/*.ADX`, `VOICE/*.ADX`, `DI/*.ADX`, `SE/*.SED` + `*.SWD` |
| `DATA/CHARA` | 1045 | per-model `.ARC`, plus `_TEX`, `_SE`, `_H` (hair), `_DEAD_B/F/S` |
| `DATA/RT` | 314 | real-time cutscenes: `E##/*.SAI`, `COSTUME/`, `MAP_COL/*.COL`, `RT_IGS_*` |
| `DATA/SCRIPT` | 315 | `SC_<char>.ARC`, `SC_R??.ARC`, `B##EVENT.ARC`, `R??DEBUG.ARC` |
| `DATA/TWO_D` | 156 | 2D/UI archives, one directory per screen (§7.4) |
| `DATA/GIMMICK` | 169 | `G{C,W,F}##.ARC` |
| `DATA/ROOM` | 154 | `R??_ALL / _ATH / _DIA / _DIM / _SE / _ULD .ARC` |
| `DATA/SHADOW_RENDER` | 48 | `R??_RI.SMI` — shadow-receiver geometry |
| `DATA/MAP_DATA` | 69 | `BIN/M##.BIN`, `COLLISION/MAP_#_COL.ARC`, `DOOR/*.ARC` |
| `DATA/TRAP` | 48 | `T{C,W,F}##.ARC` |
| `DATA/CAM_PATH` | 37 | `.CAM` camera splines |
| `DATA/EFFECT` | 33 | `EF_R??.ARC`, `EF_COMMON.ARC`, `PARAM.ARC`, `DI/` |
| `DATA/COMMON` | 20 | `COMMON.ARC`, `FREE.ARC`, `OCCUPATION.ARC`, `DEBUG.ARC` |
| `DATA/AI` | 3 | `RC.ARC`, `RH.ARC`, `RP.ARC` — one AI bundle per area |
| `DATA/ESTAB` | 2 | `ES_FIRST.ARC`, `ES_NAME.ARC` (establishing shots) |
| `DATA/FONT` | 2 | `FONT.BIN`, `WORKING/KEYWORD.DIC` |
| `DATA/CAMERA` | 2 | `INIT.BIN`, `TRAP.BIN` |

Authoring paths survive in the string pool: `DATA_SRC/TRAPCOMMON/CSV/TC00.TD`,
`DATA_SRC/TRAPCOMMON/TSD/TC00.TCD`, `DATA_SRC/TRAPCOMMON/SD/TC00.SD`,
`DATA_SRC/SBD/SE_TRAP_TC00.SBD`, plus `DATA/CSV/TEST.CSV` and
`DATA/CSV_BIN/TEST.CSV` — the trap tables were authored as CSV and compiled.

### 7.2 Traps and gimmicks

Both are the same object type, distinguished by id. `FUN_00262C30(obj, async)`
builds the archive name **in place** by patching the template strings
`"DATA/TRAP/TC00.ARC"` (`0x0037E2F0`, patch at +11) and
`"DATA/GIMMICK/GC00.ARC"` (`0x0037E310`, patch at +14):

* `FUN_0026DE30(id)` → group index 0/1/2, used to index the `"CWF"` letter
  table at `0x004824A4` → **C**eiling / **W**all / **F**loor.
* `FUN_0026DE80(id)` → the two-digit number (`id − base`).
* Range table at `0x00482488`: bases `{0x00,0x10,0x20}` for traps and
  `{0x30,0x70,0xB0}` for gimmicks; the boundaries scanned from `0x00482489`
  are `{0x10,0x20,0x30,0x70,0xB0}`.

| id range | archive | present on disc |
|---|---|---|
| `0x00`–`0x0F` | `DATA/TRAP/TC00..TC15.ARC` | 16 |
| `0x10`–`0x1F` | `DATA/TRAP/TW00..TW15.ARC` | 16 |
| `0x20`–`0x2F` | `DATA/TRAP/TF00..TF15.ARC` | 16 |
| `0x30`–`0x6F` | `DATA/GIMMICK/GC00..GC63.ARC` | 60 |
| `0x70`–`0xAF` | `DATA/GIMMICK/GW00..GW63.ARC` | 52 |
| `0xB0`–`0xEF` | `DATA/GIMMICK/GF00..GF63.ARC` | 48 |

So **48 player traps** (16 per surface) and up to 192 gimmick slots, of which
160 shipped. Sound banks match one-for-one:
`DATA/SOUND/SE/SE_TRAP_T{C,W,F}##.SED` / `.SWD`.

The async path is `FUN_00309840(name, 0x26, 3, obj, 0x00262D80, 0)`; the
synchronous path uses `FUN_001ABCF0` + `FUN_00262B40`.

### 7.3 Rooms

**Room lifecycle** — nine states, whose debug labels are 0x80-byte line
templates at `0x00369480`, stride `0x80`:

```
0 ROOM NON_INIT   3 ROOM SETUP     6 ROOM READY
1 ROOM INIT       4 ROOM COMPLETE  7 ROOM SAFETY
2 ROOM LOAD       5 ROOM CANCEL    8 ROOM RELASE   [sic]
```

`FUN_0017C100(mgr)` builds the debug overlay: it walks the room list
(intrusive, `+0x08` = next, `+0x10` = name, `+0x34` = state) and bins each room
into its state's line. Callers: `FUN_0017B7B0`, `FUN_0017BAF0`, `FUN_0017BCA0`.
The room-texture manager logs `"ROOM TEX PASSING(%s) FREE(%s:%s)\n"`
(`0x0042DFF0`) from `FUN_0017BFE0`.

The per-frame streamer is `FUN_0017C650`, operating on the manager at
`0x004828BC`: tick (`FUN_0017AA20`), then `FUN_0017BCA0` when the pending index
differs from the current one, and `FUN_0017BDA0` when the current index is `-1`.

**Room name tables** (both written by static ctors; no runtime readers, §9):

* `0x00451300` — 8-entry quick list: `rh01 HOUSE ENTRANCE`, `rh04 HOUSE BELFRY`,
  `rh06 HOUSE STAIRS`, `rh10 HOUSE SEAL B`, `rp05 PALACE CLOCK`,
  `rc01 CASTLE ENTRANCE`, `rc03 CASTLE OFFICE`, `rc04 CASTLE OPERATION`.
* `0x00451400` — full list: `rh01`–`rh18` (House), `rp01`–`rp16` (Palace),
  `rc01`–`rc15` (Castle), `rt01`–`rt04` (real-time cutscene stages), plus
  `rt03 / rt97 / rt98 TEST`.

The corresponding pointer arrays are at `0x00451128` and `0x00451168`.

### 7.4 2D / UI screens

Each two-letter code is a screen with its own `.arc` and loader. The
`sp_<code>NN` strings scattered through `0x0044E500`–`0x0045F000` are the
sprite-page names inside each archive.

| code | archive | loader | meaning *(inferred unless noted)* |
|---|---|---|---|
| `TI` | `TWO_D/TI/ti.arc` | `FUN_0017DC10` (vtable `0x0047549C`) | Title |
| `OP` | `OP/op.arc` | `FUN_0021CC00` | Opening |
| `LG` | `LG/lg.arc` | `FUN_00215990` | Logo |
| `GS` | `GS/gs.arc` | `FUN_0022A010` | Game start / new-game menu |
| `LS` | `LS/ls.arc`, `LS/icon.arc` | `FUN_0022BFA0`, `FUN_0022FB40`, `FUN_00233900`, `FUN_002315D0` | Load / Save (confirmed by the save-slot table, §7.7) |
| `KC` | `KC/kc.arc` | `FUN_0022ADC0` | Key config |
| `EQ` | `EQ/eq.arc` | `FUN_00214FA0` | Equip |
| `TE` | `TE/te.arc` | `@0x00215194` | — |
| `GA` | `GA/ga.arc` | `FUN_00228920` | Gallery |
| `MU` | `MU/mu.arc` | `FUN_002367D0` | Music |
| `ST` | `ST/st.arc` | `FUN_00237900` | Status |
| `EM` | `EM/em.arc` | `FUN_002B17A0` | — |
| `EI` | `EI/ei.arc` + `M##INTRUDER.BIN` | `FUN_002B3FF0` | Enemy/intruder info |
| `MC` | `MC/mc.arc` | `FUN_002B7850` | Memory card |
| `EX` | `EX/ex.arc` | `FUN_002B8CE0` | — |
| `MM` | `MM/mm.arc` | `FUN_002B9740` | — |
| `IM` | `IM/im.arc` | `FUN_002BA250`, `FUN_003292E0` | — |
| `PI` | `PI/pi.arc` + `C##F_*_S.ARC` | `FUN_002D5ED0` | Portrait |
| `TM` | `TM/tm.arc` | `FUN_002D9970` | — |
| `EL` | `EL/el.arc`, `el2.arc` | `FUN_002DB1D0`/`3B0`, `FUN_002DCBD0`/`DE0` | — |
| `MJ` | `MJ/mj.arc` + `mj_r{h,p,c}.arc` | `FUN_002F4090`, `FUN_002F7210` | Map |
| `TS` | `TS/ts.arc` + `TS/TRAP/T{C,W,F}_M##.ARC` | `FUN_002FB550` | **Trap select** (icon set matches the trap ids) |
| `STF` | `STF/stf01.arc` | `FUN_0032A3F0` | Staff roll |
| `DIZ` | `DIZ/diz.arc`, `DI##.ARC` | `@0x0032D7EC` | Dialogue |
| `IC` | `IC/ic.arc` | `FUN_003374B0` | Icons |
| `AM` | `AM/am.arc` + `am_r{h,p,c}.arc` | tables `0x00376530`, `0x0037B6B0` | Auto map |
| `CP` | `CP/cp.arc` | table `0x00376530` | — |
| `SLD` | `SLD/SLD*.ARC` | — | Slideshow / loading art |

### 7.5 Characters

Model-name pointer table at **`0x00369120`, 215 entries** (last entry
`0x00369478`; the ROOM state strings begin immediately after at `0x00369480`).
Names are `c<NN><m|f>_<a..w>` (e.g. `c30m_a`), with:

* index **211** = `"DUMMY"` (`0x0042D650`)
* indices **212–214** = `"ALISIA_A"` / `"ALISIA_B"` / `"ALISIA_C"` (`0x0042DE80`+)

Some entries carry a leading `"* "` (e.g. `"* c15m_a"`, `"* c30m_a"`) — an
authoring marker that survived into the retail table.

`FUN_001C8CA0(name)` resolves a script actor name to a live actor: `"DUMMY"`
(`0x0044E9B8`) means *the current actor*; otherwise it compares
`g_charNames[actor->modelId]` (`actor + 0x204`) against `name`, first for the
player actor and then across the actor list at `iGpffff87B0`.

`FUN_00177370(actor, arg)` loads an actor's three archives, rewriting the
extension of a base name produced by `FUN_001FBA60`:

1. `<name>_tex.arc` (`0x0042DEE8`) — group `0x20`, into a 300000-byte
   64-byte-aligned scratch buffer (`FUN_00100640`), callback `0x001772D0`
2. `<name>.arc` — group `0x20`, callback `0x00177320`
3. `<name>_se.arc` (`0x0042DEF8`) — group `actor+0xA0`, callback `0x001FBAE0`

Progress bits accumulate in `actor+0x2A6` (`= 1`, `|= 4`, `|= 2`, `|= 0x10`).

Bone names appear as literals: `koshi` (hips), `atama` (head), `ashi_R`,
`ashi_L`. Lip-sync clips are `clip_{m,f}_{a,e,i,o,u}`. Room-boundary interface
names are `IF_north/south/east/west/ceiling/floor/distant` and `PARENT`
(`0x0044E888`, referenced from data at `0x00376A30`).

### 7.6 Sound

* **SE**: Sony SD via `SSD.IRX` / `RSSD.IRX`. `FUN_001820D0` initialises with
  10 slots, 0x40 voices, a 0x20000-byte IOP buffer.
* **SPU2 bank map** at `0x0044FE60` — 8 entries of `{id, kind, spu_addr, size}`:

  | id | kind | SPU2 addr | size |
  |---|---|---|---|
  | 0 | 1 | `0x008000` | `0x034000` |
  | 1 | 1 | `0x1E0000` | `0x00B000` |
  | 2 | 2 | `0x03C000` | `0x033000` |
  | 3 | 1 | `0x0A2000` | `0x01A000` |
  | 4 | 1 | `0x0BC000` | `0x019000` |
  | 5 | 1 | `0x0D5000` | `0x01A000` |
  | 6 | 2 | `0x0EF000` | `0x05F000` |
  | 7 | 3 | `0x1EB000` | `0x004000` |

* **Bank names** at `0x0044FEE0`: `SE_SYSTEM`, `SE_PLAYER_C01FA`,
  `SE_TRAP_TC00` … `SE_TRAP_TF15`, `SE_MAP_R??`, `SE_DOOR_R?`.
  `FUN_00181F70` registers eight of them plus the `data/sound/se/` prefix
  (`0x0042E1F0`) into the sound manager (`FUN_001E2410`).
* **Streams**: CRI ADX for BGM (`DATA/SOUND/BGM/{S,E}##.ADX`), voice
  (`DATA/SOUND/VOICE/*.ADX`) and per-room ambience
  (`DATA/SOUND/DI/SE_DI_R??.ADX`).
* Mixer/reverb channel names at `0x00369000`: `Unuse`, `System`, `Driver`,
  `Stream`, `RevCore0..3`, `OWBlock`, `Sampling`.

### 7.7 Save data

Five slots, directory names `BASLUS-21255SAV00` … `SAV04` at `0x00451BE0`,
stride 0x20. Pointer tables at `0x0037CE80`/`0x0037CE90` and `0x0037CEB0`.
Consumers are the LS screen: `FUN_0022AFA0`, `FUN_0022CBE0`, `FUN_00233590`.
The save icon comes from `DATA/TWO_D/LS/icon.arc`.

---

## 8. Scripting

* Per-character behaviour: `DATA/SCRIPT/SC_C##[MF]_?.ARC` (one per model), plus
  `SC_COMMON.ARC` and `SC_DUMMY.ARC`.
* Per-room: `DATA/SCRIPT/SC_R{H,P,C}##.ARC`.
* Events: `DATA/SCRIPT/B##EVENT.ARC`, name built from `"b%03devent"`
  (`0x0044EB80`); cutscene sub-events use `evsub_` / `evsub_realtime`
  (`0x0044EB60`, referenced from `FUN_001DBE20`).
* Debug variants: `DATA/SCRIPT/R{H,P,C}##DEBUG.ARC` — 22 of them; see §9.
* AI bundles: `DATA/AI/RH.ARC`, `RP.ARC`, `RC.ARC` — one per area. They are
  literally the first three files in `GAME.DAT` (TOC ids 0–2).

Name-building format strings used by the script/effect layer: `"%s%s.arc"`,
`"se_%s"`, `"ef_%s_init"`, `"ef_%c%03d"`, `"ef_%c%03d_%02d"`, `"ef_t%s%02d"`,
`"ef_t%s%02d_%02d"`, `"rt_ig%c_%s"` (`FUN_001CB6E0`), `"sp_i%s"` / `"sp_n%s"`,
`"%s_%03d"`, `"%s_%c%d"`.

---

## 9. Debug / dev leftovers

None of this is reachable in retail; it is recorded so it is not
re-investigated.

* **`DATA/COMMON/DEBUG.ARC`** ships known primitives (`CONE.SMI`, `SPHERE.SMI`,
  `CYLINDER.SMI`, `DUMMY_MODEL.SMI`/`.TM2`, `DUMMY_MOTION.SAI`) but **nothing on
  the disc or in the ELF references it** — verified by a full-disc AFS scan plus
  an ELF string/xref scan. Any use of these assets needs injected code.
* **Room-select menus** at `0x00451128` (8-room quick list) and `0x00451168`
  (full list, including the `rt03 / rt97 / rt98 TEST` rooms) are written by the
  static-ctor cluster around `0x0046E160`–`0x0046E7AC` — the same ctor that sets
  the current debug room to `-1` — and have **zero readers**. The menu was
  compiled out.
* `FUN_001ABA90`'s `sdif://` branch (`0x0042E3C8`) is a dev host-loader remnant.
* `"xxxx-xxxx-xxxx-xxxx-xxxx-xxxx"` (`0x0042E200`) is handed to the Ssd-EE init
  as a placeholder id.
* `DATA/TEST/*`, `DATA/CSV/TEST.CSV`, `DATA/CAM_PATH/TEST.CAM` and
  `DATA/SOUND/TEST/**` are all still in the TOC.
* Error text for every CRI library is linked in, so a TTY-attached build would
  print real diagnostics.

---

## 10. Working with the Ghidra bridge

The GhidraMCP HTTP bridge is **not** exposed as an MCP tool here — drive it with
`curl`. `GET /` returns the full endpoint catalog (37 endpoints). The ones that
matter:

```sh
B=http://127.0.0.1:8080
curl -s "$B/list_functions"                             # every function + entry addr
curl -s "$B/strings?filter=DEBUG&limit=200"
curl -s "$B/xrefs_to?address=0x0036a0f0&limit=50"
curl -s "$B/xrefs_from?address=0x001466d0"
curl -s "$B/decompile_function?address=0x0016b870&timeout=120"
curl -s "$B/disassemble_function?address=0x00100008"
curl -s "$B/read_memory?address=0x0036a0f0&length=96"   # hex, max 0x10000
curl -s "$B/loose_code?kind=orphan"                     # code belonging to no function
```

Write endpoints (`/rename_function_by_address`, `/set_function_prototype`,
`/set_decompiler_comment`, …) take **form-encoded POST** bodies and mutate the
Ghidra database; they are only undoable from the Ghidra GUI.

Two gotchas:

1. **Every address appears three times** — `0x00xxxxxx`, `0x20xxxxxx` and
   `0x30xxxxxx` — because Ghidra maps the uncached RAM mirrors.
2. Application errors (bad address, nothing found) come back as **HTTP 200**
   with a human-readable body, not as an HTTP error.

### Open threads

* Name the remaining top-level states 8–0x14 (§6). Fastest route is a live PCSX2
  breakpoint on `FUN_00167210` to log real transitions.
* The renderer has not been traced. The game uses stock `libgraph`/`libdma`; the
  VU1 microcode blobs sit somewhere in `0x00342000`–`0x00420000` and have no
  symbols yet.
* `.SSC` is done -- see [`CUTSCENES.md`](CUTSCENES.md) (VM dispatch table at
  `0x00376660`, format and decoder in `tools/ssc.py`). Loaders for `.COL`
  (collision), `.SAI` (animation), `.CAM`, `.CKF` and
  `.NVM` are still unidentified in code — pairing each with the format work in
  `tools/README.md` is the obvious next step.
