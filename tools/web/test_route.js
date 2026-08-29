/**
 * Check the browser's story tables and route walk against `tools/order.py`,
 * and the chapter cards against the disc.
 *
 *   node tools/web/test_route.js ["path/to/Trapt (USA).iso"]
 *
 * `story.js` reads the same four tables `order.py` does, out of the ELF the
 * page already has open, so the two must agree exactly -- otherwise the route
 * the page auto-plays is not the route the game plays.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const iso = require('./iso.js');
const discMod = require('./disc.js');
const story = require('./story.js');
const cards = require('./cards.js');
const catalog = require('./catalog.js');

const ISO = process.argv[2]
  || 'E:/Seagate/OpenSuseBack/Emulators/PS2EMU/Trapt (USA).iso';
const TOOLS = path.join(__dirname, '..');

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log('  %s %s%s', ok ? 'ok  ' : 'FAIL', what,
              ok ? '' : '\n        got  ' + JSON.stringify(got).slice(0, 300) +
                        '\n        want ' + JSON.stringify(want).slice(0, 300));
}
const python = (args) =>
  JSON.parse(execFileSync('python', [path.join(TOOLS, 'order.py'), args],
                          { cwd: TOOLS, maxBuffer: 1 << 26 }).toString());

async function main() {
  if (!fs.existsSync(ISO)) {
    console.log('disc image not found: %s', ISO);
    process.exit(2);
  }
  const source = iso.fdSource(fs, ISO);
  const disc = await discMod.open(source);
  const t = story.read(disc);
  const py = python('--tables');

  console.log('the story tables, against order.py --tables');
  check('154 cutscene names', t.names, py.names);
  check('38 groups', t.groups, py.groups);
  check('15 chapters: stages and their groups',
        t.chapters.map((c) => ({ index: c.index, open: c.open, stages: c.stages })),
        py.chapters);
  check('the ending route table', t.routes, py.routes);
  check('the story flag each chapter loses', t.chapters.map((c) => c.flag),
        py.chapterFlags);
  check('30 ending flows, same reachable steps',
        t.flows.map((f) => f.reachable), py.flows.map((f) => f.reachable));
  check('and the same steps in them',
        t.flows.map((f) => f.steps.map((s) => [s.kind, s.id, s.stage, s.branch])),
        py.flows.map((f) => f.steps.map((s) => [s.kind, s.id, s.stage, s.branch])));

  console.log('what no table plays');
  const ref = story.referenced(t);
  const unref = t.names.filter((n, i) => !ref.has(i));
  const pyUnref = py.names.filter((n, i) => {
    const ids = new Set();
    for (const g of py.groups) for (const x of g) ids.add(x);
    for (const f of py.flows)
      for (const k of f.reachable)
        if (f.steps[k].kind === 'cutscene') ids.add(f.steps[k].id);
    return !ids.has(i);
  });
  check('16 unreferenced cutscenes, same list', unref, pyUnref);

  console.log('the route walk');
  const full = story.route(t, {});
  const cuts = full.filter((b) => b.kind === 'cutscene');
  const cardBeats = full.filter((b) => b.kind === 'card');
  const stages = full.filter((b) => b.kind === 'stage');
  check('the opening is first', cuts.slice(0, 3).map((b) => b.name),
        ['e001', 'e002', 'e003']);
  check('a card for the opening, every chapter and the finale',
        cardBeats.length, 1 + story.N_CHAPTERS + 1);
  check('26 playable stages', stages.length, 26);
  check('it ends on the flag-1-clear finale', cuts.slice(-2).map((b) => b.name),
        ['e129', 'e130']);
  check('no cutscene appears twice',
        cuts.length - new Set(cuts.map((b) => b.name)).size, 0);
  // The playlist order.py produces walks the same main line, so the chapter
  // half of the route must be a prefix-consistent subsequence of it.
  const pl = execFileSync('python', [path.join(TOOLS, 'order.py'), '--playlist'],
                          { cwd: TOOLS, maxBuffer: 1 << 26 })
                .toString().split(String.fromCharCode(10))
                .map((x) => x.trim()).filter(Boolean);
  const mainLine = cuts.map((b) => b.name);
  let i = 0, drift = null;
  for (const n of mainLine) {
    const at = pl.indexOf(n, i);
    if (at < 0) { drift = n + ' is not in order.py --playlist'; break; }
    if (at < i) { drift = n + ' is out of order'; break; }
    i = at;
  }
  check('every beat is in order.py order', drift, null);

  console.log('routes that stop early, and endings');
  const short = story.route(t, { chapters: 3, ending: t.routes[2][0] });
  check('three chapters then an ending flow',
        short.filter((b) => b.kind === 'card').map((b) => b.title),
        ['Trapt', 'Chapter 1', 'Chapter 2', 'Chapter 3', 'Ending']);
  check('its last cutscenes come from the flow',
        short.filter((b) => b.kind === 'cutscene').slice(-1)[0].note
          .startsWith('ending flow'), true);
  const filtered = story.route(t, { have: new Set(['e001', 'e004']) });
  check('a disc missing most cutscenes yields only what it has',
        filtered.filter((b) => b.kind === 'cutscene').map((b) => b.name),
        ['e001', 'e004']);

  console.log('the chapter cards');
  const have = await cards.available(disc, t);
  check('all 15 chapters have a card on the disc', have.length, 15);
  check('chapter 12 is SLD12', t.chapters[11].card,
        'DATA/TWO_D/SLD/SLD12.ARC');
  const pic = await cards.load(disc, t.chapters[11].card);
  check('and it decodes to a 512x256 picture',
        pic && [pic.width, pic.height], [512, 256]);
  const again = await cards.load(disc, t.chapters[11].card);
  check('a second read is served from cache', again === pic, true);
  let lit = 0;
  for (let i = 3; i < pic.rgba.length; i += 4) if (pic.rgba[i] > 8) lit++;
  check('the card is not blank', lit > pic.width * pic.height * 0.5, true);

  console.log('the catalogue, against scene.py');
  const SAMPLE = ['e001', 'e009', 'e133', 'e326', 'e401_01', 'e429_04'];
  const PY = [
    'import json, scene',
    'd = scene.Disc()',
    'out = {}',
    'for n in ' + JSON.stringify(SAMPLE) + ':',
    '    s = scene.load(n, d)',
    '    first = s.subtitles[0] if s.subtitles else None',
    '    out[n] = {"room": s.room, "duration": s.duration,',
    '              "cues": len(s.subtitles),',
    '              "speakers": list(dict.fromkeys(x.speaker for x in s.subtitles',
    '                                             if x.speaker)),',
    '              "opening": " ".join(first.lines) if first else "",',
    '              "openingFrame": first.frame if first else s.duration // 2,',
    '              "entities": len(s.entities)}',
    'print(json.dumps(out))',
  ].join(String.fromCharCode(10));
  const wantCat = JSON.parse(
    execFileSync('python', ['-c', PY], { cwd: TOOLS, maxBuffer: 1 << 26 }).toString());

  let read = 0;
  const realRead = disc.iso.source.read.bind(disc.iso.source);
  disc.iso.source.read = async (o, n) => { read += n; return realRead(o, n); };
  for (const n of SAMPLE) {
    const e = await catalog.describe(disc, n);
    const w = wantCat[n];
    check(n + ': room, length, cues and cast',
          [e.room, e.duration, e.cues, e.speakers], [w.room, w.duration, w.cues, w.speakers]);
    check(n + ': the opening line and its frame',
          [e.opening, e.openingFrame], [w.opening, w.openingFrame]);
    check(n + ': entity count', e.entities, w.entities);
  }
  disc.iso.source.read = realRead;
  // The whole point of the ranged read: a card costs kilobytes, not megabytes.
  const bundles = SAMPLE.reduce(
    (n, x) => n + disc.sizeOf('DATA/RT/' + x.toUpperCase() + '/RT_' + x.toUpperCase() + '.ARC'), 0);
  check('it read a fraction of the bundles it described', read < bundles / 20, true,
        'read ' + (read / 1024).toFixed(0) + ' KB of ' + (bundles / 1e6).toFixed(1) + ' MB');
  console.log('        %d KB read to describe %s MB of bundles',
              Math.round(read / 1024), (bundles / 1e6).toFixed(1));

  source.close();
  console.log(failures ? '\n%d FAILED' : '\nall checks passed', failures);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
