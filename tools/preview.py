"""Render an extracted OBJ to a PNG - a quick sanity check on geometry.

  python preview.py model.obj out.png [--size 512] [--yaw 0]

Software Z-buffer rasteriser with simple diffuse shading; no dependencies
beyond numpy and Pillow.
"""
import sys
import math
import numpy as np
from PIL import Image


def load_obj(path):
    V, F = [], []
    for line in open(path):
        if line.startswith('v '):
            V.append([float(x) for x in line.split()[1:4]])
        elif line.startswith('f '):
            idx = [int(t.split('/')[0]) for t in line.split()[1:4]]
            F.append([i - 1 if i > 0 else len(V) + i for i in idx])
    return np.array(V, np.float64), np.array(F, np.int32)


def render(V, F, size=512, yaw=0.0, pitch=0.0):
    if len(V) == 0 or len(F) == 0:
        return Image.new('RGB', (size, size), (24, 24, 28))
    c = (V.max(0) + V.min(0)) / 2
    P = V - c
    ry, rx = math.radians(yaw), math.radians(pitch)
    P = P @ np.array([[math.cos(ry), 0, math.sin(ry)],
                      [0, 1, 0],
                      [-math.sin(ry), 0, math.cos(ry)]]).T
    P = P @ np.array([[1, 0, 0],
                      [0, math.cos(rx), -math.sin(rx)],
                      [0, math.sin(rx), math.cos(rx)]]).T
    scale = size * 0.42 / max(np.abs(P).max(), 1e-6)
    x = P[:, 0] * scale + size / 2
    y = -P[:, 1] * scale + size / 2      # OBJ +Y is up, image +Y is down
    z = P[:, 2]

    img = np.full((size, size, 3), 26, np.uint8)
    zb = np.full((size, size), 1e30)

    tri = np.stack([np.stack([x[F[:, k]], y[F[:, k]], z[F[:, k]]], 1)
                    for k in range(3)], 1)                      # (n,3,3)
    e1 = tri[:, 1, :3] - tri[:, 0, :3]
    e2 = tri[:, 2, :3] - tri[:, 0, :3]
    nz = np.cross(e1, e2)
    ln = np.linalg.norm(nz, axis=1, keepdims=True)
    ln[ln == 0] = 1
    nrm = nz / ln
    light = np.array([0.3, 0.5, -0.8])
    light = light / np.linalg.norm(light)
    shade = np.clip(np.abs(nrm @ light), 0, 1) * 0.75 + 0.25

    order = np.argsort(-tri[:, :, 2].mean(1))
    for t in order:
        p = tri[t]
        x0, x1 = int(max(0, np.floor(p[:, 0].min()))), int(min(size - 1, np.ceil(p[:, 0].max())))
        y0, y1 = int(max(0, np.floor(p[:, 1].min()))), int(min(size - 1, np.ceil(p[:, 1].max())))
        if x1 < x0 or y1 < y0:
            continue
        xs = np.arange(x0, x1 + 1)
        ys = np.arange(y0, y1 + 1)
        gx, gy = np.meshgrid(xs, ys)
        d = ((p[1, 1] - p[2, 1]) * (p[0, 0] - p[2, 0]) +
             (p[2, 0] - p[1, 0]) * (p[0, 1] - p[2, 1]))
        if abs(d) < 1e-9:
            continue
        w0 = ((p[1, 1] - p[2, 1]) * (gx - p[2, 0]) + (p[2, 0] - p[1, 0]) * (gy - p[2, 1])) / d
        w1 = ((p[2, 1] - p[0, 1]) * (gx - p[2, 0]) + (p[0, 0] - p[2, 0]) * (gy - p[2, 1])) / d
        w2 = 1 - w0 - w1
        m = (w0 >= 0) & (w1 >= 0) & (w2 >= 0)
        if not m.any():
            continue
        zz = w0 * p[0, 2] + w1 * p[1, 2] + w2 * p[2, 2]
        sub = zb[y0:y1 + 1, x0:x1 + 1]
        better = m & (zz < sub)
        if not better.any():
            continue
        sub[better] = zz[better]
        col = np.array([210, 205, 200]) * shade[t]
        img[y0:y1 + 1, x0:x1 + 1][better] = col.astype(np.uint8)
    return Image.fromarray(img)


def main():
    src, dst = sys.argv[1], sys.argv[2]
    size = int(sys.argv[sys.argv.index('--size') + 1]) if '--size' in sys.argv else 512
    yaw = float(sys.argv[sys.argv.index('--yaw') + 1]) if '--yaw' in sys.argv else 0.0
    V, F = load_obj(src)
    print('%s: %d verts, %d tris' % (src, len(V), len(F)))
    render(V, F, size, yaw).save(dst)
    print('wrote', dst)


if __name__ == '__main__':
    main()
