"""CRI ADX decoder -- the format every `.ADX` on the Trapt disc uses.

Trapt ships 1192 ADX streams (655 MB): BGM, per-room ambience and 1048 voice
clips.  All of them are encoding type 3, 18-byte blocks, 4-bit samples,
48000 Hz, version 4, unencrypted.

    HEADER (big-endian)
      0x00 u16  0x8000
      0x02 u16  copyright offset -- b"(c)CRI" sits at offset - 2
      0x04 u8   encoding type (2 fixed-coefficient, 3 standard, 4 exponential)
      0x05 u8   block size, bytes per block per channel (18)
      0x06 u8   sample bit depth (4)
      0x07 u8   channel count
      0x08 u32  sample rate
      0x0c u32  total samples per channel
      0x10 u16  highpass cutoff in Hz
      0x12 u8   version (3 or 4)
      0x13 u8   flags -- non-zero means an encryption key we do not handle

    Audio starts at ``copyright_offset + 4``.  Blocks are interleaved by
    channel; each block is a big-endian s16 scale followed by 16 bytes of
    signed 4-bit deltas, high nibble first (32 samples).

Each sample is ``((delta << 12) * scale + c1 * prev1 + c2 * prev2) >> 12``,
clamped to s16, where the predictor coefficients come from the cutoff
frequency.  The whole expression stays in 12-bit fixed point until the single
final shift -- splitting it into ``delta * scale + (predictor >> 12)`` loses a
bit and drifts audibly over a long clip.

Validated sample-exact against ffmpeg's ADX decoder.
"""
import math
import struct
import wave

MAGIC = 0x8000
SQRT2 = 1.4142135623730951
COEFF_BITS = 12
COEFF_ONE = 1 << COEFF_BITS


def coefficients(cutoff, rate):
    """Second-order predictor coefficients, as 12-bit fixed point."""
    a = SQRT2 - math.cos(2.0 * math.pi * cutoff / rate)
    b = SQRT2 - 1.0
    c = (a - math.sqrt((a + b) * (a - b))) / b
    return (round(c * 2.0 * COEFF_ONE), round(-(c * c) * COEFF_ONE))


class Header:
    __slots__ = ('encoding', 'block_size', 'bit_depth', 'channels', 'rate',
                 'samples', 'cutoff', 'version', 'flags', 'data_offset')

    def __repr__(self):
        return ('<ADX %d ch, %d Hz, %d samples (%.2f s), type %d, v%d>'
                % (self.channels, self.rate, self.samples,
                   self.samples / float(self.rate), self.encoding, self.version))


def parse_header(data):
    if len(data) < 0x14 or struct.unpack_from('>H', data, 0)[0] != MAGIC:
        raise ValueError('not an ADX')
    copyright_off, = struct.unpack_from('>H', data, 2)
    h = Header()
    (h.encoding, h.block_size, h.bit_depth, h.channels) = struct.unpack_from('>4B', data, 4)
    h.rate, h.samples = struct.unpack_from('>2I', data, 8)
    h.cutoff, = struct.unpack_from('>H', data, 0x10)
    h.version, h.flags = struct.unpack_from('>2B', data, 0x12)
    h.data_offset = copyright_off + 4
    if data[copyright_off - 2:copyright_off + 4] != b'(c)CRI':
        raise ValueError('missing CRI signature at %#x' % (copyright_off - 2))
    if h.flags:
        raise ValueError('encrypted ADX (flags %#x) not supported' % h.flags)
    if h.encoding not in (2, 3):
        raise ValueError('unsupported ADX encoding type %d' % h.encoding)
    if h.bit_depth != 4 or h.block_size != 18:
        raise ValueError('unsupported ADX block %d bits / %d bytes'
                         % (h.bit_depth, h.block_size))
    return h


def decode(data):
    """Decode to ``(header, [channel0_samples, ...])`` of s16 ints."""
    h = parse_header(data)
    if h.encoding == 2:
        c1, c2 = 0x0000, 0x0000
    else:
        c1, c2 = coefficients(h.cutoff, h.rate)

    per_block = (h.block_size - 2) * 2          # 32 samples
    out = [[] for _ in range(h.channels)]
    hist = [(0, 0)] * h.channels
    pos = h.data_offset
    end = len(data)
    remaining = h.samples

    while remaining > 0 and pos + h.block_size * h.channels <= end:
        for ch in range(h.channels):
            scale = struct.unpack_from('>h', data, pos)[0]
            body = data[pos + 2:pos + h.block_size]
            pos += h.block_size
            p1, p2 = hist[ch]
            append = out[ch].append
            for byte in body:
                for nib in (byte >> 4, byte & 0x0F):
                    if nib >= 8:
                        nib -= 16
                    s = ((nib << COEFF_BITS) * scale
                         + c1 * p1 + c2 * p2) >> COEFF_BITS
                    if s > 32767:
                        s = 32767
                    elif s < -32768:
                        s = -32768
                    append(s)
                    p2, p1 = p1, s
            hist[ch] = (p1, p2)
        remaining -= per_block

    for ch in range(h.channels):
        del out[ch][h.samples:]
    return h, out


def to_wav(data, path):
    """Decode `data` and write a 16-bit PCM WAV to `path`."""
    h, chans = decode(data)
    frames = bytearray()
    n = len(chans[0])
    if h.channels == 1:
        frames += struct.pack('<%dh' % n, *chans[0])
    else:
        inter = [0] * (n * h.channels)
        for c, samples in enumerate(chans):
            inter[c::h.channels] = samples
        frames += struct.pack('<%dh' % len(inter), *inter)
    with wave.open(path, 'wb') as w:
        w.setnchannels(h.channels)
        w.setsampwidth(2)
        w.setframerate(h.rate)
        w.writeframes(bytes(frames))
    return h


def main():
    import sys
    data = open(sys.argv[1], 'rb').read()
    if len(sys.argv) > 2:
        print(to_wav(data, sys.argv[2]), '->', sys.argv[2])
    else:
        print(parse_header(data))


if __name__ == '__main__':
    main()
