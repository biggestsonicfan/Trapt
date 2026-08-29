/**
 * `.SLI` room light-set reader -- `tools/sli.py` in the browser.
 *
 * Every `DATA/ROOM/<room>_ALL.ARC` ships one, and it holds the one thing a
 * cutscene's own light rig never records: the **direction** of its
 * directional light.  An SSC `0xB4` block of kind 0 carries a colour and no
 * aim; `FUN_001D4430` sums the room's directional entries and normalises.
 *
 *   0x00 u32  version (1)      0x08 u32 -> records (always 0x10)
 *   0x04 u32  count            0x0c u32 0
 *
 *   RECORD (0x50)
 *     +0x00 float4   position, or direction when kind == 0
 *     +0x10 float4   colour
 *     +0x20 float4   unused on the disc
 *     +0x30 float2   range near, far
 *     +0x3c u32      kind -- 0 directional, 1 point, 4 ambient, 5 "black"
 *     +0x40 char[16] name
 */
(function () {
'use strict';

function parse(blob) {
  const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const count = dv.getUint32(4, true), off = dv.getUint32(8, true);
  if (off + count * 0x50 > blob.byteLength)
    throw new Error('sli: ' + count + ' records overrun ' + blob.byteLength + ' bytes');
  const out = [];
  for (let i = 0; i < count; i++) {
    const b = off + i * 0x50;
    let name = '';
    for (let k = 0; k < 16 && blob[b + 0x40 + k]; k++)
      name += String.fromCharCode(blob[b + 0x40 + k]);
    out.push({
      vec: [dv.getFloat32(b, true), dv.getFloat32(b + 4, true),
            dv.getFloat32(b + 8, true)],
      colour: [dv.getFloat32(b + 0x10, true), dv.getFloat32(b + 0x14, true),
               dv.getFloat32(b + 0x18, true)],
      range: [dv.getFloat32(b + 0x30, true), dv.getFloat32(b + 0x34, true)],
      kind: dv.getUint32(b + 0x3c, true),
      name: name,
    });
  }
  return out;
}

/** What a `0xB4` kind-0 block with no direction inherits, or null. */
function infiniteDirection(lights) {
  let sx = 0, sy = 0, sz = 0;
  for (const l of lights)
    if (l.kind === 0) { sx += l.vec[0]; sy += l.vec[1]; sz += l.vec[2]; }
  const n = Math.sqrt(sx * sx + sy * sy + sz * sz);
  return n > 1e-9 ? [sx / n, sy / n, sz / n] : null;
}

const api = { parse, infiniteDirection };
if (typeof module !== 'undefined') module.exports = api;
if (typeof window !== 'undefined') window.TraptSli = api;
})();
