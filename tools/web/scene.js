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
// Sprite effects.  Handlers, from the dispatch table at 0x00376660:
//   0x68 FUN_001C4C90  string + 4 ints -> effect vtable +0x80
//   0x6D FUN_001C47F0  two numbers + a frame -> a keyframe list
//   0x6E FUN_001C46A0  four numbers + a frame -> another keyframe list
//   0xCA FUN_001C1D50  actor + bone; asserts the effect's kind is 3
const OP_FX_TEXTURE = 0x68, OP_FX_SIZE_KEY = 0x6D, OP_FX_COLOUR_KEY = 0x6E;
const OP_FX_EMIT_A = 0xC8, OP_FX_EMIT_B = 0xC9, OP_FX_BIND_BONE = 0xCA;

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
           scale: null, clips: [], visibility: [], light: null,
           lightRange: null, lightParent: false, origin: null, tint: null,
           start: 0, end: null,
           // Sprite effects: a block naming a texture instead of a model.
           sprite: null, sizeKeys: [], colourKeys: [], binds: [],
           emitter: null, trackLen: null };
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
  let frame = frameBase, entity = null, pendingVoice = null;
  const trackVis = [];
  for (const call of ssc.parse(blob)) {
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
    // `0x6D(sx, sy, frame)` and `0x6E(r, g, b, a, frame)` are keyframes, and
    // the data says so plainly: in `ef_e004_30.ssc` the `0x6D` pairs run
    // (0.5,0.5)@0 (2,2)@10 (4,4)@140 (4.5,4.5)@240 -- always equal, always
    // growing -- while the `0x6E` quads hold (1.5,0.2,0.1) and move the
    // fourth 0 -> 1.8 -> 1.8 -> 0 over the same span.
    } else if (code === OP_FX_SIZE_KEY && entity && args.length >= 3) {
      entity.sizeKeys.push([num(args[2]), num(args[0]), num(args[1])]);
    } else if (code === OP_FX_COLOUR_KEY && entity && args.length >= 5) {
      entity.colourKeys.push([num(args[4]), num(args[0]), num(args[1]),
                              num(args[2]), num(args[3])]);
    // `0xCA(actor, bone, ?)` binds the emitter to a bone.  `FUN_001C1D50`
    // requires the effect object's kind to be 3 -- exactly the block kind
    // these appear in -- then resolves the actor and the bone by name.
    } else if (code === OP_FX_BIND_BONE && entity && args.length >= 2) {
      entity.binds.push([isStr(args[0]) ? args[0] : '',
                         isStr(args[1]) ? args[1] : '']);
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
      else if (code === OP_ATTACH)
        entity.attachments.push([args[0], args[1],
                                 args.length > 2 ? num(args[2]) : 1.0]);
      else if (code === OP_TRANSFORM) entity.transform = args.slice(0, 4).map(num);
      else if (code === OP_SCALE) entity.scale = args.slice(0, 4).map(num);
      else if (code === OP_LIGHT_TYPE) {
        entity.light = LIGHT_KINDS[args.length ? int(args[0]) : -1] || 'unknown';
        entity.lightParent = !!(args.length > 1 && num(args[1]));
      } else if (code === OP_LIGHT_RANGE)
        entity.lightRange = args.slice(0, 2).map(num);
    }
    if (code === OP_END) break;
  }
  for (const e of scene.entities)
    if (e.track === trackName) {
      e.visibility = trackVis.slice();
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

const api = { compile, run, mergeMasterClips, family, text, renderModels,
              clipAt, visibleAt, num, sample, sizeAt, colourAt,
              KIND_MODEL, KIND_LIGHT, KIND_CAMERA };
if (typeof module !== 'undefined') module.exports = api;
if (typeof window !== 'undefined') window.TraptScene = api;
})();
