"""Trapt (SLUS-21255) '.TM2' texture reader - Sony TIM2, PS2 standard.

FILE HEADER (0x10)
  0x00 char[4] 'TIM2'
  0x04 u8      version
  0x05 u8      format (0 = picture headers start at 0x10)
  0x06 u16     picture count

PICTURE HEADER (0x30)
  +0x00 u32 total size of this picture, header included
  +0x04 u32 clut size
  +0x08 u32 image size
  +0x0c u16 header size
  +0x0e u16 clut colour count
  +0x10 u8  picture format
  +0x11 u8  mipmap count
  +0x12 u8  clut type   (low 6 bits = pixel format, bit 7 set = CSM2/linear)
  +0x13 u8  image type  (1=16bpp 2=24bpp 3=32bpp 4=4bpp idx 5=8bpp idx)
  +0x14 u16 width
  +0x16 u16 height
  +0x18 GsTex0/GsTex1/GsRegs/GsTexClut

Image data follows the header; the CLUT follows the image data.

PS2 quirks handled here:
  * alpha is 0..128 (0x80 = opaque), so it is rescaled to 0..255;
  * a 256-entry CSM1 CLUT is stored swizzled - within every block of 32
    entries, entries 8..15 and 16..23 are swapped.
"""
import struct

MAGIC = b'TIM2'


def _rgba16(v):
    r = (v & 0x1f) << 3
    g = ((v >> 5) & 0x1f) << 3
    b = ((v >> 10) & 0x1f) << 3
    a = 255 if (v >> 15) & 1 else 0
    return (r, g, b, a)


def _alpha(a):
    """PS2 alpha: 0x80 means fully opaque."""
    return 255 if a >= 0x80 else a * 2


def _read_clut(buf, count, ctype):
    fmt = ctype & 0x3f
    out = []
    if fmt == 1:                                   # 16bpp
        for i in range(count):
            out.append(_rgba16(struct.unpack_from('<H', buf, 2 * i)[0]))
    elif fmt == 2:                                 # 24bpp
        for i in range(count):
            r, g, b = buf[3 * i:3 * i + 3]
            out.append((r, g, b, 255))
    else:                                          # 32bpp
        for i in range(count):
            r, g, b, a = buf[4 * i:4 * i + 4]
            out.append((r, g, b, _alpha(a)))
    # CSM1 256-entry CLUTs are stored swizzled
    if count == 256 and not (ctype & 0x80):
        s = list(out)
        for base in range(0, 256, 32):
            for k in range(8):
                s[base + 8 + k], s[base + 16 + k] = out[base + 16 + k], out[base + 8 + k]
        out = s
    return out


def _pixels(img, clut, itype, w, h):
    """Expand one picture's payload to RGBA bytes, or None if there is none."""
    import numpy as np
    n = w * h
    if n <= 0:
        return None
    if itype in (4, 5) and clut:
        pal = np.zeros((256, 4), np.uint8)
        pal[:len(clut)] = np.array(clut, np.uint8)
        raw = np.frombuffer(img, np.uint8)
        if itype == 5:                             # 8bpp indexed
            idx = np.zeros(n, np.uint8)
            idx[:min(n, raw.size)] = raw[:n]
        else:                                      # 4bpp, low nibble first
            need = (n + 1) // 2
            b = np.zeros(need, np.uint8)
            b[:min(need, raw.size)] = raw[:need]
            idx = np.empty(need * 2, np.uint8)
            idx[0::2] = b & 0x0f
            idx[1::2] = b >> 4
            idx = idx[:n]
        return pal[idx].tobytes()

    if itype == 3:                                 # 32bpp direct
        a = np.zeros((n, 4), np.uint8)
        raw = np.frombuffer(img, np.uint8)[:n * 4]
        a.reshape(-1)[:raw.size] = raw
        a[:, 3] = np.minimum(a[:, 3].astype(np.uint16) * 2, 255).astype(np.uint8)
        return a.tobytes()
    if itype == 2:                                 # 24bpp direct
        a = np.full((n, 4), 255, np.uint8)
        raw = np.frombuffer(img, np.uint8)[:n * 3]
        a[:raw.size // 3, :3] = raw[:raw.size // 3 * 3].reshape(-1, 3)
        return a.tobytes()
    if itype == 1:                                 # 16bpp direct
        v = np.zeros(n, np.uint16)
        raw = np.frombuffer(img, np.uint16)[:n]
        v[:raw.size] = raw
        a = np.empty((n, 4), np.uint8)
        a[:, 0] = ((v & 0x1f) << 3).astype(np.uint8)
        a[:, 1] = (((v >> 5) & 0x1f) << 3).astype(np.uint8)
        a[:, 2] = (((v >> 10) & 0x1f) << 3).astype(np.uint8)
        a[:, 3] = np.where(v >> 15, 255, 0).astype(np.uint8)
        return a.tobytes()
    return None


def decode(data):
    """Decode a TIM2 file. Returns a list of (width, height, rgba_bytes)."""
    if data[:4] != MAGIC:
        raise ValueError('not a TIM2 (%r)' % data[:4])
    npic = struct.unpack_from('<H', data, 6)[0]
    pics = []
    # Byte 5 is TIM2's `format`, and it moves the first picture header: 0 puts
    # it straight after the 16-byte file header, anything else aligns it to
    # 128.  129 of the 7668 TIM2 on the disc are format 1 and every one of
    # them read as a 0x0 picture and decoded to nothing -- `spark.tm2`, which
    # is the effect e004 draws on Allura's hand, and `rh01_21.tm2`, which is a
    # wall in the first room of the House.
    o = 0x10 if data[5] == 0 else 0x80
    for _ in range(npic):
        total, clut_sz, img_sz = struct.unpack_from('<3I', data, o)
        hdr_sz, ncol = struct.unpack_from('<2H', data, o + 0x0c)
        ctype, itype = data[o + 0x12], data[o + 0x13]
        w, h = struct.unpack_from('<2H', data, o + 0x14)

        img = data[o + hdr_sz:o + hdr_sz + img_sz]
        clut = _read_clut(data[o + hdr_sz + img_sz:o + hdr_sz + img_sz + clut_sz],
                          ncol, ctype) if clut_sz else []

        px = _pixels(img, clut, itype, w, h)
        if px is not None:
            pics.append((w, h, px))
        o += total
        if total <= 0:
            break
    return pics


def to_png(data, path_stem):
    """Decode and write PNG(s). Returns the list of paths written."""
    from PIL import Image
    out = []
    pics = decode(data)
    for i, (w, h, rgba) in enumerate(pics):
        p = '%s.png' % path_stem if len(pics) == 1 else '%s_%d.png' % (path_stem, i)
        Image.frombytes('RGBA', (w, h), rgba).save(p)
        out.append(p)
    return out
