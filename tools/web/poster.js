/**
 * A still from a cutscene, rendered by the page that plays it.
 *
 * `site.py` gets its gallery posters from `pdiag.py`, which rasterises an
 * exported bundle offline.  Here the renderer is already on screen, so a
 * poster is the same scene assembled, posed at one frame, drawn into the
 * 512x224 target and read back.
 *
 * That costs a second or two each, which is fine on demand and absurd for all
 * 149 at once -- so this is a queue: it renders what the page asks for, one
 * at a time, and only while nothing is playing.  Everything it builds is
 * disposed straight away, because 149 undisposed scenes is a GPU memory leak
 * the size of the disc.
 */
(function () {
'use strict';

const req = (typeof require !== 'undefined');
const playMod = req ? require('./play.js') : window.TraptPlay;

/** Free every buffer and texture a built scene put on the GPU. */
function dispose(built) {
  built.root.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      const m = o.material;
      if (m.uniforms && m.uniforms.map && m.uniforms.map.value)
        m.uniforms.map.value.dispose();
      if (m.map) m.map.dispose();
      m.dispose();
    }
  });
  for (const t of built.textures.values()) if (t) t.dispose();
}

/**
 * Render `name` at its own frame into `rt` and return the pixels.
 *
 * `view` supplies the renderer, the scene and the camera the page already
 * has; the scene's own contents are put back before returning, so this can
 * run between cutscenes without disturbing what is on screen.
 */
async function render(THREE, disc, view, name, frame) {
  const built = await playMod.assemble(THREE, disc, name);
  const at = frame === undefined || frame === null
    ? Math.round(built.scene.duration / 2) : frame;
  const r = playMod.poseAt(built, at);

  const prev = view.group;
  if (prev) view.scene.remove(prev);
  view.scene.add(built.root);

  const cam = view.camera;
  const keepFov = cam.fov, keepAspect = cam.aspect;
  if (r.camera) {
    const p = r.camera.position, t = r.camera.target;
    if (p) cam.position.set(p[0], p[1], p[2]);
    if (t) cam.lookAt(t[0], t[1], t[2]);
    if (r.camera.fov) cam.fov = r.camera.fov;
  }
  cam.aspect = view.posterAspect;
  cam.updateProjectionMatrix();
  view.key.position.copy(cam.position);
  view.group = built.root;             // so the eye uniform is written
  if (view.setEye) view.setEye();

  const rt = view.rt;
  view.renderer.setRenderTarget(rt);
  view.renderer.clear();
  view.renderer.render(view.scene, cam);
  const pixels = new Uint8Array(rt.width * rt.height * 4);
  view.renderer.readRenderTargetPixels(rt, 0, 0, rt.width, rt.height, pixels);
  view.renderer.setRenderTarget(null);

  view.scene.remove(built.root);
  view.group = prev;
  if (prev) view.scene.add(prev);
  cam.fov = keepFov;
  cam.aspect = keepAspect;
  cam.updateProjectionMatrix();

  const info = {
    width: rt.width, height: rt.height, pixels: pixels,
    room: built.scene.room, frame: at,
  };
  dispose(built);
  return info;
}

/**
 * A one-at-a-time queue.  `canRun()` gates it -- the page says no while a
 * cutscene is playing, because a poster borrows the renderer.
 */
function queue(canRun) {
  const pending = [];
  let running = false;
  async function pump() {
    if (running || !pending.length) return;
    if (!canRun()) { setTimeout(pump, 500); return; }
    running = true;
    const job = pending.shift();
    try {
      job.resolve(await job.work());
    } catch (e) {
      job.reject(e);
    }
    running = false;
    setTimeout(pump, 0);
  }
  return {
    add(work) {
      return new Promise((resolve, reject) => {
        pending.push({ work, resolve, reject });
        pump();
      });
    },
    get depth() { return pending.length + (running ? 1 : 0); },
    clear() { pending.length = 0; },
  };
}

/** RGBA from a render target is bottom-up; put it into a canvas the right way. */
function toCanvas(shot) {
  const cv = document.createElement('canvas');
  cv.width = shot.width; cv.height = shot.height;
  const img = new ImageData(shot.width, shot.height);
  const row = shot.width * 4;
  for (let y = 0; y < shot.height; y++) {
    const src = (shot.height - 1 - y) * row;
    img.data.set(shot.pixels.subarray(src, src + row), y * row);
  }
  for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
  cv.getContext('2d').putImageData(img, 0, 0);
  return cv;
}

const api = { render, queue, dispose, toCanvas };
if (typeof module !== 'undefined') module.exports = api;
if (typeof window !== 'undefined') window.TraptPoster = api;
})();
