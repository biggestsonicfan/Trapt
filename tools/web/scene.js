/**
 * Compile a whole cutscene into one timeline -- `tools/scene.py` in the
 * browser.  This is the keystone: `smi`/`sai`/`tm2` give assets, and this
 * decides which actor wears which model, plays which clip at which frame, in
 * which room, under which camera.
 *
 * A cutscene is a bundle of parallel `.ssc` tracks sharing one frame counter:
 * a master/director track spawns the rest (`0x06`), and `0x04 at_time` is the
 * clock every other call hangs off.
 *
 * Four things here are hard-won and silent when wrong -- see scene.py:
 *
 *  - **`0xA2` visibility is a property of the track, not the open block.**
 *    Most are emitted outside any `0x64 ... 0x65` pair; scoping them to the
 *    block keeps only the first and leaves every actor on screen all scene.
 *  - **`0x80` is a tint, not a scale** -- a colour on a light block, a
 *    material multiplier on a model.
 *  - **The master track streams each act's animation** with `0x55`, while an
 *    actor's own track names only the clip it started with.  Without folding
 *    those back into the owning entity, every actor freezes after act 1.
 *  - **`x_h.smi` and `x.smi` in one block are alternatives, not parts**: `_h`
 *    is the facial-rig variant.  Drawing both z-fights every character.
 */
(function () {
'use strict';

const ssc = (typeof require !== 'undefined') ? require('./ssc.js') : window.TraptSsc;

const OP_END = 0x00, OP_AT_TIME = 0x04, OP_CUE = 0x05, OP_SPAWN = 0x06;
const OP_SPAWN_FX_AT = 0x07, OP_SPAWN_FX = 0x08;   // spawn a track at a point
const OP_PLAY_ANIM = 0x55, OP_LETTERBOX = 0x57, OP_VOICE = 0x59;
const OP_BGM_START = 0x5A, OP_BGM_STOP = 0x5B;
const OP_FADE_IN = 0x53, OP_FADE_OUT = 0x54;
const OP_SUB_SHOW = 0x60, OP_SUB_HIDE = 0x61, OP_SET_ROOM = 0x62;
const OP_BLOCK_BEGIN = 0x64, OP_BLOCK_END = 0x65, OP_BLOCK_DROP = 0x67;
const OP_TINT = 0x7E;                              // (r, g, b, w); w is not alpha
const OP_SCALE = 0x80, OP_MODEL = 0x82, OP_ANIM = 0x83, OP_TRANSFORM = 0x84;
const OP_VISIBLE = 0xA2, OP_ROOT_BONE = 0xB3, OP_LIGHT_TYPE = 0xB4;
const OP_LIGHT_RANGE = 0xB5, OP_ATTACH = 0xB7, OP_CAMERA = 0xB9, OP_FOG = 0xC7;
// `0xB2 (name, show, 0)` FUN_001C20C0 -> 0x1D53F0: hides the model's node
// `name` and everything under it, through a list of up to four names at model
// +0x22C (show 0 adds the name, 1 takes it out).  On the disc it is always
// "buki", the weapon: e001's guards and courtiers are posed holding nothing.
const OP_HIDE_PART = 0xB2;
// Sprite effects.  Handlers, from the dispatch table at 0x00376660:
//   0x68 FUN_001C4C90  string + 4 ints -> effect vtable +0x80
//   0x6D FUN_001C47F0  two numbers + a frame -> a keyframe list
//   0x6E FUN_001C46A0  four numbers + a frame -> another keyframe list
//   0xCA FUN_001C1D50  actor + bone; asserts the effect's kind is 3
const OP_FX_TEXTURE = 0x68, OP_FX_SIZE_KEY = 0x6D, OP_FX_COLOUR_KEY = 0x6E;
const OP_FX_EMIT_A = 0xC8, OP_FX_EMIT_B = 0xC9, OP_FX_BIND_BONE = 0xCA;
// `0xAA` and `0xAB` dispatch to the *same handlers* as `0x6E` and `0x6D`
// (FUN_001C46A0 and FUN_001C47F0), so they are aliases and not new opcodes:
// one keyframe implementation shared by the sprite and particle paths.
// e001's torch flame uses only the `0xAA`/`0xAB` spelling, which is why it had
// no colour ramp and no growth until these were read.
const OP_FX_COLOUR_KEY2 = 0xAA, OP_FX_SIZE_KEY2 = 0xAB;
// `0x9F` FUN_001C4A50 -- the sheet's grid and how fast it is played.
// arg1 -> columns, arg2 -> rows, arg3 -> cell count, each defaulting to the
// derived value when the script passes 0.  The handler derives columns as
// `sheet_w / cell_w` and rows as `sheet_h / cell_h` from the fields `0x68`
// filled in, which is what proves `0x68` carries (cell w, cell h, sheet w,
// sheet h).  It then writes `arg0 * cells` to +0xb4; for e001's torch that is
// 4 * (4*8) = 128, exactly where its `0xAA` alpha keys end -- so arg0 is
// **frames per cell** and +0xb4 the particle's whole life.
const OP_FX_GRID = 0x9F;
// `0x6C` FUN_001C45C0 -- six flags.  The handler coerces each of its six
// values with `!= 0` and passes them to a vtable method, so they are switches
// rather than numbers, and the fourth is the one that shows.
//
// Eight sprite blocks on the disc carry a `0x6C`.  The fourth flag is set on
// four of them: the three that draw `ef_s014c.tm2` and one that draws
// `ef_e129d.tm2`.  Measured out of the pixels, those two are also the only
// two of the sixteen sprite textures whose alpha does not peak in the middle
// -- `ef_s014c.tm2` is a radial falloff centred on its bottom-right *corner*
// -- and the five centred textures that carry a `0x6C` all have it clear.
//
// So the flag says the tile is one quadrant and the sprite is it mirrored
// into four, which puts that corner at the middle and makes the glow round.
// Drawn flat it is a hard-edged square, opaque along two of its sides.
const OP_FX_QUAD_FLAGS = 0x6C;

const KIND_MODEL = 4, KIND_LIGHT = 6, KIND_CAMERA = 7;
const LIGHT_KINDS = { 0: 'directional', 1: 'point', 4: 'ambient', 5: 'black' };
const LETTERBOX_MODES = { 0: 'in', 1: 'out' };
const VIS_HIDDEN = 0x80000000;   // bit 31 of the track's flag word
const BS = String.fromCharCode(92);
const NL = BS + 'n';
const NUL = BS + '0';

const num = (a) => {
  if (a && typeof a === 'object') {
    if ('den' in a) return a.den ? a.num / a.den : a.num;
    if ('c4' in a) return a.c4;
    return 0;
  }
  return typeof a === 'number' ? a : 0;
};
const int = (a) => Math.trunc(num(a));
const isStr = (a) => typeof a === 'string';

/** Split a `0x60` payload into speaker and lines. */
function text(raw) {
  raw = raw.replace(/\0+$/, '').split(NUL).join('');
  let speaker = '';
  if (raw.startsWith('%%SCSV') && raw.indexOf('%%RC') >= 0) {
    const i = raw.indexOf('%%RC');
    speaker = raw.slice(6, i);
    raw = raw.slice(i + 4);
    if (raw.startsWith(NL)) raw = raw.slice(2);
  }
  return { speaker: ssc.plain(speaker), lines: raw.split(NL).map(ssc.plain) };
}

function newEntity(track, index, kind, label) {
  return { track: track, index: index, kind: kind, label: label,
           models: [], attachments: [], rootBone: null, transform: null,
           scale: null, clips: [], visibility: [], parts: [], light: null,
           lightRange: null, lightParent: false, origin: null, tint: null,
           start: 0, end: null,
           // Sprite effects: a block naming a texture instead of a model.
           sprite: null, sizeKeys: [], colourKeys: [], binds: [],
           emitter: null, grid: null, flags: null, mirror: false,
           trackLen: null, fx: null, block: 0, size: null, billboard: 0,
           pull: 0, act: null };
}

// ---------------------------------------------------------------- effect VM
//
// An effect track is not a timeline but a **per-frame program**.  The game
// runs it from the top every frame (FUN_001C8A10, dispatch table 0x00376660)
// with a local clock at vm+0xb0, a condition flag at vm+0xac and a bank of
// registers the `C5` argument tag names:
//
//   0x04 (a, b, c)    cond = clock == a; with c > 0, every c frames from a
//   0x03 n            if !cond, skip the next n calls
//   0xA4 n            cond = r16 == n: r16 is the track's state
//   0x0D-0x1C, 0xA0, 0xA1, 0xA5, 0xA6, 0xA9
//                     one calculator, 0x001C7240: (dst, a, b, mode, op),
//                     mode 1 float / 0 int; op 0 set 1 add 2 sub 3 mul 4 div
//                     8 wrap dst into [a, b]; 9 clamp dst into [a, b];
//                     10 compare (x, y, cmp) -> cond
//   0x7C (u, v, m)    material m's UV offset   (model vtable +0x60)
//   0x7D (a, m)       material m's alpha       (model vtable +0x5C)
//   0x7E (r,g,b,a, m) material m's colour and alpha
//   0x84 / 0x8C       one handler, 0x001C15D0: (x, y, z, mode), the mode
//                     picking a model method at +0x88 + 4*mode.  The disc
//                     uses mode 0 with 0x84 (1818 times: position) and mode
//                     8 with 0x8C (1049: scale) and nothing else
//   0x01              this frame is done;  0x00 the track is over
//
// `m` is the .SMI material's flags word (+0x40), not its index.
// `ef_e004_20` is the whole idea in one file: at clock 0 it builds the fire
// mesh and zeroes four registers; every frame it fades two materials in
// (r6 += .008 while r6 <= .4) and scrolls their UVs; at 50 it sets r16 = 10,
// and state 10 knocks both alphas below zero and ends the track.  Read as a
// timeline it drew the fire for the rest of the cutscene.
const FX_YIELD = 0x01, FX_SKIP = 0x03, FX_STATE = 0xA4;
const FX_UV = 0x7C, FX_ALPHA = 0x7D, FX_CMP = 0xA6;
const FX_STATE_REG = 16;
const OP_PLACE = 0x8C;                            // 0x84's handler, scale mode
const PLACE_POS = 0, PLACE_SCALE = 8;
// `0xB8(name, mode)` hands both to model method +0x84.  The disc only ever
// writes ("none", 3), 45 times, and every model it is written for is a flat
// XY card -- ef_m061_10's fire is a radius-1 disc with z = 0 -- so mode 3 is
// face-the-camera.  e004 1646 proves it: the camera sits level with the
// fire's z there, and a card left in the XY plane vanishes edge-on.
const OP_BILLBOARD = 0xB8;
// `0xAC(f)` pulls the block f world units toward the camera, every frame --
// a depth push, not a blend.  The handler (0x1C4550) hands f to vtable +0xD4.
// On the effect class (vtable 0x4785D0, block kinds 1/2/3/8) that is
// 0x1D8EE0 -> 0x21D720: the drawable stores -f at +0x20C and sets bit 0x20,
// and the draw (0x2202EC, 0x22152C, 0x222C5C) adds
// +0x20C * normalize(pos - eye) to the position.  The model class
// (0x1D76F0 -> 0x1D8BEC) does the same to its world matrix.  e004's glow
// sprites use 2 and 3: pulled through the fire mesh they sit in, they are
// drawn whole instead of cut by it.
const OP_TOWARD_EYE = 0xAC;
const FX_MAX_FRAMES = 3600;
// The dispatch table sends these to the calculator too; Allura's e004 fade
// clamps with 0xA1.
const FX_CALC_EXTRA = [0xA0, 0xA1, 0xA5, FX_CMP, 0xA9];
const isCalc = (op) => (op >= 0x0D && op <= 0x1C) || FX_CALC_EXTRA.includes(op);
const isReg = (a) => !!(a && typeof a === 'object' && 'reg' in a);

/**
 * Run an effect track's program frame by frame.  Returns null for a track
 * that never touches a register or a material (a plain timeline, which `run`
 * already reads), else `{end, mats}`: the local frame the track ended on
 * (null if it outlives FX_MAX_FRAMES) and, per material id, one
 * `[alpha, u, v, r, g, b]` per local frame -- what that frame drew with.
 */
function fxRun(calls) {
  calls = calls.filter((c) => c.op !== null);
  if (!calls.some((c) => c.op === FX_UV || c.op === FX_ALPHA
                         || c.args.some(isReg))) return null;
  const R = new Map();
  const val = (a) => (isReg(a) ? (R.get(a.reg) || 0) : num(a));
  const mats = new Map();
  const mat = (id) => {
    if (!mats.has(id)) mats.set(id, { now: [1, 0, 0, 1, 1, 1], frames: [] });
    return mats.get(id);
  };
  // Which block each call belongs to, so a track with two blocks moves each
  // on its own; `run` numbers the entities it makes the same way.
  const blockOf = [];
  let blk = -1;
  for (const c of calls) { if (c.op === OP_BLOCK_BEGIN) blk++; blockOf.push(blk); }
  const place = new Map();       // block -> {now: [px,py,pz, sx,sy,sz], frames}
  let cond = false;
  for (let t = 0; t < FX_MAX_FRAMES; t++) {
    let ended = false;
    for (let pc = 0; pc < calls.length; pc++) {
      const { op, args } = calls[pc];
      if (op === OP_END) { ended = true; break; }
      if (op === FX_YIELD) break;
      if (op === FX_SKIP) { if (!cond) pc += int(args[0]); continue; }
      if (op === OP_AT_TIME) {
        const a = int(args[0]), b = int(args[1]), c = int(args[2]);
        if (c > 0) cond = t >= a && (b < 0 || t <= b) && (t - a) % c === 0;
        else if (b >= 0) cond = t >= a && t <= b;
        else cond = t === a;
        continue;
      }
      if (op === FX_STATE) { cond = (R.get(FX_STATE_REG) || 0) === int(args[0]); continue; }
      if (isCalc(op) && args.length >= 5) {
        const fl = int(args[3]) === 1, kind = int(args[4]);
        const fix = (x) => (fl ? x : Math.trunc(x));
        if (kind === 10) {
          const x = fix(val(args[0])), y = fix(val(args[1]));
          cond = [x === y, x > y, x < y, x >= y, x <= y, x !== y][int(args[2])] || false;
          continue;
        }
        if (!isReg(args[0])) continue;
        const a = fix(val(args[1])), b = fix(val(args[2]));
        let r = R.get(args[0].reg) || 0;
        if (kind === 0) r = a;
        else if (kind === 1) r = a + b;
        else if (kind === 2) r = a - b;
        else if (kind === 3) r = a * b;
        else if (kind === 4) r = b ? a / b : 0;
        else if (kind === 8 && b > a) r = a + ((((r - a) % (b - a)) + (b - a)) % (b - a));
        else if (kind === 9) r = Math.min(b, Math.max(a, r));
        else continue;
        R.set(args[0].reg, fix(r));
        continue;
      }
      if (op === FX_ALPHA && args.length >= 2) mat(int(args[1])).now[0] = val(args[0]);
      else if (op === FX_UV && args.length >= 3) {
        const m = mat(int(args[2])).now;
        m[1] = val(args[0]); m[2] = val(args[1]);
      } else if (op === OP_TINT && args.length >= 5) {
        const m = mat(int(args[4])).now;
        m[3] = val(args[0]); m[4] = val(args[1]); m[5] = val(args[2]);
        m[0] = val(args[3]);
      } else if ((op === OP_TRANSFORM || op === OP_PLACE) && args.length >= 4) {
        const mode = int(args[3]);
        if (mode !== PLACE_POS && mode !== PLACE_SCALE) continue;
        if (!place.has(blockOf[pc]))
          place.set(blockOf[pc], { now: [null, null, null, 1, 1, 1], frames: [] });
        const now = place.get(blockOf[pc]).now, k = mode === PLACE_POS ? 0 : 3;
        for (let i = 0; i < 3; i++) now[k + i] = val(args[i]);
      }
    }
    if (ended) return { end: t, mats: mats, place: place };
    for (const m of mats.values()) m.frames.push(m.now.slice());
    for (const m of place.values()) m.frames.push(m.now.slice());
  }
  return { end: null, mats: mats, place: place };
}

/**
 * A material's `[alpha, u, v, r, g, b]` at local frame `t`, or null.  With
 * `fx.place` and a block number, that block's `[px, py, pz, sx, sy, sz]`
 * instead -- position null where the program never set one.
 */
function fxAt(fx, id, t, table) {
  const m = fx && (table || fx.mats).get(id);
  if (!m || !m.frames.length) return null;
  return m.frames[Math.max(0, Math.min(m.frames.length - 1, t))];
}

// ---------------------------------------------------------------- actor VM
//
// An actor track is the same VM, but not restarted every frame: it keeps its
// place.  `0x04 (t)` then `0x05 (0, #k)` is a wait -- until the clock reaches
// t, jump back to call k and end the frame -- so a few calls between two
// waits run once per frame.  Allura's e004 track is the case on screen:
//
//   0xB0 (0, 2)                      hide material 2, her gauntlet, at once
//   at 1430: 0xB0 (1, 2), r0 = 0     show it, then every frame until 1530
//            r0 += .01, clamp [0,1], 0x7D (r0, 2)        fade it in
//   at 1750: the same with -= until 1850                 and out again
//
// `0xB0 (on, m)` (0x001C2E00) hands (m, on, 1) to model vtable +0x68, which
// shows or hides every material whose flags word is m.  `0x9D (a, m)` goes
// to +0x38; it comes right before the fade, so it is taken to switch m to
// the blend unit, which any alpha below 1 here does anyway.
const OP_MAT_SHOW = 0xB0;
const ACT_MAX_FRAMES = 30000;

/**
 * Run an actor track's material program.  Null when the track never touches
 * a material, else `{mats}` as `fxRun` returns it, indexed by track clock
 * (the scene's frame), and two more fields: 1 shown / 0 hidden by `0xB0`,
 * and 1 once a `0x7E` has set the colour.
 * The tables stop at the last change; `fxAt` holds the last row after it.
 */
function actorRun(calls) {
  calls = calls.filter((c) => c.op !== null);
  if (!calls.some((c) => c.op === FX_UV || c.op === FX_ALPHA || c.op === OP_MAT_SHOW
                         || (c.op === OP_TINT && c.args.length >= 5))) return null;
  const R = new Map();
  const val = (a) => (isReg(a) ? (R.get(a.reg) || 0) : num(a));
  const mats = new Map();
  const mat = (id) => {
    if (!mats.has(id)) mats.set(id, { now: [1, 0, 0, 1, 1, 1, 1, 0], frames: [] });
    return mats.get(id);
  };
  let pc = 0, cond = false, last = -1;
  for (let t = 0; t < ACT_MAX_FRAMES && pc < calls.length; t++) {
    let touched = false;
    for (let steps = 0; pc < calls.length && steps < 10000; steps++) {
      const { op, args } = calls[pc++];
      if (op === OP_END) { pc = calls.length; break; }
      if (op === FX_YIELD) break;
      if (op === OP_AT_TIME) {
        // A wait has to fire even if it is reached late, so `>=`.
        const a = int(args[0]), b = int(args[1]), c = int(args[2]);
        if (c > 0) cond = t >= a && (b < 0 || t <= b) && (t - a) % c === 0;
        else cond = t >= a && (b < 0 || t <= b);
        continue;
      }
      if (op === OP_CUE) {
        const k = args.length > 1 && args[1] && typeof args[1] === 'object' ? args[1].c4 : null;
        if (!cond && k !== null && k !== undefined) { pc = k; break; }
        continue;
      }
      if (op === FX_SKIP) { if (!cond) pc += int(args[0]); continue; }
      if (op === FX_STATE) { cond = (R.get(FX_STATE_REG) || 0) === int(args[0]); continue; }
      if (isCalc(op) && args.length >= 5) {
        const fl = int(args[3]) === 1, kind = int(args[4]);
        const fix = (x) => (fl ? x : Math.trunc(x));
        if (kind === 10) {
          const x = fix(val(args[0])), y = fix(val(args[1]));
          cond = [x === y, x > y, x < y, x >= y, x <= y, x !== y][int(args[2])] || false;
          continue;
        }
        if (!isReg(args[0])) continue;
        const a = fix(val(args[1])), b = fix(val(args[2]));
        let r = R.get(args[0].reg) || 0;
        if (kind === 0) r = a;
        else if (kind === 1) r = a + b;
        else if (kind === 2) r = a - b;
        else if (kind === 3) r = a * b;
        else if (kind === 4) r = b ? a / b : 0;
        else if (kind === 8 && b > a) r = a + ((((r - a) % (b - a)) + (b - a)) % (b - a));
        else if (kind === 9) r = Math.min(b, Math.max(a, r));
        else continue;
        R.set(args[0].reg, fix(r));
        continue;
      }
      if (op === FX_ALPHA && args.length >= 2) {
        mat(int(args[1])).now[0] = val(args[0]); touched = true;
      } else if (op === FX_UV && args.length >= 3) {
        const m = mat(int(args[2])).now;
        m[1] = val(args[0]); m[2] = val(args[1]); touched = true;
      } else if (op === OP_TINT && args.length >= 5) {
        const m = mat(int(args[4])).now;
        m[3] = val(args[0]); m[4] = val(args[1]); m[5] = val(args[2]);
        m[0] = val(args[3]); m[7] = 1; touched = true;
      } else if (op === OP_MAT_SHOW && args.length >= 2) {
        mat(int(args[1])).now[6] = int(args[0]) ? 1 : 0; touched = true;
      }
    }
    for (const m of mats.values()) m.frames.push(m.now.slice());
    if (touched) last = t;
  }
  for (const m of mats.values()) m.frames.length = Math.min(m.frames.length, last + 1);
  return { mats: mats };
}

/**
 * Linear interpolation over `[[frame, ...values], ...]`, held at both ends.
 *
 * Keys arrive in script order, which is ascending on the disc.  Before the
 * first and after the last the value is held rather than extrapolated --
 * `ef_e004_30`'s alpha ends on 0 and an extrapolated fifth key would drive it
 * negative.
 */
function sample(keys, t, fallback) {
  if (!keys.length) return fallback;
  if (t <= keys[0][0]) return keys[0].slice(1);
  if (t >= keys[keys.length - 1][0]) return keys[keys.length - 1].slice(1);
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    if (a[0] <= t && t <= b[0]) {
      const span = b[0] - a[0];
      const f = span <= 0 ? 0 : (t - a[0]) / span;
      return a.slice(1).map((av, k) => av + (b[k + 1] - av) * f);
    }
  }
  return keys[keys.length - 1].slice(1);
}

const sizeAt = (e, local) => sample(e.sizeKeys, local, [1, 1]);
const colourAt = (e, local) => sample(e.colourKeys, local, [1, 1, 1, 1]);

/**
 * `frameBase` and `origin` are non-zero only for a track spawned by 0x07/0x08:
 * an effect track times everything from the moment it was spawned, and is
 * placed at the world position the spawn named.
 */
function run(scene, trackName, blob, frameBase, origin) {
  frameBase = frameBase || 0;
  origin = origin || null;
  let frame = frameBase, entity = null, pendingVoice = null, blocks = 0;
  const trackVis = [];
  const calls = ssc.parse(blob);
  for (const call of calls) {
    if (call.op === null) continue;
    const code = call.op, args = call.args;
    if (code === OP_AT_TIME) { if (args.length) frame = int(args[0]) + frameBase; continue; }
    if (code === OP_CUE) continue;
    scene.events.push({ frame: frame, track: trackName, code: code, args: args });

    if (code === OP_SET_ROOM) scene.room = args[0];
    else if (code === OP_SPAWN) scene.tracks.push(args[0]);
    // ELF 0x001C8790 (0x08) reads a string then three floats into a {x,y,z,1}
    // vec4 and hands it to the same spawner 0x06 uses; 0x001C8860 (0x07) adds
    // the position to a looked-up target instead.  Unlike 0x06 the same track
    // spawns many times, at different places and frames, so these are
    // instances rather than names.
    else if (code === OP_SPAWN_FX || code === OP_SPAWN_FX_AT)
      scene.effects.push({ frame: frame, track: args[0],
        pos: args.slice(1, 4).map(num),
        target: code === OP_SPAWN_FX_AT && args.length > 4 ? int(args[4]) : null });
    else if (code === OP_CAMERA) scene.cameraFile = args[1];
    else if (code === OP_BGM_START) scene.bgm.push([frame, 'start', int(args[0])]);
    else if (code === OP_BGM_STOP) scene.bgm.push([frame, 'stop', int(args[0])]);
    else if (code === OP_FADE_IN) scene.fades.push([frame, 'in', int(args[0])]);
    else if (code === OP_FADE_OUT) scene.fades.push([frame, 'out', int(args[0])]);
    else if (code === OP_LETTERBOX)
      scene.letterbox.push([frame,
        LETTERBOX_MODES[int(args[0])] || 'hold',
        Math.max(1, args.length > 1 ? int(args[1]) : 1)]);
    else if (code === OP_VOICE) pendingVoice = args[0];
    else if (code === OP_SUB_SHOW) {
      const t = text(args[0]);
      scene.subtitles.push({ frame: frame, speaker: t.speaker, lines: t.lines,
                             voice: pendingVoice, raw: args[0], end: null });
      pendingVoice = null;
    } else if (code === OP_SUB_HIDE) {
      const last = scene.subtitles[scene.subtitles.length - 1];
      if (last && last.end === null) last.end = frame;
    } else if (code === OP_FOG) {
      scene.fog = args.slice(0, 5).map(num);
    } else if (code === OP_BLOCK_BEGIN) {
      entity = newEntity(trackName, scene.entities.length,
                         args.length ? int(args[0]) : null,
                         args.length > 1 && isStr(args[1]) ? args[1] : null);
      entity.start = frame;
      entity.origin = origin;
      entity.block = blocks++;
      scene.entities.push(entity);
    // ------------------------------------------------------ sprite effects
    // A sprite effect names a **texture** here where a model effect names an
    // `.smi` with `0x82`.  The four ints are (cell w, cell h, sheet w,
    // sheet h): `ef_p_s_00.tm2` is `32 32 256 256`, an 8x8 grid of 32-pixel
    // cells on a sheet that really is 256x256.  Where the declared sheet
    // disagrees with the file -- five textures do -- the cell is the whole
    // sheet, so the UV rect is the whole image either way.
    } else if (code === OP_FX_TEXTURE && entity && args.length) {
      const n = args.slice(1, 5).map(num);
      while (n.length < 4) n.push(0);
      entity.sprite = { texture: isStr(args[0]) ? args[0] : '',
                        cell: [n[0], n[1]], sheet: [n[2], n[3]] };
    } else if (code === OP_FX_QUAD_FLAGS && entity && args.length >= 6) {
      entity.flags = args.slice(0, 6).map((a) => !!num(a));
      entity.mirror = entity.flags[3];
    // `0x6D(sx, sy, frame)` and `0x6E(r, g, b, a, frame)` are keyframes, and
    // the data says so plainly: in `ef_e004_30.ssc` the `0x6D` pairs run
    // (0.5,0.5)@0 (2,2)@10 (4,4)@140 (4.5,4.5)@240 -- always equal, always
    // growing -- while the `0x6E` quads hold (1.5,0.2,0.1) and move the
    // fourth 0 -> 1.8 -> 1.8 -> 0 over the same span.
    } else if ((code === OP_FX_SIZE_KEY || code === OP_FX_SIZE_KEY2)
               && entity && args.length >= 3) {
      entity.sizeKeys.push([num(args[2]), num(args[0]), num(args[1])]);
    } else if ((code === OP_FX_COLOUR_KEY || code === OP_FX_COLOUR_KEY2)
               && entity && args.length >= 5) {
      entity.colourKeys.push([num(args[4]), num(args[0]), num(args[1]),
                              num(args[2]), num(args[3])]);
    // `0xCA(actor, bone, ?)` binds the emitter to a bone.  `FUN_001C1D50`
    // requires the effect object's kind to be 3 -- exactly the block kind
    // these appear in -- then resolves the actor and the bone by name.
    } else if (code === OP_FX_BIND_BONE && entity && args.length >= 2) {
      entity.binds.push([isStr(args[0]) ? args[0] : '',
                         isStr(args[1]) ? args[1] : '']);
    } else if (code === OP_FX_GRID && entity && args.length >= 3) {
      const cell = entity.sprite ? entity.sprite.cell : [1, 1];
      const sheet = entity.sprite ? entity.sprite.sheet : [1, 1];
      const cols = int(args[1]) || (cell[0] ? Math.floor(sheet[0] / cell[0]) : 1);
      const rows = int(args[2]) || (cell[1] ? Math.floor(sheet[1] / cell[1]) : 1);
      const cells = (args.length > 3 ? int(args[3]) : 0) || (cols * rows);
      const rate = int(args[0]);
      entity.grid = { rate, cols, rows, cells, life: rate * cells };
    } else if ((code === OP_FX_EMIT_A || code === OP_FX_EMIT_B) && entity) {
      // Structure only: what these steer is not established, so they are
      // carried and not used.
      if (!entity.emitter) entity.emitter = {};
      entity.emitter[code.toString(16)] = args.map(num);
    } else if (code === OP_TINT && entity) {
      // Four floats.  The first three are a colour -- (0.6, 0.2, 0.1) recurs,
      // a torch orange.  The fourth is NOT alpha: it reaches 1.5 across the
      // disc, so it is an intensity or a ramp, kept but not yet applied.
      entity.tint = args.slice(0, 4).map(num);
    } else if (code === OP_BLOCK_END) {
      entity = null;
    } else if (code === OP_BLOCK_DROP) {
      for (let i = scene.entities.length - 1; i >= 0; i--)
        if (scene.entities[i].track === trackName && scene.entities[i].end === null) {
          scene.entities[i].end = frame;
          break;
        }
    } else if (code === OP_VISIBLE) {
      trackVis.push([frame, !((int(args[0]) & VIS_HIDDEN) && int(args[1]))]);
    } else if (code === OP_HIDE_PART) {
      // Emitted inside the block and, to bring the weapon back, after it; the
      // handler acts on the track's current model either way.
      let owner = entity;
      for (let i = scene.entities.length - 1; i >= 0 && !owner; i--)
        if (scene.entities[i].track === trackName) owner = scene.entities[i];
      if (owner) owner.parts.push([frame, args[0], !!int(args[1])]);
    } else if (entity !== null) {
      if (code === OP_MODEL) entity.models.push(args[0]);
      // arg[3] is a C2 rational (a blend) 588 times on the disc and a C1
      // integer exactly once: c21m_b_e001.sai at 8430, carrying 8431.  That
      // clip is authored in absolute scene time -- it runs the full 11890
      // frames and parks the body at y=-18.9, under the floor, outside its
      // own window -- so the integer is where in the clip to start.
      else if (code === OP_ANIM)
        entity.clips.push([frame, args[0],
          args.length > 3 && typeof args[3] === 'number' ? args[3] : 0]);
      else if (code === OP_ROOT_BONE) entity.rootBone = args[0];
      else if (code === OP_BILLBOARD) entity.billboard = args.length > 1 ? int(args[1]) : 3;
      else if (code === OP_TOWARD_EYE && args.length && !isReg(args[0])) entity.pull = num(args[0]);
      else if (code === OP_ATTACH)
        entity.attachments.push([args[0], args[1],
                                 args.length > 2 ? num(args[2]) : 1.0]);
      else if (code === OP_TRANSFORM) entity.transform = args.slice(0, 4).map(num);
      else if (code === OP_SCALE) entity.scale = args.slice(0, 4).map(num);
      // Mode 8 of the transform call: a true scale, unlike 0x80.  Register
      // arguments are the effect VM's to resolve, frame by frame.
      else if (code === OP_PLACE && args.length >= 4 && int(args[3]) === PLACE_SCALE
               && !args.slice(0, 3).some(isReg))
        entity.size = args.slice(0, 3).map(num);
      else if (code === OP_LIGHT_TYPE) {
        entity.light = LIGHT_KINDS[args.length ? int(args[0]) : -1] || 'unknown';
        entity.lightParent = !!(args.length > 1 && num(args[1]));
      } else if (code === OP_LIGHT_RANGE)
        entity.lightRange = args.slice(0, 2).map(num);
    }
    if (code === OP_END) break;
  }
  // Only a spawned effect is a per-frame program.  Actor tracks use the same
  // registers -- Allura's in e004 fades her material 2 with r0 -- but they are
  // cue-driven timelines (`0x04` then `0x05` waits), and run frame by frame
  // the end_track at their foot fires on frame 0.
  const fx = origin ? fxRun(calls) : null;
  const act = origin ? null : actorRun(calls);
  for (const e of scene.entities)
    if (e.track === trackName) {
      e.visibility = trackVis.slice();
      // Shared by the track's blocks: materials are addressed by flags word.
      if (act) e.act = act;
      // Shared, not copied: every block of one spawn runs the same program.
      if (fx && e.start >= frameBase) {
        e.fx = fx;
        if (fx.end !== null && e.trackLen === null) e.trackLen = fx.end;
      }
      // How long the track ran.  A sprite block with no `0x6E` alpha keys
      // has nothing else saying when it is over -- e004's spark tracks are
      // thirty frames long and carry only `0x80` and the emitter -- so
      // without this they would burn until the cutscene ended.  It is a
      // *length* and not an end frame because the same track is spawned more
      // than once: `ef_e004_12` runs at 1172 and again at 1182, and an
      // absolute end would give the second spawn the first one's.
      if (e.trackLen === null) e.trackLen = frame - frameBase;
    }
}

/** `c01f_a_e001_2.sai` -> `c01f_a_e001`, the per-act clip family. */
function family(clipName) {
  const stem = clipName.replace(/\.[^.]*$/, '');
  const i = stem.lastIndexOf('_');
  if (i < 0) return stem;
  const tail = stem.slice(i + 1);
  return tail.length && /^\d+$/.test(tail) ? stem.slice(0, i) : stem;
}

/** Fold the master track's per-act `0x55` into the entity that owns the rig. */
function mergeMasterClips(scene) {
  const byFamily = new Map(), byModel = new Map();
  for (const e of scene.entities) {
    for (const [, name] of e.clips)
      if (!byFamily.has(family(name))) byFamily.set(family(name), e);
    for (const m of e.models) {
      const k = m.replace(/\.[^.]*$/, '');
      if (!byModel.has(k)) byModel.set(k, e);
    }
  }
  for (const ev of scene.events) {
    if (ev.code !== OP_PLAY_ANIM || !ev.args.length || !isStr(ev.args[0])) continue;
    const name = ev.args[0];
    let owner = byFamily.get(family(name));
    if (!owner) {
      const stem = family(name);
      for (const [key, e] of byModel)
        if (stem.startsWith(key) || key.startsWith(stem)) { owner = e; break; }
    }
    if (!owner) continue;
    if (!owner.clips.some((c) => c[0] === ev.frame && c[1] === name))
      owner.clips.push([ev.frame, name, 0]);
  }
  for (const e of scene.entities)
    e.clips.sort((a, b) => (a[0] - b[0]) || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
}

/**
 * Walk the master track and everything it spawns.
 * `assets` is a Map of lower-case member name -> bytes.
 */
function compile(name, assets) {
  const scene = {
    name: name, room: null, duration: 0, entities: [], subtitles: [],
    bgm: [], fades: [], letterbox: [], cameraFile: null, fog: null,
    events: [], tracks: [], effects: [], opcounts: {},
  };
  const masterName = 'rt_' + name + '.ssc';
  const master = assets.get(masterName);
  if (!master) throw new Error('no master track ' + masterName);

  run(scene, masterName, master);
  const seen = new Set([masterName]);
  const queue = scene.tracks.slice();
  while (queue.length) {
    const t = queue.shift();
    const key = t.toLowerCase().replace(/\.sss$/, '.ssc');
    if (seen.has(key)) continue;
    seen.add(key);
    const blob = assets.get(key);
    if (!blob) continue;
    const before = scene.tracks.length;
    run(scene, key, blob);
    for (let i = before; i < scene.tracks.length; i++) queue.push(scene.tracks[i]);
  }

  // Effect tracks last, because the spawns that name them come out of the
  // tracks above.  Each spawn is its own instance: ef_e001_20 is spawned three
  // times at three positions, and each wants its own entities.
  scene.effects.forEach((fx, i) => {
    let key = fx.track.toLowerCase();
    if (!/\.ssc$/.test(key)) key += '.ssc';
    const b2 = assets.get(key);
    if (b2) run(scene, key + '#' + i, b2, fx.frame, fx.pos);
  });

  let last = 0;
  for (const ev of scene.events) if (ev.frame > last) last = ev.frame;
  scene.duration = last + 1;
  mergeMasterClips(scene);
  return scene;
}

/** `_h` and plain are alternatives; prefer the facial-rig one. */
function renderModels(entity) {
  const stems = new Map();
  for (const m of entity.models) stems.set(m.replace(/\.[^.]*$/, ''), m);
  const out = [];
  for (const [stem, file] of stems) {
    if (stem.endsWith('_h')) { out.push(file); continue; }
    if (!stems.has(stem + '_h')) out.push(file);
  }
  return out;
}

/** Which clip is running at `frame`, or null. */
function clipAt(entity, frame) {
  let best = null;
  for (const [start, file, offset] of entity.clips)
    if (start <= frame) best = { start: start, file: file, offset: offset || 0 };
  return best;
}

function visibleAt(entity, frame) {
  if (entity.end !== null && frame >= entity.end) return false;
  let vis = true;
  for (const [f, on] of entity.visibility) if (f <= frame) vis = on;
  return vis;
}

/** The node names `0xB2` has hidden on `entity` at `frame`. */
function hiddenPartsAt(entity, frame) {
  const hidden = new Set();
  for (const [f, name, show] of entity.parts || [])
    if (f <= frame) { if (show) hidden.delete(name); else hidden.add(name); }
  return hidden;
}

const api = { compile, run, fxRun, actorRun, fxAt, mergeMasterClips, family, text, renderModels,
              clipAt, visibleAt, hiddenPartsAt, num, sample, sizeAt, colourAt,
              KIND_MODEL, KIND_LIGHT, KIND_CAMERA };
if (typeof module !== 'undefined') module.exports = api;
if (typeof window !== 'undefined') window.TraptScene = api;
})();
