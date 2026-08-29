/**
 * Prove `gs.js` still carries `player.html`'s shaders verbatim.
 *
 *   node tools/web/test_shader.js
 *
 * The GS emulation in `player.html` is the product of a long argument with a
 * savestate (docs/PS2SHADER.md): the 120/128 alpha reference, the `>>7`
 * modulate, which materials may be alpha-tested, the lit/unlit split between
 * characters and rooms.  `gs.js` runs the same look over CPU-skinned
 * geometry, and the only honest way to do that was to copy the fragment
 * shader and the post pass across.
 *
 * Two copies of anything drift.  This makes that a test failure rather than a
 * slow divergence nobody notices: if you edit either file's GLSL, this fails
 * and tells you to copy it over.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const gs = require('./gs.js');
const { stubThree } = require('./stub_three.js');

let failures = 0;
function check(what, ok, detail) {
  if (!ok) failures++;
  console.log('  %s %s%s', ok ? 'ok  ' : 'FAIL', what,
              ok || !detail ? '' : '\n        ' + detail);
}

const html = fs.readFileSync(path.join(__dirname, '..', 'player.html'), 'utf8');

/** Pull `const NAME = \`...\`;` out of player.html. */
function block(name) {
  const open = 'const ' + name + ' = `';
  const i = html.indexOf(open);
  if (i < 0) throw new Error(name + ' not found in player.html');
  const j = html.indexOf('`;', i);
  return html.slice(i + open.length, j);
}

// player.html interpolates ${RT_H} into POST_F; gs.js does too, so compare
// the raw source text on both sides.
const raw = fs.readFileSync(path.join(__dirname, 'gs.js'), 'utf8');
function gsBlock(name) {
  const open = 'const ' + name + ' = `';
  const i = raw.indexOf(open);
  if (i < 0) throw new Error(name + ' not found in gs.js');
  const j = raw.indexOf('`;', i);
  return raw.slice(i + open.length, j);
}

console.log('gs.js against player.html');
for (const name of ['FRAG', 'POST_V', 'POST_F']) {
  const a = block(name), b = gsBlock(name);
  check(name + ' is byte-identical (' + a.length + ' chars)', a === b,
        a === b ? '' : 'copy it across: the two have diverged');
}

// The vertex stage is deliberately different -- and must be, because this
// page skins on the CPU.  Assert the difference is the one intended.
console.log('the vertex stage differs, on purpose');
check('gs.js VERT does not sample a bone texture',
      !/boneTex/.test(gs.VERT), 'it should take posed positions directly');
check('player.html VERT does', /boneTex/.test(block('VERT')));
check('both hand the fragment stage the same varyings',
      ['vUv', 'vN', 'vP', 'vC'].every(
        (v) => gs.VERT.includes('varying') && gs.VERT.includes(v)
            && block('VERT').includes(v)));

console.log('the uniforms the fragment shader declares are all supplied');
const declared = [...gs.FRAG.matchAll(/uniform\s+\w+\s+([^;]+);/g)]
  .flatMap((m) => m[1].split(',').map((s) => s.trim()));
const THREE = stubThree();
const mat = gs.makeMaterial(THREE, { diffuse: [1, 2, 3, 255], atest: true }, {});
const missing = declared.filter((u) => !(u in mat.uniforms));
check(declared.length + ' uniforms, none missing', missing.length === 0,
      'missing: ' + missing.join(', '));

const post = gs.makePost(THREE);
const postDeclared = [...gs.POST_F.matchAll(/uniform\s+\w+\s+([^;]+);/g)]
  .flatMap((m) => m[1].split(',').map((s) => s.trim()));
const postMissing = postDeclared.filter((u) => !(u in post.uniforms));
check(postDeclared.length + ' post uniforms, none missing', postMissing.length === 0,
      'missing: ' + postMissing.join(', '));

console.log('the material honours the material word');
const blended = gs.makeMaterial(THREE, { blend: true, diffuse: [0, 0, 0, 128] }, {});
check('a blended material never writes depth', blended.depthWrite === false);
check('and never discards', blended.uniforms.blendOn.value === 1);
const additive = gs.makeMaterial(THREE, { blend: true, add: true, diffuse: [0, 0, 0, 0] }, {});
check('an additive material uses OneFactor',
      additive.blendDst === THREE.OneFactor);
check('an opaque material tests at 120/128',
      Math.abs(mat.uniforms.alphaRef.value - 120 / 128) < 1e-9);
check('a material with no alpha-test bits is not cut',
      gs.makeMaterial(THREE, { diffuse: [0, 0, 0, 0] }, {}).uniforms.aTest.value === 0);
check('PS2 is the default and can be switched off',
      [mat.uniforms.ps2.value,
       gs.makeMaterial(THREE, {}, { ps2: false }).uniforms.ps2.value].join() === '1,0');

console.log('lights come from the scene, with the room supplying the aim');
const rig = gs.lightsFor(THREE, [
  { light: 'ambient', scale: [0.2, 0.2, 0.2] },
  { light: 'ambient', scale: [0.1, 0.1, 0.1] },
  { light: 'directional', scale: [0.5, 0.5, 0.5] },
  { light: 'point', scale: [1, 0, 0], transform: [1, 2, 3], lightRange: [0, 50],
    lightParent: true },
], [0.2594, 0.9342, -0.2450]);
check('several ambient blocks sum',
      Math.abs(rig.ambient.x - 0.3) < 1e-6, 'got ' + rig.ambient.x);
check('the directional takes its colour from the block and its aim from the room',
      Math.abs(rig.dirColour.x - 0.5) < 1e-6
      && Math.abs(rig.dirDir.y - 0.9342) < 1e-3);
check('a camera-parented point light is flagged', rig.points[0].cam === true);
check('the rig is padded to the two the shader declares', rig.points.length === 2);

console.log('the projection aspect');
// The .cam FOV is vertical and the 512x224 target is anamorphic -- the video
// hardware stretches it to 4:3.  Taking the aspect from the element instead
// widens the field and slides everything toward the centre: measured on e001
// frame 7422, Catalina lands 76 px of 512 from where the hardware has her.
check('native renders at the display aspect, not the element',
      gs.cameraAspect(true, 1032, 460) === 4 / 3);
check('modern renders at the element aspect',
      Math.abs(gs.cameraAspect(false, 1032, 460) - 1032 / 460) < 1e-9);
const tanHalf = Math.tan(40 * Math.PI / 180 / 2);
const hfov = (a) => Math.round(2 * Math.atan(tanHalf * a) * 180 / Math.PI * 10) / 10;
check('40 deg vertical is 51.8 horizontal at 4:3, not 78.5 at 2.24',
      [hfov(4 / 3), hfov(1032 / 460)].join(), '51.8,78.5');

// player.html and pdiag.py both carry this rule; if either stops, say so.
check('player.html still uses OUT_ASPECT when native',
      /camera\.aspect = FX\.native \? OUT_ASPECT/.test(html));
const pdiag = fs.readFileSync(path.join(__dirname, '..', 'pdiag.py'), 'utf8');
check('pdiag.py still divides the horizontal focal by the display aspect',
      /fx = \(W\*0\.5\)\/\(t\*DISPLAY_ASPECT\)/.test(pdiag));

console.log(failures ? '\n%d FAILED' : '\nall checks passed', failures);
process.exit(failures ? 1 : 0);
