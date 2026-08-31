/**
 * Load every browser module the way a browser does, with no disc.
 *
 *   node tools/web/test_modules.js
 *
 * Each file has to work under two loaders: `require` in the tests, and a
 * classic `<script>` in the page.  Those differ in exactly one dangerous way
 * -- `require` gives every file its own scope, while script tags share one
 * global lexical environment -- and that difference has already cost a
 * release: `iso.js` and `disc.js` both declared `u32` and `api` at top level,
 * so the second tag died with a redeclaration SyntaxError and the page failed
 * with "TraptDisc is not defined" while every test passed.
 *
 * This needs no game data, so it is the half of the suite CI can run.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
function check(what, ok, detail) {
  if (!ok) failures++;
  console.log('  %s %s%s', ok ? 'ok  ' : 'FAIL', what,
              ok || !detail ? '' : '\n        ' + detail);
}

const HERE = __dirname;
// `.gitattributes` says `* text=auto`, so a checkout on Windows hands
// this file back with CRLF endings while every marker below is written
// with LF.  Without normalising, the slices come back empty and the
// suite does not fail -- it finds nothing to check and passes, or dies
// on the first lookup.  Normalise once, here.
const html = fs.readFileSync(path.join(HERE, 'pick.html'), 'utf8')
  .replace(/\r\n/g, '\n');

// The order the page loads them in is the order they must work in.
const loaded = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map((m) => m[1])
  .filter((p) => !p.startsWith('..'));            // three.js is vendored

console.log('the page loads what it uses');
const inline = html.slice(html.indexOf("<script>\n'use strict';"));
const used = new Set([...inline.matchAll(/\b(Trapt[A-Za-z0-9]*)\b/g)].map((m) => m[1]));
// A global counts as used if the page's own script reaches for it, or if any
// loaded module does: play.js wants TraptCam, scene.js wants TraptSsc, and
// neither is named anywhere in the page.
const provided = new Set();
for (const f of loaded) {
  const src = fs.readFileSync(path.join(HERE, f), 'utf8');
  for (const m of src.matchAll(/window\.(Trapt[A-Za-z0-9]*)\s*=/g))
    provided.add(m[1]);
  // `\b` matters: without it the name backtracks until the lookahead passes,
  // and you collect `TraptIs` instead of rejecting `TraptIso =`.
  for (const m of src.matchAll(/window\.(Trapt[A-Za-z0-9]*)\b(?!\s*=)/g))
    used.add(m[1]);
}
const unprovided = [...used].filter((g) => !provided.has(g));
check(used.size + ' Trapt globals used, all provided by a loaded script',
      unprovided.length === 0, 'not loaded: ' + unprovided.join(', '));
const unused = [...provided].filter((g) => !used.has(g));
check('and nothing is loaded that the page never uses', unused.length === 0,
      'loaded but unused: ' + unused.join(', '));

// Being provided eventually is not enough.  Modules capture their dependency
// once, at load time -- `const playMod = req ? require('./play.js') :
// window.TraptPlay;` -- so the publisher must already have run.  poster.js
// shipped loading one tag before play.js, which left playMod undefined for
// the life of the page and put "can't access property assemble, playMod is
// undefined" in every gallery tile.  The sandbox check further down cannot
// see this: by the time it runs, every global is present.
const publisher = new Map();
for (const f of loaded) {
  const src = fs.readFileSync(path.join(HERE, f), 'utf8');
  for (const m of src.matchAll(/window\.(Trapt[A-Za-z0-9]*)\s*=/g))
    publisher.set(m[1], f);
}
const tooLate = [];
loaded.forEach((f, i) => {
  const src = fs.readFileSync(path.join(HERE, f), 'utf8');
  for (const m of src.matchAll(/window\.(Trapt[A-Za-z0-9]*)\b(?!\s*=)/g)) {
    const owner = publisher.get(m[1]);
    if (owner && loaded.indexOf(owner) > i)
      tooLate.push(f + ' reads ' + m[1] + ', which ' + owner + ' publishes later');
  }
});
check('and every one is published before it is read', tooLate.length === 0,
      tooLate.join('\n        '));

console.log('every module parses on its own');
for (const f of loaded) {
  let err = '';
  try {
    new vm.Script(fs.readFileSync(path.join(HERE, f), 'utf8'), { filename: f });
  } catch (e) { err = e.message; }
  check(f + ' parses', err === '', err);
}

console.log('and all of them together, in one shared global scope');
const sandbox = { console, TextDecoder, TextEncoder, performance, atob, Blob };
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
let loadErr = '';
for (const f of loaded) {
  try {
    vm.runInContext(fs.readFileSync(path.join(HERE, f), 'utf8'), sandbox,
                    { filename: f });
  } catch (e) {
    loadErr = f + ': ' + e.message;
    break;
  }
}
check(loaded.length + ' scripts load with no collision', loadErr === '', loadErr);
for (const g of [...provided].sort())
  check(g + ' is defined', typeof sandbox[g] === 'object' && sandbox[g] !== null);
check('no require or module leaked into the page path',
      [typeof sandbox.require, typeof sandbox.module].join() === 'undefined,undefined');

console.log('the same files work under require');
for (const f of loaded) {
  let err = '';
  try {
    const m = require(path.join(HERE, f));
    if (!m || typeof m !== 'object') err = 'exported ' + typeof m;
  } catch (e) { err = e.message; }
  check(f + ' exports an object', err === '', err);
}

// A handful of pure functions, so this suite is not purely structural.
console.log('a few things that need no disc at all');
const gs = require('./gs.js');
check('the display aspect rule', gs.cameraAspect(true, 1000, 100) === 4 / 3
      && gs.cameraAspect(false, 1000, 100) === 10);
const font = require('./font.js');
check('full-width folding matches what the script stores',
      font.widen("don't") === 'ｄｏｎ’ｔ');
// The value is proved against adx.py in test_audio; pinning it here only
// stops a change to the fixed-point maths passing unnoticed without a disc.
const adx = require('./adx.js');
check('the ADX predictor coefficients are stable',
      JSON.stringify(adx.coefficients(500, 48000)) === '[7400,-3343]',
      JSON.stringify(adx.coefficients(500, 48000)));
const scene = require('./scene.js');
check('a clip family drops its act number',
      scene.family('c01f_a_e001_2.sai') === 'c01f_a_e001'
      && scene.family('knife_a_e001.sai') === 'knife_a_e001');
const ssc = require('./ssc.js');
check('the subtitle markup is stripped to plain text',
      ssc.plain('Ｍｏｔｈｅｒ') === 'Mother');

console.log(failures ? '\n%d FAILED' : '\nall checks passed', failures);
process.exit(failures ? 1 : 0);
