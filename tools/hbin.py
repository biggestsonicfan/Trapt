"""`#bin` -- the container the stage half of the game is authored in.

Eight hundred and ninety files on the disc start with the four bytes `#bin`.
It is a flat directory of *named* chunks plus a relocation table, and once it
is read the trap tables, the character parameters and the stage graph all fall
out of it at once::

    0x00 char[4]  '#bin'
    0x04 u32      file size (always exactly the file's length)
    0x08 u32      chunk count
    0x0c u32      fixup count
    0x10          chunk[count], stride 12:
                    u32 name   -- file offset of a NUL-terminated name
                    u32 offset -- file offset of the payload
                    u32 size
                  u32 fixup[fixup count]
                  ... payload, then the string blob ...

Chunk names repeat: a `.sta` holds twenty-five chunks all called `HIT_DATA`,
so the directory is an ordered list, never a map.

The **fixup table** is what makes the pointers inside a payload usable.  Each
entry is the file offset of a 32-bit field that itself holds a file offset, so
the loader can rebase the block wherever it lands in EE RAM.  Nothing here
rebases anything -- the stored values are already file-relative, which is
exactly what we want -- but the table is worth reading anyway, because it says
which fields are pointers and which are numbers.  `TrapData` has five pointer
slots and only three of them are live in `tc02.td`; the fixup count is how you
know.

Two quirks, both real data rather than misreadings:

* Twenty-five `.tcd` files declare a chunk that runs past the end of the file
  (`gc06.tcd` wants 28 bytes at offset 28 of a 44-byte file).  `parse` clamps
  to the file rather than raising -- the game reads what is there.
* Name buffers were fixed-size in the authoring tool and were never cleared,
  so a short name is followed by the tail of whatever was written before it.
  `SRoomDef`'s eight-byte name reads `RH_01\0ef`, and a `COL_DATA` bone name
  is followed by the tail of `TYPE_CAPSULE`.  Always cut at the first NUL.

    python hbin.py DATA/TRAP/TRAPINFO.BIN      # one file's chunks
    python hbin.py --scan                      # every `#bin` on the disc
"""
import struct
import sys

MAGIC = b'#bin'
HEADER = 0x10
CHUNK_STRIDE = 12


class Chunk:
    __slots__ = ('name', 'offset', 'size', 'data', 'truncated')

    def __init__(self, name, offset, size, data, truncated):
        self.name = name
        self.offset = offset
        self.size = size
        self.data = data
        self.truncated = truncated

    def __repr__(self):
        return '<%s @0x%x %d bytes%s>' % (
            self.name, self.offset, self.size,
            ' TRUNCATED' if self.truncated else '')


class Container:
    """A parsed `#bin`.  `chunks` is ordered; `first`/`all_of` look up by name."""

    def __init__(self, blob, chunks, fixups):
        self.blob = blob
        self.chunks = chunks
        self.fixups = fixups

    def all_of(self, name):
        return [c for c in self.chunks if c.name == name]

    def first(self, name):
        for c in self.chunks:
            if c.name == name:
                return c
        return None

    @property
    def names(self):
        seen = []
        for c in self.chunks:
            if c.name not in seen:
                seen.append(c.name)
        return seen

    def cstr(self, off):
        """The NUL-terminated string at a file offset, latin-1."""
        if off <= 0 or off >= len(self.blob):
            return ''
        end = self.blob.find(b'\0', off)
        if end < 0:
            end = len(self.blob)
        return self.blob[off:end].decode('latin1')

    def sjis(self, off):
        """The same, decoded as Shift-JIS -- trap names and descriptions."""
        if off <= 0 or off >= len(self.blob):
            return ''
        end = self.blob.find(b'\0', off)
        if end < 0:
            end = len(self.blob)
        return self.blob[off:end].decode('cp932', 'replace')


def parse(blob):
    if blob[:4] != MAGIC:
        raise ValueError('not a #bin (magic %r)' % blob[:4])
    size, count, nfix = struct.unpack_from('<3I', blob, 4)
    if size != len(blob):
        raise ValueError('#bin: header says %d bytes, file is %d' % (size, len(blob)))
    need = HEADER + count * CHUNK_STRIDE + nfix * 4
    if need > len(blob):
        raise ValueError('#bin: %d chunks + %d fixups overrun %d bytes'
                         % (count, nfix, len(blob)))
    chunks = []
    for i in range(count):
        noff, doff, dsize = struct.unpack_from('<3I', blob, HEADER + CHUNK_STRIDE * i)
        if noff >= len(blob):
            raise ValueError('#bin: chunk %d name at 0x%x is past the end' % (i, noff))
        end = blob.find(b'\0', noff)
        name = blob[noff:end if end >= 0 else len(blob)].decode('latin1')
        stop = min(doff + dsize, len(blob))
        chunks.append(Chunk(name, doff, dsize, blob[doff:stop], stop != doff + dsize))
    base = HEADER + CHUNK_STRIDE * count
    fixups = [struct.unpack_from('<I', blob, base + 4 * i)[0] for i in range(nfix)]
    return Container(blob, chunks, fixups)


# ---------------------------------------------------------------- self-check

def _scan(disc):
    import arc as arc_mod
    import collections
    seen = collections.Counter()
    kinds = collections.defaultdict(collections.Counter)
    total = bad = truncated = 0
    for path in disc.glob(''):
        blob = disc.read(path)
        if blob is None:
            continue
        files = [(path, blob)]
        if blob[:4] != MAGIC:
            try:
                files = [(path + '!' + n, blob[o:o + s])
                         for n, o, s in arc_mod.entries(blob)]
            except Exception:
                continue
        for name, body in files:
            if body[:4] != MAGIC:
                continue
            total += 1
            ext = name.rsplit('.', 1)[-1].lower()
            seen[ext] += 1
            try:
                c = parse(body)
            except Exception as exc:
                bad += 1
                print('FAIL %s: %s' % (name, exc))
                continue
            for ch in c.chunks:
                kinds[ext][ch.name] += 1
                if ch.truncated:
                    truncated += 1
    print('%d `#bin` files, %d failed to parse, %d truncated chunks'
          % (total, bad, truncated))
    print('by extension: %s' % dict(seen))
    for ext in sorted(kinds):
        print('  .%s' % ext)
        for name, n in sorted(kinds[ext].items()):
            print('      %-16s x%d' % (name, n))
    return 1 if bad else 0


def main():
    import os
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import scene as scene_mod
    disc = scene_mod.Disc()
    args = sys.argv[1:]
    if not args or args[0] == '--scan':
        return _scan(disc)
    blob = disc.read(args[0])
    if blob is None:
        raise SystemExit('no such file on the disc: %s' % args[0])
    c = parse(blob)
    print('%s: %d bytes, %d chunks, %d fixups'
          % (args[0], len(blob), len(c.chunks), len(c.fixups)))
    for i, ch in enumerate(c.chunks):
        print('  %3d %s' % (i, ch))
    if c.fixups:
        print('  fixups: %s' % ' '.join('0x%x' % f for f in c.fixups))
    return 0


if __name__ == '__main__':
    sys.exit(main())
