"""Compile a Trapt real-time cutscene into a flat, renderable timeline.

Reads the `.SSC` tracks of one cutscene (see `docs/CUTSCENES.md`) and resolves
them into the things a viewer actually needs: which archives to open, which
models each actor wears, which animation clip plays from which frame, when
actors appear and vanish, the camera track, the subtitles, and the audio cues.

    >>> sc = load('e001')
    >>> sc.room, sc.duration, len(sc.actors), len(sc.subtitles)
    ('rp03', 11890, 11, 45)

`Scene.events` keeps every opcode the tracks executed, guarded by the frame its
enclosing `at_time` selected, so unnamed opcodes are still inspectable rather
than silently dropped.
"""
import collections
import math
import os
import struct

import afs
import arc
import cam as cam_mod
import sli as sli_mod
import sai as sai_mod
import ssc

# opcodes we act on
OP_END = 0x00
OP_AT_TIME = 0x04
OP_CUE = 0x05
OP_SPAWN = 0x06
OP_PRELOAD = 0x09
OP_SPAWN_FX_AT = 0x07      # (track, x, y, z, target) -- offset from a target
OP_SPAWN_FX = 0x08         # (track, x, y, z, flags)  -- world position
OP_SPAWN_FX_BONE = 0x0C    # (track, bone) -- on one of the spawner's bones
OP_SCENE_BEGIN = 0x50
OP_SCENE_END = 0x51
OP_FADE_IN = 0x53
OP_FADE_OUT = 0x54
OP_PLAY_ANIM = 0x55
OP_LETTERBOX = 0x57
OP_VOICE = 0x59
OP_BGM_START = 0x5A
OP_BGM_STOP = 0x5B
OP_SUB_SHOW = 0x60
OP_SUB_HIDE = 0x61
OP_SET_ROOM = 0x62
OP_RELEASE_ANIM = 0x52
OP_BLOCK_BEGIN = 0x64
OP_BLOCK_END = 0x65
OP_BLOCK_DROP = 0x67
OP_SCALE = 0x80
OP_MODEL = 0x82
OP_ANIM = 0x83
OP_TRANSFORM = 0x84
OP_TINT = 0x7E             # (r, g, b, a, mask) -- colour and alpha
OP_VISIBLE = 0xA2
OP_ROOT_BONE = 0xB3
OP_LIGHT_TYPE = 0xB4
OP_LIGHT_RANGE = 0xB5
OP_LIGHT_LIFE = 0x69       # a light block's life, in frames
OP_ATTACH = 0xB7
# `0xB2 (name, show, 0)`, ELF 0x001C20C0 -> 0x001D53F0: hide the model's node
# `name` and what hangs under it (show 0 adds the name to a four-slot list at
# model +0x22C, 1 takes it out).  Always "buki", the weapon, on the disc.
OP_HIDE_PART = 0xB2
OP_CAMERA = 0xB9
OP_FOG = 0xC7
# Sprite effects.  Handlers, from the dispatch table at 0x00376660:
#   0x68 FUN_001C4C90  string + 4 ints -> effect vtable +0x80
#   0x6D FUN_001C47F0  two numbers + a frame -> a keyframe list
#   0x6E FUN_001C46A0  four numbers + a frame -> another keyframe list
#   0xCA FUN_001C1D50  actor + bone; asserts the effect's kind is 3
OP_FX_TEXTURE = 0x68
# `0x6C` FUN_001C45C0 -- six flags.  The handler reads six values, coerces
# each to a boolean with `!= 0`, and passes all six to a vtable method at
# +0x10, so whatever they are they are switches rather than numbers.
#
# The fourth one is the only one this viewer needs, and the disc identifies it
# without ambiguity.  Eight sprite blocks across the 154 cutscenes carry a
# `0x6C`; the fourth flag is set on three of them, and those three are the
# only blocks that draw `ef_s014c.tm2` -- plus one more on `ef_e129d.tm2`.
# Measured straight out of the pixels, those two textures are also the only
# two of the sixteen sprite textures whose alpha does **not** peak in the
# middle: `ef_s014c.tm2` is a clean radial falloff centred on its
# bottom-right *corner* (flat 255 out to r=30, zero by r=66, on a 64x64
# tile), and `ef_e129d.tm2` peaks on two opposite corners.  The other five
# textures that carry a `0x6C` are all centred and all have the flag clear.
#
# Five for five and two for two: the flag says the tile is a **quadrant** and
# the billboard is it mirrored into all four, which puts the tile's
# bottom-right corner at the centre of the sprite and the glow comes out
# round.  Drawn flat the way the other fifteen are, it is a hard-edged square
# that is fully opaque along two of its sides -- which is exactly what e004
# looked like.
OP_FX_QUAD_FLAGS = 0x6C
OP_FX_SIZE_KEY = 0x6D
OP_FX_COLOUR_KEY = 0x6E
# `0xAA` and `0xAB` dispatch to the *same handlers* as `0x6E` and `0x6D`
# (FUN_001C46A0 and FUN_001C47F0), so they are aliases, not new opcodes: one
# keyframe implementation shared by the sprite path and the particle path.
# e001's torch flame uses the `0xAA`/`0xAB` spelling exclusively, which is why
# it had no colour ramp and no growth until these were read.
OP_FX_COLOUR_KEY2 = 0xAA
OP_FX_SIZE_KEY2 = 0xAB
# `0x9F` FUN_001C4A50 -- the sprite sheet's grid and how fast it is played.
#   arg1 -> columns, arg2 -> rows, arg3 -> cell count
# Each defaults to the derived value when the script passes 0: the handler
# computes columns as `sheet_w / cell_w` and rows as `sheet_h / cell_h` from
# the very fields `0x68` filled in, which is what proves `0x68`'s four numbers
# are (cell w, cell h, sheet w, sheet h).  The count defaults to rows*columns.
# `arg0` lands at +0x2a and the handler then writes `arg0 * cells` to +0xb4.
# For e001's torch that is 4 * (4*8) = 128, which is exactly where its `0xAA`
# alpha keys end -- so arg0 is **frames per cell** and +0xb4 the whole life.
OP_FX_GRID = 0x9F
OP_FX_EMIT_A = 0xC8
OP_FX_EMIT_B = 0xC9
OP_FX_BIND_BONE = 0xCA
# The particle emitter.  Each handler asks the effect object (vtable +0xD8)
# for its emitter, vtable 0x00478FF0, and calls one setter on it;
# tools/web/particles.js runs the fields, docs/VIEWER.md 10.25 has where each
# one was found.
#   0x9E FUN_001C40C0 -> +0x20 (slots, life max, life min, 1/rate, fade
#        fraction, spawns per frame, re-roll) -- and zeroes the acceleration
#   0x74 FUN_001C3C10 -> +0x34 (a)        Y acceleration, stored negated
#   0x77 FUN_001C3600 -> +0x3C (r1, v1, r0, v0, out)   the sphere shape
#   0xAE FUN_001C3740 -> +0x4C (v, bx, by, bz, jx, jy, jz, deg)   the box
OP_PT_EMITTER = 0x9E
OP_PT_ACCEL = 0x74
OP_PT_SPHERE = 0x77
OP_PT_BOX = 0xAE

# `0x57 letterbox(mode, frames)` -- ELF 0x001C6570 -> 0x001E4600/0x001E4650,
# tweened by 0x001E43F0.  The bars are two black 640-wide sprites in the same
# 640x448 UI space the subtitles are laid out in, and the handler re-sets their
# heights every time it brings them in: (48, 48) when the master script's name
# starts with `rt_di`, (50, 110) otherwise -- which is every cutscene on the
# disc.  Scaled into the 512x224 framebuffer by (0.8, 0.5) that is a 25-line
# band at the top and a 55-line one from y=169 down, which is exactly what a
# PCSX2 capture of `e001` at 7422 measures.
#
# `mode` 0 slides them in over `frames`, 1 slides them out, anything else
# leaves them where they are.  All 149 cutscenes do the same thing: `(0, 1)`
# on the first frame and `(1, 1)` on the last (`e017` never closes).
LETTERBOX_UI = (640.0, 448.0)
LETTERBOX_BARS = (50.0, 110.0)
LETTERBOX_BARS_DI = (48.0, 48.0)   # scripts named `rt_di...`; none are cutscenes
LETTERBOX_MODES = {0: 'in', 1: 'out'}

KIND_MODEL = 4
KIND_LIGHT = 6
KIND_CAMERA = 7

LIGHT_KINDS = {0: 'directional', 1: 'point', 4: 'ambient', 5: 'black'}

BS = chr(92)
NL = BS + 'n'
NUL = BS + '0'


def _sample(keys, t, default):
    """Linear interpolation over `[(frame, *values), ...]`, held at both ends.

    Keys arrive in script order, which is ascending on the disc, and the first
    one is usually at frame 0.  Before the first and after the last the value
    is held rather than extrapolated -- `ef_e004_30`'s alpha ends on 0 and an
    extrapolated fifth frame would drive it negative.
    """
    if not keys:
        return default
    if t <= keys[0][0]:
        return tuple(keys[0][1:])
    if t >= keys[-1][0]:
        return tuple(keys[-1][1:])
    for i in range(len(keys) - 1):
        a, b = keys[i], keys[i + 1]
        if a[0] <= t <= b[0]:
            span = b[0] - a[0]
            f = 0.0 if span <= 0 else (t - a[0]) / span
            return tuple(av + (bv - av) * f for av, bv in zip(a[1:], b[1:]))
    return tuple(keys[-1][1:])


class Entity:
    """One `0x64 ... 0x65` block: a model, a light or the camera."""

    def __init__(self, track, index, kind, label):
        self.track = track
        self.index = index
        self.kind = kind
        self.label = label        # 'none', 'joyu', 'rt_amb', ...
        self.models = []          # ['c01f_a_h.smi', 'c01f_a.smi']
        self.attachments = []     # [(model, bone, scale)]
        self.root_bone = None
        self.transform = None     # (x, y, z, w)
        self.scale = None         # scale on a model, colour on a light
        self.clips = []           # [(frame, 'x.sai', clip_offset)]
        self.visibility = []      # [(frame, bool)]
        self.parts = []           # [(frame, node name, shown)] from `0xB2`
        self.light = None         # 'directional' | 'point' | 'ambient'
        self.light_range = None   # (near, far)
        self.light_parent = False # `0xB4` arg1: ride the camera (see below)
        self.light_dir = None     # inherited from the room's `.sli`
        self.light_life = None    # `0x69` on a light block, frames
        self.bone = None          # (spawner track, bone) for a `0x0C` spawn
        self.origin = None        # world position a `0x08` spawn placed it at
        self.tint = None          # (r, g, b, w) from `0x7E`; w is not alpha
        self.start = 0            # frame the block ran on
        self.end = None           # frame `0x67` destroyed it, if it ever did
        # --- sprite effects: a block that names a texture instead of a model
        self.sprite = None        # {'texture', 'cell': (w,h), 'sheet': (w,h)}
        self.size_keys = []       # [(frame, sx, sy)]     from `0x6D`
        self.colour_keys = []     # [(frame, r,g,b,a)]    from `0x6E`
        self.binds = []           # [(actor, bone)]       from `0xCA`
        self.emitter = None       # raw `0xC8` / `0xC9` parameters
        self.grid = None          # {'rate', 'cols', 'rows', 'cells'} from `0x9F`
        self.particles = None     # the emitter: `0x9E`, `0x74`, `0x77`, `0xAE`
        self.flags = None         # the six booleans from `0x6C`
        self.track_len = None     # how long its track ran, in frames

    @property
    def is_sprite(self):
        return self.sprite is not None

    @property
    def mirror(self):
        """Is this tile one quadrant of a sprite mirrored into four?"""
        return bool(self.flags and len(self.flags) > 3 and self.flags[3])

    def size_at(self, local):
        """Sprite size at `local` frames since the block began: `(sx, sy)`."""
        return _sample(self.size_keys, local, (1.0, 1.0))

    def colour_at(self, local):
        """Sprite colour at `local`: `(r, g, b, a)`, unclamped."""
        return _sample(self.colour_keys, local, (1.0, 1.0, 1.0, 1.0))

    @property
    def is_light(self):
        return self.kind == KIND_LIGHT

    @property
    def name(self):
        if self.models:
            return self.models[0].rsplit('.', 1)[0]
        return self.label or self.track

    @property
    def render_models(self):
        """The models to actually draw.

        A block often attaches both ``x_h.smi`` and ``x.smi``.  Those are not
        two parts of one character: ``_h`` is the same model with a facial rig
        (eight extra bones -- ``lip_U/D/Lu/Ru``, ``me_L/R``, ``mayuge``,
        ``miken``) and its own higher-detail texture set, used when a cutscene
        needs lip-sync.  Drawing both renders the character twice and z-fights.
        """
        stems = {m.rsplit('.', 1)[0]: m for m in self.models}
        drop = {base for base in stems if base + '_h' in stems}
        return [m for stem, m in stems.items() if stem not in drop]

    def clip_at(self, frame):
        """The clip playing at `frame`, as ``(start_frame, filename)``."""
        current = None
        for start, filename, _off in self.clips:
            if start <= frame:
                current = (start, filename)
        return current

    def visible_at(self, frame):
        if frame < self.start or (self.end is not None and frame >= self.end):
            return False
        state = True
        for f, on in self.visibility:
            if f <= frame:
                state = on
        return state

    def hidden_parts_at(self, frame):
        """The node names `0xB2` has hidden at `frame`."""
        hidden = set()
        for f, name, shown in self.parts:
            if f <= frame:
                (hidden.discard if shown else hidden.add)(name)
        return hidden

    def __repr__(self):
        return '<Entity %s kind=%s models=%s clips=%d>' % (
            self.name, self.kind, self.models, len(self.clips))


class Subtitle:
    # `raw` is the cue exactly as the script stores it -- full-width Shift-JIS
    # with its `%%SCSV` / `%%RC` / `\n` markup intact.  `speaker` and `lines`
    # are that same text folded to ASCII, which is what a modern renderer wants
    # and what the game's own font cannot be driven from: the PS2 face is
    # indexed by Shift-JIS and every glyph in a cue is a full-width one.
    __slots__ = ('frame', 'end', 'speaker', 'lines', 'voice', 'raw')

    def __init__(self, frame, speaker, lines, voice, raw=''):
        self.frame = frame
        self.end = None
        self.speaker = speaker
        self.lines = lines
        self.voice = voice
        self.raw = raw

    def __repr__(self):
        return '<Subtitle %d %r %r>' % (self.frame, self.speaker, self.lines)


class Scene:
    def __init__(self, name):
        self.name = name
        self.room = None
        self.duration = 0
        self.entities = []
        self.subtitles = []
        self.bgm = []             # [(frame, 'start'|'stop', id)]
        self.fades = []           # [(frame, 'in'|'out', frames)]
        self.letterbox = []       # [(frame, 'in'|'out'|'hold', frames)]
        self.bars = LETTERBOX_BARS  # (top, bottom) heights in 640x448 UI units
        self.camera = None        # cam.Track
        self.camera_file = None
        self.fog = None           # (near, far, r, g, b)
        self.room_model = None    # '<room>.smi' from DATA/ROOM/<ROOM>_ALL.ARC
        self.room_lights = []     # <room>.sli, the room's own light set
        self.effects = []         # [(frame, track, (x,y,z), target, bone)]
                                  # from 0x07/0x08/0x0C
        self.events = []          # (frame, track, opcode, args)
        self.archives = {}        # lower-case member name -> bytes
        self.loose = {}           # lower-case base name -> bytes (streamed .sai)
        self.tracks = []

    @property
    def actors(self):
        return [e for e in self.entities if e.kind == KIND_MODEL and e.models]

    @property
    def lights(self):
        return [e for e in self.entities if e.is_light]

    def asset(self, name):
        """Look a member up across every archive plus the loose files."""
        key = name.lower()
        return self.archives.get(key) or self.loose.get(key)

    def __repr__(self):
        return ('<Scene %s room=%s %d frames, %d entities, %d subtitles>'
                % (self.name, self.room, self.duration, len(self.entities),
                   len(self.subtitles)))


# ------------------------------------------------------------------ disc I/O

class Disc:
    """Lazy accessor over GAME.DAT with the ELF filename table."""

    def __init__(self, gamedat=None, elf=None):
        self.toc = afs.load_toc(elf) if elf else afs.load_toc()
        self.map, self.ents = afs.open_afs(gamedat) if gamedat else afs.open_afs()
        self.by_name = {v[0].upper(): k for k, v in self.toc.items()}

    def read(self, path):
        aid = self.by_name.get(path.upper())
        if aid is None:
            return None
        off, size = self.ents[aid]
        return bytes(self.map[off:off + size])

    def glob(self, prefix):
        prefix = prefix.upper()
        return sorted(n for n in self.by_name if n.startswith(prefix))

    def members(self, path):
        blob = self.read(path)
        if blob is None:
            return {}
        return {n.lower(): blob[o:o + s] for n, o, s in arc.entries(blob)}


# ------------------------------------------------------------- SSC execution

def _text(raw):
    """Split a `0x60` subtitle payload into (speaker, [lines])."""
    raw = raw.rstrip(chr(0)).replace(NUL, '')
    speaker = ''
    if raw.startswith('%%SCSV') and '%%RC' in raw:
        speaker, raw = raw[6:].split('%%RC', 1)
        if raw.startswith(NL):
            raw = raw[2:]
    return ssc._plain(speaker), [ssc._plain(x) for x in raw.split(NL)]


# `0xA2` is a set/clear on a bitmask, not a boolean: the handler at ELF
# 0x001C8650 forwards (mask, flag) to 0x0029EC80, which does
# `flags |= mask` / `flags &= ~mask` on the word at `+0xE0`.  Bit 31 is the
# hidden bit -- setting it hides, clearing it shows.  Two independent checks
# against a PCSX2 frame at 7422 of e001 settle the polarity: Graines
# (`6060:set`) is absent there and Catalina (`7260:clear`) is present, and the
# opposite reading gets both backwards.
VIS_HIDDEN = 0x80000000


def _int(a):
    """An opcode argument as a 32-bit unsigned mask."""
    return int(_num(a)) & 0xFFFFFFFF


def _f32(x):
    """`x` rounded to single precision, as the game's FPU holds it."""
    return struct.unpack('<f', struct.pack('<f', x))[0]


def _particle_emitter(p, a):
    """`0x9E`, FUN_0021D3C0.  It zeroes +0x290, so an acceleration comes after it."""
    p['slots'] = int(a[0])
    p['life'] = [int(a[2]), int(a[1])]
    rate = int(_f32(1 / _f32(a[3]))) if a[3] else 0
    p['rate'] = max(1, rate)
    p['fade'] = int(_f32(p['life'][0] * _f32(a[4])))
    p['perFrame'] = int(a[5]) & 0xFF
    p['reroll'] = len(a) > 6 and a[6] != 0
    p['accel'] = 0


def _particle_op(entity, code, args):
    """The emitter setters, as fields of `entity.particles`.

    Mirrors scene.js `particleOp`.  Single precision because the game's is:
    `0x9E` stores `(int)(1.0f / x)` frames, and e001's 0.008 comes out 124.
    """
    a = [_num(x) for x in args]
    p = entity.particles
    if p is None:
        p = entity.particles = {
            'slots': 0, 'life': [0, 0], 'rate': 1, 'fade': 0, 'perFrame': 0,
            'reroll': False, 'accel': 0, 'shape': None}
    if code == OP_PT_EMITTER and len(a) >= 6:
        _particle_emitter(p, a)
    elif code == OP_PT_ACCEL and len(a) >= 1:
        p['accel'] = -a[0]          # stored negated: -0.001 climbs
    elif code == OP_PT_SPHERE and len(a) >= 5:
        v1 = a[3] + 2e-7 if abs(a[1] - a[3]) < 1e-7 else a[1]
        p['shape'] = {'kind': 'sphere', 'radius': [a[2], a[0]],
                      'speed': [a[3], v1], 'sign': 1 if a[4] else -1}
    elif code == OP_PT_BOX and len(a) >= 7:
        p['shape'] = {'kind': 'box', 'speed': a[0], 'half': a[1:4],
                      'jitter': a[4:7], 'angle': a[7] if len(a) > 7 else 0}


def _run(scene, track_name, blob, frame_base=0, origin=None):
    """Execute one `.ssc` track into `scene`.

    `frame_base` and `origin` are non-zero only for a track spawned by
    `0x07`/`0x08`: an effect track times everything from the moment it was
    spawned, not from the start of the cutscene, and is placed at the world
    position the spawn named.
    """
    frame = frame_base
    entity = None
    pending_voice = None
    counter = collections.Counter()
    # `0xA2` writes flags on the *track* object (ELF 0x0029EC80 takes the same
    # `param_1` that 0x0029DF00 hangs the block's object off at `+0xE4/+0xE8`),
    # and the hide call at 0x0029EBC0 walks that child list.  So visibility is
    # a property of the track, shared by every block it owns, and -- crucially
    # -- most of these opcodes are emitted *outside* any `0x64 ... 0x65` pair.
    # Scoping them to the open block dropped all but the first, which left
    # every actor on screen for the whole cutscene.
    track_vis = []
    for _, op, args in ssc.parse(blob):
        if op is None:
            continue
        code = op[0]
        if code == OP_AT_TIME:
            frame = (args[0] + frame_base) if args else frame
            continue
        if code == OP_CUE:
            continue
        scene.events.append((frame, track_name, code, args))
        counter[code] += 1

        if code == OP_SET_ROOM:
            scene.room = ssc.sj(args[0])
        elif code == OP_SPAWN:
            scene.tracks.append(ssc.sj(args[0]))
        elif code in (OP_SPAWN_FX, OP_SPAWN_FX_AT):
            # ELF 0x001C8790 (0x08) reads a string then three floats into a
            # {x,y,z,1} vec4 and hands it to the same track spawner 0x06 uses.
            # 0x001C8860 (0x07) takes a fourth argument and adds the position
            # to a looked-up target instead of using it as a world point.
            # Unlike 0x06 the same track spawns many times, at different
            # places and frames, so these are instances rather than names.
            pos = tuple(_num(a) for a in args[1:4])
            tgt = _int(args[4]) if code == OP_SPAWN_FX_AT and len(args) > 4 else None
            scene.effects.append((frame, ssc.sj(args[0]), pos, tgt, None))
        elif code == OP_SPAWN_FX_BONE and len(args) > 1:
            # Allura's e004 track lights her right elbow with `ef_e004_13`.
            scene.effects.append((frame, ssc.sj(args[0]), (0.0, 0.0, 0.0), None,
                                  (track_name, ssc.sj(args[1]))))
        elif code == OP_CAMERA:
            scene.camera_file = ssc.sj(args[1])
        elif code == OP_BGM_START:
            scene.bgm.append((frame, 'start', args[0]))
        elif code == OP_BGM_STOP:
            scene.bgm.append((frame, 'stop', args[0]))
        elif code == OP_FADE_IN:
            scene.fades.append((frame, 'in', args[0]))
        elif code == OP_FADE_OUT:
            scene.fades.append((frame, 'out', args[0]))
        elif code == OP_LETTERBOX:
            scene.letterbox.append(
                (frame, LETTERBOX_MODES.get(_int(args[0]), 'hold'),
                 max(1, _int(args[1]) if len(args) > 1 else 1)))
        elif code == OP_VOICE:
            pending_voice = ssc.sj(args[0])
        elif code == OP_SUB_SHOW:
            cue = ssc.sj(args[0])
            speaker, lines = _text(cue)
            scene.subtitles.append(
                Subtitle(frame, speaker, lines, pending_voice, cue))
            pending_voice = None
        elif code == OP_SUB_HIDE:
            if scene.subtitles and scene.subtitles[-1].end is None:
                scene.subtitles[-1].end = frame
        elif code == OP_FOG:
            scene.fog = tuple(_num(a) for a in args[:5])
        elif code == OP_BLOCK_BEGIN:
            entity = Entity(track_name, len(scene.entities),
                            args[0] if args else None,
                            ssc.sj(args[1]) if len(args) > 1 and
                            isinstance(args[1], bytes) else None)
            entity.start = frame
            entity.origin = origin
            scene.entities.append(entity)
        # ---------------------------------------------------- sprite effects
        # A sprite effect names a **texture** here where a model effect names
        # an `.smi` with `0x82`.  Handler `FUN_001C4C90` reads one string and
        # four ints and hands them to the effect object's vtable at +0x80.
        #
        # The four are (cell w, cell h, sheet w, sheet h): `ef_p_s_00.tm2` is
        # `32 32 256 256`, an 8x8 grid of 32-pixel cells on a 256x256 sheet
        # that really is 256x256, and `ef_e132d.tm2` is `32 32 128 32`, four
        # cells in a row on a texture that really is 128x32.  Where the
        # declared sheet disagrees with the file -- five textures do -- the
        # cell is the whole sheet, so the UV rect is the whole image either
        # way and nothing rests on the numbers.
        elif code == OP_FX_TEXTURE and entity is not None and args:
            nums = [_num(a) for a in args[1:5]]
            while len(nums) < 4:
                nums.append(0.0)
            entity.sprite = {
                'texture': ssc.sj(args[0]) if isinstance(args[0], bytes) else '',
                'cell': (nums[0], nums[1]),
                'sheet': (nums[2], nums[3]),
            }
        elif (code == OP_FX_QUAD_FLAGS and entity is not None
              and len(args) >= 6):
            entity.flags = tuple(bool(_num(a)) for a in args[:6])
        # `0x6D(sx, sy, frame)` and `0x6E(r, g, b, a, frame)` are keyframes,
        # and the data says so plainly: in `ef_e004_30.ssc` the `0x6D` pairs
        # are (0.5,0.5)@0 (2,2)@10 (4,4)@140 (4.5,4.5)@240 -- always equal,
        # always growing -- while the `0x6E` quads hold (1.5,0.2,0.1) and move
        # the fourth 0 -> 1.8 -> 1.8 -> 0 across the same span.  A sprite that
        # swells while it fades up and out again.
        elif (code in (OP_FX_SIZE_KEY, OP_FX_SIZE_KEY2)
              and entity is not None and len(args) >= 3):
            entity.size_keys.append((_num(args[2]), _num(args[0]), _num(args[1])))
        elif (code in (OP_FX_COLOUR_KEY, OP_FX_COLOUR_KEY2)
              and entity is not None and len(args) >= 5):
            entity.colour_keys.append((_num(args[4]),) +
                                      tuple(_num(a) for a in args[:4]))
        # `0xCA(actor, bone, ?)` binds the emitter to a bone.  `FUN_001C1D50`
        # requires the effect object's kind to be 3 -- which is exactly the
        # block kind these appear in -- then resolves the actor by name, looks
        # the bone up by name and hands its matrix to the effect.
        elif code == OP_FX_BIND_BONE and entity is not None and len(args) >= 2:
            entity.binds.append((
                ssc.sj(args[0]) if isinstance(args[0], bytes) else '',
                ssc.sj(args[1]) if isinstance(args[1], bytes) else ''))
        elif code == OP_FX_GRID and entity is not None and len(args) >= 3:
            cell = entity.sprite['cell'] if entity.sprite else (1, 1)
            sheet = entity.sprite['sheet'] if entity.sprite else (1, 1)
            cols = _int(args[1]) or (int(sheet[0] // cell[0]) if cell[0] else 1)
            rows = _int(args[2]) or (int(sheet[1] // cell[1]) if cell[1] else 1)
            cells = (_int(args[3]) if len(args) > 3 else 0) or (cols * rows)
            rate = _int(args[0])
            entity.grid = {'rate': rate, 'cols': cols, 'rows': rows,
                           'cells': cells, 'life': rate * cells}
        elif code in (OP_PT_EMITTER, OP_PT_ACCEL, OP_PT_SPHERE,
                      OP_PT_BOX) and entity is not None:
            _particle_op(entity, code, args)
        elif code in (OP_FX_EMIT_A, OP_FX_EMIT_B) and entity is not None:
            # A ribbon's shape: `0xC8` (segments, -, wander, width) and `0xC9`
            # (U span, U jitter, U base, U scroll); docs/VIEWER.md 10.7.
            if entity.emitter is None:
                entity.emitter = {}
            entity.emitter['%02x' % code] = [_num(a) for a in args]
        elif code == OP_TINT and entity is not None:
            # ELF 0x001C2CC0: four floats.  The first three are a colour --
            # (0.6, 0.2, 0.1) recurs, a torch orange.  The fourth is NOT
            # alpha: it reaches 1.5 across the disc, so it is an intensity
            # or a ramp, and it is kept but not yet applied.  The trailing
            # 65535 is a channel mask we do not need.
            entity.tint = tuple(_num(a) for a in args[:4])
        elif code == OP_BLOCK_END:
            entity = None
        elif code == OP_BLOCK_DROP:
            # ELF 0x001C4DA0 -> 0x0029DEF0: unlink and destroy the track's
            # current object.  e001 uses it once, to swap the living king for
            # his corpse at 8430.
            if scene.entities:
                for e in reversed(scene.entities):
                    if e.track == track_name and e.end is None:
                        e.end = frame
                        break
        elif code == OP_VISIBLE:
            track_vis.append((frame, not (_int(args[0]) & VIS_HIDDEN
                                          and _int(args[1]))))
        elif code == OP_HIDE_PART:
            # Inside the block, and after it to give the weapon back; the
            # handler acts on the track's current model either way.
            owner = entity or next((e for e in reversed(scene.entities)
                                    if e.track == track_name), None)
            if owner is not None:
                owner.parts.append((frame, ssc.sj(args[0]), bool(_int(args[1]))))
        elif entity is not None:
            if code == OP_MODEL:
                entity.models.append(ssc.sj(args[0]))
            elif code == OP_ANIM:
                # arg[3] is a C2 rational (a blend) 588 times on the disc
                # and a C1 integer exactly once: c21m_b_e001.sai at 8430,
                # carrying 8431.  That clip is authored in absolute scene
                # time -- it runs the full 11890 frames and parks the body
                # at y=-18.9, under the floor, outside its own window -- so
                # the integer is where in the clip to start.  Play it from 0
                # and the corpse stays under the stage all scene.
                off = args[3] if len(args) > 3 and isinstance(args[3], int) else 0
                entity.clips.append((frame, ssc.sj(args[0]), off))
            elif code == OP_ROOT_BONE:
                entity.root_bone = ssc.sj(args[0])
            elif code == OP_ATTACH:
                entity.attachments.append((ssc.sj(args[0]), ssc.sj(args[1]),
                                           _num(args[2]) if len(args) > 2 else 1.0))
            elif code == OP_TRANSFORM:
                entity.transform = tuple(_num(a) for a in args[:4])
            elif code == OP_SCALE:
                entity.scale = tuple(_num(a) for a in args[:4])
            elif code == OP_VISIBLE:
                track_vis.append((frame, not (_int(args[0]) & VIS_HIDDEN
                                              and _int(args[1]))))
            elif code == OP_LIGHT_TYPE:
                entity.light = LIGHT_KINDS.get(args[0] if args else -1, 'unknown')
                # arg1 != 0 parents the light to the camera: ELF 0x001D44B0
                # rebuilds its position every frame as
                # `camera_rotation * local_offset + camera_eye`.  `joyu`
                # (女優, "actress") is the key light on the cast and is always
                # this kind -- placing it at its raw offset instead puts it
                # tens of units away from where the hardware has it.
                entity.light_parent = bool(len(args) > 1 and _num(args[1]))
            elif code == OP_LIGHT_RANGE:
                entity.light_range = tuple(_num(a) for a in args[:2])
            elif code == OP_LIGHT_LIFE and entity.kind == KIND_LIGHT and args:
                entity.light_life = _int(args[0])
        if code == OP_END:
            break
    # Only a spawned effect is a per-frame program; actor tracks use the
    # same registers but are cue-driven timelines (see `_fx_end`).
    fx_end = _fx_end(blob) if origin is not None else None
    for e in scene.entities:
        if e.track == track_name:
            e.visibility = list(track_vis)
            if fx_end is not None and e.start >= frame_base and e.track_len is None:
                e.track_len = fx_end
            # How long the track ran.  A sprite block with no `0x6E` alpha
            # keys has nothing else that says when it is over -- e004's spark
            # tracks are thirty frames long and carry only `0x80` and the
            # emitter -- so without this they would burn until the cutscene
            # ended.  It is a *length* and not an end frame because the same
            # track is spawned more than once: `ef_e004_12` runs at 1172 and
            # again at 1182, and an absolute end would give the second spawn
            # the first one's.
            if e.track_len is None:
                e.track_len = frame - frame_base
    return counter


FX_YIELD, FX_SKIP, FX_STATE = 0x01, 0x03, 0xA4
FX_UV, FX_ALPHA, FX_CMP = 0x7C, 0x7D, 0xA6
# The other opcodes the dispatch table at 0x376660 points at the calculator.
FX_CALC_EXTRA = (0xA0, 0xA1, 0xA5, FX_CMP, 0xA9)
FX_STATE_REG = 16
FX_MAX_FRAMES = 3600


def _is_reg(a):
    return isinstance(a, tuple) and a[0] == 'c5'


def _fx_end(blob):
    """The local frame a spawned effect's program ends on, or None.

    An effect track is a per-frame program, not a timeline: every frame the
    game runs it from the top until `0x01` (this frame is done) or `0x00`
    (the track is over), with `0x04` setting a condition flag, `0x03 n`
    skipping n calls when it is clear, `0xA4 n` testing r16 == n and the
    calculator ops (`0x0D`-`0x1C`, `0xA0`, `0xA1`, `0xA5`, `0xA6`, `0xA9`) doing arithmetic on registers.
    `web/scene.js`'s `fxRun` is the full VM -- it also records each frame's
    material alpha, UV scroll and placement for the page to draw; this is
    the part that says when the track stops.  None for a track that touches
    no register or material (a plain timeline) or outlives FX_MAX_FRAMES.
    """
    calls = [(op[0], args) for _, op, args in ssc.parse(blob) if op is not None]
    if not any(op in (FX_UV, FX_ALPHA) or any(_is_reg(a) for a in args)
               for op, args in calls):
        return None
    regs = {}

    def val(a):
        return regs.get(a[1], 0) if _is_reg(a) else _num(a)

    def sint(a):
        v = _int(a)
        return v - 0x100000000 if v & 0x80000000 else v

    cond = False
    for t in range(FX_MAX_FRAMES):
        pc = 0
        while pc < len(calls):
            op, args = calls[pc]
            pc += 1
            if op == OP_END:
                return t
            if op == FX_YIELD:
                break
            if op == FX_SKIP:
                if not cond:
                    pc += sint(args[0])
            elif op == OP_AT_TIME:
                a, b, c = (sint(x) for x in args[:3])
                if c > 0:
                    cond = t >= a and (b < 0 or t <= b) and (t - a) % c == 0
                elif b >= 0:
                    cond = a <= t <= b
                else:
                    cond = t == a
            elif op == FX_STATE:
                cond = regs.get(FX_STATE_REG, 0) == sint(args[0])
            elif (0x0D <= op <= 0x1C or op in FX_CALC_EXTRA) and len(args) >= 5:
                fl, kind = sint(args[3]) == 1, sint(args[4])
                fix = (lambda x: x) if fl else (lambda x: math.trunc(x))
                if kind == 10:
                    x, y = fix(val(args[0])), fix(val(args[1]))
                    tests = [x == y, x > y, x < y, x >= y, x <= y, x != y]
                    k = sint(args[2])
                    cond = tests[k] if 0 <= k < len(tests) else False
                    continue
                if not _is_reg(args[0]):
                    continue
                a, b = fix(val(args[1])), fix(val(args[2]))
                r = regs.get(args[0][1], 0)
                if kind == 0:
                    r = a
                elif kind == 1:
                    r = a + b
                elif kind == 2:
                    r = a - b
                elif kind == 3:
                    r = a * b
                elif kind == 4:
                    r = a / b if b else 0
                elif kind == 8 and b > a:
                    r = a + (r - a) % (b - a)
                elif kind == 9:
                    r = min(b, max(a, r))
                else:
                    continue
                regs[args[0][1]] = fix(r)
    return None


def _family(clip_name):
    """``'c01f_a_e001_2.sai'`` -> ``'c01f_a_e001'`` -- the per-act clip family."""
    stem = clip_name.rsplit('.', 1)[0]
    head, sep, tail = stem.rpartition('_')
    return head if sep and tail.isdigit() else stem


def _merge_master_clips(scene):
    """Fold the master track's per-act `play_anim` into the owning entity.

    The master streams each act in (`0x55`) while the actor's own track only
    named the clip it started with, so without this an actor freezes on act 1.
    """
    by_family = {}
    by_model = {}
    for e in scene.entities:
        for _, name, _off in e.clips:
            by_family.setdefault(_family(name), e)
        for m in e.models:
            by_model.setdefault(m.rsplit('.', 1)[0], e)

    for frame, track, code, args in scene.events:
        if code != OP_PLAY_ANIM or not args or not isinstance(args[0], bytes):
            continue
        name = ssc.sj(args[0])
        owner = by_family.get(_family(name))
        if owner is None:
            stem = _family(name)
            owner = next((e for key, e in by_model.items()
                          if stem.startswith(key) or key.startswith(stem)), None)
        if owner is None:
            continue
        # Compare on (frame, name) only: the clips now carry a third field
        # and a 2-tuple would never match one, duplicating every merge.
        if not any(f == frame and n == name for f, n, _ in owner.clips):
            owner.clips.append((frame, name, 0))
    for e in scene.entities:
        e.clips.sort()


def _num(a):
    if isinstance(a, tuple):
        if a[0] == 'c2':
            return a[1] / a[2] if a[2] else 0.0
        return a[1]
    return a if isinstance(a, (int, float)) else 0.0


# ------------------------------------------------------------------- loading

def _keep_lights(scene, marks, bone):
    """A bone-bound (`0x0C`) spawn keeps only its lights, riding `bone`;
    nothing has measured what its model and sprite blocks should do yet."""
    new = [e for e in scene.entities[marks[0]:] if e.kind == KIND_LIGHT]
    del scene.entities[marks[0]:], scene.events[marks[1]:]
    for e in new:
        e.bone, e.index = bone, len(scene.entities)
        scene.entities.append(e)


def load(name, disc=None):
    """Build a `Scene` for cutscene `name` (e.g. ``'e001'``)."""
    disc = disc or Disc()
    scene = Scene(name)

    for path in ('DATA/RT/COMMON/RT_COMMON.ARC',
                 'DATA/RT/%s/RT_%s.ARC' % (name.upper(), name.upper())):
        scene.archives.update(disc.members(path))
    # Allura's rig lives in a costume archive chosen by the scene's flag byte
    for path in ('DATA/RT/COSTUME/RT_C01F_A_HL.ARC',):
        for k, v in disc.members(path).items():
            scene.archives.setdefault(k, v)

    # streamed animation sits loose in the AFS next to the archive
    for path in disc.glob('DATA/RT/%s/' % name.upper()):
        if path.endswith('.SAI'):
            scene.loose[os.path.basename(path).lower()] = disc.read(path)

    master = scene.archives.get('rt_%s.ssc' % name)
    if master is None:
        raise ValueError('no master track rt_%s.ssc' % name)

    scene.bars = (LETTERBOX_BARS_DI if name.lower().startswith('di')
                  else LETTERBOX_BARS)
    counts = {'rt_%s.ssc' % name: _run(scene, 'rt_%s.ssc' % name, master)}
    queued = list(scene.tracks)
    seen = set()
    while queued:
        tname = queued.pop(0)
        key = tname.lower().replace('.sss', '.ssc')
        if key in seen:
            continue
        seen.add(key)
        blob = scene.archives.get(key)
        if blob is None:
            continue
        counts[key] = _run(scene, key, blob)
        queued.extend(t for t in scene.tracks if t.lower() not in seen)

    # Effect tracks last, because the spawns that name them come out of the
    # tracks above.  Each spawn is its own instance: `ef_e001_20` is spawned
    # three times at three positions, and each wants its own entities.
    for i, (at, tname, pos, _tgt, bone) in enumerate(list(scene.effects)):
        key = tname.lower()
        if not key.endswith('.ssc'):
            key += '.ssc'
        blob = scene.archives.get(key)
        if blob is None:
            continue
        marks = len(scene.entities), len(scene.events)
        counts['%s@%d' % (key, at)] = _run(scene, '%s#%d' % (key, i), blob,
                                          frame_base=at, origin=pos)
        if bone is not None:
            _keep_lights(scene, marks, bone)

    scene.opcounts = counts
    scene.duration = max([f for f, _, _, _ in scene.events] or [0]) + 1
    _merge_master_clips(scene)

    if scene.camera_file:
        blob = scene.asset(scene.camera_file)
        if blob:
            scene.camera = cam_mod.parse(blob)

    # The room itself is never named by the script -- `set_room` only picks the
    # collision and lighting set -- but DATA/ROOM/<room>_ALL.ARC holds the
    # matching <room>.smi environment, which is what the cutscene is staged in.
    if scene.room:
        room_arc = disc.members('DATA/ROOM/%s_ALL.ARC' % scene.room.upper())
        for k, v in room_arc.items():
            scene.archives.setdefault(k, v)
        if '%s.smi' % scene.room in room_arc:
            scene.room_model = '%s.smi' % scene.room
        sli_blob = room_arc.get('%s.sli' % scene.room)
        if sli_blob:
            scene.room_lights = sli_mod.parse(sli_blob)
            # A `0xB4` kind-0 block records no direction; the game takes it
            # from the room (ELF 0x001D4430).  Verified against a PCSX2
            # savestate: rp03.sli gives (0.2594, 0.9342, -0.2450) and the
            # live light at 0x008138D0 holds exactly that.
            inf = sli_mod.infinite_direction(scene.room_lights)
            if inf:
                for l in scene.lights:
                    if l.light == 'directional' and l.light_dir is None:
                        l.light_dir = inf

    for i, sub in enumerate(scene.subtitles):
        if sub.end is None:
            nxt = scene.subtitles[i + 1].frame if i + 1 < len(scene.subtitles) \
                else scene.duration
            sub.end = nxt
    return scene


def clip(scene, filename):
    """Parse one of the scene's `.sai` clips."""
    blob = scene.asset(filename)
    return sai_mod.parse(blob) if blob else None


# The opcodes `_run` actually acts on.  Everything else in a track is parsed,
# counted and then dropped, which is fine for the ones that do not change what
# is on screen and is not fine for the ones that do -- see `--effects`.
HANDLED = frozenset((
    OP_END, OP_AT_TIME, OP_CUE, OP_SPAWN, OP_SPAWN_FX, OP_SPAWN_FX_AT,
    OP_SET_ROOM, OP_CAMERA, OP_BGM_START, OP_BGM_STOP, OP_FADE_IN, OP_FADE_OUT,
    OP_LETTERBOX, OP_VOICE, OP_SUB_SHOW, OP_SUB_HIDE, OP_FOG, OP_BLOCK_BEGIN,
    OP_BLOCK_END, OP_BLOCK_DROP, OP_TINT, OP_VISIBLE, OP_MODEL, OP_ANIM,
    OP_ROOT_BONE, OP_ATTACH, OP_TRANSFORM, OP_SCALE, OP_LIGHT_TYPE,
    OP_LIGHT_RANGE, OP_FX_TEXTURE, OP_FX_SIZE_KEY, OP_FX_COLOUR_KEY,
    OP_FX_EMIT_A, OP_FX_EMIT_B, OP_FX_BIND_BONE, OP_FX_COLOUR_KEY2,
    OP_FX_SIZE_KEY2, OP_FX_GRID, OP_FX_QUAD_FLAGS, OP_PT_EMITTER,
    OP_PT_ACCEL, OP_PT_SPHERE, OP_PT_BOX))


def effect_report(names=None):
    """How much of each cutscene's effect work survives compilation.

    Prints one row per cutscene that has any, so the claim "the effects in
    <x> are wrong" can be checked rather than argued about.
    """
    import order as order_mod
    names = names or order_mod.Story().names
    rows = []
    totals = collections.Counter()
    for name in names:
        try:
            sc = load(name)
        except Exception:
            continue
        fx = [e for e in sc.events if e[1].startswith('ef_')]
        fx_ents = [e for e in sc.entities if e.track.startswith('ef_')]
        sprites = [e for e in fx_ents if e.is_sprite]
        # "Blank" is an effect block that draws neither a model nor a sprite.
        # Before sprites were implemented this was every one of them that
        # named a texture; what is left is whatever neither path covers.
        blank = [e for e in fx_ents if not e.models and not e.is_sprite]
        tex = collections.Counter()
        binds = 0
        for _f, _t, code, args in sc.events:
            if code == OP_FX_TEXTURE and args and isinstance(args[0], bytes):
                tex[args[0].decode('latin1')] += 1
            elif code == OP_FX_BIND_BONE:
                binds += 1
        ignored = sum(1 for e in sc.events if e[2] not in HANDLED)
        fx_ignored = sum(1 for e in fx if e[2] not in HANDLED)
        totals['events'] += len(sc.events)
        totals['ignored'] += ignored
        totals['fx'] += len(fx)
        totals['fx_ignored'] += fx_ignored
        totals['entities'] += len(fx_ents)
        totals['sprites'] += len(sprites)
        totals['bound'] += sum(len(e.binds) for e in sprites)
        totals['blank'] += len(blank)
        totals['tex'] += sum(tex.values())
        totals['binds'] += binds
        if tex or binds or blank or sprites:
            rows.append((name, len(sc.events), ignored, len(fx), fx_ignored,
                         len(sprites), binds, len(blank), sorted(tex)))
    rows.sort(key=lambda r: -r[5])
    print('%-10s %6s %6s %6s %6s %7s %5s %5s  %s'
          % ('name', 'events', 'ign', 'fxev', 'fxign', 'sprites', 'bound',
             'blank', 'textures'))
    for r in rows:
        print('%-10s %6d %6d %6d %6d %7d %5d %5d  %s'
              % (r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], ' '.join(r[8])))
    pct = lambda a, b: (100.0 * a / b) if b else 0.0
    print('\n%d cutscenes with effect work; corpus %d events, %d ignored (%.1f%%)'
          % (len(rows), totals['events'], totals['ignored'],
             pct(totals['ignored'], totals['events'])))
    print('effect tracks: %d events, %d ignored (%.1f%%)'
          % (totals['fx'], totals['fx_ignored'],
             pct(totals['fx_ignored'], totals['fx'])))
    print('effect entities: %d, of which %d are sprites and %d draw nothing (%.1f%%)'
          % (totals['entities'], totals['sprites'], totals['blank'],
             pct(totals['blank'], totals['entities'])))
    print('%d sprites, %d of them bound to a bone by 0xca'
          % (totals['sprites'], totals['bound']))
    return 0


def main():
    import sys
    if '--effects' in sys.argv:
        rest = [a for a in sys.argv[1:] if not a.startswith('--')]
        return effect_report(rest or None)
    name = sys.argv[1] if len(sys.argv) > 1 else 'e001'
    sc = load(name)
    print(sc)
    print('camera: %s -> %s' % (sc.camera_file, sc.camera))
    print('bgm:', sc.bgm, '| fades:', sc.fades)
    print('letterbox:', sc.letterbox, '| bars:', sc.bars)
    print('\ntracks: %s' % ', '.join(sorted(sc.opcounts)))
    print('\nentities:')
    for e in sc.entities:
        print('  %-22s kind=%-4s models=%-34s root=%-8s clips=%d vis=%d attach=%s'
              % (e.track, e.kind, ','.join(e.models) or '-', e.root_bone,
                 len(e.clips), len(e.visibility),
                 ','.join(a[0] for a in e.attachments) or '-'))
        for f, c, off in e.clips[:3]:
            print('        clip @%-6d %s%s'
                  % (f, c, ' +%d' % off if off else ''))
    unknown = collections.Counter()
    for f, t, code, a in sc.events:
        if code not in ssc.OPS:
            unknown[code] += 1
    print('\nunnamed opcodes used: %s'
          % ' '.join('%02x:%d' % kv for kv in sorted(unknown.items())))


if __name__ == '__main__':
    main()
