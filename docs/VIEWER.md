# Playing Trapt cutscenes outside the emulator

`tools/export.py` turns any of the game's 154 real-time cutscenes into a
self-contained HTML page that plays it: the real camera track, the skinned
cast, the room, the subtitles and the original voice and BGM. No emulator, no
web server, no install beyond Python.

```sh
python tools/export.py --list                # every cutscene id on the disc
python tools/export.py e001 out/             # -> out/e001/index.html
python tools/export.py e001 out/ --single    # -> out/e001.html, one file
python tools/export.py e001 out/ --no-audio  # skip the ADX pass
```

Open `index.html` straight off disk. Space plays, the slider scrubs, arrow keys
step (hold shift for 5 s), and dragging the canvas switches to a free orbit
camera so you can walk around a frozen shot.

Two buttons control the look. **PS2 / Modern** switches the whole
fixed-function emulation on or off in one go — gamma handling, alpha rule,
texture filtering and output resolution all move together. **Look** opens a
grading panel that works in either mode. Both are documented in
[`PS2SHADER.md`](PS2SHADER.md).

`e001` — the opening — exports in about 24 s to a 18 MB page: 13 models,
25 animation clips, 67 textures, 45 subtitle cues and 45 audio streams.

---

## 1. What had to be reverse-engineered

Four of the six formats were already done (`AFS`, `RPS`, `.SMI`, `.TM2` in
[`../tools/README.md`](../tools/README.md); `.SSC` in
[`CUTSCENES.md`](CUTSCENES.md)). Building the viewer needed three more.

### 1.1 `.SAI` — skeletal animation (`tools/sai.py`)

18686 files, 545 MB, the biggest payload on the disc. A flat list of nodes
named after `.SMI` bones, each with up to three keyed channels:

```
0x00 u32  magic 0x20030818        0x0c u32  -> node array (always 0x14)
0x04 u32  file size               0x10 u32  0
0x08 u16  node count

NODE (0x30)                       CHANNEL (0x10, packed after the node array)
  +0x00 u32   duration              +0x00 u32  duration
  +0x04 c[32] node name             +0x04 u16  key count
  +0x24 u32   -> rotation           +0x06 u16  0xaaaa
  +0x28 u32   -> translation        +0x08 u32  -> times   u16[count]
  +0x2c u32   -> scale              +0x0c u32  -> values  float4[count]
```

Rotations are unit quaternions in **(x, y, z, w)** order in the column-vector
convention — the transpose of the row-vector 3x3 in the `.SMI` node. Settled
empirically: of four candidate layouts, only `(x,y,z,w)` against the transposed
bind matrix put a third of all keys within 5 degrees of the bind pose (the
bones a clip does not animate), and the other three scored 5% or 0%.

Translations and scales are `(x, y, z, 1)`. A missing channel falls back to the
bind matrix, which is how rotation-only clips keep a rig's proportions.

**All 18818 `.SAI` on the disc parse**, every time array ascending and inside
its clip, every rotation key unit length, every translation `w` exactly 1.
Channel slots in use: 733050 rotation, 79557 translation, 373 scale.

### 1.2 `.CAM` — camera tracks (`tools/cam.py`)

No magic, no names — a fixed 0x28-byte directory of four channels, each record
ending with its own timestamp:

```
0x00 u32  flags (0 everywhere)
0x04      {u32 count, u32 offset} x 4      absent channel: count 0, offset EOF
0x24 u32  padding; payload always starts at 0x28

record:   float[stride-1] value, float time     (1-based frame)
```

The stride is not stored — derive it from the gap to the next present
channel. Channels are `0` position, `1` look-at target, `2` roll, `3` vertical
FOV. **268 of 268 parse.** `e001.cam` is 11889 frames of position and target
at a constant 40 degrees.

### 1.3 `.SLI` — room lights (`tools/sli.py`)

Every `DATA/ROOM/<room>_ALL.ARC` ships one, and it holds the one thing a
cutscene's own light rig never records: the **direction** of its directional
light. A fixed 0x50 per record after a 0x10 header:

```
0x00 u32  version (1)        0x08 u32 -> records (always 0x10)
0x04 u32  count              0x0c u32 0

RECORD (0x50)
  +0x00 float4   position, or direction when kind == 0
  +0x10 float4   colour
  +0x20 float4   0,0,0,1        (never non-zero on the disc)
  +0x30 float2   range near, far
  +0x3c u32      kind -- 0 directional, 1 point, 4 ambient, 5 "black"
  +0x40 char[16] name
```

**92 of 92 parse**, each with exactly one ambient and one directional. The
names are legible — `rp03.sli` holds `ambient_light1_2`, `inf_light1_2`, three
`black_light4_*` and three `taimatu*` (松明, torch).

An SSC `0xB4` light block of kind 0 carries no direction; ELF `0x001D4430`
sums the room's directional lights and normalises. For `rp03` that gives
`(0.2594, 0.9342, -0.2450)`, and the live light in a savestate at `0x008138D0`
holds exactly that. The viewer had been using an invented
`(0.35, 0.80, -0.49)`.

### 1.4 `.ADX` — CRI audio (`tools/adx.py`)

1192 streams, 655 MB: BGM, room ambience and 1048 voice clips. Standard CRI
ADX, type 3, 18-byte blocks, 4-bit samples, 48 kHz, version 4, unencrypted.

The one thing worth writing down: the sample expression is

```
((delta << 12) * scale + c1 * prev1 + c2 * prev2) >> 12
```

The whole thing stays in 12-bit fixed point until a single final shift.
Splitting it into `delta * scale + (predictor >> 12)` loses a bit and drifts
audibly over a long clip — that mistake put a peak error of 426 (of 32767) into
a 0.7 s voice line. Done right, the decoder is **sample-exact against ffmpeg**,
verified over 19,024,000 samples of stereo BGM.

`DATA/SOUND/BGM/E001.ADX` runs 9,512,000 samples at 48 kHz = 198.17 s, which is
11890 frames at 60 fps — the opening's exact length.

---

## 2. Pipeline

```
GAME.DAT ──afs──> RPS ──arc──> .SMI .TM2 .SSC .SAI .CAM
                                 │
             scene.py  ── runs every .SSC track into one timeline
                                 │
   pose.py   ── .SMI skeleton + .SAI clip -> world matrices -> skinned verts
                                 │
        ┌────────────────────────┴────────────────────────┐
   render.py                                          export.py
   numpy software frame                        scene.js + player.html
   (the correctness gate)                      (the deliverable)
```

* **`scene.py`** compiles the cutscene: which archives to open, which models
  each actor wears, which clip plays from which frame, visibility, the light
  rig, fog, camera, subtitles and audio cues. It also folds in
  `DATA/ROOM/<room>_ALL.ARC`, which the script never names — `set_room` only
  picks the collision and lighting set, but that archive holds the `<room>.smi`
  the scene is actually staged in.
* **`pose.py`** poses a skeleton and skins it. `.SMI` stores each vertex once
  per influencing bone, already scaled by its blend weight, with the weight in
  the position's `w`. Transforming that homogeneous float4 by the bone matrix
  scales the translation row correctly, so the blend is a plain sum.
* **`render.py`** rasterises one frame with numpy. This is not a toy: it is the
  reference the WebGL player is checked against, and it is how every convention
  below was pinned down.
* **`export.py`** writes the page.

### Three conventions that will bite

1. **Row-vector matrices.** `.SMI` 4x4s are row-major and multiply on the
   right (`v' = v * M`), so a child's world matrix is `local * parent`.
2. **V is not flipped.** `.SMI` V already runs top-down, matching image row
   order. Applying the OBJ convention (`v = 1 - v`) sends face UVs into the
   blank half of their atlas — the symptom is streaky white heads while bodies
   and rooms look fine.
3. **`_h` models are alternatives, not additions.** A block often attaches both
   `x_h.smi` and `x.smi`. `_h` is the same character with a facial rig — eight
   extra bones, `lip_U/D/Lu/Ru`, `me_L/R`, `mayuge`, `miken` — and its own
   higher-detail texture set, used when a scene needs lip-sync. Drawing both
   renders each character twice and z-fights.

4. **The material colour is not a modulate factor, and the winding is not a
   normal.** Both are authoring leftovers in `.SMI`, and both were being
   believed. See §3.1 — between them they accounted for a black doorway and a
   5x loss of directional lighting.

Also: `0x80` is a **tint**, not a scale. On a light block it is the light
colour; on a model block it is a material multiplier (`0.5,0.5,0.5` = half
brightness). Treating it as a scale visibly shrinks the map track's door props.

---

## 3. The player

`tools/player.html` is the template. It vendors three.js 0.150.1 (the last UMD
build) and holds one `RawShaderMaterial`.

Skinning happens on the GPU with a **bone texture** — `c21m_a_h` has 64 bones,
which as `mat4` uniforms would consume the entire guaranteed vertex-uniform
budget. Each bone is four RGBA32F texels holding the matrix's four rows, and
the vertex shader is:

```glsl
mat4 B0 = boneAt(bidx.x);
vec4 p = B0 * lp0;                    // lp0.w carries the blend weight
vec3 n = mat3(B0) * (n0 * NRM);
if (two > 0.5) { mat4 B1 = boneAt(bidx.y); p += B1 * lp1; n += mat3(B1) * (n1 * NRM); }
```

`boneAt` builds `mat4(row0, row1, row2, row3)`. GLSL takes those as *columns*,
so the matrix arrives transposed — which is exactly what makes `G * v`
reproduce the row-vector product `v * M`. Nothing needs transposing by hand.

The light rig is the game's own, read out of the map track's `0x64` kind-6
blocks: ambient `rt_amb`, directional `rt_inf`, and the point lights `joyu`
(*actress* — the key light on the cast) and `rt_poi`, plus `0xC7` fog. Two
things are invented: `rt_inf`'s **direction**, which nothing in the script
records, and a single **exposure** multiplier, because the rig gives relative
levels and never says how bright `0.35` actually is.

The fragment stage now reproduces the GS's fixed function rather than
approximating it -- texture MODULATE with the `0x80 = 1.0` convention, the
real alpha-test threshold, per-material blend selection, and a 512x224
render target. That is derived and documented separately in
[`PS2SHADER.md`](PS2SHADER.md), which also covers the VU1 microcode bank.

### 3.1 Two things in `.SMI` that look like data and are not

Both of these shipped as bugs and both are cheap to fall for again.

**The material RGB at `+0x54` is authoring leftover.** It is *not* a modulate
colour. In `e001` alone ten materials pair `(0,0,0)` with a perfectly good
texture; multiplying it into the sample rendered the plaza door, the entire
`rp11_rt` prop set and `gf16_rt` pure black. The rest of the file agrees it is
junk: the only values that ever appear are `255,255,255`, `229,229,229`,
`(0,0,0)` and a few DCC-ish tints like `139,145,139`, and the flag words at
`+0x40`/`+0x42` do not separate the black ones from the white ones. A texture
**replaces** the colour; `diffuse` survives only for the handful of materials
that carry no texture at all (2 in a 567-material sample).

**The index winding is reversed against the authored normals.** Measured over
`e001` with the ADC strip decode: `(b-a)×(c-a)` runs *opposite* to the authored
vertex normal on **100.0%** of character triangle area (`c01f_a_h`,
`c15m_a_h`, `c21m_a_h`). It is a clean global reversal, not noise. So:

* Do not flip on `gl_FrontFacing`. Under WebGL's default CCW-front rule every
  visible surface reports *back*, so the flip inverted the normal across
  65–87% of submitted area and cut mean `N·L` from 0.78 to **0.13** — a 5–7x
  loss of directional response, which is precisely what the old additive
  `+0.34` lift was compensating for. `vN` is already outward; light with it
  unflipped.
* `side` stays `DoubleSide`. Single-sided culling would want
  `THREE.BackSide` given the uniform reversal, but it cannot be justified from
  the models alone: **environment meshes carry no normals at all**, so their
  winding has nothing to be checked against. (An earlier reading of a
  0–100% per-mesh spread in `rp03.smi` was an artefact of two things at once
  — decoding the strips without alternating winding, and the parser
  substituting a constant `(0,1,0)` for the absent room normals.) Culling
  needs the GS `PRIM`/`FRAME` state to settle it, not the geometry.

### Payload

| | |
|---|---|
| geometry | float4 position (weight in w), s16 normals at 1/4096, float2 UV, u16 bone pair |
| animation | u16 times; rotations quantised to s16 (~0.006 deg, half the size) |
| camera | baked one sample per frame, so the page interpolates nothing |
| textures | PNG, or JPEG when a texture is fully opaque |
| audio | decoded by `adx.py`, compressed to Ogg Vorbis by ffmpeg |

Everything is base64 inside `scene.js`, loaded by a plain `<script src>` — no
`fetch`, so it works from `file://` with no server.

---

## 4. Verification

The browser cannot be run here, so the player's maths is checked headlessly.

```sh
python tools/verify.py e001 1 1040 4400 7860 11800
```

`tools/test_player.js` extracts the `TRAPT MATH` block **verbatim out of
`player.html`** — so it exercises the code the page actually ships — poses
every entity at a frame under node, and `verify.py` diffs the bone matrices and
skinned vertices against `pose.py`.

Result across five frames of `e001` and one of `e118`: worst bone-matrix delta
**6.4e-4**, worst vertex delta **1.5e-3**, on ~5700 bone values and ~9200
vertex values per frame. That residual is the s16 quaternion quantisation and
nothing else.

The vertex shader is the one thing node cannot execute, so `test_player.js`
proves its convention algebraically instead: it builds `mat4` from rows the way
GLSL does and asserts the result equals the CPU row-vector product.

`export.py` has been smoke-tested over 18 cutscenes spanning `e001`–`e429_04`
(rooms `rh`, `rp`, `rc`, `rt`; 721–11891 frames; 3–19 actors) with no failures.

---

## 5. Four things the script says that the viewer was not hearing

All four were found by diffing a frame against the same frame on hardware. A
PCSX2 savestate pins to an exact cutscene frame by matching its live camera eye
(EE `0x0081B6F0`) against the `.CAM` track — `e001`'s state matches frame
**7422** to 4.7e-6.

### 5.1 `0xA2` is a bitmask on the track, and it fires outside the block

`0xA2 (mask, flag)` sets or clears bits of a flag word — ELF `0x001C8650`
forwards to `0x0029EC80`, which does `flags |= mask` / `flags &= ~mask` at
`+0xE0`. Bit 31 is **hidden**.

Two things made this invisible. The word lives on the **track** object, not on
the block's model (`0x0029EC80` takes the same `param_1` that `0x0029DF00`
hangs the block's object off at `+0xE4/+0xE8`, and the hide call at
`0x0029EBC0` walks that child list). And **most of these opcodes are emitted
outside any `0x64 ... 0x65` pair**, so a reader that only applies opcodes to an
open block keeps the first and drops the rest. `e001` has 110 of them and was
keeping 7.

The effect is a cutscene that never hides anyone: Graines stands frozen in the
palace doorway for the 90 seconds after he walks out of the scene. The polarity
is settled twice over against the hardware frame — Graines (`6060:set`) is
absent there and Catalina (`7260:clear`) is present, and the opposite reading
gets both backwards.

`0x67` (ELF `0x001C4DA0` → `0x0029DEF0`) destroys the track's current object.
`e001` uses it once, to swap the living king for his corpse at 8430.

### 5.2 A rigid mesh rides the node at `+0x2a`, not the root

`.SMI` meshes carry a 12-byte bone palette. When it is empty the mesh is rigid
and hangs off the **single node index at `+0x2a`** — a field that is never
`>= n_node` across all 22496 meshes on the disc, and is non-zero in **2521
models**. Reading it as 0 pins every such mesh to the model root: every
`buki_obj` a character holds, and props like `rp03d0`, the plaza door, whose
entire animation is one hinge node. Catalina's sceptre ended up at her feet
and the door hung unhinged across its own doorway.

### 5.3 `joyu` rides the camera

`0xB4`'s second argument parents a light to the camera (ELF `0x001D44B0`
rebuilds its position every frame as `camera_rotation * offset + eye`). The
offset's x runs along **-right**: `joyu`'s `(10, -5, 0)` at `e001` 7422 lands
at `(4.140, 5.258, -37.819)`, which `eye - 10*R - 5*U` reproduces to 5e-5.

`joyu` is 女優, *actress* — it is the key light on the cast, and it follows the
shot. Placed at its raw offset it sits 20 units away from where the hardware
has it, and **that is what the invented `EXPOSURE = 1.35` was compensating
for**. With the real direction (§1.3) and the real position, 1.0 minimises the
error on the cast and 1.35 is 40% worse. The multiplier is gone.

Worth knowing and *not* acting on: the hardware keeps **12** lights resident at
that frame — the room's 8 from `.sli` plus the script's 4 — but feeding all 12
to the material is far worse than the script's 4 alone. Whatever picks among
them, it is not "all of them".

### 5.4 Room geometry is culled by name

`0x63 (index, on)` toggles a named group of room geometry, indexing a table at
ELF `0x00376A30`: `IF_north`, `IF_south`, `IF_east`, `IF_west`, `IF_ceiling`,
`IF_floor`, `IF_distant`. `e001`'s map track fires 25 of them — at frame 7422
`IF_north` is off and `IF_south`, `IF_ceiling`, `IF_distant` are on. This is
the game hiding whichever walls are between the camera and the shot.

**Not implemented.** The ids resolve through `FUN_00298A30`'s table at
`0x0048EB10` into records the room holds at `+0x240`, which is a structure this
work has not opened. It costs nothing in `e001`, whose shots all look at the
facade, but it will matter in a room the camera enters.

---

## 6. Known gaps

* **`.slp` lip-sync is not decoded**, so mouths do not move. The 38 `.slp` in
  `RT_E001.ARC` pair one-to-one with `DATA/SOUND/VOICE/M####.ADX` and each has
  a known frame from the subtitle table — an ideal sample set for cracking it.
* **Effects are not played.** The `ef_*.ssc` tracks are parsed and kept in
  `Scene.events` but nothing renders them.
* **Alpha is a cutout, not a blend** (`discard` below 0.35). Hair sheen and
  similar translucent layers therefore read harder than they do on hardware.
* **One artifact.** In `e001` a flesh-coloured wedge shows at Allura's hip in
  the `rt_c01f_a_hl` (long-hair) costume. Textures all resolve, UVs are in
  range, material indices are sane and it is not backface-related; not chased
  further. She renders clean in every other cutscene checked.
* **`rt_inf`'s direction is invented** (see above).
* `--list` finds 149 cutscene directories against 154 registry entries, so a
  few ids share or lack an archive.
