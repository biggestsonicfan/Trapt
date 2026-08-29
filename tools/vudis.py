"""Disassembler for PS2 VU (Vector Unit) microcode.

    python vudis.py vu1MicroMem.bin [start] [count]
    python vudis.py --elf 0x00343110 0x00343388     # a program inside the ELF

A VU instruction is 64 bits: the LOWER word first, then the UPPER word, both
little-endian.  The two issue in parallel, so the listing prints them side by
side the way the hardware runs them.

    UPPER   31 I | 30 E | 29 M | 28 D | 27 T | 24-21 DEST(xyzw)
            20-16 FT | 15-11 FS | 10-6 FD | 5-0 opcode
            opcodes 0x3C-0x3F escape to a sub-opcode built from bits 10-6 and 1-0

    LOWER   31-25 opcode, with 0x40 escaping to a sub-opcode in bits 5-0 (+ 10-6)

`E` on an upper instruction ends the microprogram (two more instructions still
execute after it), which is how the program bank is split into 19 programs.
"""
import struct
import sys

BC = 'xyzw'
DESTC = 'xyzw'

UPPER = {}
for i, n in ((0x00, 'ADDA'), (0x04, 'SUBA'), (0x08, 'MADDA'), (0x0C, 'MSUBA')):
    pass
for base, name in ((0x00, 'ADD'), (0x04, 'SUB'), (0x08, 'MADD'), (0x0C, 'MSUB'),
                   (0x10, 'MAX'), (0x14, 'MINI'), (0x18, 'MUL')):
    for b in range(4):
        UPPER[base + b] = name + BC[b]
UPPER.update({0x1C: 'MULq', 0x1D: 'MAXi', 0x1E: 'MULi', 0x1F: 'MINIi',
              0x20: 'ADDq', 0x21: 'MADDq', 0x22: 'ADDi', 0x23: 'MADDi',
              0x24: 'SUBq', 0x25: 'MSUBq', 0x26: 'SUBi', 0x27: 'MSUBi',
              0x28: 'ADD', 0x29: 'MADD', 0x2A: 'MUL', 0x2B: 'MAX',
              0x2C: 'SUB', 0x2D: 'MSUB', 0x2E: 'OPMSUB', 0x2F: 'MINI'})

UPPER_EXT = {}
for base, name in ((0x00, 'ADDA'), (0x04, 'SUBA'), (0x08, 'MADDA'),
                   (0x0C, 'MSUBA'), (0x18, 'MULA')):
    for b in range(4):
        UPPER_EXT[base + b] = name + BC[b]
UPPER_EXT.update({0x10: 'ITOF0', 0x11: 'ITOF4', 0x12: 'ITOF12', 0x13: 'ITOF15',
                  0x14: 'FTOI0', 0x15: 'FTOI4', 0x16: 'FTOI12', 0x17: 'FTOI15',
                  0x1C: 'MULAq', 0x1D: 'ABS', 0x1E: 'MULAi', 0x1F: 'CLIP',
                  0x20: 'ADDAq', 0x21: 'MADDAq', 0x22: 'ADDAi', 0x23: 'MADDAi',
                  0x24: 'SUBAq', 0x25: 'MSUBAq', 0x26: 'SUBAi', 0x27: 'MSUBAi',
                  0x28: 'ADDA', 0x29: 'MADDA', 0x2A: 'MULA', 0x2B: 'OPMULA',
                  0x2C: 'SUBA', 0x2D: 'MSUBA', 0x2E: 'NOP'})

# Upper opcodes 0x3C-0x3F escape to one of FOUR sub-tables, chosen by `op & 3`,
# indexed by bits 10-6 (the FD field).  Using a single merged table decodes the
# matrix-multiply idiom as SUBAz/ADDAi nonsense instead of MULAx/MADDAy/MADDAz.
UPPER_FD = [
  ['ADDAx','SUBAx','MADDAx','MSUBAx','ITOF0', 'FTOI0', 'MULAx','MULAq',
   'ADDAq','SUBAq','ADDA','SUBA'],
  ['ADDAy','SUBAy','MADDAy','MSUBAy','ITOF4', 'FTOI4', 'MULAy','ABS',
   'MADDAq','MSUBAq','MADDA','MSUBA'],
  ['ADDAz','SUBAz','MADDAz','MSUBAz','ITOF12','FTOI12','MULAz','MULAi',
   'ADDAi','SUBAi','MULA','OPMULA'],
  ['ADDAw','SUBAw','MADDAw','MSUBAw','ITOF15','FTOI15','MULAw','CLIP',
   'MADDAi','MSUBAi',None,'NOP'],
]

# Lower "LowerOP" (op field 0x40) escapes on `code & 0x3f` in 0x3C-0x3F to four
# more tables, again indexed by bits 10-6.  Empty slots are architectural NOPs.
LOWER_T3 = [
  ['MOVE','LQI','DIV','MTIR','RNEXT',None,None,None,
   'ESADD','EATANxy','ESQRT','ESIN',None,None,None,None,
   None,'XTOP',None,None,None,None,None,None,None,None,None,None,None,None,None,None],
  ['MR32','SQI','SQRT','MFIR','RGET',None,None,None,
   'ERSADD','EATANxz','ERSQRT','EATAN',None,None,None,None,
   None,'XITOP',None,None,None,None,None,None,None,None,None,None,None,None,None,None],
  [None,'LQD','RSQRT','ILWR','RINIT',None,None,None,
   'ELENG','ESUM','ERCPR','EEXP',None,None,None,None,
   'MFP',None,'XGKICK',None,None,None,None,None,None,None,None,None,None,None,None,None],
  [None,'SQD','WAITQ','ISWR','RXOR',None,None,None,
   'ERLENG',None,'WAITP',None,None,None,None,None,
   None,None,None,None,None,None,None,None,None,None,None,None,None,None,None,None],
]

LOWER = {0x00: 'LQ', 0x01: 'SQ', 0x04: 'ILW', 0x05: 'ISW',
         0x08: 'IADDIU', 0x09: 'ISUBIU', 0x10: 'FCEQ', 0x11: 'FCSET',
         0x12: 'FCAND', 0x13: 'FCOR', 0x14: 'FSEQ', 0x15: 'FSSET',
         0x16: 'FSAND', 0x17: 'FSOR', 0x18: 'FMEQ', 0x1A: 'FMAND',
         0x1B: 'FMOR', 0x1C: 'FCGET', 0x20: 'B', 0x21: 'BAL',
         0x24: 'JR', 0x25: 'JALR', 0x28: 'IBEQ', 0x29: 'IBGEZ',
         0x2A: 'IBGTZ', 0x2B: 'IBLEZ', 0x2C: 'IBLTZ', 0x2D: 'IBNE',
         0x3C: 'LQD', 0x3D: 'SQD', 0x3E: 'LQI', 0x3F: 'SQI'}

LOWER2 = {0x30: 'IADD', 0x31: 'ISUB', 0x32: 'IADDI', 0x34: 'IAND', 0x35: 'IOR',
          0x40: 'MOVE', 0x41: 'MR32', 0x44: 'LQI', 0x45: 'SQI', 0x46: 'LQD',
          0x47: 'SQD', 0x48: 'DIV', 0x49: 'SQRT', 0x4A: 'RSQRT', 0x4B: 'WAITQ',
          0x4C: 'MTIR', 0x4D: 'MFIR', 0x4E: 'ILWR', 0x4F: 'ISWR',
          0x50: 'RINIT', 0x51: 'RGET', 0x52: 'RNEXT', 0x53: 'RXOR',
          0x64: 'MFP', 0x68: 'XTOP', 0x69: 'XITOP', 0x6C: 'XGKICK',
          0x70: 'ESADD', 0x71: 'ERSADD', 0x72: 'ELENG', 0x73: 'ERLENG',
          0x74: 'EATANxy', 0x75: 'EATANxz', 0x76: 'ESUM', 0x78: 'ERCPR',
          0x79: 'ESQRT', 0x7A: 'ERSQRT', 0x7B: 'ESIN', 0x7C: 'EATAN',
          0x7D: 'EEXP'}


def dest_str(d):
    s = ''.join(DESTC[i] for i in range(4) if d & (8 >> i))
    return s or '(none)'


def disasm_upper(w):
    op = w & 0x3F
    dest = (w >> 21) & 0xF
    ft, fs, fd = (w >> 16) & 0x1F, (w >> 11) & 0x1F, (w >> 6) & 0x1F
    flags = ''.join(c for c, b in (('I', 31), ('E', 30), ('M', 29), ('D', 28), ('T', 27))
                    if w & (1 << b))
    d = dest_str(dest)
    if op in (0x3C, 0x3D, 0x3E, 0x3F):
        tbl = UPPER_FD[op & 3]
        idx = (w >> 6) & 0x1F
        name = tbl[idx] if idx < len(tbl) and tbl[idx] else 'nop'
        if name == 'NOP':
            text = 'NOP'
        elif name.startswith(('ITOF', 'FTOI', 'ABS')):
            text = '%-8s vf%02d.%s, vf%02d' % (name, ft, d, fs)
        elif name.startswith(('ADDA', 'SUBA', 'MADDA', 'MSUBA', 'MULA', 'OPMULA')):
            if name[-1] in 'xyzw' and name[:-1] in ('ADDA', 'SUBA', 'MADDA', 'MSUBA', 'MULA'):
                text = '%-8s ACC.%s, vf%02d, vf%02d%s' % (name, d, fs, ft, name[-1])
            elif name.endswith(('q', 'i')):
                text = '%-8s ACC.%s, vf%02d, %s' % (name, d, fs, name[-1].upper())
            else:
                text = '%-8s ACC.%s, vf%02d, vf%02d' % (name, d, fs, ft)
        elif name == 'CLIP':
            text = '%-8s vf%02d.xyz, vf%02d.w' % (name, fs, ft)
        else:
            text = '%-8s vf%02d.%s, vf%02d, vf%02d' % (name, fd, d, fs, ft)
    else:
        name = UPPER.get(op, 'UPPER?%02x' % op)
        if name[-1] in 'xyzw' and name[:-1] in ('ADD', 'SUB', 'MADD', 'MSUB',
                                                'MAX', 'MINI', 'MUL'):
            text = '%-8s vf%02d.%s, vf%02d, vf%02d%s' % (name, fd, d, fs, ft, name[-1])
        elif name.endswith(('q', 'i')) and name not in ('MAXi', 'MINIi'):
            text = '%-8s vf%02d.%s, vf%02d, %s' % (name, fd, d, fs, name[-1].upper())
        elif name in ('MAXi', 'MINIi'):
            text = '%-8s vf%02d.%s, vf%02d, I' % (name, fd, d, fs)
        else:
            text = '%-8s vf%02d.%s, vf%02d, vf%02d' % (name, fd, d, fs, ft)
    return text, flags


def disasm_lower(w, pc):
    if w == 0:
        return 'NOP'
    op = (w >> 25) & 0x7F
    dest = (w >> 21) & 0xF
    ft, fs = (w >> 16) & 0x1F, (w >> 11) & 0x1F
    it, is_ = ft, fs
    d = dest_str(dest)
    if op == 0x40:
        sub = w & 0x3F
        fd = (w >> 6) & 0x1F
        if sub in (0x3C, 0x3D, 0x3E, 0x3F):
            tbl = LOWER_T3[sub & 3]
            name = tbl[fd] if fd < len(tbl) else None
            if name is None:
                return 'nop'
        else:
            name = LOWER2.get(sub)
            if name is None:
                return 'lower?%02x  (%08x)' % (sub, w)
        if name in ('MOVE', 'MR32'):
            return '%-8s vf%02d.%s, vf%02d' % (name, ft, d, fs)
        if name in ('DIV', 'RSQRT'):
            fsf, ftf = (w >> 21) & 3, (w >> 23) & 3
            return '%-8s Q, vf%02d.%s, vf%02d.%s' % (name, fs, BC[fsf], ft, BC[ftf])
        if name == 'SQRT':
            ftf = (w >> 23) & 3
            return '%-8s Q, vf%02d.%s' % (name, ft, BC[ftf])
        if name == 'XGKICK':
            return '%-8s vi%02d' % (name, is_)
        if name in ('XTOP', 'XITOP', 'FCGET', 'RGET', 'RNEXT', 'MFP'):
            return '%-8s vi%02d' % (name, it)
        if name in ('IADD', 'ISUB', 'IAND', 'IOR'):
            return '%-8s vi%02d, vi%02d, vi%02d' % (name, fd, is_, it)
        if name == 'IADDI':
            imm = (w >> 6) & 0x1F
            imm = imm - 32 if imm & 0x10 else imm
            return '%-8s vi%02d, vi%02d, %d' % (name, it, is_, imm)
        if name in ('MTIR',):
            fsf = (w >> 21) & 3
            return '%-8s vi%02d, vf%02d.%s' % (name, it, fs, BC[fsf])
        if name in ('MFIR', 'ILWR', 'ISWR'):
            return '%-8s vf%02d.%s, vi%02d' % (name, ft, d, is_)
        if name in ('LQI', 'SQI', 'LQD', 'SQD'):
            return '%-8s vf%02d.%s, (vi%02d)' % (name, ft, d, is_)
        return '%-8s' % name
    name = LOWER.get(op)
    if name is None:
        return 'LOWER?%02x  (%08x)' % (op, w)
    if name in ('LQ', 'SQ'):
        imm = w & 0x7FF
        imm = imm - 0x800 if imm & 0x400 else imm
        return ('%-8s vf%02d.%s, %d(vi%02d)' % (name, ft, d, imm, is_)
                if name == 'LQ' else
                '%-8s vf%02d.%s, %d(vi%02d)' % (name, fs, d, imm, it))
    if name in ('ILW', 'ISW'):
        imm = w & 0x7FF
        imm = imm - 0x800 if imm & 0x400 else imm
        return '%-8s vi%02d, %d(vi%02d).%s' % (name, it, imm, is_, d)
    if name in ('IADDIU', 'ISUBIU'):
        imm = ((w >> 10) & 0x7800) | (w & 0x7FF)
        return '%-8s vi%02d, vi%02d, 0x%x' % (name, it, is_, imm)
    if name in ('B', 'BAL'):
        imm = w & 0x7FF
        imm = imm - 0x800 if imm & 0x400 else imm
        tgt = pc + 1 + imm
        return '%-8s 0x%03x' % (name, tgt) if name == 'B' else '%-8s vi%02d, 0x%03x' % (name, it, tgt)
    if name in ('IBEQ', 'IBNE'):
        imm = w & 0x7FF
        imm = imm - 0x800 if imm & 0x400 else imm
        return '%-8s vi%02d, vi%02d, 0x%03x' % (name, it, is_, pc + 1 + imm)
    if name.startswith('IB'):
        imm = w & 0x7FF
        imm = imm - 0x800 if imm & 0x400 else imm
        return '%-8s vi%02d, 0x%03x' % (name, is_, pc + 1 + imm)
    if name in ('JR', 'JALR'):
        return '%-8s vi%02d' % (name, is_)
    return '%-8s' % name


def disasm(data, base_instr=0, count=None, origin=0):
    """Yield ``(pc, lower_word, upper_word, text)`` for each instruction."""
    n = len(data) // 8 if count is None else count
    out = []
    for i in range(n):
        q = (base_instr + i) * 8 - origin
        if q < 0 or q + 8 > len(data):
            break
        lo, up = struct.unpack_from('<II', data, q)
        pc = base_instr + i
        utext, flags = disasm_upper(up)
        ltext = disasm_lower(lo, pc)
        out.append((pc, lo, up, utext, ltext, flags))
    return out


def main():
    if sys.argv[1] == '--elf':
        elf = 'E:/Seagate/OpenSuseBack/Emulators/PS2EMU/Trapt (USA)/SLUS_212.55'
        d = open(elf, 'rb').read()
        start = int(sys.argv[2], 16); end = int(sys.argv[3], 16)
        off = start - 0x00100000 + 0x80
        data = d[off:off + (end - start)]
        base = 0
    else:
        data = open(sys.argv[1], 'rb').read()
        base = int(sys.argv[2], 0) if len(sys.argv) > 2 else 0
        cnt = int(sys.argv[3], 0) if len(sys.argv) > 3 else None
        data = data[base * 8: (base + cnt) * 8 if cnt else None]
        base = base
    for pc, lo, up, utext, ltext, flags in disasm(data, base, origin=base * 8):
        print('%03x: %08x %08x  %-2s %-36s | %s'
              % (pc, up, lo, flags, utext, ltext))


if __name__ == '__main__':
    main()
