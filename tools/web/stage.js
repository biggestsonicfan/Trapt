/**
 * A whole stage, assembled -- `tools/stage.py` in the browser.
 *
 * This is to the stage half of the game what `scene.js` is to the cutscene
 * half: it puts `mapbin.js` (the layout), `col.js` (the floors and walls) and
 * `trap.js` (what can be set on them) together and adds the small amount of
 * simulation a room needs to be walked around in.  Nothing in here touches
 * three.js or the DOM, so `test_stage.js` can diff it against the Python.
 *
 * **Physics happens in room-local space.**  A `.col` is authored around its
 * room's origin and `SRoomDef` translates it with no rotation at all, so the
 * body moves in room coordinates and only the renderer adds the offset.  That
 * keeps thousands of triangles from being transformed on every room change,
 * and makes a door crossing the one place the two frames meet.
 *
 * **The walk speed comes from the animation, not from a table.**  `CHR_DATA`
 * carries 30 and 60 for the two gaits and neither is units per second at any
 * frame rate that makes the feet plant.  Measuring the clip does work: the
 * foot bone's excursion along Z over one cycle is the distance the body
 * covers in that cycle, because the clips are authored in place.  For Allura
 * that is 12.00 units over 72 frames walking and 23.95 over 42 running, about
 * 10 and 34 units a second at 60 fps -- 1.0 and 3.6 m/s for a 15.42-unit
 * model at 1.6 m.  `CHR_DATA` is not noise either: 30/12.00 and 60/23.95 are
 * both 2.50, so it is the same pair of strides times a constant nobody has
 * explained yet.
 */
(function () {
'use strict';

const req = (typeof require !== 'undefined');
const colMod = req ? require('./col.js') : window.TraptCol;
const hbinMod = req ? require('./hbin.js') : window.TraptHbin;
const mapMod = req ? require('./mapbin.js') : window.TraptMapbin;
const trapMod = req ? require('./trap.js') : window.TraptTrap;
const arcMod = req ? require('./arc.js') : window.TraptArc;
const smiMod = req ? require('./smi.js') : window.TraptSmi;
const saiMod = req ? require('./sai.js') : window.TraptSai;

const PLAYER = 'c01f_a';
const FOOT_BONES = ['ashi_L', 'ashi_R'];
const HIP_BONE = 'koshi';
const DOOR_REACH = 24.0;
const SET_REACH = 60.0;

/**
 * The player, in one room's coordinates.  `pos` is the point between the
 * feet, which is where the `.SMI` origin is -- the bind pose runs 0.00 to
 * 15.42 -- so the collision query and the model transform are the same point.
 */
class Body {
  constructor(pos, radius, height, yaw) {
    this.pos = pos.slice();
    this.radius = radius;
    this.height = height;
    this.yaw = yaw || 0;
    this.gait = 'idle';
    this.hitWall = false;
    this.clipTime = 0;
  }
}

class Room {
  constructor(entry, mesh, doors) {
    this.entry = entry;
    this.id = entry.id;
    this.name = entry.name;
    this.origin = entry.pos;
    this.mesh = mesh;
    this.doors = doors;
  }
  toWorld(p) {
    return [p[0] + this.origin[0], p[1] + this.origin[1], p[2] + this.origin[2]];
  }
  toLocal(p) {
    return [p[0] - this.origin[0], p[1] - this.origin[1], p[2] - this.origin[2]];
  }
}

class Stage {
  constructor(number, graph, rooms, traps, player) {
    this.number = number;
    this.graph = graph;
    this.rooms = rooms;          // Map name -> Room
    this.traps = traps;
    this.player = player;
    this.placed = [];
    this.current = null;
    this.body = null;
  }

  enter(name, at) {
    const room = this.rooms.get(name);
    if (!room) return null;
    this.current = room;
    if (!at) at = colMod.spawnPoint(room.mesh);
    const ground = room.mesh.floorAt(at[0], at[2], at[1] + colMod.STEP_UP);
    const pos = [at[0], ground ? ground[0] : at[1], at[2]];
    if (!this.body) this.body = new Body(pos, this.player.radius, this.player.height);
    else this.body.pos = pos;
    return room;
  }

  /**
   * Advance the body by `frames` at 60 fps.  `moveX`/`moveZ` are a world-axis
   * direction of magnitude 0..1 -- the left stick, already deadzoned.
   */
  step(moveX, moveZ, run, frames) {
    frames = frames === undefined ? 1 : frames;
    const body = this.body;
    const mag = Math.sqrt(moveX * moveX + moveZ * moveZ);
    if (mag < 1e-4) {
      body.gait = 'idle';
      body.hitWall = false;
      body.clipTime += frames;
      return { moved: 0, hitWall: false, door: null };
    }
    const gait = run ? 'run' : 'walk';
    body.gait = gait;
    const speed = this.player.gaits[gait].speed;      // units per frame
    const ux = moveX / mag, uz = moveZ / mag;
    const step = speed * mag * frames;
    const before = body.pos.slice();
    const out = colMod.move(this.current.mesh, body.pos, ux * step, uz * step,
                            body.radius, body.height);
    body.pos = out.pos;
    body.hitWall = out.hitWall;
    // Face where the body went, not where it was pushed -- sliding along a
    // wall should not spin the character into it.
    body.yaw = Math.atan2(ux, uz);
    const moved = Math.hypot(body.pos[0] - before[0], body.pos[2] - before[2]);
    // The clip advances with the distance covered, so a body sliding along a
    // wall slows its legs instead of running on the spot.
    body.clipTime += frames * (step > 1e-9 ? moved / step : 0);
    return { moved, hitWall: out.hitWall, door: this.doorAt(body.pos) };
  }

  doorAt(pos) {
    for (const d of this.current.doors) {
      if (d.sealed || !d.to) continue;
      const dx = pos[0] - d.local[0];
      const dz = pos[2] - d.local[2];
      if (dx * dx + dz * dz <= DOOR_REACH * DOOR_REACH) return d;
    }
    return null;
  }

  /**
   * Cross a door.  The arrival point is found in *world* space -- the door's
   * own world position mapped into the destination -- rather than by pairing
   * door indices, because three of the 48 rooms ship more door meshes than
   * any one stage opens.  No floor there falls back to the spawn point.
   */
  goThrough(door) {
    const dest = this.rooms.get(door.to);
    if (!dest) return null;
    const local = dest.toLocal(door.world);
    const ground = dest.mesh.floorAt(local[0], local[2], local[1] + colMod.STEP_UP);
    if (!ground) return this.enter(dest.name);
    return this.enter(dest.name, [local[0], ground[0], local[2]]);
  }

  /**
   * Where trap `tr` would go from `pos`, or null.  Ceiling traps go overhead,
   * floor traps underfoot, wall traps on the nearest wall within reach.
   */
  canSet(tr, pos) {
    const mesh = this.current.mesh;
    if (tr.surface === 'floor') {
      const hit = mesh.floorAt(pos[0], pos[2], pos[1] + colMod.STEP_UP);
      return hit ? { surface: 'floor', at: [pos[0], hit[0], pos[2]] } : null;
    }
    if (tr.surface === 'ceiling') {
      const hit = mesh.ceilingAt(pos[0], pos[2], pos[1]);
      return hit ? { surface: 'ceiling', at: [pos[0], hit[0], pos[2]] } : null;
    }
    let best = null;
    for (const w of mesh.walls) {
      if (w.y1 <= pos[1] || w.y0 >= pos[1] + this.body.height) continue;
      const [cx, cz] = colMod.closestOnSegment(pos[0], pos[2],
                                               w.x1, w.z1, w.x2, w.z2);
      const d = Math.hypot(pos[0] - cx, pos[2] - cz);
      if (d > SET_REACH) continue;
      if (!best || d < best.d) best = { d, cx, cz, w };
    }
    if (!best) return null;
    return { surface: 'wall', at: [best.cx, pos[1], best.cz],
             normal: [best.w.nx, 0, best.w.nz] };
  }

  setTrap(tr, spot) {
    const rec = { trap: tr, room: this.current.name, spot,
                  armed: true, cooldown: 0 };
    this.placed.push(rec);
    return rec;
  }

  /** Tick every set trap's cooldown; returns the ones that just re-armed. */
  tickTraps(frames) {
    const rearmed = [];
    for (const rec of this.placed) {
      if (rec.armed) continue;
      rec.cooldown -= frames;
      if (rec.cooldown <= 0) { rec.cooldown = 0; rec.armed = true; rearmed.push(rec); }
    }
    return rearmed;
  }

  fire(rec) {
    if (!rec.armed) return false;
    rec.armed = false;
    rec.cooldown = rec.trap.reset;      // TrapInfo stores this in frames
    return true;
  }
}

// ------------------------------------------------------------ the character

/** `CHR_DATA` as far as it is understood: name and scale certain, speeds raw. */
function chrData(container) {
  const ch = container && container.first('CHR_DATA');
  if (!ch) return null;
  const d = ch.data;
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  let name = '';
  for (let i = 0; i < 16 && i < d.length && d[i]; i++)
    name += String.fromCharCode(d[i]);
  const f3 = (o) => [dv.getFloat32(o, true), dv.getFloat32(o + 4, true),
                     dv.getFloat32(o + 8, true)];
  const rows = [];
  for (const o of [0x30, 0x40])
    if (o + 16 <= d.length)
      rows.push([dv.getFloat32(o, true), dv.getFloat32(o + 4, true),
                 dv.getFloat32(o + 8, true), dv.getFloat32(o + 12, true)]);
  return { name, scale: f3(0x24), speeds: rows };
}

/** The body capsule from the hip `COL_DATA`: bone, two points, radius. */
function capsule(container) {
  if (!container) return null;
  for (const ch of container.allOf('COL_DATA')) {
    let bone = '';
    for (let i = 4; i < 16 && ch.data[i]; i++) bone += String.fromCharCode(ch.data[i]);
    if (bone !== HIP_BONE) continue;
    const dv = new DataView(ch.data.buffer, ch.data.byteOffset, ch.data.byteLength);
    const f3 = (o) => [dv.getFloat32(o, true), dv.getFloat32(o + 4, true),
                       dv.getFloat32(o + 8, true)];
    return { bone, a: f3(0x10), b: f3(0x20), radius: dv.getFloat32(0x30, true) };
  }
  return null;
}

/**
 * How far the body travels in one cycle of `clip`, from the feet.  The clips
 * are authored in place, so a foot bone's excursion along Z over the cycle
 * *is* the distance covered.  Both feet agree to the hundredth on the disc.
 */
function strideOf(model, clip, bones) {
  bones = bones || FOOT_BONES;
  const want = [];
  model.nodes.forEach((n, i) => { if (bones.includes(n.name)) want.push(i); });
  if (!want.length) return null;
  let duration = 0;
  for (const n of clip.nodes) if (n.duration > duration) duration = n.duration;
  if (duration <= 0) return null;
  const spans = [];
  for (const i of want) {
    let lo = Infinity, hi = -Infinity;
    for (let f = 0; f <= Math.floor(duration); f++) {
      const z = saiMod.worldMatrices(model, clip, f)[i][14];
      if (z < lo) lo = z;
      if (z > hi) hi = z;
    }
    spans.push(hi - lo);
  }
  const stride = Math.max(...spans);
  return { stride, duration, speed: stride / duration, perFoot: spans };
}

/** Allura's shape and gaits, measured from her own files. */
async function loadPlayer(disc, name) {
  name = name || PLAYER;
  const blob = await disc.read('DATA/CHARA/' + name.toUpperCase() + '.ARC');
  if (!blob) throw new Error('no character archive for ' + name);
  const members = arcMod.members(blob);
  const sta = members.get(name + '.sta');
  const container = sta ? hbinMod.parse(sta) : null;
  const model = smiMod.parse(members.get(name + '.smi'));

  let lo = Infinity, hi = -Infinity;
  for (const pn of smiMod.bindPose(model))
    for (let i = 1; i < pn.positions.length; i += 3) {
      const y = pn.positions[i];
      if (y < lo) lo = y;
      if (y > hi) hi = y;
    }
  const height = isFinite(lo) ? hi - lo : 15.0;

  const caps = capsule(container);
  const gaits = {};
  for (const [gait, file] of [['walk', name + '_001.sai'],
                              ['run', name + '_002.sai']]) {
    const clipBlob = members.get(file);
    if (!clipBlob) continue;
    const got = strideOf(model, saiMod.parse(clipBlob));
    if (got) { got.clip = file; gaits[gait] = got; }
  }
  return {
    name, model: name + '.smi', idle: name + '_000.sai',
    height, radius: caps ? caps.radius : 3.0, capsule: caps,
    chr: chrData(container), gaits, members,
  };
}

// ------------------------------------------------------------------- camera

const CAMERA_INIT = 'DATA/CAMERA/INIT.BIN';

/**
 * `DATA/CAMERA/INIT.BIN` -- seven records of four `s16`.  The file reads
 * `(18, 115, 40, 2)` three times then `(18, 180, 40, 2)` four times, so there
 * are two camera setups and seven slots to put them in.
 *
 * The **field names are inferred**, from nothing stronger than the numbers
 * being the right size for a third-person camera on a 15-unit character in a
 * 220-unit room: 18 as a pitch in degrees, 115 or 180 as a distance back, 40
 * as a height.  `raw` is kept so the guess can be checked, not trusted.
 */
async function cameraDefaults(disc) {
  const blob = await disc.read(CAMERA_INIT);
  if (!blob) return [];
  const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const out = [];
  for (let i = 0; i + 8 <= blob.length; i += 8) {
    const raw = [dv.getInt16(i, true), dv.getInt16(i + 2, true),
                 dv.getInt16(i + 4, true), dv.getInt16(i + 6, true)];
    out.push({ pitch: raw[0], distance: raw[1], height: raw[2], mode: raw[3],
               raw });
  }
  return out;
}

// ------------------------------------------------------- stage id -> map id

// The chapter tables name a *stage*, `M###.BIN` is indexed by a *map*, and
// there are 26 of the first and 22 of the second, so the two are not the same
// number.  Nothing in the ELF maps one to the other directly: the map index
// reaches `FUN_002e4ed0` -- which builds `data/map_data/bin/m###.bin` out of
// the 22-entry table at `0x00384190` -- as a plain integer argument to SSC
// opcode `0x1E`, so it is a literal inside a *stage script*.
//
// The stage scripts are `DATA/SCRIPT/B<nn><v>EVENT.ARC` and there are exactly
// **26** with a `B0`/`B1` prefix -- the stage count.  Each ships one
// `evsub_<room>.ssc` per room it uses, so the archive names its own rooms and
// the map falls out of matching that set against the 22 maps.  The match is
// by subset, because a script lists rooms while a map also lists the passages
// between them, and it is unique for all 26.
//
// Stage ids are assigned positionally: walk the chapters in order, giving
// each as many scripts as it has stages.  That consumes exactly 26, and the
// scripts' own two-digit prefix independently agrees with the chapter for 14
// of the 15 -- chapter 15's single stage is `B143EVENT`, sharing the `14`
// prefix, which is also why there is no `B15`.
//
// One ambiguity is left and it does not matter: chapter 10 lists its stages
// as (17, 16), so which of `B100`/`B101` is which is a guess.  Both resolve
// to the same map.

const SCRIPT_RE = /B[01]\d\dEVENT\.ARC$/;
const EVSUB_RE = /^evsub_(r[hpc]\d+)\.ssc$/;

function stageScripts(disc) {
  return disc.glob('DATA/SCRIPT/').filter((p) => SCRIPT_RE.test(p)).sort();
}

async function scriptRooms(disc, path) {
  const blob = await disc.read(path);
  const out = new Set();
  if (!blob) return out;
  let entries;
  try { entries = arcMod.entries(blob); } catch (e) { return out; }
  for (const e of entries) {
    const m = EVSUB_RE.exec(e.name.toLowerCase());
    if (m) out.add(m[1]);
  }
  return out;
}

/** Which map holds exactly, or contains, this room set: `{map, how}`. */
function mapForRooms(rooms, maps) {
  const exact = [];
  const sub = [];
  for (const [n, rs] of maps) {
    if (rs.size === rooms.size && [...rooms].every((r) => rs.has(r))) exact.push(n);
    if (rooms.size && [...rooms].every((r) => rs.has(r))) sub.push(n);
  }
  if (exact.length === 1) return { map: exact[0], how: 'exact' };
  if (sub.length === 1) return { map: sub[0], how: 'subset' };
  return { map: null, how: 'ambiguous' };
}

/** `Map` of stage id -> `{script, rooms, map, how, chapter}` for all 26. */
async function stageMapTable(disc, chapters) {
  const maps = new Map();
  for (const n of mapMod.stageNumbers(disc)) {
    const g = await mapMod.load(disc, n);
    maps.set(n, new Set(g.rooms.map((r) => r.id)));
  }
  const scripts = stageScripts(disc);
  const out = new Map();
  let i = 0;
  for (const chapter of chapters) {
    for (const s of chapter.stages || []) {
      if (i >= scripts.length) break;
      const path = scripts[i++];
      const rooms = await scriptRooms(disc, path);
      const got = mapForRooms(rooms, maps);
      out.set(typeof s === 'number' ? s : s.stage, {
        script: path, rooms: [...rooms].sort(),
        map: got.map, how: got.how, chapter: chapter.index,
      });
    }
  }
  return out;
}

// ----------------------------------------------------------------- assembly

/** Every `.col` on the disc, keyed by room id. */
async function loadCollision(disc) {
  const out = new Map();
  for (const path of disc.glob('DATA/MAP_DATA/COLLISION/')) {
    const blob = await disc.read(path);
    if (!blob) continue;
    let entries;
    try { entries = arcMod.entries(blob); } catch (e) { continue; }
    for (const e of entries) {
      const low = e.name.toLowerCase();
      if (!low.endsWith('.col')) continue;
      out.set(low.slice(0, -'_ri.col'.length),
              blob.subarray(e.offset, e.offset + e.size));
    }
  }
  return out;
}

async function load(disc, number, player, cols) {
  const graph = await mapMod.load(disc, number);
  const meshes = cols || await loadCollision(disc);
  const rooms = new Map();

  for (const entry of graph.rooms) {
    const blob = meshes.get(entry.id);
    if (!blob) continue;
    const mesh = colMod.parse(blob);
    const models = await mapMod.doorModels(disc, entry.id);
    const doors = [];
    for (const d of graph.ownedDoors(entry.name)) {
      const got = models.get(d.number);
      if (!got) continue;
      const local = got.pos;
      let to = d.bRoom;
      if (d.sealed || to === mapMod.NOT_USE || !graph.room(to)) to = null;
      doors.push({
        number: d.number, index: d.index, local, to, sealed: d.sealed,
        world: [local[0] + entry.pos[0], local[1] + entry.pos[1],
                local[2] + entry.pos[2]],
      });
    }
    rooms.set(entry.name, new Room(entry, mesh, doors));
  }

  // A passage has no doors of its own -- the door mesh belongs to the room --
  // so give it the far side of every door that leads into it.  Without this a
  // corridor is a room you can walk into and never out of.
  for (const entry of graph.rooms) {
    if (!entry.passage || !rooms.has(entry.name)) continue;
    const here = rooms.get(entry.name);
    for (const other of graph.rooms) {
      if (other.name === entry.name || !rooms.has(other.name)) continue;
      for (const d of rooms.get(other.name).doors) {
        if (d.to !== entry.name) continue;
        here.doors.push({ number: -1, index: d.index,
                          local: here.toLocal(d.world), world: d.world,
                          to: other.name, sealed: false });
      }
    }
  }

  const traps = await trapMod.loadAll(disc);
  return new Stage(number, graph, rooms, traps,
                   player || await loadPlayer(disc));
}

const api = { load, loadPlayer, loadCollision, cameraDefaults,
              Stage, Room, Body, chrData, capsule, strideOf,
              stageScripts, scriptRooms, mapForRooms, stageMapTable,
              PLAYER, DOOR_REACH, SET_REACH, FOOT_BONES, HIP_BONE,
              CAMERA_INIT };
if (typeof module !== 'undefined') module.exports = api;
if (typeof window !== 'undefined') window.TraptStage = api;
})();
