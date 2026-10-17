// Character visuals for one player: model + animation crossfades, squash & stretch, name tag,
// IT bomb/glow, shield bubble, frozen ice, ghost, boost trail, blob shadow, LIGHTS OUT light,
// and snapshot interpolation for remote players.
import * as THREE from 'three';
import { PLAYER } from '../../shared/config.js';
import { makeCharacter } from './assets.js';
import { glowTex } from './world.js';
import { groundBelow } from './physics.js';

const INTERP_DELAY = 100; // ms behind newest snapshot
const RED = new THREE.Color(0xff1030);
const ICE = new THREE.Color(0xaee9ff);
const ICE_EMIT = new THREE.Color(0x2a8fd0);
const AIR = new Set(['jump', 'fall', 'dive']);
const ANIM_FALLBACK = {
  idle: ['idle'],
  run: ['run', 'idle'],
  jump: ['jump', 'fall', 'idle'],
  fall: ['fall', 'jump', 'idle'],
  dive: ['dive', 'fall', 'jump', 'idle'],
  slip: ['hit', 'fall', 'idle'],
  dance: ['dance', 'idle'],
};

// shared geometry/materials
const bombGeo = new THREE.SphereGeometry(0.3, 24, 16);
const capGeo = new THREE.CylinderGeometry(0.09, 0.11, 0.12, 12);
const fuseGeo = new THREE.CylinderGeometry(0.025, 0.025, 0.22, 6);
const shineGeo = new THREE.SphereGeometry(0.07, 8, 6);
const bubbleGeo = new THREE.SphereGeometry(1, 32, 20);
const iceGeo = new THREE.BoxGeometry(1.15, 2.0, 1.15);
const blobGeo = new THREE.PlaneGeometry(1.3, 1.3).rotateX(-Math.PI / 2);
const ringGeo = new THREE.RingGeometry(0.75, 1.0, 40).rotateX(-Math.PI / 2);
const capMat = new THREE.MeshStandardMaterial({ color: 0x777788, metalness: 0.6, roughness: 0.3 });
const fuseMat = new THREE.MeshStandardMaterial({ color: 0xc98a4b, roughness: 0.9 });
const shineMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
const bubbleMat = new THREE.MeshStandardMaterial({ color: 0x9fe9ff, emissive: 0x3fb6ff, emissiveIntensity: 0.5, transparent: true, opacity: 0.28, roughness: 0.05, depthWrite: false });
const iceMat = new THREE.MeshStandardMaterial({ color: 0xc8f3ff, emissive: 0x5fd0ff, emissiveIntensity: 0.3, transparent: true, opacity: 0.5, roughness: 0.05, depthWrite: false });
const blobTex = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(0,0,0,0.8)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
})();

const lerpAngle = (a, b, k) => {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
};

function nameTag(name, color) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 128;
  const g = c.getContext('2d');
  g.font = 'bold 60px Fredoka, "Trebuchet MS", sans-serif';
  const w = Math.min(500, g.measureText(name).width + 70);
  const x = (512 - w) / 2;
  g.fillStyle = 'rgba(31,22,64,0.85)';
  g.beginPath();
  g.roundRect(x, 20, w, 88, 44);
  g.fill();
  g.lineWidth = 8;
  g.strokeStyle = '#' + color.toString(16).padStart(6, '0');
  g.stroke();
  g.fillStyle = '#ffffff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(name, 256, 67, 470);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false }));
  sprite.scale.set(2.2, 0.55, 1);
  sprite.renderOrder = 10;
  return sprite;
}

export class PlayerView {
  constructor({ scene, world, effects }, info, isSelf) {
    this.scene = scene;
    this.world = world;
    this.effects = effects;
    this.id = info.id;
    this.name = info.name;
    this.color = info.color;
    this.isSelf = isSelf;
    this.buffer = [];
    this.anim = 'idle';
    this.forcedAnim = null;
    this.current = null;
    this.sq = 1;
    this.sqv = 0;
    this.scale = 1;
    this.time = Math.random() * 10;
    this.state = { it: false, fx: [], score: 0, item: null };
    this.ghostAlpha = 1;

    this.root = new THREE.Group();
    this.body = new THREE.Group();
    this.squash = new THREE.Group();
    this.root.add(this.body);
    this.body.add(this.squash);
    this.char = makeCharacter(info.color);
    this.squash.add(this.char.model);

    if (!isSelf) {
      this.tag = nameTag(info.name, info.color);
      this.tag.position.y = PLAYER.height + 0.5;
      this.root.add(this.tag);
    }

    // bomb over IT's head
    this.bombMat = new THREE.MeshStandardMaterial({ color: 0x1d1d2b, roughness: 0.25, metalness: 0.2, emissive: 0xff0000, emissiveIntensity: 0 });
    this.bomb = new THREE.Group();
    const ball = new THREE.Mesh(bombGeo, this.bombMat);
    ball.castShadow = true;
    const cap = new THREE.Mesh(capGeo, capMat);
    cap.position.y = 0.3;
    const fuse = new THREE.Mesh(fuseGeo, fuseMat);
    fuse.position.set(0.04, 0.42, 0);
    fuse.rotation.z = -0.4;
    const shine = new THREE.Mesh(shineGeo, shineMat);
    shine.position.set(-0.13, 0.13, 0.22);
    this.spark = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xffc040, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.spark.position.set(0.09, 0.54, 0);
    this.spark.scale.setScalar(0.35);
    this.bomb.add(ball, cap, fuse, shine, this.spark);
    this.bomb.visible = false;
    this.body.add(this.bomb);

    this.glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xff2040, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    this.glow.position.y = 0.95;
    this.glow.scale.setScalar(2.8);
    this.glow.visible = false;
    this.body.add(this.glow);

    this.bubble = new THREE.Mesh(bubbleGeo, bubbleMat);
    this.bubble.position.y = 0.9;
    this.bubble.visible = false;
    this.body.add(this.bubble);

    this.ice = new THREE.Mesh(iceGeo, iceMat);
    this.ice.position.y = 0.98;
    this.ice.visible = false;
    this.body.add(this.ice);

    // ground-anchored bits: blob shadow + IT ring
    this.ground = new THREE.Group();
    this.blob = new THREE.Mesh(blobGeo, new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false, opacity: 0.35, polygonOffset: true, polygonOffsetFactor: -2 }));
    this.ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xff1a3c, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3 }));
    this.ring.visible = false;
    this.ground.add(this.blob, this.ring);

    this.light = world.takeLight();
    scene.add(this.root, this.ground);
    this.playAnim('idle');
  }

  dispose() {
    this.scene.remove(this.root, this.ground);
    this.world.returnLight(this.light);
    this.char.mixer?.stopAllAction();
    for (const w of this.char.mats) w.mat.dispose();
    for (const m of [this.bombMat, this.glow.material, this.spark.material, this.blob.material, this.ring.material]) m.dispose();
    if (this.tag) {
      this.tag.material.map.dispose();
      this.tag.material.dispose();
    }
  }

  // ---------- networking (remote players) ----------
  push(now, p, ry, a) {
    const b = this.buffer;
    const last = b[b.length - 1];
    if (last && Math.hypot(p[0] - last.x, p[1] - last.y, p[2] - last.z) > 8) b.length = 0; // teleport: no lerp
    b.push({ t: now, x: p[0], y: p[1], z: p[2], ry, a });
    if (b.length > 30) b.shift();
  }

  sample(now, dt) {
    const b = this.buffer;
    if (!b.length) return;
    const rt = now - INTERP_DELAY;
    while (b.length >= 2 && b[1].t <= rt) b.shift();
    const a = b[0];
    const c = b[1];
    let x = a.x;
    let y = a.y;
    let z = a.z;
    let ry = a.ry;
    let anim = a.a;
    if (c && rt > a.t) {
      const k = Math.min(1, (rt - a.t) / Math.max(1, c.t - a.t));
      x += (c.x - a.x) * k;
      y += (c.y - a.y) * k;
      z += (c.z - a.z) * k;
      ry = lerpAngle(a.ry, c.ry, k);
      anim = k < 0.5 ? a.a : c.a;
    }
    const r = this.root;
    const far = Math.hypot(x - r.position.x, y - r.position.y, z - r.position.z) > 6 || !this.placed;
    if (far) r.position.set(x, y, z);
    else {
      const k = Math.min(1, dt * 20);
      r.position.x += (x - r.position.x) * k;
      r.position.y += (y - r.position.y) * k;
      r.position.z += (z - r.position.z) * k;
    }
    this.placed = true;
    r.rotation.y = lerpAngle(r.rotation.y, ry, Math.min(1, dt * 16));
    this.setAnim(anim || 'idle');
  }

  // ---------- animation ----------
  setAnim(a) {
    if (a === this.anim) return;
    const prev = this.anim;
    this.anim = a;
    if (!this.isSelf) {
      // derive juice for remote players from anim transitions
      if (a === 'jump' && !AIR.has(prev)) this.stretch(1);
      if (!AIR.has(a) && a !== 'slip' && AIR.has(prev)) this.land(9);
    }
  }

  playAnim(name) {
    const actions = this.char.actions;
    const key = (ANIM_FALLBACK[name] || [name]).find((k) => actions[k]) || null;
    if (key === this.current && !this.restart) return;
    this.restart = false;
    const next = key && actions[key];
    const prev = this.current && actions[this.current];
    this.current = key;
    if (!next) return;
    if (prev === next) {
      next.reset().play();
      return;
    }
    next.reset();
    next.enabled = true;
    next.setEffectiveTimeScale(1);
    next.setEffectiveWeight(1);
    next.play();
    if (prev) next.crossFadeFrom(prev, 0.15, false);
  }

  // play a one-shot clip (e.g. punch) over the current animation, then return to it
  playOnce(name) {
    const action = this.char.actions[name];
    this.oneShot = name;
    this.oneShotUntil = this.time + (action ? action.getClip().duration * 0.95 : 0.35);
    this.restart = true; // restart even if the same clip is already showing
  }

  stretch(amount = 1) {
    this.sqv += 7 * amount;
  }

  land(speed) {
    const k = Math.min(1, speed / 20);
    this.sqv -= 4 + 10 * k;
    if (speed > 6) {
      const p = this.root.position;
      this.effects.burst({ x: p.x, y: p.y + 0.05, z: p.z }, {
        count: Math.round(6 + 10 * k), colors: [0xffffff, 0xe8e0d0], speed: 3 + 4 * k, up: 0.5, size: 0.35, endSize: 0.6, flat: true, gravity: 0, drag: 4, life: 0.5,
      });
    }
  }

  // ---------- per frame ----------
  // ctx: { now, scale, fuse, darkness, dancing }
  update(dt, ctx) {
    this.time += dt;
    const st = this.state;
    const fx = st.fx || [];
    const frozen = fx.includes('frozen') && !ctx.countdown; // everyone is frozen during the countdown
    const ghost = fx.includes('ghost');
    const shield = fx.includes('shield');
    const boost = fx.includes('boost');
    const t = this.time;

    // chaos scale
    this.scale += (ctx.scale - this.scale) * Math.min(1, dt * 6);
    this.body.scale.setScalar(this.scale);

    // squash & stretch spring (substepped for stability)
    for (let left = dt; left > 0; left -= 1 / 60) {
      const h = Math.min(left, 1 / 60);
      this.sqv += (-(this.sq - 1) * 320 - this.sqv * 13) * h;
      this.sq = Math.min(1.6, Math.max(0.5, this.sq + this.sqv * h));
    }
    const side = 1 / Math.sqrt(this.sq);
    this.squash.scale.set(side, this.sq, side);

    // animation
    if (this.oneShot && this.time > this.oneShotUntil) this.oneShot = null;
    const anim = this.forcedAnim || this.oneShot || this.anim;
    this.playAnim(anim);
    if (this.char.mixer) this.char.mixer.update(frozen ? 0 : dt * (anim === 'run' && ctx.runRate ? ctx.runRate : 1));
    if (this.char.parts) this.beanAnim(anim, frozen ? 0 : dt);

    // visibility: ghosts vanish for others, go translucent for yourself
    const hidden = ghost && !this.isSelf;
    this.root.visible = !hidden && (this.isSelf || !!this.placed);
    this.ground.visible = this.root.visible;
    const targetAlpha = ghost && this.isSelf ? 0.35 : 1;
    this.ghostAlpha += (targetAlpha - this.ghostAlpha) * Math.min(1, dt * 8);

    // IT: bomb, glow, ring, red pulse
    const fuse = ctx.fuse ?? 10;
    const blinkHz = Math.min(12, Math.max(1.2, 14 / Math.max(0.6, fuse)));
    const blink = st.it ? (Math.sin(t * blinkHz * Math.PI * 2) > 0 ? 1 : 0) : 0;
    const pulse = st.it ? 0.35 + 0.25 * Math.sin(t * 8) : 0;
    this.bomb.visible = st.it;
    this.glow.visible = st.it && !this.isSelf; // your own glow would wash out the camera view
    this.ring.visible = st.it;
    if (st.it) {
      this.bomb.position.set(0, PLAYER.height + 0.55 + Math.sin(t * 5) * 0.06, 0);
      this.bomb.rotation.set(Math.sin(t * 3) * 0.2, t * 1.5, Math.sin(t * 4) * 0.2);
      this.bombMat.emissiveIntensity = blink * 2.5;
      this.spark.scale.setScalar(0.25 + Math.random() * 0.25);
      this.glow.material.opacity = 0.15 + pulse * 0.45;
      this.ring.material.opacity = 0.55 + 0.3 * Math.sin(t * 8);
      this.ring.scale.setScalar(this.scale * (1 + 0.15 * Math.sin(t * 8)));
    }
    if (this.tag) {
      const ty = (PLAYER.height + (st.it ? 1.25 : 0.5)) * this.scale;
      this.tag.position.y += (ty - this.tag.position.y) * Math.min(1, dt * 10);
    }

    this.bubble.visible = shield;
    if (shield) {
      const w = 1 + Math.sin(t * 6) * 0.04;
      this.bubble.scale.set(0.95 * w, 1.2 / w, 0.95 * w);
    }
    this.ice.visible = frozen;

    this.applyMaterials(pulse, frozen);

    if (boost && !hidden && Math.random() < dt * 50) {
      const p = this.root.position;
      this.effects.emit({ x: p.x + (Math.random() - 0.5) * 0.5, y: p.y + 0.2 + Math.random() * 1.2 * this.scale, z: p.z + (Math.random() - 0.5) * 0.5 }, Math.random() < 0.5 ? this.color : 0xffffff, 0.35, 0.45);
    }

    // blob shadow on the ground below
    const p = this.root.position;
    const gy = groundBelow(this.world.boxes || [], p.x, p.z, p.y + 0.1);
    const h = p.y - gy;
    if (gy > -Infinity && h < 25) {
      this.ground.visible = this.root.visible;
      this.ground.position.set(p.x, gy + 0.02, p.z);
      this.blob.material.opacity = 0.35 * Math.max(0, 1 - h / 12);
      this.blob.scale.setScalar(this.scale * (1 - Math.min(0.5, h / 20)));
    } else this.ground.visible = false;

    // LIGHTS OUT personal light
    if (this.light) {
      this.light.position.set(p.x, p.y + 1.8 * this.scale, p.z);
      this.light.color.setHex(st.it ? 0xff3040 : this.color);
      this.light.intensity = hidden ? 0 : ctx.darkness * (st.it ? 26 : 13);
    }
  }

  applyMaterials(pulse, frozen) {
    const alpha = this.ghostAlpha;
    for (const w of this.char.mats) {
      const m = w.mat;
      if (w.color) {
        m.color.copy(w.color);
        if (frozen) m.color.lerp(ICE, 0.65);
      }
      if (w.emissive) {
        m.emissive.copy(w.emissive);
        if (pulse > 0) m.emissive.lerp(RED, pulse);
        if (frozen) m.emissive.lerp(ICE_EMIT, 0.5);
      }
      const transparent = alpha < 0.99 || w.transparent;
      if (m.transparent !== transparent) {
        m.transparent = transparent;
        m.needsUpdate = true;
      }
      m.opacity = w.opacity * alpha;
    }
  }

  // simple procedural animation for the fallback bean
  beanAnim(anim, dt) {
    const { body, hands, feet } = this.char.parts;
    const t = this.time;
    const k = Math.min(1, dt * 14);
    let rx = 0;
    let rz = 0;
    let by = 0.22;
    let hy = 0.6;
    let hz = 0;
    let hs = 0;
    let fz = 0;
    if (anim === 'idle') {
      by += Math.sin(t * 3) * 0.02;
      hy += Math.sin(t * 3) * 0.03;
    } else if (anim === 'run') {
      by += Math.abs(Math.sin(t * 13)) * 0.12;
      rx = 0.18;
      hs = Math.sin(t * 13) * 0.35;
      fz = Math.sin(t * 13) * 0.25;
    } else if (anim === 'jump') {
      rx = -0.1;
      hy = 1.05;
    } else if (anim === 'fall') {
      hy = 1.1 + Math.sin(t * 22) * 0.12;
    } else if (anim === 'dive') {
      rx = 1.35;
      by = 0.5;
      hy = 0.9;
      hz = 0.45;
    } else if (anim === 'slip') {
      rx = -0.7;
      hy = 1.0 + Math.sin(t * 25) * 0.15;
    } else if (anim === 'punch') {
      hz = 0.5;
      hy = 0.95;
    } else if (anim === 'dance') {
      rz = Math.sin(t * 8) * 0.3;
      by += Math.abs(Math.sin(t * 8)) * 0.15;
      hy = 1.0 + Math.sin(t * 8) * 0.25;
    }
    body.rotation.x += (rx - body.rotation.x) * k;
    body.rotation.z += (rz - body.rotation.z) * k;
    body.position.y += (by - body.position.y) * k;
    hands.forEach((h, i) => {
      const s = i ? 1 : -1;
      const y = anim === 'dance' ? 1.0 + Math.sin(t * 8 + i * Math.PI) * 0.3 : hy;
      h.position.y += (y - h.position.y) * k;
      h.position.z += (hz + hs * s - h.position.z) * k;
    });
    feet.forEach((f, i) => {
      const s = i ? 1 : -1;
      f.position.z += (0.06 + fz * s - f.position.z) * k;
    });
  }
}
