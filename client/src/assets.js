// Loads /assets/assets.json (character, banana, sfx) and builds per-player character instances.
// Everything has a procedural fallback so the game still runs if an asset is missing.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { loadSfx } from './audio.js';

const BASE = '/assets/';
const assets = { manifest: {}, character: null, banana: null };

export async function loadAssets(onProgress = () => {}) {
  try {
    const res = await fetch(BASE + 'assets.json');
    if (res.ok) assets.manifest = await res.json();
  } catch {
    console.warn('assets.json missing — using fallback visuals');
  }
  onProgress(0.2);
  const m = assets.manifest;
  const loader = new GLTFLoader();
  const load = (file) =>
    file
      ? loader.loadAsync(BASE + file).catch((e) => {
          console.warn(`failed to load ${file}`, e.message);
          return null;
        })
      : Promise.resolve(null);
  let done = 0;
  const step = (p) => p.finally(() => onProgress(0.2 + (++done / 3) * 0.8));
  const [character, banana] = await Promise.all([
    step(load(m.character?.file)),
    step(load(m.banana?.file)),
    step(loadSfx(m.sfx, BASE)),
  ]);
  assets.character = character;
  assets.banana = banana;
}

// ---------- characters ----------

// Returns { model, mixer, actions, mats, parts }. `mats` are per-instance materials with their base
// colors stored so effects (IT glow, frozen) can tint and restore them.
export function makeCharacter(color) {
  const cfg = assets.manifest.character || {};
  if (!assets.character) return makeBean(color);

  const model = cloneSkinned(assets.character.scene);
  const inner = new THREE.Group();
  inner.add(model);
  model.scale.setScalar(cfg.scale ?? 1);
  model.rotation.y = cfg.rotationY ?? 0;
  model.position.y = cfg.yOffset ?? 0;

  const tintNames = new Set(cfg.tintMaterials || []);
  const mats = [];
  model.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.frustumCulled = false; // skinned bounds are unreliable
    const conv = (src) => {
      const mat = src.clone();
      if (tintNames.has(src.name)) mat.color.setHex(color);
      mats.push(wrapMat(mat));
      return mat;
    };
    o.material = Array.isArray(o.material) ? o.material.map(conv) : conv(o.material);
  });

  const mixer = new THREE.AnimationMixer(model);
  const actions = {};
  const oneShot = new Set(cfg.oneShotClips || ['hit', 'punch']);
  for (const [key, clipName] of Object.entries(cfg.clips || {})) {
    const clip = clipName && THREE.AnimationClip.findByName(assets.character.animations, clipName);
    if (!clip) continue;
    const action = mixer.clipAction(clip);
    if (oneShot.has(key) || oneShot.has(clipName)) {
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
    }
    actions[key] = action;
  }
  return { model: inner, mixer, actions, mats, parts: null };
}

function wrapMat(mat) {
  return { mat, color: mat.color?.clone(), emissive: mat.emissive?.clone(), opacity: mat.opacity, transparent: mat.transparent };
}

// Procedural jelly-bean buddy, used when the character model is unavailable.
const beanGeo = {
  body: new THREE.CapsuleGeometry(0.42, 0.85, 8, 20),
  eye: new THREE.SphereGeometry(0.12, 16, 12),
  pupil: new THREE.SphereGeometry(0.065, 12, 8),
  hand: new THREE.SphereGeometry(0.13, 12, 8),
  foot: new THREE.CapsuleGeometry(0.11, 0.12, 4, 8),
};
const white = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 });
const black = new THREE.MeshStandardMaterial({ color: 0x111122, roughness: 0.2 });

function makeBean(color) {
  const skin = new THREE.MeshStandardMaterial({ color, roughness: 0.45 });
  const dark = new THREE.MeshStandardMaterial({ color: new THREE.Color(color).multiplyScalar(0.55), roughness: 0.6 });
  const model = new THREE.Group();
  const body = new THREE.Group();
  body.position.y = 0.22;
  model.add(body);
  const torso = new THREE.Mesh(beanGeo.body, skin);
  torso.position.y = 0.66;
  torso.castShadow = true;
  body.add(torso);
  for (const s of [-1, 1]) {
    const eye = new THREE.Mesh(beanGeo.eye, white);
    eye.position.set(s * 0.15, 1.12, 0.33);
    eye.scale.z = 0.7;
    const pupil = new THREE.Mesh(beanGeo.pupil, black);
    pupil.position.set(0, 0, 0.09);
    eye.add(pupil);
    body.add(eye);
  }
  const hands = [-1, 1].map((s) => {
    const h = new THREE.Mesh(beanGeo.hand, skin);
    h.position.set(s * 0.52, 0.6, 0);
    h.castShadow = true;
    body.add(h);
    return h;
  });
  const feet = [-1, 1].map((s) => {
    const f = new THREE.Mesh(beanGeo.foot, dark);
    f.rotation.x = Math.PI / 2;
    f.position.set(s * 0.18, 0.11, 0.06);
    f.castShadow = true;
    model.add(f);
    return f;
  });
  return { model, mixer: null, actions: {}, mats: [wrapMat(skin), wrapMat(dark)], parts: { body, hands, feet } };
}

// ---------- banana peel ----------

const peelFallbackGeo = new THREE.TorusGeometry(0.25, 0.08, 8, 14, Math.PI * 1.3);
const peelFallbackMat = new THREE.MeshStandardMaterial({ color: 0xffe135, roughness: 0.5 });

export function makeBanana() {
  const g = new THREE.Group();
  if (assets.banana) {
    const m = assets.banana.scene.clone();
    m.scale.setScalar(assets.manifest.banana?.scale ?? 1);
    m.traverse((o) => {
      if (o.isMesh) o.castShadow = true;
    });
    g.add(m);
  } else {
    const m = new THREE.Mesh(peelFallbackGeo, peelFallbackMat);
    m.rotation.x = -Math.PI / 2;
    m.position.y = 0.08;
    m.castShadow = true;
    g.add(m);
  }
  return g;
}
