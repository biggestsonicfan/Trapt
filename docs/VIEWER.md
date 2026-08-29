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

Four buttons control the look. **PS2 / Modern** switches the whole
fixed-function emulation on or off in one go — gamma handling, alpha rule,
texture filtering and output resolution all move together. **Subs** switches
the subtitles between the game's own font, drawn into the 512x224 framebuffer
the way the GS draws it, and plain DOM text; it follows the PS2/Modern button
until you press it. **Letterbox** runs the script's own `0x57` bars, which is
what the dialogue is meant to sit on (§1.5); it follows the PS2/Modern button
too. **Look** opens a grading panel that works in either mode. These are
documented in [`PS2SHADER.md`](PS2SHADER.md) and [`FONT.md`](FONT.md).

`e001` — the opening — exports in about 24 s to a 18 MB page: 13 models,
25 animation clips, 67 textures, 45 subtitle cues and 45 audio streams.

---

## 1. What had to be reverse-engineered

Four of the seven pieces were already done (`AFS`, `RPS`, `.SMI`, `.TM2` in
[`../tools/README.md`](../tools/README.md); `.SSC` in
[`CUTSCENES.md`](CUTSCENES.md)). Building the viewer needed four more.

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

### 1.4 The subtitle font (`tools/font.py`)

The game has no font on the disc: `DATA/FONT/FONT.BIN` is an 18-byte `FJF`
stub nothing reads. It draws dialogue from the **PS2 kernel font**, a full
JIS X 0208 face of 16x16 four-bit glyphs baked into the ELF at `0x003885C0`,
through a 16-entry alpha-ramp CLUT at `0x00388580`, with per-glyph advances in
a Shift-JIS-keyed range table at `0x004506E0`.

`0x60`'s `(x, y)` is the **centre of the first glyph box** in a 640x448 UI
space that maps into the GS's 512x224 by `(0.8, 0.5)`; a 16x16 glyph is drawn
into a 24x24 box, so on screen it is a 19.2 x 12 quad. Inline `%%SC<XX>` /
`%%RC` markup sets and restores the pen colour from a fifteen-entry table at
`0x0020D7B0`, which is what draws a speaker's name grey.

Laid out that way, `font.py` reproduces **all 56 glyph quad positions** in the
reference savestate's display list exactly, and rendering it matches PCSX2
captures at five frames of `e001` to the resampling noise floor. See
[`FONT.md`](FONT.md).

### 1.5 The letterbox (`0x57`)

Not cosmetic, and not symmetric. The opcode handler at ELF `0x001C6570` drives
two black 640-wide sprites in the same 640x448 UI space the subtitles use, and
re-sets their heights each time it brings them in: **50 at the top and 110 at
the bottom** — 25 and 55 lines of the 512x224 framebuffer, with the bottom band
starting at `y=169`. The tween at `0x001E43F0` slides them in from off-screen
over the opcode's own frame count, so `letterbox(0, n)` opens and
`letterbox(1, n)` closes. Every one of the 149 cutscenes issues `(0, 1)` on its
first frame and `(1, 1)` on its last.

That bottom band is why the dialogue anchor looks so low: the text is drawn
**on** the bar, not over the scene, and the 55 lines are exactly enough to hold
a three-line cue. The viewer used to draw an invented symmetric 9%, which put
the subtitles over the picture — the one thing [`FONT.md`](FONT.md) had
measured on hardware and could not explain. It can now: the capture of `e001`
at 7422 has 25 black lines at the top and 55 from 169 down, which is the ELF's
numbers exactly, and `pdiag.py` reproduces both.

It is an **overlay, not a viewport**. The world is still rendered to the whole
512x224 and the camera never learns about the bars, so the aspect ratio does
not change — the frame stays 4:3, and the visible band is a crop of it
(512x144, about 2.07:1 as displayed) rather than a squeeze.

### 1.6 `.ADX` — CRI audio (`tools/adx.py`)

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
                                 │        SLUS_212.55 ──font.py──> glyphs + advances
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
* **`font.py`** reads the subtitle face out of the executable and lays a cue
  out the way the game does; `export.py` bakes the glyphs a cutscene needs
  into one atlas.
* **`export.py`** writes the page.
* **`site.py`** runs `export.py` over the whole catalogue and assembles the
  result into one deployable directory (§2.1).

### 2.1 The whole catalogue (`tools/site.py`)

```
python tools/site.py site --jobs 8 --posters
```

writes a directory that drops on any static host, or opens off disk:

```
site/index.html      the gallery, in story order, generated from manifest.json
site/script.html     every line of dialogue in the game, in story order
site/order.js        the playlist -- story order, out of the ELF (order.py)
site/three.min.js    one copy, shared by every page
site/manifest.json   what got built, and every warning it raised
site/e001/index.html the player, pointing at ../three.min.js and ../order.js
site/e001/scene.js   that cutscene's data
site/e001/poster.png optional still, rendered by pdiag.py
```

Three things make it worth having over a shell loop. `export.py` copied
three.js into every bundle, which is 149 copies of 600 KB — `build()` takes a
`three_href` now and points the pages at one shared file instead. `Disc()` maps GAME.DAT once
per worker rather than once per cutscene, so `--jobs` scales nearly linearly.
And `build()` hands back what the index needs — room, length, cast, opening
line, warnings — so the gallery is generated from the same run that built the
pages, not from a second pass over 2 GB of output.

The posters go through `pdiag.py`, which reads the bundle's `scene.js`
directly (it only looks for `window.TRAPT_SCENE=`), at the first cue's frame —
so each still carries a line of dialogue sitting on the letterbox.

`--resume` skips what is already built, `--only`/`--skip`/`--limit` select,
`--no-audio` roughly halves the size, and `--serve PORT` serves the result for
a look. A failed cutscene is recorded in the manifest and shown on the index;
it never stops the other 148.

**The whole catalogue builds.** 149 cutscenes, `--jobs 8 --no-audio`, **17.8 s,
0.79 GB, no failures** — and exactly two warnings in the set, both a texture a
scene names and the disc does not have (`e106` wants `noIcon.tm2`, `e428_01`
wants `gdi_rh06_00.tm2`). With audio it is around 2.5 GB and paced by ffmpeg,
one process per voice clip.

### 2.2 Playing the story in order

Disc order is not story order, and a gallery of 149 ids sorted by name is a
catalogue rather than a game. `tools/order.py` reads the four ordering tables
out of the ELF -- the cutscene groups, the three per-chapter tables and the 30
branching ending records, all documented in
[`CUTSCENES.md`](CUTSCENES.md) §7 -- and `site.py` uses the result twice:

* the gallery is laid out **chapter by chapter**, each tile captioned with
  where the game plays it (`before stage 04`, `chapter opening`, `first
  clear`), and the search box hides an empty chapter's heading with it;
* `order.js` is written next to it as `window.TRAPT_ORDER`, and every player
  page loads it. The same file carries `window.TRAPT_STORY` -- the tables
  unflattened, which is what story mode walks (§2.3).

That is what turns the player into a playlist. With `order.js` present the bar
grows **prev / next** buttons and an **Auto** toggle, and the position readout
becomes `all · 12 / 149`. Auto plays the cutscene to its last frame and then
navigates to the next one, so **Play in order** on the gallery walks the whole
game from `e001` to the last ending unattended. The flag rides in
`sessionStorage` plus an `?auto=1` on the URL, because each cutscene is its own
page; `,` and `.` step by hand.

Two details that matter. A `export.py` bundle with no `order.js` is unchanged
-- `window.TRAPT_ORDER` is absent, the buttons stay hidden and nothing
navigates -- so the standalone single-file export still works exactly as it
did. And a page reached by auto-advance has had no click of its own, so the
browser may refuse to start its audio; the picture runs regardless and the
hint line asks for a click.

`site.py` also writes **`script.html`**: all 1492 subtitle cues, in story
order, each scene linking to its own player page. It is the game's whole spoken
script as one document.

### 2.3 Story mode — the game's own machine, with you in the gaps

**Play in order** is a list. Story mode is the game: `player.html` carries a
re-implementation of `FUN_00173520` (chapters) and `FUN_0032A7C0` (endings)
over the same tables, in its `TRAPT STORY` block, and runs a real playthrough
— chapter opening, the cutscenes before a stage, the stage, the cutscenes
after it, the next stage or the next chapter, and one of the three finales or
one of the thirty ending flows.

The viewer has no rooms to play, and three story flags at `app+0x40E` are set
by something inside those rooms that has not been found
([`CUTSCENES.md`](CUTSCENES.md) §7.3). So everywhere the retail game would
learn something the viewer cannot, it **asks**:

| where the game would look | what you are asked |
|---|---|
| the screen at state 5 (`FUN_00173050`) | play this chapter (`0x100D`), take one of its two ending routes (`0x100E`), or stop (`0x1002`) |
| the same screen, on a chapter that reads a flag | enter chapter 10 / 14 / 15 with its story flag set or clear |
| a stage's result (`FUN_00172B50`) | cleared (`0x1013`), failed (`0x1003`, which clears the chapter's flag and drops you back to the screen), or retry (`0x1012`) |
| `FUN_0032A5D0` inside an ending | which way bit *n* of `app+0x40F` went, with the cutscene each side leads to |

Nothing is invented: every option on those panels is a result code or a flag
the ELF actually tests, and each one prints the code it stands for. The panel
also shows the chapter and the live story flags, so a run is legible as it
goes — and the branches are real, so the choices land you on different
cutscenes and different endings.

Start it from **Story mode** on the gallery. The run's state is JSON in
`sessionStorage` (each cutscene is a separate page, so it has to survive the
navigation) and `?story=1` is what marks a page as part of a run; a plain click
from the gallery is still a plain page.

Three runs worth trying, all confirmed by `tools/test_order.js`: clear
everything and never take a flag, and you get 14 chapters and `e129 e130`;
carry flag 1 into chapter 14 and flag 2 into chapter 15, and the run is longer
and ends `e230 e231`; set flag 0 at chapter 10 and the game plays stage `0x11`
and then stops dead, which is exactly what `FUN_001741B0` and `app+0x7F` do.

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
| font | only the glyphs the cutscene's cues use, CLUT already applied, one padded 16x16 cell each — 51 glyphs and 4.6 kB for `e001` |

Everything is base64 inside `scene.js`, loaded by a plain `<script src>` — no
`fetch`, so it works from `file://` with no server.

---

## 4. Verification

The browser cannot be run here, so the player's maths is checked headlessly.

```sh
python tools/verify.py e001 1 1040 4400 7860 11800
```

`tools/test_player.js` extracts the `TRAPT MATH` and `TRAPT SUBS` blocks
**verbatim out of `player.html`** — so it exercises the code the page actually
ships — poses every entity at a frame and lays out every subtitle cue under
node, and `verify.py` diffs the bone matrices and skinned vertices against
`pose.py` and the glyph placements against `font.py`.

Result across five frames of `e001` and one of `e118`: worst bone-matrix delta
**6.4e-4**, worst vertex delta **1.5e-3**, on ~5700 bone values and ~9200
vertex values per frame. That residual is the s16 quaternion quantisation and
nothing else. The subtitle side comes back at **5e-7** over 1941 glyph
placements, which is the harness's own rounding; the font's own gates -- the
layout against the hardware display list and the raster against a PCSX2
capture -- are in [`FONT.md`](FONT.md).

The vertex shader is the one thing node cannot execute, so `test_player.js`
proves its convention algebraically instead: it builds `mat4` from rows the way
GLSL does and asserts the result equals the CPU row-vector product.

The playlist and story mode are checked the same way, by
`tools/test_order.js`. It lifts the `PLAYLIST` block verbatim out of
`player.html` and runs it against a stub DOM -- prev and next at both ends of
the list, Auto arriving with `?auto=1`, Auto switching itself off at the last
cutscene, a bundle with no `order.js` doing nothing at all -- and then the
`TRAPT STORY` block, which is pure, against the real tables from
`order.py --tables`. That half walks whole playthroughs and asserts on what
they played: the straight run's 14 chapters and `e129 e130`, the flag-1 route
through chapter 15 to `e230 e231`, chapter 10 stopping the machine, a failed
stage taking its story flag away, an ending flow branching both ways, and a
partial site skipping the cutscenes it does not have. Its four branch rules
are diffed against `order.py --rules` over all 120 (chapter, flag) rows, so
the Python and the JavaScript transcription of the ELF cannot drift apart.
**63 checks, `node tools/test_order.js`.**

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
