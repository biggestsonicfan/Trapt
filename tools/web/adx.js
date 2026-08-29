/**
 * CRI ADX decoder -- `tools/adx.py` in the browser.
 *
 * Every `.ADX` on the Trapt disc is encoding type 3, 18-byte blocks, 4-bit
 * samples, 48000 Hz, version 4, unencrypted: 1192 streams, 655 MB of BGM,
 * room ambience and 1048 voice clips.
 *
 *   HEADER (big-endian)
 *     0x00 u16  0x8000              0x02 u16  copyright offset
 *     0x04 u8   encoding type       0x05 u8   block size (18)
 *     0x06 u8   sample bits (4)     0x07 u8   channels
 *     0x08 u32  sample rate         0x0c u32  samples per channel
 *     0x10 u16  highpass cutoff Hz  0x12 u8   version
 *     0x13 u8   flags -- non-zero means an encryption key we do not handle
 *
 * Audio starts at `copyright_offset + 4`.  Blocks interleave by channel; each
 * is a big-endian s16 scale then 16 bytes of signed 4-bit deltas, high nibble
 * first.
 *
 * Each sample is
 *
 *     ((delta << 12) * scale + c1 * prev1 + c2 * prev2) >> 12
 *
 * clamped to s16.  **The whole expression stays in 12-bit fixed point until
 * that single final shift** -- splitting it into `delta * scale +
 * (predictor >> 12)` loses a bit and drifts audibly over a long clip.
 *
 * The intermediate stays inside int32 for every value the format can produce
 * (worst case about 1.5e9 against a 2.15e9 limit), which is what makes the
 * plain `>>` safe here; `adx.py` is arbitrary-precision and both floor, so
 * the two agree bit for bit.  `test_audio.js` checks that on real streams.
 */
(function () {
'use strict';

const MAGIC = 0x8000;
const SQRT2 = 1.4142135623730951;
const COEFF_BITS = 12;
const COEFF_ONE = 1 << COEFF_BITS;

/** Second-order predictor coefficients, as 12-bit fixed point. */
function coefficients(cutoff, rate) {
  const a = SQRT2 - Math.cos(2.0 * Math.PI * cutoff / rate);
  const b = SQRT2 - 1.0;
  const c = (a - Math.sqrt((a + b) * (a - b))) / b;
  return [Math.round(c * 2.0 * COEFF_ONE), Math.round(-(c * c) * COEFF_ONE)];
}

function parseHeader(data) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.byteLength < 0x14 || dv.getUint16(0, false) !== MAGIC)
    throw new Error('not an ADX');
  const copyrightOff = dv.getUint16(2, false);
  const h = {
    encoding: data[4], blockSize: data[5], bitDepth: data[6], channels: data[7],
    rate: dv.getUint32(8, false), samples: dv.getUint32(12, false),
    cutoff: dv.getUint16(0x10, false), version: data[0x12], flags: data[0x13],
    dataOffset: copyrightOff + 4,
  };
  const sig = String.fromCharCode(...data.subarray(copyrightOff - 2, copyrightOff + 4));
  if (sig !== '(c)CRI')
    throw new Error('missing CRI signature at 0x' + (copyrightOff - 2).toString(16));
  if (h.flags) throw new Error('encrypted ADX (flags 0x' + h.flags.toString(16) + ')');
  if (h.encoding !== 2 && h.encoding !== 3)
    throw new Error('unsupported ADX encoding type ' + h.encoding);
  if (h.bitDepth !== 4 || h.blockSize !== 18)
    throw new Error('unsupported ADX block ' + h.bitDepth + ' bits / '
                    + h.blockSize + ' bytes');
  return h;
}

/** Decode to `{header, channels: [Int16Array]}`. */
function decode(data) {
  const h = parseHeader(data);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let c1 = 0, c2 = 0;
  if (h.encoding === 3) {
    const c = coefficients(h.cutoff, h.rate);
    c1 = c[0]; c2 = c[1];
  }

  const perBlock = (h.blockSize - 2) * 2;        // 32 samples
  const channels = [];
  for (let i = 0; i < h.channels; i++) channels.push(new Int16Array(h.samples));

  const p1 = new Int32Array(h.channels), p2 = new Int32Array(h.channels);
  const written = new Int32Array(h.channels);
  let pos = h.dataOffset;
  let remaining = h.samples;
  const end = data.byteLength;

  while (remaining > 0 && pos + h.blockSize * h.channels <= end) {
    for (let ch = 0; ch < h.channels; ch++) {
      const scale = dv.getInt16(pos, false);
      const body = pos + 2;
      pos += h.blockSize;
      let a = p1[ch], b = p2[ch];
      const out = channels[ch];
      let w = written[ch];
      for (let i = 0; i < h.blockSize - 2; i++) {
        const byte = data[body + i];
        for (let k = 0; k < 2; k++) {
          let nib = k === 0 ? (byte >> 4) : (byte & 0x0F);
          if (nib >= 8) nib -= 16;
          let s = ((nib << COEFF_BITS) * scale + c1 * a + c2 * b) >> COEFF_BITS;
          if (s > 32767) s = 32767; else if (s < -32768) s = -32768;
          if (w < out.length) out[w++] = s;
          b = a; a = s;
        }
      }
      p1[ch] = a; p2[ch] = b;
      written[ch] = w;
    }
    remaining -= perBlock;
  }
  return { header: h, channels: channels };
}

/** Decode straight into a WebAudio buffer -- no re-encode anywhere. */
function toAudioBuffer(ctx, data) {
  const { header, channels } = decode(data);
  const buf = ctx.createBuffer(header.channels, header.samples, header.rate);
  for (let c = 0; c < header.channels; c++) {
    const src = channels[c];
    const dst = buf.getChannelData(c);
    for (let i = 0; i < src.length; i++) dst[i] = src[i] / 32768;
  }
  return buf;
}

const api = { decode, parseHeader, coefficients, toAudioBuffer, MAGIC };
if (typeof module !== 'undefined') module.exports = api;
if (typeof window !== 'undefined') window.TraptAdx = api;
})();
