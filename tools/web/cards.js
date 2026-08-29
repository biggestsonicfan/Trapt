/**
 * The game's own loading cards, out of `DATA/TWO_D`.
 *
 * Three families, established by rendering them rather than by guessing at
 * the directory names:
 *
 *   SLD00-SLD15  the **chapter title cards**.  `sp_sld00.tm2` is a 512x256
 *                image with the chapter number and name already drawn into
 *                the art -- SLD12 reads "Chapter12 / The Ties that Bind" --
 *                so there is no text to lay out, only a picture to show.
 *                SLD00 is the same ornate frame with an empty middle, which
 *                is why the numbering starts the chapters at 01.
 *   SLD_*        named slides for a character and six rooms.
 *   DIZ/DI00-08  device cards: the title is in the art ("The Devil's
 *                Trapeze") and the body is drawn over it at runtime.
 *
 * The path table is in the ELF at 0x0044D930, stride 0x20, and continues past
 * the sixteen numbered cards into the named ones.
 *
 * There is no tip-string table: a search of the executable for Shift-JIS runs
 * turns up menu labels, item names and error messages, and nothing that reads
 * like a loading-screen hint.  What the loading screen (`LS/LS.ARC`) has is a
 * background with an empty panel; whatever fills it is not a table of tips.
 */
(function () {
'use strict';

const req = (typeof require !== 'undefined');
const arcMod = req ? require('./arc.js') : window.TraptArc;
const tm2Mod = req ? require('./tm2.js') : window.TraptTm2;

const CARD_MEMBER = 'sp_sld00.tm2';        // the 512x256 art in every slide

/**
 * Read one card archive -> `{width, height, rgba}`, or null.
 * Results are cached on the disc object: a card is 132 KB decoded and the
 * same chapter card is shown every time that chapter comes round.
 */
async function load(disc, path) {
  if (!disc.__cards) disc.__cards = new Map();
  const key = path.toUpperCase();
  if (disc.__cards.has(key)) return disc.__cards.get(key);
  let pic = null;
  try {
    const blob = await disc.read(key);
    if (blob) {
      const members = arcMod.members(blob);
      // the big picture, whatever it is called in this archive
      let best = members.get(CARD_MEMBER) || null;
      if (!best)
        for (const [name, bytes] of members)
          if (name.endsWith('.tm2') && (!best || bytes.length > best.length))
            best = bytes;
      if (best) {
        const pics = tm2Mod.decode(best);
        if (pics.length) pic = pics[0];
      }
    }
  } catch (e) {
    pic = null;
  }
  disc.__cards.set(key, pic);
  return pic;
}

/** Every card the ELF's table names that the disc actually carries. */
async function available(disc, tables) {
  const out = [];
  for (let c = 0; c < tables.chapters.length; c++) {
    const p = tables.chapters[c].card;
    if (disc.has(p)) out.push({ chapter: c, path: p });
  }
  return out;
}

const api = { load, available, CARD_MEMBER };
if (typeof module !== 'undefined') module.exports = api;
if (typeof window !== 'undefined') window.TraptCards = api;
})();
