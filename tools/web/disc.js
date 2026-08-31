/**
 * The disc, as the game sees it: ELF filename table + `DATA/GAME.DAT` (AFS).
 *
 * This is `tools/afs.py` and `scene.Disc` in the browser, over `iso.js`.
 * Nothing is loaded that is not asked for -- opening a disc reads the ISO
 * directory tree, the 44 KB TOC out of the ELF and the AFS index, about
 * 100 KB in total, and every file after that is one ranged read.
 *
 * Two facts do the work, both from docs/EXECUTABLE.md:
 *
 *   - the ELF's one segment loads at 0x00100000 and starts at file offset
 *     0x80, so `vaddr - 0x100000 + 0x80` is a file offset;
 *   - the filename table is baked at a known vaddr -- 0x0036A0F0 on the US
 *     disc, 0x0036C070 on the Japanese one -- as records of 12 bytes,
 *     `{const char *name, u32 size, u32 afs_id}`.
 *
 * `GAME.DAT` itself is CRI AFS: `'AFS\0'`, a count, then `{offset, size}`
 * pairs.  The TOC maps an AFS id to the name the game asks for, which is why
 * a disc entry can be found by path at all.
 *
 * Either disc opens.  `region.js` says which one it is, from the executable
 * the image carries, and the `Disc` keeps it as `.region` so that everything
 * downstream reads the right addresses out of the right ELF.
 */
// Wrapped: classic <script> tags share one global scope, and both this
// file and its sibling declare `u32` and `api` at top level.
(function () {
'use strict';

const isoMod = (typeof require !== 'undefined') ? require('./iso.js') : window.TraptIso;
const regionMod = (typeof require !== 'undefined') ? require('./region.js') : window.TraptRegion;

const GAMEDAT_PATH = 'DATA/GAME.DAT';
const ELF_LOAD_VA = 0x00100000;
const ELF_LOAD_OFF = 0x80;

const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000;

/** Read a NUL-terminated latin-1 string out of an already-read buffer. */
function cstr(buf, off) {
  let s = '';
  for (let i = off; i < buf.length && buf[i]; i++) s += String.fromCharCode(buf[i]);
  return s;
}

class Disc {
  constructor(iso, region, elf, toc, entries, gamedat) {
    this.iso = iso;
    this.region = region;            // which build -- region.js
    this.elf = elf;                  // the whole 3.6 MB ELF, kept: the font,
    this.toc = toc;                  // the cutscene registry and the story
    this.entries = entries;          // tables all live in it
    this.gamedat = gamedat;
    this.byName = new Map();
    for (const [id, rec] of toc) this.byName.set(rec.name.toUpperCase(), id);
  }

  /** vaddr -> offset into `this.elf`. */
  elfOff(va) { return va - ELF_LOAD_VA + ELF_LOAD_OFF; }

  elfU8(va) { return this.elf[this.elfOff(va)]; }
  elfU32(va) { return u32(this.elf, this.elfOff(va)); }
  elfStr(va) { return cstr(this.elf, this.elfOff(va)); }

  /** Every disc path, upper-case, optionally filtered by prefix. */
  glob(prefix) {
    const p = (prefix || '').toUpperCase();
    const out = [];
    for (const name of this.byName.keys()) if (name.startsWith(p)) out.push(name);
    return out.sort();
  }

  has(path) { return this.byName.has(path.toUpperCase()); }

  /** One file out of GAME.DAT, by the name the game uses. */
  async read(path) {
    const id = this.byName.get(path.toUpperCase());
    if (id === undefined) return null;
    const e = this.entries[id];
    if (!e || !e.size) return null;
    return this.iso.source.read(this.gamedat.offset + e.offset, e.size);
  }

  /**
   * Part of a file, without reading the rest of it.
   *
   * A cutscene bundle is several megabytes and most of it is models and
   * textures.  Anything that only wants the script tracks -- a catalogue of
   * what each cutscene is, say -- would otherwise read 700 MB across the
   * disc to look at about 3 MB of bytecode.
   */
  async readRange(path, offset, length) {
    const id = this.byName.get(path.toUpperCase());
    if (id === undefined) return null;
    const e = this.entries[id];
    if (!e || !e.size) return null;
    const start = Math.min(offset, e.size);
    const n = Math.max(0, Math.min(length, e.size - start));
    if (!n) return new Uint8Array(0);
    return this.iso.source.read(this.gamedat.offset + e.offset + start, n);
  }

  /** The size of a file, from the AFS index, without reading it. */
  sizeOf(path) {
    const id = this.byName.get(path.toUpperCase());
    if (id === undefined) return -1;
    const e = this.entries[id];
    return e ? e.size : -1;
  }
}

/**
 * Open a disc image -- either region.  Throws with something legible if it is
 * the wrong disc, which is the whole point of asking for it.
 */
async function open(source) {
  const iso = await isoMod.open(source);

  const region = regionMod.detect(iso.files);
  if (!region || !iso.files.has(GAMEDAT_PATH))
    throw new Error('that image has no '
                    + regionMod.REGIONS.map((r) => r.elf).join(' or ')
                    + ' with ' + GAMEDAT_PATH
                    + ' -- it does not look like Trapt or Kagero II'
                    + ' (volume id "' + iso.volume.id + '")');

  const elf = await isoMod.readFile(iso, region.elf);

  const toc = new Map();
  const tocOff = region.toc.va - ELF_LOAD_VA + ELF_LOAD_OFF;
  const base = elf.length > tocOff ? tocOff : -1;
  if (base < 0) throw new Error('ELF is too small to hold the filename table');
  for (let i = 0; i < region.toc.n; i++) {
    const p = base + 12 * i;
    const nameVa = u32(elf, p), size = u32(elf, p + 4), id = u32(elf, p + 8);
    toc.set(id, { name: cstr(elf, nameVa - ELF_LOAD_VA + ELF_LOAD_OFF), size: size });
  }

  const gamedat = iso.files.get(GAMEDAT_PATH);
  const head = await iso.source.read(gamedat.offset, 8);
  if (!(head[0] === 0x41 && head[1] === 0x46 && head[2] === 0x53 && head[3] === 0))
    throw new Error('DATA/GAME.DAT is not an AFS archive');
  const count = u32(head, 4);
  const index = await iso.source.read(gamedat.offset + 8, 8 * count);
  const entries = [];
  for (let i = 0; i < count; i++)
    entries.push({ offset: u32(index, 8 * i), size: u32(index, 8 * i + 4) });

  return new Disc(iso, region, elf, toc, entries, gamedat);
}

const api = { open, Disc, GAMEDAT_PATH, REGIONS: regionMod.REGIONS };
if (typeof module !== 'undefined') module.exports = api;
if (typeof window !== 'undefined') window.TraptDisc = api;
})();
