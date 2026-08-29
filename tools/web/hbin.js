/**
 * `#bin` -- the named-chunk container, `tools/hbin.py` in the browser.
 *
 * Eight hundred and ninety files on the disc start with `#bin`: every `.sta`
 * of character parameters, every `.td`/`.tcd` of trap data, and every
 * `M###.BIN` stage graph.
 *
 *   0x00 char[4]  '#bin'
 *   0x04 u32      file size
 *   0x08 u32      chunk count
 *   0x0c u32      fixup count
 *   0x10          chunk[count], stride 12: { u32 name, u32 offset, u32 size }
 *                 u32 fixup[fixup count]  -- file offsets of pointer fields
 *
 * Chunk names repeat (a `.sta` has twenty-five `HIT_DATA`), so the directory
 * is an ordered list and never a map.  Name buffers were never cleared by the
 * authoring tool, so always cut at the first NUL: `SRoomDef` reads back as
 * `RH_01\0ef`.
 *
 * Twenty-five `.tcd` on the disc declare a chunk that runs past the end of
 * the file; those are clamped rather than thrown, because the game reads what
 * is there.
 */
(function () {
'use strict';

const MAGIC = 0x6e696223;      // '#bin' little-endian
const HEADER = 0x10;
const CHUNK_STRIDE = 12;

function cut(blob, off) {
  if (off <= 0 || off >= blob.length) return -1;
  let end = off;
  while (end < blob.length && blob[end]) end++;
  return end;
}

function latin1(blob, off) {
  const end = cut(blob, off);
  if (end < 0) return '';
  let s = '';
  for (let i = off; i < end; i++) s += String.fromCharCode(blob[i]);
  return s;
}

/**
 * Shift-JIS, for the trap names and descriptions.  They are almost entirely
 * full-width Latin -- `0x8260`-`0x8279` is `A`-`Z`, `0x8281`-`0x829a` is
 * `a`-`z`, `0x824f`-`0x8258` is `0`-`9` -- so the handful of ranges that
 * actually appear are decoded directly and anything else is passed through
 * TextDecoder when the browser has one.
 */
const SJIS_PUNCT = {
  0x8140: ' ', 0x8141: ',', 0x8142: '.', 0x8143: ',', 0x8144: '.',
  0x8145: '・', 0x8146: ':', 0x8147: ';', 0x8148: '?', 0x8149: '!',
  0x8160: '~', 0x8161: '―', 0x8163: '…', 0x8166: '’',
  0x8168: '"', 0x816d: '[', 0x816e: ']', 0x8169: '(', 0x816a: ')',
  0x817c: '-', 0x8175: '「', 0x8176: '」', 0x815e: '/',
  0x8151: '_', 0x8193: '%', 0x8194: '#', 0x8195: '&', 0x8196: '*',
  0x8197: '@',
};

function sjis(blob, off) {
  const end = cut(blob, off);
  if (end < 0) return '';
  let out = '';
  for (let i = off; i < end; i++) {
    const b = blob[i];
    if (b < 0x80) { out += String.fromCharCode(b); continue; }
    const w = (b << 8) | blob[i + 1];
    i++;
    if (w >= 0x8260 && w <= 0x8279) out += String.fromCharCode(0x41 + w - 0x8260);
    else if (w >= 0x8281 && w <= 0x829a) out += String.fromCharCode(0x61 + w - 0x8281);
    else if (w >= 0x824f && w <= 0x8258) out += String.fromCharCode(0x30 + w - 0x824f);
    else if (SJIS_PUNCT[w] !== undefined) out += SJIS_PUNCT[w];
    else if (typeof TextDecoder !== 'undefined') {
      try {
        out += new TextDecoder('shift_jis').decode(new Uint8Array([b, blob[i]]));
      } catch (e) { out += '�'; }
    } else out += '�';
  }
  return out;
}

class Container {
  constructor(blob, chunks, fixups) {
    this.blob = blob;
    this.chunks = chunks;
    this.fixups = fixups;
  }
  allOf(name) { return this.chunks.filter((c) => c.name === name); }
  first(name) { return this.chunks.find((c) => c.name === name) || null; }
  get names() { return [...new Set(this.chunks.map((c) => c.name))]; }
  cstr(off) { return latin1(this.blob, off); }
  sjis(off) { return sjis(this.blob, off); }
}

function parse(blob) {
  const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  if (dv.getUint32(0, true) !== MAGIC)
    throw new Error('not a #bin');
  const size = dv.getUint32(4, true);
  const count = dv.getUint32(8, true);
  const nfix = dv.getUint32(12, true);
  if (size !== blob.length)
    throw new Error('#bin: header says ' + size + ' bytes, file is ' + blob.length);
  if (HEADER + count * CHUNK_STRIDE + nfix * 4 > blob.length)
    throw new Error('#bin: ' + count + ' chunks + ' + nfix + ' fixups overrun');
  const chunks = [];
  for (let i = 0; i < count; i++) {
    const b = HEADER + CHUNK_STRIDE * i;
    const noff = dv.getUint32(b, true);
    const doff = dv.getUint32(b + 4, true);
    const dsize = dv.getUint32(b + 8, true);
    if (noff >= blob.length)
      throw new Error('#bin: chunk ' + i + ' name is past the end');
    const stop = Math.min(doff + dsize, blob.length);
    chunks.push({
      name: latin1(blob, noff), offset: doff, size: dsize,
      data: blob.subarray(doff, stop), truncated: stop !== doff + dsize,
    });
  }
  const base = HEADER + CHUNK_STRIDE * count;
  const fixups = [];
  for (let i = 0; i < nfix; i++) fixups.push(dv.getUint32(base + 4 * i, true));
  return new Container(blob, chunks, fixups);
}

/** Full-width Latin back to ASCII -- how these read on screen. */
function norm(text) {
  return typeof text.normalize === 'function' ? text.normalize('NFKC') : text;
}

const api = { parse, Container, norm, latin1, sjis, MAGIC };
if (typeof module !== 'undefined') module.exports = api;
if (typeof window !== 'undefined') window.TraptHbin = api;
})();
