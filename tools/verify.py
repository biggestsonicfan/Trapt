"""Diff the exported HTML player against the Python reference renderer.

    python verify.py e001 7860 [bundle-dir]

Exports the cutscene if needed, runs `test_player.js` under node to pose every
entity with the *player's own* maths, then poses the same frame with `pose.py`
and compares bone matrices and skinned vertex positions.  Any convention slip
-- matrix order, quaternion layout, the pre-weighted skinning -- shows up here
instead of as a silently wrong picture in the browser.
"""
import json
import os
import subprocess
import sys
import tempfile

import export as export_mod
import pose
import scene as scene_mod
import smi as smi_mod

HERE = os.path.dirname(os.path.abspath(__file__))
NODE = os.environ.get('NODE', 'node')


def check_subs(sc, laid, problems):
    """Diff the page's subtitle layout against `font.py`'s.

    The page places glyph boxes in the game's 640x448 UI space from a table the
    exporter bakes; `font.py` places them from the ELF's own width records and
    reproduces the hardware display list's 12.4 vertex X bit for bit.  Any
    disagreement between the two is a plumbing bug in the export.
    """
    if not laid:
        return 0.0, 0
    import font as font_mod
    fo = font_mod.Font()
    worst = 0.0
    n = 0
    for cue, theirs in zip(sc.subtitles, laid):
        mine = list(fo.runs(cue.raw))
        if len(mine) != len(theirs):
            problems.append('subtitle at %d: %d glyphs vs %d'
                            % (cue.frame, len(mine), len(theirs)))
            continue
        for (code, ux, uy, tint), (_, tx, ty, tt) in zip(mine, theirs):
            n += 1
            worst = max([worst, abs(ux - tx), abs(uy - ty)]
                        + [abs(a - b) for a, b in zip(tint, tt)])
    return worst, n


def run(name, frame, bundle=None, tol_bone=2e-3, tol_vert=5e-2):
    tmp = None
    if bundle is None:
        tmp = tempfile.mkdtemp(prefix='trapt-verify-')
        export_mod.build(name, tmp, audio=False, verbose=False)
        bundle = os.path.join(tmp, name)

    out = os.path.join(bundle, '_verify.json')
    subprocess.run([NODE, os.path.join(HERE, 'test_player.js'), bundle,
                    str(frame), out], check=True)
    js = json.load(open(out))

    sc = scene_mod.load(name)
    models = {}

    def model(fname):
        key = fname.lower()
        if key not in models:
            models[key] = smi_mod.parse(sc.asset(fname))
        return models[key]

    worst_bone = worst_vert = 0.0
    worst_where = ''
    checked_bones = checked_verts = 0
    problems = []

    ents = {e.name: e for e in sc.actors}
    if sc.room_model:
        ents[sc.room] = None

    for ename, rec in js['entities'].items():
        ent = ents.get(ename)
        clip = scene_mod.clip(sc, rec['clip']) if rec['clip'] else None
        local = rec['localFrame']
        for key, data in rec['models'].items():
            mod = model(key)
            W = pose.world_matrices(mod, clip, local)
            if len(W) != len(data['bones']):
                problems.append('%s/%s: %d bones vs %d'
                                % (ename, key, len(W), len(data['bones'])))
                continue
            for i, (a, b) in enumerate(zip(W, data['bones'])):
                for x, y in zip(a, b):
                    d = abs(x - y)
                    checked_bones += 1
                    if d > worst_bone:
                        worst_bone, worst_where = d, '%s/%s bone %d' % (ename, key, i)
            offset = (ent.transform[:3] if (ent and ent.transform) else (0.0, 0.0, 0.0))
            skinned = pose.skin(mod, W)
            drawn = [me for me in mod.meshes if me.vcount and me.tris]
            for mi, me in enumerate(drawn):
                if mi >= len(data['verts']):
                    break
                P = skinned[mod.meshes.index(me)][0]
                step = max(1, len(P) // 12)
                mine = [P[v] for v in range(0, len(P), step)]
                theirs = data['verts'][mi]
                for (px, py, pz), q in zip(mine, theirs):
                    for x, y in ((px + offset[0], q[0]), (py + offset[1], q[1]),
                                 (pz + offset[2], q[2])):
                        d = abs(x - y)
                        checked_verts += 1
                        if d > worst_vert:
                            worst_vert, worst_where = d, '%s/%s mesh %d' % (ename, key, mi)

    worst_sub, checked_subs = check_subs(sc, js.get('subs'), problems)

    print('frame %s: %d entities, %d bone values, %d vertex values compared'
          % (frame, len(js['entities']), checked_bones, checked_verts))
    print('  worst bone-matrix delta   %.6g' % worst_bone)
    print('  worst vertex delta        %.6g   (%s)' % (worst_vert, worst_where))
    if checked_subs:
        print('  worst subtitle delta      %.6g   (%d glyph placements)'
              % (worst_sub, checked_subs))
    for p in problems:
        print('  ! %s' % p)
    ok = (not problems and worst_bone <= tol_bone and worst_vert <= tol_vert
          and worst_sub <= 1e-4)
    print('  %s' % ('PASS' if ok else 'FAIL'))
    return ok


def main():
    name = sys.argv[1] if len(sys.argv) > 1 else 'e001'
    frames = [float(a) for a in sys.argv[2:] if not a.startswith('-')] or [7860.0]
    bundle = os.environ.get('BUNDLE')
    ok = True
    for f in frames:
        ok = run(name, f, bundle) and ok
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
