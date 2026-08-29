# The stage half of Trapt — rooms, collision, doors and traps

Everything before this was the cutscene half. [`CUTSCENES.md`](CUTSCENES.md)
decodes the `.SSC` scene VM and [`VIEWER.md`](VIEWER.md) plays a cutscene
outside the emulator; §7 of the first one reverses the order the game plays
them in. But the story tables name **stages**, and a stage was an opaque
number the viewer announced and stepped over —
[`BROWSER.md`](BROWSER.md) §5 listed it as the largest missing piece.

This is that piece. Four formats, all of them new here:

| file | what it is | tool |
|---|---|---|
| `#bin` | a named-chunk container, 908 files on the disc | [`hbin.py`](../tools/hbin.py) |
| `.col` | a room's collision — its floors, walls and ceilings | [`col.py`](../tools/col.py) |
| `M###.BIN` | the stage graph: rooms placed in a world, joined by doors | [`mapbin.py`](../tools/mapbin.py) |
| `.td` / `.tcd` / `TRAPINFO.BIN` | the 48 traps, their stats and their volumes | [`trap.py`](../tools/trap.py) |

On top of them, [`stage.py`](../tools/stage.py) assembles a whole stage and
walks a body around it, and `tools/web/` does the same in the browser so
`pick.html` gained a **Walk a stage** mode next to Gallery and Route.

```
python tools/hbin.py --scan          # every #bin on the disc
python tools/col.py rh01             # one room's collision
python tools/col.py --check          # all 80 .col files
python tools/mapbin.py 0             # stage M000, the House
python tools/trap.py                 # all 48 traps with their stats
python tools/trap.py tc00            # one trap in full
python tools/stage.py 0              # the whole thing assembled
python tools/stage.py 0 --walk 1200  # and a body walked around it
python tools/pcsx2pad.py             # your PCSX2 pad bindings
```

---

## 1. `#bin` — the container everything else is in

Eight hundred and ninety-odd files on the disc begin with the four bytes
`#bin`. It is a flat directory of *named* chunks with a relocation table:

```
0x00 char[4]  '#bin'
0x04 u32      file size (always exactly the file's length)
0x08 u32      chunk count
0x0c u32      fixup count
0x10          chunk[count], stride 12:
                u32 name    -- file offset of a NUL-terminated name
                u32 offset  -- file offset of the payload
                u32 size
              u32 fixup[fixup count]
              ... payloads, then the string blob ...
```

Chunk names repeat — a `.sta` holds twenty-five chunks all called `HIT_DATA` —
so the directory is an ordered list and never a map.

The **fixup table** is what makes the pointers inside a payload usable. Each
entry is the file offset of a 32-bit field that itself holds a file offset, so
the loader can rebase the block wherever it lands in EE RAM. Nothing here
rebases anything, since the stored values are already file-relative, but the
table still earns its keep: it says which fields are pointers and which are
numbers. `TrapData` has five pointer slots and only three are live in
`tc02.td`; the fixup count is how you know.

All 908 parse. What they carry:

| ext | files | chunks |
|---|---|---|
| `.sta` | 207 | `CHR_DATA`, `COL_DATA`, `HIT_DATA`, `ATTACK_DATA`, `BLUR_DATA` |
| `.td` | 335 | `TrapData` |
| `.tcd` | 316 | `TrapAttData`, `TrapColData`, `SCOL_*`, `TrapExData`, … |
| `.bin` | 40 | `SMapDef`, `SRoomDef`, `SPassDef`, `SDoorDef`, `TrapInfo`, `GmkInfo`, `MissionIntruder` |
| `.txp` | 10 | `TransmitBox` |

### 1.1 Two quirks that are data, not misreadings

**Name buffers were never cleared.** They are fixed-size and the authoring
tool wrote into them without zeroing, so a short name is followed by the tail
of whatever was written before it: `SRoomDef` reads back as `RH_01\0ef`, a
door record as `RH_01\001`, and a `COL_DATA` bone name is followed by the tail
of `TYPE_CAPSULE`. Always cut at the first NUL. That trailing `01` in a door
record looks exactly like a door number and is not one — see §3.2.

**Twenty-five `.tcd` declare a chunk that runs past the end of the file.**
`gc06.tcd` wants 28 bytes at offset 28 of a 44-byte file. They are clamped
rather than thrown; the game reads what is there.

---

## 2. `.col` — where the floor is

Eighty files, in `DATA/MAP_DATA/COLLISION/MAP_###_COL.ARC`, one per room and
named `<room>_ri.col` — the same `_ri` stem as the shadow-receiver mesh in
`DATA/SHADOW_RENDER`. Nothing else on the disc says where a floor is.

```
0x00 u32   group count
0x04 u32   -> group table (always 0x08)
0x08       group[], stride 12:
             u8  tag       -- 1 almost always; 0 and 2 also occur
             u8  material
             u8  primitive count
             u8  0xff
             u8  0
             u8  flags
             u8  0
             u8  verts     -- 5 for a quad, 3 for a triangle
             u32 offset
           ... primitives, 64 bytes each: 4 x float4 ...
```

A primitive is always a 64-byte slot of four `float4`s whose `w` is 1. When
`verts` is 3 only the first three are real. **No vertex count is stored
anywhere else**, and the fourth slot of a triangle is whatever was in the
authoring buffer — every one of the 125 triangles on the disc has a fourth
vertex that is zero or NaN and out of the plane of the other three, while all
6857 quads are planar to within 0.41 units. That is how the two are told
apart, and it holds without exception.

Read disc-wide the format closes exactly: **1407 groups, 6982 primitives**, and
every group's `count * 64` lands precisely on the next group's offset.

### 2.1 `material` is a surface class

Binning every triangle by the sign of its normal's Y:

| material | floor | wall | ceiling |
|---|---|---|---|
| 1 | 764 | — | — |
| 2 | 12 | 3036 | 6 |
| 3 | 4428 | 3930 | — |
| 4 | 596 | — | — |
| 5 | — | 293 | — |
| 6 | — | 236 | — |
| 7 | — | — | 538 |

So 1 and 4 are floors, 2/5/6 walls, 7 ceilings — and **3 is a room shell**, a
whole section of a room with its floor and its walls authored as one group.
Anything walking on this has to classify per primitive from the normal, never
from the material.

### 2.2 Every wall is exactly vertical

All 3808 wall primitives on the disc have `n.y == 0` to the last bit. This is
not a near miss worth a tolerance — it changes the algorithm. A vertical wall
projects to a **line segment in XZ with a height band**, and a walking body is
a circle, so wall resolution is an exact 2D circle-vs-segment test rather than
an approximated 3D sweep, and the camera's pull-in is an exact
segment-segment intersection.

(Split into triangles, four faces come out at `|n.y| = 0.003`: they are the
second halves of the handful of quads that are planar only to 0.41 units.
Which is why `Mesh.walls` classifies whole primitives and never triangles.)

---

## 3. `M###.BIN` — the stage graph

Twenty-two stages, each a `#bin` of four chunk kinds:

```
SMapDef   4 bytes   u32 map id
SRoomDef  52        char[8] name; float3 world position; u32 index; pad
SPassDef  68        the same, then char[8] x2 -- the two rooms it joins
SDoorDef  20        u32 index; char[8] room; char[8] room
```

`M000` is the House:

```
ROOM RH_01 (-120, 120, 600)   idx=1     ... eight rooms
PASS RH_11 (60, 120, 600)     idx=11    joins RH_01 and RH_03
DOOR 2      RH_01 d2 <-> RH_11
```

A stage is rooms and corridors placed in **one world space with no rotation
anywhere**, joined by doors, and a passage is itself a room with its own
geometry and collision. Cut a name at the first NUL and the underscore drops
out to give the id the rest of the disc uses: `RH_01` → `rh01`, which is
`rh01_ri.col` and `DATA/ROOM/RH01_ALL.ARC`.

All 22 assemble with every room carrying collision, a room archive and a place
to stand, and every room reachable from the first by walking doors.

### 3.1 Sealed doors seal in two ways

A record whose `index` has bit 16 set (`0x10000 | n`) is sealed; the room still
ships the door mesh. Forty-eight of the 114 doors are sealed, and **45 name
`NOT_USE` on the far side while the other 3 name a real room this stage does
not load** — `M004` seals `RH_06`'s way to `RH_17`, `M008` seals both of
`RC_05`'s. Those three are the only doors on the disc whose far side is
missing from their own stage, so the bit and the room list agree exactly.
Reading one without the other makes three rooms look like a broken table.

### 3.2 A door carries neither a position nor a door number

Both come from the room archive. `DATA/ROOM/RH01_ALL.ARC` holds `rh01d0.smi`
through `rh01d3.smi`, the translation of the first node of each is the door's
room-local position, and the meshes are numbered **in the order that room's
records appear in the door list**.

That rule closes for 45 of the 48 rooms. The other three are `RP_01` and
`RP_02`, which ship four door meshes and are used by stages that open only two
or three of them. Checked the other way — asking which of a room's door meshes
sits nearest the room the record links to — the two agree wherever the answer
is not a tie.

Because of those three, nothing should *rely* on the pairing. The useful part
is the door's **world** position, and `stage.py` arrives at a door by looking
for floor near that world point rather than by trusting an index.

### 3.3 Passages have no doors of their own

No `SDoorDef` is ever owned by a passage: every record's near side is a room.
So a corridor is a room you can walk into and never out of unless the far side
of each door leading into it is added back, which is what `stage.load` does.

---

## 4. The traps

Traps and gimmicks are the same object type split by id
([`EXECUTABLE.md`](EXECUTABLE.md) §7.2). Ids `0x00`–`0x2F` are the 48 player
traps, sixteen per surface, and the letter is the surface: `TC` **C**eiling,
`TW` **W**all, `TF` **F**loor — which is also the three tabs of the
trap-select screen.

`DATA/TRAP/TRAPINFO.BIN` is the master table, 48 × 16 bytes:

```
+0x00 u32 -> name    +0x08 u16 damage   +0x0c u16 cost
+0x04 u32 -> blurb   +0x0a u16 reset    +0x0e u16 price
```

```
TC00   ceiling Guillotine        25  360  12   3400  Slices the enemy.
TC01   ceiling Pendulum          45  300  10      0  Blade on chain.
TF15   floor   Hanging Chain     15  330  17   8550  Constricting chain.
```

`reset` is in frames, and a `price` of 0 marks the traps you start with rather
than buy. The strings are Shift-JIS full-width Latin, because that is how the
Japanese build stored them.

**Each trap's own `.td` carries a second, longer description.** `Guillotine`
is `Slices the enemy.` in `TRAPINFO` and `3 blades fall in succession.` in
`tc00.td`. Those are the two texts the trap-select screen shows — the short
one in the list, the long one in the detail panel — so both are kept. The
names agree across all 48; the descriptions differ for all 48, and that is not
a contradiction.

`TrapData` is 254 bytes of which only the five pointer slots at the front are
firmly read: name, effect text, and the model file. About fifty byte offsets
in the rest vary between traps and there is no evidence yet for what they
mean, so they are left as raw bytes rather than guessed at.

### 4.1 `.tcd` — the volumes

Self-describing chunk names: `SCOL_WALL_SET`, `SCOL_CEIL_SET`,
`SCOL_SLOPE_SET`, `SCOL_BOX_SET`, `SCOL_CAPSULE`, `SCOL_SPHERE`, `SCOL_LINE`,
`SCOL_WALL4_SET`, `SCOL_CROSS_SET`. A `*_SET` entry is eight floats — an
axis-aligned box as `min` then `max`, then two of padding — and one axis is
always flat, because the box lies on the surface the trap is set on:

```
tc00.tcd   SCOL_WALL_SET   (-10, -6, -1) .. (10, 3, -1)
           SCOL_WALL_SET   (-10, -6,  1) .. (10, 3,  1)
```

the two faces of the thin slab the guillotine sweeps through.

### 4.2 Firing a trap is already solved

A trap archive ships `.ssc` effect scripts — `ef_tc00.ssc`, `ef_tc00_100.ssc`,
`ef_u018.ssc` — and those are the same bytecode the cutscene VM in
[`ssc.py`](../tools/ssc.py) already runs, with the same opcodes. The
`.smi` model, its `.tm2` textures and the `.sai` animation are all
already-decoded formats too. Nothing new had to be cracked to make a trap go
off; what is not wired up yet is the *game* around it (§7).

---

## 5. The character, and how fast she walks

`DATA/CHARA/C01F_A.ARC` is Allura: a `.smi` rig, 95 `.sai` clips, and a
`c01f_a.sta` holding her parameters.

* `COL_DATA` × 5 — capsules attached to bones. The hip one (`koshi`) is the
  body: `A = (-3, 0, 0)`, `B = (7, 0, 1)`, **radius 3**. The other four ride
  `buki_obj`, the weapon.
* `CHR_DATA` × 1 — the name (`ALISIA`), a uniform scale of 1.065, and two
  identical rows of `(0, 30, 60, 3)`.
* `HIT_DATA` × 25, `ATTACK_DATA` × 5, `BLUR_DATA` × 4 — combat, not used here.

Her bind pose runs from `y = 0.00` to `y = 15.42`, so the model origin is the
point between the feet, which is also where a collision query wants to be —
the two need no offset between them.

### 5.1 The gait speeds come from the animation, not the table

`CHR_DATA`'s 30 and 60 are not units per second at any frame rate that makes
the feet plant. What does work is measuring the clip. The locomotion clips are
authored **in place**, so a foot bone's excursion along Z over one cycle *is*
the distance the body covers in that cycle:

| clip | | foot excursion | frames | units/frame | units/s at 60 fps |
|---|---|---|---|---|---|
| `c01f_a_001.sai` | walk | 12.00 | 72 | 0.1667 | 10.0 |
| `c01f_a_002.sai` | run | 23.95 | 42 | 0.5703 | 34.2 |

Both feet give the same answer to the hundredth. With a 15.42-unit model those
are 1.0 and 3.6 m/s if she is 1.6 m tall — a walk and a jog. The `.mfd` beside
the `.sta` agrees independently: it is a footstep event list, and it fires
twice per cycle in each clip, at frames 33 and 66 of 72 walking and 12 and 32
of 42 running.

`CHR_DATA` is not noise either. `30 / 12.00` and `60 / 23.95` are **both 2.50**,
so the table is the same pair of strides scaled by a constant. What the
constant is remains open; `stage.py` hands the raw numbers back rather than
pretending they are a speed.

---

## 6. Walking a stage

[`stage.py`](../tools/stage.py) puts it together, and `tools/web/stage.js` is
the same thing in the browser — a line-for-line port, because the two are
diffed against each other (§8).

**Physics happens in room-local space.** A `.col` is authored around its room's
origin and `SRoomDef` translates it, so the body moves in room coordinates and
only the renderer adds the offset. That keeps thousands of triangles from
being transformed on every room change, and makes a door crossing the one
place the two frames have to meet.

The body is a circle of radius 3 spanning `[y, y + 15.42]`, and a step is:

1. move by `(dx, dz)`;
2. push out of every wall it now overlaps — four passes, each resolving the
   *deepest* overlap, which converges in a corner where taking the first wall
   found would not;
3. snap to the highest floor within 12 units up (a step) or 400 down (a drop).

A step that ends over no floor at all is **refused outright** rather than
dropped. The rooms are sealed, so a walker that leaves one has found a hole in
the collision and not a ledge.

The clip advances with the distance actually covered, so a body sliding along
a wall slows its legs down instead of running on the spot, and the character
faces where it went rather than where it was pushed — otherwise sliding along
a wall spins her into it.

### 6.1 The camera

`DATA/CAMERA/INIT.BIN` is 56 bytes: seven records of four `s16`, reading
`(18, 115, 40, 2)` and `(18, 180, 40, 2)`. The **field names are inferred** —
from nothing stronger than the numbers being the right size for a
third-person camera on a 15-unit character in a 220-unit room — as a pitch in
degrees, a distance back and a height. `stage.camera_defaults` keeps the raw
values alongside so the guess can be checked rather than taken on trust.

The camera is pulled in to the first wall between it and the body by a **ray
cast, not a push-out**, and that is the difference between a camera that works
in a corner and one that does not: once the camera has ended up wholly behind
a wall it overlaps nothing, so there is no penetration for a push-out to
resolve and it simply stays outside the room looking at the back of the
geometry. Casting from the body outwards cannot reach that state at all.
Over 400 frames of circling in `RH_01` the ray cast leaves the room on zero of
them; the push-out left it on 34.

### 6.2 Lighting

A stage has no script, so unlike a cutscene the room's own `.sli` is all there
is — which settles a question the cutscene side had to guess at
([`VIEWER.md`](VIEWER.md) §5.3, and the note in
[`PS2SHADER.md`](PS2SHADER.md) about twelve resident lights being worse than
four). The GS material carries two point lights, so the two nearest the room's
centre win, chosen once per room rather than per frame so nothing pops.

---

## 7. The pad is PCSX2's

The viewer already reads the disc the emulator would have run, so the pad it
is driven with should be the one PCSX2 was set up with rather than a keyboard
layout this page invented. Drop a `PCSX2.ini` on the page — normally
`Documents/PCSX2/inis/PCSX2.ini` — and `[Pad1]` becomes the controls.

```
[Pad1]
Cross = SDL-1/FaceSouth
Up    = SDL-1/DPadUp
LUp   = SDL-1/-LeftY
L2    = SDL-1/+LeftTrigger
Start = Keyboard/Alt & Keyboard/Return
```

The key is the PS2 control and the value one or more physical sources joined
by `&`, which PCSX2 treats as a chord — all of them must be held.

**The SDL half needs no translation at all.** PCSX2's binding names are SDL's
GameController layout, and the W3C Gamepad API's "standard mapping" is that
same layout in the same order: `FaceSouth` is button 0, `DPadUp` is 12,
`LeftY` is axis 1. The whole translation is two lookup tables, which is
exactly why they are tested — a transposed pair there silently swaps Circle
and Cross and the game gets the blame.

Axis sources carry a sign — `-LeftY` is the stick pushed up — so a binding
reads one half of the axis and 0 on the other. Triggers are bound as axes by
PCSX2 but reported as analogue *buttons* by the browser, so they resolve to a
button source and keep their travel. Keyboard names are Qt's and do need
translating: `Return`, `Plus`, `Backtab`.

With no ini the page falls back to a keyboard set written **in PCSX2's own
syntax** and run through the same parser, so there is one code path and not
two.

### 7.1 What the buttons do

The physical binding comes from PCSX2. What each PS2 button *means* in a stage
is this project's choice, not the retail game's — the key-config screen (`KC`,
[`EXECUTABLE.md`](EXECUTABLE.md) §7.4) has not been read yet:

| control | |
|---|---|
| left stick / d-pad | move, relative to the camera |
| right stick | turn the camera |
| Circle or R1 | run |
| Cross | go through the door you are standing in |
| Square | set the selected trap |
| L1 / R1 | cycle the selected trap |

---

## 8. Verification

```
node tools/web/test_all.js            # 587 checks with a disc
node tools/web/test_all.js --no-disc  # 204 without
```

Two new suites need the disc and one does not.

**`test_stage.js`** diffs `col.js`, `mapbin.js`, `trap.js` and `stage.js`
against their Python counterparts over real disc data: five rooms' group
tables and wall segments, 40 floor and ceiling probes, 60 camera rays, four
stage graphs, every door mesh, all 48 traps with both texts and their
footprints, and the player's measured shape and gaits.

The important one is the solver. It is the only place in this repository where
the two copies produce **motion** rather than a picture, so a drift of a
thousandth per step is a player who walks through a wall in one of them and
not the other a hundred frames later. So the walk is scripted, deterministic,
and compared step for step rather than at the end — the first frame that
disagrees is the one worth seeing. Over 400 frames of walking and all 48 door
crossings in `M000` the two agree to **0.0**, exactly.

**`test_stageview.js`** runs the layer above it headlessly on
[`stub_three.js`](../tools/web/stub_three.js): assembling `M000`, building
and skinning Allura, walking her with a synthetic pad, checking a run covers
more ground than a walk, crossing a door, keeping the camera inside the room
over 400 frames, setting a trap on the ceiling and watching its reset timer
run down. WebGL cannot run in a test here, but almost nothing that breaks in
that layer needs a GPU.

**`test_pad.js`** needs no game data — a `PCSX2.ini` is not game data — so CI
runs it. It diffs `pad.js` against `pcsx2pad.py` over the built-in defaults, a
synthetic ini covering every source form the parser claims to handle, and this
machine's own `PCSX2.ini` if there is one.

---

## 9. Open threads

* **The intruders.** `M##INTRUDER.BIN` holds 116 `MissionIntruder` records,
  which is who comes into the stage and when. Undecoded.
* **`GMKINFO.BIN`.** 192 `GmkInfo` records of 60 bytes, the gimmick equivalent
  of `TRAPINFO`. Two string pointers and a run of −999.0 placeholders; not
  read past that.
* **The rest of `TrapData`.** About fifty varying byte offsets with no
  interpretation.
* **Trap firing.** The `.ssc` effect scripts are decodable today and are not
  run; setting a trap places its model and starts its reset timer, and nothing
  triggers it.
* **The trap grid.** `DATA/CAMERA/TRAP.BIN` is 1110 bytes of `s16` triples on
  a ±21 grid, which looks like the placement cursor's offsets. Not read.
* **`CHR_DATA`'s 2.50.** The constant relating the table's 30 and 60 to the
  measured strides of 12.00 and 23.95.
* **The retail button map.** §7.1's assignments are ours; the `KC` screen has
  the real ones.
* **`.txp` / `TransmitBox`.** 16 records across ten room archives, unread.
