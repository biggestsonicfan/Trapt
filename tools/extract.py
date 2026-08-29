"""Bulk-extract Trapt (SLUS-21255) 3D assets from GAME.DAT.

  python extract.py <outdir> [--filter SUBSTR] [--limit N] [--no-tex] [--raw]

Walks every RPS archive on the disc, converts each .SMI model to a Wavefront
OBJ (+MTL) in its bind pose and each referenced .TM2 texture to PNG, writing
a tree that mirrors the disc paths.
"""
import os
import sys
import struct
import time
import collections

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import afs
import arc
import smi
import tm2


def outdir_for(arcname):
    """DATA/CHARA/C01F_A.ARC -> CHARA/C01F_A"""
    p = arcname
    if p.upper().startswith('DATA/'):
        p = p[5:]
    if p.upper().endswith('.ARC'):
        p = p[:-4]
    return p


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    out_root = sys.argv[1]
    filt = None
    limit = 0
    do_tex = '--no-tex' not in sys.argv
    do_raw = '--raw' in sys.argv
    if '--filter' in sys.argv:
        filt = sys.argv[sys.argv.index('--filter') + 1].upper()
    if '--limit' in sys.argv:
        limit = int(sys.argv[sys.argv.index('--limit') + 1])

    t0 = time.time()

    # ---- pass 1: index every archive and its members -----------------------
    # The mmap stays open and archives are sliced on demand; holding every
    # payload would be over a gigabyte of RAM.
    print('indexing archives...')
    toc = afs.load_toc()
    mm, ents_afs = afs.open_afs()
    span = {}                           # arcname -> (offset, size) in GAME.DAT
    for i, (o, s) in enumerate(ents_afs):
        nm = toc.get(i, (None,))[0]
        if nm and nm.upper().endswith('.ARC'):
            span[nm] = (o, s)

    archives = {}                       # arcname -> [(member, off, size)]
    tex_index = collections.defaultdict(list)   # basename -> [arcname]
    for name, (o, s) in span.items():
        try:
            ents = arc.entries(mm[o:o + s])
        except Exception:
            continue
        archives[name] = ents
        for mn, _o, _s in ents:
            if mn.lower().endswith('.tm2'):
                tex_index[mn[:-4].lower()].append(name)
    print('  %d archives, %d distinct texture names' % (len(archives), len(tex_index)))

    def payload(arcname):
        o, s = span[arcname]
        return mm[o:o + s]

    def find_texture(base, home):
        """Resolve a material's texture name to (arcname, member)."""
        cands = tex_index.get(base.lower())
        if not cands:
            return None
        stem = home[:-4] if home.upper().endswith('.ARC') else home
        for want in (home, stem + '_TEX.ARC'):
            if want in cands:
                return (want, base + '.tm2')
        # prefer an archive in the same directory
        d = home.rsplit('/', 1)[0]
        for c in cands:
            if c.rsplit('/', 1)[0] == d:
                return (c, base + '.tm2')
        return (cands[0], base + '.tm2')

    # ---- pass 2: convert ---------------------------------------------------
    n_model = n_tex = n_fail = 0
    todo = sorted(archives)
    if filt:
        todo = [a for a in todo if filt in a.upper()]
    for ai, arcname in enumerate(todo):
        ents = archives[arcname]
        smis = [e for e in ents if e[0].lower().endswith('.smi')]
        if not smis:
            continue
        d = payload(arcname)
        dest = os.path.join(out_root, outdir_for(arcname).replace('/', os.sep))
        os.makedirs(dest, exist_ok=True)
        written_tex = {}

        for mn, off, sz in smis:
            stem = mn[:-4]
            try:
                model = smi.parse(d[off:off + sz])
            except Exception as e:
                n_fail += 1
                print('  FAIL %s:%s  %s' % (arcname, mn, e))
                continue

            texmap = {}
            if do_tex:
                for mt in model.materials:
                    base = mt['name']
                    if not base or base in texmap:
                        continue
                    hit = find_texture(base, arcname)
                    if not hit:
                        continue
                    tarc, tmem = hit
                    png = base + '.png'
                    if png not in written_tex:
                        for e2 in archives[tarc]:
                            if e2[0].lower() == tmem.lower():
                                try:
                                    tm2.to_png(payload(tarc)[e2[1]:e2[1] + e2[2]],
                                               os.path.join(dest, base))
                                    written_tex[png] = True
                                    n_tex += 1
                                except Exception as ex:
                                    print('  TEXFAIL %s %s' % (tmem, ex))
                                break
                    if png in written_tex:
                        texmap[base] = png

            smi.write_obj(model, os.path.join(dest, stem + '.obj'), stem,
                          mtllib=stem + '.mtl')
            smi.write_mtl(model, os.path.join(dest, stem + '.mtl'), texmap)
            if do_raw:
                with open(os.path.join(dest, mn), 'wb') as f:
                    f.write(d[off:off + sz])
            n_model += 1
            if limit and n_model >= limit:
                print('limit reached')
                break
        if limit and n_model >= limit:
            break
        if ai % 100 == 0:
            print('  [%4d/%4d] %-44s models=%d tex=%d' %
                  (ai, len(todo), arcname, n_model, n_tex))

    print('\ndone in %.1fs: %d models, %d textures, %d failures -> %s' %
          (time.time() - t0, n_model, n_tex, n_fail, out_root))
    return 0


if __name__ == '__main__':
    sys.exit(main())
