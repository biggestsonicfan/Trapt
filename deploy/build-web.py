#!/usr/bin/env python3
"""Assemble the ISO-driven page into a directory a static server can root at.

    python3 deploy/build-web.py _site

This is what .github/workflows/pages.yml publishes to GitHub Pages.

tools/web/pick.html is written to be opened straight from a checkout, so it
loads three.js as ../vendor/three.min.js and sits beside its own test suites.
Neither is right for a served tree.  This flattens it:

    index.html          pick.html, with the script tags rewritten
    <name>.<hash>.js    every module the page actually loads
    vendor/three.<hash>.min.js

The content hash in each filename is the point.  Nothing here is versioned, so
without it the only safe cache policy is revalidate-everything; with it every
script is immutable and only index.html -- 40 KB, and the sole file naming the
others -- ever needs revalidating.  A deploy changes the names of exactly the
files whose bytes changed.

Only the scripts pick.html names are copied.  The test suites, stub_three.js
and anything else in tools/web stay behind, which is what keeps the served
tree at ~880 KB.

The page's one inline <script> is hashed into a CSP meta tag as well, so the
policy travels with the file instead of living in a server config that has to
be kept in step with it.  GitHub Pages sets no headers of ours at all, so the
referrer policy goes in a meta tag beside it.  Every path stays relative, which
is what lets the same tree serve from a project URL (/Trapt/) or a domain root.
"""

import argparse
import base64
import hashlib
import os
import re
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

SCRIPT_TAG = re.compile(r'<script src="([^"]+)"></script>')
INLINE = re.compile(r'<script>\n(.*?)\n</script>', re.S)

# blob: and data: are the page's own: object URLs for decoded ADX, data URLs
# for textures built in a canvas.  No network origin appears anywhere, because
# the page never fetches anything -- the disc comes from the visitor.
CSP = (
    "default-src 'none'; "
    "script-src 'self' {hashes}; "
    "style-src 'self' 'unsafe-inline'; "
    "img-src 'self' blob: data:; "
    "media-src 'self' blob: data:; "
    "font-src 'self'; "
    "connect-src 'self'; "
    "base-uri 'none'; "
    "form-action 'none'"
)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def hashed_name(rel, data, enabled):
    """three.min.js -> three.1a2b3c4d.min.js, iso.js -> iso.1a2b3c4d.js"""
    if not enabled:
        return rel
    head, tail = os.path.split(rel)
    stem, _, rest = tail.partition('.')
    short = digest(data)[:8]
    return os.path.join(head, '%s.%s.%s' % (stem, short, rest)).replace('\\', '/')


def build(out, source, hashing, prune):
    page = os.path.join(source, 'pick.html')
    if not os.path.exists(page):
        sys.exit('no such page: %s' % page)
    html = open(page, encoding='utf-8').read()

    srcs = SCRIPT_TAG.findall(html)
    if not srcs:
        sys.exit('%s names no scripts -- has the markup changed?' % page)

    written = {}          # path relative to out -> bytes
    rewrites = {}         # original src -> new src

    for src in srcs:
        origin = os.path.normpath(os.path.join(source, src))
        if not os.path.exists(origin):
            sys.exit('%s loads %s, which does not exist (%s)' % (page, src, origin))
        data = open(origin, 'rb').read()
        # ../vendor/three.min.js lands under vendor/, everything else flat
        rel = 'vendor/' + os.path.basename(src) if src.startswith('../vendor/') \
            else os.path.basename(src)
        rel = hashed_name(rel, data, hashing)
        written[rel] = data
        rewrites[src] = rel

    out_html = SCRIPT_TAG.sub(
        lambda m: '<script src="%s"></script>' % rewrites[m.group(1)], html)

    inline = INLINE.findall(out_html)
    if len(inline) != 1:
        sys.exit('expected exactly one inline <script>, found %d' % len(inline))
    # The hash covers the element's exact text, newlines included, which is why
    # it is taken after the rewrites rather than before.
    b64 = base64.b64encode(hashlib.sha256(
        ('\n' + inline[0] + '\n').encode('utf-8')).digest()).decode()
    meta = '<meta http-equiv="Content-Security-Policy" content="%s">\n' % \
        CSP.format(hashes="'sha256-%s'" % b64)
    meta += '<meta name="referrer" content="no-referrer">\n'
    if '<meta charset="utf-8">\n' not in out_html:
        sys.exit('no charset meta to anchor the CSP to')
    out_html = out_html.replace('<meta charset="utf-8">\n',
                                '<meta charset="utf-8">\n' + meta, 1)
    written['index.html'] = out_html.encode('utf-8')

    os.makedirs(os.path.join(out, 'vendor'), exist_ok=True)
    for rel, data in sorted(written.items()):
        path = os.path.join(out, rel)
        if os.path.exists(path) and open(path, 'rb').read() == data:
            continue
        with open(path, 'wb') as fh:
            fh.write(data)

    if prune:
        # Only ever files this script would itself have written, one at a
        # time, named as they go.  Never a recursive delete.
        for base in ('', 'vendor'):
            d = os.path.join(out, base) if base else out
            for name in sorted(os.listdir(d)):
                rel = (base + '/' + name) if base else name
                full = os.path.join(d, name)
                if not os.path.isfile(full):
                    continue
                if rel in written:
                    continue
                if name.endswith('.js') or name == 'index.html':
                    os.remove(full)
                    print('  pruned %s' % rel)

    verify(out, written)
    total = sum(len(v) for v in written.values())
    print('%d files, %.0f KB -> %s' % (len(written), total / 1024.0, out))
    print('  %s' % ', '.join(sorted(k for k in written if k != 'index.html'))[:200])
    return 0


def verify(out, written):
    """Re-read what was written and check the page can actually load."""
    index = os.path.join(out, 'index.html')
    html = open(index, encoding='utf-8').read()
    for src in SCRIPT_TAG.findall(html):
        if src.startswith(('/', 'http')) or '..' in src:
            sys.exit('index.html escapes the served root: %s' % src)
        if not os.path.exists(os.path.join(out, src)):
            sys.exit('index.html loads %s, which was not written' % src)
    if 'Content-Security-Policy' not in html:
        sys.exit('the CSP meta went missing')
    for rel, data in written.items():
        got = open(os.path.join(out, rel), 'rb').read()
        if got != data:
            sys.exit('%s on disk differs from what was built' % rel)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('out', help='directory to write the served tree into')
    ap.add_argument('--source', default=os.path.join(ROOT, 'tools', 'web'),
                    help='where pick.html and its modules live')
    ap.add_argument('--no-hash', action='store_true',
                    help='keep plain filenames; easier to debug, needs a '
                         'revalidating cache policy')
    ap.add_argument('--prune', action='store_true',
                    help='remove .js/index.html in the output that this build '
                         'did not write, such as the previous build\'s hashes')
    a = ap.parse_args()
    return build(a.out, a.source, not a.no_hash, a.prune)


if __name__ == '__main__':
    sys.exit(main())
