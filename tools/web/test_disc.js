/**
 * Check the browser-side disc reader against the Python one, on the real ISO.
 *
 *   node tools/web/test_disc.js ["path/to/Trapt (USA).iso"]
 *
 * `iso.js` and `disc.js` are what the served page will use to read the
 * visitor's own disc, so they have to agree with `tools/afs.py` exactly --
 * same 3773-entry filename table, same AFS offsets, same bytes out.  This
 * reads the ISO through the same range-based interface a browser `File`
 * gives, and diffs the result against `python -c` over the extracted copy.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const vm = require('vm');

const iso = require('./iso.js');
const discMod = require('./disc.js');

const ISO = process.argv[2]
  || 'E:/Seagate/OpenSuseBack/Emulators/PS2EMU/Trapt (USA).iso';
const TOOLS = path.join(__dirname, '..');

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log('  %s %s%s', ok ? 'ok  ' : 'FAIL', what,
              ok ? '' : '\n        got  ' + JSON.stringify(got) +
                        '\n        want ' + JSON.stringify(want));
}

/** Ground truth from the Python side. */
function python(code) {
  return JSON.parse(execFileSync('python', ['-c', code], { cwd: TOOLS, maxBuffer: 1 << 28 }));
}

async function main() {
  if (!fs.existsSync(ISO)) {
    console.log('disc image not found: %s\n(pass the path as an argument)', ISO);
    process.exit(2);
  }

  const source = iso.fdSource(fs, ISO);
  console.log('%s  (%s GB)', path.basename(ISO), (source.size / 1e9).toFixed(2));

  console.log('the ISO 9660 layer');
  const image = await iso.open(source);
  check('volume id', image.volume.id, 'TRAPT');
  check('system id', image.volume.system, 'PLAYSTATION');
  check('the ELF is there', image.files.has('SLUS_212.55'), true);
  check('GAME.DAT is there', image.files.has('DATA/GAME.DAT'), true);
  check('GAME.DAT extent and size',
        [image.files.get('DATA/GAME.DAT').extent, image.files.get('DATA/GAME.DAT').size],
        [285, 1753018368]);
  check('the ELF extent and size',
        [image.files.get('SLUS_212.55').extent, image.files.get('SLUS_212.55').size],
        [856549, 3680816]);
  // Cross-checked against the independently extracted copy of the disc, not
  // against this reader's own output.
  check('every file on the disc', [...image.files.keys()].sort(),
        ['ADXCACHE.DIR', 'DATA/GAME.DAT', 'MODULES/CRI_ADXI.IRX',
         'MODULES/IOPRP270.IMG', 'MODULES/LIBSD.IRX', 'MODULES/MCMAN.IRX',
         'MODULES/MCSERV.IRX', 'MODULES/PADMAN.IRX', 'MODULES/RSSD.IRX',
         'MODULES/SIO2MAN.IRX', 'MODULES/SSD.IRX', 'SLUS_212.55',
         'SYSTEM.CNF'].sort());

  console.log('the ELF filename table, against tools/afs.py');
  const disc = await discMod.open(source);
  check('3773 records', disc.toc.size, discMod.TOC_N);

  const pyToc = python(
    'import afs, json; t = afs.load_toc();'
    + ' print(json.dumps({str(k): list(v) for k, v in t.items()}))');
  const mismatched = [];
  for (const [id, rec] of disc.toc) {
    const want = pyToc[String(id)];
    if (!want || want[0] !== rec.name || want[1] !== rec.size)
      mismatched.push(id);
  }
  check('every name and size matches afs.load_toc()', mismatched.slice(0, 5), []);
  check('same number of ids', disc.toc.size, Object.keys(pyToc).length);

  console.log('the AFS index and the bytes it points at');
  check('e001 master script is findable',
        disc.has('DATA/RT/E001/RT_E001.ARC'), true);

  // Read four files spanning the disc and hash them against Python's copy.
  const samples = ['DATA/RT/E001/RT_E001.ARC', 'DATA/SOUND/VOICE/M0001_C01F_A.ADX',
                   'DATA/ROOM/RP03_ALL.ARC', 'DATA/RT/E429_04/RT_E429_04.ARC'];
  const pyHashes = python(
    'import afs, hashlib, json, scene;'
    + ' d = scene.Disc();'
    + ' names = ' + JSON.stringify(samples) + ';'
    + ' print(json.dumps({n: [len(d.read(n) or b""),'
    + ' hashlib.sha256(d.read(n) or b"").hexdigest()[:16]] for n in names}))');
  for (const name of samples) {
    const blob = await disc.read(name);
    const h = crypto.createHash('sha256').update(blob).digest('hex').slice(0, 16);
    check(name.split('/').slice(-1)[0] + ' matches byte for byte',
          [blob.length, h], pyHashes[name]);
  }

  console.log('the tables the story order needs live in the same ELF');
  check('cutscene 0 is e001', disc.elfStr(disc.elfU32(0x00386920)), 'e001');
  check('cutscene 0x99 is e430_01', disc.elfStr(disc.elfU32(0x00386920 + 0x99 * 4)),
        'e430_01');
  check('group 0 is 3 cutscenes', disc.elfU8(0x0045DB50), 3);
  check('chapter 1 has 2 stages', disc.elfU8(0x0042DD20), 2);

  console.log('a wrong disc is rejected, not half-read');
  const notAnIso = { size: 4096, async read(o, n) { return new Uint8Array(n); } };
  let threw = '';
  try { await discMod.open(notAnIso); } catch (e) { threw = e.message; }
  check('blank image refused',
        threw.startsWith('not an ISO 9660 image'), true);

  // `require` gives every file its own scope, so node cannot see a collision
  // between two files that a browser loads into one shared global scope.  It
  // missed exactly that: iso.js and disc.js both declared `u32` and `api` at
  // top level, so the second <script> died with a redeclaration SyntaxError
  // before it could set window.TraptDisc, and only the real page showed it.
  console.log('loaded the way a browser loads them: two scripts, one global scope');
  const sandbox = { console, Blob, atob, performance };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  let loadErr = '';
  try {
    for (const f of ['iso.js', 'disc.js'])            // two <script> tags
      vm.runInContext(fs.readFileSync(path.join(__dirname, f), 'utf8'),
                      sandbox, { filename: f });
  } catch (e) {
    loadErr = e.message;
  }
  check('both scripts load without a collision', loadErr, '');
  check('window.TraptIso is defined', typeof sandbox.window.TraptIso, 'object');
  check('window.TraptDisc is defined', typeof sandbox.window.TraptDisc, 'object');
  check('no require/module leaked into the page path',
        [typeof sandbox.require, typeof sandbox.module], ['undefined', 'undefined']);

  // And the browser's own read path: a Blob, sliced, exactly as <input type=file>
  // hands it over.  fs.openAsBlob does not read the file in.
  console.log('the browser read path, over a real Blob');
  const blob = await fs.openAsBlob(ISO);
  const viaBlob = await sandbox.window.TraptDisc.open(
    sandbox.window.TraptIso.blobSource(blob));
  check('opens the disc through window.TraptDisc', viaBlob.iso.volume.id, 'TRAPT');
  check('same filename table', viaBlob.toc.size, discMod.TOC_N);
  const b1 = await viaBlob.read('DATA/RT/E001/RT_E001.ARC');
  check('same bytes as the fd path',
        crypto.createHash('sha256').update(b1).digest('hex').slice(0, 16),
        pyHashes['DATA/RT/E001/RT_E001.ARC'][1]);

  source.close();
  console.log(failures ? '\n%d FAILED' : '\nall checks passed', failures);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
