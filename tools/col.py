"""`.col` -- the collision a room is walked around in.

Eighty of them live in `DATA/MAP_DATA/COLLISION/MAP_###_COL.ARC`, one per
room, named `<room>_ri.col` -- the same `_ri` stem as the shadow-receiver mesh
in `DATA/SHADOW_RENDER`.  Nothing else on the disc says where a floor is, so
this is the file the stage half of the game stands on.

    0x00 u32   group count
    0x04 u32   -> group table (always 0x08)
    0x08       group[], stride 12:
                 u8  tag       -- 1 almost always; 0 and 2 also occur
                 u8  material
                 u8  primitive count
                 u8  0xff
                 u8  0
                 u8  flags
                 u8  0
                 u8  verts     -- 5 for a quad, 3 for a triangle
                 u32 offset    -- to this group's primitives
               ... primitives, 64 bytes each: 4 x float4 ...

A primitive is always a 64-byte slot of four `float4`s whose `w` is 1.  When
`verts` is 3 only the first three are real and the fourth slot holds whatever
was in the authoring buffer -- every one of the 125 triangles on the disc has
a fourth vertex that is zero or NaN and out of the plane of the other three,
while all 6857 quads are planar to within 0.41 units.  That is how the two are
told apart; no vertex count is stored anywhere else.

Read disc-wide the format closes exactly: 1407 groups, 6982 primitives, and
every group's `count * 64` lands precisely on the next group's offset.

**`material` is a surface class, and the geometry agrees.**  Binning every
triangle by the sign of its normal's Y (what `--check` prints):

    material 1, 4     ->  floor              (1360 faces, no exceptions)
    material 2, 5, 6  ->  wall               (3565, 18 strays in material 2)
    material 7        ->  ceiling            (538)
    material 3        ->  floor *and* wall   (4428 + 3930)

So a group tagged 3 is a whole section of a room -- its floor and its walls
authored together.  Anything walking on this has to classify per primitive,
from the normal, which is what `surface_of` does.

**Every wall is exactly vertical.**  All 3808 wall *primitives* on the disc
have `n.y == 0` to the last bit.  That is not a near miss worth a tolerance:
it means a wall projects to a *line segment* in XZ with a height band, and a
walking body is a circle, so wall resolution is exact 2D circle-vs-segment
rather than an approximation of a 3D sweep.  `Mesh.walls` precomputes those
segments, one per primitive, from the primitive's own normal.

(Split into triangles, four faces come out at `|n.y| = 0.003`: they are the
second halves of the handful of quads that are planar only to 0.41 units.
That is why `Mesh.walls` classifies whole primitives and never triangles.)

    python col.py rh01              # one room's groups
    python col.py --check           # every `.col` on the disc
"""
import math
import struct
import sys

GROUP_STRIDE = 12
PRIM_STRIDE = 64
TABLE_OFF = 0x08

# n.y above this is a floor, below its negation a ceiling, between the two a
# wall.  Every wall on the disc is exactly vertical, so the threshold only has
# to separate floors from walls; 0.7 (about 45 degrees) is the usual choice.
FLOOR_COS = 0.7

MATERIALS = {1: 'floor', 2: 'wall', 3: 'shell', 4: 'floor',
             5: 'wall', 6: 'wall', 7: 'ceiling'}

# How a body moves.  These are the walker's shape rather than the format's:
# the radius and height come from the character's own `COL_DATA` capsule (see
# `stage.py`), and the rest are the usual constants.
STEP_UP = 12.0          # the tallest lip that is walked onto, not into
FALL = 400.0            # how far below the feet still counts as this floor
PUSH_EPS = 0.01         # keeps the body off the wall it was just pushed from
PASSES = 4              # a corner needs more than one push


def surface_of(normal):
    """'floor', 'ceiling' or 'wall', from a primitive's own normal."""
    if normal[1] > FLOOR_COS:
        return 'floor'
    if normal[1] < -FLOOR_COS:
        return 'ceiling'
    return 'wall'


def _normal(v0, v1, v2):
    ax, ay, az = v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]
    bx, by, bz = v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]
    nx = ay * bz - az * by
    ny = az * bx - ax * bz
    nz = ax * by - ay * bx
    ln = math.sqrt(nx * nx + ny * ny + nz * nz)
    if ln < 1e-9:
        return (0.0, 0.0, 0.0)
    return (nx / ln, ny / ln, nz / ln)


class Group:
    __slots__ = ('index', 'tag', 'material', 'flags', 'verts', 'offset', 'prims')

    def __init__(self, index, tag, material, flags, verts, offset, prims):
        self.index = index
        self.tag = tag
        self.material = material
        self.flags = flags
        self.verts = verts
        self.offset = offset
        self.prims = prims

    @property
    def material_name(self):
        return MATERIALS.get(self.material, 'material%d' % self.material)

    def __repr__(self):
        return '<group %d %s %d %s>' % (
            self.index, self.material_name, len(self.prims),
            'tri' if self.verts == 3 else 'quad')


class Face:
    """One collision triangle, with the group it came from."""
    __slots__ = ('a', 'b', 'c', 'normal', 'surface', 'group', 'material')

    def __init__(self, a, b, c, normal, surface, group, material):
        self.a, self.b, self.c = a, b, c
        self.normal = normal
        self.surface = surface
        self.group = group
        self.material = material


class Wall:
    """A vertical wall, as the 2D segment it projects to plus a height band."""
    __slots__ = ('x1', 'z1', 'x2', 'z2', 'y0', 'y1', 'nx', 'nz', 'group')

    def __init__(self, x1, z1, x2, z2, y0, y1, nx, nz, group):
        self.x1, self.z1, self.x2, self.z2 = x1, z1, x2, z2
        self.y0, self.y1 = y0, y1
        self.nx, self.nz = nx, nz
        self.group = group


def _height_in(face, x, z):
    """Y of `face` at `(x, z)`, or None when the point is outside it."""
    ax, az = face.a[0], face.a[2]
    bx, bz = face.b[0], face.b[2]
    cx, cz = face.c[0], face.c[2]
    d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz)
    if abs(d) < 1e-9:
        return None
    u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d
    v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d
    w = 1.0 - u - v
    if u < -1e-4 or v < -1e-4 or w < -1e-4:
        return None
    return u * face.a[1] + v * face.b[1] + w * face.c[1]


def _closest_on_segment(px, pz, x1, z1, x2, z2):
    dx, dz = x2 - x1, z2 - z1
    ln = dx * dx + dz * dz
    if ln < 1e-12:
        return x1, z1
    t = ((px - x1) * dx + (pz - z1) * dz) / ln
    t = 0.0 if t < 0.0 else (1.0 if t > 1.0 else t)
    return x1 + dx * t, z1 + dz * t


class Mesh:
    """A room's collision: the groups as authored, plus what walking needs."""

    def __init__(self, groups):
        self.groups = groups
        self.faces = []
        for g in groups:
            for prim in g.prims:
                tris = ((0, 1, 2),) if g.verts == 3 else ((0, 1, 2), (0, 2, 3))
                for i, j, k in tris:
                    a, b, c = prim[i], prim[j], prim[k]
                    n = _normal(a, b, c)
                    self.faces.append(
                        Face(a, b, c, n, surface_of(n), g.index, g.material))
        self.floors = [f for f in self.faces if f.surface == 'floor']
        self.ceilings = [f for f in self.faces if f.surface == 'ceiling']
        self.walls = self._segments()

    def _segments(self):
        """Every wall primitive as one XZ segment with a height band.

        A vertical quad has two vertical edges and two horizontal ones.  The
        segment is the pair of corners furthest apart in XZ -- taking the
        min/max of each axis instead would box a diagonal wall rather than
        trace it.  Walls with no XZ footprint at all are dropped.
        """
        out = []
        for g in self.groups:
            for prim in g.prims:
                verts = prim[:3] if g.verts == 3 else prim
                n = _normal(verts[0], verts[1], verts[2])
                if surface_of(n) != 'wall':
                    continue
                best = None
                for i in range(len(verts)):
                    for j in range(i + 1, len(verts)):
                        dx = verts[i][0] - verts[j][0]
                        dz = verts[i][2] - verts[j][2]
                        d = dx * dx + dz * dz
                        if best is None or d > best[0]:
                            best = (d, i, j)
                if best is None or best[0] < 1e-12:
                    continue
                _, i, j = best
                ys = [v[1] for v in verts]
                out.append(Wall(verts[i][0], verts[i][2], verts[j][0], verts[j][2],
                                min(ys), max(ys), n[0], n[2], g.index))
        return out

    @property
    def bounds(self):
        lo = [float('inf')] * 3
        hi = [float('-inf')] * 3
        for f in self.faces:
            for v in (f.a, f.b, f.c):
                for k in range(3):
                    if v[k] < lo[k]:
                        lo[k] = v[k]
                    if v[k] > hi[k]:
                        hi[k] = v[k]
        if lo[0] == float('inf'):
            return ([0.0] * 3, [0.0] * 3)
        return (lo, hi)

    def floor_at(self, x, z, y, up=STEP_UP, down=FALL):
        """The floor under `(x, z)`: highest surface in `[y - down, y + up]`.

        Returns `(height, face)` or None.  `up` is how high a step can be
        walked onto and `down` how far a drop is still the same floor.
        """
        best = None
        for f in self.floors:
            hit = _height_in(f, x, z)
            if hit is None or hit > y + up or hit < y - down:
                continue
            if best is None or hit > best[0]:
                best = (hit, f)
        return best

    def ceiling_at(self, x, z, y, up=FALL):
        best = None
        for f in self.ceilings:
            hit = _height_in(f, x, z)
            if hit is None or hit < y or hit > y + up:
                continue
            if best is None or hit < best[0]:
                best = (hit, f)
        return best


def push_out(mesh, x, y, z, radius, height):
    """Move `(x, z)` out of every wall it overlaps.  Returns `(x, z, hits)`.

    The body is a circle of `radius` spanning `[y, y + height]`.  Each pass
    resolves the *deepest* overlap, which converges in a corner where taking
    the first wall found would not.
    """
    hits = 0
    for _ in range(PASSES):
        worst = None
        for w in mesh.walls:
            if w.y1 <= y or w.y0 >= y + height:
                continue
            cx, cz = _closest_on_segment(x, z, w.x1, w.z1, w.x2, w.z2)
            dx, dz = x - cx, z - cz
            d = math.sqrt(dx * dx + dz * dz)
            if d >= radius:
                continue
            pen = radius - d
            if worst is None or pen > worst[0]:
                worst = (pen, dx, dz, d, w)
        if worst is None:
            break
        hits += 1
        pen, dx, dz, d, w = worst
        if d > 1e-6:
            ux, uz = dx / d, dz / d
        else:
            # Dead centre on the wall line: leave along the wall's own normal.
            ln = math.sqrt(w.nx * w.nx + w.nz * w.nz)
            if ln < 1e-9:
                break
            ux, uz = w.nx / ln, w.nz / ln
        x += ux * (pen + PUSH_EPS)
        z += uz * (pen + PUSH_EPS)
    return x, z, hits


def move(mesh, pos, dx, dz, radius, height, step_up=STEP_UP, fall=FALL):
    """Walk a body from `pos` by `(dx, dz)`.

    `pos` is the point between the feet.  Returns
    `{'pos', 'hit_wall', 'grounded', 'floor'}`.  A step that ends over no
    floor at all is refused outright rather than dropped: the rooms are
    sealed, so a walker that leaves one has found a hole in the collision and
    not a ledge.
    """
    x, y, z = pos
    nx, nz, hits = push_out(mesh, x + dx, y, z + dz, radius, height)
    ground = mesh.floor_at(nx, nz, y, step_up, fall)
    if ground is None:
        here = mesh.floor_at(x, z, y, step_up, fall)
        return {'pos': (x, here[0] if here else y, z),
                'hit_wall': True, 'grounded': here is not None,
                'floor': here[1] if here else None}
    return {'pos': (nx, ground[0], nz), 'hit_wall': hits > 0,
            'grounded': True, 'floor': ground[1]}


def ray_walls(mesh, x0, z0, x1, z1, ylo, yhi):
    """How far along `(x0,z0) -> (x1,z1)` the first wall is, or None.

    Returns `(t, wall)` with `t` in 0..1.  Because every wall is a vertical
    segment this is an exact 2D segment-segment intersection, not a sweep --
    and it is what a follow camera needs, where `push_out` cannot help: a
    camera that has ended up wholly behind a wall overlaps nothing, so there
    is no penetration to resolve and it stays there.
    """
    dx, dz = x1 - x0, z1 - z0
    best = None
    for w in mesh.walls:
        if w.y1 <= ylo or w.y0 >= yhi:
            continue
        ex, ez = w.x2 - w.x1, w.z2 - w.z1
        denom = dx * ez - dz * ex
        if abs(denom) < 1e-9:
            continue
        rx, rz = w.x1 - x0, w.z1 - z0
        t = (rx * ez - rz * ex) / denom
        u = (rx * dz - rz * dx) / denom
        if t < 0.0 or t > 1.0 or u < 0.0 or u > 1.0:
            continue
        if best is None or t < best[0]:
            best = (t, w)
    return best


def spawn_point(mesh):
    """A sane place to stand: the centre of the largest floor triangle.

    Nothing on the disc records where the player enters a room -- the doors
    carry no coordinates -- so the biggest patch of floor is the stand-in.
    It is deterministic: ties break on the earliest face.
    """
    best = None
    for f in mesh.floors:
        ax, az = f.a[0], f.a[2]
        bx, bz = f.b[0], f.b[2]
        cx, cz = f.c[0], f.c[2]
        area = abs((bx - ax) * (cz - az) - (cx - ax) * (bz - az)) / 2.0
        if best is None or area > best[0]:
            best = (area, f)
    if best is None:
        return None
    f = best[1]
    return ((f.a[0] + f.b[0] + f.c[0]) / 3.0,
            (f.a[1] + f.b[1] + f.c[1]) / 3.0,
            (f.a[2] + f.b[2] + f.c[2]) / 3.0)


def parse(blob):
    count, table = struct.unpack_from('<2I', blob, 0)
    if table != TABLE_OFF:
        raise ValueError('col: group table at 0x%x, expected 0x%x'
                         % (table, TABLE_OFF))
    if table + count * GROUP_STRIDE > len(blob):
        raise ValueError('col: %d groups overrun %d bytes' % (count, len(blob)))
    groups = []
    for i in range(count):
        o = table + GROUP_STRIDE * i
        tag, material, nprim, mark = blob[o], blob[o + 1], blob[o + 2], blob[o + 3]
        flags, verts = blob[o + 5], blob[o + 7]
        offset = struct.unpack_from('<I', blob, o + 8)[0]
        if verts not in (3, 5):
            raise ValueError('col: group %d has verts=%d' % (i, verts))
        if offset + nprim * PRIM_STRIDE > len(blob):
            raise ValueError('col: group %d overruns %d bytes' % (i, len(blob)))
        nv = 3 if verts == 3 else 4
        prims = []
        for p in range(nprim):
            base = offset + PRIM_STRIDE * p
            prims.append(tuple(
                struct.unpack_from('<3f', blob, base + 16 * k) for k in range(nv)))
        groups.append(Group(i, tag, material, flags, nv, offset, prims))
    return Mesh(groups)


# ---------------------------------------------------------------- self-check

def all_cols(disc):
    """Yield `(archive, member, blob)` for every `.col` on the disc."""
    import arc as arc_mod
    for path in disc.glob('DATA/MAP_DATA/COLLISION/'):
        blob = disc.read(path)
        if blob is None:
            continue
        for name, off, size in arc_mod.entries(blob):
            if name.lower().endswith('.col'):
                yield path, name.lower(), blob[off:off + size]


def _check(disc):
    import collections
    kinds = collections.defaultdict(collections.Counter)
    ny = collections.Counter()
    files = groups = prims = bad = 0
    for path, name, blob in all_cols(disc):
        files += 1
        try:
            mesh = parse(blob)
        except Exception as exc:
            bad += 1
            print('FAIL %s/%s: %s' % (path, name, exc))
            continue
        groups += len(mesh.groups)
        for g in mesh.groups:
            prims += len(g.prims)
        for f in mesh.faces:
            kinds[f.material][f.surface] += 1
            if f.surface == 'wall':
                ny[round(abs(f.normal[1]), 3)] += 1
    print('%d .col files, %d groups, %d primitives, %d failed'
          % (files, groups, prims, bad))
    for m in sorted(kinds):
        print('  material %d (%-8s) %s'
              % (m, MATERIALS.get(m, '?'), dict(kinds[m])))
    print('  wall |n.y|: %s' % dict(ny))
    return 1 if bad else 0


def main():
    import os
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import scene as scene_mod
    disc = scene_mod.Disc()
    args = sys.argv[1:]
    if not args or args[0] == '--check':
        return _check(disc)
    want = args[0].lower()
    if not want.endswith('.col'):
        want += '_ri.col'
    for path, name, blob in all_cols(disc):
        if name != want:
            continue
        mesh = parse(blob)
        lo, hi = mesh.bounds
        print('%s in %s: %d groups, %d faces (%d floor, %d wall segments, '
              '%d ceiling)' % (name, path, len(mesh.groups), len(mesh.faces),
                               len(mesh.floors), len(mesh.walls),
                               len(mesh.ceilings)))
        print('  bounds %s .. %s'
              % (tuple(round(v, 1) for v in lo), tuple(round(v, 1) for v in hi)))
        sp = spawn_point(mesh)
        print('  spawn  %s' % (tuple(round(v, 1) for v in sp) if sp else None,))
        for g in mesh.groups:
            print('  %s' % g)
        return 0
    raise SystemExit('no %s on the disc' % want)


if __name__ == '__main__':
    sys.exit(main())
