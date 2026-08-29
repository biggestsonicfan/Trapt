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
const { stubThree } = require('./stub_three.js');
const fontMod = require('./font.js');
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

const FONT_CUES = {"reference": "%%SCSVＣａｔａｌｉｎａ%%RC\\nＷｅｌｌ．．．．．．\\nｙｏｕ　ｄｏｎ’ｔ　ｒｅｃｏｇｎｉｚｅ　ｍｅ　ａｓ　ｙｏｕｒ　ｍｏｔｈｅｒ？", "plain": "Ｍｏｔｈｅｒ．．．．．．", "restore": "%%SCRDＲｅｄ%%RCＢａｃｋ", "unknown_code": "%%SCZZＦａｌｌｓ%%RCＢａｃｋ", "ends_early": "Ｙｅｓ\\0ＨＩＤＤＥＮ"};

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

  // TIM2's `format` byte moves the first picture header: 0 puts it after the
  // 16-byte file header, anything else aligns it to 128.  Reading 0x10
  // unconditionally made 129 of the disc's 7668 textures decode to a 0x0
  // picture and vanish -- among them `spark.tm2`, the effect e004 draws on
  // Allura's hand, and `rh01_21.tm2`, a wall in the House's first room.
  console.log('format-1 TIM2, which used to decode to nothing');
  {
    const fx = await disc.read('DATA/EFFECT/EF_COMMON.ARC');
    const members = arcMod.members(fx);
    for (const name of ['spark.tm2', 'ef_g004a.tm2']) {
      const blob = members.get(name);
      check(name + ' is format 1', blob[5], 1);
      const pics = tm2.decode(blob);
      check(name + ' decodes to one picture', pics.length, 1);
      const w = python(
        'import arc, hashlib, json, scene, tm2; d = scene.Disc();'
        + ' m = {n.lower(): (o, s) for n, o, s in'
        + ' arc.entries(d.read("DATA/EFFECT/EF_COMMON.ARC"))};'
        + ' o, s = m["' + name + '"];'
        + ' w, h, px = tm2.decode(d.read("DATA/EFFECT/EF_COMMON.ARC")[o:o+s])[0];'
        + ' print(json.dumps([w, h, hashlib.sha256(px).hexdigest()[:16]]))');
      check(name + ' is ' + w[0] + 'x' + w[1] + ' and byte-identical',
            [pics[0].width, pics[0].height, sha(pics[0].rgba)], w);
    }
  }

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
    // The GS material does the test in the shader, so it lives in a uniform
    // rather than three's own alphaTest.
    const wantTested = model.materials.filter((m) => m.atest).length;
    const gotTested = group.children.filter(
      (m) => m.material.uniforms.aTest.value === 1).length;
    check('alpha test only where the render word asks for it',
          [wantTested > 0, gotTested > 0, group.children.every(
            (m) => Math.abs(m.material.uniforms.alphaRef.value - 120 / 128) < 1e-9)],
          [true, true, true]);
    check('every mesh opts out of frustum culling',
          group.children.every((m) => m.frustumCulled === false), true);
    check('rooms take vertex colours, characters take normals',
          group.children.every((m) => !!m.geometry.attributes.vcol
            && (m.material.uniforms.lit.value === 1)
               === !!m.geometry.attributes.normal), true);

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
  // e004 leans on sprite effects harder than anything but e132 and is the
  // only cutscene that binds them to bones, so it is the one that would
  // notice the two sides drifting.
  console.log('the scene timeline, against tools/scene.py');
  for (const cutscene of ['e001', 'e009', 'e401_01', 'e004']) {
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
      '                "clips": [[f, n, o] for f, n, o in e.clips],',
      '                "start": e.start, "end": e.end,',
      '                "root_bone": e.root_bone, "light": e.light,',
      '                "transform": list(e.transform) if e.transform else None,',
      '                "scale": list(e.scale) if e.scale else None,',
      '                "vis": [[f, bool(v)] for f, v in e.visibility],',
      '                "sprite": (None if not e.sprite else',
      '                           {"texture": e.sprite["texture"],',
      '                            "cell": list(e.sprite["cell"]),',
      '                            "sheet": list(e.sprite["sheet"])}),',
      '                "size_keys": [list(k) for k in e.size_keys],',
      '                "colour_keys": [list(k) for k in e.colour_keys],',
      '                "binds": [list(b) for b in e.binds],',
      '                "emitter": e.emitter, "track_len": e.track_len}',
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
        sprite: e.sprite, size_keys: e.sizeKeys, colour_keys: e.colourKeys,
        binds: e.binds, emitter: e.emitter, track_len: e.trackLen,
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
  // Sprite effects, end to end.  Before these existed, 59 of the disc's 78
  // effect blocks compiled to an entity with nothing to draw, because a
  // sprite names a texture with 0x68 where a model names an .smi with 0x82.
  console.log('sprite effects, in e004');
  {
    const THREE = stubThree();
    const built = await play.assemble(THREE, disc, 'e004', () => {});
    check('assembles with no warnings', built.warnings, []);
    check('17 billboards -- one per emitter point', built.sprites.length, 17);
    const bound = built.sprites.filter((s) => s.bind);
    check('14 of them are bound to a bone', bound.length, 14);
    check('and every bind resolved to an actor and a real bone',
          bound.filter((s) => !s.actor || s.boneIndex < 0).length, 0);
    check('the bones are the right arm, finger to shoulder',
          [...new Set(bound.map((s) => s.bind[1]))].sort(),
          ['hiji_R', 'te_R', 'ude_R', 'yubi_2_1_R']);
    check('spark.tm2 decoded -- it is a format-1 TIM2',
          !!built.textures.get('spark.tm2'), true);

    // The visible shape of the effect, frame by frame.  ef_e004_11 and _12
    // spark on her arm from 1172; _30 and _31 flash from 1420.
    const lit = (f) => {
      play.poseAt(built, f);
      const on = built.sprites.filter((s) => s.mesh.visible);
      const by = {};
      for (const s of on) {
        const t = s.entity.sprite.texture;
        by[t] = (by[t] || 0) + 1;
      }
      return by;
    };
    check('nothing before the first spawn', lit(1150), {});
    check('sparks once it starts', lit(1175), { 'spark.tm2': 7 });
    check('both spawns overlap', lit(1190), { 'spark.tm2': 14 });
    check('the flash joins them', lit(1500),
          { 'ef_s014c.tm2': 3, 'spark.tm2': 8 });
    check('and everything is gone by the end', lit(1700), {});

    play.poseAt(built, 1500);
    const flash = built.sprites.find(
      (s) => s.mesh.visible && s.entity.sprite.texture === 'ef_s014c.tm2');
    const spark = built.sprites.find(
      (s) => s.mesh.visible && s.entity.sprite.texture === 'spark.tm2');
    // The keyframes: 0x6D grows the flash 0.5 -> 4.5, 0x6E fades its alpha
    // 0 -> 1.8 -> 0 while holding an orange (1.5, 0.2, 0.1).
    check('the flash is keyframed, and mid-swell at 1500',
          [+flash.mesh.scale.x.toFixed(2), +flash.mesh.material.opacity.toFixed(2),
           +flash.mesh.material.color.r.toFixed(2)],
          [3.08, 1, 1.5]);
    // A spark has no keys at all -- it takes its colour from 0x80 and its
    // lifetime from the length of its own track.
    check('a spark takes its colour from 0x80',
          [+spark.mesh.material.color.r.toFixed(2),
           +spark.mesh.material.color.g.toFixed(2),
           +spark.mesh.material.color.b.toFixed(2)], [0.9, 0.3, 0.1]);
    // `0x68`'s four numbers are a cell on a sheet, and a sheet is often a
    // flipbook.  Drawing the sheet put all sixteen rows of e001's explosion
    // on screen as one quad -- a red rectangle over a third of the frame.
    const rect = (s) => {
      const uv = s.mesh.geometry.attributes.uv.array;
      const us = [uv[0], uv[2], uv[4], uv[6]], vs = [uv[1], uv[3], uv[5], uv[7]];
      return [+Math.min(...us).toFixed(3), +Math.max(...us).toFixed(3),
              +Math.min(...vs).toFixed(3), +Math.max(...vs).toFixed(3),
              +s.mesh.geometry.width.toFixed(3),
              +s.mesh.geometry.height.toFixed(3)];
    };
    check('a single-cell sheet takes the whole texture, square',
          rect(built.sprites.find(
            (s) => s.entity.sprite.texture === 'ef_s014c.tm2')),
          [0, 1, 0, 1, 1, 1]);
    check("and spark.tm2's 128x64 cell makes a 2:1 quad",
          rect(built.sprites.find(
            (s) => s.entity.sprite.texture === 'spark.tm2')),
          [0, 1, 0, 1, 1, 0.5]);
    check('every live billboard is aimed at the camera',
          built.sprites.filter((s) => s.mesh.visible && !s.mesh.lookingAt).length, 0);
    check('a spark rides the bone rather than sitting at the origin',
          (() => {
            play.poseAt(built, 1190);
            const a = spark.mesh.position.z;
            play.poseAt(built, 1200);
            return Math.abs(spark.mesh.position.z - a) > 1;
          })(), true);
  }

  // e001 is the case that was reported: sixteen rows of four 64x16 explosion
  // frames on one 256x256 page, drawn as a single quad.
  console.log('a flipbook sheet takes one cell, not the page');
  {
    const THREE = stubThree();
    const built = await play.assemble(THREE, disc, 'e001', () => {});
    const s = built.sprites.find(
      (x) => x.entity.sprite.texture === 'ef_p_s_01.tm2');
    check('e001 has the explosion sheet', !!s, true);
    check('its cell is 64x16 on a 256x256 page',
          [s.entity.sprite.cell, s.entity.sprite.sheet],
          [[64, 16], [256, 256]]);
    const uv = s.mesh.geometry.attributes.uv.array;
    const us = [uv[0], uv[2], uv[4], uv[6]], vs = [uv[1], uv[3], uv[5], uv[7]];
    check('so it takes a quarter of the width',
          [+Math.min(...us).toFixed(3), +Math.max(...us).toFixed(3)], [0, 0.25]);
    check('and a sixteenth of the height, from the top',
          [+Math.min(...vs).toFixed(3), +Math.max(...vs).toFixed(3)],
          [0.938, 1]);
    check('the quad is 4:1, not square',
          [+s.mesh.geometry.width.toFixed(3),
           +s.mesh.geometry.height.toFixed(3)], [1, 0.25]);
    // Its track carries no `at_time` after the block, so its length is 0 --
    // which means "the script never says it stops", not "one frame".
    check('a zero-length track is not a one-frame sprite',
          s.entity.trackLen, 0);
    play.poseAt(built, s.entity.start + 200);
    check('so it is still on screen 200 frames later', s.mesh.visible, true);
  }

  console.log('a whole cutscene assembled, against tools/scene.py');
  for (const cutscene of ['e001', 'e009']) {
    const built = await play.assemble(THREE, disc, cutscene);
    const s = built.scene;

    check(cutscene + ': assembled with no missing assets', built.warnings, []);
    check(cutscene + ': has a camera track and a room',
          [!!built.camera, !!built.room], [true, true]);

    // Effect tracks (0x08/0x07).  These were dropped entirely until the stab
    // in e001 turned out to have no blood: ef_e001_30 and _31 are spawned at
    // world points just after Olaf's cry at 7830, and neither existed.
    if (cutscene === 'e001') {
      check('e001: six effect tracks spawned', s.effects.length, 6);
      const stab = s.effects.filter((f) => f.frame > 8000);
      check('e001: two of them land after the stab',
            stab.map((f) => f.track), ['ef_e001_30', 'ef_e001_31']);
      check('e001: at the frames the script names',
            stab.map((f) => f.frame), [8270, 8431]);
      // The king's corpse.  0x67 drops the living block at 8430 and a new one
      // attaches c21m_b_h.smi, whose clip runs the full 11890 frames in
      // absolute scene time: outside its own window it parks koshi at
      // y = -18.9, under the floor.  Played from clip frame 0 the body spends
      // the whole scene beneath the stage while the knife, whose block starts
      // at frame 0, looks correct.  The 8431 in 0x83's fourth argument is what
      // says otherwise, and it is the only integer in that slot on the disc.
      const corpse = s.entities.find(
        (e) => e.models.indexOf('c21m_b_h.smi') >= 0);
      check('e001: the corpse block exists', !!corpse, true);
      check('e001: and starts at the frame 0x67 dropped the living king',
            corpse.start, 8430);
      check('e001: its clip carries the absolute-time offset',
            corpse.clips.map((c) => c[2]), [8431]);
      const at = sceneMod.clipAt(corpse, 8500);
      check('e001: so frame 8500 samples clip frame 8501, not 70',
            8500 - at.start + at.offset, 8501);
      // Every other clip on the disc has a rational there, which is a blend.
      const others = s.entities.reduce(
        (n, e) => n + e.clips.filter((c) => c[2]).length, 0);
      check('e001: and nothing else claims an offset', others, 1);

      const placed = s.entities.filter((e) => e.origin);
      check('e001: every effect block carries its spawn origin',
            placed.length, 6);
      const ef = placed.find((e) => e.models.indexOf('ef_e001_01.smi') >= 0);
      check('e001: the effect model is instantiated', !!ef, true);
      // The fourth 0x7E field reaches 1.5 across the disc, so it is not alpha
      // and must never be treated as one -- that would hide the sprite.
      check('e001: and tinted, with only the colour taken',
            ef && ef.tint ? ef.tint.length : 0, 4);
    }

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

  // ---------------------------------------------------------------- the font
  // The face is in the ELF, not on the disc, and font.py's layout has already
  // been fitted against a PCSX2 capture -- so agreeing with font.py is the
  // whole test.  A glyph placed half a pixel out, or a colour code that sets
  // where it should restore, is invisible until you diff it.
  console.log('the subtitle font, against tools/font.py');
  {
    const font = new fontMod.Font(disc.elf);
    check('cell and box from the ELF descriptor',
          [font.cell, font.box], [[16, 16], [24, 24]]);
    check('the CLUT is 16 entries', font.clut.length, 16);
    check('a shift_jis decoder was available for the reverse map',
          font.encoder !== null && font.encoder.size > 1000, true);

    const PY_FONT = [
      'import font, json',
      'f = font.Font()',
      'cues = json.loads(r' + "'''" + JSON.stringify(FONT_CUES) + "'''" + ')',
      'out = {"cell": list(f.cell), "box": list(f.box),',
      '       "clut": [list(c) for c in f.clut],',
      '       "widths": {str(k): v for k, v in sorted(f.widths.items())},',
      '       "runs": {}}',
      'for name, text in cues.items():',
      '    out["runs"][name] = [[c, round(x, 4), round(y, 4),',
      '                          [round(v, 6) for v in col]]',
      '                         for c, x, y, col in f.runs(text)]',
      'print(json.dumps(out))',
    ].join('\n');
    const w = python(PY_FONT);

    check('every advance in the width table matches',
          [...font.widths.entries()].every(([k, v]) => w.widths[String(k)] === v)
          && font.widths.size === Object.keys(w.widths).length, true);
    check('the CLUT matches byte for byte',
          font.clut.map((c) => c.join()).join('|'),
          w.clut.map((c) => c.join()).join('|'));

    let worstPos = 0, runsBad = [];
    for (const name of Object.keys(FONT_CUES)) {
      const got = font.runs(FONT_CUES[name]);
      const want = w.runs[name];
      if (got.length !== want.length) {
        runsBad.push(name + ': ' + got.length + ' glyphs vs ' + want.length);
        continue;
      }
      for (let i = 0; i < got.length; i++) {
        if (got[i].sjis !== want[i][0]) {
          runsBad.push(name + ' glyph ' + i + ': sjis '
                       + got[i].sjis.toString(16) + ' vs ' + want[i][0].toString(16));
          break;
        }
        worstPos = Math.max(worstPos, Math.abs(got[i].x - want[i][1]),
                            Math.abs(got[i].y - want[i][2]));
        const c = got[i].colour, cw2 = want[i][3];
        if (Math.abs(c[0] - cw2[0]) > 1e-6 || Math.abs(c[1] - cw2[1]) > 1e-6
            || Math.abs(c[2] - cw2[2]) > 1e-6) {
          runsBad.push(name + ' glyph ' + i + ': colour ' + c + ' vs ' + cw2);
          break;
        }
      }
    }
    check('every glyph of every cue lands in the same place', runsBad.slice(0, 2), []);
    console.log('        worst placement delta %s UI units', worstPos.toExponential(1));

    // And the pixels: font.py's rasteriser is the one measured against
    // hardware, so this renders the reference cue on both sides and diffs.
    const REF = FONT_CUES.reference;
    const PY_PIX = [
      'import font, json',
      'f = font.Font()',
      'buf = font.frame(f, r' + "'''" + REF + "'''" + ')',
      'w, h = font.NATIVE_W, font.NATIVE_H',
      'lit = [i for i in range(0, len(buf), 3) if buf[i] or buf[i+1] or buf[i+2]]',
      'print(json.dumps({"w": w, "h": h, "lit": len(lit),',
      '  "sum": round(sum(buf), 2),',
      '  "px": [[i // 3 % w, i // 3 // w, round(buf[i], 3), round(buf[i+1], 3),',
      '          round(buf[i+2], 3)] for i in lit[::97]]}))',
    ].join('\n');
    const px = python(PY_PIX);
    const ov = fontMod.overlay(font, REF);
    check('the overlay is the native framebuffer size',
          [ov.width, ov.height], [px.w, px.h]);

    let worstPix = 0, checked = 0;
    for (const [x, y, r, g, b] of px.px) {
      const o = (y * ov.width + x) * 4;
      worstPix = Math.max(worstPix, Math.abs(ov.rgba[o] - Math.round(r)),
                          Math.abs(ov.rgba[o + 1] - Math.round(g)),
                          Math.abs(ov.rgba[o + 2] - Math.round(b)));
      checked++;
    }
    check(checked + ' sampled pixels within one level of font.py',
          worstPix <= 1, true);
    console.log('        %d lit pixels in the reference cue, worst delta %d',
                px.lit, worstPix);

    // The overlay has to be transparent where there is no text, or it would
    // paint a black box over the scene.
    let opaque = 0;
    for (let i = 3; i < ov.rgba.length; i += 4) if (ov.rgba[i] > 0) opaque++;
    check('it is transparent away from the glyphs',
          opaque > 0 && opaque < ov.width * ov.height * 0.25, true);

    // The speaker name is drawn grey and the body near-white; that split is
    // the one thing a reader notices immediately if the markup is mishandled.
    const runs = font.runs(FONT_CUES.reference);
    const greys = runs.filter((g) => Math.abs(g.colour[0] - 0.5) < 0.01).length;
    const bodies = runs.filter((g) => g.colour[0] > 0.7).length;
    check('the speaker is grey and the body is not',
          [greys > 0, bodies > 0], [true, true]);
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
