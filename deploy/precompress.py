"""Write .gz (and .br, if brotli is installed) sidecars next to the site.

    python deploy/precompress.py <site-dir> [--force]

Caddy's `precompressed br gzip` and nginx's `gzip_static on` serve these
instead of compressing on every request, which matters here because a cutscene
bundle is 6-18 MB of base64 and there are 149 of them.  Measured on the full
build: `scene.js` gzips to about 55% of its size, so the whole site goes from
0.89 GB to roughly 0.5 GB on the wire.

Cloudflare Pages compresses on its own, so this is only for the self-hosted
and Docker routes.  It only ever adds files -- nothing is deleted or replaced.
"""
import os
import gzip
import sys
import time

COMPRESS = ('.js', '.html', '.json', '.css', '.svg', '.txt')
MIN_BYTES = 1024

try:
    import brotli
except ImportError:                       # optional; gzip alone is most of it
    brotli = None


def sidecars(root, force=False):
    made, saved, total = [], 0, 0
    for dirpath, _, filenames in os.walk(root):
        for name in filenames:
            if name.endswith(('.gz', '.br')) or os.path.splitext(name)[1] not in COMPRESS:
                continue
            path = os.path.join(dirpath, name)
            size = os.path.getsize(path)
            if size < MIN_BYTES:
                continue
            raw = None
            for ext, encode in (('.gz', _gzip), ('.br', _brotli)):
                if encode is None:
                    continue
                out = path + ext
                if not force and _fresh(out, path):
                    total += size
                    saved += size - os.path.getsize(out)
                    continue
                if raw is None:
                    with open(path, 'rb') as f:
                        raw = f.read()
                blob = encode(raw)
                if len(blob) >= size:      # incompressible: do not ship a sidecar
                    continue
                with open(out, 'wb') as f:
                    f.write(blob)
                made.append(out)
                if ext == '.gz':
                    total += size
                    saved += size - len(blob)
    return made, total, saved


def _fresh(sidecar, source):
    return (os.path.exists(sidecar)
            and os.path.getmtime(sidecar) >= os.path.getmtime(source))


def _gzip(raw):
    # mtime=0 so a rebuild of identical bytes produces an identical sidecar
    return gzip.compress(raw, 9, mtime=0)


def _brotli(raw):
    return brotli.compress(raw, quality=10) if brotli else None


_brotli = _brotli if brotli else None


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('-')]
    if not args:
        print(__doc__)
        return 1
    root = args[0]
    if not os.path.isdir(root):
        print('not a directory: %s' % root)
        return 1
    t0 = time.time()
    made, total, saved = sidecars(root, force='--force' in sys.argv)
    print('%d sidecars in %.1fs%s' % (len(made), time.time() - t0,
                                      '' if brotli else '  (no brotli module: gzip only)'))
    if total:
        print('%.2f GB compressible -> %.2f GB gzipped (%.0f%%)'
              % (total / 1e9, (total - saved) / 1e9, 100 * (total - saved) / total))
    return 0


if __name__ == '__main__':
    sys.exit(main())
