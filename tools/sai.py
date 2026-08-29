"""Trapt (SLUS-21255) `.SAI` skeletal-animation reader.

A `.SAI` holds one animation clip: a flat list of nodes (bone names matching
the `.SMI` skeleton), each with up to three keyed channels.

    0x00 u32   magic 0x20030818        (shared build stamp; see tools/README.md)
    0x04 u32   file size
    0x08 u16   node count
    0x0a u16   ? (0..~300, not needed for playback)
    0x0c u32   -> node array (always 0x14)
    0x10 u32   0

    NODE (stride 0x30)
      +0x00 u32       duration in frames
      +0x04 char[32]  node name -- matches a `.SMI` node
      +0x24 u32       -> rotation    channel descriptor (0 = absent)
      +0x28 u32       -> translation channel descriptor
      +0x2c u32       -> scale       channel descriptor

    CHANNEL DESCRIPTOR (stride 0x10, packed right after the node array)
      +0x00 u32  duration
      +0x04 u16  key count
      +0x06 u16  0xaaaa
      +0x08 u32  -> times  : u16[count], ascending, in frames
      +0x0c u32  -> values : float4[count]

Rotations are **unit quaternions in (x, y, z, w) order**, in the
column-vector convention -- i.e. the transpose of the row-vector 4x4 stored in
the `.SMI` node.  Translations and scales are `(x, y, z, 1.0)`.

A node with no translation channel keeps the translation from its `.SMI` bind
matrix; that is how the format gets away with rotation-only clips.

Verified against every `.SAI` on the disc: 18818/18818 parse, all times
ascending and inside the clip, all rotation keys unit length, all translation
and scale keys w == 1.
"""
import math
import struct

MAGIC = 0x20030818
NODE_STRIDE = 0x30
CHAN_STRIDE = 0x10
CHAN_MARK = 0xAAAA

ROT, POS, SCL = 0, 1, 2
CHANNEL_NAMES = ('rotation', 'translation', 'scale')


class Channel:
    __slots__ = ('kind', 'duration', 'times', 'values')

    def __init__(self, kind, duration, times, values):
        self.kind = kind
        self.duration = duration
        self.times = times
        self.values = values

    def sample(self, t):
        """Value at frame `t`; slerp for rotation, lerp otherwise."""
        ts, vs = self.times, self.values
        if not ts:
            return None
        if t <= ts[0]:
            return vs[0]
        if t >= ts[-1]:
            return vs[-1]
        lo, hi = 0, len(ts) - 1
        while hi - lo > 1:
            mid = (lo + hi) // 2
            if ts[mid] <= t:
                lo = mid
            else:
                hi = mid
        span = ts[hi] - ts[lo]
        f = 0.0 if span == 0 else (t - ts[lo]) / float(span)
        return (slerp(vs[lo], vs[hi], f) if self.kind == ROT
                else tuple(a + (b - a) * f for a, b in zip(vs[lo], vs[hi])))

    def __repr__(self):
        return '<Channel %s %d keys>' % (CHANNEL_NAMES[self.kind], len(self.times))


class Node:
    __slots__ = ('name', 'duration', 'channels')

    def __init__(self, name, duration):
        self.name = name
        self.duration = duration
        self.channels = {}

    def __repr__(self):
        return '<Node %r %s>' % (self.name, sorted(self.channels))


class Clip:
    __slots__ = ('duration', 'nodes')

    def __init__(self):
        self.duration = 0
        self.nodes = []

    def by_name(self):
        return {n.name: n for n in self.nodes}

    def __repr__(self):
        return '<Clip %d nodes, %d frames>' % (len(self.nodes), self.duration)


def slerp(a, b, f):
    d = sum(x * y for x, y in zip(a, b))
    if d < 0.0:
        b, d = tuple(-x for x in b), -d
    if d > 0.9995:
        out = tuple(x + (y - x) * f for x, y in zip(a, b))
        n = math.sqrt(sum(x * x for x in out)) or 1.0
        return tuple(x / n for x in out)
    th = math.acos(max(-1.0, min(1.0, d)))
    s = math.sin(th)
    wa, wb = math.sin((1.0 - f) * th) / s, math.sin(f * th) / s
    return tuple(x * wa + y * wb for x, y in zip(a, b))


def quat_to_matrix(q):
    """(x,y,z,w) -> row-major 4x4 in the same row-vector convention as `.SMI`."""
    x, y, z, w = q
    return [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0.0,
            2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0.0,
            2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0.0,
            0.0, 0.0, 0.0, 1.0]


def matrix_to_quat(m):
    """Inverse of `quat_to_matrix`; `m` is a row-major 4x4 (or 3x3) list."""
    if len(m) == 16:
        m = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]]
    m00, m01, m02, m10, m11, m12, m20, m21, m22 = m
    t = m00 + m11 + m22
    if t > 0:
        s = math.sqrt(t + 1.0) * 2
        q = ((m12 - m21) / s, (m20 - m02) / s, (m01 - m10) / s, 0.25 * s)
    elif m00 > m11 and m00 > m22:
        s = math.sqrt(1.0 + m00 - m11 - m22) * 2
        q = (0.25 * s, (m10 + m01) / s, (m20 + m02) / s, (m12 - m21) / s)
    elif m11 > m22:
        s = math.sqrt(1.0 + m11 - m00 - m22) * 2
        q = ((m10 + m01) / s, 0.25 * s, (m21 + m12) / s, (m20 - m02) / s)
    else:
        s = math.sqrt(1.0 + m22 - m00 - m11) * 2
        q = ((m20 + m02) / s, (m21 + m12) / s, 0.25 * s, (m01 - m10) / s)
    n = math.sqrt(sum(v * v for v in q)) or 1.0
    return tuple(v / n for v in q)


def parse(data):
    """Parse a `.SAI` blob into a `Clip`. Raises ValueError on a bad file."""
    if len(data) < 0x14 or struct.unpack_from('<I', data, 0)[0] != MAGIC:
        raise ValueError('not a SAI (magic %08x)' % struct.unpack_from('<I', data, 0)[0])
    fsize, = struct.unpack_from('<I', data, 4)
    count, = struct.unpack_from('<H', data, 8)
    node_off, zero = struct.unpack_from('<2I', data, 0x0C)
    if node_off != 0x14 or zero != 0:
        raise ValueError('unexpected SAI header')

    clip = Clip()
    for i in range(count):
        p = node_off + i * NODE_STRIDE
        duration, = struct.unpack_from('<I', data, p)
        name = data[p + 4:p + 0x24].split(b'\0')[0].decode('latin1')
        node = Node(name, duration)
        for kind, cp in enumerate(struct.unpack_from('<3I', data, p + 0x24)):
            if not cp:
                continue
            cdur, nkeys, mark, t_off, v_off = struct.unpack_from('<IHHII', data, cp)
            if mark != CHAN_MARK:
                raise ValueError('bad channel marker %04x at %#x' % (mark, cp))
            times = list(struct.unpack_from('<%dH' % nkeys, data, t_off))
            values = [struct.unpack_from('<4f', data, v_off + 16 * k)
                      for k in range(nkeys)]
            node.channels[kind] = Channel(kind, cdur, times, values)
        clip.nodes.append(node)
        clip.duration = max(clip.duration, duration)
    if fsize > len(data):
        raise ValueError('truncated SAI (%d < %d)' % (len(data), fsize))
    return clip


def pose(clip, frame):
    """Sample the whole clip: ``{name: {ROT/POS/SCL: value}}``."""
    out = {}
    for node in clip.nodes:
        vals = {}
        for kind, ch in node.channels.items():
            v = ch.sample(frame)
            if v is not None:
                vals[kind] = v
        if vals:
            out[node.name] = vals
    return out


def main():
    import sys
    clip = parse(open(sys.argv[1], 'rb').read())
    print('%d nodes, %d frames' % (len(clip.nodes), clip.duration))
    for node in clip.nodes:
        chans = ', '.join('%s:%d keys' % (CHANNEL_NAMES[k], len(c.times))
                          for k, c in sorted(node.channels.items()))
        print('  %-16s %s' % (node.name, chans))


if __name__ == '__main__':
    main()
