/**
 * Diff the stage half of the browser against the Python, on the real disc.
 *
 *   node tools/web/test_stage.js ["path/to/Trapt (USA).iso"]
 *
 * `col.js`, `mapbin.js`, `trap.js` and `stage.js` have to agree with
 * `tools/col.py`, `tools/mapbin.py`, `tools/trap.py` and `tools/stage.py`
 * exactly, and the collision solver most of all: it is the one piece of this
 * repository where the two copies produce *motion* rather than a picture, so
 * a drift of a thousandth per step is a player who walks through a wall in
 * one of them and not the other, a hundred frames later.
 *
 * So the walk here is scripted, deterministic, and compared step for step
 * rather than at the end -- the first frame that disagrees is the one worth
 * seeing, not the thousandth.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const iso = require('./iso.js');
const discMod = require('./disc.js');
const arcMod = require('./arc.js');
const colMod = require('./col.js');
const hbinMod = require('./hbin.js');
const mapMod = require('./mapbin.js');
const trapMod = require('./trap.js');
const stageMod = require('./stage.js');

const ISO = process.argv[2]
  || 'E:/Seagate/OpenSuseBack/Emulators/PS2EMU/Trapt (USA).iso';
const TOOLS = path.join(__dirname, '..');

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log('  %s %s%s', ok ? 'ok  ' : 'FAIL', what,
              ok ? '' : '\n        got  ' + JSON.stringify(got) +
                        '\n        want ' + JSON.stringify(want));
}
function near(what, got, want, tol) {
  const a = [].concat(got), b = [].concat(want);
  let worst = 0;
  const ok = a.length === b.length
    && a.every((v, i) => {
      const d = Math.abs(v - b[i]);
      if (d > worst) worst = d;
      return d <= tol;
    });
  if (!ok) failures++;
  console.log('  %s %s%s', ok ? 'ok  ' : 'FAIL', what,
              ok ? ' (max |diff| ' + worst.toExponential(1) + ')'
                 : '\n        worst |diff| ' + worst +
                   '\n        got  ' + JSON.stringify(a).slice(0, 200) +
                   '\n        want ' + JSON.stringify(b).slice(0, 200));
}

function python(code) {
  return JSON.parse(execFileSync('python', ['-c', code],
                                 { cwd: TOOLS, maxBuffer: 1 << 28,
                                   encoding: 'utf8' }));
}

// A spread of rooms: a big room shell, a corridor, a Palace room and a Castle
// room, so material 3 shells, bare floors and the triangle groups all appear.
const ROOMS = ['rh01', 'rh11', 'rp05', 'rc01', 'rh08'];
const STAGES = [0, 1, 2, 9];

/** The same scripted input on both sides -- no randomness, no timing. */
const WALK_FRAMES = 400;
function walkInput(f) {
  const a = f * 0.037;
  return [Math.sin(a), Math.cos(a * 0.7), f % 90 > 45];
}

async function main() {
  if (!fs.existsSync(ISO)) {
    console.log('disc image not found: %s', ISO);
    process.exit(2);
  }
  const source = iso.fdSource(fs, ISO);
  const disc = await discMod.open(source);

  // ------------------------------------------------------------------- .col
  console.log('.col collision, against tools/col.py');
  const cols = await stageMod.loadCollision(disc);
  const pyCol = python(
    'import col, json, scene; d = scene.Disc();'
    + ' want = ' + JSON.stringify(ROOMS) + ';'
    + ' out = {};\n'
    + 'for _p, name, blob in col.all_cols(d):\n'
    + '    rid = name[:-len("_ri.col")]\n'
    + '    if rid not in want: continue\n'
    + '    m = col.parse(blob)\n'
    + '    lo, hi = m.bounds\n'
    + '    sp = col.spawn_point(m)\n'
    + '    out[rid] = {"groups": [[g.material, g.verts, len(g.prims), g.offset]'
    + ' for g in m.groups], "faces": len(m.faces), "floors": len(m.floors),'
    + ' "ceilings": len(m.ceilings), "walls": len(m.walls),'
    + ' "bounds": [list(lo), list(hi)], "spawn": list(sp),'
    + ' "wall0": [m.walls[0].x1, m.walls[0].z1, m.walls[0].x2, m.walls[0].z2,'
    + ' m.walls[0].y0, m.walls[0].y1, m.walls[0].nx, m.walls[0].nz]}\n'
    + 'print(json.dumps(out))');

  const meshes = {};
  for (const rid of ROOMS) {
    const blob = cols.get(rid);
    if (!blob) { check(rid + ' present', false, true); continue; }
    const m = colMod.parse(blob);
    meshes[rid] = m;
    const want = pyCol[rid];
    check(rid + ' groups',
          m.groups.map((g) => [g.material, g.verts, g.prims.length, g.offset]),
          want.groups);
    check(rid + ' face counts',
          [m.faces.length, m.floors.length, m.ceilings.length, m.walls.length],
          [want.faces, want.floors, want.ceilings, want.walls]);
    near(rid + ' bounds', m.bounds[0].concat(m.bounds[1]),
         want.bounds[0].concat(want.bounds[1]), 1e-4);
    near(rid + ' spawn point', colMod.spawnPoint(m), want.spawn, 1e-4);
    const w = m.walls[0];
    near(rid + ' first wall segment',
         [w.x1, w.z1, w.x2, w.z2, w.y0, w.y1, w.nx, w.nz], want.wall0, 1e-5);
  }

  // ----------------------------------------------------------- floor queries
  console.log('floor and ceiling queries');
  const probeRoom = 'rh01';
  const probes = [];
  const [plo, phi] = meshes[probeRoom].bounds;
  for (let i = 0; i < 40; i++) {
    const t = i / 39;
    probes.push([plo[0] + (phi[0] - plo[0]) * t,
                 plo[2] + (phi[2] - plo[2]) * ((i * 7) % 40) / 39]);
  }
  const pyProbe = python(
    'import col, json, scene; d = scene.Disc();'
    + ' probes = ' + JSON.stringify(probes) + ';'
    + ' rid = "' + probeRoom + '";\n'
    + 'for _p, name, blob in col.all_cols(d):\n'
    + '    if name[:-len("_ri.col")] != rid: continue\n'
    + '    m = col.parse(blob)\n'
    + '    out = []\n'
    + '    for x, z in probes:\n'
    + '        f = m.floor_at(x, z, 400.0, 400.0, 800.0)\n'
    + '        c = m.ceiling_at(x, z, -400.0, 2000.0)\n'
    + '        out.append([f[0] if f else None, c[0] if c else None])\n'
    + '    print(json.dumps(out)); break');
  const jsProbe = probes.map(([x, z]) => {
    const f = meshes[probeRoom].floorAt(x, z, 400.0, 400.0, 800.0);
    const c = meshes[probeRoom].ceilingAt(x, z, -400.0, 2000.0);
    return [f ? f[0] : null, c ? c[0] : null];
  });
  check('40 floor/ceiling probes hit the same surfaces',
        jsProbe.map((p) => p.map((v) => v === null)),
        pyProbe.map((p) => p.map((v) => v === null)));
  near('40 floor/ceiling probe heights',
       jsProbe.flat().filter((v) => v !== null),
       pyProbe.flat().filter((v) => v !== null), 1e-4);

  // --------------------------------------------------------- the camera ray
  console.log('the wall ray cast the follow camera is pulled in by');
  {
    const rays = [];
    for (let i = 0; i < 60; i++) {
      const a = i * 0.31;
      rays.push([Math.cos(a) * 40, Math.sin(a) * 40,
                 Math.cos(a * 1.7) * 260, Math.sin(a * 1.7) * 260]);
    }
    const py = python(
      'import col, json, scene; d = scene.Disc();'
      + ' rays = ' + JSON.stringify(rays) + ';'
      + ' rid = "' + probeRoom + '";\n'
      + 'for _p, name, blob in col.all_cols(d):\n'
      + '    if name[:-len("_ri.col")] != rid: continue\n'
      + '    m = col.parse(blob)\n'
      + '    out = []\n'
      + '    for x0, z0, x1, z1 in rays:\n'
      + '        h = col.ray_walls(m, x0, z0, x1, z1, 0.0, 60.0)\n'
      + '        out.append(None if h is None else [h[0], h[1].group])\n'
      + '    print(json.dumps(out)); break');
    const js = rays.map(([x0, z0, x1, z1]) => {
      const h = colMod.rayWalls(meshes[probeRoom], x0, z0, x1, z1, 0, 60);
      return h === null ? null : [h.t, h.wall.group];
    });
    check('60 rays hit or miss the same walls',
          js.map((v) => v === null ? null : v[1]),
          py.map((v) => v === null ? null : v[1]));
    near('60 ray distances',
         js.filter(Boolean).map((v) => v[0]),
         py.filter(Boolean).map((v) => v[0]), 1e-6);
  }

  // ----------------------------------------------------------- the stage graph
  console.log('M###.BIN stage graphs, against tools/mapbin.py');
  const pyStages = python(
    'import mapbin, json, scene; d = scene.Disc();'
    + ' want = ' + JSON.stringify(STAGES) + ';'
    + ' out = {};\n'
    + 'for n in want:\n'
    + '    st = mapbin.load(d, n)\n'
    + '    out[str(n)] = {"map": st.map_id,'
    + ' "rooms": [[r.name, r.id, list(r.pos), r.index, r.passage, r.links]'
    + ' for r in st.rooms],'
    + ' "doors": [[dd.index, dd.sealed, dd.a_room, dd.b_room, dd.number]'
    + ' for dd in st.doors]}\n'
    + 'print(json.dumps(out))');
  for (const n of STAGES) {
    const g = await mapMod.load(disc, n);
    const want = pyStages[String(n)];
    check('M' + n + ' map id', g.mapId, want.map);
    check('M' + n + ' rooms',
          g.rooms.map((r) => [r.name, r.id, r.pos, r.index, r.passage, r.links]),
          want.rooms);
    check('M' + n + ' doors',
          g.doors.map((d) => [d.index, d.sealed, d.aRoom, d.bRoom, d.number]),
          want.doors);
  }

  // ------------------------------------------------------------- door meshes
  console.log('door meshes and their room-local positions');
  const pyDoors = python(
    'import mapbin, json, scene; d = scene.Disc();'
    + ' want = ' + JSON.stringify(ROOMS) + ';'
    + ' print(json.dumps({r: {str(k): [v[0], list(v[1])]'
    + ' for k, v in mapbin.door_models(d, r).items()} for r in want}))');
  for (const rid of ROOMS) {
    const got = await mapMod.doorModels(disc, rid);
    const rows = {};
    for (const [k, v] of got) rows[String(k)] = [v.file, v.pos];
    check(rid + ' door meshes', rows, pyDoors[rid]);
  }

  // -------------------------------------------------------------- the traps
  console.log('trap tables, against tools/trap.py');
  const pyTraps = python(
    'import trap, json, scene; d = scene.Disc();'
    + ' ts = trap.load_all(d); out = [];\n'
    + 'import arc\n'
    + 'for t in ts:\n'
    + '    blob = d.read(t.archive)\n'
    + '    mem = {n.lower(): blob[o:o+s] for n, o, s in arc.entries(blob)}\n'
    + '    td = trap.parse_td(mem[t.name.lower() + ".td"])\n'
    + '    fp = trap.footprint(trap.parse_tcd(mem[t.name.lower() + ".tcd"]))\n'
    + '    out.append([t.name, t.surface, t.title, t.blurb, t.damage, t.reset,'
    + ' t.cost, t.price, td["model"], td["effect"],'
    + ' [[f[0], list(f[1]), list(f[2])] for f in fp]])\n'
    + 'print(json.dumps(out))');
  const traps = await trapMod.loadAll(disc);
  check('48 traps in the master table', traps.length, 48);
  const jsTraps = [];
  for (const t of traps) {
    const extra = await trapMod.loadOne(disc, t);
    jsTraps.push([t.name, t.surface, t.title, t.blurb, t.damage, t.reset,
                  t.cost, t.price, t.model, t.effect,
                  extra.footprint.map((f) => [f.name, f.min, f.max])]);
  }
  check('every trap: name, surface, both texts, stats, model, footprint',
        jsTraps, pyTraps);

  // ------------------------------------------------------------- the player
  console.log('the player, measured from her own files');
  const pyPlayer = python(
    'import stage, json, scene; d = scene.Disc();'
    + ' p = stage.load_player(d);'
    + ' print(json.dumps({"height": p["height"], "radius": p["radius"],'
    + ' "capsule": [p["capsule"]["bone"], list(p["capsule"]["a"]),'
    + ' list(p["capsule"]["b"]), p["capsule"]["radius"]],'
    + ' "chr": [p["chr"]["name"], list(p["chr"]["scale"]), p["chr"]["speeds"]],'
    + ' "gaits": {k: [v["stride"], v["duration"], v["speed"], v["clip"]]'
    + ' for k, v in p["gaits"].items()}}))');
  const player = await stageMod.loadPlayer(disc);
  near('bind-pose height', player.height, pyPlayer.height, 1e-4);
  check('capsule',
        [player.capsule.bone, player.capsule.a, player.capsule.b,
         player.capsule.radius],
        pyPlayer.capsule);
  check('CHR_DATA', [player.chr.name, player.chr.scale, player.chr.speeds],
        pyPlayer.chr);
  for (const gait of ['walk', 'run']) {
    near(gait + ' stride and speed',
         [player.gaits[gait].stride, player.gaits[gait].duration,
          player.gaits[gait].speed],
         pyPlayer.gaits[gait].slice(0, 3), 1e-4);
    check(gait + ' clip', player.gaits[gait].clip, pyPlayer.gaits[gait][3]);
  }

  console.log('camera defaults out of DATA/CAMERA/INIT.BIN');
  {
    const py = python('import stage, json, scene; d = scene.Disc();'
                      + ' print(json.dumps([c["raw"] for c in'
                      + ' stage.camera_defaults(d)]))');
    const js = await stageMod.cameraDefaults(disc);
    check('seven records, same values', js.map((c) => c.raw), py);
  }

  console.log('which map each of the 26 stages means');
  {
    const py = python(
      'import stage, json, order, scene; d = scene.Disc();'
      + ' t = stage.stage_map_table(d);'
      + ' print(json.dumps([[s, t[s]["script"].split("/")[-1], t[s]["map"],'
      + ' t[s]["how"], t[s]["rooms"], t[s]["chapter"]] for s in sorted(t)]))');
    const story = require('./story.js');
    const tables = story.read(disc);
    const js = await stageMod.stageMapTable(disc, tables.chapters);
    check('26 stages, all resolved',
          [js.size, [...js.values()].filter((r) => r.map !== null).length],
          [26, 26]);
    check('the same script, map, match kind and rooms for every stage',
          [...js.keys()].sort((a, b) => a - b).map((s) => {
            const r = js.get(s);
            return [s, r.script.split('/').pop(), r.map, r.how, r.rooms,
                    r.chapter];
          }), py);
    // The two facts the derivation rests on, asserted rather than assumed.
    check('there are exactly 26 stage scripts',
          stageMod.stageScripts(disc).length, 26);
    check('stage 0 is the House and stage 25 the last sealed room',
          [js.get(0).map, js.get(25).map], [0, 6]);
  }

  // ------------------------------------------------------- assembly + walking
  console.log('stage assembly and the walk solver');
  const pyAssembled = python(
    'import stage, json, scene; d = scene.Disc();'
    + ' st = stage.load(d, 0);'
    + ' print(json.dumps({name: {"origin": list(r.origin),'
    + ' "doors": [[dd["number"], dd["to"], [round(v, 4) for v in dd["world"]],'
    + ' [round(v, 4) for v in dd["local"]], dd["sealed"]] for dd in r.doors]}'
    + ' for name, r in sorted(st.rooms.items())}))');
  const st = await stageMod.load(disc, 0, player, cols);
  const jsAssembled = {};
  for (const name of [...st.rooms.keys()].sort()) {
    const r = st.rooms.get(name);
    jsAssembled[name] = {
      origin: r.origin,
      doors: r.doors.map((d) => [d.number, d.to,
                                 d.world.map((v) => +v.toFixed(4)),
                                 d.local.map((v) => +v.toFixed(4)), d.sealed]),
    };
  }
  check('M000 assembles to the same rooms and doors', jsAssembled, pyAssembled);

  const pyWalk = python(
    'import stage, json, math, scene; d = scene.Disc();'
    + ' st = stage.load(d, 0);'
    + ' st.enter(sorted(st.rooms)[0]);'
    + ' out = [];\n'
    + 'for f in range(' + WALK_FRAMES + '):\n'
    + '    a = f * 0.037\n'
    + '    r = st.step(math.sin(a), math.cos(a * 0.7), f % 90 > 45)\n'
    + '    out.append([st.body.pos[0], st.body.pos[1], st.body.pos[2],'
    + ' 1 if r["hit_wall"] else 0])\n'
    + 'print(json.dumps(out))');
  st.enter([...st.rooms.keys()].sort()[0]);
  const jsWalk = [];
  for (let f = 0; f < WALK_FRAMES; f++) {
    const [mx, mz, run] = walkInput(f);
    const r = st.step(mx, mz, run);
    jsWalk.push([st.body.pos[0], st.body.pos[1], st.body.pos[2],
                 r.hitWall ? 1 : 0]);
  }
  // Report the first frame that disagrees rather than only the worst.
  let firstBad = -1;
  for (let f = 0; f < WALK_FRAMES && firstBad < 0; f++)
    for (let k = 0; k < 4; k++)
      if (Math.abs(jsWalk[f][k] - pyWalk[f][k]) > 1e-4) { firstBad = f; break; }
  check('the walk never diverges over ' + WALK_FRAMES + ' frames',
        firstBad, -1);
  near('walk positions', jsWalk.flat(), pyWalk.flat(), 1e-4);

  // A crossing exercises the world-space arrival, which is the one place the
  // room-local physics and the stage's world layout have to agree.
  const pyCross = python(
    'import stage, json, scene; d = scene.Disc();'
    + ' st = stage.load(d, 0); out = [];\n'
    + 'for name in sorted(st.rooms):\n'
    + '    st.enter(name)\n'
    + '    for door in st.rooms[name].doors:\n'
    + '        if not door["to"]: continue\n'
    + '        st.enter(name)\n'
    + '        st.go_through(door)\n'
    + '        out.append([name, door["to"], st.current.name,'
    + ' [round(v, 4) for v in st.body.pos]])\n'
    + 'print(json.dumps(out))');
  const jsCross = [];
  for (const name of [...st.rooms.keys()].sort()) {
    st.enter(name);
    for (const door of st.rooms.get(name).doors) {
      if (!door.to) continue;
      st.enter(name);
      st.goThrough(door);
      jsCross.push([name, door.to, st.current.name,
                    st.body.pos.map((v) => +v.toFixed(4))]);
    }
  }
  check('every door lands in the same place on both sides', jsCross, pyCross);

  // ------------------------------------------------------------ trap placing
  console.log('trap placement');
  const pySet = python(
    'import stage, json, scene; d = scene.Disc();'
    + ' st = stage.load(d, 0); st.enter("RH_01"); out = [];\n'
    + 'for t in st.traps[::7]:\n'
    + '    spot = st.can_set(t, st.body.pos)\n'
    + '    out.append([t.name, t.surface, None if spot is None else'
    + ' [spot["surface"], [round(v, 4) for v in spot["at"]]]])\n'
    + 'print(json.dumps(out))');
  st.enter('RH_01');
  const jsSet = [];
  for (let i = 0; i < st.traps.length; i += 7) {
    const t = st.traps[i];
    const spot = st.canSet(t, st.body.pos);
    jsSet.push([t.name, t.surface,
                spot ? [spot.surface, spot.at.map((v) => +v.toFixed(4))] : null]);
  }
  check('traps land on the same surfaces', jsSet, pySet);

  console.log('\n%s', failures ? failures + ' FAILED' : 'all checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
