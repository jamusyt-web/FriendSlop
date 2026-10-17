// Map rendering: lights, gradient sky, fog, boxes by kind, bounce pads, lava, mystery boxes, peels,
// decorative clouds, chaos lighting (LIGHTS OUT + tints) and a pooled set of player lights.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { MAPS } from '../../shared/maps.js';
import { MAX_PLAYERS } from '../../shared/config.js';
import { makeBanana } from './assets.js';

const DEFAULT_COLOR = { solid: 0xd9d4cf, bounce: 0xff4fa3, lava: 0xff5a1f, ice: 0xbfe9ff };
const TILE = 2; // meters per texture tile
const DARK = new THREE.Color(0x07061a);
const CHAOS_TINT = { ice: 0xbfefff, lowgrav: 0xc9b6ff, zoomies: 0xfff09a, bouncy: 0xffb8e6, reverse: 0xb6ffcf, tiny: 0xd0fff6, giant: 0xffd9b0 };

// ---------- procedural canvas textures ----------
function canvasTex(size, draw, srgb = true) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const gridTex = canvasTex(256, (g, s) => {
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, s, s);
  for (let i = 0; i < 1400; i++) {
    const v = Math.random();
    g.fillStyle = v < 0.5 ? `rgba(0,0,0,${0.03 + Math.random() * 0.05})` : `rgba(255,255,255,${0.2 + Math.random() * 0.3})`;
    const r = 1 + Math.random() * 3;
    g.fillRect(Math.random() * s, Math.random() * s, r, r);
  }
  g.strokeStyle = 'rgba(0,0,0,0.13)';
  g.lineWidth = 6;
  g.strokeRect(0, 0, s, s);
  g.strokeStyle = 'rgba(255,255,255,0.35)';
  g.lineWidth = 3;
  g.strokeRect(7, 7, s - 14, s - 14);
});

const stripeTex = canvasTex(128, (g, s) => {
  g.fillStyle = '#ff4fa3';
  g.fillRect(0, 0, s, s);
  g.fillStyle = '#ffd23f';
  for (let i = -s; i < s * 2; i += 32) {
    g.beginPath();
    g.moveTo(i, 0);
    g.lineTo(i + 16, 0);
    g.lineTo(i + 16 - s, s);
    g.lineTo(i - s, s);
    g.fill();
  }
});

const lavaTex = canvasTex(256, (g, s) => {
  g.fillStyle = '#e8340c';
  g.fillRect(0, 0, s, s);
  const colors = ['#ff7a00', '#ffb300', '#ff5000', '#ffe066', '#c41e00'];
  for (let i = 0; i < 70; i++) {
    const x = Math.random() * s;
    const y = Math.random() * s;
    const r = 8 + Math.random() * 34;
    const col = colors[i % colors.length];
    for (const ox of [-s, 0, s])
      for (const oy of [-s, 0, s]) {
        const grd = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
        grd.addColorStop(0, col);
        grd.addColorStop(1, 'rgba(255,80,0,0)');
        g.fillStyle = grd;
        g.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
      }
  }
});

const mysteryTex = canvasTex(128, (g, s) => {
  const grd = g.createLinearGradient(0, 0, s, s);
  grd.addColorStop(0, '#ffe14d');
  grd.addColorStop(1, '#ff8a1c');
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);
  g.strokeStyle = '#1f1640';
  g.lineWidth = 10;
  g.strokeRect(5, 5, s - 10, s - 10);
  g.font = 'bold 92px "Luckiest Guy", Arial Black, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 12;
  g.strokeText('?', s / 2, s / 2 + 6);
  g.fillStyle = '#ffffff';
  g.fillText('?', s / 2, s / 2 + 6);
});

export const glowTex = canvasTex(128, (g, s) => {
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);
});

// BoxGeometry with UVs scaled to world size so the grid texture tiles evenly on every face
function boxGeo(w, h, d, tile = TILE) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv;
  const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++)
    for (let i = 0; i < 4; i++) {
      const k = f * 4 + i;
      uv.setXY(k, (uv.getX(k) * dims[f][0]) / tile, (uv.getY(k) * dims[f][1]) / tile);
    }
  return g;
}

const skyVert = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;
const skyFrag = /* glsl */ `
  uniform vec3 top;
  uniform vec3 horizon;
  uniform vec3 bottom;
  varying vec3 vDir;
  void main() {
    float h = vDir.y;
    vec3 c = h > 0.0 ? mix(horizon, top, pow(h, 0.6)) : mix(horizon, bottom, pow(-h, 0.5));
    gl_FragColor = vec4(c, 1.0);
    #include <colorspace_fragment>
  }`;

export class World {
  constructor(scene, renderer, effects) {
    this.scene = scene;
    this.effects = effects;
    this.time = 0;
    this.darkness = 0;
    this.chaos = null;
    this.tint = 0;
    this.tintColor = new THREE.Color();

    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x8a7560, 1.6);
    scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff1d6, 2.6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.sun.shadow.radius = 3;
    scene.add(this.sun, this.sun.target);

    this.skyUniforms = { top: { value: new THREE.Color() }, horizon: { value: new THREE.Color() }, bottom: { value: new THREE.Color() } };
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(450, 32, 16),
      new THREE.ShaderMaterial({ uniforms: this.skyUniforms, vertexShader: skyVert, fragmentShader: skyFrag, side: THREE.BackSide, depthWrite: false, fog: false }),
    );
    sky.renderOrder = -10;
    sky.frustumCulled = false;
    this.skyMesh = sky;
    scene.add(sky);
    scene.fog = new THREE.Fog(0xffffff, 45, 180);

    // player lights for LIGHTS OUT: always present (intensity 0) so shaders never recompile
    this.lightPool = [];
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 14, 1.4);
      scene.add(l);
      this.lightPool.push(l);
    }

    this.group = null;
    this.mats = new Map();
    this.lavaMat = new THREE.MeshStandardMaterial({ color: 0xffffff, map: lavaTex, emissive: 0xffffff, emissiveMap: lavaTex, emissiveIntensity: 0.9, roughness: 0.6 });
    this.padMat = new THREE.MeshStandardMaterial({ color: 0xffffff, map: stripeTex, emissive: 0xffffff, emissiveMap: stripeTex, emissiveIntensity: 0.35, roughness: 0.4 });
    this.mysteryMat = new THREE.MeshStandardMaterial({ map: mysteryTex, emissive: 0xffffff, emissiveMap: mysteryTex, emissiveIntensity: 0.3, roughness: 0.35 });
    this.mysteryGeo = new THREE.BoxGeometry(0.85, 0.85, 0.85);
  }

  takeLight() {
    return this.lightPool.pop() || null;
  }
  returnLight(l) {
    if (!l) return;
    l.intensity = 0;
    this.lightPool.push(l);
  }

  material(kind, color) {
    const key = kind + ':' + color;
    let m = this.mats.get(key);
    if (m) return m;
    if (kind === 'ice') {
      m = new THREE.MeshPhysicalMaterial({ color, map: gridTex, roughness: 0.05, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.03, emissive: 0x7fd8ff, emissiveIntensity: 0.12 });
    } else {
      m = new THREE.MeshStandardMaterial({ color, map: gridTex, roughness: 0.82 });
    }
    this.mats.set(key, m);
    return m;
  }

  load(mapId) {
    const map = MAPS[mapId] || MAPS.castle;
    this.mapId = MAPS[mapId] ? mapId : 'castle';
    this.map = map;
    this.boxes = map.boxes;
    if (this.group) {
      this.scene.remove(this.group);
      this.group.traverse((o) => {
        if (o.geometry && o.geometry !== this.mysteryGeo) o.geometry.dispose();
      });
    }
    const group = new THREE.Group();
    this.group = group;
    this.pads = [];
    this.lavaTops = [];
    this.items = [];
    this.peels = new Map();
    this.clouds = null;

    let extent = 10;
    for (const b of map.boxes) {
      const w = b.max[0] - b.min[0];
      const h = b.max[1] - b.min[1];
      const d = b.max[2] - b.min[2];
      const cx = (b.min[0] + b.max[0]) / 2;
      const cz = (b.min[2] + b.max[2]) / 2;
      extent = Math.max(extent, Math.abs(b.min[0]), Math.abs(b.max[0]), Math.abs(b.min[2]), Math.abs(b.max[2]));
      const color = b.color ?? DEFAULT_COLOR[b.kind] ?? DEFAULT_COLOR.solid;
      let mesh;
      if (b.kind === 'bounce') {
        const geo = boxGeo(w, h, d, 2);
        geo.translate(0, h / 2, 0); // origin at the bottom so it squishes down
        mesh = new THREE.Mesh(geo, this.padMat);
        mesh.position.set(cx, b.min[1], cz);
        this.pads.push({ mesh, box: b, sq: 1, sqv: 0 });
      } else if (b.kind === 'lava') {
        mesh = new THREE.Mesh(boxGeo(w, h, d, 6), this.lavaMat);
        mesh.position.set(cx, (b.min[1] + b.max[1]) / 2, cz);
        this.lavaTops.push(b);
      } else {
        mesh = new THREE.Mesh(boxGeo(w, h, d), this.material(b.kind, color));
        mesh.position.set(cx, (b.min[1] + b.max[1]) / 2, cz);
      }
      mesh.castShadow = b.kind !== 'lava';
      mesh.receiveShadow = true;
      group.add(mesh);
    }

    map.items.forEach((p, i) => {
      const mesh = new THREE.Mesh(this.mysteryGeo, this.mysteryMat);
      mesh.castShadow = true;
      mesh.position.set(p[0], p[1] + 1, p[2]);
      group.add(mesh);
      this.items.push({ mesh, p, avail: true, s: 1, phase: i * 1.7 });
    });

    this.addClouds(group, extent, map);
    this.scene.add(group);

    // sun + shadow frustum sized to the map
    const ext = extent + 4;
    const cam = this.sun.shadow.camera;
    cam.left = cam.bottom = -ext;
    cam.right = cam.top = ext;
    cam.near = 1;
    cam.far = 200;
    cam.updateProjectionMatrix();
    this.sun.position.set(ext * 0.7, 60, ext * 0.45);
    this.sun.target.position.set(0, 0, 0);

    this.baseSky = new THREE.Color(map.sky);
    const lum = this.baseSky.getHSL({}).l;
    this.isDarkMap = lum < 0.3;
    this.baseHemi = this.isDarkMap ? 1.2 : 1.6;
    this.baseSun = this.isDarkMap ? 1.8 : 2.6;
    this.hemi.color.copy(this.baseSky).lerp(new THREE.Color(0xffffff), 0.5);
    this.darkness = 0;
    this.applyLighting();
    return map;
  }

  addClouds(group, extent, map) {
    if (this.isDarkMapId(map)) return;
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, emissive: 0xffffff, emissiveIntensity: 0.25 });
    const geo = new THREE.SphereGeometry(1, 12, 8);
    const clouds = new THREE.Group();
    for (let i = 0; i < 16; i++) {
      const c = new THREE.Group();
      const a = (i / 16) * Math.PI * 2 + Math.random() * 0.3;
      const r = extent + 35 + Math.random() * 40;
      c.position.set(Math.cos(a) * r, (i % 3 === 0 ? -25 : 8) + Math.random() * 22, Math.sin(a) * r);
      const n = 3 + Math.floor(Math.random() * 3);
      for (let j = 0; j < n; j++) {
        const s = new THREE.Mesh(geo, mat);
        const sz = 3 + Math.random() * 3.5;
        s.scale.set(sz, sz * 0.7, sz);
        s.position.set((j - n / 2) * 3.4, Math.random() * 1.5, Math.random() * 2);
        c.add(s);
      }
      c.rotation.y = Math.random() * Math.PI;
      clouds.add(c);
    }
    this.clouds = clouds;
    group.add(clouds);
  }

  isDarkMapId(map) {
    return new THREE.Color(map.sky).getHSL({}).l < 0.3;
  }

  setChaos(id, mods) {
    this.chaos = id;
    this.dark = !!mods?.dark;
  }

  applyLighting() {
    const d = this.darkness;
    const sky = this.baseSky.clone();
    if (this.tint > 0) sky.lerp(this.tintColor, this.tint * 0.45);
    sky.lerp(DARK, d * 0.92);
    const white = new THREE.Color(0xffffff);
    this.skyUniforms.top.value.copy(sky).multiplyScalar(0.82);
    this.skyUniforms.horizon.value.copy(sky).lerp(white, 0.35 * (1 - d));
    this.skyUniforms.bottom.value.copy(sky).multiplyScalar(0.7);
    this.scene.fog.color.copy(this.skyUniforms.horizon.value);
    this.scene.fog.near = 45 - d * 35;
    this.scene.fog.far = 180 - d * 130;
    this.hemi.intensity = this.baseHemi * (1 - d * 0.94);
    this.sun.intensity = this.baseSun * (1 - d * 0.97);
    this.scene.environmentIntensity = 0.35 * (1 - d * 0.9);
  }

  setItems(avail) {
    if (!avail) return;
    this.items.forEach((it, i) => {
      const a = !!avail[i];
      if (a && !it.avail) {
        it.s = 0;
        this.effects.burst(it.mesh.position, { count: 12, colors: [0xffe14d, 0xffffff], speed: 3, up: 1, size: 0.25, additive: true });
      }
      it.avail = a;
    });
  }

  setPeels(list) {
    const seen = new Set();
    for (const pl of list || []) {
      seen.add(pl.id);
      let e = this.peels.get(pl.id);
      if (!e) {
        const mesh = makeBanana();
        mesh.rotation.y = Math.random() * Math.PI * 2;
        mesh.scale.setScalar(0.01);
        this.group.add(mesh);
        e = { mesh, s: 0 };
        this.peels.set(pl.id, e);
      }
      e.mesh.position.set(pl.p[0], pl.p[1], pl.p[2]);
    }
    for (const [id, e] of this.peels) {
      if (seen.has(id)) continue;
      this.group.remove(e.mesh);
      this.peels.delete(id);
    }
  }

  itemPos(i) {
    return this.items[i]?.mesh.position;
  }

  nearestItem(pos) {
    let best = -1;
    let bd = Infinity;
    this.items.forEach((it, i) => {
      const d = it.mesh.position.distanceToSquared(pos);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  }

  // pad under a point (feet) if the feet are on/just above it
  padAt(x, y, z) {
    for (const pad of this.pads) {
      const b = pad.box;
      if (x > b.min[0] - 0.3 && x < b.max[0] + 0.3 && z > b.min[2] - 0.3 && z < b.max[2] + 0.3 && Math.abs(y - b.max[1]) < 0.35) return pad;
    }
    return null;
  }

  squish(pad) {
    pad.sqv = -14;
    this.effects.burst({ x: (pad.box.min[0] + pad.box.max[0]) / 2, y: pad.box.max[1], z: (pad.box.min[2] + pad.box.max[2]) / 2 }, {
      count: 14, colors: [0xff4fa3, 0xffd23f, 0xffffff], speed: 6, up: 5, size: 0.28, flat: true, gravity: 12,
    });
  }

  update(dt) {
    this.time += dt;
    const t = this.time;
    // chaos lighting transitions
    const targetDark = this.dark ? 1 : 0;
    const targetTint = this.chaos && CHAOS_TINT[this.chaos] ? 1 : 0;
    if (this.chaos && CHAOS_TINT[this.chaos]) this.tintColor.setHex(CHAOS_TINT[this.chaos]);
    const nd = this.darkness + (targetDark - this.darkness) * Math.min(1, dt * 3);
    const nt = this.tint + (targetTint - this.tint) * Math.min(1, dt * 2);
    if (Math.abs(nd - this.darkness) > 1e-4 || Math.abs(nt - this.tint) > 1e-4) {
      this.darkness = nd;
      this.tint = nt;
      this.applyLighting();
    }

    lavaTex.offset.set(Math.sin(t * 0.2) * 0.3, t * 0.04);
    this.lavaMat.emissiveIntensity = 0.85 + Math.sin(t * 2.3) * 0.15;
    this.padMat.emissiveIntensity = 0.3 + Math.sin(t * 5) * 0.12;

    for (const pad of this.pads) {
      pad.sqv += (-(pad.sq - 1) * 260 - pad.sqv * 9) * dt;
      pad.sq = Math.max(0.2, pad.sq + pad.sqv * dt);
      pad.mesh.scale.set(1 + (1 - pad.sq) * 0.25, pad.sq, 1 + (1 - pad.sq) * 0.25);
    }

    // lava bubbles
    if (this.lavaTops.length && Math.random() < dt * 6) {
      const b = this.lavaTops[Math.floor(Math.random() * this.lavaTops.length)];
      const p = { x: b.min[0] + Math.random() * (b.max[0] - b.min[0]), y: b.max[1], z: b.min[2] + Math.random() * (b.max[2] - b.min[2]) };
      this.effects.burst(p, { count: 3, colors: [0xffb300, 0xff5000], speed: 1, up: 2.5, size: 0.3, life: 0.6, gravity: 3, additive: true });
    }

    for (const it of this.items) {
      const target = it.avail ? 1 : 0;
      it.s += (target - it.s) * Math.min(1, dt * (target ? 8 : 14));
      const pop = it.avail ? 1 + Math.sin(Math.min(1, it.s) * Math.PI) * 0.3 : 1;
      it.mesh.visible = it.s > 0.02;
      it.mesh.scale.setScalar(Math.max(0.001, it.s * pop));
      it.mesh.position.y = it.p[1] + 1 + Math.sin(t * 2.4 + it.phase) * 0.18;
      it.mesh.rotation.set(Math.sin(t * 1.3 + it.phase) * 0.25, t * 1.6 + it.phase, 0);
    }

    for (const e of this.peels.values()) {
      e.s += (1 - e.s) * Math.min(1, dt * 10);
      e.mesh.scale.setScalar(Math.max(0.01, e.s));
    }

    if (this.clouds) this.clouds.rotation.y = t * 0.01;
  }
}
