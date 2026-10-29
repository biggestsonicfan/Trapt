/**
 * The game's particle emitter, the one `0x9E` sets up -- e001's torches,
 * e129's and e132's dust and sparks, e429's motes.
 *
 * Everything here was read out of the ELF; docs/VIEWER.md 10.25 has the
 * addresses.  The short version:
 *
 *   An emitter is `slots` particles (0x9E arg 1), each a 0x80-byte record
 *   with a timer.  A live particle counts its timer down from its life; a
 *   dead one waits a random 1..rate-1 frames and then respawns, at most
 *   `perFrame` spawns per emitter per frame.  The update is FUN_00221BF0,
 *   the spawn FUN_00220B30.
 *
 *   Where a particle starts and how fast it goes is the *shape*,
 *   FUN_0021F7F0.  Two are on the disc: `0x77` a sphere -- a random
 *   direction, a random radius and a random speed along it -- and `0xAE` a
 *   box -- a random point in it, a fixed velocity along an angle in the YZ
 *   plane and a random jitter on top.  The shape is rolled once per slot
 *   when the emitter starts and kept for every life after that, unless
 *   `0x9E`'s last argument asks for a fresh roll at every spawn.
 *
 *   `0x74` is a constant acceleration on Y, added to the velocity every
 *   frame before the velocity is added to the position.
 *
 * The game's random numbers are its own and not recoverable from the
 * script, so this rolls a seeded generator instead: the same emitter does
 * the same thing every time it is played, and scrubbing is exact.
 *
 * Nothing here touches three.js; play.js draws what `at` returns.
 */
(function () {
'use strict';

/** mulberry32: a small seeded generator, uniform on [0, 1). */
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stable 32-bit seed from a string -- an effect's track name. */
function seedOf(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

const lerp = (a, b, t) => a + (b - a) * t;

/**
 * One roll of the shape: where a particle starts, relative to the emitter,
 * and its velocity.  FUN_0021F7F0.
 */
function roll(shape, rand) {
  if (!shape) return { pos: [0, 0, 0], vel: [0, 0, 0] };
  if (shape.kind === 'sphere') {
    // The speed is rolled first, then a latitude in [-pi/2, pi/2] and a
    // longitude in [-pi, pi]; (0, 0, 1) turned by both is the direction.
    const speed = lerp(shape.speed[0], shape.speed[1], rand()) * shape.sign;
    const lat = rand() * Math.PI - Math.PI / 2;
    const lon = rand() * 2 * Math.PI - Math.PI;
    const dir = [Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon)];
    const r = lerp(shape.radius[0], shape.radius[1], rand());
    return { pos: dir.map((d) => d * r), vel: dir.map((d) => d * speed) };
  }
  // box: each axis uniform on [-half, half]; then the base velocity along
  // (0, sin, cos) of the angle -- FUN_0010D9E0 is the sine, FUN_0010D880 the
  // cosine -- plus each axis uniform on [-jitter, jitter].  -90, which is
  // all the disc uses besides 0, is straight down.
  const rad = Math.PI * shape.angle / 180;
  const dir = [0, Math.sin(rad), Math.cos(rad)];
  const pos = shape.half.map((h) => -h + 2 * h * rand());
  const vel = dir.map((d, i) => d * shape.speed - shape.jitter[i] + 2 * shape.jitter[i] * rand());
  return { pos, vel };
}

/**
 * An emitter run from its first frame.  `spec` is scene.js's
 * `entity.particles`; `stop` is the local frame from which no more spawn.
 *
 * The run is stepped frame by frame, as the game does, and remembered, so
 * asking for any frame -- forwards, backwards, at random -- is a lookup.
 */
function create(spec, seed, stop) {
  const rand = rng(seed);
  const n = spec.slots;
  const wait = () => -Math.trunc(1 + (spec.rate - 1) * rand());
  const slots = [];
  for (let k = 0; k < n; k++) {
    // FUN_00222260 rolls every slot's shape and its first wait up front
    const s = roll(spec.shape, rand);
    slots.push({ timer: wait(), pos: s.pos, vel: s.vel, history: [] });
  }
  const end = stop === undefined ? Infinity : stop;
  let done = 0;              // the last frame stepped

  function step(f) {
    let spawned = 0;
    for (const s of slots) {
      if (s.timer > 0) { s.timer--; continue; }
      if (s.timer === 0) { s.timer = wait(); continue; }
      if (s.timer < -1) { s.timer++; continue; }
      // -1: due.  `perFrame` 0 is no limit.
      if (f >= end || (spec.perFrame > 0 && spawned >= spec.perFrame)) continue;
      spawned++;
      const life = Math.trunc(lerp(spec.life[0], spec.life[1], rand()));
      if (spec.reroll) { const r = roll(spec.shape, rand); s.pos = r.pos; s.vel = r.vel; }
      s.timer = life;
      s.history.push({ frame: f, life, pos: s.pos, vel: s.vel });
    }
  }

  /**
   * Slot `k` at local frame `f`: null when it is not alive, else its age in
   * frames (what the keyframes are timed by), where it is relative to the
   * emitter and how much its fade has taken off its alpha.
   */
  function at(k, f) {
    if (f < 0 || k >= n) return null;
    while (done < f) step(++done);
    const h = slots[k].history;
    let lo = 0, hi = h.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (h[mid].frame <= f) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (found < 0) return null;
    const p = h[found];
    // `u` updates since the spawn; it is drawn while its timer is above 0
    const u = f - p.frame;
    if (u >= p.life) return null;
    const a = spec.accel;
    const pos = [p.pos[0] + p.vel[0] * u,
                 p.pos[1] + p.vel[1] * u + a * u * (u + 1) / 2,
                 p.pos[2] + p.vel[2] * u];
    // `+0x6C` loses 1/fade a frame once the timer is within `fade` of 0
    const faded = spec.fade > 0 ? Math.max(0, u - (p.life - spec.fade)) / spec.fade : 0;
    return { age: Math.max(0, u - 1), pos, alpha: Math.max(0, 1 - faded) };
  }

  return { at, slots: n };
}

const api = { create, roll, rng, seedOf };
if (typeof module !== 'undefined') module.exports = api;
if (typeof window !== 'undefined') window.TraptParticles = api;
})();
