"""GAME.DAT (CRI AFS) reader for Trapt, with names from the ELF TOC."""
import struct, mmap, os, sys

GAMEDAT = 'E:/Seagate/OpenSuseBack/Emulators/PS2EMU/Trapt (USA)/DATA/GAME.DAT'
ELF     = 'E:/Seagate/OpenSuseBack/Emulators/PS2EMU/Trapt (USA)/SLUS_212.55'
TOC_VA, TOC_N = 0x0036A0F0, 3773

def load_toc(elf_path=ELF):
    """Return {afs_id: (name, size)} from the TOC baked into the ELF."""
    elf = open(elf_path, 'rb').read()
    v2f = lambda v: v - 0x100000 + 0x80
    def cstr(v):
        o = v2f(v); return elf[o:elf.index(b'\0', o)].decode('latin1')
    toc = {}
    for i in range(TOC_N):
        n, sz, aid = struct.unpack_from('<III', elf, v2f(TOC_VA) + 12 * i)
        toc[aid] = (cstr(n), sz)
    return toc

def open_afs(path=GAMEDAT):
    f = open(path, 'rb')
    m = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
    assert m[:4] == b'AFS\0', 'not an AFS'
    cnt = struct.unpack_from('<I', m, 4)[0]
    ents = [struct.unpack_from('<II', m, 8 + 8 * i) for i in range(cnt)]
    return m, ents

def iter_files(path=GAMEDAT, elf_path=ELF):
    """Yield (afs_id, name, memoryview) for every file on the disc."""
    toc = load_toc(elf_path)
    m, ents = open_afs(path)
    for i, (off, sz) in enumerate(ents):
        name = toc.get(i, ('UNKNOWN/%04d.bin' % i, sz))[0]
        yield i, name, m[off:off + sz]
