# Trapt (SLUS-21255) asset extraction

Tools for pulling 3D models and textures out of *Trapt* / *Kagero II* (PS2).
Everything is read straight out of `DATA/GAME.DAT` on the disc; no files on
the disc are modified.

## Usage

```
python extract.py <outdir> [--filter SUBSTR] [--limit N] [--no-tex] [--raw]
```

* `--filter CHARA/C01F_A` — only archives whose path contains this substring
* `--limit N` — stop after N models
* `--no-tex` — skip texture decoding
* `--raw` — also drop the untouched `.smi` next to the converted mesh

Each `.SMI` becomes a Wavefront `.obj` + `.mtl` in its **bind pose**, with the
referenced `.TM2` textures written alongside as PNG. Output mirrors the disc
tree (`DATA/CHARA/C01F_A.ARC` → `CHARA/C01F_A/`).

Sanity-check a result without opening a 3D app:

```
python preview.py model.obj out.png [--size 512] [--yaw 70]
```

Cutscenes go to a browser instead. One:

```
python export.py e001 out            # out/e001/{index.html,scene.js,three.min.js}
python export.py e001 out --single   # one self-contained .html
```

All of them, into a directory you can deploy as-is (see
[`../docs/VIEWER.md`](../docs/VIEWER.md) §2.1):

```
python site.py site --jobs 8 --posters
python site.py site --resume --serve 8000
```

To put that somewhere public, see [`../docs/DEPLOY.md`](../docs/DEPLOY.md) —
`deploy/` has a Dockerfile that bakes the site into `caddy:2-alpine`, a
compose file, standalone Caddy and nginx configs, and `precompress.py` for the
`.gz`/`.br` sidecars.

The site is laid out in the order the *game* plays the cutscenes, not
alphabetically, and its player pages chain: **Auto** plays the whole story from
`e001` to the last ending without stopping, and **Story mode** runs the game's
own chapter and ending machines, prompting you wherever the retail game would
have read a stage's result, a menu or a story flag. Both come out of the ELF
([`../docs/CUTSCENES.md`](../docs/CUTSCENES.md) §7):

```
python order.py                 # the story order, as an outline
python order.py --graph         # every branch point, every flag state
python order.py --playlist      # just the names, in order
python order.py --script        # every line of dialogue, in story order
python order.py --check         # the tables vs. what is on the disc
```

## Modules

| file | purpose |
|---|---|
| `afs.py` | `GAME.DAT` (CRI AFS) reader; filenames come from the TOC baked into the ELF at `0x0036A0F0` |
| `arc.py` | `RPS` archive reader (the `.ARC` container) |
| `smi.py` | `.SMI` model reader — skeleton, meshes, skinning, materials |
| `tm2.py` | `.TM2` texture reader (Sony TIM2) |
| `extract.py` | bulk converter |
| `preview.py` | software rasteriser for verification |
| `ssc.py` | `.SSC` compiled scene-script reader (cutscene bytecode + subtitles) |
| `sai.py` | `.SAI` skeletal animation reader |
| `cam.py` | `.CAM` camera-track reader |
| `sli.py` | `.sli` room light-set reader (the room's own lights, incl. the directional's aim) |
| `font.py` | the PS2 kernel font the game draws subtitles with, read out of the ELF |
| `adx.py` | CRI `.ADX` audio decoder (sample-exact vs ffmpeg) |
| `scene.py` | compiles a whole cutscene into one renderable timeline |
| `order.py` | the story order: the ELF's chapter, group and ending-flow tables |
| `pose.py` | poses a `.SMI` skeleton with a `.SAI` clip and skins it |
| `render.py` | numpy software render of one cutscene frame (the correctness gate) |
| `pdiag.py` | rasterise an exported page with the page's own shader — the gate for texture, blend and lighting bugs |
| `export.py` | exports a cutscene to a standalone HTML player |
| `site.py` | runs `export.py` over all 149 cutscenes into one deployable site + gallery |
| `player.html` | the player template (three.js + a GPU skinning shader) |
| `verify.py`, `test_player.js` | diff the player's maths against `pose.py`, and its subtitle layout against `font.py`, under node |
| `test_order.js` | run the player's playlist and story-mode blocks headless — prev/next, Auto, and whole playthroughs |
| `web/` | the same formats in the browser, reading the visitor's own ISO — see [`../docs/BROWSER.md`](../docs/BROWSER.md) |
| `gsstate.py` | decode the GS register state from a savestate's EE memory dump |
| `vudis.py` | VU0/VU1 microcode disassembler |
| `gsdump.js`, `pinefast.js` | live GS scan over PINE (batched; the bundled client is 1 byte/round-trip) |

## What's on the disc

3773 files. Inside the 2111 `RPS` archives: **3328 `.smi` models**
(4.9M vertices, 2.98M triangles) and **7668 `.tm2` textures**. All 2111
archives and all 3328 models parse without error.

`.ssc` scene scripts are decoded (all 5512 on the disc parse; see
[`../docs/CUTSCENES.md`](../docs/CUTSCENES.md)), and so are `.sai` animation
(18818/18818), `.cam` cameras (268/268) and `.adx` audio -- see
[`../docs/VIEWER.md`](../docs/VIEWER.md), which also documents the standalone
cutscene player built on top of them.

Other extensions not yet decoded: `.slp` (lip-sync — animation, by far the
biggest payload at 545 MB), `.ssc`, `.col` (collision), `.cam`, `.swd`/`.sed`
(sound), `.ckf`, `.nvm`.

## Formats

### `RPS` archive (`.ARC`)

```
0x00 u32   'RPS\0'
0x04 u32   entry count
0x08 u32   data_base (payload start; also the header size)
0x0c u32   total file size
0x10 u32   payload size
0x18       entry[], stride 0x14:
             u32 size, u32 size_aligned,
             u32 name_off (absolute), u32 data_off (relative to data_base),
             u32 unused
```

### `.SMI` model

Magic is `0x20030818` — a build-date stamp, not an acronym, and **it is not
unique to `.SMI`**: the `.SAI` animation files carry the same magic. Tell them
apart by `+0x08`, which is `0x10` for a model and `0x2c` for an animation.
The game itself never checks the magic at all — the value appears nowhere in
the ELF, as neither an immediate nor a stored literal.

```
0x00 u32  magic 0x20030818
0x04 u32  file size
0x10 u8   node (bone) count
0x12 u8   mesh count
0x14 u32  -> node array (always 0x20)
0x18 u32  -> mesh descriptor array
0x1c u32  -> material array
```

**Node**, stride `0x70`: a 4×4 row-major local matrix (translation in row 3,
so `v' = v * M`), a `s16` parent index at `+0x40` (−1 = root), and a 32-byte
name at `+0x50`. Names are romanised Japanese — `koshi` (waist), `momo`
(thigh), `hiza` (knee), `ashi` (foot), `mune` (chest), `atama` (head).
World matrices need accumulating down the parent chain.

**Material**, stride `0x5c`: two back-to-back NUL-terminated strings at `+0x00`
(texture base name, then its authoring extension `bmp` — shipped as
`<name>.tm2`), and diffuse RGBA at `+0x54`. An empty name means untextured.

The `u16` at `+0x42` is the GS render state, and three of its bits matter:

| bit | meaning |
|---|---|
| `0x0005` | the material goes through the ALPHA blend unit |
| `0x0100` | that blend is **additive** (`Cs*As>>7 + Cd`), not the lerp |
| `0x0060` | arms the alpha test (`ATE=1 ATST=GEQUAL AREF=120`) |

The alpha-test bits are the ones worth not assuming, because several textures
carry an *unrelated image* in their alpha channel — the plaza's grass ground is
92% alpha-zero, and what sits in its alpha is a strip of grass-blade
silhouettes for a different material on the same page. Testing everything
against alpha deletes the lawn. Derivation and evidence are in
[`../docs/PS2SHADER.md`](../docs/PS2SHADER.md) §4.1.

**Mesh descriptor**, stride `0x2c`:

```
+0x00 u32 -> position stream
+0x04 u32 -> normal   stream
+0x08 u32 -> colour   stream   u8[4] RGBA, stride 4
+0x0c u32 -> uv       stream   float2,     stride 8
+0x10 u32 -> (unused by every retail model)
+0x14 u32 -> flag     stream   s16[4],     stride 8
+0x18 u8[12]  bone palette, indices into the node array (0xff = unused)
+0x24 u8      material index   (+0x26 is a render flag, 23 or 55)
+0x28 u16     vertex count
+0x2a u16     base node — the node a mesh with an EMPTY palette rides
```

Note `+0x28` is a **u16**, not a u32 — reading it as 32 bits works only while
the following field happens to be zero.

A mesh with an empty palette is **rigid**: it has no meaningful per-vertex bone
index and hangs off the single node at `+0x2a`. That field is never
`>= n_node` across all 22496 meshes on the disc, and it is non-zero in **2521
models** — every `buki_obj` weapon a character holds, and props like the plaza
door `rp03d0`, whose whole animation is one hinge node. Defaulting it to 0
pins those meshes to the model root, which puts the queen's sceptre at her feet
and hangs the door unhinged across its own doorway.

**Skinning.** The position stream's stride is `16 * influences` and the normal
stream's is `8 * influences`, where influences is 1 or 2. Each vertex is
stored once per influencing bone, **in that bone's local space**, as a
`float4` whose `w` is the blend weight (weights sum to 1). Normals are
`s16[4]` at 1/4096.

Both streams are stored **already scaled by their blend weight**, the way VU1
consumes them, so blending is a plain sum — applying the weight again squares
it and shrinks every multi-bone vertex:

```
P = Σ ( p_k.xyz * Rot[bone_k]  +  p_k.w * Trans[bone_k] )
N = Σ ( n_k     * Rot[bone_k] )
```

The position is a homogeneous `float4`, so the matrix multiply scales the
translation row by `w` on its own. A normal is a direction, so it carries the
weight outright: paired normals in `c01f_b_h.smi` have magnitudes like 0.300
and 0.700, summing to exactly 1. Getting this wrong is invisible on
single-influence meshes (where `w` is 1) and shows up only at joints — necks,
jaws and shoulders come out shrunken and mis-shaded.

Bone indices live in the flag stream, as palette indices scaled by 4:

```
s16[4] = (?, ?, idx1, idx0)
  idx0 & 0x7fff -> palette index * 4, influence 0
  idx1          -> palette index * 4, influence 1
  idx0 & 0x8000 -> PS2 ADC bit
```

**Geometry** is one triangle strip per mesh with no index buffer. A triangle
`(i-2, i-1, i)` is emitted for every vertex whose ADC bit is clear, winding
alternating with parity; strips restart by duplicating vertices with ADC set.

### `.TM2` texture

Stock Sony TIM2 — `'TIM2'`, u8 version, u8 format, u16 picture count, then
0x30-byte picture headers. On this disc: 5030 are 8bpp indexed, 2509 are 4bpp,
129 carry no image payload. Two PS2 details matter:

* alpha is 0..128 (`0x80` = opaque) and must be rescaled to 0..255;
* a 256-entry CSM1 CLUT is stored swizzled — within each block of 32 entries,
  entries 8..15 and 16..23 swap.

## Tests

```
node tools/web/test_all.js              # everything the disc allows
node tools/web/test_all.js --no-disc    # only what CI can run
```

390 checks with a disc present, 114 without. Nothing here can be *built*
without the disc, and most suites are parity diffs against the Python over
real game data, so they skip themselves (exit 2) when there is no image. The
three that do not need one are the ones that have caught shipped bugs: module
loading under a browser's shared global scope, the GS shaders in
`web/gs.js` still matching `player.html`, and `web/pick.html`'s
initialisation order. `.forgejo/workflows/ci.yml` runs those.

## Verification

The format was cracked against `DATA/COMMON/DEBUG.ARC`, which ships
`cone.smi`, `sphere.smi` and `cylinder.smi` — known shapes that pin the
decode down exactly:

* cone → 24 triangles (12 side + 12 base), apex at the origin, radius-10 base
* sphere → bbox exactly ±10 on all three axes, vertex radius 9.895–10.105
* cylinder → unit radius, Y spanning 0→1

For skinning, `dummy_model.smi` and the retail character `c01f_a.smi` are
independent models that resolve to near-identical humanoid T-pose bounding
boxes (W≈14.4, H≈15.4, D≈3) with feet at Y=0.

### Verified against the running game

Checked live in PCSX2 (DebugServer) against models resident in EE RAM while a
character was on screen, and against the retail ELF in Ghidra:

* **Node stride `0x70` and material stride `0x5c`** — a resident model with 44
  nodes puts its material array at `0x20 + 44*0x70 = 0x1360`, exactly the
  pointer stored at `+0x1c`; the next 552 bytes are exactly 6 × `0x5c`. A
  24-node model lands on `0xAA0` with exactly one material.
* **Mesh stride `0x2c`, u16 vertex count, and the influence-scaled position
  stride** — all five descriptors of a resident `c30m_t_k.smi` chain
  pointer-to-pointer and terminate exactly on the file size, with per-mesh
  position strides of 32/16/16/32/16 (2 and 1 influences). The last
  descriptor's `+0x28` dword is `0x00170090`: read as u32 that is 1,507,472
  vertices, read as u16 it is 144 and the chain closes exactly.
* **Byte-exactness** — 128 bytes of live vertex data at file offset `0xbe0`
  match the extracted `c30m_t_k.smi` byte for byte.
* **`_tex.arc` convention** — `FUN_00177370` in the ELF does `strrchr(name,
  '.')`, truncates, then `strcat`s the string at `0x0042dee8` (`"_tex.arc"`),
  which is exactly the sibling-archive lookup `extract.py` performs. The same
  routine uses `"_se.arc"` for audio.
* The material's `bmp` extension really is authoring-side only: the string
  `bmp` does not occur anywhere in the ELF.

The runtime rewrites the header's file-relative offsets into absolute pointers
in place, so a model that has been prepared for drawing will show RAM
addresses where a freshly loaded copy still holds small offsets.
