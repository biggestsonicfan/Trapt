/**
 * Headless check of the player's playlist and of story mode.
 *
 *   node test_order.js
 *
 * The browser cannot be driven from a session, so this does what
 * `test_player.js` does for the maths: it lifts blocks verbatim out of
 * `player.html` and runs them outside a page.
 *
 * The PLAYLIST block gets a stub DOM and the test asserts on where it would
 * have navigated.  The TRAPT STORY block is pure, so it runs against the real
 * tables (`python order.py --tables`) and gets walked end to end; its four
 * branch rules are diffed against `python order.py --rules`, so the ELF's
 * logic cannot drift between its Python and its JavaScript transcription.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

// `.gitattributes` says `* text=auto`, so a checkout on Windows hands
// this file back with CRLF endings while every marker below is written
// with LF.  Without normalising, the slices come back empty and the
// suite does not fail -- it finds nothing to check and passes, or dies
// on the first lookup.  Normalise once, here.
const html = fs.readFileSync(path.join(__dirname, 'player.html'), 'utf8')
  .replace(/\r\n/g, '\n');
const start = html.indexOf('// ===8<=== PLAYLIST ===8<===');
const end = html.indexOf('// ===8<=== END PLAYLIST ===8<===');
if (start < 0 || end < 0) throw new Error('PLAYLIST markers not found in player.html');
const src = html.slice(start, end) +
  // same script scope, so this can close over the block's own bindings
  '\nwindow.__t = { advance, setAuto, ORDER, AT, storyGo, storyMode,' +
  ' get storyNext() { return storyNext; },' +
  ' get auto() { return auto; }, get playing() { return playing; } };\n';

const sStart = html.indexOf('// ===8<=== TRAPT STORY ===8<===');
const sEnd = html.indexOf('// ===8<=== END TRAPT STORY ===8<===');
if (sStart < 0 || sEnd < 0) throw new Error('TRAPT STORY markers not found');
const STORY_SRC = html.slice(sStart, sEnd);

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log('  %s %s%s', ok ? 'ok  ' : 'FAIL', what,
              ok ? '' : '   got ' + JSON.stringify(got) +
                        ', want ' + JSON.stringify(want));
}

function el() {
  const e = { hidden: true, disabled: false, textContent: '', innerHTML: '',
              style: {}, onclick: null, kids: [] };
  e.classList = { on: false, toggle(_, v) { this.on = v; },
                  add() { this.on = true; }, remove() { this.on = false; },
                  contains() { return this.on; } };
  e.appendChild = (k) => { e.kids.push(k); return k; };
  e.querySelector = (sel) => (e.parts ? e.parts[sel.replace(/[^a-z]/g, '')] : null);
  return e;
}

/** `storyShow` builds each option as `<button><b>label</b><i>detail</i></button>`. */
function optionEl() {
  const b = el();
  b.parts = { b: el(), i: el() };
  return b;
}

/** Run the block as if the page were `name`, with `order` in `order.js`. */
function run(name, order, search, story) {
  const els = { prevBtn: el(), nextBtn: el(), autoBtn: el(), pos: el(),
                hint: el(), story: el(), storyTitle: el(), storyText: el(),
                storyOpts: el(), storyHud: el() };
  els.hint.textContent = 'drag to orbit';
  const store = {};
  const win = {};
  if (order) win.TRAPT_ORDER = order;
  if (story) win.TRAPT_STORY = story;
  const box = {
    window: win,
    document: { getElementById: (id) => els[id],
                createElement: () => optionEl() },
    location: { search: search || '', href: null },
    sessionStorage: { getItem: (k) => (k in store ? store[k] : null),
                      setItem: (k, v) => { store[k] = String(v); } },
    URLSearchParams: URLSearchParams,
    addEventListener: () => {},
    console,
    S: { name: name },
    playing: false,
    playBtn: el(),
  };
  box.globalThis = box;
  vm.createContext(box);
  if (story)                       // the page loads both blocks; so does this
    vm.runInContext(STORY_SRC, box, { filename: 'player.html:STORY' });
  vm.runInContext(src, box, { filename: 'player.html:PLAYLIST' });
  return { t: box.window.__t, els: els, loc: box.location, store: store,
           playBtn: box.playBtn,
           opts: () => els.storyOpts.kids.map((k) => k.parts.b.textContent) };
}

const ORDER = ['e001', 'e002', 'e003'];

console.log('a page in the middle of the playlist');
let r = run('e002', ORDER);
check('index found', r.t.AT, 1);
check('prev shown', r.els.prevBtn.hidden, false);
check('next shown', r.els.nextBtn.hidden, false);
check('prev enabled', r.els.prevBtn.disabled, false);
check('position label', r.els.pos.innerHTML,
      '<a href="../index.html">all</a> &middot; 2 / 3');
check('auto off by default', r.t.auto, false);
r.t.advance(+1);
check('next navigates forward', r.loc.href, '../e003/index.html');
r = run('e002', ORDER);
r.t.advance(-1);
check('prev navigates back', r.loc.href, '../e001/index.html');

console.log('the first and last entries');
r = run('e001', ORDER);
check('prev disabled at the head', r.els.prevBtn.disabled, true);
check('next enabled at the head', r.els.nextBtn.disabled, false);
r = run('e003', ORDER);
check('next disabled at the tail', r.els.nextBtn.disabled, true);

console.log('Auto, arriving from the gallery with ?auto=1');
r = run('e001', ORDER, '?auto=1');
check('auto on', r.t.auto, true);
check('auto starts playing', r.t.playing, true);
check('play button relabelled', r.playBtn.textContent, 'Pause');
check('auto remembered for the next page', r.store.traptAuto, '1');
r.t.advance(+1);
check('auto carries the flag across', r.loc.href, '../e002/index.html?auto=1');

console.log('Auto stops at the end of the story');
r = run('e003', ORDER, '?auto=1');
r.t.advance(+1);
check('no navigation past the tail', r.loc.href, null);
check('auto switched itself off', r.t.auto, false);
check('and unset for the next page', r.store.traptAuto, '0');

console.log('Auto survives a plain navigation through sessionStorage');
r = run('e002', ORDER);
r.t.setAuto(true);
check('stored', r.store.traptAuto, '1');
r.t.advance(+1);
check('flag added to the url', r.loc.href, '../e003/index.html?auto=1');

console.log('a standalone export.py bundle, with no order.js');
r = run('e001', null);
check('no playlist', r.t.ORDER, null);
check('buttons stay hidden', r.els.nextBtn.hidden, true);
check('advance is a no-op', r.t.advance(+1), false);
check('nothing navigated', r.loc.href, null);

// ---------------------------------------------------------------- story mode

const sandbox = { console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(STORY_SRC, sandbox, { filename: 'player.html:STORY' });

const py = (arg) =>
  JSON.parse(execFileSync('python', [path.join(__dirname, 'order.py'), arg],
                          { cwd: __dirname, maxBuffer: 1 << 26 }).toString());
const TABLES = py('--tables');
const RULES = py('--rules');
const ST = sandbox.TraptStory(TABLES);

console.log('the four branch rules, against order.py over every chapter and flag state');
let bad = [];
for (const r of RULES) {
  const n = TABLES.chapters[r.c].stages.length;
  const got = { first: ST.firstStage(r.c, r.f), chapter: ST.nextChapter(r.c, r.f),
                finale: ST.finaleGroup(r.f),
                stages: [0, 1, 2].map((s) => ST.nextStage(r.c, s, r.f, n)) };
  if (JSON.stringify(got) !== JSON.stringify(
        { first: r.first, chapter: r.chapter, finale: r.finale, stages: r.stages }))
    bad.push('c' + r.c + ' f' + r.f);
}
check(RULES.length + ' (chapter, flags) rows agree', bad, []);

/**
 * Walk the machine from `st`, answering every prompt with `pick(event, nth)`.
 * `pick` returns either a substring of the option it wants or a predicate on
 * the label; anything that does not match exactly one option is an error, so
 * a renamed option fails the test instead of silently picking the wrong path.
 */
function walk(st, pick, story) {
  const scenes = [], prompts = [], chose = [], flags = [];
  for (let i = 0; i < 400; i++) {
    const e = (story || ST).event(st);
    if (e.kind === 'scene') { scenes.push(e.name); st = e.next; continue; }
    if (e.kind === 'end') return { scenes, prompts, chose, flags, end: e.title };
    prompts.push(e.title);
    flags.push(e.at && e.at.f);
    const nth = prompts.filter((t) => t === e.title).length;
    const want = pick(e, nth);
    const hit = e.options.filter((o) => typeof want === 'function'
      ? want(o.label) : o.label.indexOf(want) >= 0);
    if (hit.length !== 1)
      throw new Error(e.title + ': ' + hit.length + ' of ' +
        JSON.stringify(e.options.map((o) => o.label)) + ' match ' + want);
    chose.push(hit[0].label);
    st = hit[0].next;
  }
  throw new Error('story walk did not terminate');
}

const playOn = (l) => l.indexOf('Play ') === 0 && l.indexOf(' set') < 0;

/** Play every chapter, clear every stage, never carry a story flag. */
const straight = (e) =>
  (e.title.indexOf('Chapter ') === 0 ? playOn : 'clears it');

console.log('the straight run: every chapter, every stage cleared');
let w = walk(ST.start(), straight);
check('opens on the attract cutscenes', w.scenes.slice(0, 3), ['e001', 'e002', 'e003']);
check('chapter 1 follows', w.scenes.slice(3, 8),
      ['e004', 'e006', 'e007', 'e008', 'e009']);
check('it reaches an ending', w.end, 'The end');
check('closing on the flag-1-clear finale', w.scenes.slice(-2), ['e129', 'e130']);
check('every name it played is a real cutscene',
      w.scenes.filter((n) => TABLES.names.indexOf(n) < 0), []);
check('no cutscene played twice', w.scenes.length - new Set(w.scenes).size, 0);
check('chapter 15 is never reached', w.prompts.indexOf('Chapter 15'), -1);
check('it played 14 chapters',
      w.prompts.filter((t) => t.indexOf('Chapter ') === 0).length, 14);

console.log('carrying story flag 1 into chapter 14, then flag 2 into chapter 15');
w = walk(ST.start(), (e) => {
  if (e.title === 'Chapter 14') return 'flag 1 set';
  if (e.title === 'Chapter 15') return 'flag 2 set';
  return straight(e);
});
check('chapter 15 is reached', w.prompts.indexOf('Chapter 15') > 0, true);
check('chapter 14 skips its third stage',
      ['16', '17', '18'].map((n) => w.prompts.indexOf('Stage ' + n) >= 0),
      [true, true, false]);
check('and the run closes on e230 e231', w.scenes.slice(-2), ['e230', 'e231']);

console.log('flag 2 left clear at chapter 15 gives the other finale');
w = walk(ST.start(), (e) =>
  (e.title === 'Chapter 14' ? 'flag 1 set' : straight(e)));
check('closes on e322..e326', w.scenes.slice(-5),
      ['e322', 'e323', 'e324', 'e325', 'e326']);

console.log('chapter 10: flag 0 picks the stage, and stops the machine');
w = walk(ST.start(), (e) => {
  if (e.title === 'Chapter 10') return 'flag 0 set';
  if (e.title === 'The chapter machine stops here') return 'Stop';
  return straight(e);
});
check('it plays stage 11, not stage 10',
      w.prompts.filter((t) => t === 'Stage 11' || t === 'Stage 10'), ['Stage 11']);
check('chapter 11 is never offered', w.prompts.indexOf('Chapter 11'), -1);
check('the machine stops instead of reaching a finale', w.end, 'Stopped');
w = walk(ST.start(), (e) =>
  (e.title === 'Chapter 10' ? 'flag 0 clear' : straight(e)));
check('with the flag clear it plays stage 10 and carries on',
      [w.prompts.filter((t) => t === 'Stage 10' || t === 'Stage 11'),
       w.prompts.indexOf('Chapter 11') > 0], [['Stage 10'], true]);

console.log('an ending flow, taken from the chapter 1 screen');
w = walk(ST.start(), (e) => {
  if (e.title === 'Chapter 1') return 'route 0';
  if (e.title === 'The ending branches') return 'flag 0 clear';
  return 'clears it';
});
check('it plays flow 00 in order', w.scenes.slice(3),
      ['e401_01', 'e401_02', 'e401_03']);
check('and it ends', w.end, 'The end');
check('the stage in the flow was offered', w.prompts.indexOf('Stage 1A') >= 0, true);
w = walk(ST.start(), (e) => {
  if (e.title === 'Chapter 1') return 'route 0';
  if (e.title === 'The ending branches') return 'flag 0 set';
  return 'clears it';
});
check('the other side of the branch plays e401_04', w.scenes.slice(-1), ['e401_04']);
w = walk(ST.start(), (e) => {
  if (e.title === 'Chapter 1') return 'route 1';
  return 'clears it';
});
check('route 1 is a different flow', w.scenes.slice(3), ['e402_01', 'e402_02']);

console.log('a failed stage clears the chapter flag and goes back to the screen');
w = walk(ST.start(), (e, nth) => {
  if (e.title === 'Stage 00') return nth === 1 ? 'fails' : 'clears it';
  return straight(e);
});
check('chapter 1 is offered again',
      w.prompts.filter((t) => t === 'Chapter 1').length, 2);
check('and the run still finishes', w.end, 'The end');
w = walk(ST.start(), (e, nth) => {
  if (e.title === 'Chapter 10') return nth === 1 ? 'flag 0 set' : 'flag 0 clear';
  if (e.title === 'Stage 11') return 'fails';
  return straight(e);
});
const at11 = w.prompts.indexOf('Stage 11');
check('chapter 10 ran its stage with story flag 0 set', w.flags[at11], 1);
check('and failing it cleared the flag again',
      w.flags[w.prompts.lastIndexOf('Chapter 10')], 0);
check('so the retry plays the other stage',
      w.prompts.filter((t) => t === 'Stage 11' || t === 'Stage 10'),
      ['Stage 11', 'Stage 10']);
check('and the run carries on to an ending', w.end, 'The end');

console.log('a site built with only some cutscenes skips what it does not have');
const partial = sandbox.TraptStory(Object.assign({}, TABLES, { have: ['e002', 'e004'] }));
check('the first scene it offers is one that exists',
      partial.event(partial.start()).name, 'e002');
const pw = walk(partial.start(), straight, partial);
check('and it still reaches an ending',
      [pw.end, pw.scenes], ['The end', ['e002', 'e004']]);

console.log('the page driver: story mode on a stub DOM, with the real tables');
r = run('e004', ['e001', 'e004'], '?story=new', TABLES);
check('story mode is on', r.t.storyMode, true);
check('the wrong page sends itself to the first scene', r.loc.href,
      '../e001/index.html?story=1');
check('and leaves the state for it to pick up',
      JSON.parse(r.store.traptStory).p, 'g');
check('the playlist buttons stand down', r.els.nextBtn.hidden, true);

r = run('e001', ['e001'], '?story=new', TABLES);
check('the right page does not navigate', r.loc.href, null);
check('it starts playing', r.t.playing, true);
check('and knows where to go when the cutscene ends',
      !!r.t.storyNext, true);
check('no prompt is up while a cutscene plays', r.els.story.classList.on, false);
check('the position readout says story', r.els.pos.innerHTML,
      '<a href="../index.html">all</a> &middot; story');

r = run('e003', ['e003'], '?story=1', TABLES);
r.t.storyGo({ p: 'screen', c: 0, f: 0 });
check('a prompt puts the overlay up', r.els.story.classList.on, true);
check('with the chapter as its title', r.els.storyTitle.textContent, 'Chapter 1');
check('and the four ways out of the chapter screen', r.opts(),
      ['Play Chapter 1', 'End the story here — route 0 (flow 00)',
       'End the story here — route 1 (flow 01)', 'Stop']);
check('the HUD offers a way out',
      r.els.storyHud.innerHTML.indexOf('leave story mode') > 0, true);

r = run('e003', ['e003'], '?story=1', TABLES);
r.t.storyGo({ p: 'screen', c: 9, f: 0 });
check('chapter 10 offers its story flag both ways', r.opts().slice(0, 2),
      ['Play Chapter 10 — story flag 0 set',
       'Play Chapter 10 — story flag 0 clear']);

r = run('e001', ['e001'], '?story=1&auto=1', TABLES);
check('story mode wins over Auto when both are asked for', r.t.auto, false);

console.log(failures ? '\n%d FAILED' : '\nall checks passed', failures);
process.exit(failures ? 1 : 0);
