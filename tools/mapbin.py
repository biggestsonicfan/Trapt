"""`DATA/MAP_DATA/BIN/M###.BIN` -- the stage graph.

Twenty-two stages, each a `#bin` (see `hbin.py`) holding four kinds of chunk.
This is the join the viewer never had: the story tables name a *stage*, and
until now a stage was an opaque number that `story.js` announced and stepped
over.  It is this file.

    SMapDef   4 bytes   u32 map id
    SRoomDef  52        char[8] name; float3 world position; u32 index; pad
    SPassDef  68        the same, then char[8] x2 -- the two rooms it joins
    SDoorDef  20        u32 index; char[8] room; char[8] room

Names are eight-byte buffers that were never cleared, so `RH_01` reads back as
`RH_01\0ef` -- the tail of whatever the authoring tool wrote before it, and
in a door record as `RH_01\001`.  (That trailing `01` looks like a door number
and is not one: `NOT_USE\0` fills all eight bytes and leaves no room for one.)
Cut at the first NUL and the underscore drops out to give the room id the rest
of the disc uses: `RH_01` -> `rh01`, which is `rh01_ri.col` and
`DATA/ROOM/RH01_ALL.ARC`.

`M000` is the House and reads:

    ROOM RH_01 (-120, 120, 600) ... ROOM RH_08 (230, -10, -170)
    PASS RH_11 (60, 120, 600) joins RH_01 and RH_03
    DOOR 2  RH_01 <-> RH_11

so a stage is rooms and corridors placed in one world space, joined by doors,
and a passage is itself a room with its own geometry and collision.  The axes
are the room's own: a room's collision is authored around its origin and the
stage translates it, with no rotation anywhere in the table.

A record whose `index` has bit 16 set (`0x10000 | n`) is a **sealed** doorway;
the room still ships the door mesh.  Forty-eight of the 114 doors are sealed,
and they seal in two ways: 45 name `NOT_USE` on the far side, and the other 3
name a real room that this stage simply does not load (`M004` seals `RH_06`'s
way to `RH_17`, `M008` seals both of `RC_05`'s).  Those three are the only
doors on the disc whose far side is missing from their own stage, so the bit
and the room list agree exactly -- reading one without the other makes three
rooms look like a broken table.

**A door carries no coordinates, and no door number.**  Both come from the
room archive: `DATA/ROOM/RH01_ALL.ARC` holds `rh01d0.smi` through
`rh01d3.smi`, the first node of each is the door's room-local position, and
the meshes are numbered in the order that room's records appear in the door
list.  That rule closes for 45 of the 48 rooms on the disc -- the other three
are `RP_01` and `RP_02`, which ship four door meshes and are used by stages
that open only two or three of them.  Checked the other way, by asking which
of a room's door meshes sits nearest the room the record links to, the two
agree wherever the answer is not a tie.

Because of those three, nothing here should *rely* on the pairing: a door's
world position is the useful part, and `stage.py` arrives at a door by
looking for floor near that world point rather than by trusting an index.

    python mapbin.py 0            # one stage
    python mapbin.py --check      # all 22, and the rooms they ask for
"""
import struct
import sys

import hbin

ROOM = 'SRoomDef'
PASS = 'SPassDef'
DOOR = 'SDoorDef'
MAP = 'SMapDef'

NOT_USE = 'NOT_USE'
DOOR_SEALED = 0x10000


def _name(blob, off, n=8):
    """An eight-byte name buffer, cut at the NUL the authoring tool left."""
    raw = blob[off:off + n]
    z = raw.find(b'\0')
    return (raw if z < 0 else raw[:z]).decode('latin1')


def room_id(name):
    """`RH_01` -> `rh01`, the id the rest of the disc uses."""
    return name.replace('_', '').lower()


class Room:
    __slots__ = ('name', 'id', 'pos', 'index', 'passage', 'links')

    def __init__(self, name, pos, index, passage, links=()):
        self.name = name
        self.id = room_id(name)
        self.pos = pos
        self.index = index
        self.passage = passage
        self.links = list(links)

    def __repr__(self):
        return '<%s %s (%g, %g, %g) idx=%d%s>' % (
            'pass' if self.passage else 'room', self.name,
            self.pos[0], self.pos[1], self.pos[2], self.index,
            ' -> ' + ', '.join(self.links) if self.links else '')


class Door:
    """One doorway.  `number` is which of `a_room`'s door meshes it is."""
    __slots__ = ('index', 'sealed', 'a_room', 'b_room', 'number')

    def __init__(self, index, sealed, a_room, b_room, number):
        self.index = index
        self.sealed = sealed
        self.a_room = a_room
        self.b_room = b_room
        self.number = number

    def other(self, name):
        if self.a_room == name:
            return self.b_room
        if self.b_room == name:
            return self.a_room
        return None

    def __repr__(self):
        return '<door %d %s d%d <-> %s%s>' % (
            self.index, self.a_room, self.number, self.b_room,
            ' SEALED' if self.sealed else '')


class Stage:
    def __init__(self, number, map_id, rooms, doors):
        self.number = number
        self.map_id = map_id
        self.rooms = rooms
        self.doors = doors
        self.by_name = {r.name: r for r in rooms}

    def room(self, name):
        return self.by_name.get(name)

    def doors_of(self, name):
        """Every door touching a room, owned side or far side."""
        return [d for d in self.doors if d.a_room == name or d.b_room == name]

    def owned_doors(self, name):
        """The doors whose meshes this room ships, in mesh order."""
        return [d for d in self.doors if d.a_room == name]

    def __repr__(self):
        return '<stage M%03d map=%d %d rooms, %d doors>' % (
            self.number, self.map_id, len(self.rooms), len(self.doors))


def parse(blob, number=-1):
    c = hbin.parse(blob)
    md = c.first(MAP)
    map_id = struct.unpack_from('<I', md.data, 0)[0] if md else -1

    rooms = []
    for ch in c.all_of(ROOM):
        pos = struct.unpack_from('<3f', ch.data, 8)
        index = struct.unpack_from('<I', ch.data, 20)[0]
        rooms.append(Room(_name(ch.data, 0), pos, index, False))
    for ch in c.all_of(PASS):
        pos = struct.unpack_from('<3f', ch.data, 8)
        index = struct.unpack_from('<I', ch.data, 20)[0]
        links = [_name(ch.data, 52), _name(ch.data, 60)]
        rooms.append(Room(_name(ch.data, 0), pos, index, True, links))

    doors = []
    seen = {}
    for ch in c.all_of(DOOR):
        raw = struct.unpack_from('<I', ch.data, 0)[0]
        a = _name(ch.data, 4)
        # A room's door meshes are numbered in the order its records appear.
        nth = seen.get(a, 0)
        seen[a] = nth + 1
        doors.append(Door(raw & 0xFFFF, bool(raw & DOOR_SEALED),
                          a, _name(ch.data, 12), nth))
    return Stage(number, map_id, rooms, doors)


def load(disc, number):
    blob = disc.read('DATA/MAP_DATA/BIN/M%03d.BIN' % number)
    if blob is None:
        raise ValueError('no stage M%03d on this disc' % number)
    return parse(blob, number)


def stage_numbers(disc):
    out = []
    for path in disc.glob('DATA/MAP_DATA/BIN/'):
        stem = path.rsplit('/', 1)[-1]
        if stem.startswith('M') and stem.endswith('.BIN'):
            out.append(int(stem[1:-4]))
    return sorted(out)


def door_models(disc, room):
    """`{door index: (file, room-local position)}` for one room.

    The door meshes ride in the room's own `_ALL` archive as `<room>d<n>.smi`
    and the translation of their first node is where the door is.
    """
    import arc as arc_mod
    import smi as smi_mod
    blob = disc.read('DATA/ROOM/%s_ALL.ARC' % room.upper())
    if blob is None:
        return {}
    out = {}
    for name, off, size in arc_mod.entries(blob):
        low = name.lower()
        if not low.endswith('.smi'):
            continue
        stem = low[:-4]
        if not stem.startswith(room.lower() + 'd'):
            continue
        tail = stem[len(room) + 1:]
        if not tail.isdigit():
            continue
        try:
            model = smi_mod.parse(blob[off:off + size])
        except Exception:
            continue
        if not model.nodes:
            continue
        m = model.nodes[0]['matrix']
        out[int(tail)] = (name, (m[12], m[13], m[14]))
    return out


# ---------------------------------------------------------------- self-check

def _check(disc):
    import arc as arc_mod
    cols = set()
    for path in disc.glob('DATA/MAP_DATA/COLLISION/'):
        blob = disc.read(path)
        if blob is None:
            continue
        for name, _o, _s in arc_mod.entries(blob):
            if name.lower().endswith('.col'):
                cols.add(name.lower()[:-len('_ri.col')])
    bad = 0
    rooms = doors = 0
    dangling = []
    for n in stage_numbers(disc):
        st = load(disc, n)
        rooms += len(st.rooms)
        doors += len(st.doors)
        names = {r.name for r in st.rooms}
        for r in st.rooms:
            if r.id not in cols:
                bad += 1
                print('M%03d: %s has no collision (%s_ri.col)' % (n, r.name, r.id))
            if disc.read('DATA/ROOM/%s_ALL.ARC' % r.id.upper()) is None:
                bad += 1
                print('M%03d: %s has no room archive' % (n, r.name))
            for other in r.links:
                if other not in names:
                    bad += 1
                    print('M%03d: passage %s links to %s, which is not in the '
                          'stage' % (n, r.name, other))
        models = {r.name: door_models(disc, r.id) for r in st.rooms}
        for d in st.doors:
            if d.a_room not in names:
                bad += 1
                print('M%03d: door %d is owned by %s, which is not in the stage'
                      % (n, d.index, d.a_room))
                continue
            have = models.get(d.a_room, {})
            if d.number not in have:
                bad += 1
                print('M%03d: door %d is %s d%d and the room ships %s'
                      % (n, d.index, d.a_room, d.number, sorted(have) or 'none'))
            # A door leading somewhere this stage does not load is real data:
            # three of the 114 records on the disc lead out of their own stage.
            # Treat them as sealed rather than as a broken table.
            if d.b_room not in names and d.b_room != NOT_USE and not d.sealed:
                dangling.append('M%03d door %d %s -> %s'
                                % (n, d.index, d.a_room, d.b_room))
    print('%d stages, %d rooms, %d doors, %d problems'
          % (len(stage_numbers(disc)), rooms, doors, bad))
    print('%d doors lead out of their own stage: %s'
          % (len(dangling), '; '.join(dangling) or 'none'))
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
    print(st)
    for r in st.rooms:
        print('  %s' % r)
        for idx, (file, pos) in sorted(door_models(disc, r.id).items()):
            print('      door %d  %-14s local (%.1f, %.1f, %.1f)'
                  % (idx, file, pos[0], pos[1], pos[2]))
    for d in st.doors:
        print('  %s' % d)
    return 0


if __name__ == '__main__':
    sys.exit(main())
