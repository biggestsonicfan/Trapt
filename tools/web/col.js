/**
 * `.col` room collision -- `tools/col.py` in the browser, solver included.
 *
 *   0x00 u32   group count
 *   0x04 u32   -> group table (always 0x08)
 *   0x08       group[], stride 12:
 *                u8 tag, u8 material, u8 primitive count, u8 0xff,
 *                u8 0,   u8 flags,    u8 0,              u8 verts,
 *                u32 offset
 *              ... primitives, 64 bytes: 4 x float4 ...
 *
 * `verts` is 5 for a quad and 3 for a triangle; a triangle's fourth vertex is
 * uninitialised authoring memory.  `material` is a surface class (1/4 floor,
 * 2/5/6 wall, 7 ceiling, 3 a whole room shell of both), so the surface is
 * classified per primitive from its own normal.
 *
 * All 3808 wall primitives on the disc are exactly vertical, so a wall is a
 * line segment in XZ with a height band and the body is a circle: wall
 * resolution is exact 2D, not an approximated sweep.
 *
 * `move`, `pushOut` and `spawnPoint` are the same algorithms as the Python,
 * step for step, so `test_stage.js` can diff them over real disc data -- and
 * they must stay that way, because a solver that drifts is a solver that puts
 * the player through a wall in one of the two.
 */
(function () {
'use strict';

const GROUP_STRIDE = 12;
const PRIM_STRIDE = 64;
const TABLE_OFF = 0x08;
const FLOOR_COS = 0.7;

const MATERIALS = { 1: 'floor', 2: 'wall', 3: 'shell', 4: 'floor',
                    5: 'wall', 6: 'wall', 7: 'ceiling' };

const STEP_UP = 12.0;
const FALL = 400.0;
const PUSH_EPS = 0.01;
const PASSES = 4;

function surfaceOf(n) {
  if (n[1] > FLOOR_COS) return 'floor';
  if (n[1] < -FLOOR_COS) return 'ceiling';
  return 'wall';
}

function normalOf(v0, v1, v2) {
  const ax = v1[0] - v0[0], ay = v1[1] - v0[1], az = v1[2] - v0[2];
  const bx = v2[0] - v0[0], by = v2[1] - v0[1], bz = v2[2] - v0[2];
  const nx = ay * bz - az * by;
  const ny = az * bx - ax * bz;
  const nz = ax * by - ay * bx;
  const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (l < 1e-9) return [0, 0, 0];
  return [nx / l, ny / l, nz / l];
}

/** Y of a face at (x, z), or null when the point is outside it. */
function heightIn(f, x, z) {
  const ax = f.a[0], az = f.a[2];
  const bx = f.b[0], bz = f.b[2];
  const cx = f.c[0], cz = f.c[2];
  const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
  if (Math.abs(d) < 1e-9) return null;
  const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
  const v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
  const w = 1 - u - v;
  if (u < -1e-4 || v < -1e-4 || w < -1e-4) return null;
  return u * f.a[1] + v * f.b[1] + w * f.c[1];
}

function closestOnSegment(px, pz, x1, z1, x2, z2) {
  const dx = x2 - x1, dz = z2 - z1;
  const l = dx * dx + dz * dz;
  if (l < 1e-12) return [x1, z1];
  let t = ((px - x1) * dx + (pz - z1) * dz) / l;
  t = t < 0 ? 0 : (t > 1 ? 1 : t);
  return [x1 + dx * t, z1 + dz * t];
}

class Mesh {
  constructor(groups) {
    this.groups = groups;
    this.faces = [];
    for (const g of groups)
      for (const prim of g.prims) {
        const tris = g.verts === 3 ? [[0, 1, 2]] : [[0, 1, 2], [0, 2, 3]];
        for (const [i, j, k] of tris) {
          const a = prim[i], b = prim[j], c = prim[k];
          const n = normalOf(a, b, c);
          this.faces.push({ a, b, c, normal: n, surface: surfaceOf(n),
                            group: g.index, material: g.material });
        }
      }
    this.floors = this.faces.filter((f) => f.surface === 'floor');
    this.ceilings = this.faces.filter((f) => f.surface === 'ceiling');
    this.walls = this._segments();
  }

  /**
   * Every wall primitive as one XZ segment plus a height band.  The segment
   * is the pair of corners furthest apart in XZ -- min/max per axis would box
   * a diagonal wall instead of tracing it.
   */
  _segments() {
    const out = [];
    for (const g of this.groups)
      for (const prim of g.prims) {
        const verts = g.verts === 3 ? prim.slice(0, 3) : prim;
        const n = normalOf(verts[0], verts[1], verts[2]);
        if (surfaceOf(n) !== 'wall') continue;
        let best = null;
        for (let i = 0; i < verts.length; i++)
          for (let j = i + 1; j < verts.length; j++) {
            const dx = verts[i][0] - verts[j][0];
            const dz = verts[i][2] - verts[j][2];
            const d = dx * dx + dz * dz;
            if (!best || d > best[0]) best = [d, i, j];
          }
        if (!best || best[0] < 1e-12) continue;
        const [, i, j] = best;
        let y0 = Infinity, y1 = -Infinity;
        for (const v of verts) { if (v[1] < y0) y0 = v[1]; if (v[1] > y1) y1 = v[1]; }
        out.push({ x1: verts[i][0], z1: verts[i][2],
                   x2: verts[j][0], z2: verts[j][2],
                   y0, y1, nx: n[0], nz: n[2], group: g.index });
      }
    return out;
  }

  get bounds() {
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (const f of this.faces)
      for (const v of [f.a, f.b, f.c])
        for (let k = 0; k < 3; k++) {
          if (v[k] < lo[k]) lo[k] = v[k];
          if (v[k] > hi[k]) hi[k] = v[k];
        }
    if (!isFinite(lo[0])) return [[0, 0, 0], [0, 0, 0]];
    return [lo, hi];
  }

  floorAt(x, z, y, up, down) {
    up = up === undefined ? STEP_UP : up;
    down = down === undefined ? FALL : down;
    let best = null;
    for (const f of this.floors) {
      const hit = heightIn(f, x, z);
      if (hit === null || hit > y + up || hit < y - down) continue;
      if (!best || hit > best[0]) best = [hit, f];
    }
    return best;
  }

  ceilingAt(x, z, y, up) {
    up = up === undefined ? FALL : up;
    let best = null;
    for (const f of this.ceilings) {
      const hit = heightIn(f, x, z);
      if (hit === null || hit < y || hit > y + up) continue;
      if (!best || hit < best[0]) best = [hit, f];
    }
    return best;
  }
}

/** Move (x, z) out of every wall it overlaps; deepest overlap first. */
function pushOut(mesh, x, y, z, radius, height) {
  let hits = 0;
  for (let pass = 0; pass < PASSES; pass++) {
    let worst = null;
    for (const w of mesh.walls) {
      if (w.y1 <= y || w.y0 >= y + height) continue;
      const [cx, cz] = closestOnSegment(x, z, w.x1, w.z1, w.x2, w.z2);
      const dx = x - cx, dz = z - cz;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d >= radius) continue;
      const pen = radius - d;
      if (!worst || pen > worst[0]) worst = [pen, dx, dz, d, w];
    }
    if (!worst) break;
    hits++;
    const [pen, dx, dz, d, w] = worst;
    let ux, uz;
    if (d > 1e-6) { ux = dx / d; uz = dz / d; }
    else {
      const l = Math.sqrt(w.nx * w.nx + w.nz * w.nz);
      if (l < 1e-9) break;
      ux = w.nx / l; uz = w.nz / l;
    }
    x += ux * (pen + PUSH_EPS);
    z += uz * (pen + PUSH_EPS);
  }
  return { x, z, hits };
}

/**
 * Walk a body from `pos` by (dx, dz).  A step that ends over no floor at all
 * is refused: the rooms are sealed, so a walker that leaves one has found a
 * hole in the collision and not a ledge.
 */
function move(mesh, pos, dx, dz, radius, height, stepUp, fall) {
  stepUp = stepUp === undefined ? STEP_UP : stepUp;
  fall = fall === undefined ? FALL : fall;
  const [x, y, z] = pos;
  const out = pushOut(mesh, x + dx, y, z + dz, radius, height);
  const ground = mesh.floorAt(out.x, out.z, y, stepUp, fall);
  if (!ground) {
    const here = mesh.floorAt(x, z, y, stepUp, fall);
    return { pos: [x, here ? here[0] : y, z], hitWall: true,
             grounded: !!here, floor: here ? here[1] : null };
  }
  return { pos: [out.x, ground[0], out.z], hitWall: out.hits > 0,
           grounded: true, floor: ground[1] };
}

/**
 * How far along (x0,z0) -> (x1,z1) the first wall is, or null: `{t, wall}`.
 *
 * Every wall is a vertical segment, so this is an exact 2D segment-segment
 * intersection rather than a sweep -- and it is what a follow camera needs,
 * where `pushOut` cannot help: a camera wholly behind a wall overlaps
 * nothing, so there is no penetration to resolve and it stays there.
 */
function rayWalls(mesh, x0, z0, x1, z1, ylo, yhi) {
  const dx = x1 - x0, dz = z1 - z0;
  let best = null;
  for (const w of mesh.walls) {
    if (w.y1 <= ylo || w.y0 >= yhi) continue;
    const ex = w.x2 - w.x1, ez = w.z2 - w.z1;
    const denom = dx * ez - dz * ex;
    if (Math.abs(denom) < 1e-9) continue;
    const rx = w.x1 - x0, rz = w.z1 - z0;
    const t = (rx * ez - rz * ex) / denom;
    const u = (rx * dz - rz * dx) / denom;
    if (t < 0 || t > 1 || u < 0 || u > 1) continue;
    if (!best || t < best.t) best = { t, wall: w };
  }
  return best;
}

/** The centre of the largest floor triangle -- a deterministic place to stand. */
function spawnPoint(mesh) {
  let best = null;
  for (const f of mesh.floors) {
    const area = Math.abs((f.b[0] - f.a[0]) * (f.c[2] - f.a[2])
                        - (f.c[0] - f.a[0]) * (f.b[2] - f.a[2])) / 2;
    if (!best || area > best[0]) best = [area, f];
  }
  if (!best) return null;
  const f = best[1];
  return [(f.a[0] + f.b[0] + f.c[0]) / 3,
          (f.a[1] + f.b[1] + f.c[1]) / 3,
          (f.a[2] + f.b[2] + f.c[2]) / 3];
}

function parse(blob) {
  const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const count = dv.getUint32(0, true);
  const table = dv.getUint32(4, true);
  if (table !== TABLE_OFF)
    throw new Error('col: group table at 0x' + table.toString(16));
  if (table + count * GROUP_STRIDE > blob.length)
    throw new Error('col: ' + count + ' groups overrun ' + blob.length + ' bytes');
  const groups = [];
  for (let i = 0; i < count; i++) {
    const o = table + GROUP_STRIDE * i;
    const material = blob[o + 1], nprim = blob[o + 2];
    const flags = blob[o + 5], verts = blob[o + 7];
    const offset = dv.getUint32(o + 8, true);
    if (verts !== 3 && verts !== 5)
      throw new Error('col: group ' + i + ' has verts=' + verts);
    if (offset + nprim * PRIM_STRIDE > blob.length)
      throw new Error('col: group ' + i + ' overruns ' + blob.length + ' bytes');
    const nv = verts === 3 ? 3 : 4;
    const prims = [];
    for (let p = 0; p < nprim; p++) {
      const base = offset + PRIM_STRIDE * p;
      const prim = [];
      for (let k = 0; k < nv; k++)
        prim.push([dv.getFloat32(base + 16 * k, true),
                   dv.getFloat32(base + 16 * k + 4, true),
                   dv.getFloat32(base + 16 * k + 8, true)]);
      prims.push(prim);
    }
    groups.push({ index: i, tag: blob[o], material, flags, verts: nv,
                  offset, prims,
                  materialName: MATERIALS[material] || ('material' + material) });
  }
  return new Mesh(groups);
}

const api = { parse, Mesh, move, pushOut, rayWalls, spawnPoint, surfaceOf,
              normalOf, heightIn, closestOnSegment, MATERIALS, FLOOR_COS,
              STEP_UP, FALL, PUSH_EPS, PASSES };
if (typeof module !== 'undefined') module.exports = api;
if (typeof window !== 'undefined') window.TraptCol = api;
})();
