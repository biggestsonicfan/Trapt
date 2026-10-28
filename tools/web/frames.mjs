/**
 * Render cutscene frames with the real page, for `tools/grade.py --browser`.
 *
 *   node tools/web/frames.mjs DISC.iso OUT_DIR e001:7422 e004:2129 ...
 *
 * `pdiag.py` is a port of the shader; this is the page itself.  It opens
 * `pick.html` in headless Chrome, hands it the disc the way a visitor does,
 * opens each cutscene, stops it on the asked-for frame with PS2 mode and the
 * game's own subtitle font on, and reads the 512x224 render target back --
 * the GS framebuffer the page draws into, before the post pass scales it.
 * Each frame lands in OUT_DIR as `<scene>-<frame>.rgba`: 512*224*4 bytes,
 * top row first.  Sprite effects, the letterbox and the subtitles are all in
 * it, which is the point: the port draws none of the effects.
 *
 * WebGL runs on SwiftShader, so no GPU is needed and the output does not
 * depend on one.  Exits non-zero, naming the frame, if any frame fails.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const [iso, out, ...wanted] = process.argv.slice(2);
if (!iso || !out || !wanted.length) {
  console.error('usage: node frames.mjs DISC.iso OUT_DIR scene:frame ...');
  process.exit(2);
}
fs.mkdirSync(out, { recursive: true });

// The page loads its modules by relative URL -- three.js from ../vendor --
// so serve tools/ rather than open the page from file://.
const TYPES = { '.html': 'text/html', '.js': 'text/javascript',
                '.mjs': 'text/javascript', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(ROOT, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end(); return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'trapt-frames-'));
const chrome = spawn('google-chrome', ['--headless=new', '--no-sandbox',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--user-data-dir=' + ud, '--remote-debugging-port=0',
  '--window-size=1280,1600', '--autoplay-policy=no-user-gesture-required',
  'about:blank'], { stdio: 'ignore', detached: true, env: { ...process.env, TMPDIR: ud } });
// Chrome writes into its profile until it has exited -- its helpers too,
// after the browser process has gone -- so the whole process group is
// stopped, and the profile removed until it stays removed.
const gone = new Promise((r) => chrome.once('exit', r));
const finish = async (code) => {
  server.close();
  const within = (ms) => Promise.race([gone.then(() => true),
                                       new Promise((r) => setTimeout(() => r(false), ms))]);
  const group = (sig) => { try { process.kill(-chrome.pid, sig); } catch {} };
  group('SIGTERM');
  if (!(await within(5000))) { group('SIGKILL'); await within(5000); }
  group('SIGKILL');                       // stragglers in the group
  for (let i = 0; i < 20 && fs.existsSync(ud); i++) {
    try { fs.rmSync(ud, { recursive: true, force: true }); } catch {}
    await sleep(250);
  }
  process.exit(code);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let devPort;
for (let i = 0; i < 200 && !devPort; i++) {
  try { devPort = fs.readFileSync(ud + '/DevToolsActivePort', 'utf8').split('\n')[0]; } catch {}
  await sleep(100);
}
if (!devPort) { console.error('chrome did not start'); await finish(1); }
const targets = await (await fetch(`http://127.0.0.1:${devPort}/json`)).json();
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.onopen = r);
let id = 0;
const wait = new Map();
const errors = [];
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); }
  if (d.method === 'Runtime.exceptionThrown')
    errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
};
const send = (method, params = {}) => new Promise((r) => {
  const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params }));
});
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails)
    throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  return r.result?.result?.value;
};

await send('Runtime.enable'); await send('Page.enable'); await send('DOM.enable');
await send('Page.navigate', { url: `http://127.0.0.1:${port}/web/pick.html?lang=en` });
// The input has a change handler only once the page's scripts have run.
for (let i = 0; i < 200; i++) {
  if (await ev('document.readyState === "complete" && typeof load === "function"').catch(() => false)) break;
  await sleep(100);
}
await sleep(500);
const doc = await send('DOM.getDocument');
const q = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#file' });
await send('DOM.setFileInputFiles', { nodeId: q.result.nodeId, files: [path.resolve(iso)] });
for (let i = 0; i < 600; i++) {
  if (await ev('!!(DISC && FONT)').catch(() => false)) break;
  await sleep(250);
}
if (!(await ev('!!(DISC && FONT)'))) {
  console.error('the page did not open the disc', errors.join('\n'));
  await finish(1);
}

// One frame, rendered on demand rather than by the page's own clock: stop
// playback, pin PS2 mode and the game font, pose, draw, read the target.
const GRAB = `async (name, frame) => {
  if (!S || S.name !== name) {
    // what a gallery card does when it is the first thing clicked
    if (!document.getElementById('transport')) routeViewport();
    await playScene(name);
  }
  S.playing = false;
  if (!V.ps2) setPs2(true);
  if (!V.subsPs2) setSubsPs2(true);
  S.frame = frame; S.seeked = true;
  applySceneFrame();
  drawFrame();
  const W = V.rt.width, H = V.rt.height;
  const px = new Uint8Array(W * H * 4);
  V.renderer.readRenderTargetPixels(V.rt, 0, 0, W, H, px);
  // GL reads bottom row first; the file is top row first, like a PNG
  const flip = new Uint8Array(px.length);
  for (let y = 0; y < H; y++)
    flip.set(px.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
  let s = '';
  for (let i = 0; i < flip.length; i += 0x8000)
    s += String.fromCharCode.apply(null, flip.subarray(i, i + 0x8000));
  return { w: W, h: H, data: btoa(s) };
}`;

let failed = 0;
for (const spec of wanted) {
  const [name, f] = spec.split(':');
  try {
    const got = await ev(`(${GRAB})(${JSON.stringify(name)}, ${Number(f)})`);
    if (!got || got.w !== 512 || got.h !== 224) throw new Error('target is ' + (got && got.w) + 'x' + (got && got.h));
    fs.writeFileSync(path.join(out, `${name}-${Number(f)}.rgba`), Buffer.from(got.data, 'base64'));
    console.log('frame', name, f);
  } catch (err) {
    failed++;
    console.error('FAILED', spec, err.message);
  }
}
if (errors.length) console.error('page errors:\n' + errors.join('\n'));
await finish(failed ? 1 : 0);
