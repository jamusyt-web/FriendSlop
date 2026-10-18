// Juice: particle bursts (one Points batch per blend mode), expanding rings/spheres, fading beams
// (gun tracers), a flash light, and trauma-based camera shake.
import * as THREE from 'three';

const MAX = 2500;

class Particles {
  constructor(scene, additive) {
    this.n = 0;
    this.pos = new Float32Array(MAX * 3);
    this.col = new Float32Array(MAX * 4);
    this.size = new Float32Array(MAX);
    this.data = []; // per particle: {vx,vy,vz,life,max,size0,size1,drag,grav,r,g,b}
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setDrawRange(0, 0);
    this.uniforms = { uScale: { value: 800 } };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        attribute float size;
        attribute vec4 color;
        uniform float uScale;
        varying vec4 vColor;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * uScale / max(0.1, -mv.z);
          gl_Position = projectionMatrix * mv;
          vColor = color;
        }`,
      fragmentShader: /* glsl */ `
        varying vec4 vColor;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          if (d > 0.5) discard;
          float a = smoothstep(0.5, 0.25, d);
          gl_FragColor = vec4(vColor.rgb, vColor.a * a);
        }`,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    scene.add(this.points);
    this.geo = geo;
  }

  spawn(x, y, z, vx, vy, vz, life, size0, size1, color, drag, grav) {
    if (this.n >= MAX) return;
    const i = this.n++;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.data[i] = { vx, vy, vz, life, max: life, size0, size1, drag, grav, r: color.r, g: color.g, b: color.b };
  }

  update(dt) {
    let i = 0;
    while (i < this.n) {
      const p = this.data[i];
      p.life -= dt;
      if (p.life <= 0) {
        // swap-remove with the last particle
        const last = --this.n;
        this.data[i] = this.data[last];
        this.pos.copyWithin(i * 3, last * 3, last * 3 + 3);
        continue;
      }
      const drag = Math.exp(-p.drag * dt);
      p.vx *= drag;
      p.vy = p.vy * drag - p.grav * dt;
      p.vz *= drag;
      this.pos[i * 3] += p.vx * dt;
      this.pos[i * 3 + 1] += p.vy * dt;
      this.pos[i * 3 + 2] += p.vz * dt;
      const t = 1 - p.life / p.max;
      this.size[i] = p.size0 + (p.size1 - p.size0) * t;
      this.col[i * 4] = p.r;
      this.col[i * 4 + 1] = p.g;
      this.col[i * 4 + 2] = p.b;
      this.col[i * 4 + 3] = Math.min(1, (1 - t) * 2.5) * Math.min(1, t * 20 + 0.2);
      i++;
    }
    this.geo.setDrawRange(0, this.n);
    for (const k of ['position', 'color', 'size']) this.geo.attributes[k].needsUpdate = true;
  }

  clear() {
    this.n = 0;
  }
}

const tmpColor = new THREE.Color();
const ringGeo = new THREE.RingGeometry(0.85, 1, 48);
const sphereGeo = new THREE.SphereGeometry(1, 32, 16);
const beamGeo = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true);
const UP = new THREE.Vector3(0, 1, 0);
const tmpDir = new THREE.Vector3();

export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.puffs = new Particles(scene, false);
    this.sparks = new Particles(scene, true);
    this.shapes = []; // expanding rings / spheres
    this.trauma = 0;
    this.time = 0;
    this.flash = new THREE.PointLight(0xffaa44, 0, 30, 1.5);
    scene.add(this.flash);
    this.shake = { x: 0, y: 0, z: 0, roll: 0 };
  }

  resize(heightPx, camera) {
    // world-size points: projected size = size * (h/2) / tan(fov/2) / depth
    const s = heightPx / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    this.puffs.uniforms.uScale.value = s;
    this.sparks.uniforms.uScale.value = s;
  }

  // Generic burst. o: {count, colors[], speed, up, life, size, endSize, drag, gravity, spread(y offset), additive}
  burst(pos, o = {}) {
    const sys = o.additive ? this.sparks : this.puffs;
    const colors = o.colors || [0xffffff];
    const count = o.count ?? 20;
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const u = Math.random() * 2 - 1;
      const r = Math.sqrt(1 - u * u);
      const sp = (o.speed ?? 5) * (0.4 + Math.random() * 0.6);
      tmpColor.setHex(colors[i % colors.length]);
      const flat = o.flat ? 0.15 : 1;
      sys.spawn(
        pos.x + (Math.random() - 0.5) * (o.jitter ?? 0.3),
        pos.y + (Math.random() - 0.5) * (o.jitter ?? 0.3),
        pos.z + (Math.random() - 0.5) * (o.jitter ?? 0.3),
        Math.cos(a) * r * sp,
        Math.abs(u) * sp * flat + (o.up ?? 2),
        Math.sin(a) * r * sp,
        (o.life ?? 0.8) * (0.6 + Math.random() * 0.6),
        (o.size ?? 0.3) * (0.7 + Math.random() * 0.6),
        o.endSize ?? 0,
        tmpColor,
        o.drag ?? 2,
        o.gravity ?? 6,
      );
    }
  }

  // single particle (trails)
  emit(pos, color, size = 0.25, life = 0.5, additive = true) {
    tmpColor.setHex(color);
    (additive ? this.sparks : this.puffs).spawn(pos.x, pos.y, pos.z, 0, 0.3, 0, life, size, 0, tmpColor, 1, 0);
  }

  // expanding flat ring (or sphere) that fades out; inward: shrinks from radius to nothing (magnet pull)
  ring(pos, color, radius = 3, life = 0.5, sphere = false, inward = false) {
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: sphere ? 0.35 : 0.9,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const m = new THREE.Mesh(sphere ? sphereGeo : ringGeo, mat);
    m.position.set(pos.x, pos.y + 0.08, pos.z);
    if (!sphere) m.rotation.x = -Math.PI / 2;
    m.scale.setScalar(0.01);
    this.scene.add(m);
    this.shapes.push({ m, life, max: life, radius, opacity: mat.opacity, inward });
  }

  // glowing line from a to b that thins and fades out (gun tracers)
  beam(a, b, color, width = 0.06, life = 0.15) {
    tmpDir.set(b.x - a.x, b.y - a.y, b.z - a.z);
    const len = tmpDir.length();
    if (len < 0.05) return;
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const m = new THREE.Mesh(beamGeo, mat);
    m.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    m.quaternion.setFromUnitVectors(UP, tmpDir.divideScalar(len));
    m.scale.set(width, len, width);
    m.renderOrder = 6;
    this.scene.add(m);
    this.shapes.push({ m, life, max: life, width, opacity: 1 });
  }

  flashAt(pos, color = 0xffaa44, intensity = 60) {
    this.flash.position.set(pos.x, pos.y + 1.5, pos.z);
    this.flash.color.setHex(color);
    this.flash.intensity = intensity;
  }

  addShake(amount) {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  update(dt) {
    this.time += dt;
    this.puffs.update(dt);
    this.sparks.update(dt);
    for (let i = this.shapes.length - 1; i >= 0; i--) {
      const s = this.shapes[i];
      s.life -= dt;
      const t = 1 - s.life / s.max;
      const e = 1 - Math.pow(1 - t, 3);
      if (s.width) s.m.scale.x = s.m.scale.z = s.width * (1 - t * 0.8);
      else s.m.scale.setScalar(Math.max(0.01, s.radius * (s.inward ? 1 - e : e)));
      s.m.material.opacity = s.opacity * (1 - t);
      if (s.life <= 0) {
        this.scene.remove(s.m);
        s.m.material.dispose();
        this.shapes.splice(i, 1);
      }
    }
    this.flash.intensity *= Math.exp(-dt * 8);
    this.trauma = Math.max(0, this.trauma - dt * 1.4);
    const k = this.trauma * this.trauma;
    const t = this.time * 40;
    this.shake.x = k * 0.5 * Math.sin(t * 1.1 + 1);
    this.shake.y = k * 0.5 * Math.sin(t * 1.3 + 2);
    this.shake.z = k * 0.5 * Math.sin(t * 0.9 + 3);
    this.shake.roll = k * 0.08 * Math.sin(t * 0.7);
  }

  clear() {
    this.puffs.clear();
    this.sparks.clear();
    for (const s of this.shapes) {
      this.scene.remove(s.m);
      s.m.material.dispose();
    }
    this.shapes.length = 0;
    this.trauma = 0;
  }
}
