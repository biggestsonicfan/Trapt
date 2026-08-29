/**
 * Run every suite, skipping the ones that need the disc when it is absent.
 *
 *   node tools/web/test_all.js                    # everything available
 *   node tools/web/test_all.js --no-disc          # only what CI can run
 *   node tools/web/test_all.js "path/to/Trapt (USA).iso"
 *
 * Nothing in this repository can be *built* without the disc, and most of the
 * tests are parity diffs against the Python over real game data, so most of
 * them cannot run in CI either.  Two things still can, and they are not
 * nothing: that every browser module loads the way a browser loads it, and
 * that the GS shaders `gs.js` carries are still byte-identical to the ones in
 * `player.html`.  Those are exactly the failures that have shipped before.
 *
 * A suite that needs the disc exits 2 when it cannot find one; that is
 * reported as a skip, not a failure.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const HERE = __dirname;
const args = process.argv.slice(2);
const noDisc = args.includes('--no-disc');
const isoArg = args.find((a) => !a.startsWith('--'));

const SUITES = [
  { file: 'test_modules.js', disc: false },
  { file: 'test_page.js', disc: false },
  { file: 'test_shader.js', disc: false },
  { file: 'test_disc.js', disc: true },
  { file: 'test_assets.js', disc: true },
  { file: 'test_audio.js', disc: true },
  { file: 'test_route.js', disc: true },
  { file: path.join('..', 'test_order.js'), disc: true },
];

let failed = 0, ran = 0, skipped = 0;
const rows = [];

for (const suite of SUITES) {
  const name = path.basename(suite.file);
  if (suite.disc && noDisc) {
    rows.push(['skip', name, 'needs the disc']);
    skipped++;
    continue;
  }
  const argv = [path.join(HERE, suite.file)];
  if (suite.disc && isoArg) argv.push(isoArg);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, argv, { cwd: HERE, encoding: 'utf8' });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const out = (r.stdout || '') + (r.stderr || '');
  const passed = (out.match(/^ {2}ok /gm) || []).length;

  if (r.status === 2) {
    rows.push(['skip', name, 'no disc image']);
    skipped++;
  } else if (r.status === 0) {
    rows.push(['ok', name, passed + ' checks, ' + secs + 's']);
    ran += passed;
  } else {
    rows.push(['FAIL', name, 'exit ' + r.status]);
    failed++;
    process.stdout.write(out.split('\n').filter((l) => /FAIL|Error|error/.test(l))
      .slice(0, 12).map((l) => '        ' + l).join('\n') + '\n');
  }
}

for (const [state, name, note] of rows)
  console.log('%s %s %s', state === 'ok' ? ' ok  ' : state === 'skip' ? ' --  ' : 'FAIL ',
              name.padEnd(18), note);
console.log('\n%d checks passed, %d suites skipped, %d suites failed',
            ran, skipped, failed);
process.exit(failed ? 1 : 0);
