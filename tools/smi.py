"""Trapt (SLUS-21255) '.SMI' model reader -> bind-pose meshes.

FILE LAYOUT (little-endian)
  0x00 u32   magic 0x20030818 (a date stamp, 2003-08-18)
  0x04 u32   file size
  0x08 u32   16 (number of entries in the table at 0x1c)
  0x0c u32   0
  0x10 u8    node (bone) count
  0x11 u8    ?
  0x12 u8    mesh count
  0x13 u8    ?
  0x14 u32   -> node array (always 0x20)
  0x18 u32   -> mesh descriptor array
  0x1c u32   -> material array (runs up to the mesh array; stride 0x5c)

MATERIAL (stride 0x5c)
  +0x00 char[32]  two NUL-terminated strings back to back: texture base name
                  then its extension ('bmp' on the authoring side, shipped as
                  '<name>.tm2').  An empty name means untextured.
  +0x20 u32[8]    resource ids
  +0x40 u16,u16   flags
  +0x48 float     shininess-ish
  +0x50 u32       0xffffffff
  +0x54 u8[4]     diffuse RGBA (PS2 alpha: 0x80 = opaque)
  +0x58 u32       flag

NODE (stride 0x70)
  0x00 float[16]  4x4 local matrix, row-major, translation in row 3
                  (row-vector convention: v' = v * M)
  0x40 s16        parent index (-1 = root)
  0x42            14 bytes misc
  0x50 char[32]   name

MESH DESCRIPTOR (stride 0x2c)
  +0x00 u32 -> position stream   float4 (x,y,z,weight), one per influence
  +0x04 u32 -> normal   stream   s16[4] at 1/4096, one per influence
  +0x08 u32 -> colour   stream   u8[4] RGBA          (stride 4)
  +0x0c u32 -> uv       stream   float2              (stride 8)
  +0x10 u32 -> (unused in all 3328 retail models)
  +0x14 u32 -> flag     stream   s16[4]              (stride 8)
  +0x18 u8[12]  bone palette, indices into the node array (0xff = unused)
  +0x24 u8      material index
  +0x28 u16     vertex count
  +0x2a u16     base node -- the node a mesh with an EMPTY palette rides

A rigid mesh carries no palette and no per-vertex bone index worth reading; it
hangs off the single node at +0x2a.  That field is never >= the node count
over all 22496 meshes on the disc, and it is non-zero in 2521 models: every
`buki_obj` weapon a character holds, and props like `rp03d0`'s door leaf whose
whole animation is one hinge node.  Reading it as 0 pins those meshes to the
model root -- the queen's sceptre ends up at her feet and the plaza door hangs
unhinged across its own doorway.

The position stream's stride is 16 * influences_per_vertex (1 or 2); the
normal stream's is 8 * influences.  Each vertex is stored once per
influencing bone, in that bone's local space, with the blend weight in the
position's w component (weights sum to 1).

FLAG STREAM, per vertex: s16[4] = (?, ?, idx1, idx0)
  idx0 & 0x7fff   palette index * 4 for influence 0
  idx1            palette index * 4 for influence 1
  idx0 & 0x8000   PS2 ADC bit - suppresses the triangle ending at this vertex

GEOMETRY is one triangle strip per mesh; a triangle (i-2, i-1, i) is emitted
for every vertex whose ADC bit is clear, with the winding alternating.
"""
import struct

MAGIC = 0x20030818
ADC = 0x8000
NRM_SCALE = 1.0 / 4096.0


class Mesh:
    __slots__ = ('index', 'vcount', 'ptrs', 'influences', 'palette', 'material',
                 'base', 'pos', 'nrm', 'col', 'uv', 'flags', 'bones', 'weights',
                 'tris')


class Model:
    __slots__ = ('nodes', 'meshes', 'materials')


def _cstr(b):
    i = b.find(b'\0')
    return (b if i < 0 else b[:i]).decode('latin1')


def _regions(data, p_mesh, n_mesh):
    """Map each stream pointer to the offset of whatever follows it."""
    pts = {len(data)}
    for i in range(n_mesh):
        for p in struct.unpack_from('<6I', data, p_mesh + 0x2c * i):
            if p:
                pts.add(p)
    s = sorted(pts)
    return {s[i]: s[i + 1] for i in range(len(s) - 1)}


def parse(data):
    magic = struct.unpack_from('<I', data, 0)[0]
    if magic != MAGIC:
        raise ValueError('not an SMI (magic %08x)' % magic)
    n_node, _, n_mesh, _ = data[0x10:0x14]
    p_node, p_mesh, p_tab = struct.unpack_from('<III', data, 0x14)

    m = Model()
    m.materials = []
    for o in range(p_tab, p_mesh - 0x5b, 0x5c):
        name = _cstr(data[o:o + 0x20])
        ext = _cstr(data[o + len(name) + 1:o + 0x20]) if len(name) < 0x1f else ''
        r, g, b, a = data[o + 0x54:o + 0x58]
        r2, g2, b2, a2 = data[o + 0x50:o + 0x54]
        f40, f42 = struct.unpack_from('<2H', data, o + 0x40)
        power, = struct.unpack_from('<f', data, o + 0x48)
        shade, = struct.unpack_from('<I', data, o + 0x58)
        m.materials.append({
            'name': name,
            'ext': ext,
            'texture': ('%s.tm2' % name) if name else None,
            # The GS treats 0x80 as 1.0, so keep the raw bytes as well as the
            # 0..255 form -- MODULATE is (Ct * Cv) >> 7, not a 0..1 multiply.
            'diffuse': (r, g, b, 255 if a >= 0x80 else a * 2),
            'diffuse_gs': (r, g, b, a),
            'colour2_gs': (r2, g2, b2, a2),
            'flags': f40,
            'render': f42,
            'power': power,
            'shade': shade,
            'blend': bool(f42 & 0x0005),
            # Bits 0x0020/0x0040 arm the GS alpha test (TEST ATE=1
            # ATST=GEQUAL AREF=120).  An opaque material with neither draws
            # every fragment
            # whatever its alpha says.  That distinction matters because
            # several textures carry an unrelated image in their alpha
            # channel: `rp03_17` is the plaza's grass ground, and what sits in
            # its alpha -- 92% of it zero -- is a strip of grass-blade
            # silhouettes belonging to another material on the same page.
            # Cutting the ground against it deletes the lawn, which is exactly
            # what the viewer was doing.  Across rp03 and rp11 the split is
            # exact: every near-transparent texture without the bits is one
            # whose alpha is other data, every one with them is a real foliage
            # cutout.  The cast needs 0x0020 as well as 0x0040 -- Allura's
            # fringe is 0x0020 and turns into flat slabs if only 0x0040 counts.
            # Blended materials are unaffected -- they never alpha-test
            # (ATST=NEVER + AFAIL=FB_ONLY) and always take the blend factor
            # from the texture, which is what keeps rp11's lamp glow a soft
            # falloff instead of a white box.
            'atest': bool(f42 & 0x0060),
            # Two of the GS's ALPHA equations are in use: 0x44, the lerp
            # `(Cs-Cd)*As>>7 + Cd`, and 0x48, additive `Cs*As>>7 + Cd`, under
            # which a black source is a no-op.  Bit 0x0100 picks the additive
            # one.  It lands on 4 of the 148 materials e001 draws and all four
            # are blended -- 14% of the blends, against the 59-of-396 (15%)
            # additive share counted in the frame's own GIF packets.
            # rp03's material 14 is the visible proof: 0x4304, vertex colour
            # (0,0,0) over a 66%-opaque texture.  Lerped it paints the plaza
            # doorway's surround solid black; added it contributes nothing,
            # which is what the hardware frame shows.
            'add': bool(f42 & 0x0005) and bool(f42 & 0x0100),
        })

    m.nodes = []
    for i in range(n_node):
        o = p_node + 0x70 * i
        m.nodes.append({
            'matrix': list(struct.unpack_from('<16f', data, o)),
            'parent': struct.unpack_from('<h', data, o + 0x40)[0],
            'name': _cstr(data[o + 0x50:o + 0x70]),
        })

    nxt = _regions(data, p_mesh, n_mesh)
    m.meshes = []
    for i in range(n_mesh):
        o = p_mesh + 0x2c * i
        ptrs = struct.unpack_from('<6I', data, o)
        vc = struct.unpack_from('<H', data, o + 0x28)[0]

        me = Mesh()
        me.index, me.vcount, me.ptrs = i, vc, ptrs
        me.palette = [b for b in data[o + 0x18:o + 0x24] if b != 0xff]
        me.material = data[o + 0x24]
        me.base = struct.unpack_from('<H', data, o + 0x2a)[0]

        # influences per vertex = position stride / 16
        inf = 1
        if vc and ptrs[0] in nxt:
            inf = max(1, (nxt[ptrs[0]] - ptrs[0]) // (16 * vc))
        me.influences = inf

        me.pos = [[struct.unpack_from('<4f', data, ptrs[0] + 16 * (inf * v + k))
                   for k in range(inf)] for v in range(vc)] if ptrs[0] else []
        me.nrm = [[tuple(c * NRM_SCALE for c in struct.unpack_from(
                       '<3h', data, ptrs[1] + 8 * (inf * v + k)))
                   for k in range(inf)] for v in range(vc)] if ptrs[1] else []
        me.col = [tuple(data[ptrs[2] + 4 * v:ptrs[2] + 4 * v + 4])
                  for v in range(vc)] if ptrs[2] else []
        me.uv = [struct.unpack_from('<2f', data, ptrs[3] + 8 * v)
                 for v in range(vc)] if ptrs[3] else []

        me.flags, me.bones, me.weights = [], [], []
        if ptrs[5]:
            pal = me.palette
            for v in range(vc):
                _a, _b, i1, i0 = struct.unpack_from('<4h', data, ptrs[5] + 8 * v)
                me.flags.append(i0 & 0xffff)
                idx = [(i0 & 0x7fff) // 4, (i1 & 0x7fff) // 4]
                me.bones.append([pal[j] if j < len(pal) else me.base
                                 for j in idx[:inf]])
                me.weights.append([me.pos[v][k][3] for k in range(inf)]
                                  if me.pos else [1.0])
        me.tris = _strip(me.flags, vc)
        m.meshes.append(me)
    return m


def _strip(flags, vcount):
    """Decode the ADC-flagged triangle strip into a triangle list."""
    tris = []
    for i in range(2, min(vcount, len(flags))):
        if flags[i] & ADC:
            continue
        tris.append((i - 1, i - 2, i) if (i & 1) else (i - 2, i - 1, i))
    return tris


# ---------------------------------------------------------------- transforms

def _mul(a, b):
    """4x4 * 4x4, row-major."""
    return [sum(a[r * 4 + k] * b[k * 4 + c] for k in range(4))
            for r in range(4) for c in range(4)]


def world_matrices(model):
    """Accumulate each node's local matrix down the parent chain."""
    out = [None] * len(model.nodes)

    def solve(i, seen=()):
        if out[i] is not None:
            return out[i]
        n = model.nodes[i]
        p = n['parent']
        if p < 0 or p >= len(model.nodes) or p == i or p in seen:
            out[i] = list(n['matrix'])
        else:
            out[i] = _mul(n['matrix'], solve(p, seen + (i,)))
        return out[i]

    for i in range(len(model.nodes)):
        solve(i)
    return out


def _xform_pt(v, M):
    x, y, z = v[0], v[1], v[2]
    return (x * M[0] + y * M[4] + z * M[8] + M[12],
            x * M[1] + y * M[5] + z * M[9] + M[13],
            x * M[2] + y * M[6] + z * M[10] + M[14])


def _xform_dir(v, M):
    x, y, z = v
    return (x * M[0] + y * M[4] + z * M[8],
            x * M[1] + y * M[5] + z * M[9],
            x * M[2] + y * M[6] + z * M[10])


IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]


def bind_pose(model):
    """Return [(positions, normals)] per mesh, skinned into model space.

    Both streams are stored ALREADY SCALED by their blend weight, the way VU1
    consumes them: the position is a homogeneous float4 whose w is the weight,
    so the matrix multiply scales the translation row by it, and the normal is
    pre-multiplied outright.  So the blend is a plain sum - re-applying the
    weight here would square it and shrink every multi-bone vertex.  Verified
    on c01f_b_h.smi, whose paired normals have magnitudes such as 0.300 and
    0.700 that sum to exactly 1.
    """
    W = world_matrices(model)
    out = []
    for me in model.meshes:
        P, N = [], []
        for v in range(me.vcount):
            px = py = pz = 0.0
            nx = ny = nz = 0.0
            for k in range(me.influences):
                p = me.pos[v][k] if me.pos else (0.0, 0.0, 0.0, 1.0)
                w = p[3]
                if w == 0.0:
                    continue
                b = me.bones[v][k] if me.bones and k < len(me.bones[v]) else 0
                M = W[b] if b < len(W) else IDENT
                x, y, z = _xform_dir(p[:3], M)
                px += x + w * M[12]
                py += y + w * M[13]
                pz += z + w * M[14]
                if me.nrm:
                    x, y, z = _xform_dir(me.nrm[v][k], M)
                    nx += x
                    ny += y
                    nz += z
            P.append((px, py, pz))
            N.append((nx, ny, nz))
        out.append((P, N if me.nrm else []))
    return out


# ------------------------------------------------------------------- export

def write_mtl(model, path, textures=None):
    """Write the companion .mtl. `textures` maps a material's texture base
    name to the image file to reference (e.g. 'c01f_a_02' -> 'c01f_a_02.png')."""
    textures = textures or {}
    with open(path, 'w') as f:
        f.write('# Trapt SMI materials\n')
        for i, mt in enumerate(model.materials):
            r, g, b, a = mt['diffuse']
            f.write('\nnewmtl mat%02d\n' % i)
            f.write('Kd %.4f %.4f %.4f\n' % (r / 255.0, g / 255.0, b / 255.0))
            if a < 255:
                f.write('d %.4f\n' % (a / 255.0))
            img = textures.get(mt['name'])
            if img:
                f.write('map_Kd %s\n' % img)
                f.write('map_d %s\n' % img)


def write_obj(model, path, name='model', flip_v=True, skin=True, mtllib=None):
    """Write every mesh to a Wavefront OBJ, one group per mesh."""
    if skin:
        posed = bind_pose(model)
    else:
        posed = [([p[0][:3] for p in me.pos],
                  [n[0] for n in me.nrm]) for me in model.meshes]
    with open(path, 'w') as f:
        f.write('# Trapt SMI -> OBJ  (%s)\n' % name)
        if mtllib:
            f.write('mtllib %s\n' % mtllib)
        base = 1
        for me, (P, N) in zip(model.meshes, posed):
            f.write('\ng %s_mesh%02d\n' % (name, me.index))
            if me.material < len(model.materials):
                f.write('usemtl mat%02d\n' % me.material)
            for x, y, z in P:
                f.write('v %.6f %.6f %.6f\n' % (x, y, z))
            for u, v in me.uv:
                f.write('vt %.6f %.6f\n' % (u, 1.0 - v if flip_v else v))
            for x, y, z in N:
                f.write('vn %.6f %.6f %.6f\n' % (x, y, z))
            hu, hn = bool(me.uv), bool(N)
            for a, b, c in me.tris:
                a += base
                b += base
                c += base
                if hu and hn:
                    f.write('f {0}/{0}/{0} {1}/{1}/{1} {2}/{2}/{2}\n'.format(a, b, c))
                elif hu:
                    f.write('f {0}/{0} {1}/{1} {2}/{2}\n'.format(a, b, c))
                elif hn:
                    f.write('f {0}//{0} {1}//{1} {2}//{2}\n'.format(a, b, c))
                else:
                    f.write('f %d %d %d\n' % (a, b, c))
            base += len(P)
