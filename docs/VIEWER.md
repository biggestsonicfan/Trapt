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
too. **Look** opens a grading panel that works in either mode. **CRT** puts RetroArch's newpixie-crt in front of the
output; see [`PS2SHADER.md`](PS2SHADER.md) §4. These are
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
* **Effects are played as billboards, not as particle systems.** Sprite
  effects render — see §7 — but `0xC8`/`0xC9` clearly steer an emitter count
  and a spread that nothing reads, so a burst of eight sparks comes out as one
  sprite at the emitter rather than a trail.
* **One particle, where the hardware has a cloud** (§9.3). The flipbook runs
  and the timing is the game's, but a single billboard spends most of its
  cycle faded out, so a torch flickers rather than burns steadily.
* **An emitter emits one sprite, not a cloud.** `0x9E`, `0x9F`, `0x74` and
  `0x77` are a particle system that is read but not run (§9.2).
* **Alpha is a cutout, not a blend** (`discard` below 0.35). Hair sheen and
  similar translucent layers therefore read harder than they do on hardware.
* **One artifact.** In `e001` a flesh-coloured wedge shows at Allura's hip in
  the `rt_c01f_a_hl` (long-hair) costume. Textures all resolve, UVs are in
  range, material indices are sane and it is not backface-related; not chased
  further. She renders clean in every other cutscene checked.
* **`rt_inf`'s direction is invented** (see above).
* `--list` finds 149 cutscene directories against 154 registry entries, so a
  few ids share or lack an archive.

---

## 7. Sprite effects

Reported as "e004 does not play the effect correctly", and it did not — nor
did ten other cutscenes. `python tools/scene.py --effects` prints the state of
it for the whole disc.

**The cause was one thing.** A model effect names an `.smi` with `0x82`; a
*sprite* effect names a **texture** with `0x68`, and only `0x82` was
implemented. So the whole block compiled to an entity with nothing to draw.
The correlation was one-to-one: 57 sprite blocks across 10 cutscenes against
59 effect entities that drew nothing.

### 7.1 The opcodes

From the dispatch table at `0x00376660`, and from the data:

| op | handler | what it is |
|---|---|---|
| `0x68` | `FUN_001C4C90` | texture + `(cell w, cell h, sheet w, sheet h)` |
| `0x6D` | `FUN_001C47F0` | `(sx, sy, frame)` — a size keyframe |
| `0x6E` | `FUN_001C46A0` | `(r, g, b, a, frame)` — a colour keyframe |
| `0xCA` | `FUN_001C1D50` | `(actor, bone)` — bind the emitter to a bone |
| `0xC8`, `0xC9` | | emitter parameters; structure only |
| `0xAA` | `FUN_001C46A0` | **the same handler as `0x6E`** -- an alias |
| `0xAB` | `FUN_001C47F0` | **the same handler as `0x6D`** -- an alias |

`0xAA`/`0xAB` are not new opcodes: they resolve to the very same handlers as
`0x6E`/`0x6D`, so the sprite path and the particle path share one keyframe
implementation and the script may spell it either way.  e001's torches use
only the `0xAA` spelling, which is why they had **no colour ramp and no
growth** until both were read -- an invisible flame.

The keyframes needed no guessing. In `ef_e004_30.ssc` the `0x6D` pairs run
`(0.5,0.5)@0 (2,2)@10 (4,4)@140 (4.5,4.5)@240` — always equal, always growing
— while the `0x6E` quads hold `(1.5, 0.2, 0.1)` and move the fourth
`0 → 1.8 → 1.8 → 0` over the same span. A sprite that swells while it fades up
and out again.

`0xCA`'s handler asserts the effect object's kind is 3, which is exactly the
block kind these appear in, then resolves the actor by name, looks the bone up
by name and hands the effect its matrix.

The four ints on `0x68` are a sprite-sheet cell and the sheet it sits on:
`ef_p_s_00.tm2` is `32 32 256 256`, an 8×8 grid of 32-pixel cells on a texture
that really is 256×256. Five textures declare a sheet larger than the file,
and in every one of those the cell *is* the sheet, so the UV rect is the whole
image either way — no case is actually inconsistent.

**Three of the sheets are flipbooks, and the cell matters.** `ef_p_s_01.tm2`
is sixteen rows of four 64×16 frames of an explosion on one 256×256 page;
`ef_p_s_00.tm2` is an 8×8 grid of 32×32; `ef_g004a.tm2` and `ef_e132d.tm2` are
four 32×32 in a row. Drawing the *page* as one quad puts the whole animation
on screen at once — which is what a red rectangle over a third of `e001`
turned out to be. The quad takes one cell's UV rect and its aspect: a 64×16
cell is four times as wide as it is tall, and a square quad stretches it.

**`0x9F` drives the flipbook**, and it also proves the reading above.
`FUN_001C4A50` takes `(rate, columns, rows, cells, …)` and defaults each of the
last three when the script passes 0 — columns from `sheet_w / cell_w`, rows
from `sheet_h / cell_h`, cells from `columns × rows` — dividing the very
fields `0x68` filled in. It then writes `rate × cells` to `+0xb4`.

For e001's torch, `0x9F 4 4 8 0` is four columns, **eight rows** and so 32
cells at four frames each: a 128-frame life, which is exactly where its `0xAA`
alpha keys end. So `rate` is frames per cell, `+0xb4` is the particle's whole
life, and the flame is the **top half of the page only** — the 32 translucent
orange cells, not the bright burst below them. Two independent readings, the
ELF's arithmetic and the alpha split measured off the pixels, agree.

### 7.2 Two things that had to be fixed underneath

**The textures were never loaded.** `spark.tm2`, `ef_s014c.tm2` and the rest
live in `DATA/EFFECT/EF_COMMON.ARC`, with per-room ones in
`DATA/EFFECT/DI/EF_DI_R??.ARC`. Neither was ever opened, so even a compiled
sprite block had no picture.

**129 TIM2 files decoded to nothing.** Byte 5 of a TIM2 is its `format`, and
it moves the first picture header: 0 puts it after the 16-byte file header,
anything else aligns it to 128. Reading `0x10` unconditionally made every
format-1 file read as a 0×0 picture — 129 of the disc's 7668, among them
`spark.tm2` itself and `rh01_21.tm2`, a wall in the first room of the House
that stage mode renders. All 7668 decode now, up from 7539.

### 7.3 What e004 actually does

`ef_e004_11` and `_12` put `spark.tm2` on Allura's own right arm — bound to
`yubi_2_1_R`, `te_R`, `hiji_R` and `ude_R`, her finger, hand, elbow and
forearm — coloured `(0.9, 0.3, 0.1)` by `0x80`, spawned twice each from frame
1172. `ef_e004_30` and `_31` add a keyframed flash from 1420. Seventeen
billboards in total, fourteen of them bone-bound.

### 7.4 What it cost, in numbers

|  | before | after |
|---|---|---|
| corpus events ignored | 3910 (17.3%) | 3754 (16.6%) |
| effect-track events ignored | 1461 (62.5%) | 1305 (55.8%) |
| effect entities drawing nothing | 59 of 78 (75.6%) | **2 of 78 (2.6%)** |
| TIM2 decoding | 7539 of 7668 | **7668 of 7668** |

The two that still draw nothing are one block in `e129` and one in `e107`,
neither of which names a texture or a model.

A billboard is not a particle system, so this is not finished: the emitter
parameters are carried and unused, which is why a spark is one sprite rather
than a trail of eight.

---

## 8. The oracle

Everything in §7 is "the script's numbers, rendered". None of it has been
checked against the machine, because a savestate is only ground truth once you
know which frame of which cutscene it is a picture of — and the game writes
that down nowhere convenient.

It does write down the **camera**: a live eye/target pair at EE `0x0081B6F0`,
updated every frame from the `.CAM` track. So the frame can be recovered by
matching that pair against all 268 tracks on the disc. A camera path is a
signature; there is no ambiguity and no threshold to tune.

```
python tools/oracle.py

SLUS-21255 (DCFBB290).01.p2s   not in a cutscene (the camera words are stale)
SLUS-21255 (DCFBB290).02.p2s   not in a cutscene (the camera words are stale)
SLUS-21255 (DCFBB290).08.p2s   e001 frame 7422  residual 3.81e-06
SLUS-21255 (DCFBB290).09.p2s   not in a cutscene (the camera words are stale)
```

That slot-08 answer is the one §4 arrived at by hand, so a run which
reproduces it is a self-test of the recovery rather than of the savestate.
`test_assets.js` asserts it.

### 8.1 There is more than one camera slot

Every story cutscene used to come back "not in a cutscene". The reason was not
that the camera moves onto the heap, as assumed for a while: `0x0081B6F0` is
the **attract loop's** slot, and a story cutscene writes 0x40 further on, at
`0x0081B730`, leaving the first one full of `0x7c` filler.

That was found by searching rather than guessing. A `.p2s` holds all 32 MB of
EE RAM, so take every 16-byte-aligned offset whose first three floats fall in
the bounding box of a cutscene's eye positions *and* whose next vector, 0x10
on, falls in the box of its targets. For e004 that leaves 3783 candidates out
of two million in 0.1 s, and matching all of them against all 3349 frames at
once takes another 0.7 s:

```
0x0081B730  frame 2129  residual 1.9e-06   <- one slot over
0x011A4360  frame 1420  residual 8.1e+00   <- and nothing else is close
```

Both slots are now tried and the residual picks the winner, so the same run
identifies attract-loop and story captures alike. Two guards came with it: a
slot whose eye equals its target is a cleared one, not a shot -- the zeroed
slot matched `e105` at a residual of 14 if you let it -- and a match over
`MATCH_MAX` (1.0 world unit) is no match, since a right answer is 1e-06 and
the nearest wrong one seen is 8.

The live `--watch` path reads every slot too, for the same reason: during a
story cutscene the attract slot can still hold a stale but plausible camera,
and taking the first one would wait for ever.

### 8.2 Two ways the oracle lies, and what it says instead

**A held camera answers for its whole shot.** The residual only knows the
camera, so when the camera does not move the answer is a *shot*, not a frame.
e004's flash holds one camera value for frames **1420..1739** -- 5.3 seconds,
with the entire effect window (1420..1660) inside it -- so no camera match can
ever pin that effect, and a frame quoted out of that span is arbitrary. This
cost a wrong conclusion before it was noticed: the sparks appeared to spawn at
1137 against the script's 1172, a 35-frame error, and both frames turn out to
sit inside one 70-frame held block (1125..1194), so nothing was wrong at all.

`match` now returns the span as a fourth value and the listing prints it:

```
.00.p2s  e004 frames 1420..1739 (the camera is held still for all 320)  residual 0.00e+00
.07.p2s  e004 frame 2129                                               residual 1.91e-06
```

Where the camera moves, single frames stay single -- e001 still answers 3705,
10834, 1341 and 7422 -- so this costs nothing and stops false precision.

To pin a frame inside a held shot, something else has to supply the clock. The
effect instances carry one: age at `+0x10` against a lifetime at `+0x1c`
(9.5), so `frame = spawn + age` where the spawn is known.

**A savestate taken at a breakpoint is not a picture of the breakpoint.** Two
states saved at `0x001C4C90` hits at least 25 frames apart came back with
**byte-identical** `Screenshot.png` (sha1 `460e8c4f...`) and differing
`eeMemory.bin`. Nothing is presented while the emulator is halted, so the
screenshot is whatever frame was last displayed. The RAM is the halted moment;
the picture is not, and the two must not be read as one observation.

**`--watch` needs PINE to itself.** PINE serves one client at a time, and when
somebody else already holds it the socket still *accepts* and then never
answers -- which arrives as a bare `timed out` fifteen minutes later and looks
exactly like "nobody played to the cutscene". A PCSX2 MCP server holds it. The
error says so now. With MCP attached, read `0x0081B730` through it instead and
match by hand.

A state that is **not** in a cutscene reads as garbage rather than zero — the
camera words hold whatever was last there, often denormals of order 1e37 — so
those are reported as such instead of being matched to the nearest track by
accident.

### 8.0 Catching a cutscene as it plays

`--watch` sits on PINE, matches the live camera against one cutscene's track
and saves a state the moment it appears -- so a capture can be aimed at a
moment somebody has to *play* to, rather than hunted for:

```
python tools/oracle.py --watch e004 --from 1172 --to 1212 --slot 5
```

Matching a single track keeps each poll cheap enough to leave running. PCSX2
takes **one** PINE client, so nothing else may hold it -- the MCP server does
when it is running, and this will be refused while it is.

### 8.1 What is still missing

None of the four savestates on this machine is in a cutscene that has sprite
effects, so §7 has no hardware reference at all. Getting one means saving
while an effect is actually up, and `oracle.py --effects` says when:

```
python tools/oracle.py --effects

scene     texture             from      to at 60fps  bones
e004      spark.tm2           1172    1202  0:19.53  3
e004      ef_s014c.tm2        1420    1660  0:23.67
e008      ef_p_s_00.tm2       1570    1770  0:26.17
e124      ef_s020a.tm2        1030    1210  0:17.17
e132      ef_u012.tm2         2230    2410  0:37.17
```

`e004` at about 19.5 s is the best target: it is the only cutscene that binds
an effect to a bone, so one capture checks the sprite rect, the keyframes and
the bone attachment together.

Note the frame counter cannot be written to seek there — doing so soft-resets
the game ([`FONT.md`](FONT.md)) — so the capture has to be taken by playing
forward.

### 8.2 Why not the emulator's IPC

PINE takes a single client, so anything holding it locks everything else out,
and it reads one byte per round trip. A savestate is free, repeatable, and
works offline. `docs/PS2SHADER.md` makes the same point about the GS state.

---

## 9. The torch flames, and what the oracle said

Reported as "the flame effects don't work in our e001 room". They did not, and
§8's oracle is what settled why — this is the first part of the effect work
checked against the machine rather than against the script.

### 9.1 They are the room's torches

`e001` spawns `ef_p_s_01.tm2` exactly three times, and `rp03.sli` has exactly
three `taimatu` (松明, *torch*) point lights:

| sprite spawn | torch light | colour |
|---|---|---|
| (0.0, 49.5, −134.0) | `taimatu2_2` (−0.2, 45, −119.8) | 0.5, 0.35, 0.3 |
| (−66.1, 49.5, −117.0) | `taimatu_2` (−80.2, 40, −119.8) | warm orange |
| (68.0, 49.5, −117.0) | `taimatu1_2` (79.8, 40, −119.8) | warm orange |

The sprite is the visible flame and the light is what it casts; they are
placed independently, at the same three torches.

A capture pinned to `e001` frame **10834** (residual 9.5e-07) shows one on
hardware: a tall narrow plume, bright yellow at the base, above a dark
brazier. Peak RGB in the patch is (255, 221, 129).

### 9.2 Three things were wrong

**`0xAA` and `0xAB` were not read.** They resolve to the *same handler
addresses* as `0x6E` and `0x6D` — `FUN_001C46A0` and `FUN_001C47F0` — so they
are aliases, one keyframe implementation shared by the sprite and particle
paths. e001's torch spells it only the `0xAA` way, so it had no colour ramp
and no growth. It does now:

```
0xAA  (1, 1, 1, 0.9)@0  (0.6, 0.5, 0.5, 0.8)@32
      (0.2, 0.05, 0.05, 0.3)@64  (0, 0, 0, 0)@128
0xAB  (1, 2)@0  (4, 7)@100
```

white and bright, fading through dull red to nothing over 128 frames, while
growing from 1×2 to 4×7.

**The quad was taking the cell's aspect.** A 64×16 cell is four times as wide
as it is tall, and the flame is *taller* than wide. The size keys say so —
(1, 2) to (4, 7) — and so does the capture. The shape is the keys' job; the
cell only picks the UV rect.

**A never-ending track was played once.** These three tracks carry no
`at_time` after their block, so a single pass left each torch lit for two
seconds and then dark. A track that never ends is an emitter that never
stops, so the keyframes loop.

### 9.3 One emitter is a cloud, not a billboard

Reading the script out, `ef_e001_20.ssc` is a particle emitter:

```
9f  4 4 8 0 0 0
9e  20 96 96 0.008 0 1 0
77  2 0 0 0 1
74  -0.001
```

and the sheet is built for it: the scanline gaps fall at every 16 rows in the
top half and every 32 in the bottom, so the page holds eight 64×16 wisps and
four 64×32 puffs — small, wide, short pieces that a plume is *made of*, not a
flame each. `0xC8`'s count in `e004` is 8 and 16, which is how many.

**How many are alive at once falls out of `0x9F`.** It writes `rate * cells`
to `+0xb4` — 128 for the torch — and that is the particle's whole life,
because it is also where the `0xAA` alpha keys end. A steady emitter spawning
one particle every `rate` frames therefore holds `life / rate` = `cells` of
them at any moment, each a cell-step older than the last, so between them they
show every frame of the sheet. That is what the 32 cells are *for*.

It is also why a single billboard looked nothing like the hardware: one
particle is faded out for most of its cycle, and the alpha swings 0.90 to 0.01
over 128 frames. Thirty-two staggered ones sum to something steady — measured
over the same frames, the total alpha holds at about 41 instead of swinging.

Confirmation for the sheet fields came from EE RAM. Scanning a savestate for
`0x9F`'s fingerprint — `+0x24 = 4`, `+0x25 = 8`, `+0x29 = 32`, `+0x2a = 4`,
`+0xb4 = 128` — finds the live effect objects, and reading them back gives
`+0x1c = (64, 16)` and `+0x20 = (256, 256)`: `0x68`'s four numbers, on
hardware, exactly as read.

### 9.4 e004's sparks, and what the disassembler settled

e004's sparks use `0xC8`/`0xC9` where the torch uses `0x9F`, and chasing them
through the debugger produced more negative results than positive ones. All of
it is worth keeping, because each cost time.

**`0xC8` and `0xC9` only store.** The effect object's vtable is `0x004758A0`
and the two entries those opcodes call are eight instructions between them:

```
+0x5c  0x0018CEE0   sw   a1,  0x210(a0)     <- 0xC8's count
                    swc1 f12, 0x214(a0)
                    swc1 f13, 0x218(a0)
                    swc1 f14, 0x21C(a0)
+0x60  0x0018CF00   swc1 f12..f15, 0x220..0x22C(a0)   <- 0xC9's four
```

Read live, a spark object holds `+0x210 = 8` with `+0x21c = 2.0`, and another
`16` with `3.0` — exactly `ef_e004_11`'s `0xC8 8 0 0.8 2` and `_12`'s
`16 0 0.8 3`. The count is real. What *spends* it is not in the effect module:
scanning the whole ELF for `lw ?, 0x210(?)` finds no reader in
`0x00188000`–`0x0018E000`, which is what you would expect if the consumer
holds a base pointer shifted by some other offset — the one case an offset
scan cannot find.

**The 16-slot region at `+0x188` is not a particle array.** It is written once
at setup, to `0x80808080`, and never touched again; a write-watchpoint across
the whole effect never fired.

**Watchpoints on heap addresses are unreliable here.** A read-watchpoint on
the count broke inside a `lq`/`sq` memcpy whose backtrace runs
`memcpy ← 0x0017F8B0 ← 0x00309350 ← 0x003086E0 ← … ← 0x00178520` — the
resource loader streaming over the region once the cutscene moved on, not a
consumer. The allocation is reused the moment e004 ends.

**What `0x00188B30` turned out to be.** Each object carries a behaviour
function at `+0x2c`, and it differs by effect: `0x9F` sets `0x00188930`, while
the spark objects carry `0x00188B30`. Disassembled, the latter is a
**keyframe evaluator**, not a spawner — it wraps a time with
`a2 % [a1+0x98]`, then walks a table of 8-byte records from `a1+0x18`,
`[a1+0x14]` of them, picking by threshold.

Just above it, `0x001887F0`–`0x001888A0` computes **scrolling UVs**, the same
shape twice for U and V:

```
lbu    v0, 0x0C(a1)        a cell base, one byte
mtc1   a2                  the time
lwc1   f03, 0xA4(a1)       a rate
madd.s f01, f03, f02       base + rate * time
div.s  f04, f01, f00       / the dimension
```

So the module animates a sprite by scrolling its UVs and interpolating a
keyframe table — and `a1` there is a **texture-animation descriptor**, a
sub-object, not the effect object. An earlier reading that put `+0xa0` at
`object+0x210` was chaining off that confusion and is wrong.

### 9.5 The instance model, read off the running game

Breaking on `0x00188B30` while an effect was drawing settled it. The caller
at `0x00190780` is a **per-instance** update:

```
s0 = the instance
a1 = [s0+0x04]        its descriptor
a2 = lhu [s0+0x10]    its AGE
jalr [a1+0x10]        -> 0x00188B30, writes a UV rect to sp+0x20..0x2c
[s0+0x10] += 1                          age++
if [s0+0x16] and age >= [s0+0x1c]:      loop flag, lifetime
    [s0+0x10] = 0                       restart
```

So an effect is a **linked list of instances** — `+0x00` next, `+0x04`
descriptor, `+0x10` age, `+0x16` loop, `+0x1c` lifetime — each carrying its
own age and all sharing one animation. Three live instances read back
sharing descriptor `0x015D06FC` at ages **7, 6 and 6**, lifetime 32 apiece.

The descriptor is the animation:

```
+0x00 u16 cell w    +0x04 u16 sheet w    +0x10 u32 behaviour fn
+0x02 u16 cell h    +0x06 u16 sheet h    +0x14 u8  key count (max 16)
+0x18     key[count], 8 bytes: { u32 frame, u16 u, u16 v }
+0x98 u32 loop length                    +0x9c u8  loop flag
```

and the live one holds eight keys walking four columns by two rows of 32x16
cells on a 128x64 sheet, one every four frames, looping at 32:

```
 0 -> (0,0)    4 -> (32,0)    8 -> (64,0)   12 -> (96,0)
16 -> (0,16)  20 -> (32,16)  24 -> (64,16)  28 -> (96,16)
```

**Three things fall out.** The flipbook is an explicit `(frame -> u, v)` table
rather than a rate the viewer derives — close to the same result, but the
game tabulates it. `0x68`'s four numbers are cell and sheet size, confirmed a
third time and now from the struct the animation itself reads. And the
staggered-age model the torch uses is **the game's own**: many instances, one
animation, different ages. The `+0xA0`/`+0xA4` scroll-rate fields are unset
filler for these effects, so scrolling is not the mechanism.

That resolves 9.4's tension in favour of the cloud. What is still unproven is
only whether `0xC8`'s 8 and 16 are that instance count.

Also: across four hardware frames of e004, at poses including the exact
arm-raise the `0xCA` bones describe, **no sparks were visible on screen**.
Either they are briefer than the sampling, or they fire at a moment the frame
estimate has not found.

### 9.6 One texture on the disc is a quadrant

A reported crop turned out not to be a crop at all.  e004's blast drew as a
hard-edged square, fully bright along two of its sides, rather than a round
glow.  The block declares `0x68 ef_s014c.tm2 64 64 64 64` -- one cell filling
the whole 64x64 sheet -- so the UV rect was already the entire texture and
there was nothing left to crop differently.

The texture is the answer.  Of the sixteen sprite textures the 154 cutscenes
use, `ef_s014c.tm2` is one of only two whose alpha does **not** peak in the
middle.  Measured straight out of the pixels it is a clean radial falloff
centred on its bottom-right *corner*:

```
 r from (63,63)     0    12    24    36    48    60    66    72
 mean alpha       255   255   254   226    93     9     0     0
```

flat out to r = 30 and gone by r = 66 -- a radius larger than the tile, so the
tile holds one quadrant of a glow about 128 across.  The other is
`ef_e129d.tm2`, bright on two opposite corners.  All fourteen others peak in
the centre.

**`0x6C` says which.**  Its handler `FUN_001C45C0` reads six values, coerces
each with `!= 0`, and passes all six to a vtable method -- six switches, not
six numbers.  Eight sprite blocks on the disc carry one, and the fourth flag
splits them exactly along the line the pixels drew:

| texture | `0x6C` | shape from its alpha |
|---|---|---|
| `ef_s014c.tm2` (x3) | `1 0 0 **1** 0 0` | quadrant, centred on its BR corner |
| `ef_e129d.tm2` | `0 0 1 **1** 0 0` | two opposite corners |
| `ef_d002c.tm2`, `ef_e129c.tm2` | `0 0 1 **0** 0 0` | centred |
| `ef_p_s_00.tm2`, `ef_s014f.tm2`, `ef_s020a.tm2` | `1 0 0 **0** 0 0` | centred |

Four for four and five for five, from two measurements that know nothing
about each other -- one taken from the bytecode, one from the texels.

So flag 3 means the tile is a quadrant and the billboard is it mirrored into
all four, laid out so the tile's bottom-right corner meets at the middle.
`play.js` builds those sprites from four quads instead of one
(`spriteGeometry`); the footprint is unchanged, since the size keys still
describe the whole sprite.  Everything else keeps the single quad it had.

What this does *not* settle is the other five flags.  Only the fourth is read.

### 9.7 What is still not right

**Where the particles go.** `0x9E 20 96 96 0.008 0 1 0`, `0x74 -0.001` and
`0x77 2 0 0 0 1` carry the spawn spread and the rise, and none of them is
read, so the thirty-two sit on top of each other. It reads as a bright
flame that pulses in place rather than a plume climbing off the brazier.
