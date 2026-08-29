/**
 * Decode the live GS display list out of a running PCSX2 over PINE.
 *
 *   node gsdump.js [startHex] [endHex]
 *
 * Walks EE RAM for PACKED GIFtags in A+D mode (NREG=1, REGS=0xE) -- the way
 * the EE sets GS registers -- and prints every register write it finds, decoded.
 * This is the game's "pixel shader": the PS2 has no programmable fragment
 * stage, so the whole look is TEX0's texture function plus the ALPHA blend
 * equation plus the TEST alpha/depth rules.
 */
import { PineClient } from '../hkmodd/PCSX2-MCP/pcsx2-mcp-server/dist/pine-client.js';

const START = parseInt(process.argv[2] || '0x00400000', 16);
const END = parseInt(process.argv[3] || '0x00600000', 16);

const REG = {
  0x00: 'PRIM', 0x01: 'RGBAQ', 0x02: 'ST', 0x03: 'UV', 0x04: 'XYZF2', 0x05: 'XYZ2',
  0x06: 'TEX0_1', 0x07: 'TEX0_2', 0x08: 'CLAMP_1', 0x09: 'CLAMP_2', 0x0a: 'FOG',
  0x0c: 'XYZF3', 0x0d: 'XYZ3', 0x14: 'TEX1_1', 0x15: 'TEX1_2', 0x16: 'TEX2_1',
  0x17: 'TEX2_2', 0x18: 'XYOFFSET_1', 0x19: 'XYOFFSET_2', 0x1a: 'PRMODECONT',
  0x1b: 'PRMODE', 0x1c: 'TEXCLUT', 0x22: 'SCANMSK', 0x34: 'MIPTBP1_1',
  0x36: 'MIPTBP2_1', 0x3b: 'TEXA', 0x3d: 'FOGCOL', 0x3f: 'TEXFLUSH',
  0x40: 'SCISSOR_1', 0x41: 'SCISSOR_2', 0x42: 'ALPHA_1', 0x43: 'ALPHA_2',
  0x44: 'DIMX', 0x45: 'DTHE', 0x46: 'COLCLAMP', 0x47: 'TEST_1', 0x48: 'TEST_2',
  0x49: 'PABE', 0x4a: 'FBA_1', 0x4c: 'FRAME_1', 0x4d: 'FRAME_2',
  0x4e: 'ZBUF_1', 0x4f: 'ZBUF_2', 0x50: 'BITBLTBUF', 0x51: 'TRXPOS',
  0x52: 'TRXREG', 0x53: 'TRXDIR', 0x54: 'HWREG', 0x60: 'SIGNAL', 0x61: 'FINISH',
  0x62: 'LABEL',
};
const PSM = { 0: 'PSMCT32', 1: 'PSMCT24', 2: 'PSMCT16', 10: 'PSMCT16S',
  19: 'PSMT8', 20: 'PSMT4', 27: 'PSMT8H', 36: 'PSMT4HL', 44: 'PSMT4HH',
  48: 'PSMZ32', 49: 'PSMZ24', 50: 'PSMZ16', 58: 'PSMZ16S' };
const ATST = ['NEVER', 'ALWAYS', 'LESS', 'LEQUAL', 'EQUAL', 'GEQUAL', 'GREATER', 'NOTEQUAL'];
const AFAIL = ['KEEP', 'FB_ONLY', 'ZB_ONLY', 'RGB_ONLY'];
const ZTST = ['NEVER', 'ALWAYS', 'GEQUAL', 'GREATER'];
const TFX = ['MODULATE', 'DECAL', 'HIGHLIGHT', 'HIGHLIGHT2'];
const ABCD = ['Cs', 'Cd', 'Zero', '?'];
const ABCD_C = ['As', 'Ad', 'FIX', '?'];
const PRIMS = ['POINT', 'LINE', 'LINESTRIP', 'TRI', 'TRISTRIP', 'TRIFAN', 'SPRITE', '?'];

const bits = (v, lo, n) => Number((v >> BigInt(lo)) & ((1n << BigInt(n)) - 1n));

function decode(reg, v) {
  switch (reg) {
    case 0x47: case 0x48: {
      const ate = bits(v, 0, 1), atst = bits(v, 1, 3), aref = bits(v, 4, 8);
      const afail = bits(v, 12, 2), date = bits(v, 14, 1), datm = bits(v, 15, 1);
      const zte = bits(v, 16, 1), ztst = bits(v, 17, 2);
      return `ATE=${ate} ATST=${ATST[atst]} AREF=${aref} AFAIL=${AFAIL[afail]} `
           + `DATE=${date} DATM=${datm} ZTE=${zte} ZTST=${ZTST[ztst]}`;
    }
    case 0x42: case 0x43: {
      const a = bits(v, 0, 2), b = bits(v, 2, 2), c = bits(v, 4, 2), d = bits(v, 6, 2);
      const fix = bits(v, 32, 8);
      return `(${ABCD[a]}-${ABCD[b]})*${ABCD_C[c]}>>7 + ${ABCD[d]}   FIX=${fix}`;
    }
    case 0x06: case 0x07: {
      return `TBP0=0x${bits(v, 0, 14).toString(16)} TBW=${bits(v, 14, 6)} `
           + `PSM=${PSM[bits(v, 20, 6)] ?? bits(v, 20, 6)} `
           + `TW=${1 << bits(v, 26, 4)} TH=${1 << bits(v, 30, 4)} `
           + `TCC=${bits(v, 34, 1) ? 'RGBA' : 'RGB'} TFX=${TFX[bits(v, 35, 2)]} `
           + `CBP=0x${bits(v, 37, 14).toString(16)} CPSM=${PSM[bits(v, 51, 4)] ?? ''} `
           + `CSM=${bits(v, 55, 1)} CSA=${bits(v, 56, 5)} CLD=${bits(v, 61, 3)}`;
    }
    case 0x14: case 0x15: {
      const mmag = bits(v, 5, 1), mmin = bits(v, 6, 3);
      const F = ['NEAREST', 'LINEAR', 'N_MIPMAP_N', 'N_MIPMAP_L', 'L_MIPMAP_N', 'L_MIPMAP_L'];
      return `LCM=${bits(v, 0, 1)} MXL=${bits(v, 2, 3)} MMAG=${F[mmag]} `
           + `MMIN=${F[mmin] ?? mmin} MTBA=${bits(v, 9, 1)} L=${bits(v, 19, 2)} K=${bits(v, 32, 12)}`;
    }
    case 0x00: case 0x1b: {
      return `PRIM=${PRIMS[bits(v, 0, 3)]} IIP=${bits(v, 3, 1)} TME=${bits(v, 4, 1)} `
           + `FGE=${bits(v, 5, 1)} ABE=${bits(v, 6, 1)} AA1=${bits(v, 7, 1)} `
           + `FST=${bits(v, 8, 1)} CTXT=${bits(v, 9, 1)} FIX=${bits(v, 10, 1)}`;
    }
    case 0x40: case 0x41:
      return `X=${bits(v, 0, 11)}..${bits(v, 16, 11)}  Y=${bits(v, 32, 11)}..${bits(v, 48, 11)}`;
    case 0x4c: case 0x4d:
      return `FBP=0x${(bits(v, 0, 9) * 2048).toString(16)} FBW=${bits(v, 16, 6) * 64} `
           + `PSM=${PSM[bits(v, 24, 6)] ?? ''} FBMSK=0x${bits(v, 32, 32).toString(16)}`;
    case 0x4e: case 0x4f:
      return `ZBP=0x${(bits(v, 0, 9) * 2048).toString(16)} PSM=${PSM[bits(v, 24, 4) + 48] ?? bits(v, 24, 4)} ZMSK=${bits(v, 32, 1)}`;
    case 0x3b:
      return `TA0=${bits(v, 0, 8)} AEM=${bits(v, 15, 1)} TA1=${bits(v, 32, 8)}`;
    case 0x3d:
      return `FCR=${bits(v, 0, 8)} FCG=${bits(v, 8, 8)} FCB=${bits(v, 16, 8)}`;
    case 0x08: case 0x09: {
      const M = ['REPEAT', 'CLAMP', 'REGION_CLAMP', 'REGION_REPEAT'];
      return `WMS=${M[bits(v, 0, 2)]} WMT=${M[bits(v, 2, 2)]} `
           + `MINU=${bits(v, 4, 10)} MAXU=${bits(v, 14, 10)} MINV=${bits(v, 24, 10)} MAXV=${bits(v, 34, 10)}`;
    }
    case 0x45: return `DTHE=${bits(v, 0, 1)}`;
    case 0x46: return `CLAMP=${bits(v, 0, 1) ? 'clamp 0..255' : 'wrap (mask 8bit)'}`;
    case 0x49: return `PABE=${bits(v, 0, 1)}`;
    case 0x4a: return `FBA=${bits(v, 0, 1)}`;
    case 0x01: return `R=${bits(v, 0, 8)} G=${bits(v, 8, 8)} B=${bits(v, 16, 8)} A=${bits(v, 24, 8)} Q=${bits(v, 32, 32)}`;
    default: return '';
  }
}

const p = new PineClient('127.0.0.1', 28011);
await p.connect();

const CHUNK = 0x10000;
const found = new Map();   // "REG=value" -> {count, decoded, sample}
let packets = 0;
for (let base = START; base < END; base += CHUNK) {
  const len = Math.min(CHUNK, END - base);
  let buf;
  try { buf = await p.readMemory(base, len); } catch { continue; }
  const dv = new DataView(buf.buffer ?? buf, buf.byteOffset ?? 0, buf.length ?? buf.byteLength);
  for (let o = 0; o + 16 <= dv.byteLength; o += 4) {
    if (dv.getUint32(o + 4, true) !== 0x10000000) continue;
    if (dv.getUint32(o + 8, true) !== 0x0000000e) continue;
    if (dv.getUint32(o + 12, true) !== 0) continue;
    const tag = dv.getUint32(o, true);
    const nloop = tag & 0x7fff;
    if (nloop === 0 || nloop > 32) continue;
    if (o + 16 + 16 * nloop > dv.byteLength) continue;
    packets++;
    for (let k = 0; k < nloop; k++) {
      const q = o + 16 + 16 * k;
      const val = dv.getBigUint64(q, true);
      const reg = Number(dv.getBigUint64(q + 8, true) & 0xffn);
      const name = REG[reg];
      if (!name) continue;
      const key = `${name}|0x${val.toString(16).padStart(16, '0')}`;
      const rec = found.get(key) || { n: 0, reg, val, name };
      rec.n++;
      found.set(key, rec);
    }
  }
}
p.disconnect();

console.log(`scanned 0x${START.toString(16)}..0x${END.toString(16)}: ${packets} A+D packets, ${found.size} distinct register values\n`);
const rows = [...found.values()].sort((a, b) => a.reg - b.reg || b.n - a.n);
let last = null;
for (const r of rows) {
  if (r.name !== last) { console.log(`\n--- ${r.name} (0x${r.reg.toString(16)}) ---`); last = r.name; }
  console.log(`  x${String(r.n).padStart(4)}  0x${r.val.toString(16).padStart(16, '0')}  ${decode(r.reg, r.val)}`);
}
