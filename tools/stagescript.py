"""`B<nn><v>EVENT.ARC` -- what a stage is told to contain.

`stage.py` builds the *place*: rooms where the graph puts them, with their
collision and their doors.  This is what the game then puts **in** it -- where
the player starts, which gimmicks sit where, and who walks in.  It is the same
`.SSC` bytecode the cutscene VM already runs (`ssc.py`), in a different
opcode band: cutscenes live at `0x50`+, a stage at `0x1D`-`0x3F`.

An archive holds one master script and one per room:

    B010EVENT.ARC
      b010event.ssc      the stage: map, player, cast
      evsub_rh01.ssc     one per room: what is placed in it
      ... evsub_rh08.ssc

`b010event.ssc` reads, in full:

    1d 'SCR:_Start'          a label
    1e 0                     the map -- M000
    1f -120 120 600 0        the player, at RH_01's own origin, facing +Z
    3f 0 .. 3f 4             five slots armed
    29 'c30m_d'              the cast model
    2b 0 -120 120 680 -3.15  and where it stands, facing -Z
    53 fade_in 60 0
    1d 'SCR:_End'

Opcodes, from the dispatch table at `0x00376660`:

| op | handler | what it is |
|---|---|---|
| `0x1D` | `FUN_001C7070` | a label -- `SCR:_Start`, `SCR:_End` |
| `0x1E` | `FUN_001DB4E0` | the map index, straight into the loader |
| `0x1F` | `FUN_001DB310` | the player: `(x, y, z, angle)` |
| `0x21` | `FUN_001DAE60` | a gimmick: `(slot, id, x, y, z, rot, a, b)` |
| `0x22` | `FUN_001DAD10` | the same, without the rotation |
| `0x23` | `FUN_001DAC10` | `(slot, n, x, y, z, ?)` -> `FUN_001B4ED0(.., 300)` |
| `0x29` | `FUN_001DAB20` | the cast model, by name |
| `0x2B` | `FUN_001DA840` | and where it stands: `(id, x, y, z, angle, ..)` |

**Two conventions the handlers impose, and neither is guessable from the
data.**  `0x1F` and `0x2B` both add **0.5 to Y** before placing anything, and
both wrap the angle into `[-pi, pi]`.  So a script's `120` is a stand-on
height of `120.5`.

**Gimmick ids are decimal in the script and hexadecimal in the engine.**
`FUN_001DAE60` remaps: below 100 add `0x30`, below 200 add `0x0C`, otherwise
subtract `0x18`.  Which is to say the script writes them in three readable
hundreds -- `22` is `GC22`, `136` is `GW36`, `206` is `GF06` -- and the engine
turns those into the id space `EXECUTABLE.md` 7.2 describes.  `rh01`'s script
names 22, 136, 137 and 206, and `RH01_ATH.ARC` ships exactly `gc22.smi`,
`gw36.smi`, `gw37.smi` and `gf06.smi`.

    python stagescript.py 0        # what stage M000 is told to contain
    python stagescript.py --check  # every stage script on the disc
"""
import math
import re
import sys

import ssc

OP_LABEL = 0x1D
OP_MAP = 0x1E
OP_PLAYER = 0x1F
OP_GIMMICK = 0x21
OP_GIMMICK2 = 0x22
OP_PLACE = 0x23
OP_ACTOR_MODEL = 0x29
OP_ACTOR_AT = 0x2B

# Both placement handlers add this before using Y.
PLACE_Y_BIAS = 0.5

GROUPS = 'CWF'
GIMMICK_BASES = (0x30, 0x70, 0xB0)   # GC, GW, GF -- EXECUTABLE.md 7.2


def gimmick_id(n):
    """A script's decimal gimmick number -> the engine's id, or None.

    `FUN_001DAE60`: `< -1` is nothing, `< 100` adds `0x30`, `< 200` adds
    `0x0C`, and anything else subtracts `0x18`.
    """
    n = int(n)
    if n < -1:
        return None
    if n < 100:
        return n + 0x30
    if n < 200:
        return n + 0x0C
    return n - 0x18


def gimmick_name(engine_id):
    """`0x46` -> `GC22`, the archive stem."""
    if engine_id is None:
        return None
    for i, base in enumerate(GIMMICK_BASES):
        if base <= engine_id < base + 0x40:
            return 'G%s%02d' % (GROUPS[i], engine_id - base)
    return None


def wrap_angle(a):
    """`[-pi, pi]`, the way both placement handlers do it."""
    a = float(a)
    if a > math.pi:
        return math.fmod(a + math.pi, 2 * math.pi) - math.pi
    if a < -math.pi:
        return math.fmod(a - math.pi, 2 * math.pi) + math.pi
    return a


def _num(a):
    if isinstance(a, tuple):
        if a[0] == 'c2':
            return a[1] / a[2] if a[2] else float(a[1])
        return float(a[1])
    return float(a) if isinstance(a, (int, float)) else 0.0


def _int(a):
    return int(_num(a))


def _str(a):
    return a.decode('latin1') if isinstance(a, bytes) else ''


class Placement:
    __slots__ = ('op', 'slot', 'number', 'gimmick', 'name', 'pos', 'rot', 'extra')

    def __init__(self, op, slot, number, pos, rot, extra):
        self.op = op
        self.slot = slot
        self.number = number
        self.gimmick = gimmick_id(number)
        self.name = gimmick_name(self.gimmick)
        self.pos = pos
        self.rot = rot
        self.extra = extra

    @property
    def archive(self):
        return 'DATA/GIMMICK/%s.ARC' % self.name if self.name else None

    def __repr__(self):
        return '<%s %s at (%g, %g, %g) rot=%g>' % (
            self.name or ('#%d' % self.number), 'gimmick',
            self.pos[0], self.pos[1], self.pos[2], self.rot)


class StageScript:
    def __init__(self, number, archive):
        self.number = number
        self.archive = archive
        self.map_index = None
        self.player = None        # {'pos', 'angle'}
        self.actors = []          # [{'model', 'id', 'pos', 'angle'}]
        self.rooms = {}           # {'rh01': [Placement, ...]}
        self.labels = []
        self.unknown = {}         # opcode -> count, for what is still unread

    def __repr__(self):
        return '<%s map=%s player=%s %d actors, %d rooms, %d placements>' % (
            self.archive.rsplit('/', 1)[-1], self.map_index,
            'yes' if self.player else 'no', len(self.actors), len(self.rooms),
            sum(len(v) for v in self.rooms.values()))


def _run_master(blob, out):
    pending_model = None
    for _off, opf, args in ssc.parse(blob):
        if opf is None:
            continue
        op = opf[0]
        if op == OP_LABEL:
            out.labels.append(_str(args[0]) if args else '')
        elif op == OP_MAP and args:
            out.map_index = _int(args[0])
        elif op == OP_PLAYER and len(args) >= 4:
            out.player = {'pos': (_num(args[0]),
                                  _num(args[1]) + PLACE_Y_BIAS,
                                  _num(args[2])),
                          'angle': wrap_angle(_num(args[3]))}
        elif op == OP_ACTOR_MODEL and args:
            pending_model = _str(args[0])
        elif op == OP_ACTOR_AT and len(args) >= 5:
            out.actors.append({
                'model': pending_model,
                'id': _int(args[0]),
                'pos': (_num(args[1]), _num(args[2]) + PLACE_Y_BIAS,
                        _num(args[3])),
                'angle': wrap_angle(_num(args[4])),
                'extra': [_num(a) for a in args[5:]],
            })
        elif op not in (OP_MAP, OP_PLAYER, OP_LABEL):
            out.unknown[op] = out.unknown.get(op, 0) + 1


def _run_room(blob, out, room):
    placed = out.rooms.setdefault(room, [])
    for _off, opf, args in ssc.parse(blob):
        if opf is None:
            continue
        op = opf[0]
        if op in (OP_GIMMICK, OP_GIMMICK2) and len(args) >= 5:
            # `0x21` reads a rotation after the position and `0x22` does not,
            # so the sixth argument is an angle in one and just another number
            # in the other.  Reading it as an angle either way would spin
            # every `0x22` gimmick by whatever happened to be there.
            keyed = op == OP_GIMMICK and len(args) > 5
            placed.append(Placement(
                op, _int(args[0]), _int(args[1]),
                (_num(args[2]), _num(args[3]), _num(args[4])),
                wrap_angle(_num(args[5])) if keyed else 0.0,
                [_num(a) for a in args[(6 if keyed else 5):]]))
        elif op == OP_PLACE:
            continue
        else:
            out.unknown[op] = out.unknown.get(op, 0) + 1


EVSUB_RE = re.compile(r'^evsub_(r[hpc]\d+)\.ssc$')


def parse(members, number=-1, archive=''):
    """`{member name: blob}` from one `B##EVENT.ARC` -> a `StageScript`."""
    out = StageScript(number, archive)
    for name, blob in sorted(members.items()):
        low = name.lower()
        if EVSUB_RE.match(low):
            continue
        if low.endswith('event.ssc'):
            _run_master(blob, out)
    for name, blob in sorted(members.items()):
        m = EVSUB_RE.match(name.lower())
        if m:
            _run_room(blob, out, m.group(1))
    return out


def load(disc, path):
    import arc as arc_mod
    blob = disc.read(path)
    if blob is None:
        raise ValueError('no such stage script: %s' % path)
    members = {n.lower(): blob[o:o + s] for n, o, s in arc_mod.entries(blob)}
    return parse(members, archive=path)


def for_stage(disc, stage_id):
    """The script for a story stage id, via `stage.stage_map_table`."""
    import stage as stage_mod
    table = stage_mod.stage_map_table(disc)
    row = table.get(stage_id)
    if row is None:
        raise ValueError('no stage %d' % stage_id)
    out = load(disc, row['script'])
    out.number = stage_id
    return out


# ---------------------------------------------------------------- self-check

def _check(disc):
    import arc as arc_mod
    import stage as stage_mod
    table = stage_mod.stage_map_table(disc)
    bad = 0
    total_placed = 0
    mismatch = 0
    for sid in sorted(table):
        row = table[sid]
        sc = load(disc, row['script'])
        # The script's own `0x1E` is the map index, which is the same thing
        # `stage.py` derives from the rooms the archive names.  They are two
        # independent readings of the same fact, so they must agree.
        if sc.map_index != row['map']:
            mismatch += 1
            print('stage %d: script says map %s, the rooms say M%03d'
                  % (sid, sc.map_index, row['map']))
        if sc.player is None:
            bad += 1
            print('stage %d (%s): no player placement'
                  % (sid, row['script'].rsplit('/', 1)[-1]))
        for room, placed in sc.rooms.items():
            total_placed += len(placed)
            # Every gimmick a room places should be in the room's own `_ATH`
            # archive, which is where its models live.
            ath = disc.read('DATA/ROOM/%s_ATH.ARC' % room.upper())
            have = set()
            if ath:
                try:
                    have = {n.lower().rsplit('.', 1)[0]
                            for n, _o, _s in arc_mod.entries(ath)}
                except Exception:
                    have = set()
            for p in placed:
                if p.name is None:
                    bad += 1
                    print('stage %d %s: gimmick number %d maps to nothing'
                          % (sid, room, p.number))
                elif have and not any(h.startswith(p.name.lower()) for h in have):
                    bad += 1
                    print('stage %d %s: places %s, which the room does not ship'
                          % (sid, room, p.name))
    print('%d stage scripts, %d placements, %d problems, %d map disagreements'
          % (len(table), total_placed, bad, mismatch))
    return 1 if bad or mismatch else 0


def main():
    import os
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import scene as scene_mod
    disc = scene_mod.Disc()
    args = sys.argv[1:]
    if not args or args[0] == '--check':
        return _check(disc)
    sc = for_stage(disc, int(args[0]))
    print('stage %d: %s' % (sc.number, sc.archive))
    print('  map        M%03d' % sc.map_index if sc.map_index is not None
          else '  map        -')
    if sc.player:
        print('  player     (%g, %g, %g) facing %.2f rad'
              % (sc.player['pos'][0], sc.player['pos'][1], sc.player['pos'][2],
                 sc.player['angle']))
    for a in sc.actors:
        print('  actor      %-10s id=%d at (%g, %g, %g) facing %.2f'
              % (a['model'], a['id'], a['pos'][0], a['pos'][1], a['pos'][2],
                 a['angle']))
    for room in sorted(sc.rooms):
        print('  %s' % room)
        for p in sc.rooms[room]:
            print('      %-6s (#%3d)  (%7.1f, %6.1f, %7.1f)  rot %5.2f  %s'
                  % (p.name, p.number, p.pos[0], p.pos[1], p.pos[2], p.rot,
                     p.extra))
    if sc.unknown:
        print('  opcodes not read: %s'
              % ' '.join('%02x:%d' % kv for kv in sorted(sc.unknown.items())))
    return 0


if __name__ == '__main__':
    sys.exit(main())
