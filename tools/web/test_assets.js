/**
 * Diff the browser decoders against the Python ones, on real disc assets.
 *
 *   node tools/web/test_assets.js ["path/to/Trapt (USA).iso"]
 *
 * `arc.js` and `tm2.js` have to agree with `tools/arc.py` and `tools/tm2.py`
 * exactly -- same members, same pixels -- because the eventual page renders
 * what they produce and there is no second chance to notice a swapped palette
 * band or a half-transparent texture.  So this decodes a real spread of the
 * disc's textures on both sides and compares the RGBA byte for byte.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const iso = require('./iso.js');
const discMod = require('./disc.js');
const arc = require('./arc.js');
const tm2 = require('./tm2.js');
const smi = require('./smi.js');
const model_ = require('./model.js');
const saiMod = require('./sai.js');
const sscMod = require('./ssc.js');
const cam = require('./cam.js');
const sceneMod = require('./scene.js');
const play = require('./play.js');
const arcMod = arc;
const ssc = sscMod;

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
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 16);

function python(code) {
  return JSON.parse(execFileSync('python', ['-c', code],
                                 { cwd: TOOLS, maxBuffer: 1 << 28 }));
}

// Archives chosen to span the formats: a cutscene bundle, a room, a character
// and a 2D screen, so indexed-4, indexed-8 and direct pictures all appear.
const ARCHIVES = [
  'DATA/RT/E001/RT_E001.ARC',
  'DATA/ROOM/RP03_ALL.ARC',
  'DATA/RT/COSTUME/RT_C01F_A_HL.ARC',
  'DATA/RT/E429_04/RT_E429_04.ARC',
];

/** Just enough THREE for model.js: no WebGL, but the same object shapes. */
function stubThree() {
  class BufferAttribute {
    constructor(array, itemSize) { this.array = array; this.itemSize = itemSize; }
  }
  class BufferGeometry {
    constructor() { this.attributes = {}; this.index = null; this.computed = false; }
    setAttribute(n, a) { this.attributes[n] = a; }
    setIndex(a) { this.index = a; }
    computeVertexNormals() { this.computed = true; }
  }
  class Vec3 {
    constructor() { this.x = 0; this.y = 0; this.z = 0; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  }
  class Group {
    constructor() {
      this.children = []; this.visible = true; this.position = new Vec3();
    }
    add(c) { this.children.push(c); }
  }
  return {
    BufferAttribute, BufferGeometry, Group,
    Mesh: class {
      constructor(g, m) {
        this.geometry = g; this.material = m; this.visible = true;
      }
    },
    Color: class { constructor(r, g, b) { this.r = r; this.g = g; this.b = b; } },
    DataTexture: class {
      constructor(d, w, h, f) { this.image = { data: d, width: w, height: h }; }
    },
    MeshLambertMaterial: class { constructor(o) { Object.assign(this, o); } },
    RGBAFormat: 1023, RepeatWrapping: 1000, LinearFilter: 1006,
    DoubleSide: 2, AdditiveBlending: 2,
  };
}

async function main() {
  if (!fs.existsSync(ISO)) {
    console.log('disc image not found: %s', ISO);
    process.exit(2);
  }
  const source = iso.fdSource(fs, ISO);
  const disc = await discMod.open(source);

  console.log('RPS archives, against tools/arc.py');
  const pyArc = python(
    'import arc, json, scene; d = scene.Disc();'
    + ' names = ' + JSON.stringify(ARCHIVES) + ';'
    + ' print(json.dumps({n: [[e[0], e[1], e[2]] for e in arc.entries(d.read(n))]'
    + ' for n in names}))');

  const decoded = [];                   // [{archive, member, w, h, hash}]
  for (const name of ARCHIVES) {
    const blob = await disc.read(name);
    const ents = arc.entries(blob);
    check(name.split('/').pop() + ': member list matches',
          ents.map((e) => [e.name, e.offset, e.size]), pyArc[name]);

    for (const e of ents) {
      if (!e.name.toLowerCase().endsWith('.tm2')) continue;
      const pics = tm2.decode(blob.subarray(e.offset, e.offset + e.size));
      pics.forEach((p, i) => decoded.push({
        archive: name, member: e.name, index: i,
        w: p.width, h: p.height, hash: sha(p.rgba),
      }));
    }
  }
  console.log('  %d textures decoded from %d archives',
              decoded.length, ARCHIVES.length);

  console.log('TIM2 pixels, against tools/tm2.py');
  const want = python(
    'import arc, hashlib, json, scene, tm2; d = scene.Disc();'
    + ' out = [];'
    + ' names = ' + JSON.stringify(ARCHIVES) + ';'
    + '\nfor n in names:\n'
    + '    blob = d.read(n)\n'
    + '    for nm, off, sz in arc.entries(blob):\n'
    + '        if not nm.lower().endswith(".tm2"): continue\n'
    + '        for i, (w, h, px) in enumerate(tm2.decode(blob[off:off+sz])):\n'
    + '            out.append([n, nm, i, w, h,'
    + ' hashlib.sha256(px).hexdigest()[:16]])\n'
    + 'print(json.dumps(out))');

  check('same number of pictures', decoded.length, want.length);
  const bad = [];
  for (let i = 0; i < Math.min(decoded.length, want.length); i++) {
    const g = decoded[i], w = want[i];
    if (g.member !== w[1] || g.index !== w[2] || g.w !== w[3] || g.h !== w[4]
        || g.hash !== w[5])
      bad.push({ member: g.member, got: [g.w, g.h, g.hash], want: w.slice(3) });
  }
  check('every picture is byte-identical', bad.slice(0, 3), []);

  const sizes = [...new Set(decoded.map((d) => d.w + 'x' + d.h))];
  console.log('  sizes seen: %s', sizes.slice(0, 8).join(' '));

  // ------------------------------------------------------------ geometry
  // Models chosen for the cases that break silently: a skinned character with
  // a facial rig, a rigid-mesh room, a prop that rides a single node (the
  // hinged door), and a hand-held object.
  const MODELS = [
    ['DATA/RT/COSTUME/RT_C01F_A_HL.ARC', 'c01f_a_h.smi'],
    ['DATA/RT/E001/RT_E001.ARC', 'c12f_a_h.smi'],
    ['DATA/RT/E001/RT_E001.ARC', 'rp03d0.smi'],
    ['DATA/RT/E001/RT_E001.ARC', 'knife_a.smi'],
    ['DATA/ROOM/RP03_ALL.ARC', 'rp03.smi'],
  ];

  console.log('SMI models, against tools/smi.py');
  const pyModels = python(
    'import arc, hashlib, json, scene, smi; d = scene.Disc();'
    + ' want = ' + JSON.stringify(MODELS) + ';'
    + ' out = {}'
    + '\nfor apath, member in want:\n'
    + '    blob = d.read(apath)\n'
    + '    mem = {n.lower(): (o, s) for n, o, s in arc.entries(blob)}\n'
    + '    o, s = mem[member]\n'
    + '    m = smi.parse(blob[o:o+s])\n'
    + '    posed = smi.bind_pose(m)\n'
    + '    P = [round(c, 3) for pn in posed for p in pn[0] for c in p]\n'
    + '    N = [round(c, 3) for pn in posed for n in pn[1] for c in n]\n'
    + '    U = [round(c, 4) for me in m.meshes for uv in me.uv for c in uv]\n'
    + '    T = [i for me in m.meshes for t in me.tris for i in t]\n'
    + '    out[member] = {\n'
    + '        "nodes": len(m.nodes), "meshes": len(m.meshes),\n'
    + '        "materials": [[mt["name"], list(mt["diffuse"]), mt["blend"],\n'
    + '                       mt["atest"], mt["add"]] for mt in m.materials],\n'
    + '        "vcounts": [me.vcount for me in m.meshes],\n'
    + '        "influences": [me.influences for me in m.meshes],\n'
    + '        "bases": [me.base for me in m.meshes],\n'
    + '        "palettes": [me.palette for me in m.meshes],\n'
    + '        "tris": hashlib.sha256(json.dumps(T, separators=(",",":")).encode()).hexdigest()[:16],\n'
    + '        "ntris": len(T) // 3, "P": P, "N": N, "U": U}\n'
    + 'print(json.dumps(out))');

  for (const [apath, member] of MODELS) {
    const blob = await disc.read(apath);
    const mem = new Map(arc.entries(blob).map(
      (e) => [e.name.toLowerCase(), e]));
    const e = mem.get(member);
    const model = smi.parse(blob.subarray(e.offset, e.offset + e.size));
    const posed = smi.bindPose(model);
    const w = pyModels[member];

    check(member + ': nodes and meshes',
          [model.nodes.length, model.meshes.length], [w.nodes, w.meshes]);
    check(member + ': vertex counts', model.meshes.map((m) => m.vcount), w.vcounts);
    check(member + ': influences per mesh',
          model.meshes.map((m) => m.influences), w.influences);
    check(member + ': base node per mesh', model.meshes.map((m) => m.base), w.bases);
    check(member + ': bone palettes', model.meshes.map((m) => m.palette), w.palettes);
    check(member + ': materials',
          model.materials.map((m) => [m.name, m.diffuse, m.blend, m.atest, m.add]),
          w.materials);

    const T = [];
    for (const me of model.meshes) for (const t of me.tris) T.push(t[0], t[1], t[2]);
    check(member + ': ' + (T.length / 3) + ' triangles, same indices',
          [sha(Buffer.from(JSON.stringify(T))), T.length / 3],
          [w.tris, w.ntris]);

    // Positions and normals elementwise: these come out of the same double
    // arithmetic on both sides, so anything but a tiny rounding gap is a bug.
    const P = [], N = [], U = [];
    posed.forEach((pn, i) => {
      for (const c of pn.positions) P.push(c);
      if (pn.normals) for (const c of pn.normals) N.push(c);
      for (const uv of model.meshes[i].uv) U.push(uv[0], uv[1]);
    });
    const worst = (a, b) => {
      if (a.length !== b.length) return 'length ' + a.length + ' vs ' + b.length;
      let m = 0;
      for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
      return m;
    };
    const dp = worst(P, w.P), dn = worst(N, w.N), du = worst(U, w.U);
    check(member + ': ' + (P.length / 3) + ' skinned vertices match',
          [typeof dp === 'number' && dp < 1e-3,
           typeof dn === 'number' && dn < 1e-3,
           typeof du === 'number' && du < 1e-3], [true, true, true]);
    if (typeof dp === 'number')
      console.log('        worst delta: position %s, normal %s, uv %s',
                  dp.toExponential(1), dn.toExponential(1), du.toExponential(1));
    else
      console.log('        %s', dp);
  }

  // WebGL cannot run here, but the geometry handed to it can still be wrong
  // in ways that only show up as a blank canvas: an index past the end of the
  // position array, a UV array of the wrong length, a material that should be
  // alpha-tested and is not.  A stub THREE catches all of that.
  // ----------------------------------------------------------- animation
  // A clip only carries the channels it animates, so most of the risk is in
  // the fallbacks: a rotation-only clip takes translation and *scale* from the
  // bind matrix, and scale there means the length of each bind row, not 1.
  // Get that wrong and the rig stretches in a way that still looks plausible.
  //
  // Clips come from two places and both are exercised here: e001 streams 29
  // of them loose in the AFS next to its archive, and keeps three inside it.
  const CLIPS = [
    { arc: 'DATA/RT/COSTUME/RT_C01F_A_HL.ARC', model: 'c01f_a_h.smi',
      clip: 'DATA/RT/E001/C01F_A_E001_1.SAI', loose: true },
    { arc: 'DATA/RT/E001/RT_E001.ARC', model: 'c12f_a_h.smi',
      clip: 'DATA/RT/E001/C12F_A_E001_2.SAI', loose: true },
    { arc: 'DATA/RT/E001/RT_E001.ARC', model: 'rp03d0.smi',
      clip: 'rp03d0_e001.sai', loose: false },
  ];
  console.log('SAI clips and posed skinning, against tools/pose.py');
  const PY_POSE = [
    'import arc, json, scene, sai, smi, pose',
    'd = scene.Disc()',
    "want = json.loads(r'''" + JSON.stringify(CLIPS) + "''')",
    'out = {}',
    'for spec in want:',
    '    blob = d.read(spec["arc"])',
    '    mem = {n.lower(): (o, s) for n, o, s in arc.entries(blob)}',
    '    o, s = mem[spec["model"]]; m = smi.parse(blob[o:o+s])',
    '    if spec["loose"]:',
    '        c = sai.parse(d.read(spec["clip"]))',
    '    else:',
    '        o, s = mem[spec["clip"]]; c = sai.parse(blob[o:o+s])',
    '    frames = [0, 1, c.duration // 3, c.duration // 2, c.duration]',
    '    per = {}',
    '    for f in frames:',
    '        posed = pose.skin(m, pose.world_matrices(m, c, f))',
    '        per[str(f)] = [round(v, 3) for pn in posed for p in pn[0] for v in p]',
    '    out[spec["clip"]] = {"nodes": len(c.nodes), "duration": c.duration,',
    '                         "channels": sorted([n.name + ":" + "".join(',
    '                             str(k) for k in sorted(n.channels)) for n in c.nodes]),',
    '                         "frames": frames, "P": per}',
    'print(json.dumps(out))',
  ].join('\n');
  const pyPose = python(PY_POSE);

  for (const spec of CLIPS) {
    const blob = await disc.read(spec.arc);
    const mem = new Map(arc.entries(blob).map((e) => [e.name.toLowerCase(), e]));
    const em = mem.get(spec.model);
    const model = smi.parse(blob.subarray(em.offset, em.offset + em.size));
    let clipBytes;
    if (spec.loose) {
      clipBytes = await disc.read(spec.clip);
    } else {
      const ec = mem.get(spec.clip);
      clipBytes = blob.subarray(ec.offset, ec.offset + ec.size);
    }
    const clip = saiMod.parse(clipBytes);
    const w = pyPose[spec.clip];
    const label = spec.clip.split('/').pop();

    check(label + ': nodes and duration',
          [clip.nodes.length, clip.duration], [w.nodes, w.duration]);
    check(label + ': same channels on every node',
          clip.nodes.map((n) => n.name + ':'
            + Object.keys(n.channels).sort().join('')).sort(), w.channels);

    let worst = 0;
    for (const f of w.frames) {
      const posed = saiMod.skin(model, saiMod.worldMatrices(model, clip, f));
      const P = [];
      for (const pn of posed) for (const c of pn.positions) P.push(c);
      const want2 = w.P[String(f)];
      if (P.length !== want2.length) { worst = Infinity; break; }
      for (let i = 0; i < P.length; i++)
        worst = Math.max(worst, Math.abs(P[i] - want2[i]));
    }
    check(label + ': ' + spec.model + ' skinned identically at '
          + w.frames.length + ' frames', worst < 1e-3, true);
    console.log('        %d nodes, %d frames, worst delta %s',
                clip.nodes.length, clip.duration, worst.toExponential(1));

    // A posed frame has to actually differ from the bind pose, or the whole
    // comparison above could be passing on an animation that does nothing.
    const bind = smi.bindPose(model);
    const mid = saiMod.skin(model,
      saiMod.worldMatrices(model, clip, Math.max(1, clip.duration >> 1)));
    let moved = 0;
    for (let i = 0; i < bind.length; i++)
      for (let k = 0; k < bind[i].positions.length; k++)
        moved = Math.max(moved, Math.abs(bind[i].positions[k] - mid[i].positions[k]));
    check(label + ': the clip actually moves the rig', moved > 0.01, true);
  }

  // Interpolation is where a port diverges quietly: a slerp taking the long
  // way round, or a binary search off by one at a key boundary.
  {
    const idq = [0, 0, 0, 1];
    const m = saiMod.quatToMatrix([0.7071067811865476, 0, 0, 0.7071067811865476]);
    check('quatToMatrix round-trips through matrixToQuat',
          saiMod.matrixToQuat(m).map((v) => +v.toFixed(6)),
          [0.707107, 0, 0, 0.707107]);
    check('slerp endpoints are exact',
          [saiMod.slerp(idq, idq, 0.5), saiMod.slerp(idq, [0, 0, 0, -1], 0)],
          [[0, 0, 0, 1], [0, 0, 0, 1]]);
    const u = saiMod.slerp(idq,
      [0, 0.7071067811865476, 0, 0.7071067811865476], 0.5);
    check('slerp stays unit length',
          Math.abs(Math.hypot(u[0], u[1], u[2], u[3]) - 1) < 1e-9, true);
  }

  console.log('the three.js bridge, against a stub THREE');
  const THREE = stubThree();
  {
    const blob = await disc.read('DATA/RT/E001/RT_E001.ARC');
    const mem = new Map(arc.entries(blob).map((e) => [e.name.toLowerCase(), e]));
    const e = mem.get('c12f_a_h.smi');
    const model = smi.parse(blob.subarray(e.offset, e.offset + e.size));
    const posed = smi.bindPose(model);
    let textures = 0;
    const group = model_.build(THREE, model, posed, (name) => {
      const t = mem.get(name.toLowerCase());
      if (!t) return null;
      const pics = tm2.decode(blob.subarray(t.offset, t.offset + t.size));
      if (!pics.length) return null;
      textures++;
      return model_.makeTexture(THREE, pics[0]);
    });

    const drawn = model.meshes.filter((m) => m.tris.length).length;
    check('one three.js mesh per drawable SMI mesh', group.children.length, drawn);
    check('textures resolved out of the same archive', textures > 0, true);

    const problems = [];
    group.children.forEach((mesh, i) => {
      const me = model.meshes.filter((m) => m.tris.length)[i];
      const g = mesh.geometry;
      const pos = g.attributes.position, uv = g.attributes.uv;
      if (pos.array.length !== me.vcount * 3) problems.push('position length ' + i);
      if (uv && uv.array.length !== me.vcount * 2) problems.push('uv length ' + i);
      if (g.attributes.normal
          && g.attributes.normal.array.length !== me.vcount * 3)
        problems.push('normal length ' + i);
      if (!g.index) problems.push('no index ' + i);
      else {
        let max = -1;
        for (const v of g.index.array) if (v > max) max = v;
        if (max >= me.vcount) problems.push('index ' + max + ' >= ' + me.vcount);
        if (g.index.array.length !== me.tris.length * 3)
          problems.push('index count ' + i);
      }
    });
    check('every attribute and index is in range', problems.slice(0, 4), []);

    // The alpha-test rule is the one that deletes scenery when it is wrong.
    const wantTested = model.materials.filter((m) => m.atest).length;
    const gotTested = group.children.filter((m) => m.material.alphaTest > 0).length;
    check('alpha test only where the render word asks for it',
          [wantTested > 0, gotTested > 0, group.children.every(
            (m) => m.material.alphaTest === 0
                || Math.abs(m.material.alphaTest - 120 / 255) < 1e-6)],
          [true, true, true]);

    const b = model_.bounds(posed);
    check('bounds are finite and non-degenerate',
          [isFinite(b.radius), b.radius > 0, b.center.every(isFinite)],
          [true, true, true]);
    console.log('        %d meshes, radius %s, centre %s',
                group.children.length, b.radius.toFixed(1),
                b.center.map((c) => c.toFixed(1)).join(', '));
  }

  // ------------------------------------------------------- script and camera
  console.log('SSC bytecode, against tools/ssc.py');
  {
    const blob = await disc.read('DATA/RT/E001/RT_E001.ARC');
    const mem = new Map(arc.entries(blob).map((e) => [e.name.toLowerCase(), e]));
    const tracks = [...mem.keys()].filter((n) => n.endsWith('.ssc')).sort();
    const PY_SSC = [
      'import arc, json, scene, ssc',
      'd = scene.Disc()',
      'blob = d.read("DATA/RT/E001/RT_E001.ARC")',
      'mem = {n.lower(): (o, s) for n, o, s in arc.entries(blob)}',
      'out = {}',
      'for name in sorted(k for k in mem if k.endswith(".ssc")):',
      '    o, s = mem[name]',
      '    calls = []',
      '    for off, op, args in ssc.parse(blob[o:o+s]):',
      '        if op is None:',
      '            calls.append([off, None, None, args])',
      '            continue',
      '        a = []',
      '        for x in args:',
      '            if isinstance(x, bytes): a.append(ssc.sj(x))',
      '            elif isinstance(x, tuple) and x[0] == "c2": a.append([x[1], x[2]])',
      '            elif isinstance(x, tuple) and x[0] == "c4": a.append(["c4", x[1]])',
      '            else: a.append(x)',
      '        calls.append([off, op[0], op[1], a])',
      '    out[name] = calls',
      'print(json.dumps(out))',
    ].join('\n');
    const pySsc = python(PY_SSC);

    let mismatch = null, totalCalls = 0;
    for (const name of tracks) {
      const e = mem.get(name);
      const calls = ssc.parse(blob.subarray(e.offset, e.offset + e.size));
      const want = pySsc[name];
      totalCalls += calls.length;
      if (calls.length !== want.length) {
        mismatch = name + ': ' + calls.length + ' calls vs ' + want.length;
        break;
      }
      for (let i = 0; i < calls.length && !mismatch; i++) {
        const g = calls[i], w = want[i];
        const ga = g.args.map((x) => (x && typeof x === 'object'
          ? ('den' in x ? [x.num, x.den] : ['c4', x.c4]) : x));
        if (g.offset !== w[0] || g.op !== w[1]
            || (g.op !== null && g.flag !== w[2])
            || JSON.stringify(ga) !== JSON.stringify(w[3]))
          mismatch = name + ' call ' + i + ': ' + JSON.stringify([g.offset, g.op, ga])
                   + ' vs ' + JSON.stringify(w);
      }
      if (mismatch) break;
    }
    check(tracks.length + ' tracks, ' + totalCalls + ' calls, identical to ssc.py',
          mismatch, null);
  }

  console.log('CAM tracks, against tools/cam.py');
  {
    const blob = await disc.read('DATA/RT/E001/RT_E001.ARC');
    const mem = new Map(arc.entries(blob).map((e) => [e.name.toLowerCase(), e]));
    const e = mem.get('e001.cam');
    const track = cam.parse(blob.subarray(e.offset, e.offset + e.size));
    const PY_CAM = [
      'import arc, cam, json, scene',
      'd = scene.Disc()',
      'blob = d.read("DATA/RT/E001/RT_E001.ARC")',
      'mem = {n.lower(): (o, s) for n, o, s in arc.entries(blob)}',
      'o, s = mem["e001.cam"]',
      't = cam.parse(blob[o:o+s])',
      'frames = [1, 100.5, 4670, 7800, 7910, t.duration()]',
      'print(json.dumps({',
      '  "duration": t.duration(),',
      '  "widths": [None if c is None else c.width for c in t.channels],',
      '  "keys": [0 if c is None else len(c.times) for c in t.channels],',
      '  "samples": [[round(v, 4) if not isinstance(v, tuple)',
      '               else [round(x, 4) for x in v]',
      '               for k, v in sorted(t.sample(f).items())] for f in frames],',
      '  "frames": frames}))',
    ].join('\n');
    const w = python(PY_CAM);
    check('duration and channel widths',
          [track.duration(), track.channels.map((c) => (c ? c.width : null)),
           track.channels.map((c) => (c ? c.times.length : 0))],
          [w.duration, w.widths, w.keys]);
    let worst = 0;
    w.frames.forEach((f, i) => {
      const s = track.sample(f);
      const got = Object.keys(s).sort().map((k) => s[k]);
      const want = w.samples[i];
      for (let j = 0; j < want.length; j++) {
        const a = got[j], b = want[j];
        if (Array.isArray(b))
          for (let c = 0; c < b.length; c++) worst = Math.max(worst, Math.abs(a[c] - b[c]));
        else worst = Math.max(worst, Math.abs(a - b));
      }
    });
    check('sampled identically at ' + w.frames.length + ' frames', worst < 1e-3, true);
    console.log('        %s frames, worst delta %s',
                track.duration(), worst.toExponential(1));
  }

  // ------------------------------------------------------------- the timeline
  // The interpreter is where a cutscene stops being a bag of files: which
  // actor wears which model, plays which clip when, in which room, under which
  // camera.  Every field here is one the player reads directly.
  console.log('the scene timeline, against tools/scene.py');
  for (const cutscene of ['e001', 'e009', 'e401_01']) {
    const up = cutscene.toUpperCase();
    const blob = await disc.read('DATA/RT/' + up + '/RT_' + up + '.ARC');
    const assets = arcMod.members(blob);
    const built = sceneMod.compile(cutscene, assets);

    const PY_SCENE = [
      'import json, scene',
      'd = scene.Disc()',
      's = scene.load("' + cutscene + '", d)',
      'print(json.dumps({',
      '  "room": s.room, "duration": s.duration, "camera": s.camera_file,',
      '  "fog": list(s.fog) if s.fog else None,',
      '  "bgm": [[f, k, i] for f, k, i in s.bgm],',
      '  "fades": [[f, k, n] for f, k, n in s.fades],',
      '  "letterbox": [[f, k, n] for f, k, n in s.letterbox],',
      '  "subtitles": [[x.frame, x.speaker, x.lines, x.voice] for x in s.subtitles],',
      '  "entities": [{"track": e.track, "kind": e.kind, "label": e.label,',
      '                "models": e.models, "render": e.render_models,',
      '                "clips": [[f, n] for f, n in e.clips],',
      '                "start": e.start, "end": e.end,',
      '                "root_bone": e.root_bone, "light": e.light,',
      '                "transform": list(e.transform) if e.transform else None,',
      '                "scale": list(e.scale) if e.scale else None,',
      '                "vis": [[f, bool(v)] for f, v in e.visibility]}',
      '               for e in s.entities]}))',
    ].join('\n');
    const w = python(PY_SCENE);

    check(cutscene + ': room, duration and camera',
          [built.room, built.duration, built.cameraFile],
          [w.room, w.duration, w.camera]);
    check(cutscene + ': bgm, fades and letterbox',
          [built.bgm, built.fades, built.letterbox], [w.bgm, w.fades, w.letterbox]);
    check(cutscene + ': ' + built.subtitles.length + ' subtitle cues',
          built.subtitles.map((s) => [s.frame, s.speaker, s.lines, s.voice]),
          w.subtitles);
    check(cutscene + ': ' + built.entities.length + ' entities',
          built.entities.length, w.entities.length);

    const diffs = [];
    built.entities.forEach((e, i) => {
      const x = w.entities[i];
      if (!x) { diffs.push('missing ' + i); return; }
      const mine = {
        track: e.track, kind: e.kind, label: e.label, models: e.models,
        render: sceneMod.renderModels(e), clips: e.clips, start: e.start,
        end: e.end, root_bone: e.rootBone, light: e.light,
        transform: e.transform, scale: e.scale, vis: e.visibility,
      };
      if (JSON.stringify(mine) !== JSON.stringify(x))
        diffs.push({ i: i, got: mine, want: x });
    });
    check(cutscene + ': every entity identical', diffs.slice(0, 1), []);
    console.log('        room %s, %d frames, %d entities, %d cues, camera %s',
                built.room, built.duration, built.entities.length,
                built.subtitles.length, built.cameraFile);
  }

  // --------------------------------------------------------- the whole scene
  // Assembling a cutscene is where every port meets: the script names actors,
  // the actors name rigs and clips, the rigs name textures, and the room and
  // camera come from somewhere else again.  A stub THREE is enough to check
  // that all of it resolves and that posing at a frame actually moves things.
  console.log('a whole cutscene assembled, against tools/scene.py');
  for (const cutscene of ['e001', 'e009']) {
    const built = await play.assemble(THREE, disc, cutscene);
    const s = built.scene;

    check(cutscene + ': assembled with no missing assets', built.warnings, []);
    check(cutscene + ': has a camera track and a room',
          [!!built.camera, !!built.room], [true, true]);

    // every actor the timeline draws got geometry
    const drawn = s.entities.filter(
      (e) => e.kind === 4 && sceneMod.renderModels(e).length);
    check(cutscene + ': ' + built.actors.length + ' actors built',
          built.actors.length,
          drawn.reduce((n, e) => n + sceneMod.renderModels(e).length, 0));

    // and every clip the timeline names resolved to a parsable SAI
    let clips = 0, unresolved = [];
    for (const actor of built.actors)
      for (const [, file] of actor.entity.clips) {
        clips++;
        if (!built.clipFor(actor, file)) unresolved.push(file);
      }
    check(cutscene + ': ' + clips + ' clip references all resolve',
          [...new Set(unresolved)].slice(0, 3), []);

    // The camera track ends a few frames before the scene does -- the last
    // events are the letterbox closing -- and sampling past the end clamps.
    const camDur = built.camera.duration();
    check(cutscene + ': camera spans the scene and clamps past its end',
          [camDur > s.duration * 0.9, camDur <= s.duration,
           built.camera.sample(s.duration + 500).position.every(isFinite)],
          [true, true, true]);

    // posing has to actually differ frame to frame, and the camera with it
    const frames = [1, Math.round(s.duration / 3), Math.round(s.duration / 2),
                    s.duration - 1];
    const eyes = [], moved = [];
    for (const f of frames) {
      const before = built.actors.map(
        (a) => a.group.children.map((c) => c.geometry.attributes.position.array[1]));
      const r = play.poseAt(built, f);
      eyes.push(r.camera.position.map((v) => Math.round(v * 100) / 100));
      const after = built.actors.map(
        (a) => a.group.children.map((c) => c.geometry.attributes.position.array[1]));
      moved.push(JSON.stringify(before) !== JSON.stringify(after));
    }
    check(cutscene + ': the camera moves across the scene',
          new Set(eyes.map(JSON.stringify)).size > 1, true);
    check(cutscene + ': posing changes the geometry', moved.slice(1).some(Boolean),
          true);

    // the overlay state the page draws
    const mid = play.poseAt(built, s.subtitles.length ? s.subtitles[0].frame : 1);
    check(cutscene + ': the first cue is on screen at its own frame',
          s.subtitles.length ? mid.subtitle === s.subtitles[0] : true, true);
    // `0x57 (0, 1)` on frame 1 starts the tween there, so it reads 0 at the
    // event's own frame and is fully seated one frame later.
    check(cutscene + ': the letterbox slides in over frame 1',
          [play.poseAt(built, 1).letterbox, play.poseAt(built, 3).letterbox],
          [0, 1]);

    console.log('        %d actors, %d clips, room %s, camera %s frames, '
                + '%d cues, %d entities',
                built.actors.length, clips, s.room, camDur,
                s.subtitles.length, s.entities.length);
  }

  console.log('the decoders refuse what they should');
  let e1 = '', e2 = '', e3 = '';
  try { arc.entries(new Uint8Array(64)); } catch (e) { e1 = e.message; }
  try { tm2.decode(new Uint8Array(64)); } catch (e) { e2 = e.message; }
  try { smi.parse(new Uint8Array(64)); } catch (e) { e3 = e.message; }
  check('arc rejects non-RPS', e1.startsWith('not an RPS archive'), true);
  check('tm2 rejects non-TIM2', e2.startsWith('not a TIM2'), true);
  check('smi rejects non-SMI', e3.startsWith('not an SMI'), true);

  source.close();
  console.log(failures ? '\n%d FAILED' : '\nall checks passed', failures);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
