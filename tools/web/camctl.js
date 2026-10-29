/**
 * The viewer's own cameras, after noclip.website's three controllers.
 *
 *   noclip  fly: WASD/arrows move along the view, Q/E (PageDown/PageUp) down
 *           and up, drag turns the head, the wheel sets the speed.  Movement
 *           eases in and out rather than starting and stopping dead.
 *   orbit   look a model over: drag swings the eye round a target and keeps
 *           swinging a little after release, shift- or middle-drag pans the
 *           target, the wheel zooms, A/D W/S Q/E orbit, zoom and tilt, R spins.
 *   ortho   the orbit controls through a parallel projection, with snaps to
 *           the top, front, side and back.
 *
 * All three share one state -- yaw, pitch, a distance and a target -- because
 * fitting a model or a room to the view sets the target and the distance and
 * everything downstream reads them.  The eye is always `eye(o)`; nothing here
 * touches three.js, so the arithmetic is testable under node.
 *
 * Saved views are noclip's too: shift+1..9 stores the camera, 1..9 brings it
 * back.  The page keeps them in localStorage per cutscene or model.
 */
(function () {
'use strict';

const MODES = ['noclip', 'orbit', 'ortho'];
const PITCH = 1.4;                 // free look stops short of straight up
const PITCH_SNAP = 1.5697;         // a top view; lookAt degenerates at pi/2
const SPEED_MIN = 0.05, SPEED_MAX = 20;
const FLY_SCALE = 0.25, FLY_MAX = 60, FLY_BOOST = 3;
const FLY_EASE = 10;               // 1/s: how fast velocity reaches the keys'
const SPIN_DRAG = 5;               // 1/s: how fast a released orbit settles
const SPIN_MAX = 3;                // rad/s: a flick coasts, it does not whirl
const KEY_TURN = 1.5;              // rad/s for the orbit keys
const AUTO_SPIN = 0.35;            // rad/s for R

function create() {
  return { mode: 'noclip', yaw: 0.6, pitch: 0.25, dist: 10, target: [0, 0, 0],
           vel: [0, 0, 0], spin: [0, 0], speed: 1, invertY: false,
           autoRotate: false, fov: 35 };
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** Where the eye sits. */
function eye(o) {
  const cp = Math.cos(o.pitch);
  return [o.target[0] + Math.sin(o.yaw) * cp * o.dist,
          o.target[1] + Math.sin(o.pitch) * o.dist,
          o.target[2] + Math.cos(o.yaw) * cp * o.dist];
}

/** Unit forward, right and up of the view in world space. */
function axes(o) {
  const cp = Math.cos(o.pitch), sp = Math.sin(o.pitch);
  const sy = Math.sin(o.yaw), cy = Math.cos(o.yaw);
  return { fwd: [-sy * cp, -sp, -cy * cp],
           right: [cy, 0, -sy],
           up: [0, 1, 0],
           // the screen's own up, for panning: right x forward
           screenUp: [-sy * sp, cp, -cy * sp] };
}

/** Turn about the eye: the head turns, the eye stays where it was. */
function lookFrom(o, dyaw, dpitch) {
  const e = eye(o);
  o.yaw += dyaw;
  o.pitch = clamp(o.pitch + dpitch, -PITCH, PITCH);
  const cp = Math.cos(o.pitch);
  o.target = [e[0] - Math.sin(o.yaw) * cp * o.dist,
              e[1] - Math.sin(o.pitch) * o.dist,
              e[2] - Math.cos(o.yaw) * cp * o.dist];
}

/** Swing the eye round the target. */
function orbitBy(o, dyaw, dpitch) {
  o.yaw += dyaw;
  const lim = o.mode === 'ortho' ? PITCH_SNAP : PITCH;
  o.pitch = clamp(o.pitch + dpitch, -lim, lim);
}

/**
 * A drag (or a pointer-locked move) of (dyaw, dpitch), already scaled to
 * radians.  `orbit` asks for an orbit whatever the mode, which is what
 * right-drag does in the fly camera.
 */
function look(o, dyaw, dpitch, orbit) {
  if (o.invertY) dpitch = -dpitch;
  if (o.mode === 'noclip' && !orbit) { lookFrom(o, dyaw, dpitch); return; }
  orbitBy(o, dyaw, dpitch);
}

/** Remember a drag's last turn rate so the orbit coasts on release. */
function fling(o, dyaw, dpitch, dt) {
  if (o.mode === 'noclip' || !(dt > 0)) return;
  if (o.invertY) dpitch = -dpitch;
  // Pointer events can arrive bunched; a floor on dt and a cap on the rate
  // keep two events a millisecond apart from reading as a whirl.
  const t = Math.max(dt, 1 / 60);
  o.spin = [clamp(dyaw / t, -SPIN_MAX, SPIN_MAX), clamp(dpitch / t, -SPIN_MAX, SPIN_MAX)];
}

/** Move the target in the screen plane by (dx, dy) of the view's height. */
function pan(o, dx, dy) {
  const a = axes(o), s = o.dist;
  for (let i = 0; i < 3; i++)
    o.target[i] += (-a.right[i] * dx + a.screenUp[i] * dy) * s;
}

/**
 * One wheel notch.  The fly camera has no target to come closer to, so,
 * as in noclip, the wheel sets how fast it flies; the others zoom.
 */
function wheel(o, dir) {
  if (o.mode === 'noclip') {
    o.speed = clamp(o.speed * Math.pow(1.15, -dir), SPEED_MIN, SPEED_MAX);
  } else {
    o.dist = Math.max(0.05, o.dist * (1 + dir * 0.12));
  }
}

/**
 * Fly speed in units a second.  It scales with the distance, which is set
 * from the size of whatever was loaded, so the same keys suit a face and a
 * courtyard.  What it is scaled *to* comes from the game: the player walks
 * 10 units a second and runs 34 (STAGE.md), and a camera that crosses a room
 * much faster than the girl being chased through it cannot be aimed -- hence
 * a quarter of the distance, capped a little under twice a run.  `speed` is
 * the wheel's multiplier on that and shift trebles it.
 */
function flySpeed(o, boost) {
  return Math.min(Math.max(o.dist, 1) * FLY_SCALE, FLY_MAX) * o.speed
       * (boost ? FLY_BOOST : 1);
}

/** -1, 0 or 1 for a pair of held keys. */
const axis = (k, plus, minus) => (k[plus] ? 1 : 0) - (k[minus] ? 1 : 0);

function stepFly(o, k, dt) {
  const x = axis(k, 'd', 'a'), y = axis(k, 'e', 'q'), z = axis(k, 'w', 's');
  const a = axes(o), v = flySpeed(o, k.boost);
  const ease = 1 - Math.exp(-FLY_EASE * dt);
  let moving = false;
  for (let i = 0; i < 3; i++) {
    const want = (a.fwd[i] * z + a.right[i] * x + a.up[i] * y) * v;
    o.vel[i] += (want - o.vel[i]) * ease;
    if (!want && Math.abs(o.vel[i]) < 1e-3 * v) o.vel[i] = 0;
    o.target[i] += o.vel[i] * dt;
    moving = moving || o.vel[i] !== 0;
  }
  return moving;
}

function stepOrbit(o, k, dt, dragging) {
  const yawKey = axis(k, 'd', 'a'), tilt = axis(k, 'e', 'q'), in_ = axis(k, 'w', 's');
  orbitBy(o, yawKey * KEY_TURN * dt, tilt * KEY_TURN * dt);
  if (in_) o.dist = Math.max(0.05, o.dist * Math.exp(-in_ * 1.5 * dt
                                                     * (k.boost ? FLY_BOOST : 1)));
  if (!dragging) {
    orbitBy(o, o.spin[0] * dt, o.spin[1] * dt);
    const drag = Math.exp(-SPIN_DRAG * dt);
    o.spin = [o.spin[0] * drag, o.spin[1] * drag];
    if (Math.abs(o.spin[0]) + Math.abs(o.spin[1]) < 1e-3) o.spin = [0, 0];
  }
  if (o.autoRotate) orbitBy(o, AUTO_SPIN * o.speed * dt, 0);
  return !!(yawKey || tilt || in_ || o.spin[0] || o.spin[1] || o.autoRotate);
}

/**
 * Advance one frame from the held keys `k` (w a s d q e, boost).  Returns
 * whether the camera moved.
 */
function step(o, k, dt, dragging) {
  return o.mode === 'noclip' ? stepFly(o, k, dt) : stepOrbit(o, k, dt, dragging);
}

function setMode(o, mode) {
  if (!MODES.includes(mode)) return;
  o.mode = mode;
  o.vel = [0, 0, 0];
  o.spin = [0, 0];
  // Leaving a top view must not swing the eye: tilt about the eye instead.
  if (Math.abs(o.pitch) > PITCH) lookFrom(o, 0, 0);
}

/**
 * Keep the eye and turn it to face `target`, which becomes what the orbit
 * swings round.  Flying leaves the target a fixed distance ahead of the eye,
 * often out past the room, so the orbit and ortho cameras take the scene's
 * own centre instead.
 */
function aimAt(o, target) {
  const e = eye(o);
  const d = [target[0] - e[0], target[1] - e[1], target[2] - e[2]];
  const n = Math.hypot(d[0], d[1], d[2]);
  if (!(n > 1e-6)) return;
  o.dist = n;
  fromPose(o, e, d);
}

/** Snap to a view straight down an axis, for the ortho camera. */
function snap(o, view) {
  const v = { top: [0, PITCH_SNAP], front: [0, 0], side: [Math.PI / 2, 0],
              back: [Math.PI, 0] }[view];
  if (!v) return;
  o.yaw = v[0]; o.pitch = v[1]; o.spin = [0, 0];
}

/**
 * Take over from another camera (the cutscene's) without a jump: put the eye
 * where it was and look the same way, keeping the current distance.
 */
function fromPose(o, e, fwd) {
  const n = Math.hypot(fwd[0], fwd[1], fwd[2]) || 1;
  const f = [fwd[0] / n, fwd[1] / n, fwd[2] / n];
  o.yaw = Math.atan2(-f[0], -f[2]);
  o.pitch = clamp(Math.asin(clamp(-f[1], -1, 1)), -PITCH, PITCH);
  o.target = [e[0] + f[0] * o.dist, e[1] + f[1] * o.dist, e[2] + f[2] * o.dist];
  o.vel = [0, 0, 0];
  o.spin = [0, 0];
}

/** What a saved view holds. */
function save(o) {
  return { mode: o.mode, yaw: o.yaw, pitch: o.pitch, dist: o.dist,
           target: o.target.slice(), speed: o.speed, fov: o.fov };
}

function restore(o, s) {
  if (!s || !Array.isArray(s.target)) return false;
  setMode(o, s.mode || o.mode);
  o.yaw = +s.yaw || 0;
  o.pitch = clamp(+s.pitch || 0, -PITCH_SNAP, PITCH_SNAP);
  o.dist = s.dist > 0 ? s.dist : o.dist;
  o.target = s.target.slice(0, 3).map(Number);
  if (s.speed > 0) o.speed = clamp(s.speed, SPEED_MIN, SPEED_MAX);
  if (s.fov > 0) o.fov = s.fov;
  return true;
}

/** Half the height of the ortho view: what a perspective view shows at the target. */
function orthoHalf(o) {
  return o.dist * Math.tan(o.fov * Math.PI / 360);
}

const api = { MODES, PITCH, SPEED_MIN, SPEED_MAX, create, eye, axes, lookFrom,
              orbitBy, look, fling, pan, wheel, flySpeed, step, setMode, snap,
              fromPose, aimAt, save, restore, orthoHalf };
if (typeof module !== 'undefined') module.exports = api;
if (typeof window !== 'undefined') window.TraptCamCtl = api;
})();
