/**
 * `pad.js` against `tools/pcsx2pad.py`, and against a real `PCSX2.ini`.
 *
 *   node tools/web/test_pad.js [path/to/PCSX2.ini]
 *
 * This needs no game data, so it is part of the half of the suite CI can run.
 * What it is guarding is small but easy to get wrong in a way nobody notices
 * until a controller is in someone's hands: PCSX2's binding names are SDL's,
 * the browser's Gamepad API "standard mapping" is the same layout, and the
 * whole translation is two lookup tables that have to line up exactly.  A
 * transposed pair there swaps Circle and Cross, which is precisely the bug
 * that would be blamed on the game.
 *
 * The synthetic ini covers every source form the parser claims to handle --
 * both axis signs, an analogue trigger, a chord, a keyboard binding, a
 * device that is not SDL, and two kinds of garbage.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const pad = require('./pad.js');

const TOOLS = path.join(__dirname, '..');
const iniArg = process.argv[2];

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log('  %s %s%s', ok ? 'ok  ' : 'FAIL', what,
              ok ? '' : '\n        got  ' + JSON.stringify(got) +
                        '\n        want ' + JSON.stringify(want));
}

/** Run a snippet in `tools/`; `input` is handed to it verbatim on stdin. */
function python(code, input) {
  return JSON.parse(execFileSync('python', ['-c', code],
                                 { cwd: TOOLS, maxBuffer: 1 << 26,
                                   encoding: 'utf8',
                                   input: input === undefined ? '' : input }));
}

const SYNTHETIC = [
  '; a comment, and a section that is not the pad',
  '[Hotkeys]',
  'Screenshot = Keyboard/F8',
  '',
  '[Pad1]',
  'Cross = SDL-1/FaceSouth',
  'Circle = SDL-1/FaceEast',
  'Square = SDL-1/FaceWest',
  'Triangle = SDL-1/FaceNorth',
  'Up = SDL-1/DPadUp',
  'L1 = SDL-0/LeftShoulder',
  'L2 = SDL-1/+LeftTrigger',
  'R2 = SDL-1/+RightTrigger',
  'LUp = SDL-1/-LeftY',
  'LDown = SDL-1/+LeftY',
  'LLeft = SDL-1/-LeftX',
  'LRight = SDL-1/+LeftX',
  'RRight = XInput-0/+RightX',
  'Start = Keyboard/Alt & Keyboard/Return',
  'Select = Keyboard/Backspace',
  'L3 = Keyboard/Keypad7',
  'R3 = Keyboard/F11',
  'Analog = Keyboard/8',
  'Down = Nonsense/Whatever',
  'Left = SDL-1/NoSuchButton',
  'NotAPadControl = SDL-1/FaceSouth',
  '',
  '[Pad2]',
  'Cross = SDL-2/FaceSouth',
].join('\n');

console.log('the built-in defaults, against pcsx2pad.py');
{
  const js = pad.defaults();
  const py = python('import pcsx2pad, json;'
                    + ' print(json.dumps(pcsx2pad.defaults()["bindings"]))');
  check('the same targets', Object.keys(js.bindings).sort(), Object.keys(py).sort());
  check('the same sources', js.bindings, py);
  check('the default ini text is identical on both sides',
        pad.DEFAULT_INI.trim(),
        python('import pcsx2pad, json;'
               + ' print(json.dumps(pcsx2pad.DEFAULT_INI.strip()))'));
}

console.log('a synthetic ini covering every source form');
{
  const js = pad.parse(SYNTHETIC);
  const py = python('import pcsx2pad, json, sys;'
                    + ' r = pcsx2pad.parse(sys.stdin.read());'
                    + ' print(json.dumps({"b": r["bindings"], "u": r["unknown"]}))',
                    SYNTHETIC);
  check('bindings match', js.bindings, py.b);
  check('what was not understood matches', js.unknown, py.u);

  // Spot-check the parts the tables are actually responsible for.
  check('Cross is standard-mapping button 0',
        js.bindings.Cross, [{ kind: 'button', pad: 1, index: 0 }]);
  check('Circle is button 1 and Square is button 2',
        [js.bindings.Circle[0].index, js.bindings.Square[0].index], [1, 2]);
  check('DPadUp is button 12', js.bindings.Up[0].index, 12);
  check('a trigger resolves to an analogue button, not an axis',
        js.bindings.L2, [{ kind: 'button', pad: 1, index: 6 }]);
  check('-LeftY and +LeftY are the two halves of axis 1',
        [js.bindings.LUp[0], js.bindings.LDown[0]],
        [{ kind: 'axis', pad: 1, index: 1, sign: -1 },
         { kind: 'axis', pad: 1, index: 1, sign: 1 }]);
  check('a chord keeps both sources',
        js.bindings.Start,
        [{ kind: 'key', code: 'AltLeft' }, { kind: 'key', code: 'Enter' }]);
  check('XInput resolves like SDL', js.bindings.RRight,
        [{ kind: 'axis', pad: 0, index: 2, sign: 1 }]);
  check('a keypad key and a function key',
        [js.bindings.L3[0].code, js.bindings.R3[0].code], ['Numpad7', 'F11']);
  check('a digit key', js.bindings.Analog[0].code, 'Digit8');
  check('an unknown device is dropped', js.bindings.Down, undefined);
  check('an unknown binding is dropped', js.bindings.Left, undefined);
  check('a target that is not a pad control is ignored',
        js.bindings.NotAPadControl, undefined);
  check('both are reported as not understood',
        Object.keys(js.unknown).sort(), ['Down', 'Left']);
  check('only [Pad1] is read', js.raw.Cross, 'SDL-1/FaceSouth');
}

console.log('reading a pad with no devices attached');
{
  const p = new pad.Pad(pad.defaults().bindings);
  const state = p.read();
  check('every control reads 0', pad.PAD_TARGETS.every((t) => state[t] === 0), true);
  check('both sticks read centred', [state.lx, state.ly, state.rx, state.ry],
        [0, 0, 0, 0]);
  // Holding a key is the one input path that works without a browser.
  p.held.add('KeyW');
  p.held.add('KeyD');
  const moved = p.read();
  check('a held key drives the stick it is bound to',
        [moved.lx, moved.ly], [1, -1]);
  check('the d-pad and the stick share the axis rather than doubling it',
        (() => { p.held.add('ArrowUp'); return p.read().ly; })(), -1);
  p.held.clear();
  check('releasing clears it', p.read().lx, 0);
}

console.log('rising edges');
{
  const edges = new pad.Edges();
  const off = { Cross: 0 }, on = { Cross: 1 };
  check('first press fires', edges.pressed(on, 'Cross'), true);
  check('holding does not repeat', edges.pressed(on, 'Cross'), false);
  check('release then press fires again',
        [edges.pressed(off, 'Cross'), edges.pressed(on, 'Cross')], [false, true]);
}

const realIni = iniArg || python(
  'import pcsx2pad, json; p = pcsx2pad.find_ini(); print(json.dumps(p))');
if (realIni && fs.existsSync(realIni)) {
  console.log("this machine's own PCSX2.ini");
  const text = fs.readFileSync(realIni, 'utf8');
  const js = pad.parse(text);
  const py = python('import pcsx2pad, json, sys;'
                    + ' print(json.dumps(pcsx2pad.parse(sys.stdin.read())["bindings"]))',
                    text);
  check('bindings match', js.bindings, py);
  check('nothing in it was left unparsed', js.unknown, {});
  const dev = pad.devicesUsed(js.bindings);
  console.log('        %d targets bound, %d keyboard sources, pads %s',
              Object.keys(js.bindings).length, dev.keys,
              JSON.stringify(dev.pads));
} else {
  console.log('no PCSX2.ini on this machine -- skipping the real-ini check');
}

console.log('\n%s', failures ? failures + ' FAILED' : 'all checks passed');
process.exit(failures ? 1 : 0);
