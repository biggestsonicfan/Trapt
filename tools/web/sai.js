/**
 * `.SAI` skeletal animation + the poser -- `tools/sai.py` and `tools/pose.py`
 * in the browser.  See those files for the byte layout.
 *
 * One clip is a flat list of nodes named after `.SMI` bones, each with up to
 * three keyed channels (rotation, translation, scale).  Rotations are unit
 * quaternions in **(x, y, z, w)** order in the *column*-vector convention --
 * the transpose of the row-vector 3x3 in the `.SMI` node -- which is why
 * `quatToMatrix` below returns the row-vector form directly and it drops
 * straight into a node matrix.
 *
 * A clip only carries the channels it animates.  Everything it leaves out
 * falls back to the bind matrix: that is how a rotation-only clip keeps a
 * rig's proportions, and it is why the scale fallback is the *length of each
 * bind row* rather than 1.
 */
(function () {
'use strict';

const MAGIC = 0x20030818;
const NODE_STRIDE = 0x30;
const CHAN_MARK = 0xAAAA;
const ROT = 0, POS = 1, SCL = 2;
const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function cstr(b, o, max) {
  let s = '';
  for (let i = o; i < o + max && i < b.length && b[i]; i++)
    s += String.fromCharCode(b[i]);
  return s;
}

/** Value at frame `t`: slerp for rotation, lerp otherwise. */
function sample(ch, t) {
  const ts = ch.times, vs = ch.values;
  if (!ts.length) return null;
  if (t <= ts[0]) return vs[0];
  if (t >= ts[ts.length - 1]) return vs[vs.length - 1];
  let lo = 0, hi = ts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] <= t) lo = mid; else hi = mid;
  }
  const span = ts[hi] - ts[lo];
  const f = span === 0 ? 0 : (t - ts[lo]) / span;
  if (ch.kind === ROT) return slerp(vs[lo], vs[hi], f);
  const a = vs[lo], b = vs[hi];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f,
          a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f];
}

function slerp(a, b, f) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  if (d < 0) { b = [-b[0], -b[1], -b[2], -b[3]]; d = -d; }
  if (d > 0.9995) {
    const o = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f,
               a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f];
    const n = Math.sqrt(o[0] * o[0] + o[1] * o[1] + o[2] * o[2] + o[3] * o[3]) || 1;
    return [o[0] / n, o[1] / n, o[2] / n, o[3] / n];
  }
  const th = Math.acos(Math.max(-1, Math.min(1, d)));
  const s = Math.sin(th);
  const wa = Math.sin((1 - f) * th) / s, wb = Math.sin(f * th) / s;
  return [a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb,
          a[2] * wa + b[2] * wb, a[3] * wa + b[3] * wb];
}

/** (x,y,z,w) -> row-major 4x4 in the same row-vector convention as `.SMI`. */
function quatToMatrix(q) {
  const x = q[0], y = q[1], z = q[2], w = q[3];
  return [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
          2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
          2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
          0, 0, 0, 1];
}

/** Inverse of quatToMatrix, for the bind-pose rotation fallback. */
function matrixToQuat(m) {
  const m00 = m[0], m01 = m[1], m02 = m[2];
  const m10 = m[4], m11 = m[5], m12 = m[6];
  const m20 = m[8], m21 = m[9], m22 = m[10];
  const t = m00 + m11 + m22;
  let q;
  if (t > 0) {
    const s = Math.sqrt(t + 1) * 2;
    q = [(m12 - m21) / s, (m20 - m02) / s, (m01 - m10) / s, 0.25 * s];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [0.25 * s, (m10 + m01) / s, (m20 + m02) / s, (m12 - m21) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(m10 + m01) / s, 0.25 * s, (m21 + m12) / s, (m20 - m02) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(m20 + m02) / s, (m21 + m12) / s, 0.25 * s, (m01 - m10) / s];
  }
  const n = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

function parse(data) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.byteLength < 0x14 || dv.getUint32(0, true) !== MAGIC)
    throw new Error('not a SAI (magic ' + dv.getUint32(0, true).toString(16) + ')');
  const fsize = dv.getUint32(4, true);
  const count = dv.getUint16(8, true);
  const nodeOff = dv.getUint32(0x0c, true), zero = dv.getUint32(0x10, true);
  if (nodeOff !== 0x14 || zero !== 0) throw new Error('unexpected SAI header');

  const nodes = [];
  let duration = 0;
  for (let i = 0; i < count; i++) {
    const p = nodeOff + i * NODE_STRIDE;
    const node = { name: cstr(data, p + 4, 0x20),
                   duration: dv.getUint32(p, true), channels: {} };
    for (let kind = 0; kind < 3; kind++) {
      const cp = dv.getUint32(p + 0x24 + 4 * kind, true);
      if (!cp) continue;
      const cdur = dv.getUint32(cp, true);
      const nkeys = dv.getUint16(cp + 4, true);
      if (dv.getUint16(cp + 6, true) !== CHAN_MARK)
        throw new Error('bad channel marker at 0x' + cp.toString(16));
      const tOff = dv.getUint32(cp + 8, true), vOff = dv.getUint32(cp + 12, true);
      const times = new Array(nkeys), values = new Array(nkeys);
      for (let k = 0; k < nkeys; k++) {
        times[k] = dv.getUint16(tOff + 2 * k, true);
        values[k] = [dv.getFloat32(vOff + 16 * k, true),
                     dv.getFloat32(vOff + 16 * k + 4, true),
                     dv.getFloat32(vOff + 16 * k + 8, true),
                     dv.getFloat32(vOff + 16 * k + 12, true)];
      }
      node.channels[kind] = { kind: kind, duration: cdur, times: times, values: values };
    }
    nodes.push(node);
    if (node.duration > duration) duration = node.duration;
  }
  if (fsize > data.byteLength)
    throw new Error('truncated SAI (' + data.byteLength + ' < ' + fsize + ')');
  return { duration: duration, nodes: nodes,
           byName: new Map(nodes.map((n) => [n.name, n])) };
}

const rowLen = (m, r) => Math.sqrt(m[r * 4] * m[r * 4] + m[r * 4 + 1] * m[r * 4 + 1]
                                 + m[r * 4 + 2] * m[r * 4 + 2]);

/** Row-major, row-vector 4x4 from quaternion, translation and scale. */
function compose(rot, t, s) {
  const r = quatToMatrix(rot);
  return [r[0] * s[0], r[1] * s[0], r[2] * s[0], 0,
          r[4] * s[1], r[5] * s[1], r[6] * s[1], 0,
          r[8] * s[2], r[9] * s[2], r[10] * s[2], 0,
          t[0], t[1], t[2], 1];
}

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

/** Per-node local matrices for `model` posed by `clip` at `frame`. */
function localMatrices(model, clip, frame) {
  const out = [];
  for (const node of model.nodes) {
    const bind = node.matrix;
    const a = clip ? clip.byName.get(node.name) : null;
    if (!a) { out.push(bind.slice()); continue; }
    const rot = a.channels[ROT], pos = a.channels[POS], scl = a.channels[SCL];
    if (!rot && !pos && !scl) { out.push(bind.slice()); continue; }
    const q = rot ? sample(rot, frame) : matrixToQuat(bind);
    const t = pos ? sample(pos, frame) : [bind[12], bind[13], bind[14]];
    const s = scl ? sample(scl, frame)
                  : [rowLen(bind, 0), rowLen(bind, 1), rowLen(bind, 2)];
    out.push(compose(q, t, s));
  }
  return out;
}

/** Accumulate posed local matrices down each node's parent chain. */
function worldMatrices(model, clip, frame) {
  const local = localMatrices(model, clip, frame || 0);
  const out = new Array(local.length).fill(null);
  function solve(i, seen) {
    if (out[i]) return out[i];
    const p = model.nodes[i].parent;
    if (p < 0 || p >= local.length || p === i || seen.indexOf(p) >= 0)
      out[i] = local[i];
    else
      out[i] = mul(local[i], solve(p, seen.concat([i])));
    return out[i];
  }
  for (let i = 0; i < local.length; i++) solve(i, []);
  return out;
}

/**
 * Skin every mesh with `mats` -> `[{positions, normals}]`.
 * Same plain sum as the bind pose: both streams are pre-scaled by the weight.
 */
function skin(model, mats) {
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
        const M = b < mats.length ? mats[b] : IDENT;
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

const api = { parse, sample, slerp, quatToMatrix, matrixToQuat, compose,
              localMatrices, worldMatrices, skin, ROT, POS, SCL, MAGIC };
if (typeof module !== 'undefined') module.exports = api;
if (typeof window !== 'undefined') window.TraptSai = api;
})();
