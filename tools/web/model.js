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
 * a THREE.Texture or null.  Returns a THREE.Group of one Mesh per SMI mesh.
 */
function build(THREE, model, posed, texFor) {
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
    const idx = new Uint32Array(me.tris.length * 3);
    me.tris.forEach((t, k) => {
      idx[3 * k] = t[0]; idx[3 * k + 1] = t[1]; idx[3 * k + 2] = t[2];
    });
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    if (!pn.normals) g.computeVertexNormals();

    const mt = model.materials[me.material] || { diffuse: [255, 255, 255, 255] };
    const map = mt.texture ? texFor(mt.texture) : null;
    const mat = new THREE.MeshLambertMaterial({
      map: map,
      color: new THREE.Color(mt.diffuse[0] / 255, mt.diffuse[1] / 255,
                             mt.diffuse[2] / 255),
      transparent: !!mt.blend,
      opacity: mt.blend ? mt.diffuse[3] / 255 : 1,
      alphaTest: mt.atest ? AREF : 0,
      depthWrite: !mt.blend,
      side: THREE.DoubleSide,
    });
    if (mt.add) mat.blending = THREE.AdditiveBlending;

    const mesh = new THREE.Mesh(g, mat);
    mesh.name = 'mesh' + i;
    // Meshes with no triangles are skipped, so the child index is not the SMI
    // mesh index -- posing has to write back through this.
    mesh.userData = { meshIndex: i };
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
