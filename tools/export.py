"""Export a Trapt cutscene to a standalone HTML player.

    python export.py e001 out/
    python export.py e001 out/ --single      # one self-contained .html
    python export.py --list                  # every cutscene id on the disc

Writes ``out/<name>/`` containing `index.html`, `three.min.js` and `scene.js`.
Everything the page needs is inside those three files -- geometry, animation,
textures and audio are base64 inside `scene.js` -- so it loads straight off the
filesystem with no web server.  ``--single`` folds all three into one file.

Geometry keeps the game's own skinning scheme: `.SMI` stores a vertex once per
influencing bone, pre-scaled by its blend weight, with the weight in the
position's w.  Transforming that homogeneous float4 by the bone matrix scales
the translation row correctly, so the blend is a plain sum and the whole thing
is four lines of vertex shader.
"""
import base64
import io
import json
import os
import struct
import subprocess
import sys
import shutil

import afs
import cam as cam_mod
import sai as sai_mod
import scene as scene_mod
import smi as smi_mod
import tm2 as tm2_mod
import adx as adx_mod

HERE = os.path.dirname(os.path.abspath(__file__))
FPS = 60.0
FFMPEG = os.environ.get('FFMPEG', 'ffmpeg')


def _q15(x):
    """Unit-range float -> s16."""
    return max(-32767, min(32767, int(round(x * 32767.0))))


def _q12(x):
    """.SMI normals are natively s16 at 1/4096; round-trip them losslessly."""
    return max(-32768, min(32767, int(round(x * 4096.0))))


class Buffer:
    """Accumulates typed arrays into one blob, handing back (offset, count)."""

    def __init__(self):
        self.parts = []
        self.size = 0

    def add(self, fmt, values):
        values = list(values)
        if not values:
            return [0, 0]
        data = struct.pack('<%d%s' % (len(values), fmt), *values)
        pad = (-self.size) % 4
        if pad:
            self.parts.append(b'\0' * pad)
            self.size += pad
        off = self.size
        self.parts.append(data)
        self.size += len(data)
        return [off, len(values)]

    def bytes(self):
        return b''.join(self.parts)


# ------------------------------------------------------------------ geometry

def pack_model(model, buf):
    """One `.SMI` -> nodes, meshes and vertex streams inside `buf`."""
    nodes = [{'name': n['name'], 'parent': n['parent'], 'm': [round(v, 6) for v in n['matrix']]}
             for n in model.nodes]
    meshes = []
    for me in model.meshes:
        if me.vcount == 0 or not me.tris:
            continue
        two = me.influences > 1
        lp0, lp1, n0, n1, bidx, uv, col = [], [], [], [], [], [], []
        for v in range(me.vcount):
            p0 = me.pos[v][0] if me.pos else (0.0, 0.0, 0.0, 1.0)
            lp0 += [p0[0], p0[1], p0[2], p0[3]]
            q0 = me.nrm[v][0] if me.nrm else (0.0, 1.0, 0.0)
            n0 += [_q12(q0[0]), _q12(q0[1]), _q12(q0[2])]
            b = me.bones[v] if me.bones else [0]
            bidx += [b[0] if b else 0, (b[1] if len(b) > 1 else 0) if two else 0]
            if two:
                p1 = me.pos[v][1] if me.pos and len(me.pos[v]) > 1 else (0.0, 0.0, 0.0, 0.0)
                lp1 += [p1[0], p1[1], p1[2], p1[3]]
                q1 = me.nrm[v][1] if me.nrm and len(me.nrm[v]) > 1 else (0.0, 0.0, 0.0)
                n1 += [_q12(q1[0]), _q12(q1[1]), _q12(q1[2])]
            t = me.uv[v] if me.uv else (0.0, 0.0)
            uv += [t[0], t[1]]
            if me.col:
                col += list(me.col[v])
        idx = []
        for a, b_, c in me.tris:
            idx += [a, b_, c]
        if me.vcount > 65535:
            continue
        entry = {'material': me.material, 'two': two, 'count': me.vcount,
                 'base': me.base,
                 'lp0': buf.add('f', lp0), 'n0': buf.add('h', n0),
                 'uv': buf.add('f', uv), 'b': buf.add('H', bidx),
                 'idx': buf.add('H', idx),
                 # Environment geometry ships baked vertex colours and no
                 # normals; characters ship normals and no colours.  The flag
                 # tells the shader which half of the GS pipeline to run.
                 'lit': 1 if me.nrm else 0}
        if col:
            entry['col'] = buf.add('B', col)
        if two:
            entry['lp1'] = buf.add('f', lp1)
            entry['n1'] = buf.add('h', n1)
        meshes.append(entry)
    materials = [{'tex': m['texture'],
                  # raw GS bytes: the GS treats 0x80 as 1.0, so the shader
                  # divides by 128, not 255
                  'diffuse': list(m['diffuse_gs']),
                  'colour2': list(m['colour2_gs']),
                  'power': m['power'],
                  'render': m['render'],
                  'mode': ('add' if m['add'] else 'blend') if m['blend']
                          else 'opaque',
                  'atest': 1 if m['atest'] else 0}
                 for m in model.materials]
    return {'nodes': nodes, 'meshes': meshes, 'materials': materials}


def pack_clip(clip, buf):
    nodes = {}
    for node in clip.nodes:
        chans = {}
        for kind, ch in node.channels.items():
            key = ('r', 't', 's')[kind]
            if kind == sai_mod.ROT:
                # unit quaternions -- s16 is ~0.006 degrees of error, well
                # inside the source's own precision, and halves the payload
                vals = []
                for v in ch.values:
                    vals += [_q15(v[0]), _q15(v[1]), _q15(v[2]), _q15(v[3])]
                chans[key] = {'t': buf.add('H', ch.times), 'v': buf.add('h', vals),
                              'q': 1}
            else:
                vals = []
                for v in ch.values:
                    vals += [v[0], v[1], v[2], 1.0]
                chans[key] = {'t': buf.add('H', ch.times), 'v': buf.add('f', vals),
                              'q': 0}
        if chans:
            nodes[node.name] = chans
    return {'duration': clip.duration, 'nodes': nodes}


# ------------------------------------------------------------------ textures

def pack_texture(blob, quality):
    """`.TM2` -> a PNG (or JPEG when fully opaque) data URI."""
    from PIL import Image
    pics = tm2_mod.decode(blob)
    if not pics:
        return None
    w, h, rgba = pics[0]
    img = Image.frombytes('RGBA', (w, h), rgba)
    out = io.BytesIO()
    alpha = img.getchannel('A')
    if alpha.getextrema()[0] >= 250 and quality:
        img.convert('RGB').save(out, 'JPEG', quality=quality, optimize=True)
        mime = 'image/jpeg'
    else:
        img.save(out, 'PNG', optimize=True)
        mime = 'image/png'
    return 'data:%s;base64,%s' % (mime, base64.b64encode(out.getvalue()).decode())


# ---------------------------------------------------------------- the font

def pack_font(subtitles):
    """The glyphs a cutscene's cues need, plus everything to lay them out.

    The atlas is the CLUT already applied, because that is the order the GS
    works in -- it palettises a texel and *then* filters, so a page that
    filters palettised RGBA reproduces the dark fringe on a glyph edge that
    filtering coverage and palettising afterwards would not.
    """
    import font as font_mod
    from PIL import Image
    fo = font_mod.Font()
    seen, glyphs = {}, []
    for s in subtitles:
        for ch in s.raw:
            if ch in seen:
                continue
            code = font_mod.sjis_of(ch)
            seen[ch] = code if code is not None and fo.has(code) else None
            if seen[ch] is not None:
                glyphs.append(seen[ch])
    if not glyphs:
        return None
    cols = 16
    pad = 1
    w, h, rgba, slots = fo.atlas(glyphs, cols=cols, pad=pad)
    out = io.BytesIO()
    Image.frombytes('RGBA', (w, h), rgba).save(out, 'PNG', optimize=True)
    # keyed by Unicode code point so the page needs no Shift-JIS table
    table = {}
    for ch, code in seen.items():
        if code is not None:
            table[ord(ch)] = [slots[code], fo.advance(code)]
    return {
        'atlas': 'data:image/png;base64,%s' % base64.b64encode(out.getvalue()).decode(),
        'size': [w, h], 'cols': cols, 'cell': list(fo.cell), 'pad': pad,
        'box': list(fo.box), 'ui': [font_mod.UI_W, font_mod.UI_H],
        'native': [font_mod.NATIVE_W, font_mod.NATIVE_H],
        'anchor': [font_mod.SUB_X, font_mod.SUB_Y + font_mod.SUB_ANCHOR_DY],
        'body': list(font_mod.BODY_COLOUR),
        # `%%SC<XX>` set-colour codes, already in GS units (ELF 0x0020D7B0)
        'colours': {k: list(font_mod.gs_colour(v))
                    for k, v in font_mod.MARKUP_COLOURS.items()},
        'sample': font_mod.GS_SAMPLE, 'glyphs': table,
    }


# --------------------------------------------------------------------- audio

def encode_audio(adx_blob, bitrate, mono):
    """Decode ADX with our own decoder, then compress with ffmpeg to Ogg.

    `-bitexact` is what makes a rebuild reproducible.  Without it the Ogg
    muxer picks a random bitstream serial number per encode, which lands in
    every page header and changes every page CRC with it -- two builds of
    `e001` from the same disc differed in 4790 bytes across 368 runs, all of
    them serial and CRC, for identical audio.  That is invisible when you open
    the page and expensive everywhere else: rsync re-sends 0.89 GB, Docker
    rebuilds the layer, and a git-backed host stores another half a gigabyte.
    """
    wav = io.BytesIO()
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        wpath = os.path.join(td, 'a.wav')
        opath = os.path.join(td, 'a.ogg')
        adx_mod.to_wav(adx_blob, wpath)
        cmd = [FFMPEG, '-v', 'error', '-y', '-i', wpath,
               '-c:a', 'libvorbis', '-b:a', bitrate]
        if mono:
            cmd += ['-ac', '1']
        # `-bitexact` has to sit on the *output* side to reach the muxer;
        # before `-i` it is an input option and the serial stays random.
        cmd += ['-bitexact', opath]
        try:
            subprocess.run(cmd, check=True)
        except (OSError, subprocess.CalledProcessError):
            return None
        data = open(opath, 'rb').read()
    return 'data:audio/ogg;base64,%s' % base64.b64encode(data).decode()


# -------------------------------------------------------------------- export

def build(name, outdir, single=False, audio=True, jpeg_quality=88,
          bitrate='64k', bgm_bitrate='96k', verbose=True, disc=None,
          three_href=None, order_href=None):
    """Export one cutscene.  Returns what `site.py` needs for its index.

    `disc` lets a caller building many scenes open GAME.DAT once, and
    `three_href` points the page at a shared copy of three instead of writing
    one per bundle -- 149 cutscenes is 149 copies of 600 KB otherwise.
    `order_href` points it at the shared `order.js`, which turns the page into
    one entry of the story-order playlist (`tools/order.py`).
    """
    disc = disc or scene_mod.Disc()
    sc = scene_mod.load(name, disc)
    buf = Buffer()
    log = (lambda *a: print(*a)) if verbose else (lambda *a: None)

    models, clips, textures = {}, {}, {}
    warnings = []

    def want_model(fname):
        key = fname.lower()
        if key in models:
            return key
        blob = sc.asset(fname)
        if blob is None:
            warnings.append('missing model %s' % fname)
            return None
        models[key] = pack_model(smi_mod.parse(blob), buf)
        for mat in models[key]['materials']:
            t = mat['tex']
            if t and t.lower() not in textures:
                tb = sc.asset(t)
                if tb is None:
                    warnings.append('missing texture %s' % t)
                    textures[t.lower()] = None
                else:
                    textures[t.lower()] = pack_texture(tb, jpeg_quality)
        return key

    def want_clip(fname):
        key = fname.lower()
        if key in clips:
            return key
        blob = sc.asset(fname)
        if blob is None:
            warnings.append('missing clip %s' % fname)
            return None
        clips[key] = pack_clip(sai_mod.parse(blob), buf)
        return key

    entities = []
    if sc.room_model:
        key = want_model(sc.room_model)
        if key:
            entities.append({'name': sc.room, 'models': [key], 'clips': [],
                             'visibility': [], 'start': 0, 'static': True})
    for ent in sc.actors:
        keys = [k for k in (want_model(m) for m in ent.render_models) if k]
        if not keys:
            continue
        entries = []
        for frame, cname, coff in ent.clips:
            # The third field is `0x83`'s start offset -- see scene.py.  It is
            # zero everywhere but the e001 corpse, and the page carries it so
            # that clip samples in absolute scene time like the game does.
            ck = want_clip(cname)
            if ck:
                entries.append([frame, ck, coff])
        entities.append({
            'name': ent.name, 'models': keys, 'clips': entries,
            'visibility': [[f, 1 if on else 0] for f, on in ent.visibility],
            'parts': [[f, n, 1 if on else 0] for f, n, on in ent.parts],
            'start': ent.start,
            # `0x67` destroys the track's current object -- e001 swaps the
            # living king for his corpse at 8430 and both share a track.
            'end': ent.end,
            'position': list(ent.transform[:3]) if ent.transform else None,
            'tint': list(ent.scale[:3]) if ent.scale else None,
            'static': not entries,
        })

    # camera, sampled once per frame so the page does no interpolation
    camera = None
    if sc.camera:
        n = int(sc.duration)
        pos, tgt, fov, roll = [], [], [], []
        for f in range(1, n + 1):
            s = sc.camera.sample(f)
            pos += list(s.get('position', (0.0, 0.0, 0.0)))
            tgt += list(s.get('target', (0.0, 0.0, 1.0)))
            fov.append(s.get('fov', 40.0))
            roll.append(s.get('roll', 0.0))
        camera = {'frames': n, 'position': buf.add('f', pos),
                  'target': buf.add('f', tgt), 'fov': buf.add('f', fov),
                  'roll': buf.add('f', roll)}

    lights = [{'kind': l.light or 'ambient',
               'colour': list(l.scale[:3]) if l.scale else [1.0, 1.0, 1.0],
               'position': list(l.transform[:3]) if l.transform else [0.0, 0.0, 0.0],
               'range': list(l.light_range) if l.light_range else [0.0, 200.0],
               # `position` on a camera-parented light is an offset in camera
               # space, not a world point -- the page resolves it per frame.
               'parent': 'camera' if l.light_parent else None,
               # directional lights inherit their aim from the room's `.sli`
               'direction': list(l.light_dir) if l.light_dir else None,
               'label': l.label} for l in sc.lights]

    subtitles = [{'frame': s.frame, 'end': s.end, 'speaker': s.speaker,
                  'lines': s.lines, 'voice': s.voice, 'raw': s.raw}
                 for s in sc.subtitles]
    font = pack_font(sc.subtitles)

    sounds = {}
    if audio:
        voices = sorted({s.voice for s in sc.subtitles if s.voice})
        for v in voices:
            blob = disc.read('DATA/SOUND/VOICE/%s.ADX' % v.upper())
            if blob is None:
                warnings.append('missing voice %s' % v)
                continue
            uri = encode_audio(blob, bitrate, mono=True)
            if uri:
                sounds[v] = uri
        log('  encoded %d/%d voice clips' % (len(sounds), len(voices)))
        bgm_blob = disc.read('DATA/SOUND/BGM/%s.ADX' % name.upper())
        if bgm_blob:
            uri = encode_audio(bgm_blob, bgm_bitrate, mono=False)
            if uri:
                sounds['@bgm'] = uri
                log('  encoded BGM %s' % name.upper())
        elif sc.bgm:
            warnings.append('no DATA/SOUND/BGM/%s.ADX for the bgm cue' % name.upper())

    data = {
        'name': sc.name, 'room': sc.room, 'fps': FPS,
        'duration': int(sc.duration), 'fog': list(sc.fog) if sc.fog else None,
        'models': models, 'clips': clips, 'textures': textures,
        'entities': entities, 'camera': camera, 'lights': lights,
        'subtitles': subtitles, 'font': font, 'sounds': sounds,
        'bgm': [[f, k, i] for f, k, i in sc.bgm],
        'fades': [[f, k, n] for f, k, n in sc.fades],
        # `0x57`: the bars are sprites in the same 640x448 UI space the
        # subtitles use, so they travel with their own units (scene.py).
        'letterbox': {'ui': list(scene_mod.LETTERBOX_UI), 'bars': list(sc.bars),
                      'events': [[f, k, n] for f, k, n in sc.letterbox]},
    }

    dest = os.path.join(outdir, name)
    blob64 = base64.b64encode(buf.bytes()).decode()
    scene_js = 'window.TRAPT_SCENE=%s;\nwindow.TRAPT_BIN="%s";\n' % (
        json.dumps(data, separators=(',', ':')), blob64)

    template = open(os.path.join(HERE, 'player.html'), encoding='utf-8').read()
    three = open(os.path.join(HERE, 'vendor', 'three.min.js'), encoding='utf-8').read()
    title = '%s - Trapt cutscene' % name

    if single:
        html = (template.replace('<!--TITLE-->', title)
                .replace('<script src="three.min.js"></script>',
                         '<script>%s</script>' % three)
                .replace('<script src="scene.js"></script>',
                         '<script>%s</script>' % scene_js))
        os.makedirs(outdir, exist_ok=True)
        path = os.path.join(outdir, '%s.html' % name)
        with open(path, 'w', encoding='utf-8') as f:
            f.write(html)
        made = [path]
    else:
        os.makedirs(dest, exist_ok=True)
        with open(os.path.join(dest, 'scene.js'), 'w', encoding='utf-8') as f:
            f.write(scene_js)
        page = template.replace('<!--TITLE-->', title)
        made = [os.path.join(dest, 'index.html'), os.path.join(dest, 'scene.js')]
        if order_href:
            page = page.replace(
                '<script src="scene.js">',
                '<script src="%s"></script>\n<script src="scene.js">'
                % order_href)
        if three_href:
            page = page.replace('<script src="three.min.js">',
                                '<script src="%s">' % three_href)
        else:
            shutil.copyfile(os.path.join(HERE, 'vendor', 'three.min.js'),
                            os.path.join(dest, 'three.min.js'))
            made.insert(1, os.path.join(dest, 'three.min.js'))
        with open(os.path.join(dest, 'index.html'), 'w', encoding='utf-8') as f:
            f.write(page)

    log('%s: %d models, %d clips, %d textures, %d entities, %d subtitles, '
        '%d glyphs'
        % (name, len(models), len(clips), len(textures), len(entities),
           len(subtitles), len(font['glyphs']) if font else 0))
    log('  binary %.1f MB, %d sounds' % (buf.size / 1e6, len(sounds)))
    for path in made:
        log('  %-52s %7.1f MB' % (path, os.path.getsize(path) / 1e6))
    for w in dict.fromkeys(warnings):
        log('  ! %s' % w)
    return {
        'name': name, 'room': sc.room, 'duration': int(sc.duration), 'fps': FPS,
        'models': len(models), 'clips': len(clips), 'textures': len(textures),
        'entities': len(entities), 'subtitles': len(subtitles),
        'sounds': len(sounds), 'glyphs': len(font['glyphs']) if font else 0,
        'speakers': list(dict.fromkeys(s.speaker for s in sc.subtitles
                                       if s.speaker)),
        'opening': ' '.join(sc.subtitles[0].lines) if sc.subtitles else '',
        'opening_frame': sc.subtitles[0].frame if sc.subtitles else
                         int(sc.duration) // 2,
        'letterbox': len(sc.letterbox),
        'warnings': list(dict.fromkeys(warnings)),
        'files': [os.path.relpath(p, outdir).replace(os.sep, '/')
                  for p in made],
        'bytes': sum(os.path.getsize(p) for p in made),
    }


def list_cutscenes():
    toc = afs.load_toc()
    names = sorted({n.split('/')[2].lower() for n, _ in toc.values()
                    if n.upper().startswith('DATA/RT/E') and n.count('/') > 2})
    return names


def main():
    if '--list' in sys.argv:
        names = list_cutscenes()
        print('%d cutscenes:' % len(names))
        for i in range(0, len(names), 10):
            print('  ' + ' '.join(names[i:i + 10]))
        return
    name = sys.argv[1]
    outdir = sys.argv[2] if len(sys.argv) > 2 and not sys.argv[2].startswith('-') else 'out'
    build(name, outdir,
          single='--single' in sys.argv,
          audio='--no-audio' not in sys.argv)


if __name__ == '__main__':
    main()
