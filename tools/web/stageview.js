/**
 * The stage, on screen and under a controller -- `play.js` for the other half
 * of the game.
 *
 * `stage.js` is the simulation and knows nothing about three.js; this is the
 * part that reads the room's geometry off the disc, skins Allura, drives the
 * camera and turns a PS2 pad into movement.  Keeping the split means the
 * solver stays diffable against the Python and only the presentation lives
 * here.
 *
 * What is loaded, and when:
 *
 *   DATA/ROOM/<ROOM>_ALL.ARC     the room the body is standing in, on demand
 *                                and then cached -- a stage is up to sixteen
 *                                rooms and about a megabyte each, so loading
 *                                them all up front would cost more than the
 *                                cutscene player ever does
 *   DATA/CHARA/C01F_A.ARC        Allura: the rig, the three gait clips
 *   DATA/CHARA/C01F_A_TEX.ARC    her textures, which are not in the rig
 *   DATA/TRAP/T{C,W,F}##.ARC     a trap, the first time it is selected
 *
 * The camera is behind and above the body, at the distance and height
 * `DATA/CAMERA/INIT.BIN` carries, turned by the right stick and pulled in by
 * the room's own walls so it does not sit outside them.
 */
(function () {
'use strict';

const req = (typeof require !== 'undefined');
const arcMod = req ? require('./arc.js') : window.TraptArc;
const tm2Mod = req ? require('./tm2.js') : window.TraptTm2;
const smiMod = req ? require('./smi.js') : window.TraptSmi;
const saiMod = req ? require('./sai.js') : window.TraptSai;
const sliMod = req ? require('./sli.js') : window.TraptSli;
const gsMod = req ? require('./gs.js') : window.TraptGs;
const modelMod = req ? require('./model.js') : window.TraptModel;
const colMod = req ? require('./col.js') : window.TraptCol;
const stageMod = req ? require('./stage.js') : window.TraptStage;
const trapMod = req ? require('./trap.js') : window.TraptTrap;
const scriptMod = req ? require('./stagescript.js') : window.TraptStageScript;

const DEG = Math.PI / 180;
// How far short of a wall the camera stops, in world units.  The body's own
// capsule is radius 3, so this is comfortably outside the near plane.
const CAMERA_MARGIN = 10;

/**
 * A room's `.sli` turned into the rig `gs.js` builds materials against.
 *
 * A stage has no script, so unlike a cutscene the room's own lights are all
 * there is -- which settles a question the cutscene side had to guess at.
 * The rig carries two point lights, so the two nearest the body win and the
 * rest are dropped; picking by distance every frame would pop, so it is done
 * once per room.
 */
function lightsFromSli(THREE, lights, at) {
  const entities = [];
  const points = [];
  for (const l of lights) {
    if (l.kind === 4) entities.push({ light: 'ambient', scale: l.colour });
    else if (l.kind === 0) entities.push({ light: 'directional', scale: l.colour });
    else if (l.kind === 1) points.push(l);
  }
  points.sort((a, b) => {
    const da = Math.hypot(a.vec[0] - at[0], a.vec[1] - at[1], a.vec[2] - at[2]);
    const db = Math.hypot(b.vec[0] - at[0], b.vec[1] - at[1], b.vec[2] - at[2]);
    return da - db;
  });
  for (const l of points.slice(0, 2))
    entities.push({ light: 'point', scale: l.colour, transform: l.vec,
                    lightRange: l.range });
  return gsMod.lightsFor(THREE, entities,
                         sliMod.infiniteDirection(lights));
}

/**
 * Re-point an already-built group at a different light rig.
 *
 * `gs.makeMaterial` captures the rig's vectors in its uniforms when the mesh
 * is built, so the cast -- built once and walked between rooms -- would keep
 * the lighting of whichever room happened to load first.  Copying the values
 * in is enough; the uniform objects themselves stay where they are.
 */
function applyLights(group, rig) {
  const pts = rig.points;
  group.traverse((o) => {
    const u = o.material && o.material.uniforms;
    if (!u || !u.ambient) return;
    u.ambient.value.copy(rig.ambient);
    u.dirColour.value.copy(rig.dirColour);
    u.dirDir.value.copy(rig.dirDir);
    for (let i = 0; i < 2; i++) {
      const p = pts[i];
      if (!p) continue;
      u['pt' + i + 'c'].value.copy(p.c);
      u['pt' + i + 'p'].value.copy(p.p);
      u['pt' + i + 'r'].value.copy(p.r);
    }
  });
}

/** Decode a TM2 once per name, out of whichever archive supplied it. */
function textureCache(THREE) {
  const cache = new Map();
  return {
    cache,
    make(assets) {
      return (file) => {
        const key = file.toLowerCase();
        if (cache.has(key)) return cache.get(key);
        let t = null;
        const blob = assets.get(key);
        if (blob) {
          try {
            const pics = tm2Mod.decode(blob);
            if (pics.length) t = modelMod.makeTexture(THREE, pics[0]);
          } catch (e) { t = null; }
        }
        cache.set(key, t);
        return t;
      };
    },
  };
}

class Runner {
  constructor(THREE, disc, stage, opts) {
    this.THREE = THREE;
    this.disc = disc;
    this.stage = stage;
    this.opts = opts || {};
    this.root = new THREE.Group();
    this.rooms = new Map();          // name -> {group, assets, lights, sli}
    this.actor = null;               // {model, group, clips, bind}
    this.camera = { yaw: 0, pitch: 18 * DEG, distance: 115, height: 40 };
    this.warnings = [];
    this.showCollision = false;
    this.debugGroup = null;
    this.selected = 0;               // which trap the pad would set
    this.script = null;              // the B##EVENT stage script, if any
    this.trapCache = new Map();
    this.placedGroup = new THREE.Group();
    this.root.add(this.placedGroup);
  }

  // ------------------------------------------------------------------ setup

  async loadCamera() {
    const rows = await stageMod.cameraDefaults(this.disc);
    if (rows.length) {
      this.camera.pitch = rows[0].pitch * DEG;
      this.camera.distance = rows[0].distance;
      this.camera.height = rows[0].height;
      this.cameraRows = rows;
    }
    return this.camera;
  }

  /** Allura: rig, textures and the three gait clips, built once. */
  async loadActor(onProgress) {
    const THREE = this.THREE;
    const say = onProgress || (() => {});
    const name = this.stage.player.name;
    say('reading ' + name);
    const assets = new Map(this.stage.player.members);
    const tex = await this.disc.read('DATA/CHARA/' + name.toUpperCase() + '_TEX.ARC');
    if (tex) for (const [k, v] of arcMod.members(tex)) if (!assets.has(k)) assets.set(k, v);

    const model = smiMod.parse(assets.get(name + '.smi'));
    const bind = smiMod.bindPose(model);
    this.actorTex = textureCache(THREE);
    const group = modelMod.build(THREE, model, bind, this.actorTex.make(assets),
                                 { lights: this.lights, ps2: this.opts.ps2 !== false });
    const clips = new Map();
    for (const [gait, file] of [['idle', this.stage.player.idle],
                                ['walk', this.stage.player.gaits.walk.clip],
                                ['run', this.stage.player.gaits.run.clip]]) {
      const blob = assets.get(file);
      if (blob) clips.set(gait, saiMod.parse(blob));
      else this.warnings.push('missing clip ' + file);
    }
    this.actor = { model, group, clips, bind, assets };
    this.root.add(group);
    return this.actor;
  }

  /** The room the body is in, read and cached. */
  async loadRoom(name, onProgress) {
    if (this.rooms.has(name)) return this.rooms.get(name);
    const THREE = this.THREE;
    const say = onProgress || (() => {});
    const room = this.stage.rooms.get(name);
    say('reading room ' + room.id);
    const blob = await this.disc.read('DATA/ROOM/' + room.id.toUpperCase()
                                      + '_ALL.ARC');
    if (!blob) {
      this.warnings.push('no archive for room ' + room.id);
      return null;
    }
    const assets = arcMod.members(blob);
    let sli = [];
    const sliBlob = assets.get(room.id + '.sli');
    if (sliBlob) {
      try { sli = sliMod.parse(sliBlob); }
      catch (e) { this.warnings.push('sli ' + room.id + ': ' + e.message); }
    }
    const centre = colMod.spawnPoint(room.mesh) || [0, 0, 0];
    const lights = lightsFromSli(THREE, sli, centre);

    const group = new THREE.Group();
    const tex = textureCache(THREE);
    const texFor = tex.make(assets);
    const geoBlob = assets.get(room.id + '.smi');
    if (geoBlob) {
      try {
        const model = smiMod.parse(geoBlob);
        group.add(modelMod.build(THREE, model, smiMod.bindPose(model), texFor,
                                 { lights, ps2: this.opts.ps2 !== false }));
      } catch (e) { this.warnings.push('room ' + room.id + ': ' + e.message); }
    } else this.warnings.push('no geometry for room ' + room.id);

    // The door meshes are separate models sitting at their own positions, and
    // without them a doorway is a hole in the wall.
    for (const d of room.doors) {
      const file = room.id + 'd' + d.number + '.smi';
      const dblob = d.number >= 0 ? assets.get(file) : null;
      if (!dblob) continue;
      try {
        const model = smiMod.parse(dblob);
        group.add(modelMod.build(THREE, model, smiMod.bindPose(model), texFor,
                                 { lights, ps2: this.opts.ps2 !== false }));
      } catch (e) { /* a missing door leaf is not worth failing the room over */ }
    }

    group.position.set(room.origin[0], room.origin[1], room.origin[2]);
    const rec = { group, assets, lights, sli, tex };
    this.rooms.set(name, rec);
    this.root.add(group);
    await this.placeGimmicks(room, rec, say);
    return rec;
  }

  /**
   * Everything the stage script puts in this room.
   *
   * The models are in the room's own `_ATH` archive rather than in
   * `DATA/GIMMICK`, which is what makes this cheap: the room already had to
   * be read, and `RH01_ATH.ARC` ships exactly the four the script names.  The
   * gimmick archive is the fallback for anything a room does not carry.
   */
  async placeGimmicks(room, rec, onProgress) {
    const script = this.script;
    if (!script) return 0;
    const placed = script.rooms[room.id] || [];
    if (!placed.length) return 0;
    const say = onProgress || (() => {});
    const THREE = this.THREE;
    say('placing ' + placed.length + ' in ' + room.id);

    const ath = await this.disc.read('DATA/ROOM/' + room.id.toUpperCase()
                                     + '_ATH.ARC');
    const athMembers = ath ? arcMod.members(ath) : new Map();
    const pool = new Map(athMembers);
    for (const [k, v] of rec.assets) if (!pool.has(k)) pool.set(k, v);
    const tex = textureCache(THREE);
    const texFor = tex.make(pool);

    let n = 0;
    for (const p of placed) {
      if (!p.name) continue;
      const stem = p.name.toLowerCase();
      // A gimmick ships as `gc22.smi`, sometimes split into `gw36_000.smi`
      // and `gw36_001.smi`; take the base if there is one, else the parts.
      let files = pool.has(stem + '.smi') ? [stem + '.smi']
        : [...pool.keys()].filter(
            (k) => k.startsWith(stem + '_') && k.endsWith('.smi')).sort();
      if (!files.length) {
        const own = await this.disc.read(p.archive);
        if (own) {
          for (const [k, v] of arcMod.members(own)) if (!pool.has(k)) pool.set(k, v);
          files = pool.has(stem + '.smi') ? [stem + '.smi'] : [];
        }
      }
      if (!files.length) { this.warnings.push('no model for ' + p.name); continue; }
      for (const file of files) {
        let model;
        try { model = smiMod.parse(pool.get(file)); }
        catch (e) { this.warnings.push(file + ': ' + e.message); continue; }
        const g = modelMod.build(THREE, model, smiMod.bindPose(model), texFor,
                                 { lights: rec.lights,
                                   ps2: this.opts.ps2 !== false });
        g.position.set(p.pos[0], p.pos[1], p.pos[2]);
        g.rotation.y = p.rot;
        rec.group.add(g);
        n++;
      }
    }
    return n;
  }

  /** Show only the room the body is in; the rest stay loaded but hidden. */
  showOnly(name) {
    for (const [key, rec] of this.rooms) rec.group.visible = key === name;
    const rec = this.rooms.get(name);
    if (rec) {
      this.lights = rec.lights;
      // The actor was built against whatever rig was current when it loaded,
      // so its materials have to be re-pointed at this room's.
      if (this.actor) applyLights(this.actor.group, rec.lights);
    }
  }

  async enter(name, at, onProgress) {
    await this.loadRoom(name, onProgress);
    this.stage.enter(name, at);
    this.showOnly(name);
    this.rebuildDebug();
    return this.stage.current;
  }

  /**
   * Where the stage script says the player starts, as `{room, local, angle}`.
   *
   * `0x1F` gives a **world** point, so the room is whichever one contains it
   * -- which is also the only check that the script and the stage graph agree
   * about where anything is.  Returns null when no room does, and the caller
   * falls back to the biggest patch of floor.
   */
  scriptedSpawn() {
    const p = this.script && this.script.player;
    if (!p) return null;
    let best = null;
    for (const [name, room] of this.stage.rooms) {
      const local = room.toLocal(p.pos);
      const [lo, hi] = room.mesh.bounds;
      if (local[0] < lo[0] || local[0] > hi[0]
          || local[2] < lo[2] || local[2] > hi[2]) continue;
      const ground = room.mesh.floorAt(local[0], local[2],
                                       local[1] + colMod.STEP_UP);
      if (!ground) continue;
      // Prefer the room whose floor is nearest under the scripted height: two
      // rooms can overlap in XZ when one sits above the other.
      const drop = local[1] - ground[0];
      if (!best || Math.abs(drop) < Math.abs(best.drop))
        best = { room: name, local: [local[0], ground[0], local[2]],
                 angle: p.angle, drop };
    }
    return best;
  }

  // ------------------------------------------------------------------- tick

  /**
   * One frame.  `pad` is a `pad.js` state object; `frames` is elapsed time in
   * 60ths, the unit the rest of the viewer already runs on.
   */
  step(pad, frames, edges) {
    const st = this.stage;
    if (!st.body) return null;

    // The right stick turns the camera, and movement is relative to where the
    // camera is looking -- the same convention every third-person game uses,
    // and the reason a stage is playable with one stick and a d-pad.
    this.camera.yaw -= (pad.rx || 0) * 0.045 * frames;
    this.camera.pitch = Math.max(-0.6, Math.min(1.1,
      this.camera.pitch + (pad.ry || 0) * 0.02 * frames));

    const sin = Math.sin(this.camera.yaw), cos = Math.cos(this.camera.yaw);
    const inX = pad.lx || 0, inZ = pad.ly || 0;
    // Forward on the stick is away from the camera.
    const moveX = inX * cos - inZ * sin;
    const moveZ = -inX * sin - inZ * cos;
    const run = (pad.Circle || 0) > 0.5 || (pad.R1 || 0) > 0.5;

    const out = st.step(moveX, moveZ, run, frames);
    st.tickTraps(frames);

    const events = { door: out.door, entered: null, set: null, fired: null };
    if (edges) {
      if (out.door && edges.pressed(pad, 'Cross')) events.entered = out.door;
      if (edges.pressed(pad, 'Square')) {
        const tr = st.traps[this.selected];
        const spot = st.canSet(tr, st.body.pos);
        if (spot) events.set = st.setTrap(tr, spot);
      }
      if (edges.pressed(pad, 'L1')) this.selected =
        (this.selected + st.traps.length - 1) % st.traps.length;
      if (edges.pressed(pad, 'R1')) this.selected =
        (this.selected + 1) % st.traps.length;
    }
    this.pose();
    return { move: out, events };
  }

  /** Skin the actor for its current gait and put it where the body is. */
  pose() {
    const st = this.stage;
    const body = st.body;
    if (!this.actor || !body) return;
    const clip = this.actor.clips.get(body.gait) || this.actor.clips.get('idle');
    if (!clip) return;
    let duration = 0;
    for (const n of clip.nodes) if (n.duration > duration) duration = n.duration;
    const local = duration > 0 ? (body.clipTime % duration) : 0;
    const mats = saiMod.worldMatrices(this.actor.model, clip, local);
    const skinned = saiMod.skin(this.actor.model, mats);
    for (const child of this.actor.group.children) {
      const pn = skinned[child.userData.meshIndex];
      if (!pn) continue;
      child.geometry.attributes.position.array.set(pn.positions);
      child.geometry.attributes.position.needsUpdate = true;
      if (pn.normals && child.geometry.attributes.normal) {
        child.geometry.attributes.normal.array.set(pn.normals);
        child.geometry.attributes.normal.needsUpdate = true;
      }
    }
    const world = st.current.toWorld(body.pos);
    this.actor.group.position.set(world[0], world[1], world[2]);
    this.actor.group.rotation.y = body.yaw;
  }

  /**
   * Where the camera should be: behind the body at `distance`, pulled in to
   * the first wall between the two.
   *
   * The pull-in is a ray cast and not a push-out, which is the difference
   * between a camera that works in a corner and one that does not: once the
   * camera has ended up wholly behind a wall it overlaps nothing, so there is
   * no penetration for `pushOut` to resolve and it simply stays outside the
   * room looking at the back of the geometry.  Casting from the body outwards
   * cannot get into that state at all.
   */
  cameraPose() {
    const st = this.stage;
    const body = st.body;
    if (!body) return null;
    const c = this.camera;
    const cp = Math.cos(c.pitch);
    const eyeY = body.pos[1] + c.height;
    const want = [
      body.pos[0] - Math.sin(c.yaw) * cp * c.distance,
      eyeY + Math.sin(c.pitch) * c.distance,
      body.pos[2] - Math.cos(c.yaw) * cp * c.distance,
    ];
    const from = [body.pos[0], body.pos[1] + body.height * 0.6, body.pos[2]];
    const lo = Math.min(from[1], want[1]);
    const hi = Math.max(from[1], want[1]);
    const hit = colMod.rayWalls(st.current.mesh, from[0], from[2],
                                want[0], want[2], lo, hi);
    // Stop short of the wall by a margin, and never closer than a fraction of
    // the intended distance -- a camera that snaps to the body on every
    // doorframe is worse than one that clips a little.
    let t = 1;
    if (hit) {
      const span = Math.hypot(want[0] - from[0], want[2] - from[2]) || 1;
      t = Math.max(0.25, hit.t - CAMERA_MARGIN / span);
    }
    const local = [from[0] + (want[0] - from[0]) * t,
                   from[1] + (want[1] - from[1]) * t,
                   from[2] + (want[2] - from[2]) * t];
    return { eye: st.current.toWorld(local), target: st.current.toWorld(from) };
  }

  // -------------------------------------------------------------- the traps

  /** A trap's model and its `.tcd` footprint, read on first use. */
  async loadTrap(index) {
    if (this.trapCache.has(index)) return this.trapCache.get(index);
    const tr = this.stage.traps[index];
    const extra = await trapMod.loadOne(this.disc, tr);
    let group = null;
    if (extra && tr.model && extra.members.get(tr.model.toLowerCase())) {
      try {
        const model = smiMod.parse(extra.members.get(tr.model.toLowerCase()));
        const tex = textureCache(this.THREE);
        group = modelMod.build(this.THREE, model, smiMod.bindPose(model),
                               tex.make(extra.members),
                               { lights: this.lights,
                                 ps2: this.opts.ps2 !== false });
      } catch (e) { this.warnings.push(tr.name + ': ' + e.message); }
    }
    const rec = { trap: tr, group, footprint: extra ? extra.footprint : [] };
    this.trapCache.set(index, rec);
    return rec;
  }

  /** Put a set trap's model into the world. */
  async showPlaced(rec) {
    const built = await this.loadTrap(this.stage.traps.indexOf(rec.trap));
    if (!built.group) return null;
    const clone = built.group.clone();
    const world = this.stage.current.toWorld(rec.spot.at);
    clone.position.set(world[0], world[1], world[2]);
    if (rec.spot.normal)
      clone.rotation.y = Math.atan2(rec.spot.normal[0], rec.spot.normal[2]);
    this.placedGroup.add(clone);
    rec.object = clone;
    return clone;
  }

  // -------------------------------------------------------------- collision

  /** Draw the collision itself -- floors green, walls red, ceilings blue. */
  rebuildDebug() {
    const THREE = this.THREE;
    if (this.debugGroup) {
      this.root.remove(this.debugGroup);
      this.debugGroup.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
      this.debugGroup = null;
    }
    if (!this.showCollision || !this.stage.current) return;
    const room = this.stage.current;
    const g = new THREE.Group();
    const COLOURS = { floor: 0x51c46a, wall: 0xd05a5a, ceiling: 0x5a86d0 };
    for (const surface of ['floor', 'wall', 'ceiling']) {
      const pts = [];
      for (const f of room.mesh.faces) {
        if (f.surface !== surface) continue;
        for (const [a, b] of [[f.a, f.b], [f.b, f.c], [f.c, f.a]])
          pts.push(a[0], a[1], a[2], b[0], b[1], b[2]);
      }
      if (!pts.length) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position',
                       new THREE.BufferAttribute(new Float32Array(pts), 3));
      const line = new THREE.LineSegments(
        geo, new THREE.LineBasicMaterial({ color: COLOURS[surface] }));
      line.frustumCulled = false;
      g.add(line);
    }
    g.position.set(room.origin[0], room.origin[1], room.origin[2]);
    this.debugGroup = g;
    this.root.add(g);
  }

  setCollisionVisible(on) {
    this.showCollision = !!on;
    this.rebuildDebug();
  }
}

/**
 * `opts.script` is a `B##EVENT.ARC` path -- what the stage is told to contain.
 * Without one the stage is still walkable, just empty: no gimmicks, and the
 * player starts on the biggest patch of floor instead of where the script
 * says.
 */
async function create(THREE, disc, number, opts, onProgress) {
  const say = onProgress || (() => {});
  opts = opts || {};
  say('reading the stage graph');
  const player = await stageMod.loadPlayer(disc);
  say('reading collision');
  const cols = await stageMod.loadCollision(disc);
  const stage = await stageMod.load(disc, number, player, cols);
  const runner = new Runner(THREE, disc, stage, opts);
  await runner.loadCamera();

  if (opts.script) {
    say('reading the stage script');
    try { runner.script = await scriptMod.load(disc, opts.script); }
    catch (e) { runner.warnings.push('script: ' + e.message); }
    // The script's own `0x1E` is the map it expects.  If it disagrees with
    // the stage we were asked for, the two were paired wrongly and every
    // placement below would land in the wrong rooms.
    if (runner.script && runner.script.mapIndex !== null
        && runner.script.mapIndex !== number) {
      runner.warnings.push('script wants map M'
        + String(runner.script.mapIndex).padStart(3, '0') + ', not M'
        + String(number).padStart(3, '0'));
      runner.script = null;
    }
  }

  const spawn = runner.scriptedSpawn();
  const first = spawn ? spawn.room : [...stage.rooms.keys()].sort()[0];
  await runner.loadRoom(first, say);
  runner.showOnly(first);
  stage.enter(first, spawn ? spawn.local : null);
  if (spawn) {
    stage.body.yaw = spawn.angle;
    runner.camera.yaw = spawn.angle;
  }
  say('building the cast');
  await runner.loadActor(say);
  runner.showOnly(first);
  runner.pose();
  return runner;
}

const api = { create, Runner, lightsFromSli, applyLights, DEG, CAMERA_MARGIN };
if (typeof module !== 'undefined') module.exports = api;
if (typeof window !== 'undefined') window.TraptStageView = api;
})();
