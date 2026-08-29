/**
 * `.SMI` model reader -- `tools/smi.py` in the browser.  See that file's
 * docstring for the byte layout; this is the same reader, same conventions.
 *
 * The three that cost real time, restated because they are silent when wrong:
 *
 *  - **Matrices are row-vector.** A node's 4x4 is row-major with the
 *    translation in row 3 and multiplies as `v' = v * M`, so a child's world
 *    matrix is `local * parent`, not `parent * local`.
 *  - **A vertex is stored once per influencing bone**, in that bone's local
 *    space, and both the position and the normal are stored *already scaled*
 *    by the blend weight -- the position as a homogeneous float4 whose w is
 *    the weight.  So blending is a plain sum; re-applying the weight squares
 *    it and shrinks every multi-bone vertex.
 *  - **A mesh with an empty bone palette is rigid** and rides the single node
 *    at `+0x2a`, not the model root.  Read that as 0 and the queen's sceptre
 *    ends up at her feet.
 *
 * Geometry is one ADC-flagged triangle strip per mesh: a triangle is emitted
 * for every vertex whose 0x8000 bit is clear, winding alternating.
 */
(function () {
'use strict';

const MAGIC = 0x20030818;
const ADC = 0x8000;
const NRM_SCALE = 1.0 / 4096.0;
const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function cstr(b, o, max) {
  let s = '';
  for (let i = o; i < o + max && i < b.length && b[i]; i++)
    s += String.fromCharCode(b[i]);
  return s;
}

/** Map each stream pointer to the offset of whatever follows it. */
function regions(dv, pMesh, nMesh, size) {
  const pts = new Set([size]);
  for (let i = 0; i < nMesh; i++)
    for (let k = 0; k < 6; k++) {
      const p = dv.getUint32(pMesh + 0x2c * i + 4 * k, true);
      if (p) pts.add(p);
    }
  const s = [...pts].sort((a, b) => a - b);
  const next = new Map();
  for (let i = 0; i < s.length - 1; i++) next.set(s[i], s[i + 1]);
  return next;
}

function parse(data) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (dv.getUint32(0, true) !== MAGIC)
    throw new Error('not an SMI (magic ' + dv.getUint32(0, true).toString(16) + ')');
  const nNode = data[0x10], nMesh = data[0x12];
  const pNode = dv.getUint32(0x14, true);
  const pMesh = dv.getUint32(0x18, true);
  const pTab = dv.getUint32(0x1c, true);

  const materials = [];
  for (let o = pTab; o <= pMesh - 0x5c; o += 0x5c) {
    const name = cstr(data, o, 0x20);
    const f42 = dv.getUint16(o + 0x42, true);
    const a = data[o + 0x57];
    materials.push({
      name: name,
      texture: name ? name + '.tm2' : null,
      diffuse: [data[o + 0x54], data[o + 0x55], data[o + 0x56],
                a >= 0x80 ? 255 : a * 2],
      diffuseGs: [data[o + 0x54], data[o + 0x55], data[o + 0x56], a],
      flags: dv.getUint16(o + 0x40, true),
      render: f42,
      power: dv.getFloat32(o + 0x48, true),
      shade: dv.getUint32(o + 0x58, true),
      blend: !!(f42 & 0x0005),
      atest: !!(f42 & 0x0060),
      add: !!(f42 & 0x0005) && !!(f42 & 0x0100),
    });
  }

  const nodes = [];
  for (let i = 0; i < nNode; i++) {
    const o = pNode + 0x70 * i;
    const m = new Array(16);
    for (let k = 0; k < 16; k++) m[k] = dv.getFloat32(o + 4 * k, true);
    nodes.push({ matrix: m, parent: dv.getInt16(o + 0x40, true),
                 name: cstr(data, o + 0x50, 0x20) });
  }

  const next = regions(dv, pMesh, nMesh, data.byteLength);
  const meshes = [];
  for (let i = 0; i < nMesh; i++) {
    const o = pMesh + 0x2c * i;
    const ptrs = [];
    for (let k = 0; k < 6; k++) ptrs.push(dv.getUint32(o + 4 * k, true));
    const vc = dv.getUint16(o + 0x28, true);

    const palette = [];
    for (let k = 0; k < 12; k++)
      if (data[o + 0x18 + k] !== 0xff) palette.push(data[o + 0x18 + k]);

    let inf = 1;
    if (vc && next.has(ptrs[0]))
      inf = Math.max(1, Math.floor((next.get(ptrs[0]) - ptrs[0]) / (16 * vc)));

    const me = {
      index: i, vcount: vc, ptrs: ptrs, palette: palette,
      material: data[o + 0x24], base: dv.getUint16(o + 0x2a, true),
      influences: inf, pos: [], nrm: [], col: [], uv: [],
      flags: [], bones: [], weights: [], tris: [],
    };

    if (ptrs[0])
      for (let v = 0; v < vc; v++) {
        const row = [];
        for (let k = 0; k < inf; k++) {
          const p = ptrs[0] + 16 * (inf * v + k);
          row.push([dv.getFloat32(p, true), dv.getFloat32(p + 4, true),
                    dv.getFloat32(p + 8, true), dv.getFloat32(p + 12, true)]);
        }
        me.pos.push(row);
      }
    if (ptrs[1])
      for (let v = 0; v < vc; v++) {
        const row = [];
        for (let k = 0; k < inf; k++) {
          const p = ptrs[1] + 8 * (inf * v + k);
          row.push([dv.getInt16(p, true) * NRM_SCALE,
                    dv.getInt16(p + 2, true) * NRM_SCALE,
                    dv.getInt16(p + 4, true) * NRM_SCALE]);
        }
        me.nrm.push(row);
      }
    if (ptrs[2])
      for (let v = 0; v < vc; v++)
        me.col.push([data[ptrs[2] + 4 * v], data[ptrs[2] + 4 * v + 1],
                     data[ptrs[2] + 4 * v + 2], data[ptrs[2] + 4 * v + 3]]);
    if (ptrs[3])
      for (let v = 0; v < vc; v++)
        me.uv.push([dv.getFloat32(ptrs[3] + 8 * v, true),
                    dv.getFloat32(ptrs[3] + 8 * v + 4, true)]);

    if (ptrs[5])
      for (let v = 0; v < vc; v++) {
        const p = ptrs[5] + 8 * v;
        const i1 = dv.getInt16(p + 4, true), i0 = dv.getInt16(p + 6, true);
        me.flags.push(i0 & 0xffff);
        const idx = [(i0 & 0x7fff) >> 2, (i1 & 0x7fff) >> 2];
        const bones = [];
        for (let k = 0; k < inf; k++)
          bones.push(idx[k] < palette.length ? palette[idx[k]] : me.base);
        me.bones.push(bones);
        const w = [];
        for (let k = 0; k < inf; k++) w.push(me.pos.length ? me.pos[v][k][3] : 1.0);
        me.weights.push(w);
      }

    me.tris = strip(me.flags, vc);
    meshes.push(me);
  }
  return { nodes: nodes, meshes: meshes, materials: materials };
}

/** ADC-flagged strip -> triangle list, winding alternating. */
function strip(flags, vcount) {
  const tris = [];
  const n = Math.min(vcount, flags.length);
  for (let i = 2; i < n; i++) {
    if (flags[i] & ADC) continue;
    tris.push((i & 1) ? [i - 1, i - 2, i] : [i - 2, i - 1, i]);
  }
  return tris;
}

/** 4x4 * 4x4, row-major. */
function mul(a, b) {
  const out = new Array(16);
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 4; c++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[r * 4 + k] * b[k * 4 + c];
      out[r * 4 + c] = s;
    }
  return out;
}

/** Accumulate each node's local matrix down the parent chain. */
function worldMatrices(model) {
  const out = new Array(model.nodes.length).fill(null);
  function solve(i, seen) {
    if (out[i]) return out[i];
    const n = model.nodes[i];
    const p = n.parent;
    if (p < 0 || p >= model.nodes.length || p === i || seen.indexOf(p) >= 0)
      out[i] = n.matrix.slice();
    else
      out[i] = mul(n.matrix, solve(p, seen.concat([i])));
    return out[i];
  }
  for (let i = 0; i < model.nodes.length; i++) solve(i, []);
  return out;
}

/**
 * Skin every mesh into model space -> `[{positions, normals}]`, flat arrays.
 * Both streams arrive pre-scaled by their weight, so this is a plain sum.
 */
function bindPose(model) {
  const W = worldMatrices(model);
  const out = [];
  for (const me of model.meshes) {
    const P = new Float32Array(me.vcount * 3);
    const N = new Float32Array(me.vcount * 3);
    for (let v = 0; v < me.vcount; v++) {
      let px = 0, py = 0, pz = 0, nx = 0, ny = 0, nz = 0;
      for (let k = 0; k < me.influences; k++) {
        const p = me.pos.length ? me.pos[v][k] : [0, 0, 0, 1];
        const w = p[3];
        if (w === 0) continue;
        const b = (me.bones.length && k < me.bones[v].length) ? me.bones[v][k] : 0;
        const M = b < W.length ? W[b] : IDENT;
        px += p[0] * M[0] + p[1] * M[4] + p[2] * M[8] + w * M[12];
        py += p[0] * M[1] + p[1] * M[5] + p[2] * M[9] + w * M[13];
        pz += p[0] * M[2] + p[1] * M[6] + p[2] * M[10] + w * M[14];
        if (me.nrm.length) {
          const n = me.nrm[v][k];
          nx += n[0] * M[0] + n[1] * M[4] + n[2] * M[8];
          ny += n[0] * M[1] + n[1] * M[5] + n[2] * M[9];
          nz += n[0] * M[2] + n[1] * M[6] + n[2] * M[10];
        }
      }
      P[3 * v] = px; P[3 * v + 1] = py; P[3 * v + 2] = pz;
      N[3 * v] = nx; N[3 * v + 1] = ny; N[3 * v + 2] = nz;
    }
    out.push({ positions: P, normals: me.nrm.length ? N : null });
  }
  return out;
}

const api = { parse, bindPose, worldMatrices, strip, MAGIC };
if (typeof module !== 'undefined') module.exports = api;
if (typeof window !== 'undefined') window.TraptSmi = api;
})();
