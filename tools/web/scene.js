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
const OP_PLAY_ANIM = 0x55, OP_LETTERBOX = 0x57, OP_VOICE = 0x59;
const OP_BGM_START = 0x5A, OP_BGM_STOP = 0x5B;
const OP_FADE_IN = 0x53, OP_FADE_OUT = 0x54;
const OP_SUB_SHOW = 0x60, OP_SUB_HIDE = 0x61, OP_SET_ROOM = 0x62;
const OP_BLOCK_BEGIN = 0x64, OP_BLOCK_END = 0x65, OP_BLOCK_DROP = 0x67;
const OP_SCALE = 0x80, OP_MODEL = 0x82, OP_ANIM = 0x83, OP_TRANSFORM = 0x84;
const OP_VISIBLE = 0xA2, OP_ROOT_BONE = 0xB3, OP_LIGHT_TYPE = 0xB4;
const OP_LIGHT_RANGE = 0xB5, OP_ATTACH = 0xB7, OP_CAMERA = 0xB9, OP_FOG = 0xC7;

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
           lightRange: null, lightParent: false, start: 0, end: null };
}

/** Execute one track into `scene`. */
function run(scene, trackName, blob) {
  let frame = 0, entity = null, pendingVoice = null;
  const trackVis = [];
  for (const call of ssc.parse(blob)) {
    if (call.op === null) continue;
    const code = call.op, args = call.args;
    if (code === OP_AT_TIME) { if (args.length) frame = int(args[0]); continue; }
    if (code === OP_CUE) continue;
    scene.events.push({ frame: frame, track: trackName, code: code, args: args });

    if (code === OP_SET_ROOM) scene.room = args[0];
    else if (code === OP_SPAWN) scene.tracks.push(args[0]);
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
      scene.entities.push(entity);
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
      else if (code === OP_ANIM) entity.clips.push([frame, args[0]]);
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
    if (e.track === trackName) e.visibility = trackVis.slice();
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
      owner.clips.push([ev.frame, name]);
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
    events: [], tracks: [], opcounts: {},
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
  for (const [start, file] of entity.clips)
    if (start <= frame) best = { start: start, file: file };
  return best;
}

function visibleAt(entity, frame) {
  if (entity.end !== null && frame >= entity.end) return false;
  let vis = true;
  for (const [f, on] of entity.visibility) if (f <= frame) vis = on;
  return vis;
}

const api = { compile, run, mergeMasterClips, family, text, renderModels,
              clipAt, visibleAt, num, KIND_MODEL, KIND_LIGHT, KIND_CAMERA };
if (typeof module !== 'undefined') module.exports = api;
if (typeof window !== 'undefined') window.TraptScene = api;
})();
