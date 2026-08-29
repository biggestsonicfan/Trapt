/**
 * `B<nn><v>EVENT.ARC` -- what a stage is told to contain.
 * `tools/stagescript.py` in the browser.
 *
 * `stage.js` builds the *place*; this is what the game puts in it -- where the
 * player starts, which gimmicks sit where, and who walks in.  Same `.SSC`
 * bytecode as a cutscene, different opcode band: cutscenes live at `0x50`+, a
 * stage at `0x1D`-`0x3F`.
 *
 * | op | handler | what it is |
 * |---|---|---|
 * | `0x1D` | `FUN_001C7070` | a label -- `SCR:_Start`, `SCR:_End` |
 * | `0x1E` | `FUN_001DB4E0` | the map index, straight into the loader |
 * | `0x1F` | `FUN_001DB310` | the player: `(x, y, z, angle)` |
 * | `0x21` | `FUN_001DAE60` | a gimmick: `(slot, id, x, y, z, rot, ..)` |
 * | `0x22` | `FUN_001DAD10` | the same, without the rotation |
 * | `0x29` | `FUN_001DAB20` | the cast model, by name |
 * | `0x2B` | `FUN_001DA840` | and where it stands |
 *
 * Two conventions the handlers impose and neither is guessable from the data:
 * `0x1F` and `0x2B` both add **0.5 to Y**, and both wrap the angle into
 * `[-pi, pi]`.
 *
 * Gimmick ids are decimal in the script and hexadecimal in the engine.  Below
 * 100 add `0x30`, below 200 add `0x0C`, otherwise subtract `0x18` -- so the
 * script writes three readable hundreds, `22` is `GC22`, `136` is `GW36`,
 * `206` is `GF06`, and `RH01_ATH.ARC` ships exactly those four models.
 */
(function () {
'use strict';

const req = (typeof require !== 'undefined');
const ssc = req ? require('./ssc.js') : window.TraptSsc;
const arcMod = req ? require('./arc.js') : window.TraptArc;

const OP_LABEL = 0x1D, OP_MAP = 0x1E, OP_PLAYER = 0x1F;
const OP_GIMMICK = 0x21, OP_GIMMICK2 = 0x22, OP_PLACE = 0x23;
const OP_ACTOR_MODEL = 0x29, OP_ACTOR_AT = 0x2B;

const PLACE_Y_BIAS = 0.5;          // both placement handlers add it
const GROUPS = 'CWF';
const GIMMICK_BASES = [0x30, 0x70, 0xB0];
const EVSUB_RE = /^evsub_(r[hpc]\d+)\.ssc$/;

/** A script's decimal gimmick number -> the engine's id, or null. */
function gimmickId(n) {
  n = Math.trunc(n);
  if (n < -1) return null;
  if (n < 100) return n + 0x30;
  if (n < 200) return n + 0x0c;
  return n - 0x18;
}

/** `0x46` -> `GC22`, the archive stem. */
function gimmickName(id) {
  if (id === null || id === undefined) return null;
  for (let i = 0; i < GIMMICK_BASES.length; i++) {
    const base = GIMMICK_BASES[i];
    if (id >= base && id < base + 0x40)
      return 'G' + GROUPS[i] + String(id - base).padStart(2, '0');
  }
  return null;
}

/** `[-pi, pi]`, the way both placement handlers do it. */
function wrapAngle(a) {
  if (a > Math.PI) return ((a + Math.PI) % (2 * Math.PI)) - Math.PI;
  if (a < -Math.PI) return ((a - Math.PI) % (2 * Math.PI)) + Math.PI;
  return a;
}

const num = (a) => {
  if (a && typeof a === 'object') {
    if ('den' in a) return a.den ? a.num / a.den : a.num;
    if ('c4' in a) return a.c4;
    return 0;
  }
  return typeof a === 'number' ? a : 0;
};
const int = (a) => Math.trunc(num(a));
const str = (a) => (typeof a === 'string' ? a : '');

function placement(op, args) {
  const id = gimmickId(int(args[1]));
  // `0x21` reads a rotation after the position and `0x22` does not, so the
  // sixth argument is an angle in one and just another number in the other.
  const keyed = op === OP_GIMMICK && args.length > 5;
  return {
    op, slot: int(args[0]), number: int(args[1]),
    gimmick: id, name: gimmickName(id),
    pos: [num(args[2]), num(args[3]), num(args[4])],
    rot: keyed ? wrapAngle(num(args[5])) : 0,
    extra: args.slice(keyed ? 6 : 5).map(num),
    archive: gimmickName(id) ? 'DATA/GIMMICK/' + gimmickName(id) + '.ARC' : null,
  };
}

function runMaster(blob, out) {
  let pendingModel = null;
  for (const call of ssc.parse(blob)) {
    if (call.op === null) continue;
    const op = call.op, args = call.args;
    if (op === OP_LABEL) out.labels.push(args.length ? str(args[0]) : '');
    else if (op === OP_MAP && args.length) out.mapIndex = int(args[0]);
    else if (op === OP_PLAYER && args.length >= 4)
      out.player = { pos: [num(args[0]), num(args[1]) + PLACE_Y_BIAS,
                           num(args[2])],
                     angle: wrapAngle(num(args[3])) };
    else if (op === OP_ACTOR_MODEL && args.length) pendingModel = str(args[0]);
    else if (op === OP_ACTOR_AT && args.length >= 5)
      out.actors.push({ model: pendingModel, id: int(args[0]),
                        pos: [num(args[1]), num(args[2]) + PLACE_Y_BIAS,
                              num(args[3])],
                        angle: wrapAngle(num(args[4])),
                        extra: args.slice(5).map(num) });
    else if (op !== OP_MAP && op !== OP_PLAYER && op !== OP_LABEL)
      out.unknown[op] = (out.unknown[op] || 0) + 1;
  }
}

function runRoom(blob, out, room) {
  if (!out.rooms[room]) out.rooms[room] = [];
  for (const call of ssc.parse(blob)) {
    if (call.op === null) continue;
    const op = call.op, args = call.args;
    if ((op === OP_GIMMICK || op === OP_GIMMICK2) && args.length >= 5)
      out.rooms[room].push(placement(op, args));
    else if (op !== OP_PLACE)
      out.unknown[op] = (out.unknown[op] || 0) + 1;
  }
}

/** `Map` of member name -> blob from one `B##EVENT.ARC` -> a stage script. */
function parse(members, number, archive) {
  const out = { number: number === undefined ? -1 : number,
                archive: archive || '', mapIndex: null, player: null,
                actors: [], rooms: {}, labels: [], unknown: {} };
  const names = [...members.keys()].sort();
  for (const name of names) {
    const low = name.toLowerCase();
    if (EVSUB_RE.test(low)) continue;
    if (low.endsWith('event.ssc')) runMaster(members.get(name), out);
  }
  for (const name of names) {
    const m = EVSUB_RE.exec(name.toLowerCase());
    if (m) runRoom(members.get(name), out, m[1]);
  }
  return out;
}

async function load(disc, path) {
  const blob = await disc.read(path);
  if (!blob) throw new Error('no such stage script: ' + path);
  return parse(arcMod.members(blob), -1, path);
}

const api = { parse, load, gimmickId, gimmickName, wrapAngle, placement,
              PLACE_Y_BIAS, OP_MAP, OP_PLAYER, OP_GIMMICK, OP_GIMMICK2,
              OP_ACTOR_MODEL, OP_ACTOR_AT };
if (typeof module !== 'undefined') module.exports = api;
if (typeof window !== 'undefined') window.TraptStageScript = api;
})();
