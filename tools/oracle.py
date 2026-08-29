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
# There is more than one of these.  The attract loop's camera is at CAM_EYE;
# a story cutscene's is 0x40 further on, and the first address reads as `0x7c`
# filler while it plays -- which is why every story capture used to come back
# "not in a cutscene".  Both are static, 0x10 apart within a slot, so try each
# and let the residual say which one was live.
CAM_SLOTS = (0x0081B6F0, 0x0081B730)
EE_MASK = 0x01FFFFFF

STATE_DIR = os.path.join(os.path.expanduser('~'), 'OneDrive', 'Documents',
                         'PCSX2', 'sstates')
ALT_STATE_DIR = os.path.join(os.path.expanduser('~'), 'Documents', 'PCSX2',
                             'sstates')

# Anything outside this is not a coordinate in any room on the disc.
SANE = 100000.0

# A right answer sits at 1e-06 and the nearest wrong one seen is 8 world
# units, so this separates them without being tuned to either.
MATCH_MAX = 1.0

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

    def camera_at(self, addr):
        """`(eye, target)` for one camera slot, or None if it holds rubbish."""
        eye = self.vec4(addr)
        target = self.vec4(addr + 0x10)
        for v in (eye, target):
            for c in v[:3]:
                if not (-SANE < c < SANE):
                    return None
        # A camera looking at itself is a cleared slot, not a shot.  The zero
        # one matches some cutscene or other at a residual of 14 if you let it.
        if _dist(eye[:3], target[:3]) < 1e-6:
            return None
        return eye[:3], target[:3]

    @property
    def cameras(self):
        """Every slot that holds something that could be a camera."""
        return [(a, c) for a in CAM_SLOTS
                for c in [self.camera_at(a)] if c is not None]

    @property
    def camera(self):
        """`(eye, target)` as 3-vectors, or None when the state is not in one."""
        got = self.cameras
        return got[0][1] if got else None

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
    out = {'path': path, 'state': st, 'camera': None, 'slot': None,
           'cutscene': None, 'frame': None, 'residual': None}
    # Try every slot and let the residual pick: which one is live depends on
    # whether this is the attract loop or the story, and a stale slot can
    # still hold a plausible-looking camera from whatever ran last.
    for addr, cam in st.cameras:
        got = match(disc, cam[0], cam[1], names)
        if got and got[2] <= MATCH_MAX and (out['residual'] is None
                                            or got[2] < out['residual']):
            out['camera'], out['slot'] = cam, addr
            out['cutscene'], out['frame'], out['residual'] = got
    return out


class Pine:
    """The smallest possible PINE client: batched 64-bit reads, and save-state.

    PCSX2 listens on 28011 and takes **one** client, so nothing else may hold
    it -- the MCP server does when it is running.  The protocol is
    `[u32 size][cmd]...` in and `[u32 size][u8 status][data]...` back, and
    many commands ride in one message.

        MsgRead64  = 0x03, payload u8 op + u32 addr -> 8 bytes
        MsgSaveState = 0x09, payload u8 slot
    """

    READ64 = 0x03
    SAVESTATE = 0x09

    def __init__(self, host='127.0.0.1', port=28011, timeout=15.0):
        import socket
        self.sock = socket.create_connection((host, port), timeout)
        self.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)

    def close(self):
        try:
            self.sock.close()
        except Exception:
            pass

    def _send(self, payload):
        head = struct.pack('<I', len(payload) + 4)
        self.sock.sendall(head + payload)
        acc = b''
        try:
            while len(acc) < 4:
                acc += self.sock.recv(4096)
        except Exception:
            # PINE takes one client at a time.  The socket still *accepts*
            # when somebody else already has it -- a debug server, an MCP
            # bridge -- and then simply never answers, which reads as a plain
            # timeout and has cost fifteen minutes of waiting before now.
            raise IOError(
                'PINE accepted the connection but never replied.  It takes '
                'one client at a time, so close whatever else is attached '
                '(a PCSX2 MCP server holds it) and try again.')
        size = struct.unpack_from('<I', acc, 0)[0]
        while len(acc) < size:
            acc += self.sock.recv(65536)
        if acc[4] != 0:
            raise IOError('PINE status 0x%02x' % acc[4])
        return acc[5:size]

    def read(self, addr, length):
        words = (length + 7) // 8
        out = b''
        per = 512
        for i in range(0, words, per):
            n = min(per, words - i)
            req = b''.join(struct.pack('<BI', self.READ64, addr + (i + k) * 8)
                           for k in range(n))
            got = self._send(req)
            if len(got) < n * 8:
                raise IOError('short PINE reply')
            out += got[:n * 8]
        return out[:length]

    def camera_at(self, addr):
        b = self.read(addr, 0x20)
        eye = struct.unpack_from('<3f', b, 0)
        target = struct.unpack_from('<3f', b, 0x10)
        for v in (eye, target):
            for c in v:
                if not (-SANE < c < SANE):
                    return None
        if _dist(eye, target) < 1e-6:
            return None
        return eye, target

    @property
    def cameras(self):
        """Every slot that currently holds something camera-shaped."""
        return [(a, c) for a in CAM_SLOTS
                for c in [self.camera_at(a)] if c is not None]

    def camera(self):
        got = self.cameras
        return got[0][1] if got else None

    def save_state(self, slot):
        self._send(struct.pack('<BB', self.SAVESTATE, slot & 0xFF))


def track_for(disc, name):
    """One cutscene's `.cam`, or None."""
    import arc as arc_mod
    import cam as cam_mod
    up = name.upper()
    blob = disc.read('DATA/RT/%s/RT_%s.ARC' % (up, up))
    if blob is None:
        return None
    members = {n.lower(): (o, s) for n, o, s in arc_mod.entries(blob)}
    got = members.get('%s.cam' % name.lower())
    if got is None:
        return None
    return cam_mod.parse(blob[got[0]:got[0] + got[1]])


def watch(disc, name, slot=5, lo=None, hi=None, timeout=600.0):
    """Wait until the game is playing `name`, then save a state.

    Matching only that one cutscene's track makes each poll cheap, so this can
    sit on the wire while somebody plays towards the moment wanted.  `lo`/`hi`
    narrow it to a frame window -- an effect is usually only up for a second
    or two, and `--effects` says when.
    """
    import time
    track = track_for(disc, name)
    if track is None:
        raise ValueError('no camera track for %s' % name)
    n = int(track.duration())
    pine = Pine()
    deadline = time.time() + timeout
    try:
        while time.time() < deadline:
            # Every slot, not just the first: during a story cutscene the
            # attract loop's slot can still hold a stale but plausible camera,
            # and taking that one would wait here for ever.
            live = pine.cameras
            if not live:
                time.sleep(0.15)
                continue
            best = None
            for _addr, (eye, target) in live:
                for f in range(1, n + 1, COARSE):
                    s = track.sample(f)
                    if not s or not s.get('position') or not s.get('target'):
                        continue
                    r = _dist(s['position'], eye) + _dist(s['target'], target)
                    if best is None or r < best[1]:
                        best = (f, r, eye, target)
            if best and best[1] < MATCH_MAX:
                eye, target = best[2], best[3]
                f0 = max(1, best[0] - COARSE)
                for f in range(f0, min(n, best[0] + COARSE) + 1):
                    s = track.sample(f)
                    if not s or not s.get('position') or not s.get('target'):
                        continue
                    r = _dist(s['position'], eye) + _dist(s['target'], target)
                    if r < best[1]:
                        best = (f, r, eye, target)
                frame = best[0]
                if (lo is None or frame >= lo) and (hi is None or frame <= hi):
                    pine.save_state(slot)
                    return {'cutscene': name, 'frame': frame,
                            'residual': best[1], 'slot': slot}
            time.sleep(0.1)
    finally:
        pine.close()
    return None


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
    argv = sys.argv[1:]

    def opt(flag, default=None, cast=str):
        if flag not in argv:
            return default
        i = argv.index(flag)
        return cast(argv[i + 1]) if i + 1 < len(argv) else default

    # Every flag that takes a value, so its value is not mistaken for a path.
    VALUED = ('--shot', '--watch', '--from', '--to', '--slot', '--timeout')
    taken = {argv.index(f) + 1 for f in VALUED if f in argv}
    args = [a for i, a in enumerate(argv)
            if not a.startswith('--') and i not in taken]

    if '--watch' in argv:
        name = opt('--watch')
        lo, hi = opt('--from', None, int), opt('--to', None, int)
        slot = opt('--slot', 5, int)
        print('waiting for %s%s -- play towards it; ctrl-c to give up'
              % (name, '' if lo is None else ' frames %s..%s' % (lo, hi)))
        try:
            got = watch(disc, name, slot=slot, lo=lo, hi=hi,
                        timeout=opt('--timeout', 600.0, float))
        except Exception as exc:
            print('could not watch: %s' % exc)
            return 1
        if not got:
            print('timed out without seeing it')
            return 1
        print('caught %s frame %d (residual %.2e) -> slot %d'
              % (got['cutscene'], got['frame'], got['residual'], got['slot']))
        return 0

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

    shot = opt('--shot', 'shot.png' if '--shot' in argv else None)
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
