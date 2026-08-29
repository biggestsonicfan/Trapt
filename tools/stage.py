"""A whole stage, assembled: rooms placed, collision loaded, a body to walk.

This is to the stage half of the game what `scene.py` is to the cutscene half.
It puts together the three tables that were missing until now --
`mapbin.py` for the layout, `col.py` for the floors and walls, `trap.py` for
what can be set on them -- and adds the small amount of simulation a room
needs to be walked around in.

    python stage.py 0                # what stage M000 is made of
    python stage.py 0 --walk 600     # walk a body 600 frames and report
    python stage.py --check          # assemble all 22

**Physics happens in room-local space.**  A room's `.col` is authored around
the room's own origin and the stage translates it (`SRoomDef` carries a
position and no rotation at all), so moving the body is done in the room's
coordinates and only the renderer adds the offset.  That keeps thousands of
collision triangles from being transformed on every room change, and it makes
a door crossing the only place the two frames have to be reconciled.

**The walk speed comes from the animation, not from a table.**  `CHR_DATA` in
`c01f_a.sta` carries `30` and `60` for the two gaits, but neither is units per
second at any frame rate that makes the feet plant.  What does work is
measuring the clip: the foot bone's excursion along Z over one cycle is the
distance the body covers in that cycle, because the clips are authored in
place, so

    speed = stride / duration

For Allura that is 12.00 units over 72 frames walking and 23.95 over 42
running -- about 10 and 34 units a second at 60 fps, and with a 15.42-unit
model that is 1.0 and 3.6 m/s if she is 1.6 m tall.  Both are sane, the feet
do not slide, and the `.mfd` footstep events agree: two steps per cycle in
each clip (frames 33 and 66 of 72 walking, 12 and 32 of 42 running).

`CHR_DATA` is not noise, though -- `30 / 12.00` and `60 / 23.95` are both
**2.50**, so the table is the same pair of strides scaled by a constant whose
meaning is not yet known.  `chr_data` hands the raw numbers back rather than
pretending they are a speed.
"""
import struct
import sys

import col
import hbin
import mapbin
import trap

PLAYER = 'c01f_a'                 # Allura, the character a stage is played as
CLIP_IDLE = '%s_000.sai'
CLIP_WALK = '%s_001.sai'
CLIP_RUN = '%s_002.sai'
FOOT_BONES = ('ashi_L', 'ashi_R')
HIP_BONE = 'koshi'

# How close to a door's world position counts as standing in it.
DOOR_REACH = 24.0
# A trap is set on the surface under the crosshair within this of the body.
SET_REACH = 60.0


class Body:
    """The player, in one room's coordinates.

    `pos` is the point between the feet, which is where the `.SMI` origin is
    -- the bind pose runs from y = 0.00 to y = 15.42 -- so the collision
    query and the model transform are the same point and nothing needs an
    offset.
    """

    def __init__(self, pos, radius, height, yaw=0.0):
        self.pos = list(pos)
        self.radius = radius
        self.height = height
        self.yaw = yaw
        self.gait = 'idle'
        self.moving = 0.0        # 0 idle, 1 walking, 2 running
        self.hit_wall = False
        self.clip_time = 0.0

    def as_dict(self):
        return {'pos': [round(v, 4) for v in self.pos],
                'yaw': round(self.yaw, 4), 'gait': self.gait,
                'hit_wall': self.hit_wall}


class Room:
    """One room of a stage: where it is, and what its collision is."""

    def __init__(self, entry, mesh, doors):
        self.entry = entry            # mapbin.Room
        self.id = entry.id
        self.name = entry.name
        self.origin = entry.pos
        self.mesh = mesh              # col.Mesh, in room-local coordinates
        self.doors = doors            # [{'number', 'local', 'world', 'to', 'sealed'}]

    def to_world(self, p):
        return (p[0] + self.origin[0], p[1] + self.origin[1], p[2] + self.origin[2])

    def to_local(self, p):
        return (p[0] - self.origin[0], p[1] - self.origin[1], p[2] - self.origin[2])

    def __repr__(self):
        return '<room %s %d faces, %d walls, %d doors>' % (
            self.name, len(self.mesh.faces), len(self.mesh.walls), len(self.doors))


class Stage:
    """A stage, ready to walk: rooms, doors, traps and the player body."""

    def __init__(self, number, graph, rooms, traps, player):
        self.number = number
        self.graph = graph
        self.rooms = rooms            # {name: Room}
        self.traps = traps            # [trap.Trap]
        self.player = player          # {'radius','height','gaits',...}
        self.placed = []              # traps set on surfaces this run
        self.current = None
        self.body = None

    # -------------------------------------------------------------- entering

    def enter(self, name, at=None):
        """Put the body in a room, at `at` (room-local) or its spawn point."""
        room = self.rooms[name]
        self.current = room
        if at is None:
            at = col.spawn_point(room.mesh)
        ground = room.mesh.floor_at(at[0], at[2], at[1] + col.STEP_UP)
        pos = (at[0], ground[0] if ground else at[1], at[2])
        if self.body is None:
            self.body = Body(pos, self.player['radius'], self.player['height'])
        else:
            self.body.pos = list(pos)
        return room

    # ------------------------------------------------------------------ step

    def step(self, move_x, move_z, run, frames=1.0):
        """Advance the body by `frames` at 60 fps.

        `move_x`/`move_z` are a direction in world axes, magnitude 0..1 -- the
        left stick, already deadzoned.  Returns what changed.
        """
        body = self.body
        mag = (move_x * move_x + move_z * move_z) ** 0.5
        if mag < 1e-4:
            body.gait = 'idle'
            body.moving = 0.0
            body.hit_wall = False
            body.clip_time += frames
            return {'moved': 0.0, 'hit_wall': False, 'door': None}

        gait = 'run' if run else 'walk'
        body.gait = gait
        body.moving = 2.0 if run else 1.0
        speed = self.player['gaits'][gait]['speed']       # units per frame
        ux, uz = move_x / mag, move_z / mag
        step = speed * mag * frames
        before = tuple(body.pos)
        out = col.move(self.current.mesh, body.pos, ux * step, uz * step,
                       body.radius, body.height)
        body.pos = list(out['pos'])
        body.hit_wall = out['hit_wall']
        # Face the way the body actually went, not the way it was pushed --
        # sliding along a wall should not spin the character into it.
        body.yaw = _atan2(ux, uz)
        moved = ((body.pos[0] - before[0]) ** 2
                 + (body.pos[2] - before[2]) ** 2) ** 0.5
        # The clip advances with the distance covered, so a body sliding along
        # a wall slows its legs down instead of running on the spot.
        body.clip_time += frames * (moved / step if step > 1e-9 else 0.0)
        return {'moved': moved, 'hit_wall': out['hit_wall'],
                'door': self.door_at(body.pos)}

    def door_at(self, pos):
        """The door the body is standing in, or None."""
        for d in self.current.doors:
            if d['sealed'] or d['to'] is None:
                continue
            dx = pos[0] - d['local'][0]
            dz = pos[2] - d['local'][2]
            if dx * dx + dz * dz <= DOOR_REACH * DOOR_REACH:
                return d
        return None

    def go_through(self, door):
        """Cross a door and land in the room on the other side.

        The arrival point is found in **world** space -- the door's own world
        position, mapped into the destination -- rather than by pairing door
        indices, because three of the 48 rooms ship more door meshes than any
        one stage opens (see `mapbin.py`).  If the destination has no floor
        there, its spawn point is the fallback.
        """
        dest = self.rooms.get(door['to'])
        if dest is None:
            return None
        local = dest.to_local(door['world'])
        ground = dest.mesh.floor_at(local[0], local[2], local[1] + col.STEP_UP,
                                    col.STEP_UP, col.FALL)
        if ground is None:
            return self.enter(dest.name)
        return self.enter(dest.name, (local[0], ground[0], local[2]))

    # ----------------------------------------------------------------- traps

    def can_set(self, tr, pos):
        """Where trap `tr` would go from `pos`, or None.

        A trap is set on the surface its group names: ceiling traps overhead,
        floor traps underfoot, wall traps on the nearest wall in front.  The
        rectangle it needs is in its `.tcd` footprint; nothing here checks
        that it fits yet, only that the surface exists.
        """
        mesh = self.current.mesh
        if tr.surface == 'floor':
            hit = mesh.floor_at(pos[0], pos[2], pos[1] + col.STEP_UP)
            return {'surface': 'floor', 'at': (pos[0], hit[0], pos[2])} if hit else None
        if tr.surface == 'ceiling':
            hit = mesh.ceiling_at(pos[0], pos[2], pos[1])
            return {'surface': 'ceiling', 'at': (pos[0], hit[0], pos[2])} if hit else None
        best = None
        for w in mesh.walls:
            if w.y1 <= pos[1] or w.y0 >= pos[1] + self.body.height:
                continue
            cx, cz = col._closest_on_segment(pos[0], pos[2], w.x1, w.z1, w.x2, w.z2)
            d = ((pos[0] - cx) ** 2 + (pos[2] - cz) ** 2) ** 0.5
            if d > SET_REACH:
                continue
            if best is None or d < best[0]:
                best = (d, cx, cz, w)
        if best is None:
            return None
        _d, cx, cz, w = best
        return {'surface': 'wall', 'at': (cx, pos[1], cz),
                'normal': (w.nx, 0.0, w.nz)}

    def set_trap(self, tr, spot):
        rec = {'trap': tr, 'room': self.current.name, 'spot': spot,
               'armed': True, 'cooldown': 0.0}
        self.placed.append(rec)
        return rec


def _atan2(x, z):
    import math
    return math.atan2(x, z)


# ------------------------------------------------------------------- camera

CAMERA_INIT = 'DATA/CAMERA/INIT.BIN'


def camera_defaults(disc):
    """`DATA/CAMERA/INIT.BIN` -- seven records of four `s16`.

    The file is 56 bytes and reads `(18, 115, 40, 2)` five times over and
    `(18, 180, 40, 2)` for the last four, so there are two distinct camera
    setups and seven slots to put them in.

    The **field names are inferred**, from nothing stronger than the numbers
    being the right size for a third-person camera on a 15-unit character in
    a 220-unit room: 18 as a pitch in degrees, 115 or 180 as a distance back,
    40 as a height.  The fourth is always 2.  `raw` is kept alongside so the
    guess can be checked rather than taken on trust.
    """
    blob = disc.read(CAMERA_INIT)
    if blob is None:
        return []
    out = []
    for i in range(len(blob) // 8):
        pitch, dist, height, mode = struct.unpack_from('<4h', blob, i * 8)
        out.append({'pitch': pitch, 'distance': dist, 'height': height,
                    'mode': mode, 'raw': [pitch, dist, height, mode]})
    return out


# ------------------------------------------------------------- the character

def chr_data(container):
    """The `CHR_DATA` chunk of a `.sta`, as far as it is understood.

    `name` and `scale` are certain.  `speeds` is the pair of four-float rows
    at +0x30 and +0x40 -- for Allura both are `(0, 30, 60, 3)` -- handed back
    raw, because 30 and 60 are exactly 2.50x the two gaits' measured strides
    and that constant has no explanation yet.
    """
    ch = container.first('CHR_DATA')
    if ch is None:
        return None
    raw = ch.data
    name = raw[:16].split(b'\0')[0].decode('latin1', 'replace')
    scale = struct.unpack_from('<3f', raw, 0x24)
    rows = [list(struct.unpack_from('<4f', raw, o)) for o in (0x30, 0x40)
            if o + 16 <= len(raw)]
    return {'name': name, 'scale': scale, 'speeds': rows}


def capsule(container):
    """The body capsule from the first `COL_DATA`: bone, two points, radius."""
    for ch in container.all_of('COL_DATA'):
        bone = ch.data[4:16].split(b'\0')[0].decode('latin1', 'replace')
        if bone != HIP_BONE:
            continue
        a = struct.unpack_from('<3f', ch.data, 0x10)
        b = struct.unpack_from('<3f', ch.data, 0x20)
        r = struct.unpack_from('<f', ch.data, 0x30)[0]
        return {'bone': bone, 'a': a, 'b': b, 'radius': r}
    return None


def stride_of(model, clip, bones=FOOT_BONES):
    """How far the body travels in one cycle of `clip`, from the feet.

    The clips are authored in place, so a foot bone's excursion along the
    model's forward axis over the cycle *is* the distance covered.  Both feet
    give the same answer to the last hundredth on the disc, so the larger is
    taken and a disagreement would show up as a wrong speed rather than
    silently.
    """
    import pose
    names = [n.get('name', '') for n in model.nodes]
    want = [i for i, n in enumerate(names) if n in bones]
    if not want:
        return None
    duration = max(n.duration for n in clip.nodes)
    if duration <= 0:
        return None
    spans = []
    for i in want:
        lo = hi = None
        for f in range(int(duration) + 1):
            z = pose.world_matrices(model, clip, f)[i][14]
            lo = z if lo is None or z < lo else lo
            hi = z if hi is None or z > hi else hi
        spans.append(hi - lo)
    return {'stride': max(spans), 'duration': duration,
            'speed': max(spans) / duration, 'per_foot': spans}


def load_player(disc, name=PLAYER):
    """Allura's shape and gaits, measured from her own files."""
    import arc as arc_mod
    import sai as sai_mod
    import smi as smi_mod
    blob = disc.read('DATA/CHARA/%s.ARC' % name.upper())
    if blob is None:
        raise ValueError('no character archive for %s' % name)
    members = {n.lower(): blob[o:o + s] for n, o, s in arc_mod.entries(blob)}
    sta = members.get('%s.sta' % name)
    container = hbin.parse(sta) if sta else None
    model = smi_mod.parse(members['%s.smi' % name])

    lo = hi = None
    for positions, _normals in smi_mod.bind_pose(model):
        for v in positions:
            lo = v[1] if lo is None or v[1] < lo else lo
            hi = v[1] if hi is None or v[1] > hi else hi
    height = (hi - lo) if lo is not None else 15.0

    caps = capsule(container) if container else None
    gaits = {}
    for gait, template in (('walk', CLIP_WALK), ('run', CLIP_RUN)):
        clip_blob = members.get(template % name)
        if clip_blob is None:
            continue
        got = stride_of(model, sai_mod.parse(clip_blob))
        if got:
            got['clip'] = template % name
            gaits[gait] = got
    return {
        'name': name,
        'model': '%s.smi' % name,
        'idle': CLIP_IDLE % name,
        'height': height,
        'radius': caps['radius'] if caps else 3.0,
        'capsule': caps,
        'chr': chr_data(container) if container else None,
        'gaits': gaits,
    }


# ------------------------------------------------------------------ assembly

def load(disc, number, player=None):
    """Assemble stage `number`: every room, its collision, its doors."""
    graph = mapbin.load(disc, number)
    meshes = {}
    for path, member, blob in col.all_cols(disc):
        meshes[member[:-len('_ri.col')]] = blob

    rooms = {}
    for entry in graph.rooms:
        blob = meshes.get(entry.id)
        if blob is None:
            continue
        mesh = col.parse(blob)
        models = mapbin.door_models(disc, entry.id)
        doors = []
        for d in graph.owned_doors(entry.name):
            got = models.get(d.number)
            if got is None:
                continue
            _file, local = got
            to = d.b_room
            if d.sealed or to == mapbin.NOT_USE or graph.room(to) is None:
                to = None
            doors.append({'number': d.number, 'index': d.index, 'local': local,
                          'world': (local[0] + entry.pos[0],
                                    local[1] + entry.pos[1],
                                    local[2] + entry.pos[2]),
                          'to': to, 'sealed': d.sealed})
        rooms[entry.name] = Room(entry, mesh, doors)

    # A passage has no doors of its own -- the door mesh belongs to the room --
    # so give it the far side of every door that leads into it.  Without this
    # a corridor is a room you can walk into and never out of.
    for entry in graph.rooms:
        if not entry.passage or entry.name not in rooms:
            continue
        here = rooms[entry.name]
        for other in graph.rooms:
            if other.name == entry.name or other.name not in rooms:
                continue
            for d in rooms[other.name].doors:
                if d['to'] != entry.name:
                    continue
                here.doors.append({'number': -1, 'index': d['index'],
                                   'local': here.to_local(d['world']),
                                   'world': d['world'], 'to': other.name,
                                   'sealed': False})

    traps = trap.load_all(disc)
    return Stage(number, graph, rooms,
                 traps, player or load_player(disc))


# ---------------------------------------------------------------- self-check

def _walk_demo(st, frames):
    """Drive the body in a circle and report -- a smoke test with numbers."""
    import math
    st.enter(sorted(st.rooms)[0])
    log = {'wall': 0, 'doors': 0, 'distance': 0.0}
    for f in range(frames):
        a = f * 0.02
        out = st.step(math.sin(a), math.cos(a), f % 120 > 60)
        log['distance'] += out['moved']
        if out['hit_wall']:
            log['wall'] += 1
        if out['door']:
            log['doors'] += 1
    return log


def _check(disc):
    player = load_player(disc)
    bad = 0
    for n in mapbin.stage_numbers(disc):
        try:
            st = load(disc, n, player)
        except Exception as exc:
            bad += 1
            print('M%03d: %s' % (n, exc))
            continue
        for name, room in sorted(st.rooms.items()):
            if not room.mesh.floors:
                bad += 1
                print('M%03d %s: no floor at all' % (n, name))
            if col.spawn_point(room.mesh) is None:
                bad += 1
                print('M%03d %s: nowhere to stand' % (n, name))
        # every room should be reachable from the first by walking doors
        names = sorted(st.rooms)
        seen = {names[0]}
        queue = [names[0]]
        while queue:
            cur = queue.pop()
            for d in st.rooms[cur].doors:
                if d['to'] and d['to'] not in seen:
                    seen.add(d['to'])
                    queue.append(d['to'])
        if len(seen) != len(names):
            print('M%03d: %d of %d rooms reachable from %s (%s)'
                  % (n, len(seen), len(names), names[0],
                     ' '.join(sorted(set(names) - seen))))
    print('%d stages assembled, %d problems' % (len(mapbin.stage_numbers(disc)), bad))
    print('player: %s, %.2f tall, radius %.1f, gaits %s'
          % (player['name'], player['height'], player['radius'],
             {k: round(v['speed'], 4) for k, v in player['gaits'].items()}))
    return 1 if bad else 0


def main():
    import os
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import scene as scene_mod
    disc = scene_mod.Disc()
    args = sys.argv[1:]
    if not args or args[0] == '--check':
        return _check(disc)
    st = load(disc, int(args[0]))
    p = st.player
    print('stage M%03d: %d rooms, %d traps' % (st.number, len(st.rooms), len(st.traps)))
    print('player %s: %.2f tall, capsule radius %.1f, CHR_DATA %s'
          % (p['name'], p['height'], p['radius'],
             p['chr']['speeds'] if p['chr'] else '-'))
    for gait, g in sorted(p['gaits'].items()):
        print('  %-5s %-16s stride %.2f over %d frames -> %.4f units/frame '
              '(%.1f/s)' % (gait, g['clip'], g['stride'], g['duration'],
                            g['speed'], g['speed'] * 60))
    for name in sorted(st.rooms):
        room = st.rooms[name]
        lo, hi = room.mesh.bounds
        print('  %-7s at (%g, %g, %g)  %d floor / %d wall / %d ceiling  '
              'size %.0f x %.0f x %.0f'
              % (name, room.origin[0], room.origin[1], room.origin[2],
                 len(room.mesh.floors), len(room.mesh.walls),
                 len(room.mesh.ceilings),
                 hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]))
        for d in room.doors:
            print('        door %2d -> %-8s world (%.0f, %.0f, %.0f)%s'
                  % (d['number'], d['to'] or '(sealed)', d['world'][0],
                     d['world'][1], d['world'][2],
                     ' [from the other side]' if d['number'] < 0 else ''))
    if '--walk' in args:
        frames = int(args[args.index('--walk') + 1])
        print('walking %d frames: %s' % (frames, _walk_demo(st, frames)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
