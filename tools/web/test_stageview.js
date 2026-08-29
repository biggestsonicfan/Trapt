/**
 * Run the stage the way the page does, headless.
 *
 *   node tools/web/test_stageview.js ["path/to/Trapt (USA).iso"]
 *
 * `test_stage.js` proves the simulation matches the Python.  This proves the
 * layer above it actually assembles and runs: the room's geometry and lights
 * come off the disc, Allura is built and skinned, the pad drives her, the
 * camera follows, a door is crossed and a trap is set.
 *
 * WebGL cannot run here, but almost nothing that breaks in this layer needs a
 * GPU -- a missing archive, a clip that is not in the rig, a light rig the
 * material does not match, a camera that ends up inside a wall, a skinned
 * vertex array of the wrong length.  `stub_three.js` has the object shapes,
 * so all of that is visible.
 */
'use strict';

const fs = require('fs');

const iso = require('./iso.js');
const discMod = require('./disc.js');
const colMod = require('./col.js');
const padMod = require('./pad.js');
const stageMod = require('./stage.js');
const viewMod = require('./stageview.js');
const { stubThree } = require('./stub_three.js');

const ISO = process.argv[2]
  || 'E:/Seagate/OpenSuseBack/Emulators/PS2EMU/Trapt (USA).iso';

let failures = 0;
function check(what, ok, detail) {
  if (!ok) failures++;
  console.log('  %s %s%s', ok ? 'ok  ' : 'FAIL', what,
              ok || !detail ? '' : '\n        ' + detail);
}

/** A pad state object, as `pad.read()` would return it. */
function padState(over) {
  const s = {};
  for (const t of padMod.PAD_TARGETS) s[t] = 0;
  s.lx = 0; s.ly = 0; s.rx = 0; s.ry = 0; s.connected = 0;
  return Object.assign(s, over || {});
}

async function main() {
  if (!fs.existsSync(ISO)) {
    console.log('disc image not found: %s', ISO);
    process.exit(2);
  }
  const THREE = stubThree();
  const disc = await discMod.open(iso.fdSource(fs, ISO));

  console.log('assembling stage M000 the way the page does');
  const notes = [];
  const runner = await viewMod.create(THREE, disc, 0, { ps2: true },
                                      (m) => notes.push(m));
  const st = runner.stage;
  check('it reported progress', notes.length >= 3, notes.join(' / '));
  check('no warnings while assembling', runner.warnings.length === 0,
        runner.warnings.join('; '));
  check('16 rooms in the stage', st.rooms.size === 16, String(st.rooms.size));
  check('the body is standing somewhere', !!st.body && !!st.current,
        JSON.stringify(st.body && st.body.pos));
  check('the first room is built and visible',
        runner.rooms.get(st.current.name).group.visible === true);
  check('the room group sits at the room origin',
        runner.rooms.get(st.current.name).group.position.x === st.current.origin[0]);

  console.log('the cast');
  check('Allura has a rig with meshes', runner.actor.group.children.length > 0,
        String(runner.actor.group.children.length));
  check('all three gait clips loaded',
        ['idle', 'walk', 'run'].every((g) => runner.actor.clips.get(g)),
        [...runner.actor.clips.keys()].join(','));
  check('the room supplied a light rig',
        !!runner.rooms.get(st.current.name).lights.points);

  console.log('the camera, from DATA/CAMERA/INIT.BIN');
  check('it took the file values, not invented ones',
        runner.camera.distance === 115 && runner.camera.height === 40,
        JSON.stringify(runner.camera));
  const pose0 = runner.cameraPose();
  check('the camera is behind and above the body',
        pose0.eye[1] > st.current.toWorld(st.body.pos)[1],
        JSON.stringify(pose0));

  console.log('walking with a pad');
  const before = st.body.pos.slice();
  const edges = new padMod.Edges();
  for (let f = 0; f < 240; f++)
    runner.step(padState({ ly: -1, lx: Math.sin(f * 0.03) * 0.6 }), 1, edges);
  const moved = Math.hypot(st.body.pos[0] - before[0], st.body.pos[2] - before[2]);
  check('the body moved', moved > 20, 'moved ' + moved.toFixed(1));
  check('and is still on a floor',
        !!st.current.mesh.floorAt(st.body.pos[0], st.body.pos[2],
                                  st.body.pos[1] + 1),
        JSON.stringify(st.body.pos));
  check('the actor followed it', Math.abs(runner.actor.group.position.x
          - st.current.toWorld(st.body.pos)[0]) < 1e-3);
  check('the gait changed from idle', st.body.gait !== 'idle', st.body.gait);
  check('skinning wrote through to the geometry',
        runner.actor.group.children.every(
          (c) => c.geometry.attributes.position.needsUpdate));

  console.log('running is faster than walking');
  {
    st.enter(st.current.name);
    const a = st.body.pos.slice();
    for (let f = 0; f < 60; f++) runner.step(padState({ ly: -1 }), 1, edges);
    const walked = Math.hypot(st.body.pos[0] - a[0], st.body.pos[2] - a[2]);
    st.enter(st.current.name);
    const b = st.body.pos.slice();
    for (let f = 0; f < 60; f++)
      runner.step(padState({ ly: -1, Circle: 1 }), 1, edges);
    const ran = Math.hypot(st.body.pos[0] - b[0], st.body.pos[2] - b[2]);
    check('run covers more ground than walk in the same 60 frames',
          ran > walked * 2, 'walk ' + walked.toFixed(1) + ', run ' + ran.toFixed(1));
  }

  console.log('the camera stays inside the room');
  {
    let outside = 0;
    const [lo, hi] = st.current.mesh.bounds;
    st.enter(st.current.name);
    for (let f = 0; f < 400; f++) {
      const a = f * 0.05;
      runner.step(padState({ ly: Math.cos(a), lx: Math.sin(a),
                             rx: Math.sin(a * 0.3) }), 1, edges);
      const eye = st.current.toLocal(runner.cameraPose().eye);
      // Vertically a camera may legitimately sit above a low room; the pull-in
      // is a horizontal test, so this is too.
      if (eye[0] < lo[0] || eye[0] > hi[0] || eye[2] < lo[2] || eye[2] > hi[2])
        outside++;
    }
    check('the camera never leaves the room at all',
          outside === 0, outside + ' of 400 frames');
  }

  console.log('crossing a door');
  {
    const from = st.current.name;
    const door = st.current.doors.find((d) => d.to);
    check('the starting room has a door that leads somewhere', !!door);
    await runner.enter(door.to, st.rooms.get(door.to).toLocal(door.world),
                       () => {});
    check('the body is in the new room', st.current.name === door.to,
          st.current.name);
    check('and standing on its floor',
          !!st.current.mesh.floorAt(st.body.pos[0], st.body.pos[2],
                                    st.body.pos[1] + 1));
    check('the new room is the only one visible',
          [...runner.rooms.entries()].filter(([, r]) => r.group.visible)
            .map(([n]) => n).join(',') === door.to);
    check('the old room stayed loaded', runner.rooms.has(from));
  }

  console.log('setting a trap');
  {
    await runner.enter('RH_01', null, () => {});
    const results = { floor: 0, wall: 0, ceiling: 0, none: 0 };
    for (let i = 0; i < st.traps.length; i++) {
      const spot = st.canSet(st.traps[i], st.body.pos);
      results[spot ? spot.surface : 'none']++;
    }
    check('every trap found a surface to sit on', results.none === 0,
          JSON.stringify(results));
    check('the three surfaces are used as the ids say',
          results.ceiling === 16 && results.wall === 16 && results.floor === 16,
          JSON.stringify(results));

    runner.selected = 0;                       // TC00 Guillotine, a ceiling trap
    const set = runner.step(padState({ Square: 1 }), 1, edges);
    check('Square sets the selected trap', !!set.events.set,
          JSON.stringify(set.events));
    const rec = set.events.set;
    check('it landed on the ceiling', rec.spot.surface === 'ceiling');
    check('above the body',
          rec.spot.at[1] > st.body.pos[1], JSON.stringify(rec.spot.at));
    const obj = await runner.showPlaced(rec);
    check('its model was read and placed', !!obj);
    check('at the spot in world space',
          obj && Math.abs(obj.position.y
            - st.current.toWorld(rec.spot.at)[1]) < 1e-3);

    check('firing it starts the reset timer',
          st.fire(rec) && !rec.armed && rec.cooldown === rec.trap.reset,
          JSON.stringify({ armed: rec.armed, cd: rec.cooldown }));
    st.tickTraps(rec.trap.reset - 1);
    check('it is still cooling down', !rec.armed);
    st.tickTraps(2);
    check('and re-arms when the timer runs out', rec.armed);
  }

  // The stage script is what a stage is *told* to contain: where the player
  // starts, what is placed in each room, who walks in.  Without it a stage is
  // walkable but empty.
  console.log('the stage script, dressing M000');
  {
    const dressed = await viewMod.create(THREE, disc, 0,
      { ps2: true, script: 'DATA/SCRIPT/B010EVENT.ARC' }, () => {});
    check('no warnings', dressed.warnings.length === 0,
          dressed.warnings.join('; '));
    check('the script agrees it is map 0', dressed.script.mapIndex === 0,
          String(dressed.script.mapIndex));
    check('it places 57 gimmicks over 8 rooms',
          Object.values(dressed.script.rooms).reduce((a, b) => a + b.length, 0)
            === 57 && Object.keys(dressed.script.rooms).length === 8,
          JSON.stringify(Object.keys(dressed.script.rooms)));
    check('and names one cast member', dressed.script.actors.length === 1
          && dressed.script.actors[0].model === 'c30m_d',
          JSON.stringify(dressed.script.actors));

    const spawn = dressed.scriptedSpawn();
    check('the scripted start resolves to a room', !!spawn,
          JSON.stringify(dressed.script.player));
    check('which is RH_01, at its own origin',
          spawn.room === 'RH_01'
          && Math.abs(spawn.local[0]) < 1 && Math.abs(spawn.local[2]) < 1,
          JSON.stringify(spawn));
    check('and the body actually starts there',
          dressed.stage.current.name === 'RH_01'
          && Math.abs(dressed.stage.body.pos[0] - spawn.local[0]) < 1e-6,
          JSON.stringify(dressed.stage.body.pos));

    // rh01 places seven gimmicks; two of them ship as split meshes, so the
    // room group gains nine objects on top of its own geometry and doors.
    const rec = dressed.rooms.get('RH_01');
    const plain = await viewMod.create(THREE, disc, 0, { ps2: true }, () => {});
    const bare = plain.rooms.get(plain.stage.current.name).group.children.length;
    check('the dressed room has more in it than the bare one',
          rec.group.children.length > bare,
          rec.group.children.length + ' vs ' + bare);
    check('every placed gimmick resolved to a model',
          dressed.warnings.filter((w) => w.startsWith('no model for')).length === 0,
          dressed.warnings.join('; '));

    // A script paired with the wrong map would put everything in the wrong
    // rooms, so it is refused rather than half-applied.
    const wrong = await viewMod.create(THREE, disc, 1,
      { ps2: true, script: 'DATA/SCRIPT/B010EVENT.ARC' }, () => {});
    check('a script for another map is refused, not half-applied',
          wrong.script === null
          && wrong.warnings.some((w) => w.indexOf('wants map M000') >= 0),
          JSON.stringify(wrong.warnings));
  }

  console.log('the collision overlay');
  {
    runner.setCollisionVisible(true);
    check('it draws floors, walls and ceilings',
          runner.debugGroup && runner.debugGroup.children.length === 3,
          String(runner.debugGroup && runner.debugGroup.children.length));
    runner.setCollisionVisible(false);
    check('and clears when turned off', runner.debugGroup === null);
  }

  console.log('\n%s', failures ? failures + ' FAILED' : 'all checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
