"""Decode the GS register state out of a PCSX2 savestate's EE memory dump.

    python gsstate.py eeMemory.bin

The PS2 has no programmable fragment stage: the whole "pixel shader" is the
GS register state the EE hands it.  The EE sets those registers with PACKED
GIFtags in A+D mode (NREG=1, REGS=0xE), each followed by pairs of
``(u64 value, u64 register address)``.  Scanning a memory dump for that tag
recovers every state the frame used, with no emulator round trips.

Everything here is what the hardware does, so it is also the spec the three.js
material has to reproduce -- see `docs/PS2SHADER.md`.
"""
import collections
import struct
import sys

REG = {
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
    0x52: 'TRXREG', 0x53: 'TRXDIR', 0x54: 'HWREG', 0x60: 'SIGNAL',
    0x61: 'FINISH', 0x62: 'LABEL',
}
PSM = {0: 'PSMCT32', 1: 'PSMCT24', 2: 'PSMCT16', 10: 'PSMCT16S', 19: 'PSMT8',
       20: 'PSMT4', 27: 'PSMT8H', 36: 'PSMT4HL', 44: 'PSMT4HH', 48: 'PSMZ32',
       49: 'PSMZ24', 50: 'PSMZ16', 58: 'PSMZ16S'}
ATST = ['NEVER', 'ALWAYS', 'LESS', 'LEQUAL', 'EQUAL', 'GEQUAL', 'GREATER', 'NOTEQUAL']
AFAIL = ['KEEP', 'FB_ONLY', 'ZB_ONLY', 'RGB_ONLY']
ZTST = ['NEVER', 'ALWAYS', 'GEQUAL', 'GREATER']
TFX = ['MODULATE', 'DECAL', 'HIGHLIGHT', 'HIGHLIGHT2']
ABD = ['Cs', 'Cd', '0', '?']
C_ = ['As', 'Ad', 'FIX', '?']
PRIMS = ['POINT', 'LINE', 'LINESTRIP', 'TRI', 'TRISTRIP', 'TRIFAN', 'SPRITE', '?']
FILT = ['NEAREST', 'LINEAR', 'NEAREST_MIPMAP_NEAREST', 'NEAREST_MIPMAP_LINEAR',
        'LINEAR_MIPMAP_NEAREST', 'LINEAR_MIPMAP_LINEAR']
WM = ['REPEAT', 'CLAMP', 'REGION_CLAMP', 'REGION_REPEAT']


def bit(v, lo, n):
    return (v >> lo) & ((1 << n) - 1)


def decode(reg, v):
    if reg in (0x47, 0x48):
        return (f"ATE={bit(v,0,1)} ATST={ATST[bit(v,1,3)]} AREF={bit(v,4,8)} "
                f"AFAIL={AFAIL[bit(v,12,2)]} DATE={bit(v,14,1)} DATM={bit(v,15,1)} "
                f"ZTE={bit(v,16,1)} ZTST={ZTST[bit(v,17,2)]}")
    if reg in (0x42, 0x43):
        return (f"({ABD[bit(v,0,2)]}-{ABD[bit(v,2,2)]})*{C_[bit(v,4,2)]}>>7 + "
                f"{ABD[bit(v,6,2)]}   FIX={bit(v,32,8)}")
    if reg in (0x06, 0x07):
        return (f"TBP0=0x{bit(v,0,14)*64:x} TBW={bit(v,14,6)*64} "
                f"PSM={PSM.get(bit(v,20,6), bit(v,20,6))} "
                f"{1<<bit(v,26,4)}x{1<<bit(v,30,4)} "
                f"TCC={'RGBA' if bit(v,34,1) else 'RGB'} TFX={TFX[bit(v,35,2)]} "
                f"CBP=0x{bit(v,37,14)*64:x} CPSM={PSM.get(bit(v,51,4),'')} "
                f"CSM={bit(v,55,1)} CSA={bit(v,56,5)} CLD={bit(v,61,3)}")
    if reg in (0x14, 0x15):
        return (f"LCM={bit(v,0,1)} MXL={bit(v,2,3)} MMAG={FILT[bit(v,5,1)]} "
                f"MMIN={FILT[bit(v,6,3)] if bit(v,6,3) < 6 else bit(v,6,3)} "
                f"MTBA={bit(v,9,1)} L={bit(v,19,2)} K={bit(v,32,12)}")
    if reg in (0x00, 0x1b):
        return (f"PRIM={PRIMS[bit(v,0,3)]} IIP={'gouraud' if bit(v,3,1) else 'flat'} "
                f"TME={bit(v,4,1)} FGE={bit(v,5,1)} ABE={bit(v,6,1)} AA1={bit(v,7,1)} "
                f"FST={'UV' if bit(v,8,1) else 'STQ'} CTXT={bit(v,9,1)} FIX={bit(v,10,1)}")
    if reg in (0x40, 0x41):
        return f"X={bit(v,0,11)}..{bit(v,16,11)}  Y={bit(v,32,11)}..{bit(v,48,11)}"
    if reg in (0x4c, 0x4d):
        return (f"FBP=0x{bit(v,0,9)*2048:x} FBW={bit(v,16,6)*64} "
                f"PSM={PSM.get(bit(v,24,6),'')} FBMSK=0x{bit(v,32,32):08x}")
    if reg in (0x4e, 0x4f):
        return (f"ZBP=0x{bit(v,0,9)*2048:x} PSM={PSM.get(bit(v,24,4)+48,'')} "
                f"ZMSK={bit(v,32,1)}")
    if reg == 0x3b:
        return f"TA0={bit(v,0,8)} AEM={bit(v,15,1)} TA1={bit(v,32,8)}"
    if reg == 0x3d:
        return f"R={bit(v,0,8)} G={bit(v,8,8)} B={bit(v,16,8)}"
    if reg in (0x08, 0x09):
        return (f"WMS={WM[bit(v,0,2)]} WMT={WM[bit(v,2,2)]} MINU={bit(v,4,10)} "
                f"MAXU={bit(v,14,10)} MINV={bit(v,24,10)} MAXV={bit(v,34,10)}")
    if reg == 0x45:
        return f"DTHE={bit(v,0,1)}"
    if reg == 0x46:
        return 'clamp to 0..255' if bit(v, 0, 1) else 'wrap (8-bit mask)'
    if reg == 0x49:
        return f"PABE={bit(v,0,1)}"
    if reg == 0x4a:
        return f"FBA={bit(v,0,1)}"
    if reg == 0x01:
        return (f"R={bit(v,0,8)} G={bit(v,8,8)} B={bit(v,16,8)} A={bit(v,24,8)} "
                f"(A=0x80 is 1.0 on the GS)")
    if reg == 0x44:
        return 'dither matrix ' + ' '.join(str(bit(v, i * 4, 3) - (8 if bit(v, i * 4 + 3, 1) else 0))
                                           for i in range(16))
    return ''


def scan(data, start=0, end=None):
    end = end if end is not None else len(data)
    found = collections.Counter()
    order = {}
    packets = 0
    o = start
    while o + 16 <= end:
        if (struct.unpack_from('<I', data, o + 4)[0] == 0x10000000
                and struct.unpack_from('<I', data, o + 8)[0] == 0x0000000E
                and struct.unpack_from('<I', data, o + 12)[0] == 0):
            tag = struct.unpack_from('<I', data, o)[0]
            nloop = tag & 0x7fff
            if 0 < nloop <= 32 and o + 16 + 16 * nloop <= end:
                packets += 1
                for k in range(nloop):
                    q = o + 16 + 16 * k
                    val, ra = struct.unpack_from('<QQ', data, q)
                    reg = ra & 0xff
                    if reg in REG:
                        key = (reg, val)
                        found[key] += 1
                        order.setdefault(key, o)
                o += 16 + 16 * nloop
                continue
        o += 4
    return packets, found


def main():
    path = sys.argv[1]
    data = open(path, 'rb').read()
    start = int(sys.argv[2], 16) & 0x1ffffff if len(sys.argv) > 2 else 0x00100000
    end = int(sys.argv[3], 16) & 0x1ffffff if len(sys.argv) > 3 else 0x01000000
    packets, found = scan(data, start, end)
    print(f'{packets} A+D packets, {len(found)} distinct register values\n')
    for (reg, val), n in sorted(found.items(), key=lambda kv: (kv[0][0], -kv[1])):
        print(f'{REG[reg]:<11} x{n:<5} 0x{val:016x}  {decode(reg, val)}')


if __name__ == '__main__':
    main()
