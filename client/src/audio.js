// WebAudio sfx. Buffers are decoded up front; the AudioContext is created on the first user gesture
// (browsers block audio before that). Missing sfx names are silently ignored.

const buffers = {};
let ctx = null;
let master = null;
let volume = 0.7;
const listener = { x: 0, y: 0, z: 0, rx: 1, rz: 0 };
const lastPlayed = {};

export async function loadSfx(manifest, base) {
  const decoder = new OfflineAudioContext(1, 1, 44100);
  await Promise.all(
    Object.entries(manifest || {}).map(async ([name, file]) => {
      try {
        const res = await fetch(base + file);
        if (!res.ok) throw new Error(res.status);
        buffers[name] = await decoder.decodeAudioData(await res.arrayBuffer());
      } catch {
        console.warn(`sfx "${name}" missing (${file})`);
      }
    }),
  );
}

function unlock() {
  if (!ctx) {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = volume;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
}
for (const ev of ['pointerdown', 'keydown']) addEventListener(ev, unlock, { capture: true });

export function setVolume(v) {
  volume = v;
  if (master) master.gain.value = v;
}

// pos: {x,y,z} of the listener; right: camera right vector (for stereo pan)
export function setListener(pos, right) {
  listener.x = pos.x;
  listener.y = pos.y;
  listener.z = pos.z;
  listener.rx = right.x;
  listener.rz = right.z;
}

// opts: volume, rate (pitch), at {x,y,z} for distance falloff + pan, jitter (random pitch range)
export function play(name, opts = {}) {
  const buf = buffers[name];
  if (!buf || !ctx || ctx.state !== 'running') return;
  const now = ctx.currentTime;
  if (lastPlayed[name] && now - lastPlayed[name] < 0.03) return; // avoid stacking the same sound
  lastPlayed[name] = now;

  let gain = opts.volume ?? 1;
  let pan = 0;
  if (opts.at) {
    const dx = opts.at.x - listener.x;
    const dy = opts.at.y - listener.y;
    const dz = opts.at.z - listener.z;
    const d = Math.hypot(dx, dy, dz);
    gain *= Math.max(0.12, 1 - d / 45);
    if (d > 0.5) pan = Math.max(-0.8, Math.min(0.8, (dx * listener.rx + dz * listener.rz) / d));
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const jitter = opts.jitter ?? 0.08;
  src.playbackRate.value = (opts.rate ?? 1) * (1 + (Math.random() * 2 - 1) * jitter);
  const g = ctx.createGain();
  g.gain.value = gain;
  const p = ctx.createStereoPanner();
  p.pan.value = pan;
  src.connect(g).connect(p).connect(master);
  src.start();
}
