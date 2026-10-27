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
uniform vec2 uvOff;            // an effect track's 0x7C scroll
varying vec2 vUv; varying vec3 vN; varying vec3 vP; varying vec4 vC;
void main() {
  vP = (modelMatrix * vec4(position, 1.0)).xyz;
  // World space, like vP and every light.  Not three's normalMatrix: that is
  // the inverse transpose of *modelView* and puts the normal in view space,
  // so the cast was lit by a rig that turned with the camera -- Allura 33
  // levels dark at e001 7422.  Groups here translate (and effects scale
  // uniformly), so the model matrix's 3x3 is the right one; FRAG normalises.
  vN = mat3(modelMatrix) * normal;
  vUv = uv + uvOff;
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
uniform float fxAlpha;         // an effect track's 0x7D/0x7E material alpha
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
  gl_FragColor = vec4(col, blendOn > 0.5 ? base.a * clamp(fxAlpha, 0.0, 1.0) : 1.0);
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

// ---------------------------------------------------------------- newpixie
// RetroArch's crt/newpixie-crt, ported to GLSL ES 1.00.
//
//   newpixie CRT, by Mattias Gustavsson; adapted for slang by hunterk.
//   Dual licensed MIT / public domain (Unlicense).  Copyright (c) 2016
//   Mattias Gustavsson.  Upstream: libretro/slang-shaders crt/shaders/newpixie
//
// The .slangp is four passes and this is all four, in order: accumulate (a
// feedback pass that decays the previous frame), a separable 9-tap blur run
// horizontally then vertically, and the CRT itself, which samples the
// accumulate output for the image and the blurred one for the ghosting.  The
// first three run at the framebuffer's own size, which for us is 512x224, so
// they cost almost nothing; only the last one is full-viewport.
//
// What sits in front of it is our own post pass, so the chain is: GS emulation
// at 512x224 -> colour depth, dither and grade -> the CRT.  That order is the
// physical one, a console's video signal arriving at a tube, and it is why the
// CRT does not replace POST_F but consumes it.
//
// Two upstream things are deliberately not here.  `use_frame` composites a
// bezel photograph (crtframe.png) over the result; it defaults to off, and the
// whole point of this page is that it ships no binary assets.  And `tsample`
// upstream takes `offs` and `resolution` arguments that its body never reads,
// so they are dropped rather than carried.
const CRT_ACC_F = `
precision highp float;
uniform sampler2D src;       // this frame, out of the post pass
uniform sampler2D prev;      // what this pass produced last frame
uniform float modulate;      // how much of the old frame survives
varying vec2 vUv;
void main() {
  vec4 a = texture2D(prev, vUv) * modulate;
  vec4 b = texture2D(src, vUv);
  gl_FragColor = max(a, b * 0.96);
}`;

const CRT_BLUR_F = `
precision highp float;
uniform sampler2D src;
uniform vec2 dir;            // (blur/width, 0) horizontally, (0, blur/height) vertically
varying vec2 vUv;
void main() {
  vec4 sum = texture2D(src, vUv) * 0.2270270270;
  sum += texture2D(src, vUv - 4.0 * dir) * 0.0162162162;
  sum += texture2D(src, vUv - 3.0 * dir) * 0.0540540541;
  sum += texture2D(src, vUv - 2.0 * dir) * 0.1216216216;
  sum += texture2D(src, vUv - 1.0 * dir) * 0.1945945946;
  sum += texture2D(src, vUv + 1.0 * dir) * 0.1945945946;
  sum += texture2D(src, vUv + 2.0 * dir) * 0.1216216216;
  sum += texture2D(src, vUv + 3.0 * dir) * 0.0540540541;
  sum += texture2D(src, vUv + 4.0 * dir) * 0.0162162162;
  gl_FragColor = sum;
}`;

const CRT_F = `
precision highp float;
uniform sampler2D backbuffer;   // the accumulate pass
uniform sampler2D blurbuffer;   // the vertical blur
uniform vec2 fit;               // letterbox, the same rule POST_F uses
uniform vec2 resolution;        // the lit area, in device pixels
uniform float frame;            // FrameCount upstream
uniform float curvature, wiggle, scanroll, vignette, ghosting;
varying vec2 vUv;

vec3 tsample(sampler2D samp, vec2 tc) {
  tc = tc * vec2(1.025, 0.92) + vec2(-0.0125, 0.04);
  vec3 s = pow(abs(texture2D(samp, vec2(tc.x, 1.0 - tc.y)).rgb), vec3(2.2));
  return s * vec3(1.25);
}

vec3 filmic(vec3 linearColor) {
  vec3 x = max(vec3(0.0), linearColor - vec3(0.004));
  return (x * (6.2 * x + 0.5)) / (x * (6.2 * x + 1.7) + 0.06);
}

vec2 curve(vec2 uv) {
  uv = (uv - 0.5);
  uv *= vec2(0.925, 1.095);
  uv *= curvature;
  uv.x *= 1.0 + pow((abs(uv.y) / 4.0), 2.0);
  uv.y *= 1.0 + pow((abs(uv.x) / 3.0), 2.0);
  uv /= curvature;
  uv += 0.5;
  uv = uv * 0.92 + 0.04;
  return uv;
}

float rand(vec2 co) {
  return fract(sin(dot(co.xy, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  // Outside the 4:3 box there is no tube, so there is nothing to light.
  vec2 box = (vUv - 0.5) / fit + 0.5;
  if (box.x < 0.0 || box.x > 1.0 || box.y < 0.0 || box.y > 1.0) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return;
  }
  // Upstream's vertex stage flips y and tsample flips it back; keeping both
  // halves means the asymmetric offsets inside tsample land where they do
  // upstream instead of mirrored.
  vec2 vTexCoord = vec2(box.x, 1.0 - box.y);
  vec2 fragCoord = vTexCoord * resolution;

  float time = mod(frame, 849.0) * 36.0;
  vec2 uv = vTexCoord;

  /* Curve */
  vec2 curved_uv = mix(curve(uv), uv, 0.4);
  float scale = -0.101;
  vec2 scuv = curved_uv * (1.0 - scale) + scale / 2.0 + vec2(0.003, -0.001);
  uv = scuv;

  /* Main color, Bleed */
  vec3 col;
  float x = wiggle * sin(0.1 * time + curved_uv.y * 13.0)
          * sin(0.23 * time + curved_uv.y * 19.0)
          * sin(0.3 + 0.11 * time + curved_uv.y * 23.0) * 0.0012;
  float o = sin(fragCoord.y * 1.5) / resolution.x;
  x += o * 0.25;
  time = float(mod(frame, 640.0));
  col.r = tsample(backbuffer, vec2(x + scuv.x + 0.0009, scuv.y + 0.0009)).x + 0.02;
  col.g = tsample(backbuffer, vec2(x + scuv.x + 0.0000, scuv.y - 0.0011)).y + 0.02;
  col.b = tsample(backbuffer, vec2(x + scuv.x - 0.0015, scuv.y + 0.0000)).z + 0.02;
  float i = clamp(col.r * 0.299 + col.g * 0.587 + col.b * 0.114, 0.0, 1.0);
  i = pow(1.0 - pow(i, 2.0), 1.0);
  i = (1.0 - i) * 0.85 + 0.15;

  /* Ghosting */
  float ghs = 0.15 * ghosting;
  vec3 r = tsample(blurbuffer, vec2(x - 0.014, -0.027) * 0.85
      + 0.007 * vec2(0.35 * sin(1.0 / 7.0 + 15.0 * curved_uv.y + 0.9 * time),
                     0.35 * sin(2.0 / 7.0 + 10.0 * curved_uv.y + 1.37 * time))
      + vec2(scuv.x + 0.001, scuv.y + 0.001)).xyz * vec3(0.5, 0.25, 0.25);
  vec3 g = tsample(blurbuffer, vec2(x - 0.019, -0.020) * 0.85
      + 0.007 * vec2(0.35 * cos(1.0 / 9.0 + 15.0 * curved_uv.y + 0.5 * time),
                     0.35 * sin(2.0 / 9.0 + 10.0 * curved_uv.y + 1.50 * time))
      + vec2(scuv.x + 0.000, scuv.y - 0.002)).xyz * vec3(0.25, 0.5, 0.25);
  vec3 b = tsample(blurbuffer, vec2(x - 0.017, -0.003) * 0.85
      + 0.007 * vec2(0.35 * sin(2.0 / 3.0 + 15.0 * curved_uv.y + 0.7 * time),
                     0.35 * cos(2.0 / 3.0 + 10.0 * curved_uv.y + 1.63 * time))
      + vec2(scuv.x - 0.002, scuv.y + 0.000)).xyz * vec3(0.25, 0.25, 0.5);

  col += vec3(ghs * (1.0 - 0.299)) * pow(clamp(vec3(3.0) * r, vec3(0.0), vec3(1.0)), vec3(2.0)) * vec3(i);
  col += vec3(ghs * (1.0 - 0.587)) * pow(clamp(vec3(3.0) * g, vec3(0.0), vec3(1.0)), vec3(2.0)) * vec3(i);
  col += vec3(ghs * (1.0 - 0.114)) * pow(clamp(vec3(3.0) * b, vec3(0.0), vec3(1.0)), vec3(2.0)) * vec3(i);

  /* Level adjustment (curves) */
  col *= vec3(0.95, 1.05, 0.95);
  col = clamp(col * 1.3 + 0.75 * col * col + 1.25 * col * col * col * col * col,
              vec3(0.0), vec3(10.0));

  /* Vignette */
  float vig = ((1.0 - 0.99 * vignette)
      + 16.0 * curved_uv.x * curved_uv.y * (1.0 - curved_uv.x) * (1.0 - curved_uv.y));
  vig = 1.3 * pow(vig, 0.5);
  col *= vig;

  time *= scanroll;

  /* Scanlines */
  float scans = clamp(0.35 + 0.18 * sin(6.0 * time - curved_uv.y * resolution.y * 1.5), 0.0, 1.0);
  float s = pow(scans, 0.9);
  col = col * vec3(s);

  /* Vertical lines (shadow mask) */
  col *= 1.0 - 0.23 * (clamp((mod(fragCoord.x, 3.0)) / 2.0, 0.0, 1.0));

  /* Tone map */
  col = filmic(col);

  /* Noise */
  vec2 seed = curved_uv * resolution;
  col -= 0.015 * pow(vec3(rand(seed + time), rand(seed + time * 2.0), rand(seed + time * 3.0)), vec3(1.5));

  /* Flicker */
  col *= (1.0 - 0.004 * (sin(50.0 * time + curved_uv.y * 2.0) * 0.5 + 0.5));

  gl_FragColor = vec4(col, 1.0);
}`;

/** newpixie's own defaults, from the #pragma parameter lines upstream. */
const CRT = {
  on: 0, modulate: 0.65, blur: 1, curvature: 2, wiggle: 0, scanroll: 1,
  vignette: 1, ghosting: 1,
};

/** The three materials of the CRT chain; the caller owns the targets. */
function makeCrt(THREE) {
  const flat = { depthTest: false, depthWrite: false, vertexShader: POST_V };
  return {
    acc: new THREE.RawShaderMaterial(Object.assign({}, flat, {
      fragmentShader: CRT_ACC_F,
      uniforms: { src: { value: null }, prev: { value: null },
                  modulate: { value: CRT.modulate } },
    })),
    blur: new THREE.RawShaderMaterial(Object.assign({}, flat, {
      fragmentShader: CRT_BLUR_F,
      uniforms: { src: { value: null }, dir: { value: new THREE.Vector2() } },
    })),
    crt: new THREE.RawShaderMaterial(Object.assign({}, flat, {
      fragmentShader: CRT_F,
      uniforms: {
        backbuffer: { value: null }, blurbuffer: { value: null },
        fit: { value: new THREE.Vector2(1, 1) },
        resolution: { value: new THREE.Vector2(RT_W, RT_H) },
        frame: { value: 0 },
        curvature: { value: CRT.curvature }, wiggle: { value: CRT.wiggle },
        scanroll: { value: CRT.scanroll }, vignette: { value: CRT.vignette },
        ghosting: { value: CRT.ghosting },
      },
    })),
  };
}

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

/**
 * Move the rig's camera-parented lights onto the camera, as player.html does
 * before every frame.  ELF 0x001D44B0 rebuilds a parented light each frame as
 * `camera_rotation * offset + eye`, with the offset's x along -right: `joyu`'s
 * (10, -5, 0) at e001 7422 lands at (4.140, 5.258, -37.819), which
 * `eye - 10*R - 5*U` reproduces to 5e-5.  `joyu` is the key light on the
 * cast; left at its raw offset it sits near the world origin and Allura comes
 * out 33 levels darker than the hardware frame.
 */
function placeCameraLights(rig, camera) {
  if (!rig || !rig.points.some((l) => l.cam)) return;
  camera.updateMatrixWorld();
  const e = camera.matrixWorld.elements;
  for (const l of rig.points) {
    if (!l.cam) continue;
    // three's camera looks down its -Z, so forward is the negated third column
    l.p.copy(camera.position);
    l.p.x += -l.off.x * e[0] + l.off.y * e[4] - l.off.z * e[8];
    l.p.y += -l.off.x * e[1] + l.off.y * e[5] - l.off.z * e[9];
    l.p.z += -l.off.x * e[2] + l.off.y * e[6] - l.off.z * e[10];
  }
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
      uvOff: { value: new THREE.Vector2() },
      fxAlpha: { value: 1 },
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
             placeCameraLights,
              defaultLights, cameraAspect, LOOK, AREF_OPAQUE,
              CRT_ACC_F, CRT_BLUR_F, CRT_F, CRT, makeCrt,
              RT_W, RT_H, OUT_ASPECT };
if (typeof module !== 'undefined') module.exports = api;
if (typeof window !== 'undefined') window.TraptGs = api;
})();
