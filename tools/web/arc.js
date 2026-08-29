/**
 * `RPS` archive reader -- `tools/arc.py` in the browser.
 *
 *   0x00 u32  magic 'RPS\0'
 *   0x04 u32  entry count
 *   0x08 u32  data_base (start of payload, also the header size)
 *   0x0C u32  total file size
 *   0x10 u32  payload size
 *   0x14 u32  unused
 *   0x18      entry[], stride 0x14:
 *               u32 size, u32 size_aligned, u32 name_off (absolute),
 *               u32 data_off (relative to data_base), u32 unk
 *
 * Member names are the lower-case file names the scene scripts ask for
 * (`c01f_a_h.smi`, `rt_e001_txt.ssc`), so the map this returns is keyed the
 * way `scene.Scene.asset()` looks things up.
 */
(function () {
'use strict';

const MAGIC = 0x00535052;                       // 'RPS\0' little-endian

const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000;

function cstr(buf, off) {
  let s = '';
  for (let i = off; i < buf.length && buf[i]; i++) s += String.fromCharCode(buf[i]);
  return s;
}

/** `[{name, offset, size}]` for every member, in stored order. */
function entries(data) {
  if (u32(data, 0) !== MAGIC)
    throw new Error('not an RPS archive (magic ' + [...data.slice(0, 4)] + ')');
  const count = u32(data, 4), base = u32(data, 8);
  const out = [];
  for (let i = 0; i < count; i++) {
    const p = 0x18 + 0x14 * i;
    out.push({
      name: cstr(data, u32(data, p + 8)),
      offset: base + u32(data, p + 12),
      size: u32(data, p),
    });
  }
  return out;
}

/** `Map` of lower-case member name -> bytes, the shape scene.py works in. */
function members(data) {
  const out = new Map();
  for (const e of entries(data))
    out.set(e.name.toLowerCase(), data.subarray(e.offset, e.offset + e.size));
  return out;
}

/**
 * Open an archive without reading it: pull the header and entry table, then
 * fetch members individually.  The header is `0x18 + 0x14 * count` bytes, so
 * one small read describes an archive of any size.
 */
async function openRanged(disc, path) {
  const head = await disc.readRange(path, 0, 0x18);
  if (!head || head.length < 0x18) return null;
  if (u32(head, 0) !== MAGIC) return null;
  const count = u32(head, 4);
  const tableEnd = 0x18 + 0x14 * count;
  // Names sit past the entry table and before data_base, so one read of the
  // whole header region covers the table and every name in it.
  const base = u32(head, 8);
  const front = await disc.readRange(path, 0, Math.min(base, tableEnd + 0x8000));
  const list = [];
  for (let i = 0; i < count; i++) {
    const p = 0x18 + 0x14 * i;
    if (p + 0x14 > front.length) break;
    const nameOff = u32(front, p + 8);
    list.push({
      name: nameOff < front.length ? cstr(front, nameOff) : '',
      offset: base + u32(front, p + 12),
      size: u32(front, p),
    });
  }
  return {
    path: path, entries: list,
    /** Read one member, by name, as its own ranged read. */
    read: async (name) => {
      const want = name.toLowerCase();
      const e = list.find((x) => x.name.toLowerCase() === want);
      return e ? disc.readRange(path, e.offset, e.size) : null;
    },
    /** Read every member whose name passes `want(name)`. */
    readWhere: async (want) => {
      const out = new Map();
      for (const e of list)
        if (want(e.name.toLowerCase()))
          out.set(e.name.toLowerCase(), await disc.readRange(path, e.offset, e.size));
      return out;
    },
  };
}

const api = { entries, members, openRanged };
if (typeof module !== 'undefined') module.exports = api;
if (typeof window !== 'undefined') window.TraptArc = api;
})();
