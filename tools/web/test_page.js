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
 * The second class is an ELF address written into the page.  The page is the
 * one place the modules cannot cover: every decoder takes its addresses from
 * `disc.region`, and the tests diff the decoders against Python, but the
 * page's own inline script is read by neither.  It kept the cutscene registry
 * at the US `0x00386920`, so a Japanese disc built its whole grid out of 154
 * strings of rubbish -- 154 tiles, none of them naming a file, "0 of 154 have
 * data" -- while every suite passed on both discs.
 *
 * These are text assertions, which is weaker than running the thing.  They are
 * here because they are cheap and they pin the exact regressions.
 */
'use strict';

const fs = require('fs');
const path = require('path');

// `.gitattributes` says `* text=auto`, so a checkout on Windows hands
// this file back with CRLF endings while every marker below is written
// with LF.  Without normalising, the slices come back empty and the
// suite does not fail -- it finds nothing to check and passes, or dies
// on the first lookup.  Normalise once, here.
const html = fs.readFileSync(path.join(__dirname, 'pick.html'), 'utf8')
  .replace(/\r\n/g, '\n');
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
// and the switches, whose markup swHtml writes around the id it is given
for (const m of script.matchAll(/swHtml\('([^']+)'/g)) made.add(m[1]);
const missing = [...asked].filter((id) => !ids.has(id) && !made.has(id));
check(asked.size + ' ids asked for, all defined', missing.length === 0,
      'missing: ' + missing.join(', '));

console.log('the transport is wired before anything that can throw');
const st = fn('sceneTransport');
const playAt = st.indexOf('btn.onchange');
// the call that runs while building, not the one inside the button handler
const ps2At = st.indexOf('setPs2(V.ps2');
check('playBtn gets its handler', playAt > 0);
check('and it gets it before setPs2 runs', playAt > 0 && ps2At > playAt,
      'setPs2 at ' + ps2At + ', btn.onchange at ' + playAt);
check('seek and cam are wired too',
      st.includes('seek.oninput') && st.includes('cam.onchange'));

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

console.log('sprite effects follow the camera the viewer is actually using');
check('applySceneFrame re-aims them at V.camera',
      /TraptPlay\.faceSprites\(S\.built,/.test(fn('applySceneFrame')),
      'poseAt aims at the scene camera; a free camera turns them edge-on');

console.log('route mode hands control back when a scene ends');
check('playScene exposes an end hook', fn('routeNext').includes('S.onEnd'));
check('and tick fires it instead of looping',
      /if \(S\.onEnd\)/.test(fn('tick')));

console.log('the picker and the player sit side by side');
const body = html.slice(html.indexOf('<div id="stage">'), html.indexOf('</main>'));
const side = body.slice(body.indexOf('<aside id="side">'), body.indexOf('</aside>'));
check('the cutscenes, stages, routes and disc report are tabs of one sidebar',
      ['id="cards"', 'id="stages"', 'id="routes"', 'id="rows"'].every((x) => side.includes(x)),
      'anything left below the player is a scroll away from what it plays');
check('#detail is the sidebar\'s sibling, not under it',
      body.indexOf('</aside>') < body.indexOf('<section id="detail">'));
check('the old name-only list is gone; every cutscene row has its still',
      !html.includes('id="list"') && !html.includes('id="listHead"'));

// It used to be positioned over the canvas with pointer-events: none, which
// made it unreadable against a bright frame and impossible to select.
// Everything between the opening of #view and the transport div is a child of
// the viewport; #vinfo must not be among them.
const viewKids = script.slice(script.indexOf('id="view"'), script.indexOf('id="transport"'));
check('the debug line is a panel under the transport, not an overlay on the video',
      !viewKids.includes('vinfo')
      && /id="transport"[\s\S]{0,80}?id="vinfo"/.test(script)
      && !/#vinfo \{[^}]*position: absolute/.test(html),
      'it belongs outside #view so its text can be read and copied');

// Stage mode runs its own camera and its own input, and both of those are
// things the page already had one of.  Every check here is a collision that
// would otherwise only show up with a controller in someone's hands.
console.log('stage mode owns the frame while it is running');
{
  const tick = fn('tick');
  const gAt = tick.indexOf('if (G) {');
  const orbitAt = tick.indexOf('placeFreeCam(');
  const sAt = tick.indexOf('if (S) {');
  check('tick handles the stage', gAt > 0);
  check('and does so before the cutscene and orbit blocks',
        gAt > 0 && gAt < sAt && gAt < orbitAt,
        'otherwise the follow camera and the orbit camera fight for the frame');
  check('and returns rather than falling through',
        /if \(G\) \{[\s\S]{0,200}?return;\s*\}/.test(tick));
  check('a long stall does not teleport the body',
        /Math\.min\(6, dt \* 60\)/.test(fn('stageTick')),
        'a backgrounded tab hands back a dt of seconds, not frames');

  // A stale G is not untidy, it is fatal: tick hands the stage the whole
  // frame and returns, so whatever took over gets starved.  That shipped
  // once -- a route hung on its first cutscene after a stage had been walked,
  // because the scene assembled, never advanced, and so never fired the
  // S.onEnd that moves the route on.  Every mode entry has to tear it down.
  check('leaveStage detaches the pad and drops the scene graph',
        /G\.pad\.detach\(\)/.test(fn('leaveStage'))
        && /V\.scene\.remove\(G\.runner\.root\)/.test(fn('leaveStage'))
        && /G = null;/.test(fn('leaveStage')));
  for (const entry of ['playScene', 'showModel', 'openCutscene', 'startRoute',
                       'playStage'])
    check(entry + ' leaves stage mode first',
          /leaveStage\(\);/.test(fn(entry)),
          'a stale G starves it of every frame');
  check('and V.group is only cleared when it was the stage',
        /if \(V\.group === G\.runner\.root\) V\.group = null;/
          .test(fn('leaveStage')),
        'blanking it unconditionally would drop the thing that replaced it');

  const ps = fn('playStage');
  check('entering stage mode leaves cutscene, model and route mode',
        /S = null; M = null;/.test(ps) && /leaveRoute\(\);/.test(ps),
        'otherwise a chapter card timer fires into a stage');
  check('a route timer is cleared and not just orphaned',
        /clearTimeout\(R\.timer\)/.test(fn('leaveRoute')));
  check('V.group follows the stage so drawFrame feeds it the eye position',
        /V\.group = runner\.root;/.test(ps),
        'the point lights in the GS shader need it');
  check('the pad is attached to the viewport, not the document',
        /attach\(document\.getElementById\('view'\)\)/.test(ps));
  check('and the viewport is made focusable so keys reach it',
        /view\.tabIndex = 0;/.test(ps) && /view\.focus\(\);/.test(ps));
  check('the HUD lives inside #view so fullscreen carries it',
        /<div id="view"><div id="hud">/.test(ps),
        'the letterbox, subtitles and look panel are children of #view too');
  check('the stage panel is built when a disc is opened',
        fn('load').includes('buildStagePanel()'));
  check('an unbound key stays the browser\'s',
        fs.readFileSync(path.join(__dirname, 'pad.js'), 'utf8')
          .includes('_wants(code)'),
        'preventDefault on every key would break tab, ctrl-r and the rest');
}

// The route used to announce a stage and step over it, because there was
// nothing to step into.  Now there is, so the card is a handoff -- and a
// handoff has two halves that have to agree about who owns `R`.
console.log('a route hands over to the stage and gets it back');
{
  const rn = fn('routeNext');
  check('the stage beat looks the map up rather than apologising',
        /STAGEMAP/.test(rn) && !/there is no room to play/.test(rn),
        'the viewer can play a stage now');
  check('and passes the map and the stage id to the card',
        /play: row && row\.map !== null \? row\.map : null/.test(rn));

  const sc = fn('showCard');
  check('a card with a map offers Play first',
        sc.indexOf('Play this stage') > 0
        && sc.indexOf('Play this stage') < sc.indexOf("go.textContent"),
        'it is the point of the card, so it leads');
  check('Play enters the stage carrying the route with it',
        /playStage\(beat\.play, null, \{ route: R, stage: beat\.stage \}\)/.test(sc));
  check('and the continue button becomes Skip when there is a stage to play',
        /beat\.play != null \? 'Skip it' : 'Continue'/.test(sc));

  const ps = fn('playStage');
  check('a route that sent us here is held, not dropped',
        /if \(opts\.route && R\) clearTimeout\(R\.timer\);\s*else leaveRoute\(\);/
          .test(ps),
        'but its chapter-card timer must still go');
  check('and the stage remembers it can go back',
        /route: opts\.route \? \{ stage: opts\.stage \} : null/.test(ps));

  const rtr = fn('returnToRoute');
  check('returning reads G.route before leaveStage clears G',
        rtr.indexOf('G && G.route') < rtr.indexOf('leaveStage()'));
  check('and rebuilds the route markup before the next beat',
        rtr.indexOf('routeViewport()') < rtr.indexOf('routeNext()'),
        'playing a stage replaced #detail, so #card no longer exists');
  check('startRoute uses the same markup helper',
        /routeViewport\(\);/.test(fn('startRoute')),
        'two copies of it would drift');
  check('the stage bar offers the way back only on a route',
        /if \(G\.route\) \{/.test(fn('buildStageBar'))
        && /back\.onclick = returnToRoute;/.test(fn('buildStageBar')));
  check('the stage-to-map table is built when a disc opens',
        /STAGEMAP = await TraptStage\.stageMapTable\(/.test(fn('load')));
}

console.log('modern mode fills the element');
const fo = fn('fitOutput');
check('only native is pillarboxed to 4:3',
      /let fx = 1, fy = 1;[\s\S]*?if \(V\.look\.native\) \{[\s\S]*?OUT_ASPECT/.test(fo),
      'modern renders at the element aspect and fills it');
// With the CRT on, the post pass draws into a target rather than the canvas.
// If it kept the letterbox, the black bars would be inside the tube and get
// curved, scanlined and vignetted along with the picture.
check('and the CRT takes the letterbox over when it is on',
      /V\.crtOn && V\.crt[\s\S]*?postMat\.uniforms\.fit\.value\.set\(1, 1\)[\s\S]*?crt\.crt\.uniforms\.fit\.value\.set\(fx, fy\)/
        .test(fo),
      'the bars belong outside the tube, not in it');
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


// The free camera's arithmetic is camctl.js, pure, so it is run rather than
// pattern matched.
console.log('the free camera flies where it is pointed');
{
  const C = require('./camctl.js');
  const r3 = (a) => a.map((n) => +n.toFixed(3) || 0);
  const o = C.create();
  Object.assign(o, { yaw: 0, pitch: 0, dist: 10, target: [0, 0, 0] });
  // Hold keys long enough for the easing to arrive, then read the velocity.
  const settle = (k) => {
    o.vel = [0, 0, 0];
    for (let i = 0; i < 400; i++) C.step(o, k, 0.05, false);
    return JSON.stringify(r3(o.vel));
  };

  // Facing down -z from +z: the axes have to agree with the orbit formula, or
  // W and D go somewhere other than where the camera is looking.
  check('the eye sits where the orbit puts it',
        JSON.stringify(r3(C.eye(o))) === '[0,0,10]');
  const ax = C.axes(o);
  check('forward is into the screen and right is to the right',
        JSON.stringify([r3(ax.fwd), r3(ax.right)]) === '[[0,0,-1],[1,0,0]]',
        JSON.stringify([r3(ax.fwd), r3(ax.right)]));
  check('and they stay unit as it turns',
        [0.3, 1.1, -2.0].every((y) => {
          const a = C.axes({ yaw: y, pitch: 0.4 });
          return Math.abs(Math.hypot.apply(null, a.fwd) - 1) < 1e-9
              && Math.abs(Math.hypot.apply(null, a.right) - 1) < 1e-9
              && Math.abs(Math.hypot.apply(null, a.screenUp) - 1) < 1e-9;
        }));

  // Nothing held must not drift the shot -- this runs every frame.
  check('no key held moves nothing', C.step(o, {}, 1, false) === false
        && JSON.stringify(r3(o.target)) === '[0,0,0]');

  check('W flies forward at a quarter of the distance per second',
        settle({ w: true }) === '[0,0,-2.5]', settle({ w: true }));
  check('it eases in rather than jumping to speed',
        (() => { o.vel = [0, 0, 0]; C.step(o, { w: true }, 0.05, false);
                 return o.vel[2] < 0 && o.vel[2] > -2.5; })());
  check('and eases out, coming to rest', (() => {
          for (let i = 0; i < 200; i++) C.step(o, {}, 0.05, false);
          return C.step(o, {}, 0.05, false) === false; })());
  const before = C.eye(o), t0 = o.target.slice();
  o.vel = [0, 0, -2.5]; C.step(o, { w: true }, 1, false);
  const after = C.eye(o);
  check('and the eye travels exactly with the target',
        JSON.stringify(r3([after[0] - before[0], after[1] - before[1],
                           after[2] - before[2]]))
        === JSON.stringify(r3([o.target[0] - t0[0], o.target[1] - t0[1],
                               o.target[2] - t0[2]])));
  check('D strafes right', settle({ d: true }) === '[2.5,0,0]');
  check('E rises', settle({ e: true }) === '[0,2.5,0]');
  check('Q sinks', settle({ q: true }) === '[0,-2.5,0]');
  check('A and D together hold still', settle({ a: true, d: true }) === '[0,0,0]');
  check('shift hurries by exactly three',
        settle({ w: true, boost: true }) === '[0,0,-7.5]');
  o.speed = 2;
  check('the wheel speed multiplies it', settle({ w: true }) === '[0,0,-5]');
  C.wheel(o, 1);
  check('and a wheel notch down slows it, in the fly camera', o.speed < 2 && o.dist === 10);
  o.speed = 1;

  // Speed follows the distance so the same keys suit a face and a room, but
  // it floors at 1 or a close-up would crawl, and caps at 60: the player runs
  // at 34 units a second (STAGE.md), and a room must not become a slingshot.
  o.dist = 0.05;
  check('it never crawls when zoomed right in', settle({ w: true }) === '[0,0,-0.25]');
  o.dist = 4000;
  check('and a huge room does not turn it into a slingshot',
        settle({ w: true }) === '[0,0,-60]');

  // Looking in the fly camera must not shift the eye: the head turns.
  Object.assign(o, { yaw: 0.3, pitch: 0.2, dist: 7, target: [1, 2, 3] });
  const stood = C.eye(o);
  C.look(o, 0.5, -0.3, false);
  check('a look turns without moving the eye',
        JSON.stringify(r3(C.eye(o))) === JSON.stringify(r3(stood)),
        JSON.stringify(r3(C.eye(o))) + ' vs ' + JSON.stringify(r3(stood)));
  check('and it really did turn', +o.yaw.toFixed(2) === 0.8 && +o.pitch.toFixed(2) === -0.1);
  C.look(o, 0, -99, false);
  check('pitch stops short of straight down', o.pitch === -1.4);
  o.invertY = true; C.look(o, 0, -0.2, false); o.invertY = false;
  check('invert Y turns the other way', +o.pitch.toFixed(2) === -1.2);
}

console.log('the orbit and ortho cameras keep the target');
{
  const C = require('./camctl.js');
  const r3 = (a) => a.map((n) => +n.toFixed(3) || 0);
  const o = C.create();
  C.setMode(o, 'orbit');
  Object.assign(o, { yaw: 0, pitch: 0, dist: 10, target: [1, 2, 3] });
  C.look(o, 0.5, 0.2, false);
  check('a drag swings the eye round the target',
        JSON.stringify(o.target) === '[1,2,3]' && +o.yaw.toFixed(2) === 0.5
        && Math.abs(Math.hypot(...C.eye(o).map((v, i) => v - o.target[i])) - 10) < 1e-9);
  C.fling(o, 0.1, 0, 0.05);
  const y0 = o.yaw;
  C.step(o, {}, 0.05, true);
  check('it does not coast while the button is down', o.yaw === y0);
  C.step(o, {}, 0.05, false);
  check('and coasts after release', o.yaw > y0);
  for (let i = 0; i < 200; i++) C.step(o, {}, 0.05, false);
  check('then settles', C.step(o, {}, 0.05, false) === false);
  C.wheel(o, -1);
  check('the wheel zooms in', o.dist < 10 && o.speed === 1);
  const d0 = o.dist;
  C.step(o, { w: true }, 0.1, false);
  check('W zooms in too', o.dist < d0);
  Object.assign(o, { yaw: 0, pitch: 0, dist: 10, target: [0, 0, 0] });
  C.pan(o, 0.1, 0);
  check('pan drags the target with the cursor', JSON.stringify(r3(o.target)) === '[-1,0,0]',
        JSON.stringify(r3(o.target)));
  o.autoRotate = true;
  check('auto-rotate keeps it moving', C.step(o, {}, 0.1, false) === true && o.yaw > 0);
  o.autoRotate = false;
  C.setMode(o, 'ortho');
  C.snap(o, 'top');
  check('the top view looks straight down',
        JSON.stringify(C.axes(o).fwd.map((n) => +n.toFixed(2) || 0)) === '[0,-1,0]');
  check('the ortho view is as tall as the perspective one at the target',
        Math.abs(C.orthoHalf({ dist: 10, fov: 90 }) - 10) < 1e-9);
  // Leaving the cutscene camera picks up its shot instead of jumping.
  const f = C.create();
  C.fromPose(f, [5, 6, 7], [0, 0, -2]);
  check('free cam starts where the scene camera was',
        JSON.stringify(r3(C.eye(f))) === '[5,6,7]'
        && JSON.stringify(r3(C.axes(f).fwd)) === '[0,0,-1]');
  const saved = C.save(f);
  const g = C.create();
  check('a saved view restores to the same eye',
        C.restore(g, JSON.parse(JSON.stringify(saved)))
        && JSON.stringify(r3(C.eye(g))) === '[5,6,7]');
  check('and a junk slot is refused', C.restore(g, { yaw: 1 }) === false);
  const h = C.create();
  Object.assign(h, { yaw: 0, pitch: 0, dist: 1000, target: [0, 0, -990] });
  C.aimAt(h, [0, 0, -5]);
  check('orbit takes the scene centre and keeps the eye',
        JSON.stringify(r3(C.eye(h))) === '[0,0,10]' && +h.dist.toFixed(3) === 15);
  C.setMode(h, 'ortho'); C.snap(h, 'top');
  const top = C.eye(h);
  C.setMode(h, 'noclip');
  check('leaving a top view tilts about the eye',
        JSON.stringify(r3(C.eye(h))) === JSON.stringify(r3(top)) && h.pitch === 1.4);
  C.setMode(h, 'orbit');
  C.fling(h, 0.1, 0, 0.0001);
  check('a bunched flick is capped', h.spin[0] === 3);
}

console.log('movement keys yield to typing and to the shortcuts');
{
  const mk = fn('movementKey'), ty = fn('typing');
  check('an input, textarea, select or contenteditable swallows the key',
        /typing\(e\)/.test(mk) && /INPUT/.test(ty) && /TEXTAREA/.test(ty)
        && /SELECT/.test(ty) && /isContentEditable/.test(ty)
        && /typing\(e\)/.test(fn('cameraKey')));
  check('and so does any of ctrl, meta or alt',
        /ctrlKey/.test(mk) && /metaKey/.test(mk) && /altKey/.test(mk));
  check('only wasdqe move', /'wasdqe'/.test(mk));
  check('a lost keyup cannot leave the camera flying',
        /addEventListener\('blur'/.test(script)
        && /V\.keys = Object\.create\(null\)/.test(script));
  // Stage mode drives its own follow camera, so `tick` has to return before
  // it flies -- otherwise the two fight for the frame, which is the bug that
  // stranded route mode once already.
  const tk = fn('tick');
  check('flying is skipped in stage mode, which drives its own camera',
        tk.indexOf('if (G) {') >= 0
        && tk.indexOf('if (G) {') < tk.indexOf('placeFreeCam(')
        && /if \(G\) \{[^}]*return;/s.test(tk));
  check('and skipped while the cutscene camera still has the shot',
        tk.indexOf('S.sceneCam') < tk.indexOf('placeFreeCam('));
  check('and moving switches off the cutscene camera like a drag does',
        fn('goFreeCam').includes('S.sceneCam = false'));
  // The reported problem: dragging swung the eye around the world, so the
  // world appeared to rotate instead of the head.  A plain drag has to turn
  // the camera in place; orbiting is still wanted for looking over a model,
  // so it keeps the right button and alt.
  const bo = fn('bindOrbit');
  check('a plain drag turns the camera, not the world',
        /TraptCamCtl\.look\(V\.orbit, -dx \* LOOK_X, dy \* LOOK_Y, drag\.orbit\)/.test(bo));
  check('orbit is still there on right-drag or alt-drag',
        /e\.button === 2 \|\| e\.altKey/.test(bo));
  check('and the right button does not raise a menu mid-turn',
        /contextmenu/.test(bo));
  // The card, the Look panel and the HUD are children of #view, so their
  // presses bubble to the camera.  Capturing the pointer for an ancestor
  // retargets the click the browser synthesises, so a card button never sees
  // its own click -- which left the route card completely undismissable.
  check('a press on the card, a panel or the hud is not a drag',
        /closest\('#card, #look, #camp, #hud'\)/.test(bo));
  check('and the guard runs before the pointer is captured',
        bo.indexOf('onUI(e)') < bo.indexOf('setPointerCapture'));
  check('double-clicking a button does not grab the pointer either',
        (() => {
          const i = bo.indexOf("addEventListener('dblclick'");
          const j = bo.indexOf('requestPointerLock', i);
          return i >= 0 && j > i && bo.slice(i, j).includes('onUI(e)');
        })());
  check('and the wheel leaves a panel alone',
        (() => {
          const i = bo.indexOf("addEventListener('wheel'");
          const j = bo.indexOf('preventDefault', i);
          return i >= 0 && j > i && bo.slice(i, j).includes('onUI(e)');
        })());
  check('pointer lock turns the same way, at the same sensitivity',
        /V\.locked[\s\S]*TraptCamCtl\.look\(V\.orbit, -e\.movementX \* LOOK_X/.test(bo)
        && bo.includes('requestPointerLock'));
}

// An address baked into the page is an address that is right for one disc.
// `region.js` is the only place either build's addresses belong; everything
// the page reads out of the ELF has to come through `DISC.region`.
console.log('the page hardcodes no ELF address');
const LOAD_VA = 0x00100000, END_VA = 0x00490000;
const literals = [...script.matchAll(/0x00[0-9A-Fa-f]{6}\b/g)]
  .map((m) => m[0])
  .filter((h) => {
    const v = parseInt(h, 16);
    return v >= LOAD_VA && v < END_VA;
  });
check('no ELF virtual address in the page script',
      literals.length === 0,
      'found: ' + [...new Set(literals)].join(', ')
      + ' -- read it off DISC.region instead (region.js)');

const reads = [...script.matchAll(/\bDISC\.elf(?:U8|U32|Str|Off)\(([^;\n]*)/g)]
  .map((m) => m[1])
  .filter((a) => !/DISC\.region\b/.test(a));
check('every DISC.elf* read is addressed through DISC.region',
      reads.length === 0, 'not: ' + reads.join(' | '));

console.log(failures ? '\n%d FAILED' : '\nall checks passed', failures);
process.exit(failures ? 1 : 0);
