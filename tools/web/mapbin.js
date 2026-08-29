/**
 * `M###.BIN` -- the stage graph, `tools/mapbin.py` in the browser.
 *
 * Twenty-two stages, each a `#bin` of four chunk kinds:
 *
 *   SMapDef   4 bytes   u32 map id
 *   SRoomDef  52        char[8] name; float3 world position; u32 index
 *   SPassDef  68        the same, then char[8] x2 -- the rooms it joins
 *   SDoorDef  20        u32 index; char[8] room; char[8] room
 *
 * A stage is rooms and corridors placed in one world space with no rotation
 * anywhere, joined by doors.  A record whose index has bit 16 set is a sealed
 * doorway: 45 of the 48 sealed doors name `NOT_USE` on the far side and the
 * other 3 name a room the stage does not load.
 *
 * A door stores neither a position nor a door number.  The position comes
 * from `<room>d<n>.smi` in the room's own `_ALL` archive -- the translation of
 * its first node -- and the number from the order the room's records appear.
 */
(function () {
'use strict';

const req = (typeof require !== 'undefined');
const hbinMod = req ? require('./hbin.js') : window.TraptHbin;
const arcMod = req ? require('./arc.js') : window.TraptArc;
const smiMod = req ? require('./smi.js') : window.TraptSmi;

const ROOM = 'SRoomDef';
const PASS = 'SPassDef';
const DOOR = 'SDoorDef';
const MAP = 'SMapDef';
const NOT_USE = 'NOT_USE';
const DOOR_SEALED = 0x10000;

/** An eight-byte name buffer, cut at the NUL the authoring tool left. */
function name8(data, off, n) {
  n = n === undefined ? 8 : n;
  let s = '';
  for (let i = off; i < off + n && i < data.length && data[i]; i++)
    s += String.fromCharCode(data[i]);
  return s;
}

/** `RH_01` -> `rh01`, the id the rest of the disc uses. */
function roomId(name) { return name.replace(/_/g, '').toLowerCase(); }

function parse(blob, number) {
  const c = hbinMod.parse(blob);
  const md = c.first(MAP);
  const mapId = md
    ? new DataView(md.data.buffer, md.data.byteOffset, md.data.byteLength)
        .getUint32(0, true)
    : -1;

  const f3 = (d, o) => {
    const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
    return [dv.getFloat32(o, true), dv.getFloat32(o + 4, true),
            dv.getFloat32(o + 8, true)];
  };
  const u32 = (d, o) =>
    new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(o, true);

  const rooms = [];
  for (const ch of c.allOf(ROOM)) {
    const nm = name8(ch.data, 0);
    rooms.push({ name: nm, id: roomId(nm), pos: f3(ch.data, 8),
                 index: u32(ch.data, 20), passage: false, links: [] });
  }
  for (const ch of c.allOf(PASS)) {
    const nm = name8(ch.data, 0);
    rooms.push({ name: nm, id: roomId(nm), pos: f3(ch.data, 8),
                 index: u32(ch.data, 20), passage: true,
                 links: [name8(ch.data, 52), name8(ch.data, 60)] });
  }

  const doors = [];
  const seen = new Map();
  for (const ch of c.allOf(DOOR)) {
    const raw = u32(ch.data, 0);
    const a = name8(ch.data, 4);
    const nth = seen.get(a) || 0;
    seen.set(a, nth + 1);
    doors.push({ index: raw & 0xffff, sealed: !!(raw & DOOR_SEALED),
                 aRoom: a, bRoom: name8(ch.data, 12), number: nth });
  }

  const byName = new Map(rooms.map((r) => [r.name, r]));
  return {
    number: number === undefined ? -1 : number,
    mapId, rooms, doors, byName,
    room: (n) => byName.get(n) || null,
    doorsOf: (n) => doors.filter((d) => d.aRoom === n || d.bRoom === n),
    ownedDoors: (n) => doors.filter((d) => d.aRoom === n),
  };
}

async function load(disc, number) {
  const path = 'DATA/MAP_DATA/BIN/M' + String(number).padStart(3, '0') + '.BIN';
  const blob = await disc.read(path);
  if (!blob) throw new Error('no stage M' + number + ' on this disc');
  return parse(blob, number);
}

/** Which stages this disc carries. */
function stageNumbers(disc) {
  const out = [];
  for (const path of disc.glob('DATA/MAP_DATA/BIN/')) {
    const stem = path.split('/').pop();
    if (stem.startsWith('M') && stem.endsWith('.BIN'))
      out.push(parseInt(stem.slice(1, -4), 10));
  }
  return out.sort((a, b) => a - b);
}

/**
 * `{door number: {file, pos}}` for one room -- the door meshes in its own
 * `_ALL` archive, and the room-local position each sits at.
 */
async function doorModels(disc, room) {
  const blob = await disc.read('DATA/ROOM/' + room.toUpperCase() + '_ALL.ARC');
  if (!blob) return new Map();
  const out = new Map();
  let entries;
  try { entries = arcMod.entries(blob); } catch (e) { return out; }
  for (const e of entries) {
    const low = e.name.toLowerCase();
    if (!low.endsWith('.smi')) continue;
    const stem = low.slice(0, -4);
    if (!stem.startsWith(room.toLowerCase() + 'd')) continue;
    const tail = stem.slice(room.length + 1);
    if (!/^\d+$/.test(tail)) continue;
    let model;
    try { model = smiMod.parse(blob.subarray(e.offset, e.offset + e.size)); }
    catch (err) { continue; }
    if (!model.nodes.length) continue;
    const m = model.nodes[0].matrix;
    out.set(parseInt(tail, 10), { file: e.name, pos: [m[12], m[13], m[14]] });
  }
  return out;
}

const api = { parse, load, stageNumbers, doorModels, roomId, name8,
              NOT_USE, DOOR_SEALED };
if (typeof module !== 'undefined') module.exports = api;
if (typeof window !== 'undefined') window.TraptMapbin = api;
})();
