# The font Trapt draws its subtitles with

Every line of dialogue in the game is drawn from a **full JIS X 0208 face of
16x16 four-bit anti-aliased glyphs**, and the whole 1,010,688-byte array is
baked into `SLUS_212.55`. `tools/font.py` reads it out, and the exported page
lays subtitles out with it well enough that the glyph quads land on the same
12.4 fixed-point coordinates the hardware submits.

```sh
python tools/font.py                                 # the metrics, at a glance
python tools/font.py --sheet out/font.png            # all 7896 glyphs
python tools/font.py --sheet out/latin.png --latin   # just what the script uses
python tools/font.py --text "%%SCSVJais%%RC\nWait."  # one cue, laid out
python tools/font.py --frame out/sub.png             # a 512x224 reference frame
python tools/font.py --check Screenshot.png          # diff against a PCSX2 capture
```

In the player, **Subs** switches between this and the DOM subtitles. It follows
the **PS2 / Modern** button until you press it, after which it stays where you
put it; the two are independent, so the game's font over a modern render and
DOM text over the GS emulation are both available.

---

## 1. Finding it

`DATA/FONT/FONT.BIN` is a dead end: 18 bytes, `FJF\0` and five fields, and
**nothing in the executable loads it** — its TOC id, 1145, appears in no
immediate in the ELF. Nor is there a font anywhere else on the disc: no
archive member is named for one, and none of the 7668 `.TM2` is a glyph atlas.

The real thing turned up in a **PCSX2 savestate taken with a subtitle on
screen** (`e001` frame 7422 — *Catalina / Well...... / you don't recognize me
as your mother?*). Scanning the display list in EE RAM for GIF A+D packets,
one `TEX0` value dominates:

```
TEX0_1  x252  TBP0=0x39bb  TBW=128  PSM=PSMT4  16x16  TCC=RGBA  TFX=MODULATE
              CBP=0x39ba   CPSM=PSMCT32  CLD=1
```

252 draws of a **16x16 four-bit** texture through a 16-entry palette. Each is
preceded by a `BITBLTBUF`/`TRXPOS`/`TRXREG`/`TRXDIR` quad and an IMAGE-mode
GIFtag whose 8 qwords arrive by a DMA `ref` tag — and the addresses those tags
point at march through EE RAM in 128-byte steps. 128 bytes is exactly
16x16 at 4bpp.

Rendering those blocks as 16 rows of 8 bytes, low nibble first, gives the JIS
X 0208 symbol table in row order: `、。，．・：；？！` then `＋－±×÷＝≠＜＞≦≧∞`
then `∈∋⊆⊇⊂⊃∪∩` and so on. The array is in the ELF, at the same virtual
address the savestate has it — it is static data, not something built at boot.

The 30 distinct source addresses in that frame, read in draw order, spell
`C a t a l i n a` / `W e l l . . . . . .` / `y o u _ d o n ' t _ …`, which
pins the index formula without any guesswork.

## 2. Layout

| what | where | shape |
|---|---|---|
| glyphs | `0x003885C0` | 128 B each, 16 rows of 8 bytes, low nibble first, each nibble a coverage level 0..15 |
| CLUT | `0x00388580` | 16 x RGBA32 |
| descriptor | `0x00450620` | `{u32, u16 cell_w, u16 cell_h, float draw_w, float draw_h}` = 16, 16, 24.0, 24.0 |
| advances | `0x004506E0` | 8 x `{u16 sjis_lo, u16 sjis_hi, u32 widths, u32 count}` |

A glyph's slot is its **JIS linear index**, `(row - 1) * 94 + (cell - 1)`, so
Shift-JIS `0x8281` (`ａ`) is row 3 cell 65 = 252 and lives at
`0x003885C0 + 252 * 128`. Rows 1..84 are present — the whole standard, kanji
included — 7896 glyphs.

The **CLUT is an alpha ramp on white**, and its alpha tops out at `0x80`,
which is the GS's 1.0:

```
00 000000/00   01 e1e2e2/45   02 fcfcfc/04   03 ffffff/13
04 ffffff/23   05 ffffff/2d   06 ffffff/39   07 ffffff/4c
08 ffffff/59   09 ffffff/61   0a ffffff/67   0b ffffff/6d
0c ffffff/73   0d ffffff/79   0e ffffff/7d   0f ffffff/80
```

(Entry 1 is out of order — 0x45 where the ramp wants 0x0d. It is what the
game ships; index 1 is rare enough that it never shows.)

The **advance table is indexed by Shift-JIS, not by glyph slot**, through eight
range records. Between them they cover `0x8140`-`0x818F`, `0x824F`-`0x8258`,
`0x8260`-`0x8279` and `0x8281`-`0x829A` — punctuation, full-width digits and
full-width `A`-`Z`/`a`-`z`, which is **exactly the character set the English
script uses**. The face is proportional: `i` and `l` advance 6 texels, `r` 7,
`s`/`t`/`z` 8, most lowercase 9, `C` 10, `m`/`W` 12.

Nothing derives the advance from the bitmap. `n` inks columns 1..7 and
advances 9; `t` inks 1..7 and advances 8; `?` inks 1..8 and advances 9. It is
a table and it has to be read.

## 3. How a cue becomes pixels

`0x60 subtitle_show(text, x, y, "none")`. The handler at ELF `0x001C5950`:

* sets the font to the descriptor at `0x00450740` → `0x00450620`,
* sets the colour to **0.9** (`FUN_0020DBD0(0.9, 0.9, 0.9)`) — which reaches
  the wire as RGBAQ `0x73`, since the GS's 1.0 is 128,
* sets the size to **24.0** (`FUN_0020DEC0(0x41C00000)`),
* and positions the object at **`(x, y - 8)`**.

That position is the **centre of the first glyph box**. 1927 of the 1935 cues
on the disc pass `(46, 360)`, so the first box's top-left is `(34, 340)` in the
game's **640x448 UI space**, lines step by the 24.0 size, and the whole thing
scales into the GS's 512x224 framebuffer by `(0.8, 0.5)`:

```
box     24 x 24 UI      ->  19.2 x 12 native
advance w * 1.5 UI      ->  w * 1.2 native
line 1  (34, 340) UI    ->  (27.2, 170) native
```

The display list at frame 7422 puts the first quad at
`X=0x71B3 - XYOFFSET 0x7000 = 27.1875`, `Y = 170.0`, and each quad
`19.1875 x 12` — `19.2` truncated to the 1/16 the 12.4 format can hold.
**`font.py` reproduces all 56 vertex X values in that frame exactly**, which
is what settles the anchor rule, the advance table and the UI scale together.

### Markup

`%%SC<XX>` is **set colour** and `%%RC` is **restore colour**; a line break and
the terminator are the literal two-character sequences `\n` and `\0`. The verb
strings appear nowhere in the executable — the parser compares them as 16-bit
immediates, which is why grepping for them finds nothing — and the two-letter
codes index a table at `0x0020D7B0`:

| | | | |
|---|---|---|---|
| `WT` 1,1,1 | `SV` .5,.5,.5 | `BK` 0,0,0 | `RD` 1,0,0 |
| `MR` .5,0,0 | `YL` 1,1,0 | `OL` .5,.5,0 | `LM` 0,1,0 |
| `GR` 0,.5,0 | `AQ` 0,1,1 | `TL` 0,.5,.5 | `BL` 0,0,1 |
| `NV` 0,0,.5 | `FC` 1,0,1 | `PP` .5,0,.5 | |

Those are the classic sixteen HTML colour names, with `SV` carrying gray's 0.5
rather than silver's 0.75. The table entry is **halved by a VU0 `vmulbc`**
before it becomes a vertex byte, so `%%SCSV`'s 0.5 arrives as RGBAQ `0x40` —
exactly what the reference display list carries for the speaker name — and the
0.9 body arrives as `0x73` by the same route. An unrecognised code falls
through to the same path as `%%RC`, and the object keeps **one** saved colour
rather than a stack, so save/restore is single level.

Only three of the fifteen are ever used: `%%SCSV` grey on 9090 glyphs (the
cutscene speaker names), `%%SCTL` teal on 2378 (the in-game dialogue speaker
names, which `export.py` does not reach), and the 0.9 body on 77911.

The fragment stage is the GS's ordinary fixed function: `TFX=MODULATE` with
`TCC=RGBA` (`C = Ct * Cv >> 7`), `TEX1 MMAG=MMIN=LINEAR`, and the usual
`ALPHA = (Cs - Cd) * As >> 7 + Cd`. Two details matter:

* the GS **palettises a texel and then filters**, so filtering must happen on
  CLUT'd RGBA, not on coverage. Filtering coverage and palettising after
  loses the slightly dark fringe a glyph edge has, because the CLUT's
  transparent entry is black rather than white-with-zero-alpha.
* `TEST` is `ATE=1 ATST=NEVER AFAIL=FB_ONLY`: colour is written, Z never is.

## 4. Verification

Four independent gates, in the order they close:

**Layout against the hardware.** `tools/font.py`'s `runs()` vs the 56 glyph
quads recovered from the savestate's display list — **0.000000 px error** on
every vertex X, and line tops of exactly 170/182/194.

That first line top is one pixel below where the reference frame's lower black
band begins, which is not a coincidence and is not a subtitle backdrop: it is
the `0x57` letterbox, whose handler at ELF `0x001C6570` sets the bars to 50 and
110 UI units — 25 lines at the top and 55 from `y=169` down. The capture and
the executable agree exactly, so the band the raster gate compares in is the
same black the hardware draws on. See [`VIEWER.md`](VIEWER.md) §1.5.

**Raster against the capture, at five frames.** `python tools/font.py --check
Screenshot.png` renders the cue at 512x224, stretches it to the capture's size
the way PCSX2 does, and diffs the subtitle band. Driving the emulator forward
from the reference savestate and saving a state at arbitrary points gives more
ground truth than the one frame; each is pinned to a cutscene frame by matching
the live camera eye at EE `0x0081B6F0` against the `.CAM` track, to 5e-6.

| frame | speaker | lines | mean err | worst centroid | worst edge |
|---|---|---|---|---|---|
| 7422 | Catalina | 3 | 8.77 | (+0.39, -0.07) | 0.000 |
| 8198 | Allura | 2 | 8.94 | (-0.21, -0.07) | 0.000 |
| 9266 | Knight | 2 | 8.97 | (-0.38, -0.05) | 0.800 |
| 10288 | Knight | 3 | 8.91 | (-0.41, -0.05) | 0.000 |
| 11207 | Catalina | 4 | 8.98 | (-0.53, -0.03) | 0.800 |

Mean error is out of 255; drifts are native pixels. 8.8–9.0 is the resampling
noise floor — round-tripping the capture itself through 512x224 and back scores
8.9. Two measures survive resampling and are the real gate: the per-line **ink
centroid**, inside a tenth of a native pixel vertically and half a pixel
horizontally, and the **first and last lit column** of each line, which is
*exactly zero* on ten of the twelve lines and one capture pixel on the other
two. Line ink totals agree to 1.2%.

Getting there settled two conventions that are easy to get wrong and hard to
see:

* **The GS samples a pixel at its integer coordinate, not its centre.**
  Fitting `0.0` against `0.5` is not close: 16.8 vs 25.2 mean error. GL
  samples at the centre, so the player's quads carry a half-*target*-pixel
  nudge, which correctly fades to nothing at Modern resolutions.
* **PCSX2's screenshot upscale is origin-aligned**, mapping output pixel `o`
  to source `o * in / out`. At 512→640 and 224→480 that is a real 0.1 px and
  0.27 px shift, and assuming centre alignment leaves exactly that drift.
  This is a property of the capture, not of the game.

**The page against `font.py`.** `python tools/verify.py e001 7422` extracts the
`TRAPT SUBS` block verbatim out of `player.html`, runs every cue through it
under node, and diffs against `font.py`: **1941 glyph placements, worst error
5e-7** — the `toFixed(6)` in the harness. That holds at every frame it was run
at (twelve random ones across `e001` plus the five with hardware captures), and
so does the geometry gate beside it. And `tools/pdiag.py` ports the page's
overlay shader the same way `shade()` ports its fragment shader, so
`python tools/pdiag.py out/e001.html 7422 shot.png --size 640x480` draws a
whole frame with the subtitles on it. Rasterising the exported atlas and UVs
that way reproduces `font.py`'s own frame to **0.0**.

**Every cue on the disc.** All **1935** lay out — 89,379 glyph placements over
cues of one to four lines. 2.43% of those placements are kana or kanji with no
width record (the untranslated cues, §5). After the markup verbs, exactly 45
cues contain a character that resolves to no glyph: 44 whose text is the
literal ASCII placeholder `none`, and one — `rt_ige_c30m_v.ssc` — where a line
break was mistyped as a backslash followed by a *full-width* `ｎ`. The game
cannot render those either. One line, in `rt_iga_c10m_a.ssc`, is 521.6 px wide
and runs off the 512 px frame.

## 5. What is not done

* **No hardware capture before frame 7422.** The five compared frames span
  7422–11207 of `e001`'s 11891, because the only savestate that exists is at
  7422 and the cutscene can only be run forward from there. Writing the
  cutscene's frame counter (EE `0x0082B670` and `0x0082CEC4`, both of which
  hold it) to seek backwards does not work — it soft-resets the game.
* **`%%SCTL`'s teal is read out of the table, not measured.** It appears only
  in `DATA/SCRIPT` in-game dialogue, which no savestate covers, and which
  `export.py` does not export. `%%SCSV` is the one entry confirmed on the wire.
* **The eight cues that are not at `(46, 360)`** use `(60, 80..220)`; nothing
  has been checked against hardware for them, though the anchor rule is
  positional and should carry.
* **Untranslated Japanese cues have no advance.** Eleven cutscenes
  (`e404_03`, `e408_01`, `e409_*`, `e410_*`, `e419_*`) still carry kana and
  kanji, and those characters fall outside all eight width ranges — 2.43% of
  every glyph placement on the disc. They render from the same array — the
  glyphs are all there — but advance a full 16 texels, which is a reasonable
  guess and not a measurement. What the game itself does with them is unknown.
* **Nothing else that uses this font is wired up.** The intermission menu, the
  trap names and the HUD all draw from the same face; only cutscene subtitles
  are exported.
