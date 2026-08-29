"""Pose a `.SMI` skeleton with a `.SAI` clip and skin it to world space.

The two conventions that matter, both verified against the game's own data:

* `.SMI` node matrices are **row-vector** 4x4s stored row-major, so a child's
  world matrix is ``local * parent`` and a point transforms as ``v * M``.
* `.SAI` rotations are unit quaternions ``(x, y, z, w)`` in the column-vector
  convention, i.e. the transpose of the `.SMI` 3x3.  `sai.quat_to_matrix`
  already returns the row-vector form, so it drops straight into a node matrix.

A clip only supplies the channels it animates.  Anything it leaves out -- most
often translation and scale -- falls back to the bind matrix, which is how
rotation-only clips keep a rig's proportions.
"""
import math

import sai as sai_mod
import smi as smi_mod

IDENT = [1.0, 0.0, 0.0, 0.0,
         0.0, 1.0, 0.0, 0.0,
         0.0, 0.0, 1.0, 0.0,
         0.0, 0.0, 0.0, 1.0]


def _row_len(m, r):
    return math.sqrt(m[r * 4] ** 2 + m[r * 4 + 1] ** 2 + m[r * 4 + 2] ** 2)


def compose(rot, translation, scale):
    """Row-major, row-vector 4x4 from quaternion, translation and scale."""
    r = sai_mod.quat_to_matrix(rot)
    sx, sy, sz = scale
    return [r[0] * sx, r[1] * sx, r[2] * sx, 0.0,
            r[4] * sy, r[5] * sy, r[6] * sy, 0.0,
            r[8] * sz, r[9] * sz, r[10] * sz, 0.0,
            translation[0], translation[1], translation[2], 1.0]


def local_matrices(model, clip, frame):
    """Per-node local matrices for `model` posed by `clip` at `frame`."""
    animated = clip.by_name() if clip else {}
    out = []
    for node in model.nodes:
        bind = node['matrix']
        a = animated.get(node['name'])
        if a is None:
            out.append(list(bind))
            continue
        rot = a.channels.get(sai_mod.ROT)
        pos = a.channels.get(sai_mod.POS)
        scl = a.channels.get(sai_mod.SCL)
        if rot is None and pos is None and scl is None:
            out.append(list(bind))
            continue
        q = rot.sample(frame)[:4] if rot else sai_mod.matrix_to_quat(bind)
        t = pos.sample(frame)[:3] if pos else (bind[12], bind[13], bind[14])
        s = scl.sample(frame)[:3] if scl else (_row_len(bind, 0),
                                               _row_len(bind, 1),
                                               _row_len(bind, 2))
        out.append(compose(q, t, s))
    return out


def world_matrices(model, clip=None, frame=0):
    """Accumulate posed local matrices down each node's parent chain."""
    local = local_matrices(model, clip, frame)
    out = [None] * len(local)

    def solve(i, seen=()):
        if out[i] is not None:
            return out[i]
        p = model.nodes[i]['parent']
        if p < 0 or p >= len(local) or p == i or p in seen:
            out[i] = local[i]
        else:
            out[i] = smi_mod._mul(local[i], solve(p, seen + (i,)))
        return out[i]

    for i in range(len(local)):
        solve(i)
    return out


def skin(model, mats):
    """Skin every mesh with `mats`; returns ``[(positions, normals)]``.

    Both `.SMI` vertex streams are pre-scaled by the blend weight and the
    position's w *is* that weight, so transforming the homogeneous float4
    scales the matrix's translation row correctly and the blend is a plain
    sum.  Re-applying the weight here would square it.
    """
    out = []
    for me in model.meshes:
        P, N = [], []
        for v in range(me.vcount):
            px = py = pz = nx = ny = nz = 0.0
            for k in range(me.influences):
                p = me.pos[v][k] if me.pos else (0.0, 0.0, 0.0, 1.0)
                w = p[3]
                if w == 0.0:
                    continue
                b = me.bones[v][k] if me.bones and k < len(me.bones[v]) else 0
                M = mats[b] if b < len(mats) else IDENT
                px += p[0] * M[0] + p[1] * M[4] + p[2] * M[8] + w * M[12]
                py += p[0] * M[1] + p[1] * M[5] + p[2] * M[9] + w * M[13]
                pz += p[0] * M[2] + p[1] * M[6] + p[2] * M[10] + w * M[14]
                if me.nrm:
                    n = me.nrm[v][k]
                    nx += n[0] * M[0] + n[1] * M[4] + n[2] * M[8]
                    ny += n[0] * M[1] + n[1] * M[5] + n[2] * M[9]
                    nz += n[0] * M[2] + n[1] * M[6] + n[2] * M[10]
            P.append((px, py, pz))
            N.append((nx, ny, nz))
        out.append((P, N if me.nrm else []))
    return out
