/**
 * Structural checks on `pick.html`.
 *
 *   node tools/web/test_page.js
 *
 * The decoders all have parity tests against Python; the page itself does
 * not, because it needs WebGL and a real DOM.  What it can be checked for is
 * the class of mistake that has actually bitten: an element the script asks
 * for that the markup never defines, and initialisation ordering.
 *
 * Route mode shipped broken on both counts at once.  `sceneTransport()` called
 * `setPs2()` before it wired the play button; `setPs2()` touched `V.look`,
 * which only `ensurePost()` creates, and `ensurePost()` only ran from
 * `drawFrame()`, which `tick()` skipped while nothing was in the scene.  So on
 * a route -- where the first thing shown is a card, not a model -- it threw
 * part-way through building the transport and left a Play button with no
 * handler, and with it the only thing that resumed the AudioContext.  Hence
 * "no pause and no sound", from one ordering mistake.
 *
 * These are text assertions, which is weaker than running the thing.  They are
 * here because they are cheap and they pin the exact regressions.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'pick.html'), 'utf8');
const script = html.slice(html.indexOf("<script>\n'use strict';"));

let failures = 0;
function check(what, ok, detail) {
  if (!ok) failures++;
  console.log('  %s %s%s', ok ? 'ok  ' : 'FAIL', what,
              ok || !detail ? '' : '\n        ' + detail);
}

/** The body of a top-level `function name(...) {...}` in the page script. */
function fn(name) {
  const i = script.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('no function ' + name);
  let depth = 0, j = script.indexOf('{', i);
  for (let k = j; k < script.length; k++) {
    if (script[k] === '{') depth++;
    else if (script[k] === '}' && --depth === 0) return script.slice(i, k + 1);
  }
  throw new Error('unterminated ' + name);
}

console.log('every element the script reaches for exists in the markup');
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const asked = new Set([...script.matchAll(/getElementById\('([^']+)'\)/g)]
  .map((m) => m[1]));
// these are created into innerHTML by the page itself
const made = new Set([...script.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const missing = [...asked].filter((id) => !ids.has(id) && !made.has(id));
check(asked.size + ' ids asked for, all defined', missing.length === 0,
      'missing: ' + missing.join(', '));

console.log('the transport is wired before anything that can throw');
const st = fn('sceneTransport');
const playAt = st.indexOf('btn.onclick');
// the call that runs while building, not the one inside the button handler
const ps2At = st.indexOf('setPs2(V.ps2');
check('playBtn gets its handler', playAt > 0);
check('and it gets it before setPs2 runs', playAt > 0 && ps2At > playAt,
      'setPs2 at ' + ps2At + ', btn.onclick at ' + playAt);
check('seek and cam are wired too',
      st.includes('seek.oninput') && st.includes('cam.onclick'));

console.log('nothing assumes the post pass has run yet');
check('ensureViewer creates it', fn('ensureViewer').includes('ensurePost()'));
check('setPs2 does not touch V.look unguarded',
      /if \(V\.look\) V\.look\.native/.test(fn('setPs2')),
      'V.look is only created by ensurePost()');
check('tick draws even with an empty scene',
      !/if \(!V \|\| !V\.group\) return;/.test(fn('tick'))
      && /if \(!V\.group\) \{ drawFrame\(\); return; \}/.test(fn('tick')));

console.log('audio starts, and starts from the beginning');
const ps = fn('playScene');
check('the scene is held until its audio is decoded',
      /playing: false/.test(ps) && ps.indexOf('preloadVoices') < ps.indexOf('S.playing = true'),
      'otherwise sync() marks the cues that went past as already spoken');
check('and the cue index is rebuilt when it starts',
      ps.indexOf('S.seeked = true') > ps.indexOf('preloadVoices'));
check('the AudioContext is resumed rather than left suspended',
      ps.includes('resumeAudio()') && fn('resumeAudio').includes('.resume()'));
check('with a fallback for a browser that refuses without a gesture',
      /addEventListener\('pointerdown'/.test(fn('resumeAudio')));

console.log('route mode hands control back when a scene ends');
check('playScene exposes an end hook', fn('routeNext').includes('S.onEnd'));
check('and tick fires it instead of looping',
      /if \(S\.onEnd\)/.test(fn('tick')));

console.log('modern mode fills the element');
check('only native is pillarboxed to 4:3',
      /if \(V\.look\.native\) \{[\s\S]*?OUT_ASPECT[\s\S]*?\} else \{[\s\S]*?fit\.value\.set\(1, 1\)/
        .test(fn('fitOutput')));
check('and the projection follows the same switch',
      fn('resize').includes('TraptGs.cameraAspect('));

console.log('the renderer does not require being on screen');
// A poster is rendered from the gallery, where nothing has been opened and
// there is no #view to attach a canvas to.  ensureViewer() has to build the
// renderer and its passes anyway, and only attach when there is a host.
const ev = fn('ensureViewer');
check('ensureViewer guards the host before touching it',
      /if \(host\) \{[\s\S]*?appendChild/.test(ev),
      'host is null on the gallery, before any cutscene is opened');
check('and still creates the post and subtitle passes',
      ev.indexOf('ensurePost()') < ev.indexOf('if (host)'));

console.log('fullscreen takes the viewer, not the document');
const tf = fn('toggleFullscreen');
check('it requests on #view so the overlays travel with it',
      tf.includes("getElementById('view')") && /requestFullscreen/.test(tf));
check('it exits when already fullscreen', /exitFullscreen/.test(tf));
check('and it is wired to a button and a key',
      script.includes("getElementById('fsBtn').onclick = toggleFullscreen")
      && /e\.key === 'f'/.test(script));
const fc = fn('fullscreenChanged');
check('the canvas and projection are recomputed after the browser resizes us',
      fc.includes('resize()'),
      'measuring straight after requestFullscreen is too early');
check('and the subtitle overlay is rebuilt at the new size',
      fc.includes('V.subKey = null'));

console.log(failures ? '\n%d FAILED' : '\nall checks passed', failures);
process.exit(failures ? 1 : 0);
