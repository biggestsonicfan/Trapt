"""Read a PCSX2 `PCSX2.ini` and turn `[Pad1]` into browser input.

The viewer already reads the disc the emulator would have run; the pad it is
driven with should be the one the emulator was configured with, so a stage
plays the way the user set PCSX2 up rather than the way this page guessed.

`PCSX2.ini` lives beside the emulator's other settings -- on Windows normally
`Documents/PCSX2/inis/PCSX2.ini` -- and the pad sections read:

    [Pad1]
    Cross = SDL-1/FaceSouth
    Up = SDL-1/DPadUp
    LUp = SDL-1/-LeftY
    L2 = SDL-1/+LeftTrigger
    Start = Keyboard/Return
    Screenshot = Keyboard/Shift & Keyboard/F8      (in [Hotkeys])

The key is the PS2 control and the value is one or more physical sources
joined by `&`, which PCSX2 treats as a chord -- all of them must be held.

**The SDL half needs no translation.**  PCSX2's SDL binding names are SDL's
own GameController layout, and the W3C Gamepad API's "standard mapping" is
that same layout with the same ordering, so `FaceSouth` is button 0, `DPadUp`
is button 12 and `LeftY` is axis 1, on both.  `SDL_BUTTONS` and `SDL_AXES`
below are that correspondence and nothing more.

An axis source carries a sign: `-LeftY` is the stick pushed up and `+LeftY`
down, so a binding fires on one half of the axis and reads 0 on the other.
The triggers are axes too (`+LeftTrigger`), which is why they can be held
part-way.

Keyboard names are Qt's, and those do need translating -- `Return`, `Plus`,
`Backtab` -- which `KEYS` does, falling back to `Key<X>` for a plain letter.

    python pcsx2pad.py                       # find the ini and dump Pad1
    python pcsx2pad.py path/to/PCSX2.ini
    python pcsx2pad.py --json                # what the browser consumes
"""
import json
import os
import sys

# PCSX2 / SDL GameController button name -> W3C standard-mapping button index.
SDL_BUTTONS = {
    'FaceSouth': 0, 'FaceEast': 1, 'FaceWest': 2, 'FaceNorth': 3,
    'LeftShoulder': 4, 'RightShoulder': 5,
    'LeftTrigger': 6, 'RightTrigger': 7,
    'Back': 8, 'Start': 9,
    'LeftStick': 10, 'RightStick': 11,
    'DPadUp': 12, 'DPadDown': 13, 'DPadLeft': 14, 'DPadRight': 15,
    'Guide': 16,
}

# ... and axis name -> standard-mapping axis index.  The triggers appear in
# both tables: PCSX2 binds them as axes (`+LeftTrigger`) while the Gamepad API
# reports them as analogue *buttons*, so `resolve` emits a button source with
# an analogue value rather than an axis one.
SDL_AXES = {'LeftX': 0, 'LeftY': 1, 'RightX': 2, 'RightY': 3}
SDL_TRIGGERS = {'LeftTrigger': 6, 'RightTrigger': 7}

# Qt key name -> KeyboardEvent.code, for the ones that are not `Key<X>`.
KEYS = {
    'Up': 'ArrowUp', 'Down': 'ArrowDown', 'Left': 'ArrowLeft',
    'Right': 'ArrowRight', 'Return': 'Enter', 'Enter': 'NumpadEnter',
    'Space': 'Space', 'Escape': 'Escape', 'Tab': 'Tab', 'Backtab': 'Tab',
    'Backspace': 'Backspace', 'Delete': 'Delete', 'Insert': 'Insert',
    'Home': 'Home', 'End': 'End', 'PageUp': 'PageUp', 'PageDown': 'PageDown',
    'Shift': 'ShiftLeft', 'Control': 'ControlLeft', 'Alt': 'AltLeft',
    'Meta': 'MetaLeft', 'CapsLock': 'CapsLock',
    'Plus': 'Equal', 'Minus': 'Minus', 'Equal': 'Equal',
    'Comma': 'Comma', 'Period': 'Period', 'Slash': 'Slash',
    'Backslash': 'Backslash', 'Semicolon': 'Semicolon',
    'Apostrophe': 'Quote', 'QuoteLeft': 'Backquote',
    'BracketLeft': 'BracketLeft', 'BracketRight': 'BracketRight',
}

# The PS2 controls a stage actually reads.  Anything else in [Pad1] -- the
# motors, the pressure axes -- is parsed and kept but never polled.
PAD_TARGETS = (
    'Up', 'Down', 'Left', 'Right',
    'Triangle', 'Circle', 'Cross', 'Square',
    'L1', 'R1', 'L2', 'R2', 'L3', 'R3',
    'Select', 'Start', 'Analog',
    'LUp', 'LDown', 'LLeft', 'LRight',
    'RUp', 'RDown', 'RLeft', 'RRight',
)

# Used when no ini is supplied.  Written in PCSX2's own syntax so it goes
# through exactly the same parser -- one code path, not two.
#
# The arrows are the *right* stick, not the d-pad: a stage is moved with one
# stick and aimed with the other, so a keyboard with nothing on the right
# stick cannot turn the camera at all.  The d-pad goes on the numpad, which
# keeps it bound without stealing the arrows.
DEFAULT_INI = """
[Pad1]
Up = Keyboard/Keypad8
Down = Keyboard/Keypad2
Left = Keyboard/Keypad4
Right = Keyboard/Keypad6
LUp = Keyboard/W
LDown = Keyboard/S
LLeft = Keyboard/A
LRight = Keyboard/D
RUp = Keyboard/Up
RDown = Keyboard/Down
RLeft = Keyboard/Left
RRight = Keyboard/Right
Cross = Keyboard/K
Circle = Keyboard/L
Square = Keyboard/J
Triangle = Keyboard/I
L1 = Keyboard/Q
R1 = Keyboard/E
L2 = Keyboard/1
R2 = Keyboard/3
L3 = Keyboard/Z
R3 = Keyboard/C
Select = Keyboard/Backspace
Start = Keyboard/Return
"""


def find_ini():
    """The usual places PCSX2 keeps its settings, first hit wins."""
    home = os.path.expanduser('~')
    candidates = [
        os.path.join(home, 'Documents', 'PCSX2', 'inis', 'PCSX2.ini'),
        os.path.join(home, 'OneDrive', 'Documents', 'PCSX2', 'inis', 'PCSX2.ini'),
        os.path.join(home, '.config', 'PCSX2', 'inis', 'PCSX2.ini'),
        os.path.join(home, 'Library', 'Application Support', 'PCSX2', 'inis',
                     'PCSX2.ini'),
    ]
    for p in candidates:
        if os.path.isfile(p):
            return p
    return None


def read_ini(text):
    """`{section: {key: value}}`, in file order, comments and blanks dropped."""
    out = {}
    section = None
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith((';', '#')):
            continue
        if line.startswith('[') and line.endswith(']'):
            section = line[1:-1]
            out.setdefault(section, {})
            continue
        if section is None or '=' not in line:
            continue
        key, value = line.split('=', 1)
        out[section][key.strip()] = value.strip()
    return out


def resolve_source(text):
    """One `Keyboard/X` or `SDL-1/-LeftY` -> a source dict, or None.

    A source is one of:

        {'kind': 'key',    'code': 'KeyW'}
        {'kind': 'button', 'pad': 1, 'index': 0}
        {'kind': 'axis',   'pad': 1, 'index': 1, 'sign': -1}
    """
    text = text.strip()
    if '/' not in text:
        return None
    device, binding = text.split('/', 1)
    device = device.strip()
    binding = binding.strip()

    if device == 'Keyboard':
        code = KEYS.get(binding)
        if code is None:
            if len(binding) == 1 and binding.isalpha():
                code = 'Key' + binding.upper()
            elif len(binding) == 1 and binding.isdigit():
                code = 'Digit' + binding
            elif binding.startswith('F') and binding[1:].isdigit():
                code = binding
            elif binding.startswith('Keypad') and binding[6:].isdigit():
                code = 'Numpad' + binding[6:]
            else:
                return None
        return {'kind': 'key', 'code': code}

    # SDL-1, XInput-0, DInput-0 -- all report the standard layout to the
    # browser, so only the index after the dash matters.
    head = device.split('-')
    if head[0] not in ('SDL', 'XInput', 'DInput'):
        return None
    try:
        pad = int(head[1]) if len(head) > 1 else 0
    except ValueError:
        pad = 0

    sign = 0
    if binding[:1] in '+-':
        sign = 1 if binding[0] == '+' else -1
        binding = binding[1:]

    if binding in SDL_TRIGGERS:
        # An analogue trigger: the Gamepad API gives it as a button whose
        # `value` runs 0..1, so the sign PCSX2 stores is not needed.
        return {'kind': 'button', 'pad': pad, 'index': SDL_TRIGGERS[binding]}
    if binding in SDL_AXES:
        return {'kind': 'axis', 'pad': pad, 'index': SDL_AXES[binding],
                'sign': sign or 1}
    if binding in SDL_BUTTONS:
        return {'kind': 'button', 'pad': pad, 'index': SDL_BUTTONS[binding]}
    return None


def resolve_binding(value):
    """`Keyboard/Alt & Keyboard/Return` -> the list of sources it chords."""
    out = []
    for part in value.split('&'):
        src = resolve_source(part)
        if src is not None:
            out.append(src)
    return out


def parse(text, section='Pad1'):
    """A whole `[Pad1]` -> `{target: [source, ...]}`, plus what was dropped."""
    ini = read_ini(text)
    raw = ini.get(section, {})
    bindings = {}
    unknown = {}
    for target, value in raw.items():
        if target not in PAD_TARGETS:
            continue
        sources = resolve_binding(value)
        if sources:
            bindings[target] = sources
        else:
            unknown[target] = value
    return {'section': section, 'bindings': bindings, 'unknown': unknown,
            'raw': raw}


def defaults():
    return parse(DEFAULT_INI)


def describe(source):
    if source['kind'] == 'key':
        return 'key ' + source['code']
    if source['kind'] == 'button':
        return 'pad%d button %d' % (source['pad'], source['index'])
    return 'pad%d axis %d %s' % (source['pad'], source['index'],
                                 '+' if source['sign'] > 0 else '-')


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    as_json = '--json' in sys.argv
    path = args[0] if args else find_ini()
    if path is None:
        print('no PCSX2.ini found; showing the built-in keyboard defaults',
              file=sys.stderr)
        parsed = defaults()
        path = '<defaults>'
    else:
        with open(path, 'r', encoding='utf-8', errors='replace') as f:
            parsed = parse(f.read())
    if as_json:
        print(json.dumps(parsed['bindings'], indent=2, sort_keys=True))
        return 0
    print('%s  [%s]' % (path, parsed['section']))
    if not parsed['bindings']:
        print('  nothing bound')
    for target in PAD_TARGETS:
        if target not in parsed['bindings']:
            continue
        print('  %-8s %s' % (target, ' & '.join(
            describe(s) for s in parsed['bindings'][target])))
    for target, value in parsed['unknown'].items():
        print('  %-8s NOT UNDERSTOOD: %s' % (target, value))
    return 0


if __name__ == '__main__':
    sys.exit(main())
