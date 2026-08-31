/**
 * Which build of the game a disc image holds -- `tools/region.py` in the
 * browser.
 *
 * Two discs carry this game:
 *
 *   Trapt (USA)                    SLUS_212.55   volume TRAPT
 *   Kagero II: Dark Illusion (JP)  SLPS_254.45   volume KAGEROU2
 *
 * They hold the same files under the same names, and every reader in here
 * parses both without knowing which it has.  What moved is the executable:
 * the JP one is 45 KB smaller and its read-only data sits elsewhere, so the
 * filename table, the story tables and the font are at different addresses.
 * An address is only meaningful next to the build it came out of, and that
 * pairing is what this file is.
 *
 * `disc.js` picks the region from the image's own file list and hangs it on
 * the `Disc`, so `story.js` and `font.js` never have to ask which disc the
 * visitor put in.  See `tools/region.py` for how the JP addresses were found.
 */
(function () {
'use strict';

const US = {
  code: 'us',
  serial: 'SLUS-21255',
  title: 'Trapt',
  elf: 'SLUS_212.55',
  volume: 'TRAPT',
  toc: { va: 0x0036A0F0, n: 3773 },
  order: {
    NAME_TABLE: 0x00386920,
    GROUP_TABLE: 0x0045DB50,
    CH_STAGES: 0x0042DD20,
    CH_OPEN: 0x0042DD60,
    CH_STAGE_GROUPS: 0x0042DD70,
    CH_FLAG: 0x0042DDD0,
    ROUTE_TABLE: 0x003872A0,
    FLOW_TABLE: 0x003872C0,
    CARD_TABLE: 0x0044D930,
  },
  font: {
    GLYPHS: 0x003885C0,
    CLUT: 0x00388580,
    DESC: 0x00450620,
    WIDTH_DIR: 0x004506E0,
    WIDTH_DIR_N: 8,
  },
};

const JP = {
  code: 'jp',
  serial: 'SLPS-25445',
  title: 'Kagero II: Dark Illusion',
  elf: 'SLPS_254.45',
  volume: 'KAGEROU2',
  toc: { va: 0x0036C070, n: 3762 },
  // The story tables are the same bytes as the US ones, which is how they
  // were found -- matched byte for byte in the other executable.
  order: {
    NAME_TABLE: 0x0041E690,
    GROUP_TABLE: 0x0045EC90,
    CH_STAGES: 0x00429440,
    CH_OPEN: 0x00429480,
    CH_STAGE_GROUPS: 0x00429490,
    CH_FLAG: 0x004294F0,
    ROUTE_TABLE: 0x0041F010,
    FLOW_TABLE: 0x0041F030,
    CARD_TABLE: 0x00448EE0,
  },
  // Same face, re-rasterised: kana and level-1 kanji are the US glyphs pixel
  // for pixel, the full-width Latin block is not -- the US build redrew it,
  // and the width directory exists to letter-space that redrawn face.  The
  // JP build ships none, so every glyph advances by the 16-texel cell, which
  // is what `Font.advance` already falls back to.
  font: {
    GLYPHS: 0x00379580,
    CLUT: 0x00379540,
    DESC: 0x0044BE70,
    WIDTH_DIR: 0,
    WIDTH_DIR_N: 0,
  },
};

const REGIONS = [US, JP];

/** The region an ISO's file list belongs to, or null if it is neither disc. */
function detect(files) {
  for (const r of REGIONS) if (files.has(r.elf)) return r;
  return null;
}

/** By code ('us'), serial ('SLUS-21255') or ELF name ('SLUS_212.55'). */
function find(key) {
  const k = String(key).toUpperCase();
  return REGIONS.find((r) => r.code.toUpperCase() === k || r.serial === k
                             || r.elf === k) || null;
}

const api = { US, JP, REGIONS, detect, find };
if (typeof module !== 'undefined') module.exports = api;
if (typeof window !== 'undefined') window.TraptRegion = api;
})();
