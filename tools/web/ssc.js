/**
 * `.SSC` compiled scene-script reader -- `tools/ssc.py` in the browser.
 *
 * The bytecode the cutscene VM runs.  One cutscene is a bundle of parallel
 * tracks (a master/director track plus one each for actors, camera, map, text
 * and effects) that all share a single frame counter.
 *
 *   0x00  'SC'
 *   0x02  u16   (0x011b on every file on the disc)
 *   0x04  u16   call count
 *   0x06  call stream
 *
 * A call is `E1 <u16 op BE> <u16 flag BE> <arg>* EF`, arguments tagged:
 *
 *   C1  s32 big-endian                     an integer
 *   C4  s32 big-endian                     a second integer namespace (cues)
 *   C2  s32, s32                           a rational: 5/10 is 0.5
 *   C3  NUL-terminated Shift-JIS string
 *
 * Note the **big-endian** opcodes and integers in an otherwise little-endian
 * game -- the scene compiler is the odd one out.
 */
(function () {
'use strict';

const hex2 = (v) => (v < 16 ? '0' : '') + v.toString(16);

const CALL = 0xE1;
const END = 0xEF;

/** Decode a script string. Shift-JIS if the platform has it, else latin-1. */
let decoder = null;
try {
  decoder = new TextDecoder('shift_jis');
} catch (e) {
  decoder = null;
}
function sj(bytes) {
  if (decoder) {
    try { return decoder.decode(bytes); } catch (e) { /* fall through */ }
  }
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

/**
 * `[{offset, op, flag, args}]` for every call.  `op` is null for a byte the
 * stream did not expect; trailing NUL/0xFF padding ends the walk.
 */
function parse(data) {
  if (data[0] !== 0x53 || data[1] !== 0x43)
    throw new Error('not an SSC script (magic ' + data[0] + ',' + data[1] + ')');
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const n = data.length;
  const out = [];
  let p = 6;
  while (p < n) {
    if (data[p] !== CALL) {
      let allPad = true;
      for (let i = p; i < n; i++)
        if (data[i] !== 0 && data[i] !== 0xFF) { allPad = false; break; }
      if (allPad) break;
      out.push({ offset: p, op: null, flag: 0,
                 args: ['<raw ' + hex2(data[p]) + '>'] });
      p += 1;
      continue;
    }
    const op = dv.getUint16(p + 1, false);        // big-endian
    const flag = dv.getUint16(p + 3, false);
    let q = p + 5;
    const args = [];
    while (q < n && data[q] !== END) {
      const t = data[q];
      q += 1;
      if (t === 0xC1) {
        args.push(dv.getInt32(q, false)); q += 4;
      } else if (t === 0xC4) {
        args.push({ c4: dv.getInt32(q, false) }); q += 4;
      } else if (t === 0xC2) {
        args.push({ num: dv.getInt32(q, false), den: dv.getInt32(q + 4, false) });
        q += 8;
      } else if (t === 0xC3) {
        let e = q;
        while (e < n && data[e]) e++;
        args.push(sj(data.subarray(q, e)));
        q = e + 1;
      } else {
        // Same text ssc.py produces, offset included, so the two ports
        // stay diffable on the handful of files with an unknown tag.
        args.push('<type ' + hex2(t) + ' @' + (q - 1).toString(16) + '>');
        q = n;
      }
    }
    out.push({ offset: p, op: op, flag: flag, args: args });
    p = q + 1;
  }
  return out;
}

/** A `C2` rational as a number; anything else unchanged. */
function num(a) {
  if (a && typeof a === 'object' && 'den' in a)
    return a.den ? a.num / a.den : a.num;
  if (a && typeof a === 'object' && 'c4' in a) return a.c4;
  return a;
}

/**
 * Full-width -> ASCII, and the two curly quotes the script uses.
 * The dialogue is full-width Shift-JIS even in the English release, so
 * without this every line comes out as wide-glyph mojibake that still reads.
 */
function plain(s) {
  return s.normalize('NFKC')
          .split(String.fromCharCode(0x2019)).join("'")
          .split(String.fromCharCode(0x201D)).join('"');
}

const api = { parse, sj, plain, num, CALL, END };
if (typeof module !== 'undefined') module.exports = api;
if (typeof window !== 'undefined') window.TraptSsc = api;
})();
