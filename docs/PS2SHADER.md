# The PS2 render pipeline in Trapt, and its three.js reimplementation

The PlayStation 2 has **no programmable fragment stage**. What people call "the
PS2 shader" is two separate things:

* **VU1 microcode** — the vertex stage. Transform, light, clip, and build the
  GIF packet. Genuinely programmable.
* **GS register state** — the pixel stage. Entirely fixed function: a texture
  function, an alpha test, a blend equation, a depth test.

So reproducing the look means recovering the GS state exactly and the VU1
lighting closely. Both are below, followed by what the three.js material does
with them.

Everything here was read out of a **PCSX2 savestate taken mid-cutscene**
(`e001` at frame ~7280), not inferred. A savestate is a zip containing
`eeMemory.bin` (32 MB of EE RAM), `vu1MicroMem.bin` (the resident microcode),
`GS.bin` and a `Screenshot.png` reference frame — which makes it a far better
instrument than poking the emulator over IPC, and it costs nothing to re-read.

```sh
python tools/gsstate.py eeMemory.bin        # decode the display list
python tools/vudis.py  vu1MicroMem.bin      # disassemble the microcode
```

---

## 1. Recovering the state

The EE sets GS registers by writing **PACKED GIFtags in A+D mode** — `NREG=1`,
`REGS=0xE` — each followed by `(u64 value, u64 register address)` pairs. That
tag is a 12-byte signature (`u32[1]=0x10000000, u32[2]=0x0000000E, u32[3]=0`),
so scanning a RAM dump for it recovers every state the frame used.

In `e001`'s frame: **2482 A+D packets, 306 distinct register values.**

Only one such packet exists statically in the ELF (a lone `TEXFLUSH`) — all
real state is built at runtime, which is why this has to come from a dump.

---

## 2. The GS state, as configured

### 2.1 Texture stage — `TEX0`

```
TFX = MODULATE      TCC = RGBA      on 100% of textures
```

`MODULATE` on the GS is

```
C = (Ct * Cv) >> 7        A = (At * Av) >> 7
```

Both operands are 8-bit and **`0x80` is 1.0**, not `0xFF`. A vertex colour of
128 is neutral; 255 is a 2x brightener. This one convention explains several
things at once, and getting it wrong scales the whole image by 0.5.

Texture formats are all CLUT: `PSMT8` or `PSMT4` with `PSMCT32` palettes.
Sizes run 16x16 to 256x256.

### 2.2 Sampler — `TEX1`, `CLAMP`, `TEXA`

| | |
|---|---|
| `MMAG=LINEAR MMIN=LINEAR` | 681 of 768 samplers — bilinear |
| `MXL = 0` | **no mipmaps at all** |
| `WMS/WMT` | `REPEAT` 490x, `CLAMP` 278x |
| `TEXA` | `TA0 = TA1 = 128`, `AEM = 0` |

No mipmapping is not an oversight to "fix" — the texture shimmer it produces is
a defining property of the image.

### 2.3 Alpha and depth test — `TEST`

Two configurations dominate, and together they are the game's entire
transparency strategy:

```
opaque       ATE=1 ATST=GEQUAL AREF=120 AFAIL=KEEP     ZTE=1 ZTST=GEQUAL   (x134)
translucent  ATE=1 ATST=NEVER  AREF=0   AFAIL=FB_ONLY  ZTE=1 ZTST=GEQUAL   (x128)
```

* **Opaque**: keep fragments with `A >= 120` of 128 (**0.9375**), discard the
  rest. Writes depth.
* **Translucent**: the alpha test *never* passes, but `AFAIL=FB_ONLY` means a
  failing fragment still updates the framebuffer — it just never writes Z.

That is the trick. Rather than sorting, translucent surfaces are drawn with
colour writes and no depth writes, so they never occlude anything. A third
variant (`GEQUAL AREF=64`, 63x) is a coarser 0.5 cutout.

`ZTST=GEQUAL` throughout: the GS uses **reverse Z**, larger is nearer.

### 2.4 Blend equation — `ALPHA`

The GS computes `(A - B) * C >> 7 + D`:

| value | equation | meaning | n |
|---|---|---|---|
| `0x44` | `(Cs-Cd)*As>>7 + Cd` | standard lerp | 337 |
| `0x48` | `(Cs-0)*As>>7 + Cd` | additive, alpha-scaled | 59 |
| `0x64` | `(Cs-Cd)*FIX>>7 + Cd`, `FIX=64` | constant 50% | 2 |
| `0x42` | `(0-Cs)*As>>7 + Cd` | subtractive | 1 |

### 2.5 Framebuffer

| | |
|---|---|
| `FRAME_1` | `FBW = 512`, `PSMCT32`, `FBMSK = 0` |
| `SCISSOR_1` | `X = 0..511`, `Y = 0..223` |
| `ZBUF_1` | `PSMZ24`, `ZMSK = 0` |
| `COLCLAMP` | 1 — clamp to 0..255, do not wrap |
| `DTHE` | **0 — dithering off** |
| `FBA_1` | 1 (342x) — force the framebuffer alpha MSB on write |
| `PABE` | 0 |
| `FOGCOL` | `(28, 28, 28)` |

**The render target is 512x224**, scaled to a 4:3 screen by the video
hardware. That is the single most recognisable property of the image and no
amount of shader work substitutes for it.

`FOGCOL = (28,28,28)` is `28/255 = 0.11`, which is exactly what the scene
script's `0xC7` fog opcode asks for — an independent cross-check that the
script-level and register-level readings agree.

---

## 3. The vertex stage

### 3.1 The microcode bank

`vu1MicroMem.bin` holds **28 resident microprograms**, split by the `[E]` bit
that terminates each one. In the ELF the bank sits at **`0x00343000`–
`0x00347E88`** as 19 programs of 80–160 instructions.

The shapes are legible from an instruction histogram alone:

| range | count | character |
|---|---|---|
| `0x0a8`–`0x295` | ~20 programs, 27–36 instr | per-vertex kernels, one per vertex format (`MULAx`, `ITOF0/12`, a single `IBNE` loop) |
| `0x2be`–`0x4ca` | 525 instr | clipping / triangle setup (`CLIP` x4, 8 branches) |
| `0x4cb`–`0x65b` | 401 instr | ditto, heavier (`CLIP` x7, `MULAx` x28) |

`tools/vudis.py` disassembles them. Two encoding details cost real time and are
worth writing down:

* Upper opcodes `0x3C`–`0x3F` escape to **four** separate sub-tables selected by
  `op & 3` and indexed by bits 10–6. Merging them into one table decodes the
  standard matrix multiply as `SUBAz`/`ADDAi` nonsense.
* The lower `LowerOP` escape (`code>>25 == 0x40`) reaches its sub-tables the
  same way. `MOVE` with an empty destination mask is how the assembler spells
  `nop`, which is why `0x8000033C` appears 353 times.

Decoded, program 0 is a textbook 4x4 concatenation:

```
MULAx  ACC.xyzw, vf28, vf26x     | LQ  vf16, 1(vi00)
MADDAy ACC.xyzw, vf29, vf26y     | LQ  vf17, 2(vi00)
MADDAz ACC.xyzw, vf30, vf26z     | LQ  vf18, 3(vi00)
MADDw  vf19.xyzw, vf31, vf26w    | nop
```

### 3.2 The split that actually matters

Measured across every model `e001` draws:

| geometry | normals | vertex colours | shading |
|---|---|---|---|
| `rp03`, `rp11_rt`, `gf16_rt`, `rp03d0` | **0** | **all** | baked, unlit at runtime |
| all 9 characters and the knife | **all** | **0** | lit by VU1 from normals |

It is absolute — not a majority, a partition. Environment geometry carries no
normals whatsoever, so it *cannot* be lit at runtime; it ships pre-lit vertex
colours. `rp03.smi`'s 17120 vertices average **50** and peak at exactly
**128** — i.e. mean 0.4, max 1.0 in GS units.

This is why the real frame is so much darker than a dynamically lit render, and
lighting the room was the single largest error in the viewer.

---

## 4. What the three.js material does

`tools/player.html` carries one `RawShaderMaterial` implementing the above.

```glsl
#define GS_ONE 1.9921875              // 255/128: byte-normalised -> GS units

vec4 base = diffuse;
if (hasMap > 0.5) base = texture2D(map, vUv);

// TEST: opaque discards below AREF/128; blended never discards, and gets
// depthWrite:false on the JS side to stand in for AFAIL=FB_ONLY
if (blendOn < 0.5 && base.a < alphaRef) discard;

vec3 Cv = (lit > 0.5)
    ? (ambient + dirColour * max(dot(n, dirDir), 0.0)
       + point(...) + point(...)) * exposure
    : vC.rgb * GS_ONE;                // baked, already in GS units

vec3 col = base.rgb * Cv * tint;      // TEX0 MODULATE
col = clamp(col, 0.0, 1.0);           // COLCLAMP = 1
```

and on the JS side, per material:

```js
transparent: blend,
depthWrite: !blend,                   // ATST=NEVER + AFAIL=FB_ONLY
blending:   blend ? CustomBlending : NoBlending,
blendSrc:   SrcAlphaFactor,           // ALPHA_1 = (Cs-Cd)*As>>7 + Cd
blendDst:   OneMinusSrcAlphaFactor,
```

The blend/opaque choice comes from the `.SMI` material word at `+0x42`. That
mapping was established by correlating the flag against what its texture
actually contains, over every material in the cutscene and room archives:

| `+0x42` | n | texels α=0 | 0<α<250 | α≥250 |
|---|---|---|---|---|
| `0x0000` | 56 | 4.4% | 3.2% | **92.4%** |
| `0x0040` | 33 | 3.3% | 3.2% | **93.5%** |
| `0x0004` | 13 | 10.8% | **14.4%** | 74.7% |
| `0x4244` | 10 | 19.0% | **40.1%** | 41.0% |
| `0x4241` | 4 | 0.0% | **100.0%** | 0.0% |

Bit `0x0004` is alpha blend and `0x0001` marks fully-translucent materials —
`0x4241` is 100% partial alpha and 0% opaque. The player treats
`+0x42 & 0x0005` as blended.

### 4.1 What the material word actually says

`.SMI` material `+0x42` carries more than a blend flag, and three of its bits
had to be separated before the frame matched. Counted over the 148 materials
`e001` draws:

| bit | n | meaning |
|---|---|---|
| `0x0005` | 29 | goes through the ALPHA blend unit |
| `0x0100` | 4 | that blend is **additive**, `Cs*As>>7 + Cd`, not the lerp |
| `0x0060` | 49 | arms the alpha test, `ATE=1 ATST=GEQUAL AREF=120` |

**`0x0100` is additive.** All four materials carrying it are blended -- 14% of
the blends, against the 59-of-396 (15%) additive share counted in the frame's
own GIF packets. The visible proof is `rp03` material 14: `0x4304`, vertex
colour `(0,0,0)` over a 66%-opaque texture. Lerped, it paints the plaza
doorway's whole surround solid black; added, it contributes nothing, which is
what the hardware shows.

**`0x0020|0x0040` arms the alpha test, and most materials do not.** This one is
easy to get backwards because "alpha test everything" looks reasonable. It is
not, because several textures carry an *unrelated image* in their alpha
channel. `rp03_17` is the plaza's grass ground: 92% of its texels are alpha 0,
and what sits in that alpha is a strip of grass-blade silhouettes belonging to
a different material on the same page. Cutting the ground against it deletes
the lawn. Across `rp03` and `rp11` the split is exact -- every
near-transparent texture *without* the bits is one whose alpha is other data,
every one *with* them is a real foliage cutout. The cast needs `0x0020` as
well as `0x0040`: Allura's fringe is `0x0020` and turns into flat slabs if only
`0x0040` counts.

**Vertex alpha modulates before the test.** `A = (At * Av) >> 7`. `Av` is
`0x80` = 1.0 nearly everywhere, which is why it can be ignored for a long time
-- but `rp11`'s lamp glow ships `0x38` = 0.44 and is 2.3x too hot without it.

### 4.2 The camera basis

Screen-right is `cross(forward, up)`, not `cross(up, forward)`. The game keeps
its camera basis in EE RAM and it is unambiguous:

```
0x0081B6F0  eye                     0x0081B720  forward
0x0081B700  target                  0x0081B730  right   = cross(f, up)
0x0081B710  (-pitch, yaw, roll)     0x0081B740  down    = cross(f, right)
```

three.js builds this correctly on its own (`Matrix4.lookAt` uses
`x = up x (eye-target)`), so `player.html` was never wrong -- but `pdiag.py`
and `render.py` used the other form and had been rendering **every diagnostic
image mirrored left-to-right** since they were written. Nothing in the scene
is asymmetric enough to catch it by eye; the two women simply swap sides.

That same block is how you pin a savestate to an exact cutscene frame: match
the live eye against the `.CAM` track. The state used throughout this document
matches `e001` frame **7422** to 4.7e-6.

### 4.3 Anamorphic output

`fov` is vertical. The GS's 512x224 target is anamorphic -- the video hardware
stretches it to 4:3 -- so the horizontal focal length comes from the *display*
aspect, not from `W/H`:

```
fy = (H/2) / tan(fov/2)
fx = (W/2) / (tan(fov/2) * 4/3)
```

At 640x480 the two coincide, which is why a square-pixel projection went
unnoticed until the software gate was asked to render at the hardware's own
resolution.

### Bypassing it

The **PS2 / Modern** button turns the whole emulation off. It is one switch
because these have to move together — leaving any one of them on the hardware
setting makes the other three look wrong:

| | PS2 | Modern |
|---|---|---|
| colour | 8-bit gamma-space multiply, `COLCLAMP` | sRGB decode, linear lighting, ACES tonemap, re-encode |
| alpha test | `GEQUAL 120/128`, paired with the FB_ONLY depth rule | ordinary `0.5` cutout |
| sampler | bilinear, `MXL=0`, no mipmaps | trilinear + max anisotropy |
| resolution | 512x224 letterboxed to 4:3 | full canvas, native aspect |

The post pass still runs in Modern mode, against a canvas-sized target, so the
Look panel keeps working. With its defaults the pass is a straight copy, so
bypass really is bypass.

Worth being clear that neither is "correct": PS2 mode is what the hardware
did, Modern is what the same assets look like rendered the way anything else
would render them today. The gamma difference is the loudest part — the GS
multiplies sRGB texels directly and clips, which crushes highlights in a way
linear-space lighting does not reproduce.

### The output stage

The world renders into a **512x224** target, then a post pass puts it on a 4:3
letterboxed screen. That pass is also where the tweakables live, since the
"Look" panel is the point at which deviating from hardware becomes deliberate:

| control | default | what it is |
|---|---|---|
| Native 512x224 | on | render at GS resolution, or at canvas resolution (the PS2/Modern button drives this too) |
| Sharp upscale | 1 | ease within each texel — hard pixel edges, no stair-stepping |
| Colour bits | 8 | 8 is off; 5 approximates a `PSMCT16` framebuffer |
| GS dither | 0 | the real `DIMX` 4x4 matrix. Hardware ships `DTHE=0`, so this is off by default |
| Exposure / Contrast / Saturation / Warmth | neutral | grading |
| Vignette / Scanlines | 0 | off; scanlines are keyed to the 224 native lines |

Note on the request that prompted this: three.js compiles **GLSL ES 3.0**
(WebGL2) or WGSL. It cannot consume Vulkan SPIR-V, so these are written as
GLSL — the same code you would write for Vulkan minus the descriptor-set
decorations.

---

## 5. What is faithful, and what is not

**Faithful, from measurement:** texture function and its `>>7` convention;
alpha test threshold and the depth-write rule; blend equations; per-material
blend selection; bilinear with no mipmaps; `COLCLAMP`; 512x224 at 4:3; the
baked-vs-lit split; fog colour.

**Not faithful, and knowingly so:**

* **The VU1 lighting is not the game's.** The microcode is located, split and
  disassembling correctly, but the per-vertex kernels have not been traced to
  the point of recovering the exact lighting equation. The player uses the
  script's own light rig (`rt_amb`, `rt_inf`, `joyu`, `rt_poi`) evaluated
  per-fragment, which is a different and smoother thing than per-vertex VU1
  lighting.
* `rt_inf`'s **direction** is invented — nothing in the script records one.
* **Exposure** is a free parameter. The rig gives relative levels and never
  says how bright `0.35` is.
* Alpha blending is per-material, not per-primitive, and there is no sorting —
  the depth-write rule makes that mostly not matter, but it is not identical.
* `FBA`, `PABE` and the framebuffer alpha channel are ignored.

**Open:** the per-vertex VU1 kernels are the obvious next target — they would
replace the invented lighting with the real equation, and `tools/vudis.py` now
decodes them correctly enough to read.
