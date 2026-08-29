/**
 * What each cutscene *is*, cheaply enough to do all 149.
 *
 * The gallery `site.py` builds gets this from the export: room, length, cast,
 * the opening line.  Doing the same here by assembling every cutscene would
 * read most of the disc and build 149 scenes' worth of models.  It does not
 * need to: everything on a card comes out of the `.ssc` tracks, which are a
 * few kilobytes inside a bundle that is several megabytes.
 *
 * So this opens each archive *ranged* -- one read of the header and name
 * table, then one read per script member -- and compiles only the timeline.
 * Across the disc that is about 3 MB read instead of about 700 MB.
 */
(function () {
'use strict';

const req = (typeof require !== 'undefined');
const arcMod = req ? require('./arc.js') : window.TraptArc;
const sceneMod = req ? require('./scene.js') : window.TraptScene;

const FPS = 60;

const mmss = (frames) => {
  const s = Math.round(frames / FPS);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
};

/** One cutscene's card data, or null when the disc has no bundle for it. */
async function describe(disc, name) {
  const up = name.toUpperCase();
  const path = 'DATA/RT/' + up + '/RT_' + up + '.ARC';
  if (!disc.has(path)) return null;
  const a = await arcMod.openRanged(disc, path);
  if (!a) return null;

  // Only the script tracks; the master names the rest and scene.compile
  // walks them, so read every .ssc in one pass.
  const assets = await a.readWhere((n) => n.endsWith('.ssc'));
  let scene;
  try {
    scene = sceneMod.compile(name, assets);
  } catch (e) {
    return { name: name, error: e.message, bytes: disc.sizeOf(path) };
  }

  const speakers = [];
  for (const s of scene.subtitles)
    if (s.speaker && speakers.indexOf(s.speaker) < 0) speakers.push(s.speaker);
  const first = scene.subtitles.length ? scene.subtitles[0] : null;

  return {
    name: name,
    room: scene.room,
    duration: scene.duration,
    length: mmss(scene.duration),
    cues: scene.subtitles.length,
    speakers: speakers,
    opening: first ? first.lines.join(' ') : '',
    openingSpeaker: first ? first.speaker : '',
    openingFrame: first ? first.frame : Math.round(scene.duration / 2),
    entities: scene.entities.length,
    bytes: disc.sizeOf(path),
    members: a.entries.length,
  };
}

/**
 * Describe many, calling `onOne(entry, done, total)` as each lands so a page
 * can fill its grid in while the rest are still being read.
 */
async function describeAll(disc, names, onOne) {
  const out = [];
  for (let i = 0; i < names.length; i++) {
    let entry = null;
    try {
      entry = await describe(disc, names[i]);
    } catch (e) {
      entry = { name: names[i], error: e.message };
    }
    if (entry) out.push(entry);
    if (onOne) onOne(entry, i + 1, names.length);
  }
  return out;
}

const api = { describe, describeAll, mmss, FPS };
if (typeof module !== 'undefined') module.exports = api;
if (typeof window !== 'undefined') window.TraptCatalog = api;
})();
