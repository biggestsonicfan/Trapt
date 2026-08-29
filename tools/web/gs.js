/**
 * The GS look, for geometry that is skinned on the CPU.
 *
 * `player.html` reproduces the PlayStation 2 fixed-function pipeline the game
 * actually configures -- read out of a savestate's display list, documented
 * in `docs/PS2SHADER.md`.  This page needs the same look over geometry that
 * `sai.js` has already posed, so the **fragment shader and the post pass are
 * copied out of `player.html` verbatim**; `tools/web/test_shader.js` diffs
 * them and fails if the two ever drift apart.
 *
 * Only the vertex stage differs, and only because it has less to do: the
 * player skins on the GPU from a bone texture, while here the positions
 * arriving in the attribute have already been posed.
 */
(function () {
'use strict';

// The GS renders this game at 512x224 and the display hardware stretches it.
const RT_W = 512, RT_H = 224, OUT_ASPECT = 4 / 3;

/**
 * The aspect to project a `.cam` FOV at.
 *
 * The FOV in the track is **vertical**, and the 512x224 target is
 * **anamorphic** -- the video hardware stretches it to 4:3 -- so the
 * horizontal half-angle comes from the *display* aspect, never from the
 * width/height of whatever element the canvas happens to be in.  Using the
 * element's aspect widens the field: at a 2.24 viewport that is 78.5 degrees
 * horizontal instead of 51.8, and e001 frame 7422 puts Catalina 76 px away
 * from where the hardware has her, 15% of the frame's width.
 *
 * `pdiag.py` carries the same note, having been caught by the same thing when
 * it was first asked to render at the hardware's own resolution.
 */
function cameraAspect(native, width, height) {
  return native ? OUT_ASPECT : (width / height);
}

// Skinning already happened on the CPU, so this only has to hand the fragment
// stage the same varyings the player's vertex shader does.  RawShaderMaterial
// declares nothing for you, but three still binds these names.
const VERT = `
precision highp float;
attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;
attribute vec4 vcol;
uniform mat4 modelMatrix, modelViewMatrix, projectionMatrix;
uniform mat3 normalMatrix;
varying vec2 vUv; varying vec3 vN; varying vec3 vP; varying vec4 vC;
void main() {
  vP = (modelMatrix * vec4(position, 1.0)).xyz;
  vN = normalMatrix * normal;
  vUv = uv;
  vC = vcol;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = `
precision highp float;
// The GS has no programmable fragment stage.  This reproduces the fixed
// function the game actually configures, read out of a savestate's display
// list (docs/PS2SHADER.md):
//   TEX0  TFX=MODULATE TCC=RGBA      -> C = (Ct * Cv) >> 7,  A = (At * Av) >> 7
//   TEST  ATE=1 ATST=GEQUAL AREF=120 -> discard below 120/128
//         or ATST=NEVER AFAIL=FB_ONLY-> draw blended, never write Z
//   ALPHA (Cs-Cd)*As>>7 + Cd         -> ordinary lerp, As in 0..128
//   COLCLAMP=1                       -> clamp, do not wrap
// The ">>7" is the whole trick: 0x80 is 1.0 on the GS, so a vertex colour of
// 128 is neutral and 255 is a 2x brightener.
#define GS_ONE 1.9921875              // 255/128: byte-normalised -> GS units
uniform sampler2D map; uniform float hasMap;
uniform vec4 diffuse; uniform vec3 tint;
uniform vec3 ambient, dirColour, dirDir;
uniform vec3 pt0c, pt0p, pt1c, pt1p; uniform vec2 pt0r, pt1r;
uniform vec3 fogColour; uniform vec2 fogRange; uniform float fogOn;
uniform vec3 eye; uniform float exposure;
uniform float lit;             // 1 = shade from normals, 0 = baked vertex colour
uniform float alphaRef;        // AREF / 128
uniform float aTest;           // material arms TEST ATE=1 (.SMI +0x42 & 0x60)
uniform float blendOn;         // material goes through the ALPHA blend unit
uniform float ps2;             // 0 = bypass the GS emulation entirely
varying vec2 vUv; varying vec3 vN; varying vec3 vP; varying vec4 vC;
vec3 point(vec3 c, vec3 pos, vec2 rng, vec3 n) {
  vec3 d = pos - vP;
  float att = 1.0 - smoothstep(rng.x, max(rng.y, rng.x + 0.001), length(d));
  return c * max(dot(n, normalize(d)), 0.0) * att;
}
void main() {
  // The .SMI material colour is authoring leftover, not a modulate factor.
  // Ten materials in e001 alone pair (0,0,0) with a perfectly good texture --
  // multiplying rendered the door, the whole rp11_rt prop set and gf16_rt
  // pure black.  A texture replaces the colour; diffuse is only for the
  // handful of materials that carry no texture at all.
  vec4 base = diffuse;
  if (hasMap > 0.5) base = texture2D(map, vUv);

  // MODULATE folds the vertex alpha in before anything tests it:
  // A = (At * Av) >> 7.  It is 0x80 = 1.0 nearly everywhere, but rp11's lamp
  // glow ships 0x38 = 0.44 and is 2.3x too hot without it.
  base.a *= clamp(vC.a * GS_ONE, 0.0, 1.0);

  // GS alpha test.  Opaque materials use GEQUAL AREF=120/128 with AFAIL=KEEP,
  // so a failing fragment is dropped outright.  Blended materials instead use
  // ATST=NEVER with AFAIL=FB_ONLY, which draws every fragment and simply never
  // writes Z -- that half is depthWrite:false on the JS side, so they must not
  // discard here at all.
  // Modern mode uses an ordinary half-coverage cutout instead of the GS's
  // 120/128; the hardware threshold only makes sense alongside the FB_ONLY
  // depth trick it is paired with.
  // Only materials that arm the test get cut.  Several textures carry an
  // unrelated image in their alpha channel -- the plaza's grass ground is 92%
  // alpha-zero because what sits in its alpha is a strip of grass-blade
  // silhouettes for another material on the same page.  Testing everything
  // against alpha deleted the lawn and punched holes around the doorway.
  if (blendOn < 0.5 && aTest > 0.5
      && base.a < (ps2 > 0.5 ? alphaRef : 0.5)) discard;

  // Do NOT flip on gl_FrontFacing.  .SMI index winding is a clean global
  // reversal: measured against the ADC strip decode, (b-a)x(c-a) opposes the
  // authored normal on 100.0% of character triangle area.  Under WebGL's
  // default CCW-front rule every visible surface therefore reports *back*, so
  // the flip inverted the normal across 65-87% of submitted area and cut mean
  // N.L from 0.78 to 0.13 -- which is what the old additive lift was
  // compensating for.  (Rooms cannot be measured this way and do not need to
  // be: environment meshes carry no normals at all, only baked vertex
  // colours, and take the lit == 0 path below.)  vN is already outward.
  vec3 n = normalize(vN);

  // Environment geometry ships baked vertex colours and no normals at all;
  // characters ship normals and no colours.  Lighting the room dynamically is
  // simply wrong -- rp03.smi carries 17120 pre-lit vertices averaging 0.4 and
  // peaking at exactly 128, which is why the real frame is so much darker than
  // a dynamically lit one.
  vec3 Cv = (lit > 0.5)
      ? (ambient
         + dirColour * max(dot(n, dirDir), 0.0)
         + point(pt0c, pt0p, pt0r, n)
         + point(pt1c, pt1p, pt1r, n)) * exposure
      : vC.rgb * GS_ONE;

  vec3 col;
  if (ps2 > 0.5) {
    // GS: 8-bit throughout, no colour management, COLCLAMP=1 at the end
    col = clamp(base.rgb * Cv * tint, 0.0, 1.0);
    if (fogOn > 0.5)
      col = mix(col, fogColour,
                smoothstep(fogRange.x, fogRange.y, length(vP - eye)) * 0.85);
  } else {
    // Modern: decode sRGB, light in linear, tonemap, re-encode.  The textures
    // are 8-bit sRGB art either way -- the difference is that the PS2 multiplies
    // them directly in gamma space and clips, which crushes highlights.
    vec3 alb = pow(base.rgb, vec3(2.2));
    col = alb * Cv * tint;
    if (fogOn > 0.5)
      col = mix(col, pow(fogColour, vec3(2.2)),
                smoothstep(fogRange.x, fogRange.y, length(vP - eye)) * 0.85);
    col = (col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14);  // ACES
    col = pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2));
  }
  gl_FragColor = vec4(col, blendOn > 0.5 ? base.a : 1.0);
}`;

const POST_V = `
precision highp float;
attribute vec3 position; attribute vec2 uv;
uniform mat4 modelViewMatrix, projectionMatrix;
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

const POST_F = `
precision highp float;
uniform sampler2D tex;
uniform vec2 fit;            // letterbox scale, keeps the 4:3 output shape
uniform vec2 texel;          // 1 / render-target size
uniform float sharp;         // 0 = bilinear upscale, 1 = crisp texel edges
uniform float bits;          // colour depth: 8 = off, 5 = PSMCT16-ish
uniform float dither;        // GS ordered dither strength
uniform float exposure2, contrast, saturation, warmth, vignette, scanline;
varying vec2 vUv;

// The GS dither matrix (DIMX) is a 4x4 of values in -4..3 applied before the
// framebuffer write.  This game ships DTHE=0 so it is off on hardware; it is
// here as a knob because it is the classic PS2 banding remedy.
float dimx(vec2 p) {
  int x = int(mod(p.x, 4.0)), y = int(mod(p.y, 4.0));
  float m[16];
  m[0]=-4.0; m[1]= 0.0; m[2]=-3.0; m[3]= 1.0;
  m[4]= 2.0; m[5]=-2.0; m[6]= 3.0; m[7]=-1.0;
  m[8]=-3.0; m[9]= 1.0; m[10]=-4.0; m[11]=0.0;
  m[12]=3.0; m[13]=-1.0; m[14]=2.0; m[15]=-2.0;
  int i = y * 4 + x;
  for (int k = 0; k < 16; k++) if (k == i) return m[k];
  return 0.0;
}

void main() {
  vec2 uv = (vUv - 0.5) / fit + 0.5;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return;
  }
  // sharp-bilinear: ease within each texel so the upscale keeps hard pixel
  // edges without the stair-stepping of pure nearest.  Derivative-free, so it
  // needs no GLSL ES extension.
  vec2 t = uv / texel;
  vec2 snapped = (floor(t) + smoothstep(0.0, 1.0, fract(t))) * texel;
  vec3 c = texture2D(tex, mix(uv, snapped, sharp)).rgb;

  c = c * exposure2;
  c = (c - 0.5) * contrast + 0.5;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, saturation);
  c *= vec3(1.0 + warmth * 0.12, 1.0, 1.0 - warmth * 0.12);

  if (bits < 7.5) {
    float steps = pow(2.0, bits) - 1.0;
    c += dimx(gl_FragCoord.xy) / 255.0 * dither;
    c = floor(c * steps + 0.5) / steps;
  }
  if (scanline > 0.0) {
    float s = 1.0 - scanline * 0.5 * (1.0 - cos(uv.y * 3.14159 * 2.0 * ${RT_H}.0));
    c *= s;
  }
  if (vignette > 0.0) {
    vec2 d = (vUv - 0.5) * 2.0;
    c *= mix(1.0, 1.0 - vignette, clamp(dot(d, d) * 0.55, 0.0, 1.0));
  }
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

// AREF is 120 of 128 on the opaque pass.  tm2.js already maps PS2 alpha
// 0..0x80 onto 0..255, so the normalised threshold is the same number.
const AREF_OPAQUE = 120 / 128;

/** Two dead point lights: the shader declares two and always reads both. */
function zeroPoints(THREE) {
  const out = [];
  while (out.length < 2)
    out.push({ c: new THREE.Vector3(), p: new THREE.Vector3(),
               r: new THREE.Vector2(0, 1), cam: false,
               off: new THREE.Vector3() });
  return out;
}

/** The rig a scene with no light blocks of its own falls back to. */
function defaultLights(THREE) {
  return {
    ambient: new THREE.Vector3(0.10, 0.10, 0.10),
    dirColour: new THREE.Vector3(0.35, 0.35, 0.35),
    dirDir: new THREE.Vector3(0.35, 0.80, -0.49).normalize(),
    points: zeroPoints(THREE),
  };
}

/**
 * Resolve a scene's `0x64` kind-6 blocks into the uniform set the shader
 * wants.  `roomDir` is what `sli.js` read out of the room, which is the only
 * place a directional light's aim exists -- the script block carries a colour
 * and no direction.
 *
 * `0x80` on a light block is its **colour**, not a scale.
 */
function lightsFor(THREE, lightEntities, roomDir) {
  const rig = defaultLights(THREE);
  rig.points = [];                      // the scene's own lights replace them
  let haveAmb = false;
  for (const l of lightEntities) {
    const c = new THREE.Vector3().fromArray(
      l.scale ? l.scale.slice(0, 3) : [1, 1, 1]);
    if (l.light === 'ambient') {
      // several ambient blocks in one scene do sum; the fallback does not
      if (haveAmb) rig.ambient.add(c); else rig.ambient.copy(c);
      haveAmb = true;
    } else if (l.light === 'directional') {
      rig.dirColour.copy(c);
      if (roomDir) rig.dirDir.fromArray(roomDir).normalize();
    } else {
      const p = l.transform ? l.transform.slice(0, 3) : [0, 0, 0];
      rig.points.push({
        c: c,
        p: new THREE.Vector3().fromArray(p),
        r: new THREE.Vector2().fromArray(l.lightRange || [0, 200]),
        // `joyu` rides the camera: its position is an offset in camera space
        cam: !!l.lightParent,
        off: new THREE.Vector3().fromArray(p),
      });
    }
  }
  while (rig.points.length < 2) rig.points.push(zeroPoints(THREE)[0]);
  return rig;
}

/** One material, with the same uniform set player.html builds. */
function makeMaterial(THREE, mt, opts) {
  const o = opts || {};
  const rig = o.lights || defaultLights(THREE);
  const tex = o.map || null;
  const d = mt.diffuse || [200, 200, 200, 255];
  const add = !!mt.add;
  const blend = add || !!mt.blend;
  const fog = o.fog || null;
  const pts = rig.points;
  return new THREE.RawShaderMaterial({
    vertexShader: VERT, fragmentShader: FRAG, side: THREE.DoubleSide,
    transparent: blend,
    depthWrite: !blend,                 // TEST ATST=NEVER + AFAIL=FB_ONLY
    depthTest: true,
    blending: blend ? THREE.CustomBlending : THREE.NoBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.SrcAlphaFactor,
    blendDst: add ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor,
    uniforms: {
      map: { value: tex }, hasMap: { value: tex ? 1 : 0 },
      diffuse: { value: new THREE.Vector4(d[0] / 255, d[1] / 255, d[2] / 255, 1.0) },
      tint: { value: new THREE.Vector3().fromArray(o.tint || [1, 1, 1]) },
      ambient: { value: rig.ambient },
      dirColour: { value: rig.dirColour }, dirDir: { value: rig.dirDir },
      pt0c: { value: pts[0].c }, pt0p: { value: pts[0].p }, pt0r: { value: pts[0].r },
      pt1c: { value: pts[1].c }, pt1p: { value: pts[1].p }, pt1r: { value: pts[1].r },
      fogColour: { value: fog ? new THREE.Color(fog[2], fog[3], fog[4])
                              : new THREE.Color() },
      fogRange: { value: new THREE.Vector2(fog ? fog[0] : 0, fog ? fog[1] : 1e9) },
      fogOn: { value: fog ? 1 : 0 },
      eye: { value: new THREE.Vector3() },
      exposure: { value: o.exposure === undefined ? 1.0 : o.exposure },
      lit: { value: o.lit ? 1 : 0 },
      alphaRef: { value: AREF_OPAQUE },
      aTest: { value: mt.atest ? 1 : 0 },
      blendOn: { value: blend ? 1 : 0 },
      ps2: { value: o.ps2 === false ? 0 : 1 },
    },
  });
}

/** The post pass: native 512x224, colour depth, dither, grade, scanlines. */
const LOOK = {
  native: 1, sharp: 0, bits: 8, dither: 0, exposure2: 1, contrast: 1,
  saturation: 1, warmth: 0, vignette: 0, scanline: 0,
};

function makePost(THREE) {
  return new THREE.RawShaderMaterial({
    vertexShader: POST_V, fragmentShader: POST_F,
    depthTest: false, depthWrite: false,
    uniforms: {
      tex: { value: null },
      fit: { value: new THREE.Vector2(1, 1) },
      texel: { value: new THREE.Vector2(1 / RT_W, 1 / RT_H) },
      sharp: { value: LOOK.sharp }, bits: { value: LOOK.bits },
      dither: { value: LOOK.dither }, exposure2: { value: LOOK.exposure2 },
      contrast: { value: LOOK.contrast }, saturation: { value: LOOK.saturation },
      warmth: { value: LOOK.warmth }, vignette: { value: LOOK.vignette },
      scanline: { value: LOOK.scanline },
    },
  });
}

const api = { VERT, FRAG, POST_V, POST_F, makeMaterial, makePost, lightsFor,
              defaultLights, cameraAspect, LOOK, AREF_OPAQUE,
              RT_W, RT_H, OUT_ASPECT };
if (typeof module !== 'undefined') module.exports = api;
if (typeof window !== 'undefined') window.TraptGs = api;
})();
