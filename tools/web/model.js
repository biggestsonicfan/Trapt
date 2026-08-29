/**
 * Build three.js objects from a decoded `.SMI` -- the bind-pose bridge.
 *
 * `smi.js` gives model-space positions, normals, UVs and a triangle list per
 * mesh; this turns those into `BufferGeometry` + `Material` and nothing else,
 * so it stays testable and the page keeps the scene graph.
 *
 * Two conventions are inherited from `player.html` rather than re-derived:
 *
 *  - `flipY = false` on every texture, because `.SMI` V already runs
 *    top-down.  Flipping sends face UVs into the blank half of the atlas --
 *    the symptom is streaky white heads on otherwise fine bodies.
 *  - The GS alpha test is `GEQUAL` against `AREF=120`, so `alphaTest` is
 *    120/255, and only for materials whose render word has 0x0020 or 0x0040.
 *    Cutting a material that has neither deletes geometry whose alpha channel
 *    is carrying an unrelated image.
 */
(function () {
'use strict';

const gs = (typeof require !== 'undefined') ? require('./gs.js') : window.TraptGs;

const AREF = 120 / 255;

/** `{width, height, rgba}` -> THREE.DataTexture, oriented the way the GS is. */
function makeTexture(THREE, pic) {
  const t = new THREE.DataTexture(pic.rgba, pic.width, pic.height, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;      // TEX1 reports no mipmaps on the disc
  t.flipY = false;                       // .SMI V already runs top-down
  t.needsUpdate = true;
  return t;
}

/**
 * `model` from smi.parse, `posed` from smi.bindPose, `texFor(name)` returning
 * a THREE.Texture or null, and `opts` = `{lights, tint, fog, ps2}` for the GS
 * material.  Returns a THREE.Group of one Mesh per SMI mesh.
 */
function build(THREE, model, posed, texFor, opts) {
  const o = opts || {};
  const group = new THREE.Group();
  model.meshes.forEach((me, i) => {
    if (!me.tris.length) return;
    const pn = posed[i];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pn.positions, 3));
    if (pn.normals)
      g.setAttribute('normal', new THREE.BufferAttribute(pn.normals, 3));
    if (me.uv.length) {
      const uv = new Float32Array(me.vcount * 2);
      for (let v = 0; v < me.vcount; v++) {
        uv[2 * v] = me.uv[v][0];
        uv[2 * v + 1] = me.uv[v][1];
      }
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    }
    // Environment geometry ships baked vertex colours and no normals;
    // characters ship normals and no colours.  0x80 is 1.0 on the GS, so 128
    // is the neutral default for a mesh that carries none.
    const col = new Uint8Array(me.vcount * 4);
    if (me.col.length)
      for (let v = 0; v < me.vcount; v++) {
        col[4 * v] = me.col[v][0]; col[4 * v + 1] = me.col[v][1];
        col[4 * v + 2] = me.col[v][2]; col[4 * v + 3] = me.col[v][3];
      }
    else col.fill(128);
    g.setAttribute('vcol', new THREE.BufferAttribute(col, 4, true));

    const idx = new Uint32Array(me.tris.length * 3);
    me.tris.forEach((t, k) => {
      idx[3 * k] = t[0]; idx[3 * k + 1] = t[1]; idx[3 * k + 2] = t[2];
    });
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    if (!pn.normals) g.computeVertexNormals();

    const mt = model.materials[me.material] || { diffuse: [255, 255, 255, 255] };
    const map = mt.texture ? texFor(mt.texture) : null;
    // The GS pipeline out of player.html, with `lit` picking which half runs:
    // characters shade from normals, rooms take their baked vertex colours.
    const mat = gs.makeMaterial(THREE, mt, {
      map: map, lights: o.lights, tint: o.tint, fog: o.fog,
      lit: me.nrm.length > 0, ps2: o.ps2 !== false,
    });

    const mesh = new THREE.Mesh(g, mat);
    mesh.name = 'mesh' + i;
    // Meshes with no triangles are skipped, so the child index is not the SMI
    // mesh index -- posing has to write back through this.
    mesh.userData = { meshIndex: i };
    // The bounding sphere is computed from the bind pose and never updated
    // as the rig moves, so three.js would cull an actor the moment it walked
    // out of the bounds it was authored in -- which is what made half of
    // e001's cast blink out.  player.html disables it for the same reason.
    mesh.frustumCulled = false;
    mesh.renderOrder = mt.blend ? 1 : 0;
    group.add(mesh);
  });
  return group;
}

/** Bounding sphere of the whole group, for framing a camera. */
function bounds(posed) {
  let minx = Infinity, miny = Infinity, minz = Infinity;
  let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
  for (const pn of posed)
    for (let i = 0; i < pn.positions.length; i += 3) {
      const x = pn.positions[i], y = pn.positions[i + 1], z = pn.positions[i + 2];
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
      if (z < minz) minz = z; if (z > maxz) maxz = z;
    }
  if (!isFinite(minx)) return { center: [0, 0, 0], radius: 1 };
  const c = [(minx + maxx) / 2, (miny + maxy) / 2, (minz + maxz) / 2];
  const r = Math.max(maxx - minx, maxy - miny, maxz - minz) / 2 || 1;
  return { center: c, radius: r, min: [minx, miny, minz], max: [maxx, maxy, maxz] };
}

const api = { build, makeTexture, bounds, AREF };
if (typeof module !== 'undefined') module.exports = api;
if (typeof window !== 'undefined') window.TraptModel = api;
})();
