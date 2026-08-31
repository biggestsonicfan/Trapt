"""Which build of the game the tools are reading.

Two discs carry this game and the tools read both:

    Trapt (USA)                     `SLUS_212.55`   SLUS-21255
    Kagero II: Dark Illusion (JP)   `SLPS_254.45`   SLPS-25445

They are the same game.  `GAME.DAT` holds the same 3762 files under the same
names in the same order (the US disc adds eleven -- ten English voice takes and
two effect textures), every archive parses with the same readers, and the story
tables are **byte-identical** between the two executables.  What differs is
where those tables sit: the JP executable is 45 KB smaller and everything in
its read-only data moved, so an address is only meaningful next to the build it
came out of.  That is what this module is -- one `Region` per build, carrying
the disc's location and every ELF address the other tools resolve.

Selecting one:

    TRAPT_ROOT=<dir>      a disc directory (SYSTEM.CNF + the ELF + DATA/); the
                          region is read out of it
    TRAPT_REGION=us|jp    pick between the roots known below
    --root <dir>          the same, on any tool's command line
    --region us|jp

With nothing set, the first root that exists wins, US first.  `--root` and
`--region` are swept out of `sys.argv` when **this module is imported**, so
every tool that reaches the disc takes both flags without knowing they exist
and without its own positional parsing ever seeing them.

The addresses were found by matching each US table's bytes in the JP
executable (the story tables), by walking the 12-byte TOC records (the file
table), and by rendering candidate glyph bases against the US font (the face).
`python region.py [--region jp]` re-derives every one of them from the ELF and
says so, which is what keeps this table honest against a differently dumped
disc.
"""
import os
import struct
import sys


class Region:
    """One build: where its disc is and where things are inside its ELF."""

    def __init__(self, code, serial, elf_name, title, roots, toc, order,
                 font, ee):
        self.code = code                # 'us' | 'jp'
        self.serial = serial            # 'SLUS-21255', as PCSX2 names states
        self.elf_name = elf_name        # the file on the disc
        self.title = title
        self.roots = roots              # where the disc might be, in order
        self.toc = toc                  # (va, count) of the GAME.DAT TOC
        self.order = order              # story tables -- see order.py
        self.font = font                # subtitle face -- see font.py
        self.ee = ee                    # live EE RAM -- see oracle.py
        self._root = None

    # ------------------------------------------------------------- paths
    @property
    def root(self):
        """The disc directory, or a clear failure saying where it looked."""
        if self._root is None:
            for r in self.roots:
                if os.path.isfile(os.path.join(r, self.elf_name)):
                    self._root = r
                    break
            else:
                raise IOError(
                    'no %s disc found (%s missing from: %s).  Point TRAPT_ROOT '
                    'or --root at a directory holding it.'
                    % (self.code.upper(), self.elf_name,
                       ', '.join(self.roots) or '<nowhere>'))
        return self._root

    @root.setter
    def root(self, path):
        self._root = path

    @property
    def elf(self):
        return os.path.join(self.root, self.elf_name)

    @property
    def gamedat(self):
        return os.path.join(self.root, 'DATA', 'GAME.DAT')

    def __repr__(self):
        return '<Region %s %s>' % (self.code.upper(), self.serial)


# The disc directories that ship on this machine.  A dumped ISO extracts to
# one of these shapes: SYSTEM.CNF, the ELF, MODULES/ and DATA/GAME.DAT.
_PS2 = 'E:/Seagate/OpenSuseBack/Emulators/PS2EMU'

US = Region(
    'us', 'SLUS-21255', 'SLUS_212.55', 'Trapt',
    roots=[_PS2 + '/Trapt (USA)'],
    toc=(0x0036A0F0, 3773),
    order=dict(
        NAME_TABLE=0x00386920,          # 154 `const char *`
        FLAG_TABLE=0x0045DA10,          # 154 x 2 bytes
        GROUP_TABLE=0x0045DB50,         # 38 x {u8 count; u8 id[7]}
        CH_STAGES=0x0042DD20,           # 15 x {u8 count; u8 stage[3]}
        CH_OPEN=0x0042DD60,             # 15 x u8 group
        CH_STAGE_GROUPS=0x0042DD70,     # 15 x 3 x {u8 before, u8 after}
        CH_FLAG=0x0042DDD0,             # 15 x s8
        ROUTE_TABLE=0x003872A0,         # 15 x 2 x u8 -> flow record
        FLOW_TABLE=0x003872C0,          # 30 x 0x50
    ),
    font=dict(
        GLYPHS=0x003885C0,              # JIS-linear indexed, 128 B a glyph
        CLUT=0x00388580,                # 16 x RGBA32
        DESC=0x00450620,                # cell size + draw size
        WIDTH_DIR=0x004506E0,           # 8 x {u16 lo, u16 hi, u32 ptr, u32 n}
        WIDTH_DIR_N=8,
    ),
    # Each camera slot has its own frame counter beside it, and only the one
    # belonging to the live slot means anything -- the other reads filler or
    # a stale float.  `oracle.py --probe` found the attract path's by looking
    # for `frame + 1` near the camera that had just been matched; all four
    # e001 captures on this machine agree with their camera match exactly.
    ee=dict(
        CAM_SLOTS=(0x0081B6F0, 0x0081B730),
        COUNTERS={0x0081B6F0: 0x0081CA00,     # attract loop
                  0x0081B730: 0x0081CA40},    # story
    ),
)

JP = Region(
    'jp', 'SLPS-25445', 'SLPS_254.45', 'Kagero II: Dark Illusion',
    roots=[_PS2 + '/Kagero II (Japan)'],
    toc=(0x0036C070, 3762),
    # The story tables are the same bytes as the US ones, 0x97D70 further on
    # in the case of the three in `.rodata` and moved independently otherwise.
    order=dict(
        NAME_TABLE=0x0041E690,
        FLAG_TABLE=0x0045EB50,
        GROUP_TABLE=0x0045EC90,
        CH_STAGES=0x00429440,
        CH_OPEN=0x00429480,
        CH_STAGE_GROUPS=0x00429490,
        CH_FLAG=0x004294F0,
        ROUTE_TABLE=0x0041F010,
        FLOW_TABLE=0x0041F030,
    ),
    # Same face, re-rasterised: the kana and the level-1 kanji are pixel for
    # pixel the US glyphs, the Latin block is not (the US build redrew it).
    # There is **no width directory** -- the US one exists to letter-space a
    # proportional Latin face that only that build carries, and the JP build
    # sets every advance from the 16-texel cell, which is what `Font.advance`
    # already falls back to.
    font=dict(
        GLYPHS=0x00379580,
        CLUT=0x00379540,
        DESC=0x0044BE70,
        WIDTH_DIR=None,
        WIDTH_DIR_N=0,
    ),
    # Not yet found: these are heap addresses, not static ones, so they can
    # only come off a running JP game.  Where a region names none, `oracle.py`
    # finds the live camera by its shape instead -- `State.find_cameras` --
    # and `oracle.py --probe` is how a counter gets pinned once there is a JP
    # capture to pin it from.
    ee=dict(
        CAM_SLOTS=None,
        COUNTERS=None,
    ),
)

REGIONS = {'us': US, 'jp': JP}
BY_SERIAL = {r.serial: r for r in REGIONS.values()}
BY_ELF = {r.elf_name.upper(): r for r in REGIONS.values()}

_active = None


def of_root(path):
    """The region a disc directory holds, or None if it is not one."""
    for r in REGIONS.values():
        if os.path.isfile(os.path.join(path, r.elf_name)):
            return r
    cnf = os.path.join(path, 'SYSTEM.CNF')
    if os.path.isfile(cnf):
        # `BOOT2 = cdrom0:\SLPS_254.45;1`
        text = open(cnf, 'rb').read().decode('latin1')
        for name, r in BY_ELF.items():
            if name in text.upper():
                return r
    return None


def of_serial(name):
    """The region a PCSX2 filename names, or None.

    Savestates and memory cards are named after the boot id, so
    `SLPS-25445 (34F9C63D).03.p2s` says which disc it came off.
    """
    up = name.upper()
    for serial, r in BY_SERIAL.items():
        if serial in up:
            return r
    return None


def use(which):
    """Make a region active.  Takes a code, a serial, a `Region` or a path."""
    global _active
    if isinstance(which, Region):
        _active = which
    elif os.path.isdir(which):
        r = of_root(which)
        if r is None:
            raise IOError('%s holds no disc this knows (looked for %s)'
                          % (which, ' / '.join(sorted(BY_ELF))))
        r.root = which
        _active = r
    else:
        key = which.strip().lower()
        _active = REGIONS.get(key) or BY_SERIAL.get(which.strip().upper())
        if _active is None:
            raise ValueError('no such region %r (have: %s)'
                             % (which, ', '.join(sorted(REGIONS))))
    return _active


def active():
    """The region in force, selecting one the first time it is asked for."""
    global _active
    if _active is None:
        _active = _select()
    return _active


def _select():
    root = os.environ.get('TRAPT_ROOT')
    code = os.environ.get('TRAPT_REGION')
    if root:
        r = of_root(root)
        if r is None:
            raise IOError('TRAPT_ROOT=%s holds no disc this knows' % root)
        if code and REGIONS.get(code.lower()) is not r:
            raise ValueError('TRAPT_REGION=%s but TRAPT_ROOT is the %s disc'
                             % (code, r.code.upper()))
        r.root = root
        return r
    if code:
        r = REGIONS.get(code.strip().lower())
        if r is None:
            raise ValueError('no such region %r (have: %s)'
                             % (code, ', '.join(sorted(REGIONS))))
        return r
    for r in (US, JP):                  # US first: it is what the docs quote
        for path in r.roots:
            if os.path.isfile(os.path.join(path, r.elf_name)):
                return r
    return US                           # let `Region.root` say what is missing


def from_argv(argv=None):
    """Take `--root DIR` / `--region CODE` off a command line and apply them.

    Removes what it consumed, so a tool's own positional parsing never sees
    it.  This module calls it on import, which is how every tool in here ends
    up accepting both flags.  Selecting nothing selects nothing: a command
    line without either flag leaves the region unresolved, so the environment
    still decides and a later `use()` is still free to.
    """
    argv = sys.argv if argv is None else argv
    picked = None
    i = 1
    while i < len(argv):
        arg = argv[i]
        key, _, inline = arg.partition('=')
        if key in ('--root', '--region'):
            if inline:
                value, drop = inline, 1
            elif i + 1 < len(argv):
                value, drop = argv[i + 1], 2
            else:
                raise SystemExit('%s needs a value' % key)
            del argv[i:i + drop]
            picked = value
            continue
        i += 1
    return use(picked) if picked is not None else _active


# Importing this is what gives every tool `--region` and `--root`.  It has to
# happen at import: a tool's `main()` reads `sys.argv` positionally, and the
# flags have to be gone by then.
from_argv()


# --------------------------------------------------------------- checking

def v2f(va):
    """ELF virtual address -> file offset.  Both builds load at 0x100000+0x80.

    One PT_LOAD segment, `off=0x80 va=0x00100000`, in each.
    """
    return va - 0x00100000 + 0x80


def check(r=None):
    """Re-derive every address in a region from its ELF; yield complaints.

    Cheap enough to run from `verify.py`, and it is what keeps this table
    honest against a differently-dumped disc.
    """
    r = r or active()
    elf = open(r.elf, 'rb').read()

    def u32(va):
        return struct.unpack_from('<I', elf, v2f(va))[0]

    def cstr(va):
        o = v2f(va)
        return elf[o:elf.index(b'\0', o)].decode('latin1')

    va, n = r.toc
    first = cstr(u32(va))
    if first.upper() != 'DATA/AI/RC.ARC':
        yield 'TOC at %08x starts at %r, not DATA/AI/RC.ARC' % (va, first)
    last = struct.unpack_from('<III', elf, v2f(va) + 12 * (n - 1))
    if last[2] != n - 1:
        yield 'TOC last record has AFS id %d, not %d' % (last[2], n - 1)

    names = [cstr(u32(r.order['NAME_TABLE'] + 4 * i)) for i in range(3)]
    if names != ['e001', 'e002', 'e003']:
        yield 'NAME_TABLE at %08x starts %s' % (r.order['NAME_TABLE'], names)

    o = v2f(r.font['CLUT'])
    if elf[o:o + 4] != b'\0\0\0\0' or elf[o + 15] != 0x13:
        yield 'CLUT at %08x is not the coverage ramp' % r.font['CLUT']
    _, cw, ch, dw, dh = struct.unpack_from('<IHHff', elf, v2f(r.font['DESC']))
    if (cw, ch, dw, dh) != (16, 16, 24.0, 24.0):
        yield 'DESC at %08x reads %s' % (r.font['DESC'], (cw, ch, dw, dh))
    # The space glyph is blank and the one after it is not, in both builds.
    g = v2f(r.font['GLYPHS'])
    if any(elf[g:g + 128]) or not any(elf[g + 128:g + 256]):
        yield 'GLYPHS at %08x does not start on the blank space glyph' \
              % r.font['GLYPHS']


def main():
    r = active()
    print('%s  %s' % (r.serial, r.title))
    try:
        print('  root     %s' % r.root)
        print('  elf      %s' % r.elf)
        print('  gamedat  %s' % r.gamedat)
    except IOError as e:
        print('  %s' % e)
        return 1
    print('  toc      %08x x %d' % r.toc)
    bad = list(check(r))
    for line in bad:
        print('  ! %s' % line)
    print('  %s' % ('all addresses check out' if not bad
                    else '%d address(es) wrong' % len(bad)))
    print('\nknown regions:')
    for code in sorted(REGIONS):
        o = REGIONS[code]
        print('  %-3s %s  %-26s %s' % (code, o.serial, o.title,
                                       ' '.join(o.roots)))
    return 1 if bad else 0


if __name__ == '__main__':
    raise SystemExit(main())
