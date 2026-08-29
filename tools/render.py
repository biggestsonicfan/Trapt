"""Software render of one cutscene frame -- the correctness gate for the viewer.

    python render.py e001 7830 out.png [--size 960] [--no-room] [--flat]

Assembles every visible entity at that frame with `pose.py`, looks through the
scene's own `.CAM` track, and rasterises with a numpy Z-buffer.  Flat shaded
using the scene's real light rig, so it answers "is the pose, the placement and
the camera right?" without any of the web plumbing.
"""
import math
import sys

import numpy as np
from PIL import Image

import pose
import scene as scene_mod
import smi as smi_mod
import tm2 as tm2_mod


def look_at(eye, target, roll=0.0):
    """World -> camera basis (row-vector), Y up."""
    f = np.array(target, float) - np.array(eye, float)
    n = np.linalg.norm(f)
    f = f / n if n > 1e-9 else np.array([0.0, 0.0, 1.0])
    up = np.array([0.0, 1.0, 0.0])
    if abs(np.dot(f, up)) > 0.999:
        up = np.array([0.0, 0.0, 1.0])
    # cross(f, up), not cross(up, f) -- see the note in pdiag.look_at.
    r = np.cross(f, up)
    r /= np.linalg.norm(r) or 1.0
    u = np.cross(r, f)
    if roll:
        c, s = math.cos(roll), math.sin(roll)
        r, u = r * c + u * s, u * c - r * s
    return np.stack([r, u, f])


def _texture(sc, name, cache):
    """Decode a `.TM2` into an (h, w, 4) uint8 array, or None."""
    if name in cache:
        return cache[name]
    img = None
    blob = sc.asset(name) if name else None
    if blob:
        try:
            pics = tm2_mod.decode(blob)
            if pics:
                w, h, rgba = pics[0]
                img = np.frombuffer(rgba, np.uint8).reshape(h, w, 4)
        except Exception:
            img = None
    cache[name] = img
    return img


def _entity_matrix(ent):
    """The block's own placement from `0x84`.

    `0x80` is NOT a scale here -- on a light block it is the light colour, and
    on a model block it is a material tint (`0.5,0.5,0.5,1` = half brightness).
    Applying it as a scale visibly shrinks the map track's door props.
    """
    if ent is None or ent.transform is None:
        return None
    tx, ty, tz = ent.transform[:3]
    if (tx, ty, tz) == (0.0, 0.0, 0.0):
        return None
    return [1.0, 0.0, 0.0, 0.0,
            0.0, 1.0, 0.0, 0.0,
            0.0, 0.0, 1.0, 0.0,
            tx, ty, tz, 1.0]


def _apply(M, P):
    if M is None:
        return P
    return [(x * M[0] + y * M[4] + z * M[8] + M[12],
             x * M[1] + y * M[5] + z * M[9] + M[13],
             x * M[2] + y * M[6] + z * M[10] + M[14]) for x, y, z in P]


def _parts_for(model, mats, sc, texcache, textured, ent=None):
    out = []
    M = _entity_matrix(ent)
    for me, (P, N) in zip(model.meshes, pose.skin(model, mats)):
        P = _apply(M, P)
        mat = model.materials[me.material] if me.material < len(model.materials) else {}
        rgba = mat.get('diffuse', (200, 200, 200, 255))
        tint = ent.scale[:3] if (ent is not None and ent.scale) else None
        tex = _texture(sc, mat.get('texture'), texcache) if textured else None
        uv = np.array(me.uv, float) if me.uv else None
        # Environment meshes ship baked vertex colours and no normals;
        # characters ship normals and no colours.  On the GS 0x80 is 1.0, so
        # the byte divides by 128, not 255 -- rp03's colours peak at exactly
        # 128 and average 50, which is why the real frame is so dark.
        vcol = (np.array(me.col, float)[:, :3] / 128.0) if me.col else None
        out.append({'V': np.array(P, float), 'F': np.array(me.tris, np.int32),
                    'colour': np.array(rgba[:3], float), 'alpha': rgba[3],
                    'tint': np.array(tint, float) if tint else None,
                    'vcol': vcol, 'lit': bool(me.nrm),
                    'uv': uv, 'tex': tex})
    return out


def gather(sc, frame, include_room=True, textured=True):
    """Return one dict per mesh, in world space, for `frame`."""
    parts = []
    models, clips, texcache = {}, {}, {}

    def model(name):
        if name not in models:
            blob = sc.asset(name)
            models[name] = smi_mod.parse(blob) if blob else None
        return models[name]

    def clip(name):
        if name not in clips:
            clips[name] = scene_mod.clip(sc, name)
        return clips[name]

    if include_room and sc.room_model:
        room = model(sc.room_model)
        if room:
            parts += _parts_for(room, pose.world_matrices(room), sc, texcache, textured)

    for ent in sc.actors:
        if not ent.visible_at(frame) or frame < ent.start:
            continue
        active = ent.clip_at(frame)
        cl = clip(active[1]) if active else None
        local = frame - active[0] if active else 0
        for mname in ent.render_models:
            mod = model(mname)
            if mod is None:
                continue
            parts += _parts_for(mod, pose.world_matrices(mod, cl, local),
                                sc, texcache, textured, ent)
    return parts


def rasterise(parts, eye, target, fov, roll, size=960, bg=(16, 16, 20),
              flip_v=False, cull=0):
    """Painter's-algorithm Z-buffer render with nearest-neighbour texturing."""
    W = H = size
    img = np.full((H, W, 3), bg, np.uint8)
    zb = np.full((H, W), 1e30)
    basis = look_at(eye, target, roll)
    focal = (H * 0.5) / math.tan(math.radians(fov) * 0.5)
    light = np.array([0.35, 0.75, -0.55])
    light /= np.linalg.norm(light)

    draw = []
    for part in parts:
        V, F = part['V'], part['F']
        if len(V) == 0 or len(F) == 0:
            continue
        C = (V - np.array(eye, float)) @ basis.T
        z = C[:, 2]
        ok = z > 0.05
        zs = np.where(ok, z, 1.0)
        sx = C[:, 0] * focal / zs + W * 0.5
        sy = -C[:, 1] * focal / zs + H * 0.5
        keep = ok[F].all(1)
        if not keep.any():
            continue
        f = F[keep]
        w = V[f]
        nrm = np.cross(w[:, 1] - w[:, 0], w[:, 2] - w[:, 0])
        ln = np.linalg.norm(nrm, axis=1, keepdims=True)
        ln[ln == 0] = 1.0
        shade = np.clip(np.abs((nrm / ln) @ light), 0, 1) * 0.72 + 0.28
        tri = np.stack([np.stack([sx[f[:, k]], sy[f[:, k]], z[f[:, k]]], 1)
                        for k in range(3)], 1)
        for i in range(len(f)):
            draw.append((tri[i, :, 2].mean(), tri[i], shade[i], part, f[i]))

    draw.sort(key=lambda r: -r[0])
    for _, p, shade, part, face in draw:
        x0 = int(max(0, math.floor(p[:, 0].min())))
        x1 = int(min(W - 1, math.ceil(p[:, 0].max())))
        y0 = int(max(0, math.floor(p[:, 1].min())))
        y1 = int(min(H - 1, math.ceil(p[:, 1].max())))
        if x1 < x0 or y1 < y0:
            continue
        gx, gy = np.meshgrid(np.arange(x0, x1 + 1), np.arange(y0, y1 + 1))
        d = ((p[1, 1] - p[2, 1]) * (p[0, 0] - p[2, 0]) +
             (p[2, 0] - p[1, 0]) * (p[0, 1] - p[2, 1]))
        if abs(d) < 1e-9:
            continue
        w0 = ((p[1, 1] - p[2, 1]) * (gx - p[2, 0]) +
              (p[2, 0] - p[1, 0]) * (gy - p[2, 1])) / d
        w1 = ((p[2, 1] - p[0, 1]) * (gx - p[2, 0]) +
              (p[0, 0] - p[2, 0]) * (gy - p[2, 1])) / d
        w2 = 1.0 - w0 - w1
        if cull and d * cull > 0:
            continue
        m = (w0 >= 0) & (w1 >= 0) & (w2 >= 0)
        if not m.any():
            continue
        zz = w0 * p[0, 2] + w1 * p[1, 2] + w2 * p[2, 2]
        sub = zb[y0:y1 + 1, x0:x1 + 1]
        hit = m & (zz < sub)
        if not hit.any():
            continue

        tex, uv = part['tex'], part['uv']
        if tex is not None and uv is not None:
            th, tw = tex.shape[0], tex.shape[1]
            u = w0 * uv[face[0], 0] + w1 * uv[face[1], 0] + w2 * uv[face[2], 0]
            v = w0 * uv[face[0], 1] + w1 * uv[face[1], 1] + w2 * uv[face[2], 1]
            # .SMI V already runs top-down, matching image row order; flipping
            # it (the OBJ convention) sends every face UV into the blank half
            # of its atlas, which is what the streaky white heads were.
            if flip_v:
                v = 1.0 - v
            # PS2 samplers wrap; clamping here smears edge texels into
            # long streaks wherever a UV leaves [0,1] (heads, most visibly).
            tx = np.mod((u * tw).astype(np.int32), tw)
            ty = np.mod((v * th).astype(np.int32), th)
            texel = tex[ty, tx]
            hit = hit & (texel[..., 3] > 8)
            if not hit.any():
                continue
            colour = texel[..., :3].astype(np.float64)
        else:
            colour = np.broadcast_to(part['colour'], gx.shape + (3,)).astype(np.float64)

        if part.get('vcol') is not None:
            # GS MODULATE: C = Ct * Cv, with Cv already in GS units
            colour = colour * part['vcol'][face].mean(axis=0)
        if part.get('tint') is not None:
            colour = colour * part['tint']
        sub[hit] = zz[hit]
        sh = shade if part.get('lit', True) else 1.0
        img[y0:y1 + 1, x0:x1 + 1][hit] = np.clip(
            colour[hit] * sh, 0, 255).astype(np.uint8)
    return Image.fromarray(img)


def main():
    name = sys.argv[1]
    frame = float(sys.argv[2])
    out = sys.argv[3]
    size = int(sys.argv[sys.argv.index('--size') + 1]) if '--size' in sys.argv else 960
    sc = scene_mod.load(name)
    parts = gather(sc, frame, include_room='--no-room' not in sys.argv,
                   textured='--flat' not in sys.argv)
    cam = sc.camera.sample(frame) if sc.camera else {}
    eye = cam.get('position', (0.0, 20.0, -80.0))
    target = cam.get('target', (0.0, 12.0, 0.0))
    fov = cam.get('fov', 40.0)
    roll = cam.get('roll', 0.0)
    tris = sum(len(p['F']) for p in parts)
    print('%s frame %g: %d parts, %d triangles' % (name, frame, len(parts), tris))
    print('  camera %s -> %s, fov %.1f' % (tuple(round(x, 2) for x in eye),
                                           tuple(round(x, 2) for x in target), fov))
    cull = 1 if '--cull' in sys.argv else (-1 if '--cull-back' in sys.argv else 0)
    rasterise(parts, eye, target, fov, roll, size,
              flip_v='--flip-v' in sys.argv, cull=cull).save(out)
    print('wrote', out)


if __name__ == '__main__':
    main()
