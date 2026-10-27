"""Grade the viewer against PCSX2: one score per savestate, and where it lost.

    python grade.py                         # every state in PCSX2's folder
    python grade.py a.p2s b.p2s --out dir   # these, with a picture of each
    python grade.py --save grade.json       # write the scores down
    python grade.py --baseline grade.json   # and fail if any got worse

`oracle.py` says which frame of which cutscene a savestate is a picture of;
this renders that frame the way the page does (`pdiag.py`, a port of the
page's own shader) at the GS's 512x224 and compares it with the
`Screenshot.png` PCSX2 put in the same state.  Doing that by hand is how
docs/VIEWER.md 5 found four bugs and took e001 7422 from 9.58 to 7.66; this
is the same measurement, run over every capture at once, so a fix is judged
on all of them and a regression is caught rather than noticed.

What a grade says
-----------------
``mae``    mean |viewer - hardware| over every pixel and channel, 0..255.  The
           headline, and the number VIEWER.md 5 quotes.
``bias``   mean (viewer - hardware) per channel.  Positive is too bright.  A
           bias that is most of the mae is a lighting or exposure error, not a
           geometry one.
``edges``  correlation of the two images' gradient magnitude, 1.0 = the same
           outlines.  Low edges with a small bias is geometry: a pose, a
           camera or a missing mesh.
``shift``  the whole-pixel offset that would line the screenshot up best.
           Anything but (0, 0) is a capture or crop problem to rule out
           before believing the rest; the scores are taken unshifted.

and the same three per **region**: every entity the page drew (the room,
each actor), ``overlay`` (the letterbox and subtitles) and ``clear`` (pixels
no geometry covered).  A region's ``share`` is how much of the frame's total
error is there, which is the list to work down.

The screenshot is taken at whatever size PCSX2 wrote it and resampled to
512x224 -- comparisons are made at the GS's own resolution, never above it
(see docs/VIEWER.md 5 on why point sampling at 640x480 lies).

A state the oracle cannot place -- not in a cutscene, or a cutscene whose
camera it cannot match -- is listed and skipped, not graded against a guess.
"""
import json
import os
import shutil
import sys
import tempfile
import time

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import oracle as oracle_mod
import pdiag
import region as region_mod

GS_SIZE = (512, 224)
# A state counts as worse than its baseline only past this, in mae units --
# pdiag is deterministic, so this is room for numpy, not for noise.
TOLERANCE = 0.05
SHIFT_X, SHIFT_Y = 8, 4


# ------------------------------------------------------------------ images
def hardware_frame(png_bytes):
    """PCSX2's screenshot at the GS's own 512x224, as float RGB 0..255."""
    import io
    im = Image.open(io.BytesIO(png_bytes)).convert('RGB')
    if im.size != GS_SIZE:
        im = im.resize(GS_SIZE, Image.BOX if im.size[0] >= GS_SIZE[0]
                       else Image.BILINEAR)
    return np.asarray(im, np.float64)


def luma(a):
    return a[..., 0] * 0.299 + a[..., 1] * 0.587 + a[..., 2] * 0.114


def gradient(y):
    gx = np.zeros_like(y)
    gy = np.zeros_like(y)
    gx[:, 1:-1] = y[:, 2:] - y[:, :-2]
    gy[1:-1] = y[2:] - y[:-2]
    return np.hypot(gx, gy)


def edge_corr(a, b, mask=None):
    ga, gb = gradient(luma(a)), gradient(luma(b))
    if mask is not None:
        ga, gb = ga[mask], gb[mask]
    ga, gb = ga.ravel(), gb.ravel()
    if ga.size < 16 or ga.std() < 1e-9 or gb.std() < 1e-9:
        return None
    return float(np.corrcoef(ga, gb)[0, 1])


def best_shift(view, hw):
    """The integer `(dx, dy)` that makes `hw` match `view` best, by luma."""
    lv, lh = luma(view), luma(hw)
    H, W = lv.shape
    best = None
    for dy in range(-SHIFT_Y, SHIFT_Y + 1):
        for dx in range(-SHIFT_X, SHIFT_X + 1):
            a = lv[max(0, dy):H + min(0, dy), max(0, dx):W + min(0, dx)]
            b = lh[max(0, -dy):H + min(0, -dy), max(0, -dx):W + min(0, -dx)]
            e = float(np.abs(a - b).mean())
            if best is None or e < best[0] - 1e-9:
                best = (e, dx, dy)
    return best[1], best[2]


def score(view, hw, mask=None):
    d = view - hw
    if mask is not None:
        d = d[mask]
    d = d.reshape(-1, 3)
    if not len(d):
        return None
    return {'pixels': int(len(d)),
            'mae': round(float(np.abs(d).mean()), 3),
            'bias': [round(float(x), 2) for x in d.mean(0)],
            'error': float(np.abs(d).sum())}


# ------------------------------------------------------------------ render
class Pages:
    """Exported cutscene pages, made on first use and kept for the run.

    A page is what the browser draws, so it is exported fresh from the disc
    rather than trusted from `out/`, which can be any age.
    """

    def __init__(self, folder=None):
        self.own = folder is None
        self.dir = folder or tempfile.mkdtemp(prefix='trapt-grade-')
        self.loaded = {}

    def get(self, name):
        if name not in self.loaded:
            path = os.path.join(self.dir, '%s.html' % name)
            if not os.path.isfile(path):
                import export
                export.build(name, self.dir, single=True, audio=False)
            S, blob = pdiag.load(path)
            self.loaded[name] = (S, pdiag.Bin(blob), {})
        return self.loaded[name]

    def close(self):
        if self.own:
            shutil.rmtree(self.dir, ignore_errors=True)


def render(pages, name, frame, opt=None):
    """`(rgb 0..255, owner-per-pixel, region names)` for one frame.

    Region names index the owner map: an entity's name, then `overlay` for
    what the letterbox and subtitles drew over it, `clear` for nothing.
    """
    S, B, texcache = pages.get(name)
    opt = opt or pdiag.Opts()
    parts = pdiag.gather(S, B, frame, texcache=texcache)
    eye, tgt, fov, roll = pdiag.camera_at(S, B, frame)
    rig = pdiag.Rig(S, opt)
    W, H = GS_SIZE
    ids = np.full((H, W), -1, np.int64)
    img = pdiag.render(parts, eye, tgt, fov, roll, rig, GS_SIZE, ids=ids)
    raw = np.asarray(img, np.float64)
    out = np.asarray(pdiag.overlay(img, S, frame), np.float64)
    names = sorted({p['ent'] for p in parts})
    region = np.full((H, W), len(names) + 1, np.int64)     # clear
    for i, p in enumerate(parts):
        region[ids == i] = names.index(p['ent'])
    region[np.abs(out - raw).sum(-1) > 0] = len(names)     # overlay
    # A bar over black geometry changes nothing, but it is still the bar's
    # pixel and not the room's.  The same sums as `pdiag.overlay`.
    LB = S.get('letterbox') or {'ui': [640, 448], 'bars': [50, 110],
                                'events': []}
    o = pdiag.bar_open(LB, frame)
    region[:max(0, int(round(LB['bars'][0] * H / LB['ui'][1] * o)))] = \
        len(names)
    region[min(H, int(round(H - LB['bars'][1] * H / LB['ui'][1] * o))):] = \
        len(names)
    return out, region, names + ['overlay', 'clear']


# ------------------------------------------------------------------- grade
def grade(view, hw, region, names):
    whole = score(view, hw)
    out = {'mae': whole['mae'], 'bias': whole['bias'],
           'edges': edge_corr(view, hw), 'shift': list(best_shift(view, hw)),
           'regions': {}}
    total = whole['error'] or 1.0
    for i, name in enumerate(names):
        m = region == i
        s = score(view, hw, m)
        if s is None:
            continue
        e = edge_corr(view, hw, m) if s['pixels'] >= 64 else None
        out['regions'][name] = {
            'pixels': s['pixels'], 'mae': s['mae'], 'bias': s['bias'],
            'edges': None if e is None else round(e, 3),
            'share': round(s['error'] / total, 3)}
    if out['edges'] is not None:
        out['edges'] = round(out['edges'], 3)
    return out


def picture(view, hw, path):
    """Hardware | viewer | |difference| x4, stacked, at 512x224 each."""
    d = np.clip(np.abs(view - hw).mean(-1, keepdims=True) * 4, 0, 255)
    heat = np.concatenate([d, d * 0.35, np.zeros_like(d)], -1)
    stack = np.concatenate([hw, view, heat], 0)
    Image.fromarray(stack.astype(np.uint8)).save(path)


def run(paths, pages, out_dir=None, log=print):
    discs = {}
    results = {}
    for path in paths:
        key = os.path.basename(path)
        reg = (region_mod.of_serial(key) or region_mod.active())
        if reg.code not in discs:
            import scene as scene_mod
            region_mod.use(reg)
            discs[reg.code] = scene_mod.Disc()
        got = oracle_mod.identify(discs[reg.code], path, reg=reg)
        st = got['state']
        if got['cutscene'] is None:
            log('%-36s skipped: not in a cutscene the oracle can place' % key)
            continue
        if not st.has('Screenshot.png'):
            log('%-36s skipped: no Screenshot.png in the state' % key)
            continue
        span = got.get('span') or (got['frame'], got['frame'])
        if span[1] > span[0]:
            # A held camera names a shot, not a frame, and grading one
            # arbitrary frame of it would score the wrong pose.
            log('%-36s skipped: %s frames %d..%d share one camera and the '
                'state has no frame counter to pick between them'
                % (key, got['cutscene'], span[0], span[1]))
            continue
        name, frame = got['cutscene'], got['frame']
        t0 = time.time()
        view, region, names = render(pages, name, frame)
        hw = hardware_frame(st.zip.read('Screenshot.png'))
        g = grade(view, hw, region, names)
        g.update({'cutscene': name, 'frame': frame,
                  'residual': got['residual'],
                  'counter': bool(got.get('from_counter')),
                  'seconds': round(time.time() - t0, 1)})
        results[key] = g
        if out_dir:
            picture(view, hw, os.path.join(
                out_dir, '%s-%s-%d.png' % (os.path.splitext(key)[0],
                                           name, frame)))
        log(report(key, g))
    return results


def report(key, g):
    lines = ['%-36s %s frame %d   mae %.2f   bias %s   edges %s   shift %s'
             % (key, g['cutscene'], g['frame'], g['mae'],
                '(%+.1f %+.1f %+.1f)' % tuple(g['bias']),
                '-' if g['edges'] is None else '%.3f' % g['edges'],
                '(%d, %d)' % tuple(g['shift']))]
    if g['shift'] != [0, 0]:
        lines.append('%-36s   the screenshot lines up %d, %d px off: check '
                     'the capture before the scores' % ('', g['shift'][0],
                                                       g['shift'][1]))
    rows = sorted(g['regions'].items(), key=lambda kv: -kv[1]['share'])
    for name, r in rows:
        lines.append('%-36s   %-14s %5.1f%% of the error  %6d px  mae %6.2f  '
                     'bias (%+.1f %+.1f %+.1f)  edges %s'
                     % (('', name, 100 * r['share'], r['pixels'], r['mae'])
                        + tuple(r['bias'])
                        + ('-' if r['edges'] is None else '%.3f' % r['edges'],)))
    return '\n'.join(lines)


def compare(results, baseline, log=print):
    """Each state against the baseline's grade of it.  Returns the worse ones."""
    worse = []
    for key, g in sorted(results.items()):
        b = baseline.get(key)
        if b is None:
            log('%-36s new (mae %.2f)' % (key, g['mae']))
            continue
        if (b['cutscene'], b['frame']) != (g['cutscene'], g['frame']):
            log('%-36s was %s %d, now %s %d -- the oracle changed its mind'
                % (key, b['cutscene'], b['frame'], g['cutscene'], g['frame']))
            worse.append(key)
            continue
        delta = g['mae'] - b['mae']
        verdict = ('WORSE' if delta > TOLERANCE else
                   'better' if delta < -TOLERANCE else 'same')
        log('%-36s mae %.2f -> %.2f  (%+.2f)  %s'
            % (key, b['mae'], g['mae'], delta, verdict))
        if verdict == 'WORSE':
            worse.append(key)
    for key in sorted(set(baseline) - set(results)):
        log('%-36s in the baseline but not graded this time' % key)
    return worse


def main():
    argv = sys.argv[1:]
    if '-h' in argv or '--help' in argv:
        print(__doc__)
        return 0

    VALUED = ('--out', '--save', '--baseline', '--pages')

    def opt(flag):
        if flag in argv and argv.index(flag) + 1 < len(argv):
            return argv[argv.index(flag) + 1]
        return None

    taken = {argv.index(f) + 1 for f in VALUED if f in argv}
    paths = [a for i, a in enumerate(argv)
             if not a.startswith('--') and i not in taken]
    paths = paths or oracle_mod.all_states()
    if not paths:
        print('no savestates found; looked in %s.  Name some .p2s files.'
              % (oracle_mod.state_dir() or oracle_mod.STATE_DIR))
        return 1
    out_dir = opt('--out')
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    pages = Pages(opt('--pages'))
    try:
        results = run(paths, pages, out_dir)
    finally:
        pages.close()
    if not results:
        print('nothing graded')
        return 1
    maes = [g['mae'] for g in results.values()]
    print('\n%d graded, mean mae %.2f' % (len(maes), sum(maes) / len(maes)))
    if opt('--save'):
        with open(opt('--save'), 'w') as f:
            json.dump(results, f, indent=1, sort_keys=True)
        print('wrote', opt('--save'))
    if opt('--baseline'):
        with open(opt('--baseline')) as f:
            baseline = json.load(f)
        print()
        worse = compare(results, baseline)
        if worse:
            print('\n%d got worse: %s' % (len(worse), ' '.join(worse)))
            return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
