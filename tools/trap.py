"""The trap tables -- what a trap is called, what it costs and where it fits.

Traps and gimmicks are the same object type split by id (`EXECUTABLE.md` 7.2):
ids `0x00`-`0x2F` are the 48 player traps in `DATA/TRAP/T{C,W,F}##.ARC`, one
archive per trap, and `0x30`-`0xEF` the gimmicks in `DATA/GIMMICK/`.  `C`, `W`
and `F` are Ceiling, Wall and Floor -- the surface the trap is set on, which
is also the three tabs of the trap-select screen.

Four files describe one trap, and all but the last are `#bin` (`hbin.py`):

    DATA/TRAP/TRAPINFO.BIN   48 x TrapInfo -- the master table
    <trap>.td                1 x TrapData  -- name, description, model
    <trap>.tcd               the collision volumes it occupies and attacks
    <trap>.sd                26 x s16 sound slots, 0xffff for none

Everything else in the archive is already-decoded formats: the `.smi` model,
its `.tm2` textures, a `.sai` for the trap's own animation, and `.ssc` effect
scripts (`ef_tc00.ssc` and friends) that the scene VM in `ssc.py` already
runs.  Firing a trap is running one of those.

`TrapInfo` is 16 bytes and holds the numbers the game shows you::

    +0x00 u32  -> name   (Shift-JIS, full-width)
    +0x04 u32  -> blurb  (Shift-JIS)
    +0x08 u16  damage
    +0x0a u16  reset     -- frames before it can fire again
    +0x0c u16  cost      -- what it takes out of the trap gauge
    +0x0e u16  price     -- ARK to buy; 0 for the six you start with

`TC00` is `Guillotine` / `Slices the enemy.` / 25 damage / 360 / 12 / 3400.
The names read as full-width Latin because that is how the Japanese build
stored them; `norm()` folds them back to ASCII.

Each trap's own `.td` carries the name again -- it agrees for all 48 -- plus
the model file and a **second, longer description**: `Guillotine` there is
`3 blades fall in succession.`  The two are not a contradiction, they are the
two texts the trap-select screen shows, the short one in the list and the long
one in the detail panel, so `Trap` keeps both as `blurb` and `effect`.

`TrapData` is 254 bytes of which only the five pointer slots at the front are
firmly read here.  The fixup table says which of those five are live (three
for `tc02.td`, six for `tc01.td`), and the rest of the block is left as raw
bytes rather than guessed at -- there are about fifty varying byte offsets in
it and no evidence yet for what most of them mean.

The `.tcd` volumes are named and self-describing: `SCOL_WALL_SET`,
`SCOL_CEIL_SET`, `SCOL_SLOPE_SET`, `SCOL_BOX_SET`, `SCOL_CAPSULE`,
`SCOL_SPHERE`, `SCOL_LINE`.  Each is a run of `float4`s; a `*_SET` is one
rectangle per 32 bytes as `(min, max)`, which is the footprint the trap needs
on the surface it is set on, and that is what `footprint` returns.

    python trap.py                  # the whole table
    python trap.py tc00             # one trap, in full
    python trap.py --check          # every trap and gimmick parses
"""
import struct
import sys
import unicodedata

import hbin

GROUPS = 'CWF'
SURFACES = {'C': 'ceiling', 'W': 'wall', 'F': 'floor'}
TRAP_COUNT = 48
INFO_PATH = 'DATA/TRAP/TRAPINFO.BIN'
GMK_PATH = 'DATA/GIMMICK/GMKINFO.BIN'

# The volume chunks in a `.tcd`, and how many floats one entry spans.
VOLUME_STRIDE = {
    'SCOL_WALL_SET': 8, 'SCOL_CEIL_SET': 8, 'SCOL_SLOPE_SET': 8,
    'SCOL_WALL4_SET': 8, 'SCOL_BOX_SET': 8, 'SCOL_CROSS_SET': 8,
    'SCOL_CAPSULE': 8, 'SCOL_SPHERE': 8, 'SCOL_LINE': 8,
}


def norm(text):
    """Full-width Latin back to ASCII, which is how these read on screen."""
    return unicodedata.normalize('NFKC', text)


def trap_name(index):
    """Trap id -> `TC00` .. `TF15`."""
    if not 0 <= index < TRAP_COUNT:
        raise ValueError('trap id %d is out of range' % index)
    return 'T%s%02d' % (GROUPS[index // 16], index % 16)


def trap_surface(index):
    return SURFACES[GROUPS[index // 16]]


class Trap:
    __slots__ = ('id', 'name', 'surface', 'title', 'blurb', 'effect',
                 'damage', 'reset', 'cost', 'price', 'model', 'archive')

    def __init__(self, index, title, blurb, damage, reset, cost, price):
        self.id = index
        self.name = trap_name(index)
        self.surface = trap_surface(index)
        self.title = title
        self.blurb = blurb          # TRAPINFO.BIN -- the one-line list text
        self.effect = ''            # the .td -- the longer detail text
        self.damage = damage
        self.reset = reset
        self.cost = cost
        self.price = price
        self.model = None
        self.archive = 'DATA/TRAP/%s.ARC' % self.name

    def __repr__(self):
        return '<%s %s dmg=%d cost=%d price=%d %s>' % (
            self.name, self.title, self.damage, self.cost, self.price,
            self.surface)


def parse_info(blob):
    """`TRAPINFO.BIN` -> 48 `Trap`, in id order."""
    c = hbin.parse(blob)
    chunks = c.all_of('TrapInfo')
    if len(chunks) != TRAP_COUNT:
        raise ValueError('TRAPINFO.BIN has %d entries, expected %d'
                         % (len(chunks), TRAP_COUNT))
    out = []
    for i, ch in enumerate(chunks):
        pname, pblurb = struct.unpack_from('<2I', ch.data, 0)
        damage, reset, cost, price = struct.unpack_from('<4H', ch.data, 8)
        out.append(Trap(i, norm(c.sjis(pname)), norm(c.sjis(pblurb)),
                        damage, reset, cost, price))
    return out


def parse_td(blob):
    """One `.td` -> `{title, effect, model, pointers, raw}`."""
    c = hbin.parse(blob)
    ch = c.first('TrapData')
    if ch is None:
        raise ValueError('.td has no TrapData chunk')
    ptrs = list(struct.unpack_from('<5I', ch.data, 0))
    return {
        'title': norm(c.sjis(ptrs[0])),
        'effect': norm(c.sjis(ptrs[1])),
        'model': c.cstr(ptrs[2]),
        'pointers': ptrs,
        'live': len(c.fixups),
        'raw': ch.data,
    }


def parse_tcd(blob):
    """One `.tcd` -> `{name: [entry, ...]}` over every chunk it carries.

    A `*_SET` entry is `(min, max)` -- two `float3` in a `float4` pair.  The
    other shapes are handed back as their raw float runs, because a capsule
    and a sphere pack differently and nothing here needs them yet.
    """
    c = hbin.parse(blob)
    out = {}
    for ch in c.chunks:
        n = len(ch.data) // 4
        floats = list(struct.unpack_from('<%df' % n, ch.data, 0)) if n else []
        out.setdefault(ch.name, []).append(floats)
    return out


def footprint(tcd):
    """The rectangles a trap occupies on its surface, as `(min, max)` pairs.

    A `*_SET` entry is eight floats: an axis-aligned box as `min` then `max`,
    then two zeros of padding.  `tc00.tcd` carries `(-10, -6, -1)..(10, 3, -1)`
    and the same rectangle at `z = +1` -- the two faces of the thin slab the
    guillotine sweeps through.  One axis is always flat, because the box lies
    on the surface the trap is set on.
    """
    out = []
    for name, runs in tcd.items():
        if not name.endswith('_SET'):
            continue
        for floats in runs:
            for i in range(0, len(floats) - 7, VOLUME_STRIDE[name]):
                lo = tuple(floats[i:i + 3])
                hi = tuple(floats[i + 3:i + 6])
                if lo == (0.0, 0.0, 0.0) and hi == (0.0, 0.0, 0.0):
                    continue
                out.append((name, lo, hi))
    return out


def parse_sd(blob):
    """A `.sd` -> the sound slots, `None` where the entry is `0xffff`."""
    n = len(blob) // 2
    raw = struct.unpack_from('<%dH' % n, blob, 0)
    return [None if v == 0xFFFF else v for v in raw]


def load(disc, index):
    """Everything about one trap, its archive included."""
    import arc as arc_mod
    traps = parse_info(disc.read(INFO_PATH))
    t = traps[index]
    blob = disc.read(t.archive)
    if blob is None:
        return t, {}
    members = {n.lower(): blob[o:o + s] for n, o, s in arc_mod.entries(blob)}
    stem = t.name.lower()
    if stem + '.td' in members:
        td = parse_td(members[stem + '.td'])
        t.model = td['model']
        t.effect = td['effect']
    return t, members


def load_all(disc):
    return parse_info(disc.read(INFO_PATH))


# ---------------------------------------------------------------- self-check

def _check(disc):
    import arc as arc_mod
    traps = parse_info(disc.read(INFO_PATH))
    bad = 0
    mismatch = 0
    for t in traps:
        blob = disc.read(t.archive)
        if blob is None:
            bad += 1
            print('%s: no archive' % t.name)
            continue
        members = {n.lower(): blob[o:o + s] for n, o, s in arc_mod.entries(blob)}
        stem = t.name.lower()
        for ext in ('.td', '.tcd'):
            if stem + ext not in members:
                bad += 1
                print('%s: no %s%s in the archive' % (t.name, stem, ext))
        if stem + '.td' in members:
            td = parse_td(members[stem + '.td'])
            if td['title'] != t.title:
                mismatch += 1
                print('%s: TRAPINFO calls it %r, the .td calls it %r'
                      % (t.name, t.title, td['title']))
            if not td['effect']:
                mismatch += 1
                print('%s: the .td carries no effect text' % t.name)
            if td['model'] and td['model'].lower() not in members:
                bad += 1
                print('%s: .td names %s, which is not in the archive'
                      % (t.name, td['model']))
        if stem + '.tcd' in members:
            parse_tcd(members[stem + '.tcd'])
    gmk = disc.read(GMK_PATH)
    ngmk = len(hbin.parse(gmk).all_of('GmkInfo')) if gmk else 0
    print('%d traps, %d gimmick slots, %d problems, %d text mismatches'
          % (len(traps), ngmk, bad, mismatch))
    return 1 if bad or mismatch else 0


def main():
    import os
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import scene as scene_mod
    import arc as arc_mod
    disc = scene_mod.Disc()
    args = sys.argv[1:]
    if args and args[0] == '--check':
        return _check(disc)
    traps = parse_info(disc.read(INFO_PATH))
    if not args:
        print('%-6s %-7s %-22s %5s %6s %5s %7s  %s'
              % ('id', 'surface', 'name', 'dmg', 'reset', 'cost', 'price',
                 'blurb'))
        for t in traps:
            print('%-6s %-7s %-22s %5d %6d %5d %7d  %s'
                  % (t.name, t.surface, t.title, t.damage, t.reset, t.cost,
                     t.price, t.blurb))
        return 0
    want = args[0].upper()
    for t in traps:
        if t.name != want:
            continue
        blob = disc.read(t.archive)
        members = {n.lower(): blob[o:o + s] for n, o, s in arc_mod.entries(blob)}
        stem = t.name.lower()
        td = parse_td(members[stem + '.td'])
        print('%s  %s' % (t.name, t.title))
        print('  %s' % t.blurb)
        print('  %s' % td['effect'])
        print('  surface %s, damage %d, reset %d frames, cost %d, price %d'
              % (t.surface, t.damage, t.reset, t.cost, t.price))
        print('  model %s, %d live pointer slots' % (td['model'], td['live']))
        tcd = parse_tcd(members[stem + '.tcd'])
        print('  .tcd chunks: %s'
              % ', '.join('%s x%d' % (k, len(v)) for k, v in tcd.items()))
        for name, lo, hi in footprint(tcd):
            print('      %-16s (%g, %g, %g) .. (%g, %g, %g)'
                  % (name, lo[0], lo[1], lo[2], hi[0], hi[1], hi[2]))
        sd = [k for k in members if k.lower().endswith('.sd')]
        if sd:
            print('  sound slots: %s' % parse_sd(members[sd[0]]))
        print('  archive: %s'
              % ', '.join(sorted(k for k in members
                                 if k.endswith(('.smi', '.sai', '.ssc')))))
        return 0
    raise SystemExit('no trap called %s' % want)


if __name__ == '__main__':
    sys.exit(main())
