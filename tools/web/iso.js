/**
 * ISO 9660 reader, range-based.
 *
 * The point of this file is that the disc is never loaded.  Trapt (USA) is
 * 1.76 GB and `DATA/GAME.DAT` alone is 1.75 GB of it; a browser tab that
 * called `File.arrayBuffer()` on that would die.  Everything here goes
 * through a `source` -- an object with `size` and
 * `read(offset, length) -> Promise<Uint8Array>` -- so the same code runs over
 * a `File` the visitor picked and over `fs` in a test.
 *
 * ISO 9660 is small enough to do properly: a primary volume descriptor at
 * sector 16, a root directory record inside it, and directory records that
 * are just a linked run of variable-length entries.  Trapt's disc is plain
 * 2048-byte-sector ISO 9660 with no Joliet or Rock Ridge, so names arrive as
 * `FOO.BAR;1` and get their version suffix trimmed.
 */
// Wrapped: classic <script> tags share one global scope, and both this
// file and its sibling declare `u32` and `api` at top level.
(function () {
'use strict';

const SECTOR = 2048;

/** A `File`/`Blob` from an <input type="file">. */
function blobSource(blob) {
  return {
    size: blob.size,
    async read(offset, length) {
      const buf = await blob.slice(offset, offset + length).arrayBuffer();
      return new Uint8Array(buf);
    },
  };
}

/** Node's fs, so the same reader can be tested against the real disc. */
function fdSource(fs, path) {
  const fd = fs.openSync(path, 'r');
  return {
    size: fs.fstatSync(fd).size,
    close() { fs.closeSync(fd); },
    async read(offset, length) {
      const out = Buffer.alloc(length);
      let got = 0;
      while (got < length) {                       // short reads are legal
        const n = fs.readSync(fd, out, got, length - got, offset + got);
        if (n <= 0) break;
        got += n;
      }
      return new Uint8Array(out.buffer, out.byteOffset, got);
    },
  };
}

const u8 = (b, o) => b[o];
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000;

/**
 * One directory record.  Both the extent and the size are stored twice, once
 * little-endian and once big; we read the little-endian halves.
 */
function record(buf, p) {
  const len = u8(buf, p);
  if (len === 0) return null;
  const nameLen = u8(buf, p + 32);
  let name = '';
  for (let i = 0; i < nameLen; i++) name += String.fromCharCode(buf[p + 33 + i]);
  return {
    length: len,
    extent: u32(buf, p + 2),
    size: u32(buf, p + 10),
    flags: u8(buf, p + 25),
    isDir: (u8(buf, p + 25) & 2) !== 0,
    // '\x00' and '\x01' are "." and ".."; everything else loses its `;1`
    name: nameLen === 1 && (name === '\x00' || name === '\x01')
      ? (name === '\x00' ? '.' : '..')
      : name.replace(/;\d+$/, ''),
  };
}

/** Walk one directory extent into an array of records. */
async function readDir(source, extent, size) {
  const buf = await source.read(extent * SECTOR, Math.ceil(size / SECTOR) * SECTOR);
  const out = [];
  let p = 0;
  while (p < size) {
    const r = record(buf, p);
    if (!r) {                       // records never straddle a sector boundary
      p = (Math.floor(p / SECTOR) + 1) * SECTOR;
      continue;
    }
    if (r.name !== '.' && r.name !== '..') out.push(r);
    p += r.length;
  }
  return out;
}

/**
 * Open a disc image: reads the PVD and walks every directory.
 *
 * Returns `{ volume, files }` where `files` is a Map of upper-case path
 * (`DATA/GAME.DAT`) to `{ extent, size, offset }`.  Trapt's disc has three
 * directories and 3776 entries, so walking all of it up front is a handful of
 * sector reads, not a scan.
 */
async function open(source) {
  const pvd = await source.read(16 * SECTOR, SECTOR);
  const magic = String.fromCharCode(pvd[1], pvd[2], pvd[3], pvd[4], pvd[5]);
  if (pvd[0] !== 1 || magic !== 'CD001')
    throw new Error('not an ISO 9660 image (no CD001 primary volume descriptor)');
  if (u16(pvd, 128) !== SECTOR)
    throw new Error('unexpected logical block size ' + u16(pvd, 128));

  const latin = (o, n) => {
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(pvd[o + i]);
    return s.trim();
  };
  const volume = {
    system: latin(8, 32),
    id: latin(40, 32),
    sectors: u32(pvd, 80),
  };
  const root = record(pvd, 156);

  const files = new Map();
  const queue = [{ prefix: '', extent: root.extent, size: root.size }];
  while (queue.length) {
    const dir = queue.shift();
    for (const r of await readDir(source, dir.extent, dir.size)) {
      const path = dir.prefix + r.name;
      if (r.isDir) queue.push({ prefix: path + '/', extent: r.extent, size: r.size });
      else files.set(path.toUpperCase(), {
        extent: r.extent, size: r.size, offset: r.extent * SECTOR,
      });
    }
  }
  return { volume, files, source };
}

/** Read a whole file out of the image by path. Only for small ones. */
async function readFile(iso, path) {
  const e = iso.files.get(path.toUpperCase());
  if (!e) throw new Error('not on the disc: ' + path);
  return iso.source.read(e.offset, e.size);
}

const api = { SECTOR, open, readFile, readDir, blobSource, fdSource };
if (typeof module !== 'undefined') module.exports = api;
if (typeof window !== 'undefined') window.TraptIso = api;
})();
