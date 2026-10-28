"""Trapt (SLUS-21255) `.SSC` compiled scene-script reader.

`.SSC` is the bytecode the real-time cutscene VM runs (dispatch table at ELF
`0x00376660`, 230 opcodes).  One cutscene is a bundle of parallel tracks --
a master/director track plus one per actor, camera, map, text and effect --
all sharing a single frame counter.

Format
------
    0x00  'SC'
    0x02  u16   (unknown, 0x011b on every file seen)
    0x04  u16   call count
    0x06        call stream

Each call is::

    E1  <u16 opcode BE>  <u16 flag BE>  <arg>*  EF

Arguments are type-tagged:

===== ================================================
tag    payload
===== ================================================
 C1    s32 big-endian -- integer literal
 C2    s32, s32       -- rational literal, numerator / denominator
 C3    NUL-terminated Shift-JIS string
 C4    s32 big-endian -- second integer namespace
 C5    s32 big-endian -- a register of the effect VM, by index
===== ================================================

`C2` is how the compiler spells a float: ``5/10`` is 0.5, ``11/100`` is 0.11,
``1/1`` is 1.0.

Text in `*_txt.ssc` carries inline markup: `%%SCSV` ... `%%RC` wraps the
speaker name, a literal two-character ``\\n`` is a line break and a literal
``\\0`` ends the string.

Usage
-----
    python ssc.py FILE.ssc              # opcode listing
    python ssc.py FILE_txt.ssc --lines  # speaker / voice / subtitle table
"""
import struct
import sys
import unicodedata

BS = chr(92)
NL = BS + 'n'
NUL = BS + '0'

CALL = 0xE1
END = 0xEF

# Opcodes confirmed by decompiling their handlers (dispatch table 0x00376660,
# handler = *(0x00376660 + op * 4)).  Everything else is still unnamed.
OPS = {
    0x00: 'end_track',
    0x01: 'yield',            # this frame of an effect program is done
    0x02: 'set_actor_slot',
    0x03: 'skip',             # (n) -> skip the next n calls unless the flag is set
    0x04: 'at_time',          # (start, end, step) -> guard for the calls after it
    0x05: 'cue',              # (0, c4:index)
    0x06: 'spawn_track',      # ("file.ssc", 0)
    0x09: 'preload',          # ("rt/e001/x.sai", -1, -1, -1) -> "data/%s"
    0x7C: 'uv_offset',        # (u, v, material flags)
    0x7D: 'alpha',            # (a, material flags)
    0x8C: 'place',            # (x, y, z, mode) -- 0x84's handler; mode 8 = scale
    0xAC: 'toward_eye',       # (f) -> drawn f units nearer the camera
    0xA4: 'if_state',         # (n) -> flag = r16 == n
    0xA6: 'expr',             # (dst, a, b, float, op) like 0x0D-0x1C
    0xB8: 'billboard',        # ("none", 3)
    0x0B: 'sync',
    0x50: 'scene_begin',
    0x51: 'scene_end',
    0x53: 'fade_in',          # (frames, 0)
    0x54: 'fade_out',         # (frames, 0)
    0x55: 'play_anim',        # ("x.sai", 1)
    0x56: 'scene_ready',
    0x57: 'letterbox',        # (mode: 0 in / 1 out, tween frames)
    0x59: 'play_voice',       # ("m0001_c01f_a", "none", c2(1, 1))
    0x5A: 'bgm_start',        # (id, c2(1,1), fade)
    0x5B: 'bgm_stop',         # (id, fade)
    0x60: 'subtitle_show',    # (text, x, y, "none")
    0x61: 'subtitle_hide',    # ("none")
    0x62: 'set_room',         # ("rp03")
    0x52: 'release_anim',     # ("c01f_a_e001_1.sai") -- frees the previous act
    0x64: 'block_begin',      # (kind, name); kind 4 model, 6 light, 7 camera
    0x65: 'block_end',
    0x6A: 'set_primary',      # (1)
    0x80: 'colour_or_scale',  # (r,g,b,a) on a light, (x,y,z,w) scale on a model
    0x82: 'attach_model',     # ("c01f_a_h.smi", 0, 0)
    0x83: 'play_anim_entity', # ("x.sai", rate, ?, blend_in, blend_out)
    0x84: 'set_position',     # (x, y, z, w)
    0xA2: 'set_visible',      # (mask, on)
    0xB3: 'set_root_bone',    # ("koshi")
    0xB4: 'light_type',       # (type, ?, mask); 0 directional, 1 point, 4 ambient
    0xB5: 'light_range',      # (near, far)
    0xB7: 'attach_to_bone',   # ("marukage_a.smi", "koshi", 0.5)
    0xB9: 'camera_path',      # (0, "e001.cam", 1)
    0xC7: 'fog',              # (near, far, r, g, b)
}
# 0x0D..0x1C all share handler 0x001c7240: the integer/float expression family
# (assign, add, sub, mul, div, mod, rand, wrap, clamp, compare).
for _op in range(0x0D, 0x1D):
    OPS.setdefault(_op, 'expr')


def parse(data):
    """Yield ``(offset, (opcode, flag), args)`` for every call in the stream.

    ``opcode`` is None for a byte the stream did not expect; trailing NUL or
    0xFF padding ends iteration.
    """
    if data[:2] != b'SC':
        raise ValueError('not an SSC script (magic %r)' % data[:2])
    p, n = 6, len(data)
    while p < n:
        if data[p] != CALL:
            if all(c in (0, 0xFF) for c in data[p:]):
                break
            yield p, None, ['<raw %02x>' % data[p]]
            p += 1
            continue
        op, flag = struct.unpack_from('>HH', data, p + 1)
        q = p + 5
        args = []
        while q < n and data[q] != END:
            t = data[q]
            q += 1
            if t == 0xC1:
                args.append(struct.unpack_from('>i', data, q)[0])
                q += 4
            elif t == 0xC4:
                args.append(('c4', struct.unpack_from('>i', data, q)[0]))
                q += 4
            elif t == 0xC5:
                args.append(('c5', struct.unpack_from('>i', data, q)[0]))
                q += 4
            elif t == 0xC2:
                args.append(('c2',) + struct.unpack_from('>ii', data, q))
                q += 8
            elif t == 0xC3:
                e = data.index(b'\0', q)
                args.append(data[q:e])
                q = e + 1
            else:
                args.append('<type %02x @%x>' % (t, q - 1))
                q = n
        yield p, (op, flag), args
        p = q + 1


def sj(b):
    """Decode a script string (Shift-JIS / cp932)."""
    try:
        return b.decode('cp932')
    except UnicodeDecodeError:
        return repr(b)


def _plain(s):
    """Full-width -> ASCII, and the two curly quotes the script uses."""
    return (unicodedata.normalize('NFKC', s)
            .replace(chr(0x2019), "'").replace(chr(0x201D), '"'))


def dialogue(data):
    """Yield ``(frame, speaker, [lines], voice)`` from a `*_txt.ssc` track."""
    frame = voice = None
    for _, op, args in parse(data):
        if op is None:
            continue
        if op[0] == 0x04:
            frame = args[0]
        elif op[0] == 0x59:
            voice = sj(args[0])
        elif op[0] == 0x60:
            raw = sj(args[0]).rstrip(chr(0)).replace(NUL, '')
            speaker = ''
            if raw.startswith('%%SCSV') and '%%RC' in raw:
                speaker, raw = raw[6:].split('%%RC', 1)
                if raw.startswith(NL):
                    raw = raw[2:]
            yield frame, _plain(speaker), _plain(raw).split(NL), voice
            voice = None


def _fmt(a):
    if isinstance(a, bytes):
        return '"%s"' % sj(a)
    if isinstance(a, tuple) and a[0] == 'c2':
        num, den = a[1], a[2]
        return '%g' % (num / den) if den else '%d/%d' % (num, den)
    if isinstance(a, tuple) and a[0] == 'c4':
        return '#%d' % a[1]
    if isinstance(a, tuple) and a[0] == 'c5':
        return 'r%d' % a[1]
    return repr(a)


def main():
    path = sys.argv[1]
    data = open(path, 'rb').read()
    if '--lines' in sys.argv:
        print('%-7s %-9s %-15s %s' % ('FRAME', 'SPEAKER', 'VOICE', 'LINE'))
        print('-' * 96)
        rows = list(dialogue(data))
        for frame, speaker, lines, voice in rows:
            for i, line in enumerate(lines):
                print('%-7s %-9s %-15s %s' % (frame if i == 0 else '',
                                              speaker if i == 0 else '',
                                              (voice or '-') if i == 0 else '',
                                              line))
        if rows:
            span = rows[-1][0] - rows[0][0]
            print('\n%d cues, frames %d..%d (%.1f s @60fps)'
                  % (len(rows), rows[0][0], rows[-1][0], span / 60.0))
        return
    print('header: %s' % data[:6].hex())
    for off, op, args in parse(data):
        if op is None:
            print('%06x  %s' % (off, args[0]))
            continue
        name = OPS.get(op[0], '')
        print('%06x  op=%02x %-14s f=%04x  %s'
              % (off, op[0], name, op[1], ', '.join(_fmt(a) for a in args)))


if __name__ == '__main__':
    main()
