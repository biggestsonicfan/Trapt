/**
 * Voice and BGM for a playing cutscene -- the audio half of `player.html`,
 * over `adx.js` instead of a pre-encoded page.
 *
 * There is no re-encode anywhere here: the ADX goes straight to PCM and into
 * a WebAudio buffer, which is why a voice clip costs about a millisecond and
 * a whole BGM about a tenth of a second.
 *
 * Two things the data decides for us:
 *
 *  - **Every `e4xx` ending is unvoiced.** Their scripts call
 *    `play_voice("none", ...)`; the clip name is literally `none` and no such
 *    file exists.  Those cutscenes are text-only epilogues, not a gap here.
 *  - **BGM is looked up by cutscene name**, `DATA/SOUND/BGM/<NAME>.ADX`,
 *    which is right for the main story and finds nothing for an ending --
 *    those ask for a *track id* through a slot table that has not been
 *    decoded yet.  A missing file is reported, not retried.
 */
(function () {
'use strict';

const req = (typeof require !== 'undefined');
const adxMod = req ? require('./adx.js') : window.TraptAdx;

const FPS = 60.0;

function create(ctx, disc) {
  const voices = new Map();          // name -> AudioBuffer | null | 'missing'
  const state = {
    ctx: ctx, disc: disc, bgm: null, bgmSource: null, bgmStart: 0,
    bgmStop: Infinity, playing: new Map(), spoken: -1, muted: false,
    warnings: [], loaded: 0,
  };

  /** Decode one voice clip, once. `null` while it is still being fetched. */
  async function voice(name) {
    if (!name || name === 'none') return null;
    const key = name.toLowerCase();
    if (voices.has(key)) return voices.get(key);
    voices.set(key, null);           // in flight; do not fetch twice
    let buf = null;
    try {
      const blob = await disc.read('DATA/SOUND/VOICE/' + name.toUpperCase() + '.ADX');
      if (blob) buf = adxMod.toAudioBuffer(ctx, blob);
      else state.warnings.push('no voice ' + name);
    } catch (e) {
      state.warnings.push(name + ': ' + e.message);
    }
    voices.set(key, buf);
    if (buf) state.loaded++;
    return buf;
  }

  /** Pull in the BGM the scene asks for, if the disc has one by that name. */
  async function loadBgm(cutscene, scene) {
    state.bgmStart = 0;
    state.bgmStop = Infinity;
    for (const [f, kind] of scene.bgm) {
      if (kind === 'start') state.bgmStart = f;
      else state.bgmStop = f;
    }
    if (!scene.bgm.length) return;
    try {
      const blob = await disc.read('DATA/SOUND/BGM/' + cutscene.toUpperCase() + '.ADX');
      if (blob) state.bgm = adxMod.toAudioBuffer(ctx, blob);
      else state.warnings.push('no BGM file named ' + cutscene.toUpperCase()
                               + '.ADX (the script asks for a track id)');
    } catch (e) {
      state.warnings.push('bgm: ' + e.message);
    }
  }

  /** Warm the voice cache for a scene, so cues do not stutter on first play. */
  async function preloadVoices(scene, onProgress) {
    const names = [...new Set(scene.subtitles.map((s) => s.voice)
                                             .filter((v) => v && v !== 'none'))];
    for (let i = 0; i < names.length; i++) {
      await voice(names[i]);
      if (onProgress) onProgress(i + 1, names.length);
    }
    return names.length;
  }

  function stopAll() {
    for (const [, src] of state.playing) { try { src.stop(); } catch (e) {} }
    state.playing.clear();
    if (state.bgmSource) { try { state.bgmSource.stop(); } catch (e) {} }
    state.bgmSource = null;
  }

  function playBuffer(buf, offset, gain) {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = gain === undefined ? 1 : gain;
    src.connect(g).connect(ctx.destination);
    src.start(0, Math.max(0, offset || 0));
    return src;
  }

  /**
   * Drive playback for `frame`.  `seeked` means the frame jumped, so
   * everything in flight is dropped and the cue index rebuilt -- otherwise a
   * scrub backwards would replay every line at once.
   */
  function sync(scene, frame, playing, seeked) {
    if (seeked) {
      stopAll();
      state.spoken = -1;
      for (let i = 0; i < scene.subtitles.length; i++)
        if (scene.subtitles[i].frame <= frame) state.spoken = i;
    }
    if (!playing || state.muted) {
      if (!playing) stopAll();
      return;
    }

    if (state.bgm && !state.bgmSource
        && frame >= state.bgmStart && frame < state.bgmStop) {
      state.bgmSource = playBuffer(state.bgm, (frame - state.bgmStart) / FPS, 0.45);
    }
    if (state.bgmSource && (frame < state.bgmStart || frame >= state.bgmStop)) {
      try { state.bgmSource.stop(); } catch (e) {}
      state.bgmSource = null;
    }

    for (let i = 0; i < scene.subtitles.length; i++) {
      const s = scene.subtitles[i];
      if (i > state.spoken && frame >= s.frame) {
        state.spoken = i;
        if (!s.voice || s.voice === 'none') continue;
        const buf = voices.get(s.voice.toLowerCase());
        if (buf) state.playing.set(i, playBuffer(buf, 0, 1));
      }
    }
  }

  return Object.assign(state, {
    voice, loadBgm, preloadVoices, sync, stopAll,
    setMuted(on) { state.muted = on; if (on) stopAll(); },
    get voiceCount() { return state.loaded; },
  });
}

const api = { create, FPS };
if (typeof module !== 'undefined') module.exports = api;
if (typeof window !== 'undefined') window.TraptAudio = api;
})();
