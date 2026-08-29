"""Decode a `.sli` room light set.

Every `DATA/ROOM/<room>_ALL.ARC` ships one.  It holds the lights the room is
lit by -- and, in particular, the **direction** of its directional lights,
which is the one thing a cutscene's own `.ssc` light rig never records.  The
game reads it in `FUN_001D4430` (ELF): a `0xB4` light block of kind 0 with no
direction of its own sums the room's directional lights and normalises.

    python sli.py rp03            # dump one room's lights

Layout, fixed 0x50 per record::

    0x00 u32    version (1)          0x08 u32  -> records (always 0x10)
    0x04 u32    count                0x0c u32  0

    RECORD (0x50)
      +0x00 float4   position, or direction when kind == 0
      +0x10 float4   colour
      +0x20 float4   0,0,0,1        (never non-zero on the disc)
      +0x30 float2   range near, far
      +0x38 u32      0
      +0x3c u32      kind -- 0 directional, 1 point, 4 ambient, 5 "black"
      +0x40 char[16] name
"""
import struct
import sys

KINDS = {0: 'directional', 1: 'point', 4: 'ambient', 5: 'black'}


class Light:
    __slots__ = ('vec', 'colour', 'extra', 'range', 'kind', 'name')

    def __init__(self, vec, colour, extra, rng, kind, name):
        self.vec = vec          # world position, or direction when directional
        self.colour = colour
        self.extra = extra
        self.range = rng
        self.kind = kind
        self.name = name

    @property
    def kind_name(self):
        return KINDS.get(self.kind, 'kind%d' % self.kind)

    def __repr__(self):
        return '<%s %s vec=%s colour=%s range=%s>' % (
            self.kind_name, self.name,
            tuple(round(v, 4) for v in self.vec),
            tuple(round(v, 4) for v in self.colour),
            tuple(round(v, 2) for v in self.range))


def parse(blob):
    ver, count, off, zero = struct.unpack_from('<4I', blob, 0)
    if off + count * 0x50 > len(blob):
        raise ValueError('sli: %d records at 0x%x overruns %d bytes'
                         % (count, off, len(blob)))
    out = []
    for i in range(count):
        b = off + i * 0x50
        vec = struct.unpack_from('<4f', blob, b)[:3]
        col = struct.unpack_from('<4f', blob, b + 0x10)[:3]
        extra = struct.unpack_from('<4f', blob, b + 0x20)[:3]
        near, far = struct.unpack_from('<2f', blob, b + 0x30)
        kind = struct.unpack_from('<I', blob, b + 0x3c)[0]
        name = blob[b + 0x40:b + 0x50].split(b'\0')[0].decode('ascii', 'replace')
        out.append(Light(vec, col, extra, (near, far), kind, name))
    return out


def infinite_direction(lights):
    """The direction a `0xB4` kind-0 block with no direction inherits.

    `FUN_001D4430` walks the room's light list, sums the directional entries
    and normalises.  Returns None when the room has none.
    """
    sx = sy = sz = 0.0
    for l in lights:
        if l.kind == 0:
            sx += l.vec[0]
            sy += l.vec[1]
            sz += l.vec[2]
    n = (sx * sx + sy * sy + sz * sz) ** 0.5
    return (sx / n, sy / n, sz / n) if n > 1e-9 else None


def main():
    import os
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import scene as scene_mod
    disc = scene_mod.Disc()
    if len(sys.argv) > 1 and sys.argv[1] != '--all':
        room = sys.argv[1].upper()
        blob = disc.members('DATA/ROOM/%s_ALL.ARC' % room).get('%s.sli' % room.lower())
        if blob is None:
            raise SystemExit('no %s.sli' % room.lower())
        lights = parse(blob)
        for l in lights:
            print(' ', l)
        print('inherited directional:', infinite_direction(lights))
        return 0
    ok = bad = 0
    counts = {}
    for path in disc.glob('DATA/ROOM/'):
        for name, blob in disc.members(path).items():
            if not name.endswith('.sli'):
                continue
            try:
                for l in parse(blob):
                    counts[l.kind] = counts.get(l.kind, 0) + 1
                ok += 1
            except Exception as exc:
                bad += 1
                print('FAIL %s/%s: %s' % (path, name, exc))
    print('%d parsed, %d failed; kinds %s' % (ok, bad, counts))
    return 0


if __name__ == '__main__':
    sys.exit(main())
