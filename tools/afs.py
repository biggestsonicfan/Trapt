"""GAME.DAT (CRI AFS) reader for Trapt, with names from the ELF TOC.

Both discs read the same way; which one is in the drive is `region.py`'s job,
and importing that is what gives every tool here `--region` and `--root`.
"""
import struct, mmap, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import region as region_mod


def __getattr__(name):
    """`afs.ELF` / `afs.GAMEDAT` / `afs.TOC_VA` / `afs.TOC_N`, live.

    They were constants when there was one disc.  They now follow whichever
    region is active, so reading one after a `region.use()` gives the new
    disc rather than the one that was current at import.
    """
    r = region_mod.active()
    if name == 'ELF':
        return r.elf
    if name == 'GAMEDAT':
        return r.gamedat
    if name == 'TOC_VA':
        return r.toc[0]
    if name == 'TOC_N':
        return r.toc[1]
    raise AttributeError(name)


def load_toc(elf_path=None):
    """Return {afs_id: (name, size)} from the TOC baked into the ELF."""
    r = region_mod.active()
    if elf_path is None:
        elf_path = r.elf
    else:
        # An explicit path may well be the other disc's; take its addresses.
        named = region_mod.BY_ELF.get(os.path.basename(elf_path).upper())
        r = named or r
    toc_va, toc_n = r.toc
    elf = open(elf_path, 'rb').read()
    v2f = lambda v: v - 0x100000 + 0x80
    def cstr(v):
        o = v2f(v); return elf[o:elf.index(b'\0', o)].decode('latin1')
    toc = {}
    for i in range(toc_n):
        n, sz, aid = struct.unpack_from('<III', elf, v2f(toc_va) + 12 * i)
        toc[aid] = (cstr(n), sz)
    return toc


def open_afs(path=None):
    f = open(path or region_mod.active().gamedat, 'rb')
    m = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
    assert m[:4] == b'AFS\0', 'not an AFS'
    cnt = struct.unpack_from('<I', m, 4)[0]
    ents = [struct.unpack_from('<II', m, 8 + 8 * i) for i in range(cnt)]
    return m, ents


def iter_files(path=None, elf_path=None):
    """Yield (afs_id, name, memoryview) for every file on the disc."""
    toc = load_toc(elf_path)
    m, ents = open_afs(path)
    for i, (off, sz) in enumerate(ents):
        name = toc.get(i, ('UNKNOWN/%04d.bin' % i, sz))[0]
        yield i, name, m[off:off + sz]
