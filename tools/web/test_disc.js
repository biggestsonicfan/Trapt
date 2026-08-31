/**
 * Check the browser-side disc reader against the Python one, on the real ISO.
 *
 *   node tools/web/test_disc.js ["path/to/Trapt (USA).iso"]
 *   node tools/web/test_disc.js "path/to/Kagero II (Japan).iso"
 *
 * `iso.js` and `disc.js` are what the served page will use to read the
 * visitor's own disc, so they have to agree with `tools/afs.py` exactly --
 * same filename table, same AFS offsets, same bytes out.  This reads the ISO
 * through the same range-based interface a browser `File` gives, and diffs
 * the result against `python -c` over the extracted copy.
 *
 * Either disc.  The image says which one it is, and everything below --
 * volume id, extents, table size, where the story tables are, and which
 * region the Python side is told to read -- comes off `region.js` instead of
 * being written down twice.  Both are worth running: they are different bytes
 * through the same reader.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const vm = require('vm');

const iso = require('./iso.js');
const discMod = require('./disc.js');
const regionMod = require('./region.js');
const storyMod = require('./story.js');

const ISO = process.argv[2]
  || 'E:/Seagate/OpenSuseBack/Emulators/PS2EMU/Trapt (USA).iso';
const TOOLS = path.join(__dirname, '..');

// What each image is, independently of the reader under test.
const EXPECTED = {
  us: { elf: [856549, 3680816], gamedat: [285, 1753018368] },
  jp: { elf: [286, 3634736], gamedat: [2445, 1753718784] },
};

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log('  %s %s%s', ok ? 'ok  ' : 'FAIL', what,
              ok ? '' : '\n        got  ' + JSON.stringify(got) +
                        '\n        want ' + JSON.stringify(want));
}

/** Ground truth from the Python side, pointed at the same disc. */
let REGION = regionMod.US;
function python(code) {
  const pre = 'import region; region.use("' + REGION.code + '");';
  return JSON.parse(execFileSync('python', ['-c', pre + code],
                                 { cwd: TOOLS, maxBuffer: 1 << 28 }));
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
  const region = regionMod.detect(image.files);
  if (!region) {
    console.log('that image is neither disc');
    process.exit(2);
  }
  REGION = region;
  const want = EXPECTED[region.code];
  console.log('  %s -- %s', region.serial, region.title);
  check('volume id', image.volume.id, region.volume);
  check('system id', image.volume.system, 'PLAYSTATION');
  check('the ELF is there', image.files.has(region.elf), true);
  check('GAME.DAT is there', image.files.has('DATA/GAME.DAT'), true);
  check('GAME.DAT extent and size',
        [image.files.get('DATA/GAME.DAT').extent, image.files.get('DATA/GAME.DAT').size],
        want.gamedat);
  check('the ELF extent and size',
        [image.files.get(region.elf).extent, image.files.get(region.elf).size],
        want.elf);
  // Cross-checked against the independently extracted copy of the disc, not
  // against this reader's own output.  Both pressings carry the same tree.
  check('every file on the disc', [...image.files.keys()].sort(),
        ['ADXCACHE.DIR', 'DATA/GAME.DAT', 'MODULES/CRI_ADXI.IRX',
         'MODULES/IOPRP270.IMG', 'MODULES/LIBSD.IRX', 'MODULES/MCMAN.IRX',
         'MODULES/MCSERV.IRX', 'MODULES/PADMAN.IRX', 'MODULES/RSSD.IRX',
         'MODULES/SIO2MAN.IRX', 'MODULES/SSD.IRX', region.elf,
         'SYSTEM.CNF'].sort());

  console.log('the ELF filename table, against tools/afs.py');
  const disc = await discMod.open(source);
  check('the reader agrees which disc this is', disc.region.code, region.code);
  check(region.toc.n + ' records', disc.toc.size, region.toc.n);

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
  const A = region.order;
  check('cutscene 0 is e001', disc.elfStr(disc.elfU32(A.NAME_TABLE)), 'e001');
  check('cutscene 0x99 is e430_01',
        disc.elfStr(disc.elfU32(A.NAME_TABLE + 0x99 * 4)), 'e430_01');
  check('group 0 is 3 cutscenes', disc.elfU8(A.GROUP_TABLE), 3);
  check('chapter 1 has 2 stages', disc.elfU8(A.CH_STAGES), 2);
  // The point of reading the second disc at all: the same story, not merely
  // an image that opens.  story.js off this ELF against order.py off the same.
  const py = python('import json, order; s = order.Story();'
    + ' print(json.dumps({"names": s.names, "groups": s.groups,'
    + ' "routes": s.routes}))');
  const tables = storyMod.read(disc);
  check('the cutscene registry matches order.py', tables.names, py.names);
  check('the 38 groups match order.py', tables.groups, py.groups);
  check('the ending routes match order.py', tables.routes, py.routes);

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
    for (const f of ['region.js', 'iso.js', 'disc.js'])   // three <script> tags
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
  check('opens the disc through window.TraptDisc', viaBlob.iso.volume.id,
        region.volume);
  check('same filename table', viaBlob.toc.size, region.toc.n);
  const b1 = await viaBlob.read('DATA/RT/E001/RT_E001.ARC');
  check('same bytes as the fd path',
        crypto.createHash('sha256').update(b1).digest('hex').slice(0, 16),
        pyHashes['DATA/RT/E001/RT_E001.ARC'][1]);

  source.close();
  console.log(failures ? '\n%d FAILED' : '\nall checks passed', failures);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
