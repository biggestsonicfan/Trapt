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

// Draw order on top of model.js's 0 (opaque) and 1 (blended): effect models,
// then sprites, after everything in the room.
const RO_EFFECT = 2, RO_SPRITE = 3;
// The GS's largest alpha, 0xFF over 0x80.
const GS_ALPHA_MAX = 255 / 128;
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

// A sheet can declare a lot of cells; this caps how many billboards one
// emitter turns into.  Nothing on the disc exceeds it -- the largest grid is
// e001's 32 -- so it is a guard, not a policy.
const MAX_PARTICLES = 64;

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
      if (e.size) group.scale.set(e.size[0], e.size[1], e.size[2]);
      // Effects draw after the room, as the game draws them.  three sorts
      // blended meshes by object origin, and every room mesh's origin is the
      // world's, so e004's foliage sorted in front of a fire five units from
      // the lens and painted dark bands of tree line across it.
      if (e.origin) for (const m of group.children) m.renderOrder = RO_EFFECT;
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
  // Camera-facing quads.  A kind-2 block has no binds and sits where the
  // block was placed; a kind-3 block carries one or more `0xCA` binds and
  // each of those rides a bone, which is how e004 puts a spark on Allura's
  // finger, hand, elbow and forearm at once.  A block with a `0x9F` grid is
  // an emitter and becomes a *cloud* of quads -- see `count` below.
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
    // How many particles are alive at once.
    //
    // `0x9F` writes `rate * cells` to +0xb4 -- 128 for e001's torch -- and
    // that is the particle's whole life, because it is also where the `0xAA`
    // alpha keys end.  A steady emitter spawning one particle every `rate`
    // frames therefore holds `life / rate` = `cells` of them at once, each
    // one cell-step older than the last, so between them they show every
    // frame of the sheet.  That is what the 32 cells are *for*, and it is why
    // one billboard looks nothing like the hardware: a single particle is
    // faded out for most of its cycle, while thirty-two staggered ones sum to
    // something steady.
    //
    // What is *not* implemented is where they go: `0x9E`, `0x74` and `0x77`
    // carry the spawn spread and the rise and none is read, so these sit on
    // top of each other and read as a bright pulsing flame rather than a
    // plume climbing off the brazier.
    // Two kinds of emitter, and the disc has one of each.
    //
    // A `0x9F` block -- e001's torch -- gets its count from the grid, above.
    //
    // A `0xC8` block -- e004's sparks -- states it outright.  Read live out
    // of EE RAM, a spark object holds `0xC8`'s first argument at `+0x210`
    // sitting immediately in front of a **16-slot particle array** at
    // `+0x188`, and the two values the disc uses are 8 and 16.  The same
    // object has `+0x24`-`+0x2b` uninitialised and `+0xb4` zero, so it has no
    // grid and no derived life: this is where its count comes from.
    //
    // The game makes one object per *block*, not per bone -- eight of them
    // for e004's four blocks across two spawns -- so the `0xCA` binds are
    // emission points that one emitter shares, and the particles are dealt
    // round-robin between them rather than each bone getting a full set.
    const emitted = e.emitter && e.emitter.c8 && e.emitter.c8.length
      ? Math.round(e.emitter.c8[0]) : 0;
    const points = e.binds.length ? e.binds : [null];

    // The emission slots, flattened: which point each particle comes from and
    // how old it is.  A grid block runs a full set at every point; a `0xC8`
    // block has one shared budget dealt round-robin between them.
    const slots = [];
    if (e.grid && e.grid.cells > 1) {
      const n = Math.min(MAX_PARTICLES, e.grid.cells);
      for (const bind of points)
        for (let k = 0; k < n; k++) slots.push({ bind, phase: k * e.grid.rate });
    } else if (emitted > 0 && keyLife(e) > 0) {
      // Only worth issuing when something varies with age.  e004's sparks
      // carry no keyframes at all, so N of them at one bone would be N
      // identical additive quads -- an N-times brightness multiplier, not a
      // cloud.  The count is right (it is read off the hardware) but without
      // `0xC8`'s remaining three floats and `0xC9`'s four, which are the
      // spread, stacking them would distort rather than fix.  So the count is
      // carried and only spent where the keyframes make each particle
      // distinct.
      const n = Math.min(MAX_PARTICLES, emitted);
      const life = keyLife(e);
      for (let k = 0; k < n; k++)
        slots.push({ bind: points[k % points.length],
                     phase: Math.round(k * life / n) });
    } else {
      for (const bind of points) slots.push({ bind, phase: 0 });
    }

    for (const slot of slots) {
      const bind = slot.bind;
      const geo = spriteGeometry(THREE, e.mirror);
      // The UVs are rewritten every frame by `setCell`, so keep the pristine
      // unit-quad corners to build each cell's rect from.
      let uvBase = null;
      if (geo.attributes && geo.attributes.uv)
        uvBase = Float32Array.from(geo.attributes.uv.array);
      const mat = new THREE.MeshBasicMaterial({
        map: tex, transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
        color: new THREE.Color(1, 1, 1), opacity: 0,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.visible = false;
      mesh.renderOrder = RO_SPRITE;
      root.add(mesh);
      sprites.push({ entity: e, mesh: mesh, bind: bind, actor: null,
                     uvBase: uvBase, cellU: u, cellV: v, cell: -1,
                     phase: slot.phase });
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

/** The last frame a block's keyframes reach, or 0 when it has none. */
function keyLife(e) {
  if (e.colourKeys.length) return e.colourKeys[e.colourKeys.length - 1][0];
  if (e.sizeKeys.length) return e.sizeKeys[e.sizeKeys.length - 1][0];
  return 0;
}

/**
 * The quad a sprite billboard is drawn on, in a unit square centred on the
 * origin, with UVs `setCell` can rewrite.
 *
 * Ordinarily that is one quad showing the cell the right way up.  When `0x6C`
 * flag 3 is set the tile is one **quadrant** of the sprite, so the quad
 * becomes four -- the tile, and it mirrored in u, in v, and in both -- laid
 * out so the tile's bottom-right corner meets at the middle.  `ef_s014c.tm2`
 * is a radial falloff centred on exactly that corner, and four mirrored
 * copies of it make one round glow twice the tile's width; one flat copy
 * makes a square that is fully opaque along two of its sides, which is what
 * e004's blast looked like before this existed.
 *
 * The UVs written here are the *fractions within a cell* rather than final
 * texture coordinates -- mirroring shows up as a fraction that runs 1 to 0 --
 * because `setCell` maps them onto whichever cell of the sheet is current.
 */
function spriteGeometry(THREE, mirror) {
  if (!mirror) {
    return THREE.PlaneGeometry ? new THREE.PlaneGeometry(1, 1)
                               : new THREE.BufferGeometry();
  }
  const pos = [], uv = [];
  // Quadrant (qx, qy): qx picks the right half, qy the bottom one.  `u` runs
  // away from the meeting corner in x and `v` towards it in y, so the tile's
  // (1, 0) corner -- its bottom-right -- lands at the sprite's middle in all
  // four.
  for (let qy = 0; qy < 2; qy++) {
    for (let qx = 0; qx < 2; qx++) {
      const x0 = qx ? 0 : -0.5, x1 = qx ? 0.5 : 0;
      const y0 = qy ? 0 : 0.5, y1 = qy ? -0.5 : 0;
      const u0 = qx ? 1 : 0, u1 = qx ? 0 : 1;
      const v0 = qy ? 0 : 1, v1 = qy ? 1 : 0;
      // Two triangles, wound the way three.js winds a plane.
      const c = [[x0, y0, u0, v0], [x1, y0, u1, v0],
                 [x0, y1, u0, v1], [x1, y1, u1, v1]];
      for (const i of [0, 2, 1, 1, 2, 3]) {
        pos.push(c[i][0], c[i][1], 0);
        uv.push(c[i][2], c[i][3]);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position',
                   new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
  return geo;
}

/**
 * Point a sprite's UVs at cell `index` of its sheet, counting left to right
 * then top to bottom.  A `.TIM2` runs top-down and three.js puts v = 1 at the
 * top of a plane, so row 0 is the v = 1 end and rows grow downwards.
 */
function setCell(s, index) {
  if (!s.uvBase || index === s.cell) return;
  s.cell = index;
  const g = s.entity.grid;
  const cols = g && g.cols ? g.cols : 1;
  const cx = index % cols, cy = Math.floor(index / cols);
  const uv = s.mesh.geometry.attributes.uv.array;
  for (let k = 0; k < uv.length; k += 2) {
    uv[k] = (cx + s.uvBase[k]) * s.cellU;
    uv[k + 1] = 1 - (cy + (1 - s.uvBase[k + 1])) * s.cellV;
  }
  s.mesh.geometry.attributes.uv.needsUpdate = true;
}

/**
 * Turn every live sprite, and every billboarded effect model, to face `eye`.  A billboard has to be re-aimed
 * whenever the camera moves, and the viewer's free camera is not the camera
 * `poseAt` knows about, so the page calls this again with the real one.
 */
function faceSprites(built, eye) {
  if (!eye) return;
  for (const s of built.sprites || []) {
    if (!s.mesh.visible || typeof s.mesh.lookAt !== 'function') continue;
    // `0xAC`: the game draws the sprite this far toward the eye (scene.js).
    const pull = s.entity.pull, b = s.base;
    if (pull && b) {
      const dx = eye[0] - b[0], dy = eye[1] - b[1], dz = eye[2] - b[2];
      const k = pull / (Math.hypot(dx, dy, dz) || 1);
      s.mesh.position.set(b[0] + dx * k, b[1] + dy * k, b[2] + dz * k);
    }
    s.mesh.lookAt(eye[0], eye[1], eye[2]);
  }
  // and the `0xB8` effect cards, which are models but flat ones
  for (const a of built.actors || []) {
    if (!a.entity.billboard || !a.group.visible
        || typeof a.group.lookAt !== 'function') continue;
    a.group.lookAt(eye[0], eye[1], eye[2]);
  }
}

/**
 * Drive an effect model from its track's program: its block's position and
 * scale, and alpha, UV scroll and colour per material id.  The colour replaces the block tint --
 * `0x7E` is per material, and e004's fire gives its two layers two oranges.
 */
function fxApply(group, e, local) {
  const fx = e.fx;
  const pl = sceneMod.fxAt(fx, e.block, local, fx.place);
  if (pl) {
    group.scale.set(pl[3], pl[4], pl[5]);
    if (pl[0] !== null) {
      const o = e.origin || [0, 0, 0];
      group.position.set(pl[0] + o[0], pl[1] + o[1], pl[2] + o[2]);
    }
  }
  for (const mesh of group.children) {
    const u = mesh.material && mesh.material.uniforms;
    const m = u && sceneMod.fxAt(fx, mesh.userData.matId, local);
    if (!m) continue;
    u.fxAlpha.value = m[0];
    u.uvOff.value.set(m[1], m[2]);
    u.tint.value.set(m[3], m[4], m[5]);
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
    // An effect track's program says when it is over (scene.js `fxRun`).
    const age = frame - e.start;
    const on = frame >= e.start && sceneMod.visibleAt(e, frame)
      && !(e.fx && e.fx.end !== null && age >= e.fx.end);
    actor.group.visible = on;
    if (!on) { skipped++; continue; }
    if (e.fx) fxApply(actor.group, e, age);
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
    // `0x9F` gives the sheet's own life -- frames-per-cell times cells -- and
    // for e001's torch that is 128, the same frame its alpha keys end on.
    // Where it exists it is the authority on how long one particle lasts.
    const span = (e.grid && e.grid.life) || keyed;
    const loops = span > 0 && !e.trackLen;
    // Each particle runs the same curve, offset by when it was emitted.
    const aged = local + (s.phase || 0);
    const t = loops ? aged % (span + 1) : aged;
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
    // rather than a value to clamp away.  Alpha past 1 is the same thing --
    // As is 0..255/128 -- but a WebGL target clamps source alpha to 1 before
    // it blends, so the excess rides on the colour: the blend is additive,
    // and colour * alpha is all it ever multiplies out to.
    const over = Math.min(GS_ALPHA_MAX, Math.max(1, a));
    s.mesh.material.color.setRGB(r * over, g * over, b * over);
    s.mesh.material.opacity = Math.max(0, Math.min(1, a));
    // Size is in scene units and carries the shape: e001's torch runs from
    // 1 x 2 to 4 x 7, a plume taller than it is wide.
    s.mesh.scale.set(sx || 1, sy || 1, 1);
    // Step the flipbook.  Without `0x9F` there is no grid and cell 0 stands.
    if (e.grid && e.grid.cells > 1 && e.grid.rate > 0)
      setCell(s, Math.min(e.grid.cells - 1,
                          Math.floor(t / e.grid.rate)) % e.grid.cells);

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
    s.base = [px, py, pz];
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
