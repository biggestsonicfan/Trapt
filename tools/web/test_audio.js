/**
 * Diff the browser ADX decoder against `tools/adx.py`, on real streams.
 *
 *   node tools/web/test_audio.js ["path/to/Trapt (USA).iso"]
 *
 * `adx.py` is itself validated sample-exact against ffmpeg over 19M samples,
 * so agreeing with it bit for bit is the bar.  Audio is the one format where
 * a small arithmetic slip is inaudible at first and then drifts: the predictor
 * has to stay in 12-bit fixed point until a single final shift, and a decoder
 * that splits that shift sounds fine for a second and wrong by the end of a
 * line.  Hashing whole streams catches that; spot-checking the first samples
 * would not.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const iso = require('./iso.js');
const discMod = require('./disc.js');
const adx = require('./adx.js');

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

// A short cue, the opening line, a knight with no character suffix, and one
// of the longer ones -- enough for the predictor to drift if it is going to.
const CLIPS = [
  'DATA/SOUND/VOICE/M0001_C01F_A.ADX',
  'DATA/SOUND/VOICE/M0011_C15M_A.ADX',
  'DATA/SOUND/VOICE/M0027.ADX',
  'DATA/SOUND/VOICE/M0040_C12F_A.ADX',
];

async function main() {
  if (!fs.existsSync(ISO)) {
    console.log('disc image not found: %s', ISO);
    process.exit(2);
  }
  const source = iso.fdSource(fs, ISO);
  const disc = await discMod.open(source);

  console.log('ADX headers and samples, against tools/adx.py');
  const PY = [
    'import adx, hashlib, json, scene, struct',
    'd = scene.Disc()',
    'out = {}',
    'for name in ' + JSON.stringify(CLIPS) + ':',
    '    blob = d.read(name)',
    '    h, chans = adx.decode(blob)',
    '    raw = b"".join(struct.pack("<%dh" % len(c), *c) for c in chans)',
    '    out[name] = {"channels": h.channels, "rate": h.rate,',
    '                 "samples": h.samples, "encoding": h.encoding,',
    '                 "version": h.version, "cutoff": h.cutoff,',
    '                 "n": [len(c) for c in chans],',
    '                 "sha": hashlib.sha256(raw).hexdigest()[:16],',
    '                 "first": list(chans[0][:8]),',
    '                 "last": list(chans[0][-8:])}',
    'print(json.dumps(out))',
  ].join('\n');
  const want = python(PY);

  let total = 0;
  for (const name of CLIPS) {
    const blob = await disc.read(name);
    const { header, channels } = adx.decode(blob);
    const w = want[name];
    const short = name.split('/').pop();

    check(short + ': header',
          [header.channels, header.rate, header.samples, header.encoding,
           header.version, header.cutoff],
          [w.channels, w.rate, w.samples, w.encoding, w.version, w.cutoff]);
    check(short + ': ' + header.samples + ' samples per channel',
          channels.map((c) => c.length), w.n);

    // Hash the same little-endian s16 bytes Python packed.
    const buf = Buffer.alloc(channels.reduce((n, c) => n + c.length * 2, 0));
    let o = 0;
    for (const c of channels)
      for (let i = 0; i < c.length; i++) { buf.writeInt16LE(c[i], o); o += 2; }
    check(short + ': every sample identical', sha(buf), w.sha);
    check(short + ': first and last eight',
          [[...channels[0].slice(0, 8)], [...channels[0].slice(-8)]],
          [w.first, w.last]);
    total += header.samples * header.channels;
  }
  console.log('  %s samples decoded and compared', total.toLocaleString());

  console.log('the predictor coefficients');
  const pyCo = python('import adx, json;'
    + ' print(json.dumps([adx.coefficients(500, 48000),'
    + ' adx.coefficients(0, 48000), adx.coefficients(1000, 44100)]))');
  check('match adx.py at three cutoffs',
        [adx.coefficients(500, 48000), adx.coefficients(0, 48000),
         adx.coefficients(1000, 44100)], pyCo);

  console.log('it refuses what it cannot decode');
  const bad = (bytes, label) => {
    let msg = '';
    try { adx.parseHeader(bytes); } catch (e) { msg = e.message; }
    return msg;
  };
  check('a non-ADX blob', bad(new Uint8Array(64)).startsWith('not an ADX'), true);
  const enc = await disc.read(CLIPS[0]);
  const tampered = enc.slice();
  tampered[0x13] = 8;                       // pretend it carries a key
  check('an encrypted stream', bad(tampered).startsWith('encrypted ADX'), true);

  // The BGM is the long-form case: several minutes, where a split shift
  // drifts.  Decode it here only -- Python would take minutes on 8M samples.
  const bgm = await disc.read('DATA/SOUND/BGM/E001.ADX');
  if (bgm) {
    const t0 = Date.now();
    const { header, channels } = adx.decode(bgm);
    const ms = Date.now() - t0;
    let peak = 0;
    for (const c of channels)
      for (let i = 0; i < c.length; i += 97) peak = Math.max(peak, Math.abs(c[i]));
    check('E001.ADX decodes in full',
          [header.channels, header.rate, channels[0].length === header.samples],
          [2, 48000, true]);
    check('and is not silence', peak > 1000, true);
    console.log('  %s stereo samples in %d ms (%s x realtime)',
                header.samples.toLocaleString(), ms,
                ((header.samples / header.rate) / (ms / 1000)).toFixed(0));
  }

  source.close();
  console.log(failures ? '\n%d FAILED' : '\nall checks passed', failures);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
