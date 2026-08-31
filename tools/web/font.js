/**
 * The Trapt subtitle font, straight out of the ELF -- `tools/font.py` in the
 * browser.  See `docs/FONT.md`; every constant here came out of the
 * executable or was measured against a PCSX2 capture.
 *
 * The game ships **no font**: `DATA/FONT/FONT.BIN` is an 18-byte `FJF` stub
 * nothing reads.  Dialogue is drawn with the **PS2 kernel font**, a full
 * JIS X 0208 face of 16x16 four-bit glyphs baked into `SLUS_212.55` -- which
 * this page already has open, because `disc.js` keeps the ELF.
 *
 * The Japanese disc bakes in its own copy, and it is not the same bytes: the
 * kana and the level-1 kanji are pixel for pixel the US glyphs, but the US
 * build redrew the full-width Latin block, which is also why only it carries
 * a width directory.  Where there is none, every glyph advances by the cell.
 * Addresses below are the US ones; pass `disc.region.font` for the other.
 *
 *   0x003885C0  glyphs, 128 B each, at the JIS linear index
 *               `(row - 1) * 94 + (cell - 1)`; 16 rows of 8 bytes, low nibble
 *               first, each nibble a coverage level 0..15
 *   0x00388580  the 16-entry RGBA32 CLUT they index through
 *   0x00450620  `{u32, u16 cell_w, u16 cell_h, float draw_w, float draw_h}`
 *               = 16, 16, 24.0, 24.0: a 16x16 glyph draws into a 24x24 box
 *   0x004506E0  8 records `{u16 lo, u16 hi, u32 widths, u32 count}` giving the
 *               per-glyph advance in texels
 *
 * Layout happens in the game's 640x448 UI space and scales into the GS's
 * 512x224 by (0.8, 0.5), which is what turns a 24x24 box into the 19.2 x 12
 * quad the hardware display list actually submits.
 */
(function () {
'use strict';

const regionMod = (typeof require !== 'undefined') ? require('./region.js') : window.TraptRegion;

const ROWS = 84, CELLS = 94, SLOT = 128;
const UI_W = 640.0, UI_H = 448.0;
const NATIVE_W = 512, NATIVE_H = 224;

// `0x60 subtitle_show(text, x, y, "none")`: the handler at 0x001C5950 passes
// `(x, y - 8)` as the **centre of the first glyph box**.  1927 of the 1935
// cues on the disc use (46, 360).
const SUB_X = 46.0, SUB_Y = 360.0, SUB_ANCHOR_DY = -8;
const GS_ONE = 128.0;              // the GS treats 0x80 as 1.0

// `%%SC<XX>` indexes the table at 0x0020D7B0: the sixteen HTML colour names,
// with `SV` carrying gray's 0.5 rather than silver's 0.75.
const MARKUP_COLOURS = {
  WT: [1, 1, 1], SV: [0.5, 0.5, 0.5], BK: [0, 0, 0],
  RD: [1, 0, 0], MR: [0.5, 0, 0], YL: [1, 1, 0], OL: [0.5, 0.5, 0],
  LM: [0, 1, 0], GR: [0, 0.5, 0], AQ: [0, 1, 1], TL: [0, 0.5, 0.5],
  BL: [0, 0, 1], NV: [0, 0, 0.5], FC: [1, 0, 1], PP: [0.5, 0, 0.5],
};

/**
 * A float colour in the units the GS ends up holding it in, where 0x80 is 1.
 * `0x0020D7B0` halves its entry with a VU0 `vmulbc` before it becomes a vertex
 * byte, so `%%SCSV`'s 0.5 reaches the wire as 0x40.
 */
function gsColour(c) {
  return [Math.round(c[0] * 127.5) / GS_ONE,
          Math.round(c[1] * 127.5) / GS_ONE,
          Math.round(c[2] * 127.5) / GS_ONE];
}

const BODY_COLOUR = gsColour([0.9, 0.9, 0.9]);   // 0x001C5950 -> FUN_0020DBD0

const MK_SET = '%%SC', MK_RESTORE = '%%RC';
const BS = String.fromCharCode(92);
const MK_BREAK = BS + 'n', MK_END = BS + '0';

/** Shift-JIS double byte -> the glyph array's index, or -1. */
function jisLinear(sjis) {
  const s1 = sjis >> 8, s2 = sjis & 0xFF;
  if (!((s1 >= 0x81 && s1 <= 0x9F) || (s1 >= 0xE0 && s1 <= 0xEF))
      || s2 < 0x40 || s2 === 0x7F) return -1;
  let j1, j2;
  if (s2 < 0x9F) {
    j1 = (s1 << 1) - (s1 < 0xA0 ? 0xE1 : 0x161);
    j2 = s2 - (s2 < 0x7F ? 0x1F : 0x20);
  } else {
    j1 = (s1 << 1) - (s1 < 0xA0 ? 0xE0 : 0x160);
    j2 = s2 - 0x7E;
  }
  const row = j1 - 0x20, cell = j2 - 0x20;
  if (row < 1 || row > ROWS || cell < 1 || cell > CELLS) return -1;
  return (row - 1) * CELLS + (cell - 1);
}

// The script stores every glyph full-width, apostrophes included -- `don't` is
// written `ｄｏｎ’ｔ`.  scene.js normalises cues to ASCII for display, so this
// puts them back into the form the face can be indexed with.
function widen(s) {
  let out = '', i = 0;
  while (i < s.length) {
    if (s.startsWith(MK_SET, i) && i + 6 <= s.length) { out += s.slice(i, i + 6); i += 6; continue; }
    let mk = null;
    for (const m of [MK_RESTORE, MK_BREAK, MK_END])
      if (s.startsWith(m, i)) { mk = m; break; }
    if (mk) { out += mk; i += mk.length; continue; }
    const c = s[i];
    i += 1;
    const o = c.charCodeAt(0);
    if (c === ' ') out += String.fromCharCode(0x3000);
    else if (c === "'") out += String.fromCharCode(0x2019);
    else if (c === '"') out += String.fromCharCode(0x201D);
    else if (o >= 0x21 && o <= 0x7E) out += String.fromCharCode(0xFF01 + o - 0x21);
    else out += c;
  }
  return out;
}

/** One character -> Shift-JIS, or -1. Needs a cp932 encoder. */
function makeEncoder() {
  // The browser dropped legacy encoders from TextEncoder, so build the map
  // from the face itself: every glyph the font has, decoded through a
  // shift_jis TextDecoder, gives unicode -> sjis for exactly the set that
  // matters.  If shift_jis is unavailable this stays empty and the caller
  // falls back to DOM text.
  let dec = null;
  try { dec = new TextDecoder('shift_jis', { fatal: true }); } catch (e) { return null; }
  const map = new Map();
  const buf = new Uint8Array(2);
  for (let hi = 0x81; hi <= 0xEF; hi++) {
    if (hi > 0x9F && hi < 0xE0) continue;
    for (let lo = 0x40; lo <= 0xFC; lo++) {
      if (lo === 0x7F) continue;
      buf[0] = hi; buf[1] = lo;
      let ch;
      try { ch = dec.decode(buf); } catch (e) { continue; }
      if (ch.length === 1 && !map.has(ch)) map.set(ch, (hi << 8) | lo);
    }
  }
  return map;
}

class Font {
  /**
   * `elf` is the whole executable, as disc.js already holds it, and `addrs`
   * is where the face lives inside it -- `disc.region.font`, defaulting to
   * the US build for callers that only ever see one disc.
   */
  constructor(elf, addrs) {
    const a = addrs || regionMod.US.font;
    this.addrs = a;
    this.glyphsVa = a.GLYPHS;
    this.elf = elf;
    const dv = new DataView(elf.buffer, elf.byteOffset, elf.byteLength);
    this.dv = dv;
    const d = this.off(a.DESC);
    this.cell = [dv.getUint16(d + 4, true), dv.getUint16(d + 6, true)];
    this.box = [dv.getFloat32(d + 8, true), dv.getFloat32(d + 12, true)];
    const c = this.off(a.CLUT);
    this.clut = [];
    for (let i = 0; i < 16; i++)
      this.clut.push([elf[c + i * 4], elf[c + i * 4 + 1],
                      elf[c + i * 4 + 2], elf[c + i * 4 + 3]]);
    this.widths = new Map();
    if (a.WIDTH_DIR) {
      const w = this.off(a.WIDTH_DIR);
      for (let i = 0; i < a.WIDTH_DIR_N; i++) {
        const lo = dv.getUint16(w + 12 * i, true);
        const hi = dv.getUint16(w + 12 * i + 2, true);
        const ptr = dv.getUint32(w + 12 * i + 4, true);
        const n = dv.getUint32(w + 12 * i + 8, true);
        if (hi - lo + 1 !== n) throw new Error('width record ' + i + ' is not contiguous');
        const p = this.off(ptr);
        for (let k = 0; k < n; k++) this.widths.set(lo + k, elf[p + k]);
      }
    }
    this.encoder = makeEncoder();
    this.cache = new Map();
  }

  off(va) { return va - 0x100000 + 0x80; }

  has(sjis) { return jisLinear(sjis) >= 0; }

  advance(sjis) {
    return this.widths.has(sjis) ? this.widths.get(sjis) : this.cell[0];
  }

  sjisOf(ch) {
    if (!this.encoder) return -1;
    const v = this.encoder.get(ch);
    return v === undefined ? -1 : v;
  }

  /** A glyph as 16x16 RGBA, the CLUT applied, cached. */
  rgba(sjis) {
    if (this.cache.has(sjis)) return this.cache.get(sjis);
    const lin = jisLinear(sjis);
    if (lin < 0) return null;
    const o = this.off(this.glyphsVa + lin * SLOT);
    const out = new Uint8Array(16 * 16 * 4);
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x += 2) {
        const b = this.elf[o + y * 8 + (x >> 1)];
        const c0 = this.clut[b & 0xF], c1 = this.clut[b >> 4];
        let p = (y * 16 + x) * 4;
        out[p] = c0[0]; out[p + 1] = c0[1]; out[p + 2] = c0[2]; out[p + 3] = c0[3];
        p += 4;
        out[p] = c1[0]; out[p + 1] = c1[1]; out[p + 2] = c1[2]; out[p + 3] = c1[3];
      }
    this.cache.set(sjis, out);
    return out;
  }

  /**
   * Lay one `0x60` payload out -> `[{sjis, x, y, colour}]`, the top-left of
   * each 24x24 glyph box in the 640x448 UI space.
   *
   * `%%SC<XX>` saves the current colour and sets a new one, `%%RC` puts the
   * saved one back.  The object holds exactly **one** saved slot
   * (`0x0020D7B0` writes it to `+0x190`), so this is one level, not a stack.
   */
  runs(text, x, y) {
    if (x === undefined) x = SUB_X;
    if (y === undefined) y = SUB_Y;
    const bw = this.box[0], bh = this.box[1];
    const left = x - bw / 2.0;
    const top = y + SUB_ANCHOR_DY - bh / 2.0;
    let pen = left, line = 0;
    let colour = BODY_COLOUR, saved = BODY_COLOUR;
    const out = [];
    let i = 0;
    while (i < text.length) {
      if (text.startsWith(MK_SET, i) && i + 6 <= text.length) {
        const c = MARKUP_COLOURS[text.slice(i + 4, i + 6)];
        // an unrecognised code takes the same path as `%%RC`
        if (c) { const prev = colour; colour = gsColour(c); saved = prev; }
        else { const prev = colour; colour = saved; saved = prev; }
        i += 6;
      } else if (text.startsWith(MK_RESTORE, i)) {
        const prev = colour; colour = saved; saved = prev;
        i += MK_RESTORE.length;
      } else if (text.startsWith(MK_BREAK, i)) {
        line += 1; pen = left; i += MK_BREAK.length;
      } else if (text.startsWith(MK_END, i) || text[i] === '\0') {
        break;
      } else {
        const code = this.sjisOf(text[i]);
        i += 1;
        if (code < 0 || !this.has(code)) continue;
        out.push({ sjis: code, x: pen, y: top + line * bh, colour: colour });
        pen += this.advance(code) * (bw / this.cell[0]);
      }
    }
    return out;
  }
}

// Where in a pixel the GS takes its sample: **zero**, the pixel's own integer
// coordinate rather than its centre.  Fitting this against the reference
// capture is unambiguous -- 0.0 lands on the hardware's, 0.5 leaves a
// consistent half-pixel of drift.
const GS_SAMPLE = 0.0;

/**
 * Draw one glyph box with the GS's own filtering and blend.
 * MMAG/MMIN are LINEAR, TFX is MODULATE with TCC=RGBA, and ALPHA is
 * `(Cs - Cd) * As >> 7 + Cd`.  The GS filters the *palettised* colour, not a
 * premultiplied one, which is what gives glyph edges their dark fringe -- so
 * this lerps RGB and A independently.
 */
function blend(dst, w, h, px, py, gw, gh, glyph, cw, ch, colour) {
  const x0 = Math.max(0, Math.ceil(px - GS_SAMPLE));
  const x1 = Math.min(w, Math.ceil(px + gw - GS_SAMPLE));
  const y0 = Math.max(0, Math.ceil(py - GS_SAMPLE));
  const y1 = Math.min(h, Math.ceil(py + gh - GS_SAMPLE));
  for (let sy = y0; sy < y1; sy++) {
    const vy = Math.max(0, Math.min(ch - 1, (sy + GS_SAMPLE - py) / gh * ch - 0.5));
    const j0 = Math.floor(vy), fj = vy - j0, j1 = Math.min(ch - 1, j0 + 1);
    for (let sx = x0; sx < x1; sx++) {
      const ux = Math.max(0, Math.min(cw - 1, (sx + GS_SAMPLE - px) / gw * cw - 0.5));
      const i0 = Math.floor(ux), fi = ux - i0, i1 = Math.min(cw - 1, i0 + 1);
      let a0 = 0, a1 = 0, a2 = 0, a3 = 0;
      const pairs = [[j0, 1 - fj], [j1, fj]];
      const cols = [[i0, 1 - fi], [i1, fi]];
      for (const [jj, wj] of pairs)
        for (const [ii, wi] of cols) {
          const t = (jj * cw + ii) * 4, f = wi * wj;
          a0 += glyph[t] * f; a1 += glyph[t + 1] * f;
          a2 += glyph[t + 2] * f; a3 += glyph[t + 3] * f;
        }
      const a = a3 / GS_ONE;
      if (a <= 0) continue;
      const o = (sy * w + sx) * 4;
      dst[o] = Math.min(255, a0 * colour[0] * a + dst[o] * (1 - a));
      dst[o + 1] = Math.min(255, a1 * colour[1] * a + dst[o + 1] * (1 - a));
      dst[o + 2] = Math.min(255, a2 * colour[2] * a + dst[o + 2] * (1 - a));
      // Keep coverage so the overlay can be composited over the world.
      dst[o + 3] = Math.min(255, a * 255 + dst[o + 3] * (1 - a));
    }
  }
}

/**
 * Render one cue into a `w` x `h` RGBA overlay, transparent where there is no
 * glyph, so it can be laid over the rendered frame.
 */
function overlay(font, text, x, y, w, h) {
  w = w || NATIVE_W; h = h || NATIVE_H;
  const sx = w / UI_W, sy = h / UI_H;
  const gw = font.box[0] * sx, gh = font.box[1] * sy;
  const cw = font.cell[0], ch = font.cell[1];
  const dst = new Float32Array(w * h * 4);
  for (const g of font.runs(text, x, y))
    blend(dst, w, h, g.x * sx, g.y * sy, gw, gh, font.rgba(g.sjis), cw, ch, g.colour);
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(dst[i]);
  return { width: w, height: h, rgba: out };
}

/** Rebuild the cue string the script stored, from a parsed subtitle. */
function cueText(sub) {
  const body = sub.lines.join(MK_BREAK);
  return sub.speaker
    ? MK_SET + 'SV' + widen(sub.speaker) + MK_RESTORE + MK_BREAK + widen(body)
    : widen(body);
}

const api = { Font, overlay, cueText, widen, jisLinear, gsColour, blend,
              MARKUP_COLOURS, BODY_COLOUR, SUB_X, SUB_Y, NATIVE_W, NATIVE_H,
              UI_W, UI_H, GS_ONE, GS_SAMPLE };
if (typeof module !== 'undefined') module.exports = api;
if (typeof window !== 'undefined') window.TraptFont = api;
})();
