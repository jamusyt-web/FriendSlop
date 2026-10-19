// Renders a replay (tools/clips/record.mjs) to an MP4, frame by frame. Headless Chromium plays the built client
// (dist/) with ?replay=…&capture=1: the game clock stands still and each frame is window.__capture.step(1/fps) plus a
// screenshot, so motion is perfectly smooth however slowly the frames render. The soundtrack mixes the game's own
// sounds (same positional gain / pan / pitch as in the game, heard from the followed player) from the same run.
// Frames can be split across Chromium processes: each one plays the replay from the start and draws only its part,
// with Math.random reseeded every frame so all of them see exactly the same game.
//
//   node tools/clips/capture.mjs marketing/replays/factory1.json --start 20 --end 32
//     [--out marketing/clips/<name>.mp4] [--width 1920] [--height 1080] [--fps 60] [--follow auto|<name>]
//     [--fp] [--nohud] [--feed] [--dist 0.7] [--workers 1..3, default 2] [--keep-frames] [--no-audio]
//   node tools/clips/capture.mjs marketing/replays/factory1.json --serve [--port 4173]   (watch it in a browser)
//
// Needs `npm run build` (dist/), ffmpeg and Playwright with Chromium (not a project dependency: a global install
// works, or PLAYWRIGHT=/path/to/node_modules/playwright).

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIST = path.join(ROOT, 'dist');
const ASSETS = path.join(ROOT, 'client/public/assets');
const SR = 48000; // audio sample rate
const MASTER = 0.8; // soundtrack volume (the game's default is 0.7)
const GL_ARGS = ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']; // works without a GPU

const argv = process.argv.slice(2);
const arg = (k, d) => (argv.includes('--' + k) ? argv[argv.indexOf('--' + k) + 1] : d);
const flag = (k) => argv.includes('--' + k);
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

const replayFile = argv[0] && !argv[0].startsWith('--') ? path.resolve(argv[0]) : fail('usage: capture.mjs <replay.json> --start s --end s [options] (see the top of this file)');
if (!fs.existsSync(path.join(DIST, 'index.html'))) fail('no dist/ — run `npm run build` first');
const rec = JSON.parse(fs.readFileSync(replayFile, 'utf8'));
const fps = Number(arg('fps', 60));
const width = Number(arg('width', 1920));
const height = Number(arg('height', 1080));
const k0 = Math.max(1, Math.round(Number(arg('start', 0)) * fps)); // frame k shows replay time k / fps
const k1 = Math.round(Math.min(Number(arg('end', rec.duration)), rec.duration) * fps);
const workers = Math.max(1, Math.min(3, Number(arg('workers', 2)))); // 2 is ~10% faster than 1 on 4 cores (SwiftShader already uses them all)
const follow = arg('follow', 'auto');
const view = { fp: flag('fp'), nohud: flag('nohud'), feed: flag('feed') };
const dist = arg('dist'); // third-person camera distance multiplier, e.g. 0.7 for closer vertical shots
const clipName = path.basename(replayFile, '.json') + `-${(k0 / fps).toFixed(1)}-${(k1 / fps).toFixed(1)}` + (follow !== 'auto' ? `-${follow}` : '') + (view.fp ? '-fp' : '');
const outFile = path.resolve(arg('out', path.join(ROOT, 'marketing/clips', clipName.replace(/[^\w.-]+/g, '_') + '.mp4')));
const framesDir = path.join(ROOT, 'marketing/frames', path.basename(outFile, '.mp4'));

// ---------- static server: dist/ + the replay at /replay.json ----------
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.glb': 'model/gltf-binary', '.ogg': 'audio/ogg', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function serve(port) {
  const srv = http.createServer((req, res) => {
    let p;
    try {
      p = decodeURIComponent((req.url || '/').split('?')[0]);
    } catch {
      return res.writeHead(400).end();
    }
    const file = p === '/replay.json' ? replayFile : path.join(DIST, path.normalize(p === '/' ? '/index.html' : p));
    if (file !== replayFile && !file.startsWith(DIST + path.sep)) return res.writeHead(404).end();
    fs.readFile(file, (err, data) => {
      if (err) return res.writeHead(404).end();
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(data);
    });
  });
  return new Promise((resolve) => srv.listen(port, '127.0.0.1', () => resolve(srv)));
}
const query = (capture) => {
  const q = new URLSearchParams({ replay: '/replay.json' });
  if (capture) q.set('capture', '1');
  if (follow !== 'auto') q.set('follow', follow);
  for (const [k, on] of Object.entries(view)) if (on) q.set(k, '1');
  if (dist) q.set('dist', dist);
  return '/?' + q;
};

// ---------- capture ----------
async function capture() {
  if (!(k1 > k0)) fail(`nothing to capture: --start/--end must be inside the replay (0..${rec.duration} s)`);
  const { chromium } = loadPlaywright();
  const srv = await serve(0);
  const url = `http://127.0.0.1:${srv.address().port}${query(true)}`;
  fs.rmSync(framesDir, { recursive: true, force: true });
  fs.mkdirSync(framesDir, { recursive: true });
  const n = k1 - k0;
  console.log(`${clipName}: ${n} frames ${width}x${height}@${fps} (replay ${(k0 / fps).toFixed(2)}–${(k1 / fps).toFixed(2)} s), ${workers} worker(s)`);
  for (const [t, text] of rec.timeline || []) if (t >= k0 / fps - 1 && t <= k1 / fps) console.log(`  ${t.toFixed(1).padStart(6)}s  ${text}`);

  const started = performance.now();
  let done = 0;
  const chunk = Math.ceil(n / workers);
  const parts = [];
  for (let w = 0; w < workers; w++) {
    const a = k0 + w * chunk;
    const b = Math.min(k1, a + chunk);
    if (a < b) parts.push(renderPart(chromium, url, a, b, w === 0 ? 3 : 0, () => {
      if (++done % 30 === 0 || done === n) {
        const s = (performance.now() - started) / 1000;
        console.log(`  ${done}/${n} frames, ${(s / done).toFixed(2)} s/frame (all workers), ${(((n - done) * s) / done).toFixed(0)} s left`);
      }
    }));
  }
  let sounds;
  try {
    sounds = (await Promise.all(parts)).flat();
  } finally {
    srv.close();
  }
  const secs = (performance.now() - started) / 1000;
  console.log(`rendered in ${secs.toFixed(0)} s (${(secs / n).toFixed(2)} s/frame)`);
  if (fs.statSync(path.join(framesDir, '00000.png')).size < 20000) console.warn('warning: the first frame looks blank (no WebGL?)');

  // encode (+ soundtrack)
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const audioFile = path.join(framesDir, 'audio.f32');
  const audio = !flag('no-audio');
  if (audio) mixAudio(sounds, k0 / fps, n / fps, audioFile);
  const ff = spawnSync('ffmpeg', [
    '-y', '-v', 'error', '-framerate', String(fps), '-i', path.join(framesDir, '%05d.png'),
    ...(audio ? ['-f', 'f32le', '-ar', String(SR), '-ac', '2', '-i', audioFile] : []),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(fps),
    ...(audio ? ['-c:a', 'aac', '-b:a', '192k', '-shortest'] : []),
    '-movflags', '+faststart', outFile,
  ], { stdio: 'inherit' });
  if (ff.status !== 0) fail('ffmpeg failed (frames kept in ' + framesDir + ')');
  if (!flag('keep-frames')) fs.rmSync(framesDir, { recursive: true, force: true });
  console.log(`saved ${path.relative(process.cwd(), outFile)}${flag('keep-frames') ? ` (frames in ${path.relative(process.cwd(), framesDir)})` : ''}`);
}

// Playwright isn't a project dependency: a global install (NODE_PATH) or PLAYWRIGHT=<path to the package>
function loadPlaywright() {
  const require = createRequire(import.meta.url);
  for (const id of [process.env.PLAYWRIGHT, 'playwright'].filter(Boolean)) {
    try {
      return require(id);
    } catch {
      // try the next one
    }
  }
  fail('needs Playwright + Chromium: `npm i -g playwright && npx playwright install chromium`, or PLAYWRIGHT=/path/to/node_modules/playwright');
}

// Same seeded Math.random in every process; __seed(k) restarts it for frame k (whatever was drawn before).
const SEED = `(() => {
  let s = 1;
  Math.random = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  window.__seed = (k) => { s = Math.imul(k, 0x9e3779b1) | 0; };
})();`;

// One Chromium: plays the replay up to frame a without drawing, then draws + screenshots frames a..b-1.
// Returns the sounds played from frame a on (and `preroll` s before, so sounds already ringing at the cut are in).
async function renderPart(chromium, url, a, b, preroll, onFrame) {
  const browser = await chromium.launch({ args: GL_ARGS });
  try {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    page.on('pageerror', (e) => console.error(`[page error] ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && console.error(`[console] ${m.text()}`));
    const cdp = await page.context().newCDPSession(page); // its fast PNG screenshots beat page.screenshot's
    await page.addInitScript(SEED);
    await page.goto(url);
    await page.waitForFunction(() => window.__capture?.ready, null, { timeout: 120000 });
    await page.evaluate(() => Promise.all([document.fonts.load('bold 60px Fredoka'), document.fonts.load('40px "Luckiest Guy"')]));
    const dt = 1 / fps;
    for (let k = 1; k < a; k += 600) {
      await page.evaluate(({ from, to, dt }) => {
        for (let i = from; i < to; i++) {
          window.__seed(i);
          window.__capture.step(dt, false);
        }
      }, { from: k, to: Math.min(a, k + 600), dt });
    }
    for (let k = a; k < b; k++) {
      await page.evaluate(({ k, dt }) => {
        window.__seed(k);
        window.__capture.step(dt);
      }, { k, dt });
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true });
      fs.writeFileSync(path.join(framesDir, String(k - k0).padStart(5, '0') + '.png'), Buffer.from(data, 'base64'));
      onFrame();
    }
    const sounds = await page.evaluate(() => window.__capture.sounds);
    return sounds.filter(([t]) => t > (a - 0.5) / fps - preroll);
  } finally {
    await browser.close();
  }
}

// ---------- soundtrack ----------
// sounds: [t s, sfx name, gain, pan -1..1, rate] (what the game's audio.play would have played); t0: clip start
function mixAudio(sounds, t0, seconds, file) {
  const manifest = JSON.parse(fs.readFileSync(path.join(ASSETS, 'assets.json'), 'utf8')).sfx || {};
  const bufs = {};
  const n = Math.ceil(seconds * SR);
  const mix = new Float32Array(n * 2);
  for (const [t, name, gain, pan, rate] of sounds) {
    if (!manifest[name]) continue;
    const src = (bufs[name] ??= decode(path.join(ASSETS, manifest[name])));
    const x = ((pan + 1) / 2) * (Math.PI / 2); // equal-power pan, like a StereoPannerNode on a mono sound
    const [gl, gr] = [Math.cos(x) * gain * MASTER, Math.sin(x) * gain * MASTER];
    const start = Math.round((t - t0) * SR);
    const len = Math.floor((src.length - 1) / rate);
    for (let j = Math.max(0, -start); j < len && start + j < n; j++) {
      const p = j * rate; // playback rate = pitch + speed, linear interpolation
      const i = Math.floor(p);
      const v = src[i] + (src[i + 1] - src[i]) * (p - i);
      mix[(start + j) * 2] += v * gl;
      mix[(start + j) * 2 + 1] += v * gr;
    }
  }
  // soft-limit peaks instead of clipping
  for (let i = 0; i < mix.length; i++) {
    const v = mix[i];
    const a = Math.abs(v);
    if (a > 0.8) mix[i] = Math.sign(v) * (0.8 + 0.2 * Math.tanh((a - 0.8) / 0.2));
  }
  fs.writeFileSync(file, Buffer.from(mix.buffer));
}

// any sound file -> mono Float32Array at SR
function decode(file) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'f32le', '-ac', '1', '-ar', String(SR), '-'], { maxBuffer: 1 << 28 });
  if (r.status !== 0) fail(`ffmpeg couldn't decode ${file}`);
  return new Float32Array(new Uint8Array(r.stdout).buffer);
}

// ---------- main ----------
if (flag('serve')) {
  const port = Number(arg('port', 4173));
  await serve(port);
  console.log(`watch the replay (real time): http://localhost:${port}${query(false)}\nCtrl+C to stop`);
} else await capture();
