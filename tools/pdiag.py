"""Rasterise an exported cutscene page with the page's own shader -- the gate
for texture and lighting bugs that `render.py` cannot see.

    python pdiag.py out/e001.html 7830 shot.png
    python pdiag.py out/e001.html 7830 shot.png --mode light --legacy
    python pdiag.py out/e001.html 7830 --stats

`render.py` answers "is the pose, the placement and the camera right?" and
deliberately shades flat with a hardcoded key light, ignoring `diffuse` when a
texture is present.  That blindness is why a whole class of bug survived it:
the black-material doorway and the inverted-normal lighting both look fine in
`render.py` and wrong in the browser.

This reads nothing but the HTML -- geometry, skinning, textures, lights and fog
all come out of the page, and `shade()` is a line-for-line port of FRAG in
`player.html` -- so what it draws is what the browser draws.  Keep the two in
step: if you change FRAG, change `shade()`.

Modes
-----
``shaded``  the page as it renders          ``light``   lighting only, white albedo
``unlit``   texture only, no lighting       ``normal``  world normal as RGB
``meshid``  one flat colour per mesh        ``uv``      UV, blue where outside [0,1]
``alpha``   sampled alpha as greyscale

`shaded` also composites the letterbox and the game's own subtitle font on top,
because the GS draws both into the same framebuffer; `--no-subs` and
`--no-bars` leave them off.

`--only` takes a comma-separated list; a `-name` entry excludes instead.

`--legacy` restores the pre-fix shader (material colour modulated into the
texture, the `gl_FrontFacing` normal flip, the additive `+0.34` lift and the
ambient fallback added to rather than replaced by the scene's own) so a fix can
be diffed against what shipped.
"""
import base64
import io
import json
import math
import sys

import numpy as np
from PIL import Image

NRM = 1.0 / 4096.0
# 255/128: a byte-normalised vertex colour scaled into GS units, where 0x80 is
# 1.0.  Must track GS_ONE in player.html's FRAG.
GS_ONE = 255.0 / 128.0
# TEST ATE=1 ATST=GEQUAL AREF=120 on the opaque pass -- 120/128.
AREF_OPAQUE = 120.0 / 128.0
# The GS frame is 512x224; the video hardware puts it on a 4:3 screen.
DISPLAY_ASPECT = 4.0 / 3.0

# Must track player.html.  EXPOSURE used to be an invented 1.35, fitted to
# compensate for a directional light aimed at a guess and a key light left at
# its raw offset instead of on the camera.  With both taken from the data the
# rig needs no correction: over e001 frame 7422 against the hardware frame,
# 1.0 minimises the error on the cast and 1.35 is 40% worse.
EXPOSURE = 1.0
LEGACY_LIFT = 0.34
CUTOUT = AREF_OPAQUE     # TEST AREF=120/128, matching player.html;
                         # tm2.py already maps PS2 alpha 0..0x80 onto 0..255
# Fallback only.  A directional light's real aim comes from the room's `.sli`
# (see sli.infinite_direction); this stands in for a scene that has no room.
DIR_DEFAULT = (0.35, 0.80, -0.49)


class Opts:
    """Which shader to emulate."""

    def __init__(self, legacy=False, exposure=None, ambient=None, dird=None,
                 cutout=CUTOUT, fog=True, cull=0, bilinear=True):
        self.legacy = legacy
        self.exposure = EXPOSURE if exposure is None else exposure
        self.ambient = ambient
        self.dird = dird          # None unless --dird overrides the room's
        self.cutout = cutout
        self.bilinear = bilinear
        self.fog = fog
        self.cull = cull


# --------------------------------------------------------------------- loading
def load(path):
    """Pull the scene JSON and the binary blob back out of an exported page."""
    s = open(path, encoding='utf-8').read()
    i = s.index('window.TRAPT_SCENE=') + len('window.TRAPT_SCENE=')
    j = s.index(';\nwindow.TRAPT_BIN=')
    scene = json.loads(s[i:j])
    k = s.index('window.TRAPT_BIN="') + len('window.TRAPT_BIN="')
    return scene, base64.b64decode(s[k:s.index('"', k)])


class Bin:
    """The typed-array views `TraptMath` builds over TRAPT_BIN."""

    def __init__(self, b):
        self.b = b

    def f32(self, r):
        return np.frombuffer(self.b, '<f4', r[1], r[0]) if r[1] else np.zeros(0, 'f4')

    def u16(self, r):
        return np.frombuffer(self.b, '<u2', r[1], r[0]) if r[1] else np.zeros(0, 'u2')

    def i16(self, r):
        return np.frombuffer(self.b, '<i2', r[1], r[0]) if r[1] else np.zeros(0, 'i2')

    def u8(self, r):
        return np.frombuffer(self.b, 'u1', r[1], r[0]) if r[1] else np.zeros(0, 'u1')


# ------------------------------------------------------------------- skinning
def quat_to_rows(q, s, t):
    x, y, z, w = q
    sx, sy, sz = s
    return np.array([
        (1-2*(y*y+z*z))*sx, (2*(x*y+z*w))*sx,   (2*(x*z-y*w))*sx,   0,
        (2*(x*y-z*w))*sy,   (1-2*(x*x+z*z))*sy, (2*(y*z+x*w))*sy,   0,
        (2*(x*z+y*w))*sz,   (2*(y*z-x*w))*sz,   (1-2*(x*x+y*y))*sz, 0,
        t[0], t[1], t[2], 1.0], float)


def quat_from_rows(m):
    tr = m[0]+m[5]+m[10]
    if tr > 0:
        s = math.sqrt(tr+1)*2
        q = ((m[6]-m[9])/s, (m[8]-m[2])/s, (m[1]-m[4])/s, 0.25*s)
    elif m[0] > m[5] and m[0] > m[10]:
        s = math.sqrt(1+m[0]-m[5]-m[10])*2
        q = (0.25*s, (m[4]+m[1])/s, (m[8]+m[2])/s, (m[6]-m[9])/s)
    elif m[5] > m[10]:
        s = math.sqrt(1+m[5]-m[0]-m[10])*2
        q = ((m[4]+m[1])/s, 0.25*s, (m[9]+m[6])/s, (m[8]-m[2])/s)
    else:
        s = math.sqrt(1+m[10]-m[0]-m[5])*2
        q = ((m[8]+m[2])/s, (m[9]+m[6])/s, 0.25*s, (m[1]-m[4])/s)
    q = np.array(q, float)
    return q / (np.linalg.norm(q) or 1)


def find_key(T, t):
    """Last index with T[i] <= t, or -1 before the first key."""
    if len(T) == 0 or t <= T[0]:
        return -1
    if t >= T[-1]:
        return len(T)-1
    return int(np.searchsorted(T, t, 'right') - 1)


def sample_quat(ch, t):
    T, V, q = ch['_t'], ch['_v'], ch['_s']
    i = find_key(T, t)
    if i < 0:
        return V[0:4]*q
    if i >= len(T)-1:
        return V[i*4:i*4+4]*q
    span = float(T[i+1]-T[i])
    f = (t-T[i])/span if span else 0.0
    a, b = V[i*4:i*4+4]*q, V[i*4+4:i*4+8]*q
    d = float(a @ b)
    if d < 0:
        b, d = -b, -d
    wa, wb = 1-f, f
    if d < 0.9995:
        th = math.acos(min(1, d))
        sn = math.sin(th)
        wa, wb = math.sin(wa*th)/sn, math.sin(wb*th)/sn
    o = a*wa + b*wb
    return o / (np.linalg.norm(o) or 1)


def sample_vec(ch, t):
    T, V = ch['_t'], ch['_v']
    i = find_key(T, t)
    if i < 0:
        return V[0:3].astype(float)
    if i >= len(T)-1:
        return V[i*4:i*4+3].astype(float)
    span = float(T[i+1]-T[i])
    f = (t-T[i])/span if span else 0.0
    return V[i*4:i*4+3] + (V[i*4+4:i*4+7]-V[i*4:i*4+3])*f


def rowlen(m, r):
    return math.hypot(m[r*4], m[r*4+1], m[r*4+2])


def world_matrices(md, clip, t):
    """Row-vector world matrices: a child's world matrix is local * parent."""
    nodes = md['nodes']
    n = len(nodes)
    locals_ = [None]*n
    for i, nd in enumerate(nodes):
        bind = np.array(nd['m'], float)
        a = clip['nodes'].get(nd['name']) if clip else None
        if not a:
            locals_[i] = bind
            continue
        q = sample_quat(a['r'], t) if 'r' in a else quat_from_rows(bind)
        tr = sample_vec(a['t'], t) if 't' in a else bind[12:15]
        sc = (sample_vec(a['s'], t) if 's' in a else
              np.array([rowlen(bind, 0), rowlen(bind, 1), rowlen(bind, 2)]))
        locals_[i] = quat_to_rows(q, sc, tr)
    W = [None]*n

    def solve(i, depth=0):
        if W[i] is not None:
            return W[i]
        W[i] = locals_[i]                       # cycle guard, as in the player
        p = nodes[i]['parent']
        if not (p < 0 or p >= n or p == i or depth > 96):
            W[i] = (locals_[i].reshape(4, 4) @ solve(p, depth+1).reshape(4, 4)).ravel()
        return W[i]
    for i in range(n):
        solve(i)
    return np.array(W)


def skin(me, B, W, offset):
    """The vertex shader on the CPU.  lp0.w carries the blend weight."""
    lp0 = B.f32(me['lp0']).reshape(-1, 4).astype(float)
    n0 = B.i16(me['n0']).reshape(-1, 3).astype(float) * NRM
    idx = B.u16(me['b']).reshape(-1, 2).astype(np.int64)
    M0 = W[np.clip(idx[:, 0], 0, len(W)-1)].reshape(-1, 4, 4)
    P = np.einsum('vi,vij->vj', lp0, M0)[:, :3]
    N = np.einsum('vi,vij->vj', n0, M0[:, :3, :3])
    if me['two']:
        lp1 = B.f32(me['lp1']).reshape(-1, 4).astype(float)
        n1 = B.i16(me['n1']).reshape(-1, 3).astype(float) * NRM
        M1 = W[np.clip(idx[:, 1], 0, len(W)-1)].reshape(-1, 4, 4)
        P = P + np.einsum('vi,vij->vj', lp1, M1)[:, :3]
        N = N + np.einsum('vi,vij->vj', n1, M1[:, :3, :3])
    return P + np.asarray(offset, float), N


def decode_tex(uri):
    if not uri:
        return None
    im = Image.open(io.BytesIO(base64.b64decode(uri.split(',', 1)[1])))
    return np.asarray(im.convert('RGBA'), np.float64) / 255.0


# --------------------------------------------------------------------- shading
class Rig:
    """The light rig, built the way player.html builds it."""

    def __init__(self, S, opt):
        self.opt = opt
        self.amb = np.array([0.10, 0.10, 0.10])
        self.dirC = np.array([0.35, 0.35, 0.35])
        self._pts = []
        self.dirD = None
        have_amb = False
        for l in S.get('lights') or []:
            c = np.array(l['colour'], float)
            if l['kind'] == 'ambient':
                # the shipped bug: the fallback was added to, not replaced by
                self.amb = self.amb + c if (opt.legacy or have_amb) else c
                have_amb = True
            elif l['kind'] == 'directional':
                self.dirC = c
                if l.get('direction'):
                    self.dirD = np.array(l['direction'], float)
            else:
                self._pts.append((c, np.array(l['position'], float),
                                  np.array(l['range'], float),
                                  l.get('parent') == 'camera'))
        while len(self._pts) < 2:
            self._pts.append((np.zeros(3), np.zeros(3), np.array([0.0, 1.0]),
                              False))
        if opt.ambient is not None:
            self.amb = np.full(3, opt.ambient)
        if opt.dird is not None:
            self.dirD = np.array(opt.dird, float)
        elif self.dirD is None:
            self.dirD = np.array(DIR_DEFAULT, float)
        self.dirD = self.dirD/np.linalg.norm(self.dirD)
        self.fog = S.get('fog') if opt.fog else None
        self.pts = [(c, p, r) for c, p, r, _ in self._pts]

    def place(self, eye, basis):
        """Resolve camera-parented lights for one frame.

        ELF 0x001D44B0 rebuilds such a light every frame as
        ``camera_rotation * offset + eye``.  Measured against the hardware at
        e001 frame 7422, the offset's x runs along **-right**: `joyu`'s
        (10, -5, 0) lands at (4.140, 5.258, -37.819), which
        ``eye - 10*R - 5*U`` reproduces to 5e-5.
        """
        R, U, F = basis
        eye = np.asarray(eye, float)
        self.pts = [(c, (eye - p[0]*R + p[1]*U + p[2]*F) if par else p, r)
                    for c, p, r, par in self._pts]
        return self


def smoothstep(a, b, x):
    t = np.clip((x-a)/max(b-a, 1e-9), 0, 1)
    return t*t*(3-2*t)


def sample(tex, u, v, bilinear=True):
    """TEX1 MMAG=MMIN=LINEAR, MXL=0 -- bilinear, wrapping, no mipmaps.

    Point sampling here does not merely look rougher: on the lace and filigree
    textures the cast wears it aliases into white speckle that the hardware
    never shows, which reads as a texture bug in the viewer that is not there.
    """
    th, tw = tex.shape[:2]
    if not bilinear:
        return tex[np.mod((v*th).astype(np.int64), th),
                   np.mod((u*tw).astype(np.int64), tw)].astype(float)
    x, y = u*tw - 0.5, v*th - 0.5
    x0, y0 = np.floor(x).astype(np.int64), np.floor(y).astype(np.int64)
    fx, fy = (x-x0)[:, None], (y-y0)[:, None]
    x0m, x1m = np.mod(x0, tw), np.mod(x0+1, tw)
    y0m, y1m = np.mod(y0, th), np.mod(y0+1, th)
    t = tex.astype(float)
    return ((t[y0m, x0m]*(1-fx) + t[y0m, x1m]*fx)*(1-fy)
            + (t[y1m, x0m]*(1-fx) + t[y1m, x1m]*fx)*fy)


def light(rig, n, wp):
    """The `lit == 1` half of FRAG: the script's rig evaluated per fragment."""
    out = np.tile(rig.amb, (len(n), 1))
    out = out + rig.dirC * np.clip(n @ rig.dirD, 0, None)[:, None]
    for c, p, r in rig.pts:
        d = p - wp
        L = np.linalg.norm(d, axis=1)
        att = 1.0 - smoothstep(r[0], max(r[1], r[0]+0.001), L)
        nd = np.clip(np.einsum('vi,vi->v', n, d/np.maximum(L, 1e-9)[:, None]), 0, None)
        out = out + c * (nd*att)[:, None]
    return out


def shade(rig, base, n, wp, tint, eye, vcol=None):
    """FRAG, per fragment.

    `vcol` is the mesh's baked vertex colour, present exactly when the mesh
    carries no normals (`lit == 0`).  Environment geometry ships pre-lit and
    must not be lit again -- that is the single largest brightness error the
    viewer had, and lighting it here is what let it survive in the gate.
    """
    if vcol is None:
        lit = light(rig, n, wp)
        col = (base * tint * (lit + LEGACY_LIFT) if rig.opt.legacy
               else base * tint * lit * rig.opt.exposure)
    else:
        col = base * tint * (vcol * GS_ONE)
    if rig.fog is not None:
        f0, f1, fr, fg, fb = rig.fog
        m = smoothstep(f0, f1, np.linalg.norm(wp-eye, axis=1))*0.85
        col = col*(1-m)[:, None] + np.array([fr, fg, fb])*m[:, None]
    return col


# ------------------------------------------------------------------ rasteriser
def look_at(eye, target, roll=0.0):
    """World -> camera basis (row-vector), Y up."""
    f = np.asarray(target, float)-np.asarray(eye, float)
    nf = np.linalg.norm(f)
    f = f/nf if nf > 1e-9 else np.array([0., 0., 1.])
    up = np.array([0., 1., 0.])
    if abs(f @ up) > 0.999:
        up = np.array([0., 0., 1.])
    # Screen-right is cross(f, up), not cross(up, f).  The game keeps this
    # basis at 0x0081B730 in EE RAM and it is the first form; the second
    # mirrors the whole image left-to-right.  three.js gets it right on its
    # own (`Matrix4.lookAt` builds x = up x (eye-target)), so this was a
    # divergence between the software gate and the page it is meant to check.
    r = np.cross(f, up)
    r /= np.linalg.norm(r) or 1
    u = np.cross(r, f)
    if roll:
        c, s = math.cos(roll), math.sin(roll)
        r, u = r*c+u*s, u*c-r*s
    return np.stack([r, u, f])


def render(parts, eye, target, fov, roll, rig, size, mode='shaded',
           bg=(6, 6, 10), ids=None):
    """Z-buffered, nearest-neighbour, per-fragment lighting.

    Screen y runs down, so the signed area `d` is positive exactly when
    `(b-a)x(c-a)` points at the camera -- which is what GL calls front-facing.

    `ids`, an `(H, W)` int array, comes back holding the index into `parts`
    of whatever owns each pixel (-1 for none): the opaque surface that won Z,
    or a blended one drawn over it at alpha 0.5 or more.  `grade.py` uses it
    to say which entity a difference from the hardware lives on.
    """
    owner = {id(p): i for i, p in enumerate(parts)}
    opt = rig.opt
    W, H = size if isinstance(size, tuple) else (size, size)
    img = np.tile(np.array(bg, np.float64)/255.0, (H, W, 1))
    zb = np.full((H, W), 1e30)
    basis = look_at(eye, target, roll)
    rig.place(eye, basis)
    # `fov` is vertical.  The GS's 512x224 target is anamorphic -- the video
    # hardware stretches it to 4:3 -- so the horizontal focal comes from the
    # *display* aspect, not from W/H.  At 640x480 the two coincide, which is
    # why a square-pixel projection went unnoticed until the gate was asked to
    # render at the hardware's own resolution.
    t = math.tan(math.radians(fov)*0.5)
    fy = (H*0.5)/t
    fx = (W*0.5)/(t*DISPLAY_ASPECT)
    # The GS draws opaque materials with AFAIL=KEEP (they write Z) and blended
    # ones with ATST=NEVER + AFAIL=FB_ONLY (colour only, Z never written).  So
    # the order is: every opaque surface first, then the blended ones back to
    # front, depth-tested but never depth-writing.
    ordered = [p for p in parts if not p.get('blend')]
    tail = [p for p in parts if p.get('blend')]
    if tail:
        key = [(np.asarray(p['V'], float)-np.asarray(eye, float)) @ basis[2]
               for p in tail]
        ordered += [tail[i] for i in np.argsort(
            [-(k.mean() if len(k) else 0.0) for k in key])]
    for part in ordered:
        blend = bool(part.get('blend'))
        additive = bool(part.get('add'))
        atest = bool(part.get('atest', True))
        V, F, N = part['V'], part['F'], part['N']
        if not len(V) or not len(F):
            continue
        C = (V-np.asarray(eye, float)) @ basis.T
        z = C[:, 2]
        ok = z > 0.05
        zs = np.where(ok, z, 1.0)
        sx = C[:, 0]*fx/zs + W*0.5
        sy = -C[:, 1]*fy/zs + H*0.5
        keep = ok[F].all(1)
        if not keep.any():
            continue
        f = F[keep]
        tex, uv = part['tex'], part['uv']
        for ti in np.argsort(-z[f].mean(1)):
            tri = f[ti]
            px, py, pz = sx[tri], sy[tri], z[tri]
            x0 = int(max(0, math.floor(px.min())))
            x1 = int(min(W-1, math.ceil(px.max())))
            y0 = int(max(0, math.floor(py.min())))
            y1 = int(min(H-1, math.ceil(py.max())))
            if x1 < x0 or y1 < y0:
                continue
            d = (py[1]-py[2])*(px[0]-px[2]) + (px[2]-px[1])*(py[0]-py[2])
            if abs(d) < 1e-9 or (opt.cull and d*opt.cull > 0):
                continue
            gx, gy = np.meshgrid(np.arange(x0, x1+1), np.arange(y0, y1+1))
            w0 = ((py[1]-py[2])*(gx-px[2]) + (px[2]-px[1])*(gy-py[2]))/d
            w1 = ((py[2]-py[0])*(gx-px[2]) + (px[0]-px[2])*(gy-py[2]))/d
            w2 = 1.0-w0-w1
            m = (w0 >= 0) & (w1 >= 0) & (w2 >= 0)
            if not m.any():
                continue
            zz = w0*pz[0]+w1*pz[1]+w2*pz[2]
            sub = zb[y0:y1+1, x0:x1+1]
            hit = m & (zz < sub)
            if not hit.any():
                continue
            W0, W1, W2 = w0[hit], w1[hit], w2[hit]
            uu = vv = None
            if uv is not None and len(uv):
                uu = W0*uv[tri[0], 0]+W1*uv[tri[1], 0]+W2*uv[tri[2], 0]
                vv = W0*uv[tri[0], 1]+W1*uv[tri[1], 1]+W2*uv[tri[2], 1]
            base = np.tile(part['diffuse'], (len(W0), 1))
            if tex is not None and uu is not None:
                # .SMI V already runs top-down; PS2 samplers wrap, and 20 room
                # meshes tile up to 11x, so this must be a modulo not a clamp.
                t = sample(tex, uu, vv, opt.bilinear)
                base = base * t if opt.legacy else t
            vc = None
            if part.get('col') is not None and not opt.legacy:
                C4 = part['col']
                vc = (W0[:, None]*C4[tri[0]] + W1[:, None]*C4[tri[1]]
                      + W2[:, None]*C4[tri[2]])
                # MODULATE folds the vertex alpha in before the test:
                # A = (At * Av) >> 7
                base[:, 3] = base[:, 3]*np.clip(vc[:, 3]*GS_ONE, 0, 1)
                vc = None if part.get('lit', 1) else vc[:, :3]
            # ATST=GEQUAL AREF=120, but only where the material arms the
            # test.  Blended materials use ATST=NEVER, which never discards --
            # every fragment reaches the framebuffer, it just does not reach
            # Z -- and an opaque material without the flag draws whole.
            alive = (np.ones(len(W0), bool) if (blend or not atest)
                     else base[:, 3] >= opt.cutout)
            if not alive.any():
                continue
            nn = W0[:, None]*N[tri[0]] + W1[:, None]*N[tri[1]] + W2[:, None]*N[tri[2]]
            ln = np.linalg.norm(nn, axis=1, keepdims=True)
            ln[ln == 0] = 1
            nn = nn/ln
            if opt.legacy and d <= 0:                 # the gl_FrontFacing flip
                nn = -nn
            wp = W0[:, None]*V[tri[0]] + W1[:, None]*V[tri[1]] + W2[:, None]*V[tri[2]]
            if mode == 'shaded':
                col = shade(rig, base[:, :3], nn, wp, part['tint'], eye, vc)
            elif mode == 'unlit':
                col = base[:, :3]
            elif mode == 'light':
                col = shade(rig, np.ones((len(W0), 3)), nn, wp, np.ones(3), eye,
                            vc)
            elif mode == 'normal':
                col = nn*0.5+0.5
            elif mode == 'meshid':
                col = np.tile(part['idcol'], (len(W0), 1))
            elif mode == 'uv':
                if uu is None:
                    uu = vv = np.zeros(len(W0))
                col = np.stack([np.mod(uu, 1), np.mod(vv, 1),
                                ((uu < 0) | (uu > 1) | (vv < 0) | (vv > 1)) * 1.0], 1)
            elif mode == 'alpha':
                col = np.tile(base[:, 3:4], (1, 3))
            else:
                raise SystemExit('unknown mode %r' % mode)
            hit2 = hit.copy()
            hit2[hit] = alive
            tile = img[y0:y1+1, x0:x1+1]
            src = np.clip(col[alive], 0, 1)
            if blend:
                # ALPHA = (Cs-Cd)*As>>7 + Cd, or Cs*As>>7 + Cd when additive;
                # either way no Z write (AFAIL=FB_ONLY)
                a = np.clip(base[alive, 3], 0, 1)[:, None]
                tile[hit2] = (np.clip(src*a + tile[hit2], 0, 1) if additive
                              else src*a + tile[hit2]*(1.0-a))
                if ids is not None:
                    over = hit2.copy()
                    over[hit2] = a[:, 0] >= 0.5
                    ids[y0:y1+1, x0:x1+1][over] = owner[id(part)]
            else:
                sub[hit2] = zz[hit2]
                tile[hit2] = src
                if ids is not None:
                    ids[y0:y1+1, x0:x1+1][hit2] = owner[id(part)]
    return Image.fromarray((np.clip(img, 0, 1)*255).astype(np.uint8))


# -------------------------------------------------------------- the overlay
# The GS draws the letterbox and then the dialogue straight into the 512x224
# framebuffer, over everything else, so this composites them last.  Like
# `shade()` above it is a port of what the page does -- `layout()` here is
# `layout()` in player.html and the blend is its overlay shader -- and it reads
# only the exported font block, never the ELF.  `tools/font.py` is the other
# end of the same chain: it derives that block from the executable and
# reproduces the hardware display list's vertex positions exactly.
def cue_at(S, frame):
    cur = None
    for s in S.get('subtitles', ()):
        if s['frame'] <= frame < (s['end'] if s['end'] is not None else 1e30):
            cur = s
    return cur


def layout(FNT, raw):
    """One `0x60` payload -> `[(slot, ui_x, ui_y, (r,g,b))]` in 640x448 units."""
    bw, bh = FNT['box']
    cw = FNT['cell'][0]
    left, top = FNT['anchor'][0] - bw / 2.0, FNT['anchor'][1] - bh / 2.0
    pen, line = left, 0
    tint = saved = FNT['body']
    out, i = [], 0
    while i < len(raw):
        if raw.startswith('%%SC', i) and i + 6 <= len(raw):
            c = FNT['colours'].get(raw[i + 4:i + 6])
            # an unrecognised code takes the same path as `%%RC`
            tint, saved = (c, tint) if c else (saved, tint)
            i += 6
        elif raw.startswith('%%RC', i):
            tint, saved = saved, tint
            i += 4
        elif raw.startswith('\\n', i):
            line, pen, i = line + 1, left, i + 2
        elif raw.startswith('\\0', i) or raw[i] == '\0':
            break
        else:
            g = FNT['glyphs'].get(str(ord(raw[i])))
            i += 1
            if g:
                out.append((g[0], pen, top + line * bh, tint))
                pen += g[1] * (bw / float(cw))
    return out


def bar_open(LB, frame):
    """`0x57`'s tween, replayed: 0 = bars gone, 1 = seated (player.html)."""
    open_ = 0.0
    for f, kind, n in LB.get('events', ()):
        if frame < f:
            break
        t = min(1.0, (frame - f) / float(max(1, n)))
        if kind == 'in':
            open_ = t
        elif kind == 'out':
            open_ = 1.0 - t
    return open_


def overlay(img, S, frame, subs=True, bars=True):
    a = np.asarray(img, np.float64) / 255.0
    H, W = a.shape[:2]
    LB = S.get('letterbox') or {'ui': [640, 448], 'bars': [50, 110], 'events': []}
    if bars:
        # 50 and 110 UI units, top and bottom, sliding in from off-screen --
        # not the symmetric band it looks like.  See player.html.
        open_ = bar_open(LB, frame)
        top = LB['bars'][0] * H / LB['ui'][1]
        bot = LB['bars'][1] * H / LB['ui'][1]
        y0 = int(round(top * open_))
        y1 = int(round(H - bot * open_))
        a[:max(0, y0)] = 0.0
        a[min(H, y1):] = 0.0
    FNT = S.get('font')
    cue = cue_at(S, frame) if subs else None
    if not (FNT and cue):
        return Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8))
    atlas = decode_tex(FNT['atlas'])
    ah, aw = atlas.shape[:2]
    cw, ch = FNT['cell']
    cols, pad = FNT['cols'], FNT['pad']
    step = cw + 2 * pad
    kx, ky = W / FNT['ui'][0], H / FNT['ui'][1]
    gw, gh = FNT['box'][0] * kx, FNT['box'][1] * ky
    for slot, ux, uy, tint in layout(FNT, cue['raw']):
        # The GS samples at a pixel's integer coordinate, not its centre, so
        # the quad moves half a pixel -- exactly `nudge` in player.html.
        x0, y0 = ux * kx + 0.5, uy * ky + 0.5
        px = np.arange(max(0, int(math.floor(x0))),
                       min(W, int(math.ceil(x0 + gw))))
        py = np.arange(max(0, int(math.floor(y0))),
                       min(H, int(math.ceil(y0 + gh))))
        if not len(px) or not len(py):
            continue
        fx = (px + 0.5 - x0) / gw
        fy = (py + 0.5 - y0) / gh
        mx, my = (fx >= 0) & (fx <= 1), (fy >= 0) & (fy <= 1)
        px, fx, py, fy = px[mx], fx[mx], py[my], fy[my]
        if not len(px) or not len(py):
            continue
        u0 = ((slot % cols) * step + pad) / float(aw)
        v0 = ((slot // cols) * step + pad) / float(ah)
        U, V = np.meshgrid(u0 + fx * cw / aw, v0 + fy * ch / ah)
        t = sample(atlas, U.ravel(), V.ravel()).reshape(len(py), len(px), 4)
        # TFX=MODULATE with TCC=RGBA, vertex alpha 0x80, then the standard
        # ALPHA lerp.  The atlas is the CLUT already applied, and its 0x80
        # alpha is the GS's 1.0.
        al = np.clip(t[..., 3:4] * GS_ONE, 0, 1)
        tile = a[py[0]:py[-1] + 1, px[0]:px[-1] + 1]
        tile[:] = t[..., :3] * np.asarray(tint) * al + tile * (1.0 - al)
    return Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8))


# --------------------------------------------------------------------- gather
def prime(S, B):
    """Attach typed-array views to every clip channel, once."""
    for c in S['clips'].values():
        for ch in c['nodes'].values():
            for k in ('r', 't', 's'):
                if k in ch and '_t' not in ch[k]:
                    ch[k]['_t'] = B.u16(ch[k]['t'])
                    ch[k]['_v'] = (B.i16(ch[k]['v']) if ch[k]['q']
                                   else B.f32(ch[k]['v'])).astype(float)
                    ch[k]['_s'] = 1/32767.0 if ch[k]['q'] else 1.0


def gather(S, B, frame, only=None, room=True, textured=True, texcache=None):
    """One dict per mesh, in world space, for `frame`."""
    texcache = {} if texcache is None else texcache

    def tex(name):
        if not name or not textured:
            return None
        k = name.lower()
        if k not in texcache:
            texcache[k] = decode_tex(S['textures'].get(k))
        return texcache[k]

    prime(S, B)
    parts = []
    seq = 0
    keep, drop = set(), set()
    for tok in (only or '').split(','):
        if tok.startswith('-'):
            drop.add(tok[1:])
        elif tok:
            keep.add(tok)
    for ent in S['entities']:
        if (keep and ent['name'] not in keep) or ent['name'] in drop:
            continue
        if not room and ent['name'] == S['room']:
            continue
        vis = True
        for f, on in ent['visibility']:
            if f <= frame:
                vis = bool(on)
        end = ent.get('end')
        if not vis or frame < ent.get('start', 0) or (end is not None
                                                      and frame >= end):
            continue
        # `[start, key, offset]`: the offset is `0x83`'s start within the
        # clip -- zero everywhere but e001's corpse, which is authored in
        # absolute scene time.  Older pages carry only the first two.
        cur = None
        for c in ent['clips']:
            if c[0] <= frame:
                cur = (c[0], c[1], c[2] if len(c) > 2 else 0)
        clip = S['clips'][cur[1]] if cur else None
        t = frame-cur[0]+cur[2] if cur else 0
        off = ent.get('position') or [0, 0, 0]
        tint = np.array(ent.get('tint') or [1, 1, 1], float)
        # `0xB2` hides a node and what hangs under it: the weapon.
        hidden = set()
        for f, name, shown in ent.get('parts', []):
            if f <= frame:
                (hidden.discard if shown else hidden.add)(name)
        for mk in ent['models']:
            md = S['models'][mk]
            Wm = world_matrices(md, clip, t)
            for mi, me in enumerate(md['meshes']):
                if hidden:
                    n, under = me.get('base', -1), False
                    while 0 <= n < len(md['nodes']) and not under:
                        under = md['nodes'][n]['name'] in hidden
                        n = md['nodes'][n]['parent']
                    if under:
                        continue
                P, N = skin(me, B, Wm, off)
                mat = (md['materials'][me['material']]
                       if me['material'] < len(md['materials'])
                       else {'tex': None, 'diffuse': [200, 200, 200, 255]})
                rng = np.random.RandomState(seq*7919 + 13)
                seq += 1
                # RGBA: rgb is the baked lighting, a is the vertex alpha
                # that MODULATE folds into the fragment (`A = At*Av >> 7`).
                # It is 0x80 = 1.0 almost everywhere, but not on rp11's lamp
                # glow (0x38 = 0.44), which is 2.3x too hot without it.
                col = None
                if me.get('col'):
                    col = B.u8(me['col']).reshape(-1, 4).astype(float)/255.0
                parts.append({
                    'V': P, 'N': N, 'col': col,
                    'lit': bool(me.get('lit', 1)),
                    'blend': mat.get('mode') in ('blend', 'add'),
                    'add': mat.get('mode') == 'add',
                    'atest': bool(mat.get('atest', 1)),
                    'F': B.u16(me['idx']).reshape(-1, 3).astype(np.int64),
                    'uv': B.f32(me['uv']).reshape(-1, 2).astype(float),
                    'tex': tex(mat['tex']), 'texname': mat['tex'],
                    # FRAG builds `diffuse` as vec4(rgb/255, 1.0): the .SMI
                    # material alpha is 128 ("1.0" in GS units) and would fail
                    # the 120/255 alpha test if taken literally.
                    'diffuse': np.append(
                        np.array(mat['diffuse'][:3], float)/255.0, 1.0),
                    'tint': tint, 'ent': ent['name'], 'model': mk,
                    'mesh': mi, 'mat': me['material'],
                    'idcol': rng.uniform(0.25, 1.0, 3)})
    return parts


def camera_at(S, B, frame):
    cam = S['camera']
    n = int(min(max(frame, 1), cam['frames']))-1
    return (B.f32(cam['position'])[n*3:n*3+3].astype(float),
            B.f32(cam['target'])[n*3:n*3+3].astype(float),
            float(B.f32(cam['fov'])[n]), float(B.f32(cam['roll'])[n]))


# ---------------------------------------------------------------------- stats
def stats(S, B, frames, opt):
    """Where every unit of light in the frame actually comes from.

    A term that is a large share and does not vary is a fudge factor, not a
    light.  This is what caught the doubled ambient and the additive lift.
    """
    rig = Rig(S, opt)
    print('ambient      %s' % np.round(rig.amb, 3))
    print('directional  %s  dir %s' % (np.round(rig.dirC, 3), np.round(rig.dirD, 3)))
    for i, (c, p, r, par) in enumerate(rig._pts):
        print('point%d       %s  %s %s  range %s'
              % (i, np.round(c, 3), 'cam-offset' if par else 'pos',
                 np.round(p, 1), np.round(r, 1)))
    print('fog          %s' % (rig.fog,))
    print('exposure     %s' % ('legacy +%.2f lift' % LEGACY_LIFT if opt.legacy
                               else '%.2f' % opt.exposure))
    for fr in frames:
        eye, tgt, fov, roll = camera_at(S, B, fr)
        rig.place(eye, look_at(eye, tgt, roll))
        parts = gather(S, B, fr, textured=False)
        V = np.vstack([p['V'] for p in parts])
        N = np.vstack([p['N'] for p in parts])
        N = N/np.maximum(np.linalg.norm(N, axis=1, keepdims=True), 1e-9)
        fwd = tgt-eye
        fwd /= np.linalg.norm(fwd)
        m = ((V-eye) @ fwd > 0.5) & ((V-eye) @ fwd < 200)
        V, N = V[m], N[m]
        terms = {'ambient': np.tile(rig.amb, (len(V), 1)),
                 'directional': rig.dirC*np.clip(N @ rig.dirD, 0, None)[:, None]}
        for i, (c, p, r) in enumerate(rig.pts):
            dd = p-V
            L = np.linalg.norm(dd, axis=1)
            att = 1-smoothstep(r[0], max(r[1], r[0]+0.001), L)
            nd = np.clip(np.einsum('vi,vi->v', N, dd/np.maximum(L, 1e-9)[:, None]), 0, None)
            terms['point%d' % i] = c*(nd*att)[:, None]
        if opt.legacy:
            terms['flat lift'] = np.full((len(V), 3), LEGACY_LIFT)
        tot = sum(terms.values())
        print('\nframe %g  (%d vertices in view)' % (fr, len(V)))
        for k, v in terms.items():
            print('  %-12s mean %.3f   share %5.1f%%' % (k, v.mean(), 100*v.mean()/tot.mean()))
        print('  %-12s mean %.3f   range %.3f .. %.3f  (%.1f:1)'
              % ('TOTAL', tot.mean(), tot.min(), tot.max(),
                 tot.max()/max(tot.min(), 1e-6)))


def _size(s):
    """`--size 640` is square; `--size 640x448` gives the game's 4:3 frame."""
    if 'x' in str(s):
        w, h = str(s).split('x')
        return (int(w), int(h))
    return (int(s), int(s))


# ----------------------------------------------------------------------- main
def main():
    a = sys.argv[1:]
    if not a:
        print(__doc__)
        return 1

    def opt(k, d=None):
        return a[a.index(k)+1] if k in a else d

    path = a[0]
    frame = float(a[1])
    S, blob = load(path)
    B = Bin(blob)
    o = Opts(legacy='--legacy' in a,
             exposure=float(opt('--exp')) if opt('--exp') else None,
             ambient=float(opt('--amb')) if opt('--amb') else None,
             dird=[float(x) for x in opt('--dird').split(',')] if opt('--dird') else None,
             cutout=float(opt('--cut', CUTOUT)),
             fog='--no-fog' not in a,
             cull=int(opt('--cull', 0)),
             bilinear='--nearest' not in a)

    if '--stats' in a:
        stats(S, B, [frame] + [float(x) for x in a[3:] if x.replace('.', '').isdigit()], o)
        return 0

    out = a[2]
    parts = gather(S, B, frame, only=opt('--only'), room='--no-room' not in a,
                   textured='--flat' not in a)
    eye, tgt, fov, roll = camera_at(S, B, frame)
    if opt('--cam'):
        e, t = opt('--cam').split(':')
        eye = np.array([float(x) for x in e.split(',')])
        tgt = np.array([float(x) for x in t.split(',')])
    if opt('--fov'):
        fov = float(opt('--fov'))
    rig = Rig(S, o)
    print('%s frame %g: %d parts, %d triangles%s' % (
        S['name'], frame, len(parts), sum(len(p['F']) for p in parts),
        '  [legacy shader]' if o.legacy else ''))
    print('  camera %s -> %s, fov %.1f' % (tuple(np.round(eye, 2).tolist()),
                                           tuple(np.round(tgt, 2).tolist()),
                                           fov))
    img = render(parts, eye, tgt, fov, roll, rig, _size(opt('--size', '640')),
                 opt('--mode', 'shaded'))
    if opt('--mode', 'shaded') == 'shaded':
        img = overlay(img, S, frame, subs='--no-subs' not in a,
                      bars='--no-bars' not in a)
    img.save(out)
    print('wrote', out)
    return 0


if __name__ == '__main__':
    sys.exit(main())
