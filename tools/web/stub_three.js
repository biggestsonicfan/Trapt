/**
 * Just enough of THREE to run the builders headlessly -- no WebGL, no canvas,
 * the same object shapes.
 *
 * WebGL cannot run in a test here, but nearly everything that goes wrong in
 * `model.js`, `gs.js` and `play.js` is wrong before a single pixel is drawn:
 * an index past the end of a position array, a UV array of the wrong length,
 * a uniform the fragment shader declares and nobody supplies, a material that
 * should be alpha-tested and is not.  All of that is visible here.  Only the
 * shading itself needs a real GPU.
 */
'use strict';

function stubThree() {
  class Vector2 {
    constructor(x, y) { this.x = x || 0; this.y = y || 0; }
    set(x, y) { this.x = x; this.y = y; return this; }
    fromArray(a) { this.x = a[0]; this.y = a[1]; return this; }
    copy(o) { return this.set(o.x, o.y); }
  }
  class Vector3 {
    constructor(x, y, z) { this.set(x || 0, y || 0, z || 0); }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    copy(o) { return this.set(o.x, o.y, o.z); }
    add(o) { this.x += o.x; this.y += o.y; this.z += o.z; return this; }
    fromArray(a) { return this.set(a[0], a[1], a[2]); }
    normalize() {
      const n = Math.hypot(this.x, this.y, this.z) || 1;
      return this.set(this.x / n, this.y / n, this.z / n);
    }
  }
  class BufferAttribute {
    constructor(array, itemSize, normalized) {
      this.array = array; this.itemSize = itemSize;
      this.normalized = !!normalized; this.needsUpdate = false;
    }
  }
  class BufferGeometry {
    constructor() { this.attributes = {}; this.index = null; this.computed = false; }
    setAttribute(n, a) { this.attributes[n] = a; }
    setIndex(a) { this.index = a; }
    computeVertexNormals() { this.computed = true; }
    dispose() { this.disposed = true; }
  }
  // `traverse`, `remove` and `clone` exist because `stageview.js` walks a
  // built group to re-point its light uniforms when the body changes room,
  // drops the collision overlay when it is turned off, and clones a trap's
  // model once per placement.
  class Object3D {
    constructor() {
      this.children = []; this.visible = true;
      this.position = new Vector3();
      this.rotation = new Vector3();
      this.scale = new Vector3(1, 1, 1);
      this.userData = {};
    }
    lookAt(x, y, z) { this.lookingAt = [x, y, z]; return this; }
    add(c) { this.children.push(c); return this; }
    remove(c) {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
      return this;
    }
    traverse(fn) { fn(this); for (const c of this.children) c.traverse(fn); }
    clone() {
      const out = new this.constructor();
      out.children = this.children.map((c) => c.clone());
      out.material = this.material;
      out.geometry = this.geometry;
      return out;
    }
  }
  class Group extends Object3D {}
  return {
    Vector2, Vector3, BufferAttribute, BufferGeometry, Group, Object3D,
    Vector4: class { constructor(x, y, z, w) { Object.assign(this, { x, y, z, w }); } },
    Color: class { constructor(r, g, b) { Object.assign(this, { r, g, b }); } },
    Mesh: class extends Object3D {
      constructor(g, m) {
        super();
        this.geometry = g; this.material = m; this.frustumCulled = true;
      }
    },
    LineSegments: class extends Object3D {
      constructor(g, m) { super(); this.geometry = g; this.material = m; }
    },
    LineBasicMaterial: class { constructor(o) { Object.assign(this, o); } },
    // Sprite effects: a unit quad, a basic material and lookAt.  The aim is
    // recorded rather than turned into a matrix -- what the tests need to
    // know is that a billboard was pointed at the camera at all.
    PlaneGeometry: class {
      constructor(w, h) { this.width = w; this.height = h; this.attributes = {}; }
      dispose() { this.disposed = true; }
    },
    MeshBasicMaterial: class {
      constructor(o) {
        Object.assign(this, o);
        if (!this.color) this.color = { r: 1, g: 1, b: 1 };
        this.color.setRGB = (r, g, b) => {
          this.color.r = r; this.color.g = g; this.color.b = b;
        };
      }
    },
    DataTexture: class {
      constructor(d, w, h) { this.image = { data: d, width: w, height: h }; }
    },
    RawShaderMaterial: class { constructor(o) { Object.assign(this, o); } },
    MeshLambertMaterial: class { constructor(o) { Object.assign(this, o); } },
    RGBAFormat: 1023, RepeatWrapping: 1000, LinearFilter: 1006,
    DoubleSide: 2, AdditiveBlending: 2, CustomBlending: 5, NoBlending: 0,
    AddEquation: 100, SrcAlphaFactor: 204, OneFactor: 201,
    OneMinusSrcAlphaFactor: 205,
  };
}

module.exports = { stubThree };
