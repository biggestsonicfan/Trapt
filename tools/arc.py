"""Trapt (SLUS-21255) 'RPS' archive reader.

Layout:
  0x00 u32  magic 'RPS\0'
  0x04 u32  entry count
  0x08 u32  data_base (start of payload, also header size)
  0x0C u32  total file size
  0x10 u32  payload size
  0x14 u32  unused
  0x18      entry[], stride 0x14:
              u32 size, u32 size_aligned, u32 name_off (absolute),
              u32 data_off (relative to data_base), u32 unk
"""
import struct, sys, os

MAGIC = b'RPS\0'

def cstr(b, o):
    e = b.index(b'\0', o)
    return b[o:e].decode('latin1')

def entries(data):
    """Yield (name, offset, size) for each member. Raises ValueError if not RPS."""
    if data[:4] != MAGIC:
        raise ValueError('not an RPS archive (magic %r)' % data[:4])
    count, base, total = struct.unpack_from('<III', data, 4)
    if total != len(data):
        # some archives are padded/truncated by the AFS entry size; tolerate it
        pass
    out = []
    for i in range(count):
        sz, szal, noff, doff, unk = struct.unpack_from('<5I', data, 0x18 + 0x14 * i)
        out.append((cstr(data, noff), base + doff, sz))
    return out

def main():
    path = sys.argv[1]
    data = open(path, 'rb').read()
    ents = entries(data)
    outdir = sys.argv[2] if len(sys.argv) > 2 else None
    for name, off, size in ents:
        print('%-24s @%08x  %8d' % (name, off, size))
        if outdir:
            os.makedirs(outdir, exist_ok=True)
            with open(os.path.join(outdir, name), 'wb') as f:
                f.write(data[off:off + size])

if __name__ == '__main__':
    main()
