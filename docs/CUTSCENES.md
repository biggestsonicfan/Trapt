# Trapt (SLUS-21255) — real-time cutscenes and the `.SSC` scene VM

How the game's 154 real-time cutscenes are stored, sequenced and played, worked
out end-to-end from the **opening cutscene** (`e001`) as it runs in the title
attract loop. Companion to [`EXECUTABLE.md`](EXECUTABLE.md) (code) and
[`../tools/README.md`](../tools/README.md) (asset formats).

Addresses are EE virtual addresses in the retail US ELF. Everything below was
either decompiled over the GhidraMCP bridge or read out of live EE RAM in PCSX2;
where the two disagree the live value wins and is called out.

---

## 1. Where the opening cutscene lives

Trapt has **no FMV**. Every cutscene is rendered in-engine by a scene VM that
runs compiled `.SSC` bytecode against the normal room/actor/camera systems. The
opening is just cutscene id **0**, played by the attract loop.

### 1.1 The real top-level flow is `FUN_00178520`

`FUN_00178520(component)` is the per-frame application state machine — a
**0x2D-state** switch, far larger than `FUN_0016B870` (§6 of `EXECUTABLE.md`).
It runs from the frame component list walked by `FUN_00140A00`, which is driven
by the main task:

```
main task 0x00108840 → 0x00108E70 → 0x001089C0 → 0x0010B230
                     → 0x00146790 → 0x0013F3A0 → 0x00140A00   (component list)
                                               → 0x00178520   (app flow)
```

The state itself is a `u16` at offset 0 of the object pointed to by
**`0x004828A8`** (`FUN_00171D50` returns the pointer, `FUN_00171BE0` /
`FUN_00171BF0` get/set the state). `0x004828A4` holds a second, parallel object.

> Observed on a live title screen: `[0x004828A8] = 0x00BD2610`, `u16` there `= 7`.
> A breakpoint on `FUN_0016B870` never fires anywhere in the boot → title →
> attract cycle, so that switch is the **in-room/gameplay** machine, not the
> application one.

App-flow state **6** allocates the 0x18-byte boot sequencer
(`FUN_00211B60`, vtable `0x00478D00`) and state **7** polls its `update`
(`FUN_002117C0`) until it returns 0.

### 1.2 The attract loop is `FUN_002117C0`

The 0x18-byte sequencer object is the attract loop. Layout:

| off | meaning |
|---|---|
| `+0x00` | vtable `0x00478D00` (`+8` release, `+0xC` init `0x00211AA0`, `+0x10` update `0x002117C0`, `+0x14` exit) |
| `+0x04` | sub-state |
| `+0x08` | frame counter (never reset — counts the whole attract session) |
| `+0x10` | current child screen |
| `+0x14` | result handed back to app-flow state 8 (`1` → state 0xF, `2` → state 0xC) |

```
sub-state 0  FUN_00211700  create LG  (logo,  0xB70 bytes, vtable 0x00478DD0, init FUN_00215990)
          1,2               poll / release
sub-state 3  FUN_00211660  create TI  (title, 0xB90 bytes, vtable 0x00475490, init FUN_0017DC10)
          4,5               poll / release; child result 1 or 2 → leave the loop (sub-state 0xC),
                            anything else → fall through to the demo
sub-state 6  FUN_002C02F0  create the RT cutscene player (0x50 bytes, vtable 0x0047BEB0),
                            then FUN_002BFA70(player, 0)      ← cutscene id 0 = the opening
          7,8               poll / release
sub-state 9 → 0xA → 0xB → 0   loop back to the logo
```

So the attract cycle is **logo → title → opening cutscene → logo → …**, and
every pass through it replays `e001` in full.

`DATA/TWO_D/OP/op.arc` ("Opening", `FUN_0021CC00`, reached only through the
vtable at `0x00478F7C`) is *not* this — the opening cutscene is pure RT data.

### 1.3 The RT cutscene player

`FUN_002BFA70(player, id)` stores the cutscene id at `+0x24` and
`FUN_00323A90(id)` = `0x0045DA10 + id*2` at `+0x28`. `FUN_002BFAA0` is the
update:

| state | handler | what happens |
|---|---|---|
| 0 | — | `+0x18 > 0` (already played once) → `+0x24 = -1` → state 7 (quit) |
| 1 | `FUN_002BF070` | issue every load (§3) |
| 2 | `FUN_002BEEF0` | wait for the loads; instantiate the master script; take the room index from `[0x00482A28] + 0xB4` into `+0x44` |
| 3 | — | put the room into mode 3 (or 2), `FUN_0017C8F0` |
| 4 | — | `FUN_002BF320(this, room, 1)` → stream `data/rt/map_col/<room>_ri.col` |
| 5 | `FUN_002BED70` | hand over to the VM |
| 6 | — | **playing** — tick the script VM (`FUN_001CD090`), poll START/skip |
| 7 | `FUN_002BEC10` | tear down |
| 8 | — | `+0x18++`; replay or finish |

Live object during the attract (address is stable because it reuses the title
screen's freed block): `0x0080FB00`, `+0x04 = 6` (playing), `+0x24 = 0` (id 0),
`+0x28 = 0x0045DA10`, `+0x44 = 0x17` (room index), `+0x1C` = the master script
instance.

---

## 2. The cutscene registry

Two parallel tables, indexed by cutscene id, **154 entries (0x00–0x99)**:

| table | accessor | contents |
|---|---|---|
| `0x00386920` | `FUN_00323AB0(id)` | `const char *` name — `e001`, `e002`, … `e430_01` (strings at `0x0045D540`, stride 8) |
| `0x0045DA10` | `FUN_00323A90(id)` | 2 bytes per id |

The 2-byte record is read as:

* `byte[0]` — scene parameter passed to `FUN_0029ABD0`; `0xFF` on most entries
  means "inherit from the current game state".
* `byte[1]` — Allura's costume rig: `1` → `rt_c01f_%c_h.arc`,
  `2` → `rt_c01f_%c_hl.arc`.

Cutscene 0 (`e001`) is `FF 02` → the `_hl` rig.

The `%c` comes from the 3-byte table at **`0x004825A8` = `"acb"`**, selected by
bits 15–16 of a progress/settings word — index 0 (`'a'`) on a fresh boot.

Ids are dense and ordered: `e001`–`e027`, `e101`–`e133`, `e230`/`e231`,
`e322`–`e326`, then `e401_01` … `e430_01`.  That is registry order, and it is
*not* the order they play in — see §7.

---

## 3. What a cutscene loads

Format strings, all in one block:

| addr | string |
|---|---|
| `0x00457910` | `rt_%s` — the master script instance name |
| `0x00457920` | `data/rt/common/rt_common.arc` |
| `0x00457940` | `data/rt/costume/rt_c01f_%c_hl.arc` |
| `0x00457970` | `data/rt/%s/rt_%s.arc` |
| `0x00457990` | `data/rt/costume/rt_c01f_%c_h.arc` |
| `0x004579C0` | `data/rt/map_col/%s_ri.col` |
| `0x0044E990` | `data/%s` — used by the `preload` opcode |

Captured live by breaking on `FUN_00308150` (path in `a0`) through one attract
cycle, in order:

```
data/effect/ef_common.arc
data/script/sc_common.arc
data/rt/common/rt_common.arc
data/rt/costume/rt_c01f_a_hl.arc
data/rt/e001/rt_e001.arc
data/rt/e001/c01f_a_e001_1.sai      ← and the rest of the .sai set, streamed
                                      per act by the master script
```

plus `data/rt/map_col/rp03_ri.col` from player state 4.

`FUN_00308150(path, group, heap, 0)` dispatches on the file extension against
the table at `0x0045BA20`; the extension list itself is at **`0x00376A00`**
(stride 8): `.ssc`, `.tm2`, `.smi`, `.sai`, `.cam`, …

`FUN_00309840` (the async job used by the 2D screens) is **not** on this path —
breaking there catches only `DATA/TWO_D/*` loads.

---

## 4. The `.SSC` scene VM

### 4.1 Dispatch

The opcode dispatch table is at **`0x00376660`**, stride 4,
**230 entries (ops `0x00`–`0xE5`)**:

```c
handler = *(void (**)(vm, node))(0x00376660 + opcode * 4);
```

Confirmed live: op `0x09` → `FUN_001C8260`, caught at the moment it issued
`data/rt/e001/c01f_a_e001_1.sai`.

Three handlers are shared by many opcodes:

* `FUN_001C7240` (ops `0x0D`–`0x1C`, 21 slots) — the **expression family**:
  int and float assign / add / sub / mul / div / mod / random / wrap / clamp,
  plus the six comparison modes. Not a stub.
* `FUN_001C8C90` (20 slots) and `FUN_001C15D0` (16 slots) — likewise grouped.

VM instance fields (verified against a running cutscene):

| off | meaning |
|---|---|
| `+0xAC` | last condition result (`u8`) |
| `+0xB0` | **current frame** |
| `+0xC0` | shared scene context (`+0x42` = "running" vs "scan" pass, `+0x3E` = arg-count check) |

The script manager singleton is at `0x0048293C`; the RT scene manager is at
`0x00482A28` (`+0xB4` = room index).

### 4.1a Effect tracks — `0x08`, `0x07`, `0x7E`

Half the cutscenes stage their effects through a second kind of spawn, and the
viewer ignored all of it until the stab in `e001` turned out to have no blood.

| op | handler | shape |
|---|---|---|
| `0x08` | `FUN_001C8790` | `(track, x, y, z, flags)` — spawn a track **at a world point** |
| `0x07` | `FUN_001C8860` | `(track, x, y, z, target)` — the same, offset from a looked-up target |
| `0x7E` | `FUN_001C2CC0` | `(r, g, b, w, mask)` — a colour on the block |

`0x08` reads a string, then three floats into a `{x, y, z, 1.0}` vec4, and
calls the same track spawner `0x06` uses. The difference from `0x06` is that
the same track spawns **many times**, at different places and frames, so these
are instances rather than names: `ef_e001_20` is spawned three times.

An effect track times everything from the moment it was spawned — its own
`at_time` values start at 0 — so a spawn contributes a frame base as well as an
origin.

In `e001`, after Olaf's cry at 7830:

```
@8270  0x08  ['ef_e001_30', -0.6701, 3.6973, -44.5011, 0]
@8431  0x08  ['ef_e001_31', -0.6797, 3.7091, -46.4969, 0]
```

Both attach `ef_e001_01.smi`, which is in `RT_E001.ARC` and was never being
instantiated. `0x08` fires **600 times across 73 of the 157 cutscenes**;
`0x07` 148 times across 71.

**`0x7E`'s fourth field is not alpha.** It reaches 1.5 across the disc, so it
cannot be one, and treating it as alpha hides the sprite — `ef_e001_30` passes
0.0. The first three are plainly a colour: `(0.6, 0.2, 0.1)` recurs, a torch
orange. Only the colour is applied; the fourth is carried and unused.

Two more opcodes those tracks use turned out to need nothing: `0xA6` shares the
expression-family handler `FUN_001C7240`, and `0x01` is `FUN_001C8C70`, a
single `jr ra` — a genuine no-op.

### 4.1c `0x83`'s fourth argument is usually a blend, once an offset

`play_anim_entity` normally carries a `C2` rational there. Across the whole
disc it is a rational **588 times** and a `C1` integer **once**:

```
rt_e001_c21m.ssc  @8430  play_anim_entity ['c21m_b_e001.sai', 1, 0, 8431, 0]
```

8431 is the frame it was issued on. That clip runs the **full 11890 frames** —
the length of the cutscene — because it is authored in absolute scene time, and
the game hides the body outside its own shots by **sinking it under the floor**:

| clip frame | `koshi` Y |
|---|---|
| 0 | −18.89 |
| 8431 | +1.11 |
| 9000 | −18.89 |

`knife_a_e001.sai` does the same, parked at y = −20 until it is used. The knife
looks right anyway because its block starts at frame 0, so clip time and scene
time coincide. The corpse's block starts at 8430, so playing from clip frame 0
samples the under-floor pose and the body is never seen — while the knife, the
same trick, is fine. That is the whole of the bug.

So the integer is a **start offset into the clip**, and `poseAt` samples
`frame - clip.start + offset`. Only this one clip on the disc uses it.

### 4.1b `0x63` — room-section culling, not yet implemented

`FUN_001C5810` indexes a string table at `0x00376A30` — `IF_north`, `IF_south`,
`IF_east`, `IF_west`, `IF_ceiling`, `IF_floor`, `IF_distant` — maps the name to
an id through `FUN_00298A30`, and toggles it with `FUN_00294380(room, id, on)`.
That walks a per-room array at `room+0x240` of `{id, part, flags}` and
enables or disables a part.

e001 turns the north wall on and the south wall off at 7910 and reverses it at
7980, following the camera cuts. Ignoring it leaves walls standing in shots
meant to have them removed.

It is **not implemented**, because the mapping cannot be recovered statically:
the name→id table at `0x0048EB10` is in `.bss` and built at runtime, and
neither the room `.smi` (`rp03.smi`: 50 meshes, one node) nor the RT models
carry `IF_*` names or a group id. Reading it needs a live session, or the
room-data parser that fills `room+0x240`.

### 4.2 Bytecode

```
0x00  'SC'
0x02  u16   (0x011b on every file on the disc)
0x04  u16   call count
0x06  call stream
```

Each call: `E1 <u16 op BE> <u16 flag BE> <arg>* EF`, arguments tagged

| tag | payload |
|---|---|
| `C1` | `s32` big-endian |
| `C2` | `s32, s32` — a **rational**: `5/10` = 0.5, `11/100` = 0.11, `1/1` = 1.0 |
| `C3` | NUL-terminated Shift-JIS string |
| `C4` | `s32` big-endian, a second integer namespace (cue indices) |

**`op 0x04 at_time(start, end, step)`** is the timeline primitive. On the scan
pass it *writes* the frame; on the run pass it sets `vm+0xAC` when the current
frame satisfies the range, and every call until the next `at_time` is guarded by
that flag. `-1, -1` means "exactly this frame". This is why every track is a
flat list of `at_time` / `cue` / action triplets.

Named so far (from decompiling each handler):

| op | name | args |
|---|---|---|
| `0x00` | `end_track` | |
| `0x03` | `set_actor_count` | n |
| `0x04` | `at_time` | start, end, step |
| `0x05` | `cue` | 0, `#index` |
| `0x06` | `spawn_track` | `"file.ssc"`, 0 |
| `0x09` | `preload` | `"rt/e001/x.sai"`, -1, -1, -1 → `data/%s` |
| `0x50`/`0x51` | `scene_begin` / `scene_end` | |
| `0x53`/`0x54` | `fade_in` / `fade_out` | frames, 0 |
| `0x55` | `play_anim` | `"x.sai"`, 1 |
| `0x56` | `scene_ready` | |
| `0x57` | `letterbox` | mode (0 in, 1 out), tween frames |
| `0x59` | `play_voice` | `"m0001_c01f_a"`, `"none"`, 1 |
| `0x5A`/`0x5B` | `bgm_start` / `bgm_stop` | id, …, fade |
| `0x60` | `subtitle_show` | text, x, y, `"none"` |
| `0x61` | `subtitle_hide` | `"none"` |
| `0x62` | `set_room` | `"rp03"` |
| `0x64`/`0x65` | entity block begin / end | |
| `0x80` | scale | x, y, z, w |
| `0x82` | attach model | `"c01f_a_h.smi"`, 0, 0 |
| `0x83` | play animation | `"c01f_a_e001_1.sai"`, rate, 0, in, out |
| `0x84` | transform | x, y, z, w |
| `0xA2` | visibility | mask, on |
| `0xB3` | set root bone | `"koshi"` |
| `0xB7` | attach to bone | `"marukage_a.smi"`, `"koshi"`, 0.5 |
| `0xB9` | camera path | 0, `"e001.cam"`, 1 |
| `0xC7` | fog / depth | near, far, r, g, b |

Two refinements from building the viewer: `0x64`'s first argument is a **kind**
— 4 model, 6 light, 7 camera — and its second a label (`none`, `rt_amb`,
`rt_inf`, `joyu`, `rt_poi`). Inside a kind-6 block `0xB4` is the light type
(0 directional, 1 point, 4 ambient), `0xB5` its range and `0x80` its **colour**.
`0x80` is a tint on a model block too, *not* a scale.

`0x57` is the cutscene letterbox: the handler at `0x001C6570` sets two black
640-wide sprites to **50 and 110** units of the 640x448 UI space — 25 and 55
lines of the 512x224 framebuffer — and `0x001E43F0` slides them in from
off-screen over the second argument's frame count. All 149 cutscenes call
`(0, 1)` on their first frame and `(1, 1)` on their last, and the dialogue is
drawn on the lower bar rather than over the picture ([`VIEWER.md`](VIEWER.md)
§1.5).

Subtitle strings carry inline markup: `%%SCSV` … `%%RC` wraps the speaker name,
a literal two-character `\n` breaks the line, a literal `\0` ends the string.
Text is full-width Shift-JIS even for the English release.

### 4.3 Coverage

`tools/ssc.py` parses **5512 of 5512 `.ssc` files on the disc with zero
failures**, exercising 148 distinct opcodes in the range `0x00`–`0xDE`. It
recovers **1935 subtitle cues across 562 script files** — the game's complete
spoken script. Speaker tallies: Allura 351, Jais 87, Rachel 69, Catalina 56,
Ada 53, Mayte 48, Finnegan 45 … and 31 cues still credited to `アリシア`
(*Alicia*) plus 13 to `イルツム`, untranslated placeholders that match the
`ALISIA_A/B/C` leftovers in the character table.

```
python tools/ssc.py rt_e001.ssc              # opcode listing
python tools/ssc.py rt_e001_txt.ssc --lines  # speaker / voice / subtitle table
```

---

## 5. `e001` — the opening cutscene

### 5.1 Assets

`DATA/RT/E001/` is the largest cutscene bundle on the disc: `RT_E001.ARC`
(5,048,320 B, 116 members) plus **29 loose `.SAI`** animation files
(~7 MB), one per actor per act.

`RT_E001.ARC` holds 21 `.smi`, 33 `.tm2`, 20 `.ssc`, 38 `.slp`, 3 `.sai` and
one `.cam`:

* **models** — `c12f_a_h`, `c13f_b`(`_h`), `c15m_a_h`, `c21m_a_h`, `c21m_b_h`,
  `c32m_a`, `c32m_b` and their `_k` variants; props `knife_a`, `rp03d0` (door),
  `rp11_rt`, `gf16_rt`, effect `ef_e001_01`, blob shadows `marukage_a/b`
  (丸影, "round shadow").
* **camera** — `e001.cam`, 475,608 B of baked spline.
* **scripts** — `rt_e001.ssc` (master) + `_cam` `_txt` `_map` `_knife` and one
  per actor, plus five `ef_*` effect tracks.
* **lip-sync** — 38 `.slp`, named `m####_<actor>` / `t####_<actor>`, matching
  `DATA/SOUND/VOICE/M####_<ACTOR>.ADX` one-for-one.

Allura's own model is *not* in here — she comes from
`DATA/RT/COSTUME/RT_C01F_A_HL.ARC`, which is why the costume you are wearing
shows up in cutscenes.

### 5.2 Structure

`rt_e001.ssc` sets the stage and streams four acts, preloading act *n+1* while
act *n* plays:

```
scene_begin 5
set_room "rp03"                      ← Palace room 03 (DATA/RT/MAP_COL/RP03_RI.COL)
preload   c01f_a/c13f_b/c15m_a/c21m_a _e001_1.sai
at_time 1     play_anim ×4 ; letterbox on ; fade_in 60 ; bgm_start 80
              spawn_track cam, txt, map, c01f, c15m, c21m, c12f, c13f, c32m_a, c32m_b, knife
at_time 10    preload act 2 (adds c12f_a, c32m_a, c32m_b — 7 actors)
at_time 4670  play act 2
at_time 4680  preload act 3 (6 actors, c15m_a leaves)
at_time 6060  play act 3
at_time 6070  preload act 4 (5 actors, c21m_a leaves — the king is dead)
at_time 8820  play act 4
at_time 11770 bgm_stop 80 over 60 ; fade_out 120
at_time 11890 letterbox off ; scene_end
```

**11,890 frames ≈ 3 min 18 s.** The camera track is one long `e001.cam` with
extra shake/cut events at frames 7800 and 7910 — the murder.

### 5.3 Dialogue

Recovered from `rt_e001_txt.ssc`; `VOICE` is
`DATA/SOUND/VOICE/<NAME>.ADX`.

| frame | speaker | voice | line |
|---:|---|---|---|
| 1040 | Allura | `m0001_c01f_a` | Mother...... |
| 1480 | Graines | `m0002_c15m_a` | Your Majesty, / please consider the situation! |
| 1670 | Graines | `m0003_c15m_a` | Disorder runs rampant in the castle! |
| 1930 | Graines | `m0004_c15m_a` | ......And that is just the start of it! |
| 2130 | Graines | `m0005_c15m_a` | The discontent of your subjects is nearing / the point of revolution! |
| 2501 | Graines | `m0006_c15m_a` | I beseech you, please turn your attention / toward the state of you kingdom! |
| 2810 | Graines | `m0007_c15m_a` | Your Majesty! King Olaf! |
| 3070 | Olaf | — | ...... |
| 3230 | Graines | `m0009_c15m_a` | Ever since you married that woman after / the death of the previous Queen... |
| 3660 | Graines | `m0010_c15m_a` | You have been neglectful of your royal duties, / your highness... |
| 3980 | Graines | `m0011_c15m_a` | It's already been 4 years. / And what of Allura?! / You must think of her as well! |
| 4360 | Catalina | `m0012_c12f_a` | And just who are you referring to as / "that woman", I wonder? |
| 4600 | Graines | `m0013_c15m_a` | Ah, ehem, greetings Queen Catalina. |
| 5096 | Graines | `m0014_c15m_a` | Your majesty, I have nothing further to say. |
| 5270 | Graines | `m0015_c15m_a` | I beg you, for the good of the kingdom, / please think over what I have told you. |
| 5520 | Graines | `m0016_c15m_a` | Excuse me! |
| 5940 | Catalina | `m0017_c12f_a` | Hmhmhm..... |
| 6420 | Catalina | `m0018_c12f_a` | ......Allura. |
| 6520 | Catalina | `m0019_c12f_a` | Can't you even say hello to your mother!? |
| 6700 | Rachel | `m0020_c13f_b` | Princess, please... |
| 7010 | Allura | `m0021_c01f_a` | .....The only mother I will ever have lies / at rest here before me. |
| 7280 | Catalina | `m0022_c12f_a` | Well...... / you don't recognize me as your mother? |
| 7550 | Catalina | `m0023_c12f_a` | This kind of impudence cannot be allowed / to go unpunished! |
| 7830 | Olaf | `m0024_c21m_a` | Wh, Agh...Aahh... |
| 8110 | Allura | `t0007_c01f_a` | !? |
| 8170 | Allura | `m0025_c01f_a` | Father.....?! Father!! |
| 8440 | Allura | `t0008_c01f_a` | !? |
| 8490 | Catalina | `m0026_c12f_a` | S, somebody please!! |
| 8720 | Knight | `m0027` | Your majesty!! |
| 8830 | Catalina | `m0028_c12f_a` | Aah...Allura...It was Allura...she... |
| 9000 | Catalina | `m0029_c12f_a` | attacked the king and I with a knife! |
| 9240 | Knight | `m0030` | The princess...attacked his highness...!? |
| 9370 | Rachel | `m0031_c13f_b` | Catalina!? |
| 9490 | Allura | `m0032_c01f_a` | That, That's a lie.....! |
| 9611 | Catalina | `m0033_c12f_a` | Ooh...It was so horrible...Allura's... |
| 9774 | Catalina | `m0034_c12f_a` | Allura's arm transformed into a strange shape... / It could only have been the fiend's... |
| 10104 | Knight | `m0035` | The fiend's...!? |
| 10160 | Knight | `m0036` | ......Your highness, you couldn't possibly mean / the Fiend's Arm!? |
| 10340 | Catalina | `m0037_c12f_a` | Hu, hurry! / Seize Allura before she escapes!! |
| 10550 | Allura | `m0038_c01f_a` | It wasn't me! ...It wasn't me!!! |
| 10740 | Rachel | `m0039_c13f_b` | Princess! |
| 11070 | Catalina | `m0040_c12f_a` | After her! Go after her, now!! / Any who hinder your pursuit shall be / considered guilty as well!! |
| 11311 | Catalina | `m0041_c12f_a` | Show her no mercy!! |
| 11442 | Knight | `t0009` | Yes my Queen! |
| 11450 | Knight | `t0010` | Yes! |

45 cues. Frame 3070 (Olaf's `......`) has a subtitle but no voice clip — the
`M0008` slot is absent from `DATA/SOUND/VOICE`.

Cast: `c01f_a` Allura · `c12f_a` Catalina · `c13f_b` Rachel · `c15m_a` Graines
· `c21m_a`/`c21m_b` King Olaf · `c32m_a`/`c32m_b` castle knights.

---

## 6. Live-debugging recipe

PCSX2 DebugServer, EE breakpoints:

| address | catches |
|---|---|
| `0x002C02F0` | the attract loop constructing the cutscene player — the earliest single point where the opening begins |
| `0x002BF070` | the cutscene issuing its loads (state 1) |
| `0x00308150` | every RT resource load; path in `a0`, group in `a1` |
| `0x001C8260` | the `preload` opcode; formatted path in `a0` |
| `0x002117C0` | attract-loop tick — `a0+4` is the sub-state (0–2 logo, 3–5 title, 6–8 cutscene) |

Useful live reads while a cutscene plays:

```
[0x004828A8]        → app-flow object; u16 at +0 is the app state (7 = in the sequencer)
0x0080FB00          → cutscene player (+0x04 state, +0x24 id, +0x44 room, +0x1C script)
[player+0x1C]+0xB0  → the script VM's current frame — index straight into the tables above
[0x00482A28]+0xB4   → room index of the running cutscene (0x17 for e001 / rp03)
```

Verified during a live attract pass: VM frame `1109` while "Mother......" was on
screen (cue at 1040, next at 1480), then `1594` on the Graines cue at 1480.

`FUN_0016B870` never executes during boot → title → attract; don't breakpoint it
looking for menu transitions.

---

## 7. The story order — which cutscene plays when

Disc order is *nearly* story order and the names look sequential, but they are
not the sequence: `e133` plays between `e107` and `e108`, `e132` before `e129`,
`e005` and `e025` do not exist, and nothing in a filename says where the
playable stages sit between the scenes. The real order is four tables, read by
two state machines.

### 7.1 Cutscenes are played in groups, not one at a time

Nothing in the game asks for a single cutscene except the attract loop. The
unit is a **group**: `FUN_00323BA0(obj, group)` sets one, `FUN_00323AE0` starts
it and `FUN_00323BC0` walks it, tearing down each RT player (§1.3) and building
the next, so a run of cutscenes plays back to back without returning to the
caller.

The group table is at **`0x0045DB50`** — 38 records of 8 bytes, bounds-checked
against `0x26` in `FUN_00323AE0`:

```
+0x00 u8    count
+0x01 u8[7] cutscene ids
```

Group `0x00` is `e001 e002 e003`, the opening the attract loop plays. The 38
groups between them cover cutscene ids **`0x00`–`0x40`** — every `e0xx`,
`e1xx`, `e2xx` and `e3xx` scene — and, because the tables below reference them
in ascending order, **group order is story order**.

### 7.2 The chapter machine, `FUN_00173520`

Three tables indexed by the chapter number at `app+0x408` (`FUN_00171BC0`),
15 chapters:

| addr | record | read in state |
|---|---|---|
| `0x0042DD20` | `u8 count; u8 stage[3]` — the chapter's playable stages | 9, `0xC` |
| `0x0042DD60` | `u8 group` — plays *before* the chapter | 6 |
| `0x0042DD70` | `u8 [3][2]` — per stage, (before, after) | 9, `0xF` |

`0xFF` means "no cutscene here". Laid against the state machine:

```
state 3    FUN_00173170  checkpoint the progress block, then put up a screen
      4,5  FUN_00173050  its result: 0x100D play the chapter, 0x100E hand over
                         to the ending machine (§7.4), 0x1002 leave
state 6    FUN_00172F20  group 0042DD60[chapter]        the chapter opening
      7,8                poll / release; state 8 also seeds the stage index
state 9    FUN_00172DF0  group 0042DD70[chapter][s][0]  before the stage
      10,0xB             poll / release
state 0xC                stage 0042DD21[chapter][s], then FUN_0016C2A0
      0xD                run it -- FUN_0016B870, the in-room machine (§1.1)
      0xE  FUN_00172B50  the stage's result: 0x1012 replay it, 0x1013 carry on
                         to state 0xF, 0x1003 fail back to state 3
state 0xF                group 0042DD70[chapter][s][1] after the stage
      0x10,0x11          poll / release, then FUN_00172960 asks what is next
state 0x12-0x14          a second screen, then FUN_001727F0 sets the chapter
state 0x15 FUN_001726F0  the finale (§7.3)
```

### 7.3 Three story flags, and the four rules that read them

The loop above is not a straight line, and the branches are code rather than
tables. Four short functions decide where it goes, and all four read the same
byte of **story flags at `app+0x40E`**:

| function | decides | reads |
|---|---|---|
| `FUN_00173520` state 8 | which stage the chapter opens on | flag 0 |
| `FUN_00174250(c, s, flags)` | the next stage in the chapter, or `-1` | flag 1 |
| `FUN_001741B0(c, flags)` | the next chapter, or `-1` | flags 0, 1 |
| `FUN_001726F0` | which finale group closes the run | flags 1, 2 |

Concretely, and this is the whole of the main line's branching:

* **Chapter 10** has two stages and plays exactly **one**. State 8 picks
  `0x11` when flag 0 is already set on entry, `0x10` when it is not, and
  `FUN_00174250` returns `-1` for this chapter either way. With flag 0 set
  `FUN_001741B0` also has no next chapter, and `FUN_00172960` sets `app+0x7F`
  so `FUN_001727F0` **leaves the machine entirely** — that route does not
  reach the finale at all.
* **Chapter 14** plays its third stage (`0x18`) only when flag 1 is *clear*,
  and that is also the case with no chapter 15: it goes straight to the finale.
  With flag 1 set it plays two stages and chapter 15 follows.
* **Chapter 15** always ends the run. `FUN_001726F0` then reads flag 2.

So the three finale groups are three *routes*, not three replays:

| reached from | flags | group | cutscenes |
|---|---|---|---|
| chapter 14 | flag 1 clear | `0x23` | `e129 e130` |
| chapter 15 | flag 2 clear | `0x25` | `e322 e323 e324 e325 e326` |
| chapter 15 | flag 2 set | `0x24` | `e230 e231` |

`FUN_001726F0` records which one it chose in `app+0x3FE`.

**Nothing in the ELF sets these flags.** `FUN_00172B50` only ever *clears* one
— on a failed stage (`0x1003`), the flag named by the 15-byte table at
**`0x0042DDD0`**: `-1` for every chapter except 10 → flag 0, 14 → flag 1,
15 → flag 2. Whatever sets them is inside a stage, i.e. in the part of the
game the viewer does not have. `python tools/order.py --graph` enumerates
every chapter against every flag state a run can actually reach it with.

### 7.4 The endings are a second, branching machine

Everything `e4xx_xx` — ids `0x41`–`0x99`, 89 scenes — belongs to a different
object, built in state `0x18` and ticked by **`FUN_0032A7C0`** (vtable
`0x00480AE0`).

`FUN_0032A730(this, chapter)` picks its script out of the 15×2 byte table at
**`0x003872A0`**: two routes per chapter, selected by bit 0 of `app+0x80`. That
is a record index into **`0x003872C0`**, **30 records of `0x50` bytes**:

```
+0x00  s16 step[16]        -1 end
                           < 0x4E  a stage id
                           >= 0x4E cutscene id + 0x4E
+0x20  s8  branch[16][3]   (flag, next_if_clear, next_if_set); flag -1 = i+1
```

`FUN_0032A5D0` is the walk. With no flag a step falls through to `i+1`;
otherwise it tests bit `flag` of the 16-bit field at `app+0x40F` — cleared when
the ending starts, `FUN_0032AB50` — and jumps to one of the two successors. Any
successor whose step is `-1` ends the ending, which is why a record's tail of
zero bytes is never entered and needs no terminator.

Flow `0x00`, the first ending of chapter 1, reads:

```
0: e401_01
1: stage 1A
2: e401_02   then flag 0 ? step 6 : step 4
4: e401_03
6: e401_04
```

Thirteen flags (`0`–`12`) are used across the 30 records; the stages
interleaved with the cutscenes are ids `0x1A`–`0x43`, a second set on top of
the 26 the chapters use (`0x00`–`0x19`).

### 7.5 What falls out of the four tables

Every one of the 149 cutscenes on the disc is placed, and the main line is
strictly ascending in group id:

```
Opening                group 00   e001 e002 e003
Chapter 1              group 01   e004 e006 e007 e008
  stage 00
  before stage 01      group 02   e009
  stage 01
  after stage 01       group 03   e010 e011
Chapter 2              group 04   e012 e013
  ...
Chapter 15             group 22   e132
  stage 19
Finale                 group 23   e129 e130          (chapter 14, flag 1 clear)
                       group 25   e322 ... e326      (chapter 15, flag 2 clear)
                       group 24   e230 e231          (chapter 15, flag 2 set)
Endings                flow 00-1D                    e401_01 ... e429_04
```

Two dead ends worth recording:

* **Sixteen registry entries are never played** — no group and no reachable
  flow step names them: `e404_03`, `e408_01`, `e409_01`–`e409_03`,
  `e410_01`–`e410_04`, `e419_01`–`e419_03`, `e422_01`, `e424_03`, `e427_01`,
  `e430_01`. The flow records that would hold them (`07`, `08`, `09`, `12`,
  `15`, `1A`, `1D`) are a bare stage and a terminator.
* **Five of those sixteen have no data on the disc at all**: `e409_02`,
  `e422_01`, `e424_03`, `e427_01`, `e430_01`. Whatever they were, they were cut
  before the US master; the other eleven ship complete and unreachable.

### 7.6 `tools/order.py`

The tables, decoded straight out of `SLUS_212.55`:

```
python tools/order.py             # the whole order, as an outline
python tools/order.py --graph     # every branch point, every flag state
python tools/order.py --json      # the tables and the order, machine readable
python tools/order.py --playlist  # just the names, in order
python tools/order.py --script    # 1492 cues, in story order
python tools/order.py --check     # registry vs. disc vs. what any table plays
python tools/order.py --tables    # the JSON that goes into the site's order.js
python tools/order.py --rules     # the four branch rules, as a test fixture
```

`tools/site.py` uses it three ways: the gallery is laid out chapter by chapter
instead of alphabetically; `order.js` hands the same flat list to every player
page, which is what its prev/next buttons and **Auto** walk; and the same file
carries the tables unflattened, which is what **story mode** runs
([`VIEWER.md`](VIEWER.md) §2.2, §2.3).

### 7.7 Running the machine without the game

Story mode in the viewer is `FUN_00173520` and `FUN_0032A7C0` re-implemented
over these tables, in `player.html`'s `TRAPT STORY` block. Everywhere the
retail game would have learned something it cannot learn here — a stage's
result code, the screen at state 5, a story flag set inside a room, the bit
`FUN_0032A5D0` tests — it puts the same choice to the person watching and
carries on with the answer. `tools/test_order.js` walks it headless and diffs
its four branch rules against `order.py --rules` over all 120 (chapter, flag)
combinations, so the two transcriptions cannot drift.

---

## Open threads

* ~30 of the 230 opcodes are named; 148 are actually used somewhere on the disc,
  so ~120 in-use opcodes are still unidentified. The `0x64`/`0x65` entity-block
  pair and the `0xA0`–`0xC7` actor/camera band are the highest-value targets.
* `.sai` (animation), `.cam` (camera) and `.adx` (audio) are **done** — see
  [`VIEWER.md`](VIEWER.md), together with `tools/export.py`, which plays a
  whole cutscene in a browser. `.slp` lip-sync is still undecoded; the 38 in
  `RT_E001.ARC` are the obvious sample set, since each has a matching `.ADX`
  and a known frame from §5.3.
* `RT_IGS_*.ARC` (8 files) are untouched — "in-game scene"?
* Eleven `e4xx` cutscenes ship on the disc but no table plays them (§7.5).
  Either a fifth table reaches them from inside a stage, or they are cut
  content; the seven stage-only ending flows are where to look.
* Nothing found so far *sets* a story flag (`app+0x40E`, three of them) or an
  ending branch flag (`app+0x40F`, thirteen). Both are cleared — by a failed
  stage and by the start of an ending — and read by the machines in §7.3 and
  §7.4, so whatever sets them lives inside a stage. That is the one hole left
  in the story graph.
* The `%%SCSV` / `%%RC` subtitle markup verbs have not been traced to their
  handler in the text renderer.
