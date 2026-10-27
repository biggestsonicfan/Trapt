"""Check `grade.py` end to end on savestates it can trust: ones made here.

    python test_grade.py

A real capture says how good the viewer is; it cannot say whether the grader
is right, because nobody knows the answer in advance.  So this forges
`.p2s` files whose answer is known -- EE RAM holding e001's camera and frame
counter at frame 7422, and a `Screenshot.png` that *is* the viewer's own
frame, scaled to 640x480 the way PCSX2 hands one back -- then breaks the
picture in known ways and checks the grade notices each one, and only it:

* the viewer's own frame grades near zero, with no bias and no shift
* the same frame 20% darker reads as a positive bias, and the baseline
  comparison calls it WORSE
* the same frame moved 3 px reads as a 3 px shift
* a state with no camera in RAM is skipped, not graded against a guess

Needs the disc (see `region.py`); exits 2 without one, like the JS suites.
"""
import io
import os
import struct
import sys
import tempfile
import zipfile

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import region as region_mod

NAME, FRAME = 'e001', 7422
failures = 0


def check(what, ok, detail=''):
    global failures
    if not ok:
        failures += 1
    print('  %s %s%s' % ('ok  ' if ok else 'FAIL', what,
                         '' if ok or not detail else '\n        ' + str(detail)))


def forge(path, cam, frame, shot):
    """A `.p2s` with the US story camera slot, its counter, and a picture."""
    ee = bytearray(32 * 1024 * 1024)
    slot = 0x0081B730
    counter = region_mod.US.ee['COUNTERS'][slot]
    if cam is not None:
        eye, target = np.asarray(cam[0], float), np.asarray(cam[1], float)
        fwd = (target - eye) / np.linalg.norm(target - eye)
        struct.pack_into('<4f', ee, slot, *eye, 1.0)
        struct.pack_into('<4f', ee, slot + 0x10, *target, 1.0)
        struct.pack_into('<4f', ee, slot + 0x30, *fwd, 0.0)
        struct.pack_into('<f', ee, counter, float(frame + 1))
    png = io.BytesIO()
    Image.fromarray(np.clip(shot, 0, 255).astype(np.uint8)).save(png, 'PNG')
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('eeMemory.bin', bytes(ee))
        z.writestr('Screenshot.png', png.getvalue())


def pcsx2_size(rgb):
    """What PCSX2 writes: the 512x224 frame on a 4:3 640x480 screen."""
    im = Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8))
    return np.asarray(im.resize((640, 480), Image.BILINEAR), np.float64)


def main():
    try:
        region_mod.active().root
    except IOError as exc:
        print('skipped: %s' % exc)
        return 2
    import grade
    import oracle
    import scene as scene_mod

    track = oracle.track_for(scene_mod.Disc(), NAME)
    s = track.sample(FRAME)
    cam = (s['position'], s['target'])

    work = tempfile.mkdtemp(prefix='trapt-test-grade-')
    pages = grade.Pages(os.path.join(work, 'pages'))
    os.makedirs(pages.dir)
    # what the screen showed when EE RAM was at FRAME
    view, region, names = grade.render(pages, NAME, FRAME - grade.SHOT_LAG)
    shifted = np.zeros_like(view)
    shifted[:, 3:] = view[:, :-3]
    states = {
        'SLUS-21255 (TEST).01.p2s': pcsx2_size(view),
        'SLUS-21255 (TEST).02.p2s': pcsx2_size(view * 0.8),
        'SLUS-21255 (TEST).03.p2s': pcsx2_size(shifted),
    }
    paths = []
    for key, shot in states.items():
        forge(os.path.join(work, key), cam, FRAME, shot)
        paths.append(os.path.join(work, key))
    empty = os.path.join(work, 'SLUS-21255 (TEST).04.p2s')
    forge(empty, None, 0, view)
    paths.append(empty)

    print('grade.py on forged savestates (%s frame %d)' % (NAME, FRAME))
    said = []
    got = grade.run(paths, pages, log=said.append)
    print('\n'.join('    ' + l for s in said for l in s.split('\n')))

    a = got.get('SLUS-21255 (TEST).01.p2s')
    check('the oracle places the forged state at %s %d from its counter'
          % (NAME, FRAME),
          a and (a['cutscene'], a['frame'], a['counter']) == (NAME, FRAME, True),
          a and (a['cutscene'], a['frame'], a['counter']))
    check('its own frame grades near zero (mae < 3)', a and a['mae'] < 3.0,
          a and a['mae'])
    check('and carries no bias', a and max(map(abs, a['bias'])) < 1.0,
          a and a['bias'])
    check('and lines up unshifted', a and a['shift'] == [0, 0],
          a and a['shift'])
    check('the outlines agree (edges > 0.9)', a and a['edges'] > 0.9,
          a and a['edges'])
    regions = a['regions'] if a else {}
    check('the error is split over the room, the cast, overlay and clear',
          {'overlay'} <= set(regions) and len(regions) >= 3, sorted(regions))
    check('and the shares add up to the whole',
          abs(sum(r['share'] for r in regions.values()) - 1.0) < 0.01,
          sum(r['share'] for r in regions.values()))

    b = got.get('SLUS-21255 (TEST).02.p2s')
    check('a 20% darker capture reads as the viewer being too bright',
          b and min(b['bias']) > 3.0, b and b['bias'])
    check('without moving the outlines', b and b['shift'] == [0, 0],
          b and b['shift'])
    worse = grade.compare({'X': b}, {'X': a}, log=lambda *_: None)
    check('and the baseline comparison calls it WORSE', worse == ['X'], worse)
    same = grade.compare({'X': a}, {'X': a}, log=lambda *_: None)
    check('while the same grade twice is not', same == [], same)

    c = got.get('SLUS-21255 (TEST).03.p2s')
    check('a capture 3 px off reads as a 3 px shift',
          c and c['shift'] == [-3, 0], c and c['shift'])

    check('a state with no camera is skipped, not graded',
          'SLUS-21255 (TEST).04.p2s' not in got
          and any('TEST).04' in s and 'skipped' in s for s in said))

    for f in os.listdir(pages.dir):
        os.remove(os.path.join(pages.dir, f))
    os.rmdir(pages.dir)
    for p in paths:
        os.remove(p)
    os.rmdir(work)
    print('%d failure(s)' % failures)
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
