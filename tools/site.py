"""Build every cutscene into one deployable static site.

    python site.py site                       every cutscene, one worker
    python site.py site --jobs 8              in parallel
    python site.py site --jobs 8 --posters    with a still per cutscene
    python site.py site --only e001,e404_03   just these
    python site.py site --resume              skip what is already built
    python site.py site --serve 8000          build, then serve it locally

`export.py` writes one cutscene.  This writes all 149 into a directory that
can be dropped on any static host or opened straight off disk:

    site/
      index.html        the gallery, generated from manifest.json
      script.html       every line of dialogue, in story order
      order.js          the playlist: story order, from the ELF (order.py)
      three.min.js      one copy, shared by every page
      manifest.json     what got built, and every warning it raised
      e001/index.html   the player, pointing at ../three.min.js and ../order.js
      e001/scene.js     that cutscene's data
      e001/poster.png   optional still, with `--posters`

The gallery is laid out in the order the game itself plays the cutscenes --
chapter by chapter, then the endings -- and `order.js` hands that same order to
every player page, which is what makes its prev/next buttons and **Auto** (play
the whole game in order, hands off) work.

Everything is relative, so the site works from a subdirectory and over
`file://` as well as over HTTP.

Budget for it: a cutscene is 15-20 MB with audio, so the whole set is around
2.5 GB and takes about an hour on one core.  `--jobs` divides that almost
linearly (the expensive part is ffmpeg, one process per voice clip), and
`--no-audio` cuts the size roughly in half.
"""
import concurrent.futures as futures
import html
import json
import os
import subprocess
import sys
import time

import export as export_mod
import region as region_mod

HERE = os.path.dirname(os.path.abspath(__file__))
POSTER_SIZE = '384x168'          # the 512x224 shape, small enough for a grid

_DISC = None


def _disc():
    """One `Disc` per worker process -- GAME.DAT is mapped, not read."""
    global _DISC
    if _DISC is None:
        import scene as scene_mod
        _DISC = scene_mod.Disc()
    return _DISC


# ------------------------------------------------------------------ one scene

def build_one(args):
    """Export `name` into `outdir`.  Runs in a worker; must not raise."""
    name, outdir, opts = args
    t0 = time.time()
    try:
        info = export_mod.build(
            name, outdir, disc=_disc(), verbose=False,
            three_href='../three.min.js', order_href='../order.js',
            audio=opts['audio'], jpeg_quality=opts['quality'],
            bitrate=opts['bitrate'], bgm_bitrate=opts['bgm_bitrate'])
    except Exception as e:                       # a bad scene must not stop 148
        return {'name': name, 'error': '%s: %s' % (type(e).__name__, e),
                'seconds': round(time.time() - t0, 1)}
    if opts['posters']:
        info['poster'] = _poster(outdir, info)
    info['seconds'] = round(time.time() - t0, 1)
    return info


def _poster(outdir, info):
    """Rasterise one frame with `pdiag.py`, which reads the bundle we wrote.

    `pdiag.load()` only looks for `window.TRAPT_SCENE=`, so it takes the
    bundle's `scene.js` directly -- no need to also emit a single-file page.
    The frame is the first cue, so the still carries a line of dialogue on the
    letterbox rather than an empty room.
    """
    name = info['name']
    dest = os.path.join(outdir, name, 'poster.png')
    src = os.path.join(outdir, name, 'scene.js')
    cmd = [sys.executable, os.path.join(HERE, 'pdiag.py'), src,
           str(info['opening_frame']), dest, '--size', POSTER_SIZE]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True)
    except OSError as e:
        return {'error': str(e)}
    if r.returncode or not os.path.exists(dest):
        return {'error': (r.stderr or r.stdout or 'pdiag failed').strip()[-200:]}
    info['bytes'] += os.path.getsize(dest)
    info['files'].append('%s/poster.png' % name)
    return '%s/poster.png' % name


# ---------------------------------------------------------------- the gallery

CSS = """
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: #0b0b0d; color: #e8e6e3;
    font: 13px/1.5 ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif; }
  header { padding: 26px 24px 14px; border-bottom: 1px solid #26262b;
    position: sticky; top: 0; background: #0b0b0dee; backdrop-filter: blur(6px);
    z-index: 2; }
  h1 { margin: 0 0 4px; font-size: 19px; font-weight: 600;
    letter-spacing: .02em; }
  header p { margin: 0; opacity: .55; }
  #tools { display: flex; gap: 10px; align-items: center; margin-top: 12px;
    flex-wrap: wrap; }
  input[type=search] { flex: 1; min-width: 220px; background: #16161a;
    border: 1px solid #2e2e36; border-radius: 6px; padding: 7px 10px;
    color: inherit; font: inherit; }
  input[type=search]:focus { outline: none; border-color: #4a72ad; }
  #count { opacity: .5; font-variant-numeric: tabular-nums; }
  a.btn { text-decoration: none; color: inherit; background: #3a5a8a;
    border: 1px solid #4a72ad; border-radius: 6px; padding: 7px 12px; }
  a.btn.plain { background: #232329; border-color: #34343c; }
  a.btn:hover { filter: brightness(1.15); }
  main { padding: 20px 24px 60px; }
  section { margin: 0 0 26px; }
  section[hidden] { display: none; }
  section h2 { margin: 0 0 10px; font-size: 12px; font-weight: 600;
    letter-spacing: .12em; text-transform: uppercase; opacity: .45; }
  .grid { display: grid; gap: 14px;
    grid-template-columns: repeat(auto-fill, minmax(268px, 1fr)); }
  a.card { display: block; text-decoration: none; color: inherit;
    background: #131316; border: 1px solid #26262b; border-radius: 9px;
    overflow: hidden; transition: border-color .15s, transform .15s; }
  a.card:hover { border-color: #4a72ad; transform: translateY(-2px); }
  .shot { display: block; width: 100%; aspect-ratio: 512 / 224;
    background: #000 center/cover no-repeat; }
  .body { padding: 10px 12px 12px; }
  .name { font-weight: 600; letter-spacing: .04em; }
  .meta { opacity: .5; font-variant-numeric: tabular-nums; font-size: 12px;
    display: flex; gap: 8px; flex-wrap: wrap; margin-top: 2px; }
  .line { margin-top: 7px; opacity: .8; font-size: 12px; min-height: 2.6em;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
    overflow: hidden; }
  .cast { margin-top: 7px; font-size: 11px; opacity: .45; letter-spacing: .03em;
    text-transform: uppercase; white-space: nowrap; overflow: hidden;
    text-overflow: ellipsis; }
  .warn { color: #d8b06a; }
  footer { padding: 0 24px 40px; opacity: .4; font-size: 12px; }
"""

JS = """
  const q = document.getElementById('q');
  const cards = [...document.querySelectorAll('a.card')];
  const count = document.getElementById('count');
  const sections = [...document.querySelectorAll('section')];
  function filter() {
    const t = q.value.trim().toLowerCase();
    let n = 0;
    for (const c of cards) {
      const on = !t || c.dataset.hay.includes(t);
      c.hidden = !on;
      if (on) n++;
    }
    // a chapter with nothing left in it should take its heading with it
    for (const s of sections)
      s.hidden = ![...s.querySelectorAll('a.card')].some((c) => !c.hidden);
    count.textContent = n + ' of ' + cards.length;
  }
  q.addEventListener('input', filter);
  filter();
"""


def _mmss(frames, fps):
    s = int(round(frames / float(fps or 60)))
    return '%d:%02d' % (s // 60, s % 60)


def story_sections(story, scenes):
    """`[(title, [(scene, note)])]` in story order, each scene appearing once.

    A cutscene can be listed by more than one ending route, so the first
    section that mentions one keeps it; anything the tables never name at all
    lands in a trailing section rather than being dropped.
    """
    by_name = {s['name']: s for s in scenes}
    seen, out = set(), []
    for sec in story.sections():
        rows = []
        for it in sec['items']:
            n = it.get('name')
            if it['kind'] != 'cutscene' or n in seen or n not in by_name:
                continue
            seen.add(n)
            rows.append((by_name[n], it['note']))
        if rows:
            out.append((sec['title'], rows))
    left = [(s, '') for s in scenes if s['name'] not in seen]
    if left:
        out.append(('Not in any table', left))
    return out


def _card(s, note):
    """One gallery tile.  `note` is where the game plays it (order.py)."""
    name = s['name']
    if s.get('error'):
        return ('<a class="card" href="#" data-hay="%s"><div class="body">'
                '<div class="name">%s</div>'
                '<div class="line warn">%s</div></div></a>'
                % (html.escape(name), html.escape(name),
                   html.escape(s['error'])))
    if isinstance(s.get('poster'), str):
        shot = ('<span class="shot" style="background-image:url(%s)"></span>'
                % html.escape(s['poster']))
    else:
        shot = '<span class="shot"></span>'
    cast = ', '.join(s.get('speakers') or [])
    meta = ['%s' % _mmss(s['duration'], s.get('fps', 60)),
            '%d cues' % s.get('subtitles', 0)]
    if s.get('room'):
        meta.append(html.escape(s['room']))
    if note:
        meta.append(html.escape(note))
    if s.get('bytes'):
        meta.append('%.0f MB' % (s['bytes'] / 1e6))
    if s.get('warnings'):
        meta.append('<span class="warn">%d warning%s</span>'
                    % (len(s['warnings']),
                       '' if len(s['warnings']) == 1 else 's'))
    hay = ' '.join([name, s.get('room') or '', cast, note,
                    s.get('opening') or '']).lower()
    return ('<a class="card" href="%s/index.html" data-hay="%s">%s'
            '<div class="body"><div class="name">%s</div>'
            '<div class="meta">%s</div>'
            '<div class="line">%s</div>'
            '<div class="cast">%s</div></div></a>'
            % (html.escape(name), html.escape(hay), shot, html.escape(name),
               ' &middot; '.join(meta),
               html.escape(s.get('opening') or ''),
               html.escape(cast) or '&nbsp;'))


def write_index(outdir, scenes, opts, story):
    """The gallery, straight from the manifest -- no build step, no CDN.

    Laid out in the order the game plays them (`tools/order.py`) rather than
    alphabetically, so reading top to bottom is reading the story.
    """
    ok = [s for s in scenes if not s.get('error')]
    total = sum(s.get('bytes', 0) for s in ok)
    body = []
    for title, rows in story_sections(story, scenes):
        body.append('<section><h2>%s</h2><div class="grid">%s</div></section>'
                    % (html.escape(title),
                       '\n'.join(_card(s, note) for s, note in rows)))
    order = [s['name'] for _, rows in story_sections(story, ok)
             for s, _ in rows]
    first = order[0] if order else None
    play = ''
    if first:
        play = ('<a class="btn" href="%s/index.html?story=new">Story mode</a>'
                '<a class="btn plain" href="%s/index.html?auto=1">Play in order</a>'
                % (html.escape(first), html.escape(first)))

    page = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Trapt cutscenes</title>
<style>%s</style>
</head>
<body>
<header>
  <h1>Trapt &mdash; cutscenes</h1>
  <p>%d of %d exported, %.1f GB, in the order the game plays them. Each opens
     in the WebGL player: PS2 mode reproduces the GS, the letterbox and the
     game's own subtitle font. <b>Story mode</b> runs the game's own chapter
     machine and asks you, wherever the retail game would have asked a stage or
     a menu, which way the story goes.</p>
  <div id="tools">
    <input id="q" type="search" placeholder="filter by id, room, speaker or line"
           autocomplete="off" spellcheck="false">
    <span id="count"></span>
    %s
    <a class="btn plain" href="script.html">Script</a>
  </div>
</header>
<main>
%s
</main>
<footer>Built %s from %s by tools/site.py. Order from the ELF by
tools/order.py. Audio %s.</footer>
<script>%s</script>
</body>
</html>
""" % (CSS, len(ok), len(scenes), total / 1e9, play, '\n'.join(body),
       time.strftime('%Y-%m-%d'), region_mod.active().serial,
       'included' if opts['audio'] else 'omitted', JS)
    path = os.path.join(outdir, 'index.html')
    with open(path, 'w', encoding='utf-8') as f:
        f.write(page)
    return path


SCRIPT_CSS = """
  main { padding: 20px 24px 60px; max-width: 980px; }
  section h2 { margin: 26px 0 10px; font-size: 12px; font-weight: 600;
    letter-spacing: .12em; text-transform: uppercase; opacity: .45; }
  .scene { margin: 0 0 20px; }
  .scene h3 { margin: 0 0 6px; font-size: 13px; font-weight: 600;
    letter-spacing: .04em; }
  .scene h3 a { color: inherit; text-decoration: none; }
  .scene h3 a:hover { color: #8fb0e0; }
  .scene h3 span { font-weight: 400; opacity: .45; letter-spacing: 0; }
  table { border-collapse: collapse; width: 100%; }
  td { padding: 2px 10px 2px 0; vertical-align: top; border-top: 1px solid #1c1c21; }
  td.f { opacity: .35; font-variant-numeric: tabular-nums; white-space: nowrap;
    width: 1%; }
  td.s { color: #d8b06a; white-space: nowrap; width: 1%; }
  td.l { white-space: pre-line; }
"""


def write_order(outdir, story):
    """`order.js` -- the playlist every exported page reads.

    Built from what is actually in `outdir`, so a `--only` or half-finished
    run still gets a playlist that never navigates to a missing page.
    """
    have = {d for d in os.listdir(outdir)
            if os.path.isfile(os.path.join(outdir, d, 'index.html'))}
    names = story.playlist(have)
    path = os.path.join(outdir, 'order.js')
    with open(path, 'w', encoding='utf-8') as f:
        f.write('// The order the game itself plays these in, lifted out of\n'
                '// the chapter and ending tables in %s by tools/order.py.\n'
                % region_mod.active().serial +
                '// TRAPT_ORDER is the flat playlist; TRAPT_STORY is the same\n'
                '// tables unflattened, which is what story mode walks.\n'
                'window.TRAPT_ORDER=%s;\n' % json.dumps(names))
        f.write('window.TRAPT_STORY=%s;\n'
                % json.dumps(story.tables(have), separators=(',', ':')))
    return names


HEADERS = """\
# Cache policy for Cloudflare Pages / Netlify (`_headers` format).  Written by
# tools/site.py; see ../docs/DEPLOY.md.  A cutscene bundle is immutable for a
# given build but keeps its name across rebuilds, so it gets a week with an
# ETag rather than `immutable`; the pages that change every build revalidate.
/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer

/index.html
  Cache-Control: public, max-age=300, must-revalidate
/script.html
  Cache-Control: public, max-age=300, must-revalidate
/order.js
  Cache-Control: public, max-age=300, must-revalidate
/manifest.json
  Cache-Control: public, max-age=300, must-revalidate

/three.min.js
  Cache-Control: public, max-age=604800
/:scene/scene.js
  Cache-Control: public, max-age=604800
/:scene/poster.png
  Cache-Control: public, max-age=604800
/:scene/index.html
  Cache-Control: public, max-age=3600
"""


def write_headers(outdir):
    """`_headers` -- picked up by Cloudflare Pages and Netlify, ignored elsewhere."""
    path = os.path.join(outdir, '_headers')
    with open(path, 'w', encoding='utf-8') as f:
        f.write(HEADERS)
    return path


def write_script(outdir, story, scenes):
    """`script.html` -- every line of dialogue in the game, in story order."""
    import order as order_mod
    disc = _disc()
    have = {s['name'] for s in scenes if not s.get('error')}
    body, cues, played = [], 0, 0
    for title, rows in story_sections(story, scenes):
        block = []
        for s, note in rows:
            if s['name'] not in have:
                continue
            lines = order_mod.dialogue(s['name'], disc)
            if not lines:
                continue
            played += 1
            cues += len(lines)
            block.append(
                '<div class="scene"><h3><a href="%s/index.html">%s</a> '
                '<span>%s</span></h3><table>%s</table></div>'
                % (html.escape(s['name']), html.escape(s['name']),
                   html.escape(note),
                   ''.join('<tr><td class="f">%d</td><td class="s">%s</td>'
                           '<td class="l">%s</td></tr>'
                           % (frame, html.escape(speaker or ''),
                              html.escape('\n'.join(text)))
                           for frame, speaker, text, _ in lines)))
        if block:
            body.append('<section><h2>%s</h2>%s</section>'
                        % (html.escape(title), '\n'.join(block)))

    page = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Trapt script</title>
<style>%s%s</style>
</head>
<body>
<header>
  <h1>Trapt &mdash; the script</h1>
  <p>%d cues across %d cutscenes, in story order. Frame numbers are the scene
     VM's own, so they line up with the player's counter.</p>
  <div id="tools"><a class="btn plain" href="index.html">Back to the gallery</a></div>
</header>
<main>
%s
</main>
<footer>Recovered from the <code>.SSC</code> text tracks by tools/ssc.py,
ordered by tools/order.py.</footer>
</body>
</html>
""" % (CSS, SCRIPT_CSS, cues, played, '\n'.join(body))
    path = os.path.join(outdir, 'script.html')
    with open(path, 'w', encoding='utf-8') as f:
        f.write(page)
    return cues, played


# ------------------------------------------------------------------- the site

def build_site(outdir, names, opts):
    os.makedirs(outdir, exist_ok=True)
    import shutil
    shutil.copyfile(os.path.join(HERE, 'vendor', 'three.min.js'),
                    os.path.join(outdir, 'three.min.js'))

    done = {}
    manifest = os.path.join(outdir, 'manifest.json')
    if opts['resume'] and os.path.exists(manifest):
        try:
            with open(manifest, encoding='utf-8') as f:
                for s in json.load(f)['scenes']:
                    done[s['name']] = s
        except (ValueError, KeyError):
            pass

    todo = []
    for n in names:
        built = done.get(n)
        if (opts['resume'] and built and not built.get('error')
                and os.path.exists(os.path.join(outdir, n, 'scene.js'))
                and (not opts['posters'] or isinstance(built.get('poster'), str))):
            continue
        todo.append(n)

    print('%d cutscenes, %d to build%s, %d job%s'
          % (len(names), len(todo),
             ' (%d already done)' % (len(names) - len(todo))
             if len(todo) != len(names) else '',
             opts['jobs'], '' if opts['jobs'] == 1 else 's'))
    if not todo:
        print('nothing to do')

    t0 = time.time()
    work = [(n, outdir, opts) for n in todo]
    results = []
    if opts['jobs'] > 1 and len(work) > 1:
        with futures.ProcessPoolExecutor(max_workers=opts['jobs']) as pool:
            for i, info in enumerate(pool.map(build_one, work), 1):
                results.append(info)
                _report(i, len(work), info)
    else:
        for i, item in enumerate(work, 1):
            info = build_one(item)
            results.append(info)
            _report(i, len(work), info)

    for info in results:
        done[info['name']] = info
    scenes = [done[n] for n in names if n in done]

    with open(manifest, 'w', encoding='utf-8') as f:
        json.dump({'built': time.strftime('%Y-%m-%dT%H:%M:%S'),
                   'audio': opts['audio'], 'posters': opts['posters'],
                   'scenes': scenes}, f, indent=1)

    import order as order_mod
    story = order_mod.Story()
    order = write_order(outdir, story)
    write_index(outdir, scenes, opts, story)
    write_headers(outdir)
    cues, spoken = write_script(outdir, story, scenes)
    print('\nplaylist: %d cutscenes in story order, starting at %s'
          % (len(order), order[0] if order else '-'))
    print('script:   %d cues across %d cutscenes' % (cues, spoken))

    bad = [s for s in scenes if s.get('error')]
    warn = sum(len(s.get('warnings') or []) for s in scenes)
    total = sum(s.get('bytes', 0) for s in scenes)
    print('\n%s: %d scene%s, %.2f GB, %d warning%s, %d failure%s in %s'
          % (outdir, len(scenes), '' if len(scenes) == 1 else 's', total / 1e9,
             warn, '' if warn == 1 else 's',
             len(bad), '' if len(bad) == 1 else 's', _dur(time.time() - t0)))
    for s in bad:
        print('  ! %-10s %s' % (s['name'], s['error']))
    return scenes


def _report(i, n, info):
    if info.get('error'):
        print('  [%3d/%d] %-10s FAILED  %s' % (i, n, info['name'], info['error']))
        return
    print('  [%3d/%d] %-10s %6.1f MB  %5s  %2d cues%s  %ss'
          % (i, n, info['name'], info.get('bytes', 0) / 1e6,
             _mmss(info['duration'], info.get('fps', 60)),
             info.get('subtitles', 0),
             '  ! %d' % len(info['warnings']) if info.get('warnings') else '',
             info.get('seconds', 0)))


def _dur(s):
    return '%dm %02ds' % (int(s) // 60, int(s) % 60) if s >= 60 else '%.1fs' % s


def main():
    a = sys.argv[1:]
    if not a or a[0] in ('-h', '--help'):
        print(__doc__)
        return 1

    def opt(k, d=None):
        return a[a.index(k) + 1] if k in a else d

    outdir = a[0]
    names = export_mod.list_cutscenes()
    if opt('--only'):
        want = [x.strip().lower() for x in opt('--only').split(',') if x.strip()]
        names = [n for n in names if n in want or
                 any(n.startswith(w) for w in want)]
        missing = [w for w in want
                   if not any(n == w or n.startswith(w) for n in names)]
        for w in missing:
            print('! no cutscene matches %r' % w)
    if opt('--skip'):
        drop = [x.strip().lower() for x in opt('--skip').split(',') if x.strip()]
        names = [n for n in names if not any(n.startswith(d) for d in drop)]
    if opt('--limit'):
        names = names[:int(opt('--limit'))]
    if not names:
        print('nothing selected')
        return 1

    opts = {
        'audio': '--no-audio' not in a,
        'posters': '--posters' in a,
        'resume': '--resume' in a,
        'jobs': int(opt('--jobs', 1)),
        'quality': int(opt('--quality', 88)),
        'bitrate': opt('--bitrate', '64k'),
        'bgm_bitrate': opt('--bgm-bitrate', '96k'),
    }
    build_site(outdir, names, opts)

    if opt('--serve'):
        port = int(opt('--serve'))
        import http.server
        import functools
        handler = functools.partial(http.server.SimpleHTTPRequestHandler,
                                    directory=outdir)
        print('\nserving %s at http://localhost:%d/  (ctrl-c to stop)'
              % (outdir, port))
        try:
            http.server.ThreadingHTTPServer(('', port), handler).serve_forever()
        except KeyboardInterrupt:
            print()
    return 0


if __name__ == '__main__':
    sys.exit(main())
