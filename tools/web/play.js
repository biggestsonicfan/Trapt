/**
 * Assemble a whole cutscene and drive it -- the browser's answer to
 * `tools/export.py` plus the playback half of `player.html`.
 *
 * `scene.js` gives the timeline; this fetches what that timeline names and
 * turns it into three.js objects, then poses them frame by frame.
 *
 * Where the assets come from, in the order `scene.py` resolves them:
 *
 *   DATA/RT/COMMON/RT_COMMON.ARC        shared props
 *   DATA/RT/<NAME>/RT_<NAME>.ARC        the cutscene's own bundle
 *   DATA/RT/COSTUME/RT_C01F_A_HL.ARC    Allura's rig -- she is never in the
 *                                       cutscene bundle, which is why the
 *                                       costume you wear shows up in scenes
 *   DATA/ROOM/<ROOM>_ALL.ARC            the room named by `0x62 set_room`
 *   DATA/RT/<NAME>/*.SAI                clips streamed loose in the AFS
 *
 * Earlier archives lose to later ones only where `scene.py` says so: the
 * cutscene bundle overrides common, and the costume and room only fill gaps.
 */
(function () {
'use strict';

const req = (typeof require !== 'undefined');
const arcMod = req ? require('./arc.js') : window.TraptArc;
const tm2Mod = req ? require('./tm2.js') : window.TraptTm2;
const smiMod = req ? require('./smi.js') : window.TraptSmi;
const saiMod = req ? require('./sai.js') : window.TraptSai;
const camMod = req ? require('./cam.js') : window.TraptCam;
const sceneMod = req ? require('./scene.js') : window.TraptScene;
const modelMod = req ? require('./model.js') : window.TraptModel;

const COMMON = 'DATA/RT/COMMON/RT_COMMON.ARC';
const COSTUME = 'DATA/RT/COSTUME/RT_C01F_A_HL.ARC';

/** Read an archive and fold its members in; `fill` only adds what is missing. */
async function fold(disc, path, assets, fill) {
  const blob = await disc.read(path);
  if (!blob) return false;
  let members;
  try { members = arcMod.members(blob); } catch (e) { return false; }
  for (const [k, v] of members)
    if (!fill || !assets.has(k)) assets.set(k, v);
  return true;
}

/**
 * Load everything one cutscene needs and build its three.js scene graph.
 * `onProgress(text)` is called as it goes; the reads are the slow part.
 */
async function assemble(THREE, disc, name, onProgress) {
  const say = onProgress || (() => {});
  const up = name.toUpperCase();
  const assets = new Map();

  say('reading archives');
  await fold(disc, COMMON, assets, false);
  if (!await fold(disc, 'DATA/RT/' + up + '/RT_' + up + '.ARC', assets, false))
    throw new Error('no bundle for ' + name);
  await fold(disc, COSTUME, assets, true);

  say('compiling the script');
  const scene = sceneMod.compile(name, assets);

  if (scene.room) {
    say('reading room ' + scene.room);
    await fold(disc, 'DATA/ROOM/' + scene.room.toUpperCase() + '_ALL.ARC',
               assets, true);
  }

  // Clips named by the timeline that are not in any archive are streamed
  // loose in the AFS beside the bundle.
  const wanted = new Set();
  for (const e of scene.entities)
    for (const [, file] of e.clips) wanted.add(file.toLowerCase());
  const missing = [...wanted].filter((f) => !assets.has(f));
  if (missing.length) {
    say('streaming ' + missing.length + ' clips');
    for (const f of missing) {
      const blob = await disc.read('DATA/RT/' + up + '/' + f.toUpperCase());
      if (blob) assets.set(f, blob);
    }
  }

  // --- textures, decoded once and shared by every model that names them
  const texCache = new Map();
  const texFor = (file) => {
    const key = file.toLowerCase();
    if (texCache.has(key)) return texCache.get(key);
    let t = null;
    const blob = assets.get(key);
    if (blob) {
      try {
        const pics = tm2Mod.decode(blob);
        if (pics.length) t = modelMod.makeTexture(THREE, pics[0]);
      } catch (e) { t = null; }
    }
    texCache.set(key, t);
    return t;
  };

  say('building models');
  const root = new THREE.Group();
  const actors = [];
  const warnings = [];

  for (const e of scene.entities) {
    if (e.kind !== sceneMod.KIND_MODEL) continue;
    const files = sceneMod.renderModels(e);
    if (!files.length) continue;
    for (const file of files) {
      const blob = assets.get(file.toLowerCase());
      if (!blob) { warnings.push('missing model ' + file); continue; }
      let model, posed;
      try {
        model = smiMod.parse(blob);
        posed = smiMod.bindPose(model);
      } catch (err) { warnings.push(file + ': ' + err.message); continue; }
      const group = modelMod.build(THREE, model, posed, texFor);
      if (e.transform) group.position.set(e.transform[0], e.transform[1],
                                          e.transform[2]);
      root.add(group);
      actors.push({ entity: e, model: model, group: group, file: file,
                    clips: new Map(), bind: posed });
    }
  }

  // --- the room, static geometry under the same root
  let room = null;
  if (scene.room) {
    const blob = assets.get(scene.room.toLowerCase() + '.smi');
    if (blob) {
      try {
        const model = smiMod.parse(blob);
        const posed = smiMod.bindPose(model);
        room = modelMod.build(THREE, model, posed, texFor);
        root.add(room);
      } catch (err) { warnings.push('room: ' + err.message); }
    } else {
      warnings.push('no geometry for room ' + scene.room);
    }
  }

  // --- camera track
  let camera = null;
  if (scene.cameraFile) {
    const blob = assets.get(scene.cameraFile.toLowerCase());
    if (blob) {
      try { camera = camMod.parse(blob); }
      catch (err) { warnings.push('camera: ' + err.message); }
    } else warnings.push('missing camera ' + scene.cameraFile);
  }

  /** Parse a clip once, on first use. */
  function clipFor(actor, file) {
    const key = file.toLowerCase();
    if (actor.clips.has(key)) return actor.clips.get(key);
    let clip = null;
    const blob = assets.get(key);
    if (blob) {
      try { clip = saiMod.parse(blob); } catch (e) { clip = null; }
    }
    actor.clips.set(key, clip);
    return clip;
  }

  return { scene: scene, root: root, actors: actors, room: room,
           camera: camera, assets: assets, warnings: warnings,
           clipFor: clipFor, textures: texCache };
}

/**
 * Pose everything for `frame`.  Returns what the page needs for the camera
 * and the overlay; the scene graph is updated in place.
 */
function poseAt(built, frame) {
  let posed = 0, skipped = 0;
  for (const actor of built.actors) {
    const e = actor.entity;
    const on = frame >= e.start && sceneMod.visibleAt(e, frame);
    actor.group.visible = on;
    if (!on) { skipped++; continue; }
    const cur = sceneMod.clipAt(e, frame);
    if (!cur) continue;
    const clip = built.clipFor(actor, cur.file);
    if (!clip) continue;
    // A clip restarts from the frame the timeline started it on.
    const local = frame - cur.start;
    const mats = saiMod.worldMatrices(actor.model, clip, local);
    const skinned = saiMod.skin(actor.model, mats);
    for (const child of actor.group.children) {
      const pn = skinned[child.userData.meshIndex];
      if (!pn) continue;
      child.geometry.attributes.position.array.set(pn.positions);
      child.geometry.attributes.position.needsUpdate = true;
      if (pn.normals && child.geometry.attributes.normal) {
        child.geometry.attributes.normal.array.set(pn.normals);
        child.geometry.attributes.normal.needsUpdate = true;
      }
    }
    posed++;
  }

  const out = { posed: posed, skipped: skipped, camera: null, subtitle: null,
                letterbox: 0, fade: 0 };
  if (built.camera) out.camera = built.camera.sample(frame);

  // the cue on screen is the last one started, until the next one
  const subs = built.scene.subtitles;
  for (let i = subs.length - 1; i >= 0; i--)
    if (subs[i].frame <= frame) {
      const end = subs[i].end !== null ? subs[i].end
                : (i + 1 < subs.length ? subs[i + 1].frame : Infinity);
      if (frame < end) out.subtitle = subs[i];
      break;
    }

  // `0x57`: 0 slides the bars in over n frames, 1 slides them out
  for (const [f, kind, n] of built.scene.letterbox) {
    if (frame < f) break;
    const k = Math.min(1, (frame - f) / Math.max(1, n));
    out.letterbox = kind === 'out' ? 1 - k : k;
  }
  for (const [f, kind, n] of built.scene.fades) {
    if (frame < f) break;
    const k = Math.min(1, (frame - f) / Math.max(1, n));
    out.fade = kind === 'out' ? k : 1 - k;
  }
  return out;
}

const api = { assemble, poseAt, fold, COMMON, COSTUME };
if (typeof module !== 'undefined') module.exports = api;
if (typeof window !== 'undefined') window.TraptPlay = api;
})();
