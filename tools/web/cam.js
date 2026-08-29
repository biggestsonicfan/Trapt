/**
 * `.CAM` camera-track reader -- `tools/cam.py` in the browser.
 *
 * No magic and no names: a four-slot channel directory, then records that
 * each end with their own timestamp.
 *
 *   0x00 u32   flags (0 on every file on the disc)
 *   0x04       {u32 count, u32 offset} x 4
 *   0x24 u32   padding; payload always starts at 0x28
 *
 *   record: float[stride-1] value, float time      (time is a 1-based frame)
 *
 * The stride is **not stored** -- derive it from the gap to the next present
 * channel's offset, the last running to end of file, divided by the record
 * count.  Channels are 0 position, 1 look-at target, 2 roll, 3 vertical FOV.
 */
(function () {
'use strict';

const POSITION = 0, TARGET = 1, ROLL = 2, FOV = 3;
const NAMES = ['position', 'target', 'roll', 'fov'];
const SLOTS = 4;
const HEADER = 0x28;

function sample(ch, t) {
  const ts = ch.times, vs = ch.values;
  if (!ts.length) return null;
  if (t <= ts[0]) return vs[0];
  if (t >= ts[ts.length - 1]) return vs[vs.length - 1];
  let lo = 0, hi = ts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] <= t) lo = mid; else hi = mid;
  }
  const span = ts[hi] - ts[lo];
  const f = span === 0 ? 0 : (t - ts[lo]) / span;
  const a = vs[lo], b = vs[hi], out = new Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] + (b[i] - a[i]) * f;
  return out;
}

function parse(data) {
  if (data.length < HEADER) throw new Error('too short for a CAM header');
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);

  const present = [];
  for (let i = 0; i < SLOTS; i++) {
    const count = dv.getUint32(4 + 8 * i, true);
    const off = dv.getUint32(8 + 8 * i, true);
    if (count === 0) continue;
    if (off < HEADER || off > data.length)
      throw new Error('channel ' + i + ' offset out of range');
    present.push({ off: off, count: count, index: i });
  }
  if (!present.length) throw new Error('no channels');
  present.sort((a, b) => a.off - b.off);
  if (present[0].off !== HEADER)
    throw new Error('channel data starts at 0x' + present[0].off.toString(16));

  const channels = new Array(SLOTS).fill(null);
  for (let k = 0; k < present.length; k++) {
    const p = present[k];
    const end = k + 1 < present.length ? present[k + 1].off : data.length;
    const span = end - p.off;
    if (span % p.count) throw new Error('channel ' + p.index + ': ragged records');
    const nfloats = (span / p.count) / 4;
    if (nfloats < 2)
      throw new Error('channel ' + p.index + ': record of ' + nfloats + ' floats');
    const times = new Array(p.count), values = new Array(p.count);
    for (let r = 0; r < p.count; r++) {
      const base = p.off + r * nfloats * 4;
      const v = new Array(nfloats - 1);
      for (let c = 0; c < nfloats - 1; c++) v[c] = dv.getFloat32(base + 4 * c, true);
      values[r] = v;
      times[r] = dv.getFloat32(base + 4 * (nfloats - 1), true);
    }
    channels[p.index] = { index: p.index, width: nfloats - 1,
                          times: times, values: values };
  }

  const track = { flags: dv.getUint32(0, true), channels: channels };
  track.duration = () => {
    let d = 0;
    for (const c of channels)
      if (c && c.times.length) d = Math.max(d, c.times[c.times.length - 1]);
    return d;
  };
  /** `{position:[x,y,z], target:[x,y,z], roll, fov}` at a frame. */
  track.sample = (frame) => {
    const out = {};
    for (let i = 0; i < NAMES.length; i++) {
      const ch = channels[i];
      if (!ch) continue;
      const v = sample(ch, frame);
      out[NAMES[i]] = v.length > 1 ? v : v[0];
    }
    return out;
  };
  return track;
}

const api = { parse, sample, POSITION, TARGET, ROLL, FOV, NAMES, HEADER };
if (typeof module !== 'undefined') module.exports = api;
if (typeof window !== 'undefined') window.TraptCam = api;
})();
