/**
 * The trap tables -- `tools/trap.py` in the browser.
 *
 * Ids 0x00-0x2F are the 48 player traps, sixteen per surface, and the letter
 * in the archive name is the surface: `TC` Ceiling, `TW` Wall, `TF` Floor.
 * That is also the three tabs of the trap-select screen.
 *
 *   DATA/TRAP/TRAPINFO.BIN   48 x TrapInfo, the master table
 *   DATA/TRAP/T{C,W,F}##.ARC one archive per trap
 *     <trap>.td              TrapData  -- name, effect text, model
 *     <trap>.tcd             the volumes it occupies
 *     <trap>.sd              sound slots, 0xffff for none
 *     <trap>.smi/.sai/.ssc   already-decoded formats; firing a trap is
 *                            running one of those `.ssc` effect scripts
 *
 * TrapInfo, 16 bytes:
 *   +0x00 u32 -> name    +0x08 u16 damage   +0x0c u16 cost
 *   +0x04 u32 -> blurb   +0x0a u16 reset    +0x0e u16 price
 *
 * The `.td` carries the name again -- it agrees for all 48 -- plus a *second*,
 * longer description.  `Guillotine` is `Slices the enemy.` in TRAPINFO and
 * `3 blades fall in succession.` in the `.td`; those are the two texts the
 * trap-select screen shows, in the list and in the detail panel.
 */
(function () {
'use strict';

const req = (typeof require !== 'undefined');
const hbinMod = req ? require('./hbin.js') : window.TraptHbin;
const arcMod = req ? require('./arc.js') : window.TraptArc;

const GROUPS = 'CWF';
const SURFACES = { C: 'ceiling', W: 'wall', F: 'floor' };
const TRAP_COUNT = 48;
const INFO_PATH = 'DATA/TRAP/TRAPINFO.BIN';

// A `*_SET` entry is eight floats: min, max, then two of padding.
const VOLUME_STRIDE = 8;

function trapName(i) {
  return 'T' + GROUPS[Math.floor(i / 16)] + String(i % 16).padStart(2, '0');
}
function trapSurface(i) { return SURFACES[GROUPS[Math.floor(i / 16)]]; }

function parseInfo(blob) {
  const c = hbinMod.parse(blob);
  const chunks = c.allOf('TrapInfo');
  if (chunks.length !== TRAP_COUNT)
    throw new Error('TRAPINFO.BIN has ' + chunks.length + ' entries');
  return chunks.map((ch, i) => {
    const dv = new DataView(ch.data.buffer, ch.data.byteOffset, ch.data.byteLength);
    return {
      id: i, name: trapName(i), surface: trapSurface(i),
      title: hbinMod.norm(c.sjis(dv.getUint32(0, true))),
      blurb: hbinMod.norm(c.sjis(dv.getUint32(4, true))),
      effect: '',
      damage: dv.getUint16(8, true), reset: dv.getUint16(10, true),
      cost: dv.getUint16(12, true), price: dv.getUint16(14, true),
      model: null, archive: 'DATA/TRAP/' + trapName(i) + '.ARC',
    };
  });
}

function parseTd(blob) {
  const c = hbinMod.parse(blob);
  const ch = c.first('TrapData');
  if (!ch) throw new Error('.td has no TrapData chunk');
  const dv = new DataView(ch.data.buffer, ch.data.byteOffset, ch.data.byteLength);
  const ptrs = [];
  for (let i = 0; i < 5; i++) ptrs.push(dv.getUint32(i * 4, true));
  return {
    title: hbinMod.norm(c.sjis(ptrs[0])),
    effect: hbinMod.norm(c.sjis(ptrs[1])),
    model: c.cstr(ptrs[2]),
    pointers: ptrs, live: c.fixups.length, raw: ch.data,
  };
}

function parseTcd(blob) {
  const c = hbinMod.parse(blob);
  const out = new Map();
  for (const ch of c.chunks) {
    const n = Math.floor(ch.data.length / 4);
    const dv = new DataView(ch.data.buffer, ch.data.byteOffset, ch.data.byteLength);
    const floats = [];
    for (let i = 0; i < n; i++) floats.push(dv.getFloat32(i * 4, true));
    if (!out.has(ch.name)) out.set(ch.name, []);
    out.get(ch.name).push(floats);
  }
  return out;
}

/**
 * The rectangles a trap occupies, as `{name, min, max}`.  One axis is always
 * flat, because the box lies on the surface the trap is set on.
 */
function footprint(tcd) {
  const out = [];
  for (const [name, runs] of tcd) {
    if (!name.endsWith('_SET')) continue;
    for (const floats of runs)
      for (let i = 0; i + 8 <= floats.length; i += VOLUME_STRIDE) {
        const lo = floats.slice(i, i + 3);
        const hi = floats.slice(i + 3, i + 6);
        if (lo.every((v) => v === 0) && hi.every((v) => v === 0)) continue;
        out.push({ name, min: lo, max: hi });
      }
  }
  return out;
}

function parseSd(blob) {
  const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const out = [];
  for (let i = 0; i + 1 < blob.length; i += 2) {
    const v = dv.getUint16(i, true);
    out.push(v === 0xffff ? null : v);
  }
  return out;
}

async function loadAll(disc) {
  const blob = await disc.read(INFO_PATH);
  if (!blob) throw new Error('no TRAPINFO.BIN on this disc');
  return parseInfo(blob);
}

/** One trap's archive, with its `.td` text folded into the record. */
async function loadOne(disc, tr) {
  const blob = await disc.read(tr.archive);
  if (!blob) return null;
  const members = arcMod.members(blob);
  const stem = tr.name.toLowerCase();
  const td = members.get(stem + '.td');
  if (td) {
    const parsed = parseTd(td);
    tr.model = parsed.model;
    tr.effect = parsed.effect;
  }
  const tcd = members.get(stem + '.tcd');
  return { members, tcd: tcd ? parseTcd(tcd) : new Map(),
           footprint: tcd ? footprint(parseTcd(tcd)) : [] };
}

const api = { parseInfo, parseTd, parseTcd, parseSd, footprint,
              loadAll, loadOne, trapName, trapSurface,
              TRAP_COUNT, INFO_PATH, SURFACES };
if (typeof module !== 'undefined') module.exports = api;
if (typeof window !== 'undefined') window.TraptTrap = api;
})();
