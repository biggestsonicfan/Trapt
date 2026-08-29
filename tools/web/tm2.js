/**
 * `.TM2` texture reader -- Sony TIM2, the PS2 standard. `tools/tm2.py` in JS.
 *
 * FILE HEADER (0x10)   'TIM2', u8 version, u8 format, u16 picture count
 * PICTURE HEADER (0x30, at 0x10 when format is 0)
 *   +0x00 u32 total size of this picture, header included
 *   +0x04 u32 clut size          +0x08 u32 image size
 *   +0x0c u16 header size        +0x0e u16 clut colour count
 *   +0x10 u8  picture format     +0x11 u8  mipmap count
 *   +0x12 u8  clut type          +0x13 u8  image type
 *   +0x14 u16 width              +0x16 u16 height
 *
 * Image data follows the header, then the CLUT.
 *
 * The two PS2 quirks that make output look wrong if you skip them:
 *
 *  - **alpha runs 0..128**, not 0..255: 0x80 is opaque.  Miss it and every
 *    texture is drawn at half transparency.
 *  - **a 256-entry CSM1 CLUT is stored swizzled**: within each block of 32
 *    entries, 8..15 and 16..23 are swapped.  Miss it and palettes come out
 *    striped in bands of eight.
 */
(function () {
'use strict';

const MAGIC = 0x324D4954;                        // 'TIM2' little-endian

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000;

/** PS2 alpha: 0x80 means fully opaque. */
const alpha = (a) => (a >= 0x80 ? 255 : a * 2);

function rgba16(v, out, o) {
  out[o] = (v & 0x1f) << 3;
  out[o + 1] = ((v >> 5) & 0x1f) << 3;
  out[o + 2] = ((v >> 10) & 0x1f) << 3;
  out[o + 3] = (v >> 15) & 1 ? 255 : 0;
}

/** Read a palette into a flat RGBA Uint8Array of `count` entries. */
function readClut(buf, count, ctype) {
  const fmt = ctype & 0x3f;
  const pal = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) {
    if (fmt === 1) {
      rgba16(u16(buf, 2 * i), pal, 4 * i);
    } else if (fmt === 2) {
      pal[4 * i] = buf[3 * i]; pal[4 * i + 1] = buf[3 * i + 1];
      pal[4 * i + 2] = buf[3 * i + 2]; pal[4 * i + 3] = 255;
    } else {
      pal[4 * i] = buf[4 * i]; pal[4 * i + 1] = buf[4 * i + 1];
      pal[4 * i + 2] = buf[4 * i + 2]; pal[4 * i + 3] = alpha(buf[4 * i + 3]);
    }
  }
  if (count === 256 && !(ctype & 0x80)) {        // CSM1 swizzle
    const src = pal.slice();
    for (let base = 0; base < 256; base += 32)
      for (let k = 0; k < 8; k++)
        for (let c = 0; c < 4; c++) {
          pal[(base + 8 + k) * 4 + c] = src[(base + 16 + k) * 4 + c];
          pal[(base + 16 + k) * 4 + c] = src[(base + 8 + k) * 4 + c];
        }
  }
  return pal;
}

/** Expand one picture's payload to RGBA, or null if it has no pixels. */
function pixels(img, pal, itype, w, h) {
  const n = w * h;
  if (n <= 0) return null;
  const out = new Uint8Array(n * 4);

  if ((itype === 4 || itype === 5) && pal) {
    // A short palette is padded with zeroes, matching numpy's pal[:len(clut)].
    const npal = pal.length / 4;
    for (let i = 0; i < n; i++) {
      let idx;
      if (itype === 5) {
        idx = i < img.length ? img[i] : 0;
      } else {                                   // 4bpp, low nibble first
        const b = (i >> 1) < img.length ? img[i >> 1] : 0;
        idx = (i & 1) ? (b >> 4) : (b & 0x0f);
      }
      if (idx >= npal) { out[4 * i + 3] = 0; continue; }
      out[4 * i] = pal[4 * idx];
      out[4 * i + 1] = pal[4 * idx + 1];
      out[4 * i + 2] = pal[4 * idx + 2];
      out[4 * i + 3] = pal[4 * idx + 3];
    }
    return out;
  }

  if (itype === 3) {                             // 32bpp direct
    for (let i = 0; i < n; i++) {
      const s = 4 * i;
      if (s + 3 >= img.length) break;
      out[s] = img[s]; out[s + 1] = img[s + 1]; out[s + 2] = img[s + 2];
      out[s + 3] = Math.min(img[s + 3] * 2, 255);
    }
    return out;
  }
  if (itype === 2) {                             // 24bpp direct
    for (let i = 0; i < n; i++) {
      const s = 3 * i;
      if (s + 2 >= img.length) { out[4 * i + 3] = 255; continue; }
      out[4 * i] = img[s]; out[4 * i + 1] = img[s + 1]; out[4 * i + 2] = img[s + 2];
      out[4 * i + 3] = 255;
    }
    return out;
  }
  if (itype === 1) {                             // 16bpp direct
    for (let i = 0; i < n; i++) {
      const s = 2 * i;
      rgba16(s + 1 < img.length ? u16(img, s) : 0, out, 4 * i);
    }
    return out;
  }
  return null;
}

/** Decode a TIM2 file to `[{width, height, rgba}]`. */
function decode(data) {
  if (u32(data, 0) !== MAGIC)
    throw new Error('not a TIM2 (' + [...data.slice(0, 4)] + ')');
  const npic = u16(data, 6);
  const pics = [];
  let o = 0x10;
  for (let i = 0; i < npic; i++) {
    const total = u32(data, o), clutSz = u32(data, o + 4), imgSz = u32(data, o + 8);
    const hdrSz = u16(data, o + 0x0c), ncol = u16(data, o + 0x0e);
    const ctype = data[o + 0x12], itype = data[o + 0x13];
    const w = u16(data, o + 0x14), h = u16(data, o + 0x16);

    const img = data.subarray(o + hdrSz, o + hdrSz + imgSz);
    const pal = clutSz
      ? readClut(data.subarray(o + hdrSz + imgSz, o + hdrSz + imgSz + clutSz),
                 ncol, ctype)
      : null;

    const rgba = pixels(img, pal, itype, w, h);
    if (rgba) pics.push({ width: w, height: h, rgba: rgba });
    o += total;
    if (total <= 0) break;
  }
  return pics;
}

const api = { decode };
if (typeof module !== 'undefined') module.exports = api;
if (typeof window !== 'undefined') window.TraptTm2 = api;
})();
