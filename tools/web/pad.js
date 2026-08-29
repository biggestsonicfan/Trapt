/**
 * The PS2 pad, bound the way PCSX2 is -- `tools/pcsx2pad.py` in the browser,
 * plus the polling the page needs.
 *
 * The viewer already reads the disc the emulator would have run, so the pad
 * it is driven with should be the one PCSX2 was set up with rather than a
 * keyboard layout this page invented.  Drop a `PCSX2.ini` on the page and
 * `[Pad1]` becomes the controls.
 *
 *   [Pad1]
 *   Cross = SDL-1/FaceSouth
 *   LUp   = SDL-1/-LeftY
 *   L2    = SDL-1/+LeftTrigger
 *   Start = Keyboard/Return
 *
 * The key is the PS2 control, the value one or more physical sources joined
 * by `&`, which PCSX2 treats as a chord -- all of them must be held.
 *
 * **The SDL half needs no translation.**  PCSX2's SDL binding names are SDL's
 * GameController layout, and the W3C Gamepad API's "standard mapping" is that
 * same layout in the same order: `FaceSouth` is button 0, `DPadUp` is 12,
 * `LeftY` is axis 1.  `SDL_BUTTONS` and `SDL_AXES` are that correspondence
 * and nothing more.
 *
 * Axis sources carry a sign -- `-LeftY` is the stick pushed up -- so a
 * binding reads one half of the axis and 0 on the other.  Triggers are bound
 * as axes by PCSX2 but reported as analogue *buttons* by the browser, which
 * is why they resolve to a button source.
 *
 * Keyboard names are Qt's and do need translating: `Return`, `Plus`,
 * `Backtab`.
 */
(function () {
'use strict';

const SDL_BUTTONS = {
  FaceSouth: 0, FaceEast: 1, FaceWest: 2, FaceNorth: 3,
  LeftShoulder: 4, RightShoulder: 5, LeftTrigger: 6, RightTrigger: 7,
  Back: 8, Start: 9, LeftStick: 10, RightStick: 11,
  DPadUp: 12, DPadDown: 13, DPadLeft: 14, DPadRight: 15, Guide: 16,
};
const SDL_AXES = { LeftX: 0, LeftY: 1, RightX: 2, RightY: 3 };
const SDL_TRIGGERS = { LeftTrigger: 6, RightTrigger: 7 };

const KEYS = {
  Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight',
  Return: 'Enter', Enter: 'NumpadEnter', Space: 'Space', Escape: 'Escape',
  Tab: 'Tab', Backtab: 'Tab', Backspace: 'Backspace', Delete: 'Delete',
  Insert: 'Insert', Home: 'Home', End: 'End',
  PageUp: 'PageUp', PageDown: 'PageDown',
  Shift: 'ShiftLeft', Control: 'ControlLeft', Alt: 'AltLeft',
  Meta: 'MetaLeft', CapsLock: 'CapsLock',
  Plus: 'Equal', Minus: 'Minus', Equal: 'Equal', Comma: 'Comma',
  Period: 'Period', Slash: 'Slash', Backslash: 'Backslash',
  Semicolon: 'Semicolon', Apostrophe: 'Quote', QuoteLeft: 'Backquote',
  BracketLeft: 'BracketLeft', BracketRight: 'BracketRight',
};

const PAD_TARGETS = [
  'Up', 'Down', 'Left', 'Right',
  'Triangle', 'Circle', 'Cross', 'Square',
  'L1', 'R1', 'L2', 'R2', 'L3', 'R3',
  'Select', 'Start', 'Analog',
  'LUp', 'LDown', 'LLeft', 'LRight',
  'RUp', 'RDown', 'RLeft', 'RRight',
];

// Used when no ini is supplied.  Written in PCSX2's own syntax so it goes
// through the same parser -- one code path, not two.
// The arrows are the *right* stick, not the d-pad: a stage is moved with one
// stick and aimed with the other, so a keyboard with nothing on the right
// stick cannot turn the camera at all.  The d-pad goes on the numpad, which
// keeps it bound without stealing the arrows.
const DEFAULT_INI = [
  '[Pad1]',
  'Up = Keyboard/Keypad8', 'Down = Keyboard/Keypad2',
  'Left = Keyboard/Keypad4', 'Right = Keyboard/Keypad6',
  'LUp = Keyboard/W', 'LDown = Keyboard/S',
  'LLeft = Keyboard/A', 'LRight = Keyboard/D',
  'RUp = Keyboard/Up', 'RDown = Keyboard/Down',
  'RLeft = Keyboard/Left', 'RRight = Keyboard/Right',
  'Cross = Keyboard/K', 'Circle = Keyboard/L',
  'Square = Keyboard/J', 'Triangle = Keyboard/I',
  'L1 = Keyboard/Q', 'R1 = Keyboard/E',
  'L2 = Keyboard/1', 'R2 = Keyboard/3',
  'L3 = Keyboard/Z', 'R3 = Keyboard/C',
  'Select = Keyboard/Backspace', 'Start = Keyboard/Return',
].join('\n');

function readIni(text) {
  const out = {};
  let section = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      section = line.slice(1, -1);
      if (!out[section]) out[section] = {};
      continue;
    }
    if (section === null) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    out[section][line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

/** One `Keyboard/X` or `SDL-1/-LeftY` -> a source, or null. */
function resolveSource(text) {
  text = text.trim();
  const slash = text.indexOf('/');
  if (slash < 0) return null;
  const device = text.slice(0, slash).trim();
  let binding = text.slice(slash + 1).trim();

  if (device === 'Keyboard') {
    let code = KEYS[binding];
    if (code === undefined) {
      if (/^[A-Za-z]$/.test(binding)) code = 'Key' + binding.toUpperCase();
      else if (/^[0-9]$/.test(binding)) code = 'Digit' + binding;
      else if (/^F[0-9]+$/.test(binding)) code = binding;
      else if (/^Keypad[0-9]$/.test(binding)) code = 'Numpad' + binding.slice(6);
      else return null;
    }
    return { kind: 'key', code };
  }

  const head = device.split('-');
  if (!['SDL', 'XInput', 'DInput'].includes(head[0])) return null;
  const pad = head.length > 1 ? (parseInt(head[1], 10) || 0) : 0;

  let sign = 0;
  if (binding[0] === '+' || binding[0] === '-') {
    sign = binding[0] === '+' ? 1 : -1;
    binding = binding.slice(1);
  }
  if (SDL_TRIGGERS[binding] !== undefined)
    return { kind: 'button', pad, index: SDL_TRIGGERS[binding] };
  if (SDL_AXES[binding] !== undefined)
    return { kind: 'axis', pad, index: SDL_AXES[binding], sign: sign || 1 };
  if (SDL_BUTTONS[binding] !== undefined)
    return { kind: 'button', pad, index: SDL_BUTTONS[binding] };
  return null;
}

function resolveBinding(value) {
  return value.split('&').map(resolveSource).filter(Boolean);
}

function parse(text, section) {
  section = section || 'Pad1';
  const raw = readIni(text)[section] || {};
  const bindings = {};
  const unknown = {};
  for (const [target, value] of Object.entries(raw)) {
    if (!PAD_TARGETS.includes(target)) continue;
    const sources = resolveBinding(value);
    if (sources.length) bindings[target] = sources;
    else unknown[target] = value;
  }
  return { section, bindings, unknown, raw };
}

function defaults() { return parse(DEFAULT_INI); }

function describe(s) {
  if (s.kind === 'key') return 'key ' + s.code;
  if (s.kind === 'button') return 'pad' + s.pad + ' button ' + s.index;
  return 'pad' + s.pad + ' axis ' + s.index + (s.sign > 0 ? ' +' : ' -');
}

/**
 * What a PS2 control is physically bound to, in a form worth printing.
 *
 * On a controller the useful name is the PS2 one: PCSX2 has already mapped a
 * physical button to it, so `Circle` is what the player presses and
 * "pad1 button 1" is noise.  Only a keyboard needs the key spelled out.
 */
function hint(bindings, target) {
  const sources = bindings && bindings[target];
  if (!sources || !sources.length) return null;
  if (sources.some((s) => s.kind !== 'key')) return target;
  return sources.map((s) => s.code
    // Anchored, and first: stripping a bare trailing `Left` -- which is what
    // ShiftLeft wants -- turns ArrowLeft into the empty string.
    .replace(/^(Shift|Control|Alt|Meta)(Left|Right)$/, '$1')
    .replace(/^Key/, '').replace(/^Digit/, '')
    .replace(/^Arrow/, '').replace(/^Numpad/, 'numpad ')).join(' + ');
}

/** The four half-axes of one stick as a single phrase. */
function stickHint(bindings, prefix) {
  const keys = [prefix + 'Up', prefix + 'Left', prefix + 'Down', prefix + 'Right']
    .map((t) => hint(bindings, t));
  if (!keys.every(Boolean)) return 'nothing bound';
  // A gamepad binding reports its own target name back, so that is the tell.
  if (keys[0] === prefix + 'Up')
    return 'the ' + (prefix === 'L' ? 'left' : 'right') + ' stick';
  if (keys.every((k) => k.length === 1)) return keys.join('');
  return keys.join('/');
}

/** Which physical devices a binding set needs -- for telling the user. */
function devicesUsed(bindings) {
  let keys = 0;
  const pads = new Set();
  for (const sources of Object.values(bindings))
    for (const s of sources) {
      if (s.kind === 'key') keys++;
      else pads.add(s.pad);
    }
  return { keys, pads: [...pads].sort((a, b) => a - b) };
}

const DEADZONE = 0.20;

/**
 * Live pad state.  `read()` returns every PS2 control as 0..1, analogue where
 * the source is, so a trigger or a stick keeps its travel.
 *
 * The two stick axes are assembled from the four half-axis bindings PCSX2
 * stores (`LUp`/`LDown`/`LLeft`/`LRight`), which is also how a d-pad or four
 * keys bound to the same targets come out -- the caller never has to know
 * which the user is holding.
 */
class Pad {
  constructor(bindings) {
    this.bindings = bindings || defaults().bindings;
    this.held = new Set();
    this.detached = true;
  }

  attach(target) {
    if (typeof document === 'undefined') return this;
    const el = target || window;
    this._down = (e) => {
      if (!this._wants(e.code)) return;
      this.held.add(e.code);
      e.preventDefault();
    };
    this._up = (e) => { this.held.delete(e.code); };
    this._blur = () => { this.held.clear(); };
    el.addEventListener('keydown', this._down);
    el.addEventListener('keyup', this._up);
    window.addEventListener('blur', this._blur);
    this._target = el;
    this.detached = false;
    return this;
  }

  detach() {
    if (this.detached || !this._target) return;
    this._target.removeEventListener('keydown', this._down);
    this._target.removeEventListener('keyup', this._up);
    window.removeEventListener('blur', this._blur);
    this.held.clear();
    this.detached = true;
  }

  /** Is this key code bound to anything?  Unbound keys stay the browser's. */
  _wants(code) {
    for (const sources of Object.values(this.bindings))
      for (const s of sources) if (s.kind === 'key' && s.code === code) return true;
    return false;
  }

  _gamepads() {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return [];
    return [...navigator.getGamepads()].filter(Boolean);
  }

  _sourceValue(s, pads) {
    if (s.kind === 'key') return this.held.has(s.code) ? 1 : 0;
    // PCSX2 numbers its SDL devices from 0 in the order SDL enumerated them,
    // which is not necessarily the browser's index, so fall back to the first
    // connected pad rather than reading nothing at all.
    const gp = pads[s.pad] || pads[0];
    if (!gp) return 0;
    if (s.kind === 'button') {
      const b = gp.buttons[s.index];
      if (!b) return 0;
      return typeof b === 'object' ? (b.value || (b.pressed ? 1 : 0))
                                   : (b ? 1 : 0);
    }
    const v = gp.axes[s.index];
    if (v === undefined) return 0;
    const half = s.sign > 0 ? v : -v;
    return half > DEADZONE ? Math.min(1, (half - DEADZONE) / (1 - DEADZONE)) : 0;
  }

  /** A chord reads as its weakest member, so all of it has to be held. */
  value(target) {
    const sources = this.bindings[target];
    if (!sources || !sources.length) return 0;
    const pads = this._gamepads();
    let out = 1;
    for (const s of sources) out = Math.min(out, this._sourceValue(s, pads));
    return out;
  }

  read() {
    const pads = this._gamepads();
    const v = (t) => {
      const sources = this.bindings[t];
      if (!sources || !sources.length) return 0;
      let out = 1;
      for (const s of sources) out = Math.min(out, this._sourceValue(s, pads));
      return out;
    };
    const out = {};
    for (const t of PAD_TARGETS) out[t] = v(t);
    // The d-pad and the stick drive the same two axes; whichever is pushed
    // further wins, so holding both is not double speed.
    out.lx = Math.max(out.LRight, out.Right) - Math.max(out.LLeft, out.Left);
    out.ly = Math.max(out.LDown, out.Down) - Math.max(out.LUp, out.Up);
    out.rx = out.RRight - out.RLeft;
    out.ry = out.RDown - out.RUp;
    out.connected = pads.length;
    return out;
  }
}

/** Rising edges, for buttons that should fire once rather than repeat. */
class Edges {
  constructor() { this.last = {}; }
  pressed(state, target) {
    const now = state[target] > 0.5;
    const was = !!this.last[target];
    this.last[target] = now;
    return now && !was;
  }
}

const api = { parse, defaults, readIni, resolveSource, resolveBinding,
              describe, devicesUsed, hint, stickHint, Pad, Edges,
              PAD_TARGETS, SDL_BUTTONS, SDL_AXES, SDL_TRIGGERS, KEYS,
              DEFAULT_INI, DEADZONE };
if (typeof module !== 'undefined') module.exports = api;
if (typeof window !== 'undefined') window.TraptPad = api;
})();
