// Toy guns: procedural blocky gun meshes (held in hands and as the first-person viewmodel), the viewmodel
// itself (drawn in its own pass so it never clips into walls) and rockets in flight from snapshots.
import * as THREE from 'three';
import { ITEMS } from '../../shared/items.js';
import { TICK_RATE } from '../../shared/config.js';
import { glowTex } from './world.js';

export const isGun = (id) => !!ITEMS[id]?.gun;
export const GUN_COLOR = { blaster: 0xffd23f, freezeray: 0x7fe6ff, rocket: 0xff8c3a };

// ---------- meshes ----------
const mats = {};
const mat = (color, glow = 0, vm = false) => {
  const key = color + ':' + glow + (vm ? ':vm' : ''); // the viewmodel scene gets its own (different lights)
  mats[key] ??= new THREE.MeshStandardMaterial({ color, emissive: glow ? color : 0, emissiveIntensity: glow, roughness: 0.4 });
  return mats[key];
};
// geometry helpers, all pointing +Z
const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const tube = (r, len, r2 = r) => new THREE.CylinderGeometry(r2, r, len, 14).rotateX(Math.PI / 2);
const cone = (r, len) => new THREE.ConeGeometry(r, len, 14).rotateX(Math.PI / 2);
const ring = (r, t) => new THREE.TorusGeometry(r, t, 8, 20);
const ball = (r) => new THREE.SphereGeometry(r, 14, 10);

// part: [geometry, color, x, y, z, glow, rotX]. Origin = grip, barrel along +Z, ~meters.
const GUNS = {
  blaster: {
    muzzle: [0, 0.08, 0.46],
    parts: [
      [box(0.11, 0.13, 0.32), 0xff8c3a, 0, 0.07, 0.1],
      [tube(0.04, 0.16), 0xffd23f, 0, 0.08, 0.33],
      [tube(0.058, 0.05), 0xff4fa3, 0, 0.08, 0.42],
      [box(0.08, 0.16, 0.08), 0xff4fa3, 0, -0.04, -0.02, 0, -0.25],
      [box(0.03, 0.05, 0.2), 0x2ee6ff, 0, 0.155, 0.08],
      [ball(0.04), 0x8cff5a, 0, 0.15, -0.04, 0.6],
    ],
  },
  freezeray: {
    muzzle: [0, 0.07, 0.48],
    parts: [
      [box(0.12, 0.12, 0.26), 0xf4f6ff, 0, 0.07, 0.05],
      [tube(0.035, 0.22), 0x5b6cff, 0, 0.07, 0.28],
      [ring(0.078, 0.02), 0x7fe6ff, 0, 0.07, 0.22, 0.9], // coils + bulb wider than the body: visible from behind
      [ring(0.078, 0.02), 0x7fe6ff, 0, 0.07, 0.28, 0.9],
      [ring(0.078, 0.02), 0x7fe6ff, 0, 0.07, 0.34, 0.9],
      [ball(0.085), 0xbff4ff, 0, 0.07, 0.43, 1.2],
      [tube(0.045, 0.16), 0x7fe6ff, 0, 0.165, 0.02, 0.5],
      [box(0.08, 0.16, 0.08), 0x8b5cff, 0, -0.04, -0.02, 0, -0.25],
    ],
  },
  rocket: {
    muzzle: [0, 0.11, 0.6],
    parts: [
      [tube(0.075, 0.55), 0x5ce65c, 0, 0.11, 0.24],
      [tube(0.09, 0.06), 0xffd23f, 0, 0.11, 0.51],
      [tube(0.085, 0.03), 0xffd23f, 0, 0.11, -0.02],
      [cone(0.055, 0.12), 0xff2d55, 0, 0.11, 0.57],
      [box(0.04, 0.05, 0.08), 0xff4fa3, 0, 0.215, 0.26],
      [box(0.08, 0.15, 0.08), 0xff2d55, 0, -0.03, 0.06, 0, -0.25],
    ],
  },
};

// New gun mesh; `muzzle` child marks the barrel tip.
export function makeGun(id, vm = false) {
  const def = GUNS[id] || GUNS.blaster;
  const g = new THREE.Group();
  for (const [geo, color, x, y, z, glow = 0, rx = 0] of def.parts) {
    const m = new THREE.Mesh(geo, mat(color, glow, vm));
    m.position.set(x, y, z);
    m.rotation.x = rx;
    m.castShadow = !vm;
    g.add(m);
  }
  const muzzle = new THREE.Object3D();
  muzzle.position.set(...def.muzzle);
  muzzle.name = 'muzzle';
  g.add(muzzle);
  g.userData.muzzle = muzzle;
  return g;
}

// ---------- first-person viewmodel ----------
const VM_POS = new THREE.Vector3(0.2, -0.19, -0.58);

export class Viewmodel {
  constructor(environment) {
    this.scene = new THREE.Scene();
    this.scene.environment = environment;
    this.scene.environmentIntensity = 0.35;
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.01, 10);
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x8a7560, 1.6);
    this.sun = new THREE.DirectionalLight(0xfff1d6, 2.2);
    this.sun.position.set(1, 3, 1);
    this.holder = new THREE.Group(); // sway + recoil + raise
    this.scene.add(this.hemi, this.sun, this.holder);
    this.flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false }));
    this.flash.renderOrder = 2;
    this.flash.visible = false;
    this.id = null;
    this.gun = null;
    this.raise = 0;
    this.recoil = 0;
    this.flashT = 0;
    this.bob = 0;
    this.sway = { x: 0, y: 0 };
  }

  get visible() {
    return !!this.gun;
  }

  resize(aspect) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  set(id) {
    if (id === this.id) return;
    this.id = id;
    if (this.gun) this.holder.remove(this.gun);
    this.gun = id ? makeGun(id, true) : null;
    if (!this.gun) return;
    this.gun.rotation.y = Math.PI + 0.14; // barrel away from the camera, toward the crosshair (shows its side)
    this.gun.scale.setScalar(0.8);
    this.gun.userData.muzzle.add(this.flash);
    this.flash.material.color.setHex(GUN_COLOR[id] ?? 0xffffff);
    this.holder.add(this.gun);
    this.raise = 0;
  }

  // own shot: kick back + muzzle flash
  kick(amount = 1) {
    this.recoil = Math.min(1.5, this.recoil + amount);
    this.flashT = 0.06;
    this.flash.material.rotation = Math.random() * Math.PI;
    this.flash.scale.setScalar(0.3 + 0.2 * amount);
  }

  // look: mouse delta this frame; speed: horizontal speed; grounded: on the ground; darkness: LIGHTS OUT 0..1
  update(dt, look, speed, grounded, darkness) {
    if (!this.gun) return;
    this.raise += (1 - this.raise) * Math.min(1, dt * 10);
    this.recoil *= Math.exp(-dt * 11);
    this.flash.visible = this.flashT > 0; // shown for at least one frame
    this.flashT -= dt;
    const run = grounded ? Math.min(1, speed / 9) : 0;
    this.bob += dt * (4 + 9 * run);
    const k = Math.min(1, dt * 8);
    this.sway.x += (Math.max(-0.06, Math.min(0.06, -look.x * 0.0006)) - this.sway.x) * k;
    this.sway.y += (Math.max(-0.06, Math.min(0.06, look.y * 0.0006)) - this.sway.y) * k;
    const h = this.holder;
    h.position.set(
      VM_POS.x + this.sway.x + Math.sin(this.bob) * 0.018 * run,
      VM_POS.y - this.sway.y + Math.abs(Math.cos(this.bob)) * 0.016 * run - (1 - this.raise) * 0.35 + (grounded ? 0 : 0.02),
      VM_POS.z + this.recoil * 0.1,
    );
    h.rotation.set(this.recoil * 0.3 + this.sway.y * 1.5, this.sway.x * 2, this.sway.x * 1.5);
    this.hemi.intensity = 1.6 * (1 - darkness * 0.8);
    this.sun.intensity = 2.2 * (1 - darkness * 0.85);
  }

  // drawn over the world with a cleared depth buffer
  render(renderer) {
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.autoClear = true;
  }

  // world point that shows up where the viewmodel's muzzle is on screen (start of own tracers)
  muzzleWorld(camera, out) {
    this.holder.updateMatrixWorld(true);
    this.camera.updateMatrixWorld();
    this.gun.userData.muzzle.getWorldPosition(out).project(this.camera);
    out.z = 0.5;
    out.unproject(camera).sub(camera.position).normalize();
    return out.multiplyScalar(0.9).add(camera.position);
  }
}

// ---------- rockets in flight ----------
const rocketParts = [
  [tube(0.08, 0.42), 0xf4f6ff, 0, 0, 0],
  [tube(0.085, 0.08), 0xff2d55, 0, 0, 0.05],
  [cone(0.08, 0.16), 0xff2d55, 0, 0, 0.29],
  [box(0.3, 0.025, 0.12), 0xffd23f, 0, 0, -0.16],
  [box(0.025, 0.3, 0.12), 0xffd23f, 0, 0, -0.16],
];
const tmp = new THREE.Vector3();

export class Rockets {
  constructor(scene, effects) {
    this.scene = scene;
    this.effects = effects;
    this.list = new Map(); // id -> { mesh, p, v, t, drawn }
  }

  // list: snapshot rockets [{id, p}]
  sync(list, now) {
    const seen = new Set();
    for (const r of list || []) {
      seen.add(r.id);
      let e = this.list.get(r.id);
      if (!e) {
        const mesh = new THREE.Group();
        for (const [geo, color, x, y, z] of rocketParts) {
          const m = new THREE.Mesh(geo, mat(color));
          m.position.set(x, y, z);
          mesh.add(m);
        }
        const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xffa030, blending: THREE.AdditiveBlending, depthWrite: false }));
        glow.position.z = -0.3;
        glow.scale.setScalar(0.9);
        mesh.add(glow);
        mesh.position.set(...r.p);
        this.scene.add(mesh);
        e = { mesh, glow, p: new THREE.Vector3(...r.p), v: new THREE.Vector3(), t: now, drawn: new THREE.Vector3(...r.p) };
        this.list.set(r.id, e);
        continue;
      }
      // one snapshot per server tick (arrival times bunch up, so don't divide by those)
      e.v.set(r.p[0] - e.p.x, r.p[1] - e.p.y, r.p[2] - e.p.z).multiplyScalar(TICK_RATE);
      e.p.set(...r.p);
      e.t = now;
    }
    for (const [id, e] of this.list) if (!seen.has(id)) this.remove(id, e);
  }

  remove(id, e) {
    this.scene.remove(e.mesh);
    e.glow.material.dispose();
    this.list.delete(id);
  }

  // the rocket that just exploded at p (a blast comes before the snapshot that drops it)
  removeNear(p) {
    for (const [id, e] of this.list) if (e.drawn.distanceToSquared(tmp.set(p.x, p.y, p.z)) < 9) return this.remove(id, e);
  }

  // extrapolates from the last snapshot (rockets fly straight), points along velocity, leaves smoke
  update(dt, now) {
    for (const e of this.list.values()) {
      const age = Math.min(2 / TICK_RATE, (now - e.t) / 1000); // a late snapshot shouldn't stall it
      const next = tmp.copy(e.p).addScaledVector(e.v, age);
      const step = next.distanceTo(e.drawn);
      const n = Math.min(8, Math.ceil(step / 0.35));
      for (let i = 0; i < n; i++) {
        const k = (i + 1) / n;
        const q = { x: e.drawn.x + (next.x - e.drawn.x) * k, y: e.drawn.y + (next.y - e.drawn.y) * k, z: e.drawn.z + (next.z - e.drawn.z) * k };
        this.effects.burst(q, { count: 1, colors: [0xe8e8f0, 0xc8c8d8], speed: 0.6, up: 0.4, size: 0.35, endSize: 1.1, life: 0.7, gravity: -0.6, drag: 2, jitter: 0.1 });
        if (i % 2 === 0) this.effects.emit(q, Math.random() < 0.5 ? 0xffd23f : 0xff8c3a, 0.35, 0.15);
      }
      e.drawn.copy(next);
      e.mesh.position.copy(next);
      if (e.v.lengthSq() > 1) e.mesh.lookAt(tmp.copy(next).add(e.v));
      e.glow.scale.setScalar(0.7 + Math.random() * 0.4);
    }
  }

  clear() {
    for (const [id, e] of this.list) this.remove(id, e);
  }
}
