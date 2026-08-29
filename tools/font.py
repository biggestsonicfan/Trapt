"""The Trapt subtitle font, straight out of the ELF.

    python font.py                                 # the metrics, at a glance
    python font.py --sheet out/font.png            # the whole JIS X 0208 face
    python font.py --sheet out/latin.png --latin   # just what the script uses
    python font.py --text "%%SCSVJais%%RC\\nWait."  # one cue, as the GS lays it out
    python font.py --frame out/sub.png             # a 512x224 reference frame
    python font.py --check Screenshot.png          # diff against a PCSX2 capture

The game draws dialogue with the **PS2 kernel font**: a full JIS X 0208 face of
16x16 four-bit anti-aliased glyphs.  The whole 1,010,688-byte array is baked
into `SLUS_212.55` at `0x003885C0` -- nothing on the disc carries it, and
`DATA/FONT/FONT.BIN` is an 18-byte `FJF` stub that no code reads.

Every constant here came out of the executable or was measured against a PCSX2
savestate with a subtitle on screen (`e001` frame 7422 -- "Catalina / Well......
/ you don't recognize me as your mother?").  See `docs/FONT.md`.

Layout
------
`0x003885C0`  glyph array, 128 B per glyph, indexed by the **JIS linear index**
              `(row - 1) * 94 + (cell - 1)`; 16 rows of 8 bytes, low nibble
              first, each nibble a coverage level 0..15
`0x00388580`  the 16-entry RGBA32 CLUT the glyph indexes through
`0x00450620`  `{u32, u16 cell_w, u16 cell_h, float draw_w, float draw_h}` =
              16, 16, 24.0, 24.0 -- a 16x16 glyph draws into a 24x24 box
`0x004506E0`  8 records `{u16 sjis_lo, u16 sjis_hi, u32 widths, u32 count}`
              giving the per-glyph **advance in texels**; between them they
              cover 0x8140-0x818F, 0x824F-0x8258, 0x8260-0x8279, 0x8281-0x829A,
              which is exactly the character set the English script uses
"""
import os
import struct
import sys
from math import ceil

import afs

ELF = afs.ELF

GLYPHS_VA = 0x003885C0          # JIS-linear indexed, 128 B a glyph
CLUT_VA = 0x00388580            # 16 x RGBA32
DESC_VA = 0x00450620            # cell size + draw size
WIDTH_DIR_VA = 0x004506E0       # 8 x {u16 lo, u16 hi, u32 ptr, u32 count}
WIDTH_DIR_N = 8

ROWS, CELLS = 84, 94            # the JIS X 0208 planes present in the array
SLOT = 128                      # bytes per glyph
GLYPH_N = ROWS * CELLS

# The space the game lays subtitles out in, and the GS buffer it lands in.  A
# 640x448 virtual screen maps to the 512x224 framebuffer by (0.8, 0.5), which
# is what turns the 24x24 glyph box into the 19.2 x 12 quad the display list
# actually submits.
UI_W, UI_H = 640.0, 448.0
NATIVE_W, NATIVE_H = 512, 224
UI_TO_NATIVE = (NATIVE_W / UI_W, NATIVE_H / UI_H)

# `0x60 subtitle_show(text, x, y, "none")`: the handler at ELF 0x001C5950
# passes `(x, y - 8)` to the text object as the **centre of the first glyph
# box**, and sets the body colour to 0.9.  1927 of the 1935 cues on the disc
# use (46, 360), which puts that box at (34, 340) in UI space = (27.2, 170)
# native -- and the display list at `e001` 7422 has it at (27.1875, 170).
SUB_X, SUB_Y = 46.0, 360.0
SUB_ANCHOR_DY = -8
GS_ONE = 128.0                  # the GS treats 0x80 as 1.0

# `%%SC<XX>` is **set colour**, and the two-letter codes index the table at ELF
# `0x0020D7B0`: the classic sixteen HTML colour names, with `SV` carrying
# gray's 0.5 rather than silver's 0.75.  An unrecognised code falls through to
# the same path as `%%RC`, so it restores instead of setting.
MARKUP_COLOURS = {
    'WT': (1.0, 1.0, 1.0), 'SV': (0.5, 0.5, 0.5), 'BK': (0.0, 0.0, 0.0),
    'RD': (1.0, 0.0, 0.0), 'MR': (0.5, 0.0, 0.0), 'YL': (1.0, 1.0, 0.0),
    'OL': (0.5, 0.5, 0.0), 'LM': (0.0, 1.0, 0.0), 'GR': (0.0, 0.5, 0.0),
    'AQ': (0.0, 1.0, 1.0), 'TL': (0.0, 0.5, 0.5), 'BL': (0.0, 0.0, 1.0),
    'NV': (0.0, 0.0, 0.5), 'FC': (1.0, 0.0, 1.0), 'PP': (0.5, 0.0, 0.5),
}


def gs_colour(c):
    """A float colour as the GS ends up holding it, in units where 0x80 is 1.

    `0x0020D7B0` halves its table entry with a VU0 `vmulbc` before it becomes a
    vertex byte, so `%%SCSV`'s 0.5 reaches the wire as `0x40` -- which is
    exactly what the display list at `e001` 7422 carries for the speaker name,
    and 0.9 body likewise reaches it as `0x73`.
    """
    return tuple(round(v * 127.5) / GS_ONE for v in c)


BODY_COLOUR = gs_colour((0.9, 0.9, 0.9))   # ELF 0x001C5950 -> FUN_0020DBD0
SPEAKER_COLOUR = gs_colour(MARKUP_COLOURS['SV'])

# The literal two-character escapes the script writes for a line break and for
# the end of the string, and the two markup verbs.
MK_SET = '%%SC'
MK_RESTORE = '%%RC'
MK_BREAK = '\\n'
MK_END = '\\0'
MK_SPEAKER = MK_SET + 'SV'      # what a cutscene cue wraps a speaker name in


def _v2f(va):
    """ELF virtual address -> file offset (the segment loads at 0x100000+0x80)."""
    return va - 0x100000 + 0x80


def jis_linear(sjis):
    """Shift-JIS double byte -> the glyph array's index, or None."""
    s1, s2 = sjis >> 8, sjis & 0xFF
    if not (0x81 <= s1 <= 0x9F or 0xE0 <= s1 <= 0xEF) or s2 < 0x40 or s2 == 0x7F:
        return None
    if s2 < 0x9F:
        j1 = (s1 << 1) - (0xE1 if s1 < 0xA0 else 0x161)
        j2 = s2 - (0x1F if s2 < 0x7F else 0x20)
    else:
        j1 = (s1 << 1) - (0xE0 if s1 < 0xA0 else 0x160)
        j2 = s2 - 0x7E
    row, cell = j1 - 0x20, j2 - 0x20
    if not (1 <= row <= ROWS and 1 <= cell <= CELLS):
        return None
    return (row - 1) * CELLS + (cell - 1)


def sjis_at(lin):
    """JIS linear index -> Shift-JIS, the inverse of `jis_linear`."""
    j1, j2 = lin // CELLS + 1 + 0x20, lin % CELLS + 1 + 0x20
    s1 = ((j1 - 1) >> 1) + (0x71 if j1 < 0x5F else 0xB1)
    s2 = j2 + (0x1F if j1 & 1 else 0x7D)
    if (j1 & 1) and s2 >= 0x7F:
        s2 += 1
    return (s1 << 8) | s2


def widen(s):
    """ASCII -> the full-width forms the script actually stores.

    Every glyph in a cue is a full-width one, apostrophes included -- the
    script writes `don't` as `ｄｏｎ’ｔ` -- so this is what turns a line typed
    on the command line into something the face can be indexed with.  Markup
    (`%%SC<XX>`, `%%RC`, `\\n`, `\\0`) is left alone.
    """
    out, i = [], 0
    while i < len(s):
        if s.startswith(MK_SET, i) and i + 6 <= len(s):
            out.append(s[i:i + 6])
            i += 6
            continue
        for mk in (MK_RESTORE, MK_BREAK, MK_END):
            if s.startswith(mk, i):
                out.append(mk)
                i += len(mk)
                break
        else:
            c = s[i]
            i += 1
            if c == ' ':
                out.append('　')
            elif c == "'":
                out.append('’')
            elif c == '"':
                out.append('”')
            elif 0x21 <= ord(c) <= 0x7E:
                out.append(chr(0xFF01 + ord(c) - 0x21))
            else:
                out.append(c)
    return ''.join(out)


def sjis_of(ch):
    """One character -> its Shift-JIS code, or None if it is not encodable."""
    try:
        b = ch.encode('cp932')
    except UnicodeEncodeError:
        return None
    return (b[0] << 8) | b[1] if len(b) == 2 else b[0]


class Font:
    """The face as the game holds it: glyph bitmaps, a CLUT and advances."""

    def __init__(self, elf_path=ELF):
        self.elf = open(elf_path, 'rb').read()
        _, cw, ch, dw, dh = struct.unpack_from('<IHHff', self.elf, _v2f(DESC_VA))
        self.cell = (cw, ch)                 # 16 x 16 texels
        self.box = (dw, dh)                  # drawn into 24 x 24 UI units
        o = _v2f(CLUT_VA)
        self.clut = [tuple(self.elf[o + i * 4:o + i * 4 + 4]) for i in range(16)]
        self.widths = {}
        d = _v2f(WIDTH_DIR_VA)
        for i in range(WIDTH_DIR_N):
            lo, hi, ptr, n = struct.unpack_from('<HHII', self.elf, d + 12 * i)
            assert hi - lo + 1 == n, 'width record %d is not contiguous' % i
            p = _v2f(ptr)
            for k in range(n):
                self.widths[lo + k] = self.elf[p + k]

    # ------------------------------------------------------------- glyphs
    def indices(self, sjis):
        """A glyph as 256 coverage indices (row major), or None if absent."""
        lin = jis_linear(sjis)
        if lin is None:
            return None
        o = _v2f(GLYPHS_VA + lin * SLOT)
        out = bytearray(256)
        for y in range(16):
            for x in range(0, 16, 2):
                b = self.elf[o + y * 8 + x // 2]
                out[y * 16 + x] = b & 0xF
                out[y * 16 + x + 1] = b >> 4
        return bytes(out)

    def rgba(self, sjis):
        """A glyph as 16x16 RGBA8, the CLUT already applied (as the GS does)."""
        idx = self.indices(sjis)
        if idx is None:
            return None
        out = bytearray(1024)
        for i, v in enumerate(idx):
            out[i * 4:i * 4 + 4] = bytes(self.clut[v])
        return bytes(out)

    def advance(self, sjis):
        """Advance in texels.  Full width for anything the table skips."""
        return self.widths.get(sjis, self.cell[0])

    def has(self, sjis):
        return jis_linear(sjis) is not None

    # ------------------------------------------------------------- layout
    def runs(self, text, x=SUB_X, y=SUB_Y):
        """Lay one `0x60` payload out.

        Yields ``(sjis, ui_x, ui_y, (r, g, b))`` -- the top-left of each 24x24
        glyph box in the 640x448 UI space, and the colour the GS modulates that
        glyph by, in units where 1.0 is the GS's 0x80.  `text` is the cue
        exactly as the script stores it, markup and all.

        `%%SC<XX>` saves the current colour and sets a new one; `%%RC` puts the
        saved one back.  The object holds exactly **one** saved slot (ELF
        `0x0020D7B0` writes it to `+0x190`), so this is a single level of
        save/restore and not a stack.
        """
        bw, bh = self.box
        left = x - bw / 2.0
        top = y + SUB_ANCHOR_DY - bh / 2.0
        pen, line = left, 0
        colour = saved = BODY_COLOUR
        i, n = 0, len(text)
        while i < n:
            if text.startswith(MK_SET, i) and i + 6 <= n:
                new = MARKUP_COLOURS.get(text[i + 4:i + 6])
                # an unrecognised code takes the same path as `%%RC`
                colour, saved = (gs_colour(new), colour) if new else (saved, colour)
                i += 6
            elif text.startswith(MK_RESTORE, i):
                colour, saved = saved, colour
                i += len(MK_RESTORE)
            elif text.startswith(MK_BREAK, i):
                line, pen, i = line + 1, left, i + len(MK_BREAK)
            elif text.startswith(MK_END, i) or text[i] == '\0':
                break
            else:
                code = sjis_of(text[i])
                i += 1
                if code is None or not self.has(code):
                    continue
                yield code, pen, top + line * bh, colour
                pen += self.advance(code) * (bw / self.cell[0])

    # -------------------------------------------- an atlas for the player
    def atlas(self, codes, cols=16, pad=1):
        """Pack `codes` into one RGBA atlas.

        Each cell carries `pad` texels of **replicated** edge, which is what
        the GS's CLAMP gives a bilinear tap that runs off a 16x16 glyph.
        Returns ``(width, height, bytes, {sjis: slot})``.
        """
        cw, ch = self.cell
        sx, sy = cw + 2 * pad, ch + 2 * pad
        codes = [c for c in codes if self.has(c)]
        rows = (len(codes) + cols - 1) // cols or 1
        w, h = cols * sx, rows * sy
        buf = bytearray(w * h * 4)
        slots = {}
        for n, code in enumerate(codes):
            slots[code] = n
            g = self.rgba(code)
            gx, gy = (n % cols) * sx, (n // cols) * sy
            for y in range(sy):
                py = min(ch - 1, max(0, y - pad))
                for x in range(sx):
                    px = min(cw - 1, max(0, x - pad))
                    s = (py * cw + px) * 4
                    d = ((gy + y) * w + gx + x) * 4
                    buf[d:d + 4] = g[s:s + 4]
        return w, h, bytes(buf), slots


# ------------------------------------------------------- the reference draw

#: Where in a pixel the GS takes its sample.  **Zero** -- the rasteriser's
#: sample point is the pixel's own integer coordinate, not its centre, which
#: is why PS2 code adds its own 0.5s when it wants centre sampling.  Fitting
#: this against the reference capture is unambiguous: 0.0 lands the render on
#: the hardware's, 0.5 leaves a consistent half-pixel of drift.
GS_SAMPLE = 0.0


def _blend(dst, w, h, px, py, gw, gh, glyph, cw, ch, colour):
    """Draw one glyph box with the GS's own filtering and blend.

    `MMAG`/`MMIN` are both LINEAR for text, `TFX` is MODULATE with `TCC=RGBA`,
    and `ALPHA` is `(Cs - Cd) * As >> 7 + Cd`.  The GS filters the *palettised*
    colour, not a premultiplied one, which is what gives glyph edges their
    slightly dark fringe -- so this lerps RGB and A independently.
    """
    # pixel i is inside the quad when `lo <= i + GS_SAMPLE < hi`
    x0, x1 = max(0, ceil(px - GS_SAMPLE)), min(w, ceil(px + gw - GS_SAMPLE))
    y0, y1 = max(0, ceil(py - GS_SAMPLE)), min(h, ceil(py + gh - GS_SAMPLE))
    for sy in range(y0, y1):
        vy = max(0.0, min(ch - 1.0, (sy + GS_SAMPLE - py) / gh * ch - 0.5))
        j0 = int(vy)
        fj = vy - j0
        j1 = min(ch - 1, j0 + 1)
        for sx in range(x0, x1):
            ux = max(0.0, min(cw - 1.0, (sx + GS_SAMPLE - px) / gw * cw - 0.5))
            i0 = int(ux)
            fi = ux - i0
            i1 = min(cw - 1, i0 + 1)
            acc = [0.0, 0.0, 0.0, 0.0]
            for jj, wj in ((j0, 1.0 - fj), (j1, fj)):
                for ii, wi in ((i0, 1.0 - fi), (i1, fi)):
                    t = (jj * cw + ii) * 4
                    f = wi * wj
                    for k in range(4):
                        acc[k] += glyph[t + k] * f
            a = acc[3] / GS_ONE
            if a <= 0.0:
                continue
            o = (sy * w + sx) * 3
            for k in range(3):
                dst[o + k] = min(255.0,
                                 acc[k] * colour[k] * a + dst[o + k] * (1.0 - a))


def frame(font, text, x=SUB_X, y=SUB_Y, w=NATIVE_W, h=NATIVE_H):
    """Render one cue into a `w` x `h` RGB float buffer over black."""
    sx, sy = w / UI_W, h / UI_H
    gw, gh = font.box[0] * sx, font.box[1] * sy
    cw, ch = font.cell
    dst = [0.0] * (w * h * 3)
    for code, ux, uy, colour in font.runs(text, x, y):
        _blend(dst, w, h, ux * sx, uy * sy, gw, gh, font.rgba(code), cw, ch, colour)
    return dst


# ------------------------------------------------------------------ the CLI

def _png(path, w, h, rgba):
    import zlib
    raw = b''.join(b'\0' + bytes(rgba[y * w * 4:(y + 1) * w * 4]) for y in range(h))

    def chunk(tag, data):
        c = tag + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c))

    blob = (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)
    with open(path, 'wb') as f:
        f.write(blob)
    return len(blob)


def _load_png(path):
    """Minimal 8-bit PNG reader -- enough for a PCSX2 screenshot."""
    import zlib
    d = open(path, 'rb').read()
    assert d[:8] == b'\x89PNG\r\n\x1a\n', 'not a PNG'
    o, idat, hdr = 8, [], None
    while o + 8 <= len(d):
        n, tag = struct.unpack_from('>I4s', d, o)
        if tag == b'IHDR':
            hdr = struct.unpack_from('>IIBBBBB', d, o + 8)
        elif tag == b'IDAT':
            idat.append(d[o + 8:o + 8 + n])
        o += 12 + n
    w, h, depth, ctype = hdr[0], hdr[1], hdr[2], hdr[3]
    assert depth == 8 and ctype in (2, 6), 'unsupported PNG'
    bpp = 3 if ctype == 2 else 4
    raw = zlib.decompress(b''.join(idat))
    out = bytearray(w * h * 3)
    prev = bytearray(w * bpp)
    p = 0
    for y in range(h):
        f = raw[p]
        line = bytearray(raw[p + 1:p + 1 + w * bpp])
        p += 1 + w * bpp
        for i in range(w * bpp):
            a = line[i - bpp] if i >= bpp else 0
            b = prev[i]
            c = prev[i - bpp] if i >= bpp else 0
            if f == 1:
                line[i] = (line[i] + a) & 0xFF
            elif f == 2:
                line[i] = (line[i] + b) & 0xFF
            elif f == 3:
                line[i] = (line[i] + (a + b) // 2) & 0xFF
            elif f == 4:
                q = a + b - c
                pa, pb, pc = abs(q - a), abs(q - b), abs(q - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        for x in range(w):
            out[(y * w + x) * 3:(y * w + x) * 3 + 3] = line[x * bpp:x * bpp + 3]
        prev = line
    return w, h, out


def _rgba(px, w, h):
    """An RGB float buffer -> opaque RGBA8."""
    out = bytearray(w * h * 4)
    for i in range(w * h):
        for k in range(3):
            out[i * 4 + k] = int(min(255.0, max(0.0, px[i * 3 + k])) + 0.5)
        out[i * 4 + 3] = 255
    return bytes(out)


#: Every character the width table covers -- the whole English character set.
LATIN = (list(range(0x8140, 0x8190)) + list(range(0x824F, 0x8259))
         + list(range(0x8260, 0x827A)) + list(range(0x8281, 0x829B)))

#: The cue the reference savestate has on screen at `e001` frame 7422.
REF_CUE = widen(r"%%SCSVCatalina%%RC"
                r"\nWell......"
                r"\nyou don't recognize me as your mother?\0")


def _upscale(px, iw, ih, ow, oh):
    """Bilinear, **origin aligned** -- how the capture got to its own size.

    PCSX2 maps output pixel `o` to source `o * in / out` rather than centring
    the two grids, and at these ratios that is a real 0.1 px horizontal and
    0.27 px vertical shift.  Fitting it either way against the reference
    capture is decisive: origin-aligned lands at the resampling noise floor,
    centre-aligned leaves exactly the predicted drift.
    """
    out = [0.0] * (ow * oh * 3)
    for oy in range(oh):
        sy = min(ih - 1.0, max(0.0, oy * ih / float(oh)))
        j0 = int(sy)
        fj = sy - j0
        j1 = min(ih - 1, j0 + 1)
        for ox in range(ow):
            sx = min(iw - 1.0, max(0.0, ox * iw / float(ow)))
            i0 = int(sx)
            fi = sx - i0
            i1 = min(iw - 1, i0 + 1)
            d = (oy * ow + ox) * 3
            for k in range(3):
                a = px[(j0 * iw + i0) * 3 + k] * (1 - fi) + px[(j0 * iw + i1) * 3 + k] * fi
                b = px[(j1 * iw + i0) * 3 + k] * (1 - fi) + px[(j1 * iw + i1) * 3 + k] * fi
                out[d + k] = a * (1 - fj) + b * fj
    return out


def check(font, shot_path, text=REF_CUE, x=SUB_X, y=SUB_Y, dump=None):
    """Diff a rendered cue against a PCSX2 capture of the same frame.

    The cue is rendered at the GS's own 512x224 and then stretched to the
    capture's size, because that is the order the capture went through and the
    two are not interchangeable.  Only the subtitle band is compared -- the
    `0x57` letterbox guarantees it is black behind the text.

    Per-pixel error still carries whatever resampler the emulator used, so the
    alignment gate is the **ink centroid** of each line, which any symmetric
    resample preserves: those come back in native pixels and should be zero.
    """
    sw, sh, shot = _load_png(shot_path)
    nat = frame(font, text, x, y)
    px = _upscale(nat, NATIVE_W, NATIVE_H, sw, sh)
    kx, ky = sw / float(NATIVE_W), sh / float(NATIVE_H)
    # Only the rows the cue actually puts glyphs on.  A band a cue does not
    # use catches whatever the resample smears across its edge and reports it
    # as an enormous drift; and profiling is inset by a pixel for the same
    # reason -- a glyph's ink never reaches its box edge, but the line above's
    # descenders land within a resample tap of it.
    rows = sorted({uy for _, _, uy, _ in font.runs(text, x, y)})
    lines = [((uy + 1.0) * UI_TO_NATIVE[1],
              (uy + font.box[1] - 1.0) * UI_TO_NATIVE[1]) for uy in rows]
    # The compared band is the glyph boxes themselves and nothing above them:
    # the `0x57` letterbox only guarantees black from the first box down, and
    # a row of scene above it would swamp the diff.
    y0 = max(0, int(rows[0] * UI_TO_NATIVE[1] * ky))
    y1 = min(sh, int((rows[-1] + font.box[1]) * UI_TO_NATIVE[1] * ky))

    n = err = 0
    worst = (0.0, 0, 0)
    for sy in range(y0, y1):
        for sx in range(sw):
            i = (sy * sw + sx) * 3
            a, b = px[i], shot[i]
            if a < 0.5 and b < 3:
                continue
            n += 1
            e = abs(a - b)
            err += e
            if e > worst[0]:
                worst = (e, sx, sy)

    def profile(buf, ny0, ny1):
        """Ink total, centroid and lit extent of one line, in native pixels."""
        wx = wy = tot = 0.0
        lo, hi = None, None
        for sy in range(max(0, int(ny0 * ky)), min(sh, int(ny1 * ky))):
            for sx in range(sw):
                v = buf[(sy * sw + sx) * 3]
                if v < 3:
                    continue
                wx += (sx + 0.5) / kx * v
                wy += (sy + 0.5) / ky * v
                tot += v
                lo = sx if lo is None else min(lo, sx)
                hi = sx if hi is None else max(hi, sx)
        if not tot:
            return None
        return {'x': wx / tot, 'y': wy / tot, 'ink': tot,
                'lo': lo / kx, 'hi': (hi + 1) / kx}

    lines_out = []
    for ny0, ny1 in lines:
        a, b = profile(px, ny0, ny1), profile(shot, ny0, ny1)
        if a is None or b is None:
            lines_out.append({'mismatch': (a['ink'] if a else 0,
                                           b['ink'] if b else 0)})
        else:
            lines_out.append({'dx': b['x'] - a['x'], 'dy': b['y'] - a['y'],
                              'ink': a['ink'] / b['ink'],
                              'dlo': b['lo'] - a['lo'], 'dhi': b['hi'] - a['hi']})
    if dump:
        _png(dump, sw, sh, _rgba(px, sw, sh))
    return {'pixels': n, 'mean': err / max(1, n), 'worst': worst,
            'band': (y0, y1), 'size': (sw, sh), 'lines': lines_out}


def _arg(a, flag, default=None):
    if flag not in a:
        return default
    i = a.index(flag)
    return a[i + 1] if len(a) > i + 1 and not a[i + 1].startswith('--') else default


def main():
    a = sys.argv[1:]
    font = Font()
    if '--sheet' in a:
        path = _arg(a, '--sheet', 'font.png')
        codes = LATIN if '--latin' in a else [sjis_at(i) for i in range(GLYPH_N)]
        codes = [c for c in codes if font.has(c)]
        w, h, buf, _ = font.atlas(codes, cols=int(_arg(a, '--cols', '94')), pad=0)
        print('%s  %dx%d  %d glyphs  %d bytes'
              % (path, w, h, len(codes), _png(path, w, h, buf)))
    elif '--text' in a:
        for code, ux, uy, c in font.runs(widen(_arg(a, '--text', ''))):
            ch = bytes((code >> 8, code & 0xFF)).decode('cp932', 'replace')
            print('%04x %s  ui(%7.2f,%6.1f)  native(%9.4f,%6.1f)  adv %2d  '
                  'rgb(%.2f,%.2f,%.2f)'
                  % ((code, ch, ux, uy, ux * UI_TO_NATIVE[0], uy * UI_TO_NATIVE[1],
                      font.advance(code)) + tuple(c)))
    elif '--frame' in a:
        path = _arg(a, '--frame', 'sub.png')
        w = int(_arg(a, '--width', str(NATIVE_W)))
        h = int(round(w * NATIVE_H / float(NATIVE_W)))
        px = frame(font, REF_CUE, w=w, h=h)
        print('%s  %dx%d  %d bytes' % (path, w, h, _png(path, w, h, _rgba(px, w, h))))
    elif '--check' in a:
        r = check(font, _arg(a, '--check'), dump=_arg(a, '--dump'))
        print('%dx%d capture, band y %d..%d, %d lit pixels'
              % (r['size'] + r['band'] + (r['pixels'],)))
        print('mean abs error %.2f / 255, worst %.0f at (%d, %d)'
              % ((r['mean'],) + r['worst']))
        for i, ln in enumerate(r['lines']):
            if ln is None:
                continue
            if 'mismatch' in ln:
                print('line %d MISMATCH: %.0f ink rendered, %.0f captured'
                      % ((i + 1,) + ln['mismatch']))
            else:
                print('line %d centroid (%+.3f, %+.3f) edges (%+.3f, %+.3f) '
                      'native px, ink x%.4f'
                      % (i + 1, ln['dx'], ln['dy'], ln['dlo'], ln['dhi'], ln['ink']))
    else:
        print(__doc__)
        print('cell %dx%d texels drawn into %.1fx%.1f UI units'
              % (font.cell + font.box))
        print('%d advances over %d ranges' % (len(font.widths), WIDTH_DIR_N))
        print('CLUT ' + ' '.join('%02x%02x%02x/%02x' % c for c in font.clut))


if __name__ == '__main__':
    main()
