/**
 * Headless check of the player's maths against the Python renderer.
 *
 *   node test_player.js <bundle-dir> <frame> [out.json]
 *
 * Extracts the TRAPT MATH block verbatim out of `player.html` -- so this
 * exercises the code the page actually ships -- loads the exported `scene.js`,
 * poses every entity at `frame`, and writes the bone matrices and skinned
 * vertex positions.  `tools/verify.py` then diffs them against `pose.py`.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const bundle = process.argv[2];
const frame = parseFloat(process.argv[3]);
const outPath = process.argv[4] || null;

const html = fs.readFileSync(path.join(__dirname, 'player.html'), 'utf8');
const start = html.indexOf('// ===8<=== TRAPT MATH ===8<===');
const end = html.indexOf('// ===8<=== END TRAPT MATH ===8<===');
if (start < 0 || end < 0) throw new Error('TRAPT MATH markers not found in player.html');
const mathSrc = html.slice(start, end);

const sandbox = { window: {}, console, Math, atob: (b) => Buffer.from(b, 'base64') };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(mathSrc, sandbox, { filename: 'player.html:TRAPT_MATH' });
vm.runInContext(fs.readFileSync(path.join(bundle, 'scene.js'), 'utf8'), sandbox,
                { filename: 'scene.js' });

const S = sandbox.window.TRAPT_SCENE;
const raw = Buffer.from(sandbox.window.TRAPT_BIN, 'base64');
const BIN = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
const M = sandbox.TraptMath(BIN, S);

// The one piece node cannot execute is the vertex shader, so prove its
// convention algebraically instead: GLSL builds `mat4(a,b,c,d)` from COLUMNS,
// we hand it our matrix's ROWS, so G == M-transpose and `G * v` is exactly the
// row-vector product `v * M` that skinMesh() computes on the CPU.
(function assertShaderConvention() {
  const M4 = new Float32Array([ 0.3,-0.9, 0.2, 0,
                                0.8, 0.1,-0.5, 0,
                               -0.4, 0.6, 0.7, 0,
                                5.0, 6.0, 7.0, 1]);
  const v = [1.3, -2.1, 0.7, 0.55];
  // CPU: v * M  (row-vector)
  const cpu = [0, 1, 2].map((r) =>
    v[0]*M4[r] + v[1]*M4[4+r] + v[2]*M4[8+r] + v[3]*M4[12+r]);
  // GPU: mat4(row0,row1,row2,row3) * v, columns taken from our rows
  const G = [[M4[0],M4[1],M4[2],M4[3]], [M4[4],M4[5],M4[6],M4[7]],
             [M4[8],M4[9],M4[10],M4[11]], [M4[12],M4[13],M4[14],M4[15]]];
  const gpu = [0, 1, 2].map((r) =>
    G[0][r]*v[0] + G[1][r]*v[1] + G[2][r]*v[2] + G[3][r]*v[3]);
  for (let i = 0; i < 3; i++)
    if (Math.abs(cpu[i] - gpu[i]) > 1e-6)
      throw new Error('shader matrix convention mismatch: ' + cpu + ' vs ' + gpu);
  console.error('shader convention check: mat4(rows) * v === v * M  ok');
})();

// The subtitle layout is the other piece with a hardware ground truth, so pull
// it out of the page the same way and run every cue through it.  `verify.py`
// diffs the result against `font.py`, which reproduces the GS display list's
// 12.4 vertex X exactly.
const subs = (() => {
  if (!S.font) return null;
  const s = html.indexOf('// ===8<=== TRAPT SUBS ===8<===');
  const e = html.indexOf('// ===8<=== END TRAPT SUBS ===8<===');
  if (s < 0 || e < 0) throw new Error('TRAPT SUBS markers not found in player.html');
  const box = { FNT: S.font, layout: null };
  vm.createContext(box);
  vm.runInContext(html.slice(s, e) + '\nthis.layout = layout;', box,
                  { filename: 'player.html:TRAPT_SUBS' });
  const out = S.subtitles.map((cue) => box.layout(cue.raw).map(
    ([slot, x, y, t]) => [slot, +x.toFixed(6), +y.toFixed(6), t.map((v) => +v.toFixed(6))]));
  console.error('laid out %d subtitle cues', out.length);
  return out;
})();

const result = { frame, entities: {}, subs };
for (const ent of S.entities) {
  if (!(frame >= ent.start && M.visibleAt(ent, frame))) continue;
  const cur = M.clipFor(ent, frame);
  const clip = cur ? S.clips[cur[1]] : null;
  const t = cur ? frame - cur[0] : 0;
  const rec = { clip: cur ? cur[1] : null, localFrame: t, models: {} };
  for (const key of ent.models) {
    const md = S.models[key];
    if (!md) continue;
    const W = M.worldMatrices(md, clip, t);
    // a compact fingerprint: every bone matrix, plus a vertex sample per mesh
    const bones = [];
    for (const m of W) bones.push(Array.from(m, (v) => +v.toFixed(4)));
    const verts = [];
    for (const me of md.meshes) {
      const P = M.skinMesh(me, W, ent.position);
      const step = Math.max(1, Math.floor(me.count / 12));
      const sample = [];
      for (let v = 0; v < me.count; v += step)
        sample.push([+P[v*3].toFixed(3), +P[v*3+1].toFixed(3), +P[v*3+2].toFixed(3)]);
      verts.push(sample);
    }
    rec.models[key] = { bones, verts };
  }
  result.entities[ent.name] = rec;
}

const json = JSON.stringify(result);
if (outPath) fs.writeFileSync(outPath, json);
else process.stdout.write(json);
console.error('posed %d entities at frame %s', Object.keys(result.entities).length, frame);
