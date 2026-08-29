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
  class Group {
    constructor() { this.children = []; }
    add(c) { this.children.push(c); }
  }
  return {
    BufferAttribute, BufferGeometry, Group,
    Mesh: class { constructor(g, m) { this.geometry = g; this.material = m; } },
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
