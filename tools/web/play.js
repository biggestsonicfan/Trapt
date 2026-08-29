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
const sliMod = req ? require('./sli.js') : window.TraptSli;
const gsMod = req ? require('./gs.js') : window.TraptGs;

const COMMON = 'DATA/RT/COMMON/RT_COMMON.ARC';
const COSTUME = 'DATA/RT/COSTUME/RT_C01F_A_HL.ARC';
// Sprite effects name textures that live in neither the cutscene bundle nor
// the room: `spark.tm2`, `ef_s014c.tm2` and the rest are in the effect
// library, and the per-room `EF_DI_R??.ARC` holds the ones a particular room
// uses.  Nothing loaded either, so even once a sprite block compiled it had
// no picture to draw.
const EFFECTS = 'DATA/EFFECT/EF_COMMON.ARC';

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

  const warningsEarly = [];

  say('reading archives');
  await fold(disc, COMMON, assets, false);
  if (!await fold(disc, 'DATA/RT/' + up + '/RT_' + up + '.ARC', assets, false))
    throw new Error('no bundle for ' + name);
  await fold(disc, COSTUME, assets, true);
  await fold(disc, EFFECTS, assets, true);

  say('compiling the script');
  const scene = sceneMod.compile(name, assets);

  if (scene.room) {
    say('reading room ' + scene.room);
    await fold(disc, 'DATA/ROOM/' + scene.room.toUpperCase() + '_ALL.ARC',
               assets, true);
    // The room's own effect library, for the sprites it alone uses.
    await fold(disc, 'DATA/EFFECT/DI/EF_DI_' + scene.room.toUpperCase() + '.ARC',
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

  // A directional light's aim is not in the script -- FUN_001D4430 sums the
  // room's own .sli entries and normalises.  Without it every scene falls back
  // to an invented direction.
  let roomDir = null;
  if (scene.room) {
    const sliBlob = assets.get(scene.room.toLowerCase() + '.sli');
    if (sliBlob) {
      try { roomDir = sliMod.infiniteDirection(sliMod.parse(sliBlob)); }
      catch (e) { warningsEarly.push('sli: ' + e.message); }
    }
  }
  const lights = gsMod.lightsFor(
    THREE, scene.entities.filter((e) => e.kind === sceneMod.KIND_LIGHT), roomDir);

  say('building models');
  const root = new THREE.Group();
  const actors = [];
  const warnings = warningsEarly;

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
      const group = modelMod.build(THREE, model, posed, texFor, {
        lights: lights, fog: scene.fog,
        // `0x80` on a model block is a material multiplier, not a scale.
        // `0x7E` on an effect block is the same kind of thing -- a colour --
        // so whichever the block carried wins, with 0x7E taking precedence
        // because only effect blocks emit it.
        tint: e.tint ? e.tint.slice(0, 3) : (e.scale ? e.scale.slice(0, 3) : null),
      });
      if (e.transform) group.position.set(e.transform[0], e.transform[1],
                                          e.transform[2]);
      // An effect track is spawned at a world point by `0x08`/`0x07` and its
      // blocks are positioned relative to it, so the two add.
      if (e.origin) {
        group.position.x += e.origin[0];
        group.position.y += e.origin[1];
        group.position.z += e.origin[2];
      }
      root.add(group);
      actors.push({ entity: e, model: model, group: group, file: file,
                    clips: new Map(), bind: posed });
    }
  }

  // --- sprite effects: a block that named a texture rather than a model
  //
  // One camera-facing quad per emitter point.  A kind-2 block has no binds
  // and sits where the block was placed; a kind-3 block carries one or more
  // `0xCA` binds and each of those rides a bone, which is how e004 puts a
  // spark on Allura's finger, hand, elbow and forearm at once.
  //
  // This is not the game's particle system -- `0xC8`/`0xC9` clearly steer a
  // count and a spread that nothing here reads, so a trail of eight sparks
  // comes out as one sprite at the emitter.  Size and colour over time are
  // the game's own, straight off the keyframes.
  const sprites = [];
  for (const e of scene.entities) {
    if (!e.sprite) continue;
    const tex = texFor(e.sprite.texture);
    if (!tex) { warnings.push('missing effect texture ' + e.sprite.texture); }
    // `0x68`'s four numbers are a **cell** on a **sheet**, and a sheet is
    // often a flipbook: `ef_p_s_01.tm2` is sixteen rows of four 64x16 frames
    // of an explosion on one 256x256 page.  Drawing the page as one quad puts
    // the whole animation on screen at once -- which is what a giant red
    // rectangle over a third of the frame turned out to be.
    //
    // So the quad takes one cell's UV rect.  It does **not** take the cell's
    // aspect: the shape is the size keys' job, and they disagree with the
    // cell.  e001's torch is a 64x16 cell -- four times as wide as tall --
    // and its `0xAB` keys are (1, 2) growing to (4, 7), which is *taller*
    // than wide.  A hardware capture of frame 10834 shows a tall narrow
    // plume, so the keys are right and the cell aspect is not a shape.
    //
    // **Which** cell is not known.  `0x69` is the only per-block scalar left
    // and it is -1 on the 64-cell sheets as well as the 1-cell ones, so it is
    // not an index, and no opcode keyframes one.  Cell 0 it is, which is
    // exact for the eleven single-cell textures and the first frame of the
    // three flipbooks.
    const cellW = e.sprite.cell[0] || 1, cellH = e.sprite.cell[1] || 1;
    const sheetW = e.sprite.sheet[0] || cellW, sheetH = e.sprite.sheet[1] || cellH;
    const u = Math.min(1, cellW / sheetW), v = Math.min(1, cellH / sheetH);
    const points = e.binds.length ? e.binds : [null];
    for (const bind of points) {
      const geo = new THREE.PlaneGeometry ? new THREE.PlaneGeometry(1, 1)
                                          : new THREE.BufferGeometry();
      // Cell 0 is the top-left of the sheet.  `.SMI` V runs top-down and so
      // does a TIM2, so v0 is 0 and the cell grows downwards.
      if (geo.attributes && geo.attributes.uv) {
        const uv = geo.attributes.uv.array;
        for (let k = 0; k < uv.length; k += 2) {
          uv[k] *= u;
          uv[k + 1] = 1 - (1 - uv[k + 1]) * v;
        }
        geo.attributes.uv.needsUpdate = true;
      }
      const mat = new THREE.MeshBasicMaterial({
        map: tex, transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
        color: new THREE.Color(1, 1, 1), opacity: 0,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.visible = false;
      root.add(mesh);
      sprites.push({ entity: e, mesh: mesh, bind: bind, actor: null });
    }
  }
  // Resolve each bind to the actor that carries the bone, once.
  for (const s of sprites) {
    if (!s.bind) continue;
    const want = s.bind[0].toLowerCase();
    s.actor = actors.find((a) => a.file.toLowerCase().replace(/\.smi$/, '') === want)
           || actors.find((a) => a.file.toLowerCase().startsWith(want)) || null;
    if (!s.actor) { warnings.push('effect bound to ' + s.bind[0] + ', which is not in the scene'); continue; }
    s.boneIndex = s.actor.model.nodes.findIndex((n) => n.name === s.bind[1]);
    if (s.boneIndex < 0)
      warnings.push('effect bound to bone ' + s.bind[1] + ', which ' + s.bind[0] + ' has not');
  }

  // --- the room, static geometry under the same root
  let room = null;
  if (scene.room) {
    const blob = assets.get(scene.room.toLowerCase() + '.smi');
    if (blob) {
      try {
        const model = smiMod.parse(blob);
        const posed = smiMod.bindPose(model);
        room = modelMod.build(THREE, model, posed, texFor,
                              { lights: lights, fog: scene.fog });
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
           clipFor: clipFor, textures: texCache, lights: lights,
           roomDir: roomDir, sprites: sprites };
}

/**
 * Turn every live sprite to face `eye`.  A billboard has to be re-aimed
 * whenever the camera moves, and the viewer's free camera is not the camera
 * `poseAt` knows about, so the page calls this again with the real one.
 */
function faceSprites(built, eye) {
  if (!built.sprites || !eye) return;
  for (const s of built.sprites) {
    if (!s.mesh.visible || typeof s.mesh.lookAt !== 'function') continue;
    s.mesh.lookAt(eye[0], eye[1], eye[2]);
  }
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
    // A clip restarts from the frame the timeline started it on, unless
    // 0x83 named a start offset -- see scene.js.  The corpse in e001 is the
    // only case on the disc, and without it the body spends the scene
    // nineteen units under the floor while the knife, whose block starts at
    // frame 0, looks right.
    const local = frame - cur.start + (cur.offset || 0);
    const mats = saiMod.worldMatrices(actor.model, clip, local);
    // Kept because a sprite effect bound with `0xCA` rides one of these bones
    // and needs the same pose the skin was built from, not a re-solve.
    actor.lastMats = mats;
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

  // --- sprite effects
  //
  // A block's keyframes are timed from the block, not from the cutscene, so
  // everything here runs on `frame - e.start`.  Past the last key the sprite
  // is gone: `ef_e004_30` ends its alpha on 0 at frame 240 and holding that
  // forever would leave an invisible quad in the depth buffer.
  let lit = 0;
  for (const s of built.sprites || []) {
    const e = s.entity;
    const local = frame - e.start;
    // A keyed sprite dies on its last key; an unkeyed one -- e004's sparks
    // carry only `0x80` and the emitter -- dies with its track.
    const keyed = e.colourKeys.length ? e.colourKeys[e.colourKeys.length - 1][0]
                : (e.sizeKeys.length ? e.sizeKeys[e.sizeKeys.length - 1][0] : 0);
    // A track with no `at_time` after the block has a length of 0, which is
    // not "one frame" -- it is "the script never says it stops".  e001's
    // sprite is that case, and treating 0 as a lifetime made it flash for a
    // single frame.
    const life = keyed > 0 ? keyed
               : (e.trackLen ? e.trackLen : Infinity);
    // A block whose track never ends is an emitter that never stops -- e001's
    // three torches burn for the whole scene.  Its keys describe one
    // particle's life, so playing them once and holding the last (alpha 0)
    // leaves the torch lit for two seconds and then dark.  Looping is the
    // closest a single billboard gets to a thing that keeps emitting; it is
    // an approximation of the emitter (0x9E/0x9F), not the emitter itself.
    const loops = keyed > 0 && !e.trackLen;
    const t = loops ? local % (keyed + 1) : local;
    const live = local >= 0 && (loops || local <= life)
              && sceneMod.visibleAt(e, frame) && (e.end === null || frame < e.end);
    s.mesh.visible = live;
    if (!live) continue;
    // `0x80` on a sprite block is the colour, the same way it is on a light,
    // and it is all an unkeyed sprite has: e004's spark is (0.9, 0.3, 0.1).
    const [r, g, b, a] = e.colourKeys.length ? sceneMod.colourAt(e, t)
      : (e.scale ? e.scale : [1, 1, 1, 1]);
    const [sx, sy] = sceneMod.sizeAt(e, t);
    // The GS treats 0x80 as 1.0, and these colours run past 1 -- 1.5 and 1.8
    // both occur -- so the excess is an overbright the additive blend wants
    // rather than a value to clamp away.  Only alpha is clamped, because
    // three.js reads opacity as 0..1.
    s.mesh.material.color.setRGB(r, g, b);
    s.mesh.material.opacity = Math.max(0, Math.min(1, a));
    // Size is in scene units and carries the shape: e001's torch runs from
    // 1 x 2 to 4 x 7, a plume taller than it is wide.
    s.mesh.scale.set(sx || 1, sy || 1, 1);

    let px = 0, py = 0, pz = 0;
    if (s.actor && s.boneIndex >= 0 && s.actor.lastMats) {
      const m = s.actor.lastMats[s.boneIndex];
      px = m[12]; py = m[13]; pz = m[14];
      px += s.actor.group.position.x;
      py += s.actor.group.position.y;
      pz += s.actor.group.position.z;
    } else {
      if (e.transform) { px = e.transform[0]; py = e.transform[1]; pz = e.transform[2]; }
      if (e.origin) { px += e.origin[0]; py += e.origin[1]; pz += e.origin[2]; }
    }
    s.mesh.position.set(px, py, pz);
    lit++;
  }
  // Face them at whatever is looking.  The scene's own camera is the default
  // so a headless render is right without a page; `faceSprites` re-points
  // them at a free camera when the viewer has taken one.
  if (built.camera) {
    const c = built.camera.sample(frame);
    // `.cam` samples are `{position, target, roll, fov}` -- not `eye`, which
    // is what the stage's camera calls it.
    if (c && c.position) faceSprites(built, c.position);
  }

  const out = { posed: posed, skipped: skipped, sprites: lit,
                camera: null, subtitle: null, letterbox: 0, fade: 0 };
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

const api = { assemble, poseAt, faceSprites, fold, COMMON, COSTUME, EFFECTS };
if (typeof module !== 'undefined') module.exports = api;
if (typeof window !== 'undefined') window.TraptPlay = api;
})();
