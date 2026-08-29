"""Ground truth: what a PCSX2 savestate is a picture *of*.

A `.p2s` is a zip, and two of its members make it an oracle:

    eeMemory.bin     32 MB of EE RAM -- the live game state
    Screenshot.png   what the GS actually put on screen at that instant

The screenshot is only useful if you know which frame of which cutscene it is,
and the game does not write that down anywhere convenient.  What it does write
down is the **camera**: a live eye/target pair at EE `0x0081B6F0`, updated
every frame from the `.CAM` track the cutscene is playing.  So the frame can
be recovered by matching that pair against all 268 camera tracks on the disc
and taking the best fit -- there is no ambiguity, because a camera path is a
signature.

    python oracle.py                          # identify every savestate
    python oracle.py <state.p2s>              # one, in detail
    python oracle.py <state.p2s> --shot out.png   # and save its screenshot

`e001`'s slot-08 state comes back as frame 7422 at a residual of 4.7e-06,
which is the answer `docs/VIEWER.md` 4 already had by hand -- so a run that
reproduces it is a self-test of this tool, not just of the savestate.

**A state that is not in a cutscene reads as garbage rather than as zero**:
the camera words hold whatever was last there, often denormals of order 1e37.
`identify` reports those as "not in a cutscene" instead of matching them to
the nearest track by accident.

Why this and not the emulator's own IPC: PINE takes a single client, so
anything else holding it locks everything else out, and it reads one byte per
round trip.  A savestate is free, repeatable, and offline.  See
`docs/PS2SHADER.md`.
"""
import os
import struct
import sys
import zipfile

# The live camera the RT player writes every frame.  Eye, then target,
# forward, right and down at 0x10 steps -- see docs/VIEWER.md 4.
CAM_EYE = 0x0081B6F0
CAM_TARGET = 0x0081B700
EE_MASK = 0x01FFFFFF

STATE_DIR = os.path.join(os.path.expanduser('~'), 'OneDrive', 'Documents',
                         'PCSX2', 'sstates')
ALT_STATE_DIR = os.path.join(os.path.expanduser('~'), 'Documents', 'PCSX2',
                             'sstates')

# Anything outside this is not a coordinate in any room on the disc.
SANE = 100000.0

# Frame stride for the first pass of the search.  A camera path is smooth
# over sixteen frames, so this cannot land in the wrong basin.
COARSE = 16


class State:
    """One `.p2s`, opened lazily."""

    def __init__(self, path):
        self.path = path
        self.zip = zipfile.ZipFile(path)
        self._ee = None

    @property
    def ee(self):
        if self._ee is None:
            self._ee = self.zip.read('eeMemory.bin')
        return self._ee

    def vec4(self, addr):
        return struct.unpack_from('<4f', self.ee, addr & EE_MASK)

    @property
    def camera(self):
        """`(eye, target)` as 3-vectors, or None when the state is not in one."""
        eye = self.vec4(CAM_EYE)
        target = self.vec4(CAM_TARGET)
        for v in (eye, target):
            for c in v[:3]:
                if not (-SANE < c < SANE):
                    return None
        return eye[:3], target[:3]

    def screenshot(self, out_path):
        with open(out_path, 'wb') as f:
            f.write(self.zip.read('Screenshot.png'))
        return out_path

    def has(self, member):
        return member in self.zip.namelist()


def _dist(a, b):
    return sum((x - y) ** 2 for x, y in zip(a, b)) ** 0.5


def match(disc, eye, target, names=None):
    """Best `(cutscene, frame, residual)` for a live camera, over every `.cam`.

    The residual is the sum of the eye and target distances in world units.
    A right answer sits near zero -- `e001`/7422 lands at 4.7e-06 -- and a
    wrong one is tens of units out, so there is no threshold to tune.
    """
    import arc as arc_mod
    import cam as cam_mod
    import order as order_mod
    if names is None:
        names = order_mod.Story().names
    best = None
    for name in names:
        up = name.upper()
        blob = disc.read('DATA/RT/%s/RT_%s.ARC' % (up, up))
        if blob is None:
            continue
        try:
            members = {n.lower(): (o, s) for n, o, s in arc_mod.entries(blob)}
        except Exception:
            continue
        got = members.get('%s.cam' % name)
        if got is None:
            continue
        try:
            track = cam_mod.parse(blob[got[0]:got[0] + got[1]])
        except Exception:
            continue
        n = int(track.duration())
        if n <= 0:
            continue

        def at(frame):
            s = track.sample(frame)
            if not s or not s.get('position') or not s.get('target'):
                return None
            return _dist(s['position'], eye) + _dist(s['target'], target)

        # Two passes: every COARSE-th frame to find the neighbourhood, then
        # every frame around the winner.  A camera path is smooth over 16
        # frames, so the coarse pass cannot land in the wrong basin -- and
        # scanning all 1.1M frames on the disc one at a time is a minute of
        # nothing.
        local = None
        for frame in range(1, n + 1, COARSE):
            r = at(frame)
            if r is not None and (local is None or r < local[1]):
                local = (frame, r)
        if local is None:
            continue
        lo = max(1, local[0] - COARSE)
        hi = min(n, local[0] + COARSE)
        for frame in range(lo, hi + 1):
            r = at(frame)
            if r is not None and (local is None or r < local[1]):
                local = (frame, r)
        if best is None or local[1] < best[2]:
            best = (name, local[0], local[1])
    return best


def identify(disc, path, names=None):
    """`{path, camera, cutscene, frame, residual}` for one savestate."""
    st = State(path)
    out = {'path': path, 'state': st, 'camera': st.camera,
           'cutscene': None, 'frame': None, 'residual': None}
    if out['camera'] is None:
        return out
    eye, target = out['camera']
    got = match(disc, eye, target, names)
    if got:
        out['cutscene'], out['frame'], out['residual'] = got
    return out


def state_dir():
    for d in (STATE_DIR, ALT_STATE_DIR):
        if os.path.isdir(d):
            return d
    return None


def all_states():
    d = state_dir()
    if not d:
        return []
    return sorted(os.path.join(d, f) for f in os.listdir(d)
                  if f.lower().endswith('.p2s'))


def windows(disc, names=None):
    """When each cutscene's sprite effects are on screen.

    None of the savestates on this machine is in a cutscene that has any, so
    an oracle for the effect work needs a new one -- and it has to be taken
    while the effect is actually up.  This says when, in frames and in seconds
    at 60 fps, so a capture is aimed rather than hunted for.
    """
    import scene as scene_mod
    import order as order_mod
    out = []
    for name in names or order_mod.Story().names:
        try:
            sc = scene_mod.load(name)
        except Exception:
            continue
        spans = []
        for e in sc.entities:
            if not e.sprite:
                continue
            keyed = (e.colour_keys[-1][0] if e.colour_keys
                     else (e.size_keys[-1][0] if e.size_keys else 0))
            life = keyed if keyed > 0 else (e.track_len or 0)
            spans.append((e.start, e.start + life, e.sprite['texture'],
                          len(e.binds)))
        if spans:
            out.append((name, sorted(spans)))
    return out


def main():
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import scene as scene_mod
    disc = scene_mod.Disc()
    args = [a for a in sys.argv[1:] if not a.startswith('--')]

    if '--effects' in sys.argv:
        print('%-9s %-16s %7s %7s %8s  %s'
              % ('scene', 'texture', 'from', 'to', 'at 60fps', 'bones'))
        for name, spans in windows(disc):
            for start, end, tex, binds in spans:
                print('%-9s %-16s %7d %7s %8s  %s'
                      % (name, tex, start,
                         end if end > start else '(open)',
                         '%d:%05.2f' % (start // 3600, (start % 3600) / 60.0),
                         binds or ''))
        return 0

    shot = None
    if '--shot' in sys.argv:
        i = sys.argv.index('--shot')
        shot = sys.argv[i + 1] if i + 1 < len(sys.argv) else 'shot.png'

    paths = args or all_states()
    if not paths:
        print('no savestates found; looked in %s' % (state_dir() or STATE_DIR))
        return 1
    for path in paths:
        got = identify(disc, path)
        name = os.path.basename(path)
        if got['camera'] is None:
            print('%-36s not in a cutscene (the camera words are stale)' % name)
            continue
        eye, target = got['camera']
        print('%-36s %s frame %d  residual %.2e' % (
            name, got['cutscene'], got['frame'], got['residual']))
        print('%-36s   eye (%.2f, %.2f, %.2f) -> target (%.2f, %.2f, %.2f)'
              % ('', eye[0], eye[1], eye[2], target[0], target[1], target[2]))
        if shot and got['state'].has('Screenshot.png'):
            got['state'].screenshot(shot)
            print('%-36s   screenshot -> %s' % ('', shot))
    return 0


if __name__ == '__main__':
    sys.exit(main())
