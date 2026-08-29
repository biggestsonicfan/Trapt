/**
 * Diff the browser decoders against the Python ones, on real disc assets.
 *
 *   node tools/web/test_assets.js ["path/to/Trapt (USA).iso"]
 *
 * `arc.js` and `tm2.js` have to agree with `tools/arc.py` and `tools/tm2.py`
 * exactly -- same members, same pixels -- because the eventual page renders
 * what they produce and there is no second chance to notice a swapped palette
 * band or a half-transparent texture.  So this decodes a real spread of the
 * disc's textures on both sides and compares the RGBA byte for byte.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const iso = require('./iso.js');
const discMod = require('./disc.js');
const arc = require('./arc.js');
const tm2 = require('./tm2.js');

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
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 16);

function python(code) {
  return JSON.parse(execFileSync('python', ['-c', code],
                                 { cwd: TOOLS, maxBuffer: 1 << 28 }));
}

// Archives chosen to span the formats: a cutscene bundle, a room, a character
// and a 2D screen, so indexed-4, indexed-8 and direct pictures all appear.
const ARCHIVES = [
  'DATA/RT/E001/RT_E001.ARC',
  'DATA/ROOM/RP03_ALL.ARC',
  'DATA/RT/COSTUME/RT_C01F_A_HL.ARC',
  'DATA/RT/E429_04/RT_E429_04.ARC',
];

async function main() {
  if (!fs.existsSync(ISO)) {
    console.log('disc image not found: %s', ISO);
    process.exit(2);
  }
  const source = iso.fdSource(fs, ISO);
  const disc = await discMod.open(source);

  console.log('RPS archives, against tools/arc.py');
  const pyArc = python(
    'import arc, json, scene; d = scene.Disc();'
    + ' names = ' + JSON.stringify(ARCHIVES) + ';'
    + ' print(json.dumps({n: [[e[0], e[1], e[2]] for e in arc.entries(d.read(n))]'
    + ' for n in names}))');

  const decoded = [];                   // [{archive, member, w, h, hash}]
  for (const name of ARCHIVES) {
    const blob = await disc.read(name);
    const ents = arc.entries(blob);
    check(name.split('/').pop() + ': member list matches',
          ents.map((e) => [e.name, e.offset, e.size]), pyArc[name]);

    for (const e of ents) {
      if (!e.name.toLowerCase().endsWith('.tm2')) continue;
      const pics = tm2.decode(blob.subarray(e.offset, e.offset + e.size));
      pics.forEach((p, i) => decoded.push({
        archive: name, member: e.name, index: i,
        w: p.width, h: p.height, hash: sha(p.rgba),
      }));
    }
  }
  console.log('  %d textures decoded from %d archives',
              decoded.length, ARCHIVES.length);

  console.log('TIM2 pixels, against tools/tm2.py');
  const want = python(
    'import arc, hashlib, json, scene, tm2; d = scene.Disc();'
    + ' out = [];'
    + ' names = ' + JSON.stringify(ARCHIVES) + ';'
    + '\nfor n in names:\n'
    + '    blob = d.read(n)\n'
    + '    for nm, off, sz in arc.entries(blob):\n'
    + '        if not nm.lower().endswith(".tm2"): continue\n'
    + '        for i, (w, h, px) in enumerate(tm2.decode(blob[off:off+sz])):\n'
    + '            out.append([n, nm, i, w, h,'
    + ' hashlib.sha256(px).hexdigest()[:16]])\n'
    + 'print(json.dumps(out))');

  check('same number of pictures', decoded.length, want.length);
  const bad = [];
  for (let i = 0; i < Math.min(decoded.length, want.length); i++) {
    const g = decoded[i], w = want[i];
    if (g.member !== w[1] || g.index !== w[2] || g.w !== w[3] || g.h !== w[4]
        || g.hash !== w[5])
      bad.push({ member: g.member, got: [g.w, g.h, g.hash], want: w.slice(3) });
  }
  check('every picture is byte-identical', bad.slice(0, 3), []);

  const sizes = [...new Set(decoded.map((d) => d.w + 'x' + d.h))];
  console.log('  sizes seen: %s', sizes.slice(0, 8).join(' '));

  console.log('the decoders refuse what they should');
  let e1 = '', e2 = '';
  try { arc.entries(new Uint8Array(64)); } catch (e) { e1 = e.message; }
  try { tm2.decode(new Uint8Array(64)); } catch (e) { e2 = e.message; }
  check('arc rejects non-RPS', e1.startsWith('not an RPS archive'), true);
  check('tm2 rejects non-TIM2', e2.startsWith('not a TIM2'), true);

  source.close();
  console.log(failures ? '\n%d FAILED' : '\nall checks passed', failures);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
