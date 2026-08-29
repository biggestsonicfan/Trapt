"""Trapt (SLUS-21255) `.CAM` camera-track reader.

A `.CAM` is a plain bundle of per-frame channels.  Unlike `.SAI` it carries no
magic and no names -- just a channel directory, and every record ends with its
own timestamp:

    0x00 u32   flags (0 on every file on the disc)
    0x04       {u32 count, u32 offset} x 4      -- the channel directory
    0x24 u32   padding; payload always starts at 0x28

    channel record: float[stride-1] value, float time   (time is 1-based frame)

An absent channel has ``count == 0`` and its offset parked at end of file.
The stride is not stored -- derive it from the gap to the next present
channel's offset (the last one runs to end of file) divided by the record
count.  Of the 268 `.CAM` on the disc, 165 use all four channels and 66 carry
position and target only.

Channels, in order:

===  ======  =====================================
ch   floats  meaning
===  ======  =====================================
 0     3+t   camera position (x, y, z)
 1     3+t   look-at target  (x, y, z)
 2     1+t   roll / bank, radians (usually one key)
 3     1+t   vertical field of view in degrees
===  ======  =====================================

`e001.cam` is 11889 frames of position and target at 40 degrees FOV and zero
roll -- one baked key per frame, no interpolation needed.
"""
import struct

POSITION, TARGET, ROLL, FOV = 0, 1, 2, 3
CHANNEL_NAMES = ('position', 'target', 'roll', 'fov')
SLOTS = 4          # channel directory entries, always four
HEADER = 0x28      # payload always starts here


class Channel:
    __slots__ = ('index', 'width', 'times', 'values')

    def __init__(self, index, width, times, values):
        self.index = index
        self.width = width
        self.times = times
        self.values = values

    def sample(self, t):
        """Linearly interpolated value at frame `t` (a tuple of `width` floats)."""
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
        f = 0.0 if span == 0 else (t - ts[lo]) / span
        return tuple(a + (b - a) * f for a, b in zip(vs[lo], vs[hi]))

    def __repr__(self):
        return '<Channel %d, %d floats, %d keys>' % (self.index, self.width,
                                                     len(self.times))


class Track:
    __slots__ = ('flags', 'channels')

    def duration(self):
        return max((c.times[-1] for c in self.channels if c and c.times), default=0.0)

    def get(self, index):
        """The channel in that slot, or None when the file omits it."""
        return self.channels[index] if index < len(self.channels) else None

    def sample(self, frame):
        """``{'position': (x,y,z), 'target': (x,y,z), 'roll': r, 'fov': deg}``."""
        out = {}
        for i, name in enumerate(CHANNEL_NAMES):
            ch = self.get(i)
            if ch is None:
                continue
            v = ch.sample(frame)
            out[name] = v if len(v) > 1 else v[0]
        return out

    def __repr__(self):
        return '<Track %d channels, %g frames>' % (len(self.channels), self.duration())


def parse(data):
    """Parse a `.CAM` blob into a `Track`."""
    if len(data) < HEADER:
        raise ValueError('too short for a CAM header')
    track = Track()
    track.flags, = struct.unpack_from('<I', data, 0)

    present = []
    for i in range(SLOTS):
        count, off = struct.unpack_from('<2I', data, 4 + 8 * i)
        if count == 0:
            continue
        if off < HEADER or off > len(data):
            raise ValueError('channel %d offset %#x out of range' % (i, off))
        present.append((off, count, i))
    if not present:
        raise ValueError('no channels')
    present.sort()
    if present[0][0] != HEADER:
        raise ValueError('channel data starts at %#x, expected %#x'
                         % (present[0][0], HEADER))

    ends = [p[0] for p in present[1:]] + [len(data)]
    track.channels = [None] * SLOTS
    for (off, count, index), end in zip(present, ends):
        span = end - off
        if span % count:
            raise ValueError('channel %d: %d bytes does not divide %d records'
                             % (index, span, count))
        nfloats = (span // count) // 4
        if nfloats < 2:
            raise ValueError('channel %d: record of %d floats' % (index, nfloats))
        times, values = [], []
        for k in range(count):
            rec = struct.unpack_from('<%df' % nfloats, data, off + k * nfloats * 4)
            values.append(rec[:-1])
            times.append(rec[-1])
        track.channels[index] = Channel(index, nfloats - 1, times, values)
    return track


def main():
    import sys
    track = parse(open(sys.argv[1], 'rb').read())
    print('flags=%d, %d channels, %g frames' % (track.flags, len(track.channels),
                                                track.duration()))
    for i, ch in enumerate(track.channels):
        name = CHANNEL_NAMES[i] if i < len(CHANNEL_NAMES) else 'ch%d' % i
        if ch is None:
            print('  %-9s absent' % name)
            continue
        print('  %-9s %d floats, %6d keys, t=%g..%g'
              % (name, ch.width, len(ch.times), ch.times[0], ch.times[-1]))
    for frame in (1, track.duration() / 2, track.duration()):
        s = track.sample(frame)
        print('  frame %-8g %s' % (frame, {k: (tuple(round(x, 3) for x in v)
                                               if isinstance(v, tuple) else round(v, 3))
                                           for k, v in s.items()}))


if __name__ == '__main__':
    main()
