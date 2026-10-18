// FriendSlop client: screen/phase state machine, network message handling, game loop.
import './style.css';
import * as THREE from 'three';
import { SEND_RATE, COUNTDOWN, CHAOS_DURATION, TAG_BONUS, BOMB_PENALTY } from '../../shared/config.js';
import { ITEMS } from '../../shared/items.js';
import { CHAOS, mods as chaosMods } from '../../shared/chaos.js';
import * as net from './net.js';
import * as ui from './ui.js';
import * as audio from './audio.js';
import { prefs } from './prefs.js';
import { input, initInput } from './input.js';
import { loadAssets } from './assets.js';
import { World } from './world.js';
import { Effects } from './effects.js';
import { CameraRig } from './camera.js';
import { Mover, raycastBoxes } from './physics.js';
import { PlayerView } from './player.js';

const STEP = 1 / 120; // fixed physics step
const CHAOS_BLURB = {
  lowgrav: 'floaty mode engaged',
  zoomies: 'gotta go fast',
  ice: 'everything is slippery',
  tiny: 'smol bois',
  giant: 'absolute units',
  dark: 'who turned off the lights?',
  bouncy: "can't stop bouncing",
  reverse: 'controls flipped!',
  swap: 'everyone trades places',
  rain: 'free items for everyone',
};

// ---------- three.js setup ----------
const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.NeutralToneMapping;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(prefs.fov, innerWidth / innerHeight, 0.1, 1000);
const effects = new Effects(scene);
const world = new World(scene, renderer, effects);
const rig = new CameraRig(camera);
const mover = new Mover();
const viewCtx = { scene, world, effects };

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  effects.resize(innerHeight * renderer.getPixelRatio(), camera);
}
addEventListener('resize', resize);
resize();

// ---------- state ----------
const S = {
  screen: 'loading', // loading | menu | connecting | game
  myId: null,
  room: null,
  phase: null,
  views: new Map(), // id -> PlayerView
  snapAt: 0,
  time: null,
  fuse: null,
  fuseMax: 1,
  chaos: null,
  chaosAt: 0,
  results: null,
  paused: false,
  tpSeq: 0,
  physAcc: 0,
  sendAcc: 0,
  nextBeep: 0,
  mapReady: false,
  preview: null,
  unlockAt: 0,
};

const me = () => S.views.get(S.myId);
const infoOf = (id) => S.room?.players.find((p) => p.id === id) || null;
const posOf = (id) => S.views.get(id)?.root.position || null;
const near = (p) => (p ? Math.max(0, 1 - camera.position.distanceTo(p) / 30) : 0);

// ---------- flow ----------
function goMenu(msg, isError = false) {
  net.disconnect();
  input.releaseLock();
  clearGame();
  S.screen = 'menu';
  ui.showScreen('menu');
  world.load('castle');
  world.setChaos(null);
  makePreview();
  if (msg) ui.toast(msg, isError);
}

function clearGame() {
  for (const v of S.views.values()) v.dispose();
  S.views.clear();
  Object.assign(S, { myId: null, room: null, phase: null, time: null, fuse: null, chaos: null, results: null, paused: false, mapReady: false, tpSeq: 0 });
  effects.clear();
  mover.reset();
  input.enabled = true;
  ui.showPause(false);
  ui.setMatchHud(false);
  ui.hideResults();
  ui.setItem(null);
  ui.setScoreboard(false);
  ui.clearMessages();
}

function makePreview() {
  S.preview?.dispose();
  S.preview = new PlayerView(viewCtx, { id: 'preview', name: '', color: prefs.color }, true);
  S.preview.root.position.set(0, 3, 3.4);
  S.preview.forcedAnim = 'dance';
}

function connect(code) {
  S.screen = 'connecting';
  ui.showScreen('connecting');
  ui.setConnectingText(code ? `Joining ${code}…` : 'Creating room…');
  const join = { t: 'join', name: prefs.name || 'Slopper', color: prefs.color };
  if (code) join.code = code;
  net.connect(join, onMessage, (wasOpen) => {
    if (S.screen === 'menu') return;
    goMenu(wasOpen ? 'Disconnected from server' : "Couldn't reach the server", true);
  });
  clearTimeout(S.connectTimer);
  S.connectTimer = setTimeout(() => {
    if (S.screen === 'connecting') goMenu("Couldn't reach the server", true);
  }, 10000);
}

function enterGame() {
  S.screen = 'game';
  S.preview?.dispose();
  S.preview = null;
  ui.showScreen('game');
  ui.setItem(null);
  if (S.room) applyRoom(S.room);
  ui.setLockHint(!input.locked);
}

function openPause() {
  if (S.screen !== 'game' || S.paused) return;
  S.paused = true;
  input.enabled = false;
  input.clear();
  ui.showPause(true);
  input.releaseLock();
}

function resume() {
  S.paused = false;
  input.enabled = true;
  ui.showPause(false);
  input.requestLock();
}

// ---------- network ----------
function onMessage(m) {
  switch (m.t) {
    case 'joined':
      S.myId = m.id;
      enterGame();
      break;
    case 'error':
      if (S.screen !== 'game') goMenu(m.msg || 'Something went wrong', true);
      else ui.toast(m.msg || 'Server error', true);
      break;
    case 'room':
      applyRoom(m);
      break;
    case 'snap':
      applySnap(m);
      break;
    case 'fx':
      applyFx(m);
      break;
    case 'ev':
      applyEvent(m);
      break;
    case 'results':
      showResults(m.scores || []);
      break;
  }
}

function applyRoom(room) {
  const prev = S.room;
  S.room = room;
  if (S.screen !== 'game' || S.myId == null) return;

  if (!S.mapReady || world.mapId !== room.map) {
    world.load(room.map);
    mover.boxes = world.boxes;
    S.mapReady = true;
    respawn(false);
  }

  // reconcile player views
  const ids = new Set(room.players.map((p) => p.id));
  for (const [id, v] of S.views) {
    if (ids.has(id)) continue;
    if (prev) ui.feed(`👋 ${ui.nameHtml(v)} left`);
    v.dispose();
    S.views.delete(id);
  }
  for (const p of room.players) {
    const self = p.id === S.myId;
    let v = S.views.get(p.id);
    if (v && (v.isSelf !== self || v.color !== p.color || v.name !== p.name)) {
      v.dispose();
      v = null;
    }
    if (!v) {
      v = new PlayerView(viewCtx, p, self);
      S.views.set(p.id, v);
      if (self) v.root.position.set(mover.pos.x, mover.pos.y, mover.pos.z);
      else if (prev && !prev.players.some((q) => q.id === p.id)) ui.feed(`🎉 ${ui.nameHtml(p)} joined`);
    }
  }

  ui.updateLobby(room, S.myId);
  setPhase(room.phase);
}

function setPhase(phase) {
  if (!phase || phase === S.phase) return;
  const prev = S.phase;
  S.phase = phase;
  const match = phase === 'countdown' || phase === 'play';
  ui.showLobby(phase === 'lobby');
  ui.setMatchHud(match);
  if (phase !== 'results') {
    ui.hideResults();
    S.results = null;
    for (const v of S.views.values()) v.forcedAnim = null;
  }
  if (phase === 'lobby') {
    S.chaos = null;
    S.fuse = null;
    world.setChaos(null);
    if (prev === 'results') ui.toast('Back in the lobby — run it back?');
  }
  if (phase === 'countdown') mover.reset(); // the server clears every effect when a round starts
  ui.setLockHint(!input.locked && phase !== 'results');
  ui.setItemVisible(phase !== 'results');
}

function applySnap(s) {
  const now = performance.now();
  setPhase(s.phase);
  S.snapAt = now;
  S.time = s.time ?? null;
  if (s.fuse != null && (S.fuse == null || s.fuse > S.fuse + 0.5)) S.fuseMax = s.fuse;
  S.fuse = s.fuse ?? null;
  const chaos = s.chaos ?? null;
  if (chaos !== S.chaos) {
    if (chaos && chaos !== S.chaos) S.chaosAt = now;
    S.chaos = chaos;
    world.setChaos(chaos, CHAOS[chaos]?.mods);
  }
  for (const p of s.players || []) {
    const v = S.views.get(p.id);
    if (!v) continue;
    v.state.it = !!p.it;
    v.state.fx = p.fx || [];
    v.state.score = p.score ?? 0;
    v.state.item = p.item ?? null;
    if (!v.isSelf && p.p) v.push(now, p.p, p.ry ?? 0, p.a);
  }
  world.setItems(s.boxes);
  world.setPeels(s.peels);
  // joined during results: the scores went out before we got here, so rebuild them from the snapshot
  if (s.phase === 'results' && !S.results && S.room) {
    const rows = S.room.players.filter((p) => p.id !== S.myId).map((p) => ({ ...p, score: S.views.get(p.id)?.state.score ?? 0 }));
    showResults(rows.sort((a, b) => b.score - a.score));
  }
}

function applyFx(m) {
  const self = me();
  switch (m.k) {
    case 'knock': {
      const v = m.v || [0, 0, 0];
      if (v[1] > 0) mover.vel.y = Math.max(mover.vel.y, 0); // launches (spring, boom) aren't eaten by fall speed
      mover.vel.x += v[0];
      mover.vel.y += v[1];
      mover.vel.z += v[2];
      mover.grounded = false;
      mover.diving = false;
      effects.addShake(0.35);
      self?.stretch(1.3);
      break;
    }
    case 'freeze':
      mover.frozen = Math.max(mover.frozen, m.dur ?? 1); // same as the server: a longer freeze wins
      break;
    case 'slip':
      mover.slip = m.dur ?? 1;
      break;
    case 'boost':
      mover.boost = m.dur ?? 3;
      mover.boostSpeed = m.speed ?? 1.5;
      rig.kick(12);
      break;
    case 'tp': {
      const from = { ...mover.pos };
      mover.teleport(m.p);
      S.tpSeq = m.seq ?? S.tpSeq;
      poof(from);
      poof(mover.pos);
      if (S.phase === 'countdown') faceCenter();
      rig.snapNext = true;
      break;
    }
  }
}

function applyEvent(e) {
  const at = (id) => posOf(id);
  const mine = (id) => id === S.myId;
  switch (e.k) {
    case 'tag': {
      const p = at(e.b);
      if (p) {
        const c = { x: p.x, y: p.y + 1, z: p.z };
        effects.burst(c, { count: 30, colors: [0xff2d55, 0xffd23f, 0xffffff], speed: 9, up: 3, size: 0.35, additive: true });
        effects.ring(p, 0xff2d55, 3.5, 0.45);
      }
      audio.play('tag', { at: p });
      effects.addShake(mine(e.a) || mine(e.b) ? 0.55 : near(p) * 0.4);
      ui.feed(`${ui.nameHtml(infoOf(e.a))} 💥 tagged ${ui.nameHtml(infoOf(e.b))}`, mine(e.a) || mine(e.b));
      if (mine(e.a)) ui.bigText(`TAGGED! +${TAG_BONUS}`, 'go small');
      S.views.get(e.b)?.stretch(1.5);
      break;
    }
    case 'boom': {
      const p = at(e.id);
      if (p) {
        const c = { x: p.x, y: p.y + 1, z: p.z };
        effects.burst(c, { count: 70, colors: [0xffd23f, 0xff8c3a, 0xff2d55, 0xffffff], speed: 16, up: 4, size: 0.5, life: 0.9, additive: true });
        effects.burst(c, { count: 30, colors: [0x555566, 0x333344, 0x777788], speed: 6, up: 3, size: 1.1, endSize: 2.2, life: 1.4, gravity: -1, drag: 2.5 });
        effects.ring(p, 0xff8c3a, 7, 0.6);
        effects.flashAt(p, 0xffaa44, 120);
      }
      audio.play('boom', { at: p, jitter: 0.04 });
      effects.addShake(mine(e.id) ? 1 : near(p) * 0.9);
      ui.feed(`💣 ${ui.nameHtml(infoOf(e.id))} went BOOM! <b>-${BOMB_PENALTY}</b>`, mine(e.id));
      if (mine(e.id)) ui.bigText(`BOOM! -${BOMB_PENALTY}`, 'red small');
      break;
    }
    case 'chaos': {
      const c = CHAOS[e.id];
      if (!c) break;
      S.chaosAt = performance.now();
      ui.bigText(`${c.name}!<small>${CHAOS_BLURB[e.id] || ''}</small>`, 'chaos');
      ui.feed(`🌀 CHAOS: <b>${c.name}</b>`);
      audio.play('whoosh', { volume: 0.9, rate: 0.8 });
      audio.play('go', { volume: 0.6, rate: 1.2 });
      effects.addShake(0.2);
      const p = posOf(S.myId);
      if (p) effects.burst({ x: p.x, y: p.y + 3, z: p.z }, { count: 50, colors: [0x8cff5a, 0xff4fa3, 0x2ee6ff, 0xffd23f], speed: 10, up: 4, size: 0.3, life: 1.4, gravity: 8 });
      break;
    }
    case 'pickup': {
      const p = at(e.id);
      const i = p ? world.nearestItem(p) : -1;
      const bp = i >= 0 ? world.itemPos(i) : p;
      if (bp) effects.burst(bp, { count: 24, colors: [0xffe14d, 0xff4fa3, 0x2ee6ff, 0x8cff5a], speed: 6, up: 3, size: 0.3, additive: true });
      audio.play('pickup', { at: mine(e.id) ? null : p, volume: mine(e.id) ? 1 : 0.6 });
      break;
    }
    case 'use': {
      const item = ITEMS[e.item];
      const p = e.p ? { x: e.p[0], y: e.p[1], z: e.p[2] } : at(e.id);
      itemFx(e.item, p, mine(e.id));
      if (e.item === 'glove') S.views.get(e.id)?.playOnce('punch');
      if (item) ui.feed(`${ui.nameHtml(infoOf(e.id))} used ${item.icon} ${ui.esc(item.name)}`, mine(e.id));
      break;
    }
    case 'slip': {
      const p = at(e.id);
      audio.play('slip', { at: p });
      if (p) effects.burst({ x: p.x, y: p.y + 0.3, z: p.z }, { count: 16, colors: [0xffe135, 0xffffff], speed: 5, up: 4, size: 0.3 });
      ui.feed(`🍌 ${ui.nameHtml(infoOf(e.id))} slipped!`, mine(e.id));
      if (mine(e.id)) effects.addShake(0.3);
      break;
    }
    case 'pop': {
      const p = at(e.id);
      audio.play('bounce', { at: p, rate: 1.6 });
      if (p) effects.burst({ x: p.x, y: p.y + 1, z: p.z }, { count: 24, colors: [0x9fe9ff, 0xffffff, 0xff9ff0], speed: 7, up: 1, size: 0.35, additive: true });
      ui.feed(`🫧 ${ui.nameHtml(infoOf(e.id))}'s bubble popped!`, mine(e.id));
      break;
    }
    case 'countdown':
      ui.bigText(e.n === COUNTDOWN ? `${e.n}<small>GET READY!</small>` : String(e.n), e.n === 1 ? 'red' : '');
      audio.play('beep', { jitter: 0 });
      break;
    case 'go':
      ui.bigText('GO!', 'go');
      audio.play('go', { jitter: 0 });
      effects.addShake(0.2);
      break;
  }
}

function itemFx(item, p, mine) {
  if (!p) return audio.play('use');
  const c = { x: p.x, y: p.y + 1, z: p.z };
  switch (item) {
    case 'glove':
      audio.play('punch', { at: p });
      effects.ring(p, 0xffffff, ITEMS.glove.range, 0.35);
      effects.burst(c, { count: 20, colors: [0xff2d55, 0xffffff], speed: 10, up: 1, size: 0.3, additive: true });
      effects.addShake(mine ? 0.3 : near(p) * 0.4);
      break;
    case 'freeze':
      audio.play('freeze', { at: p });
      effects.ring(p, 0x9fe9ff, ITEMS.freeze.radius, 0.7, true);
      effects.burst(c, { count: 40, colors: [0xffffff, 0x9fe9ff, 0x5fd0ff], speed: 12, up: 2, size: 0.3, life: 1, gravity: 2, additive: true });
      break;
    case 'swap':
      audio.play('whoosh', { at: p });
      effects.burst(c, { count: 30, colors: [0xb15cff, 0xff4fa3, 0xffffff], speed: 6, up: 2, size: 0.35, additive: true });
      break;
    case 'ghost':
      audio.play('whoosh', { at: p, rate: 0.7 });
      effects.burst(c, { count: 24, colors: [0xffffff, 0xd8d8f0], speed: 4, up: 1, size: 0.7, endSize: 1.4, gravity: -1, life: 1 });
      break;
    case 'spring':
      audio.play('bounce', { at: p, rate: 0.8 });
      effects.ring(p, 0x8cff5a, 3, 0.4);
      effects.burst(p, { count: 20, colors: [0x8cff5a, 0xffffff], speed: 6, up: 6, size: 0.3, flat: true });
      break;
    case 'boots':
      audio.play('whoosh', { at: p, rate: 1.3 });
      effects.burst(c, { count: 20, colors: [0xffd23f, 0xff8c3a], speed: 7, up: 1, size: 0.3, additive: true });
      break;
    default:
      audio.play('use', { at: p });
      effects.burst(c, { count: 14, colors: [0xffffff, 0xffd23f], speed: 4, up: 2, size: 0.3 });
  }
}

function showResults(scores) {
  S.results = scores;
  ui.showResults(scores, S.myId);
  ui.setMatchHud(false);
  ui.showLobby(false);
  audio.play('win', { jitter: 0 });
  const w = scores[0] && S.views.get(scores[0].id);
  if (w) w.forcedAnim = 'dance';
  ui.setLockHint(false);
}

// ---------- own player ----------
function respawn(fx = true) {
  const spawns = world.map?.spawns;
  if (!spawns?.length) return;
  const from = { ...mover.pos };
  const s = spawns[Math.floor(Math.random() * spawns.length)];
  mover.teleport(s);
  faceCenter();
  rig.snapNext = true;
  if (fx) {
    poof(from);
    poof(mover.pos);
    audio.play('whoosh');
  }
}

function faceCenter() {
  const dx = -mover.pos.x;
  const dz = -mover.pos.z;
  if (Math.hypot(dx, dz) > 1) rig.yaw = Math.atan2(-dx, -dz);
  mover.facing = Math.atan2(dx, dz);
}

function poof(p) {
  effects.burst({ x: p.x, y: p.y + 0.9, z: p.z }, { count: 18, colors: [0xffffff, 0xe0d8ff], speed: 4, up: 1, size: 0.6, endSize: 1.2, gravity: -1, life: 0.7 });
}

const moverEvents = [];
function handleMoverEvents(self) {
  const p = mover.pos;
  for (const e of moverEvents) {
    switch (e.k) {
      case 'jump':
        audio.play('jump', { volume: e.auto ? 0.35 : 0.7 });
        self.stretch(1);
        break;
      case 'doublejump':
        audio.play('jump', { volume: 0.7, rate: 1.35 });
        self.stretch(1.2);
        effects.ring(p, 0xffffff, 1.4, 0.3);
        effects.burst({ x: p.x, y: p.y + 0.2, z: p.z }, { count: 10, colors: [0xffffff], speed: 3, up: -1, size: 0.3, gravity: 0, drag: 5, life: 0.4 });
        break;
      case 'land':
        if (e.speed > 7) {
          audio.play('land', { volume: Math.min(1, e.speed / 22) });
          self.land(e.speed);
          if (e.speed > 22) effects.addShake(0.15);
        }
        break;
      case 'bounce': {
        audio.play('bounce');
        const pad = world.pads.find((q) => q.box === e.box);
        if (pad) world.squish(pad);
        self.stretch(1.8);
        rig.kick(7);
        break;
      }
      case 'dive':
        audio.play('whoosh', { volume: 0.6 });
        rig.kick(9);
        self.stretch(0.8);
        break;
      case 'lava':
        audio.play('slip', { rate: 0.6 });
        effects.burst({ x: p.x, y: p.y + 0.5, z: p.z }, { count: 30, colors: [0xff5a1f, 0xffd23f, 0x555555], speed: 6, up: 5, size: 0.4, additive: true });
        respawn();
        moverEvents.length = 0;
        return;
    }
  }
  moverEvents.length = 0;
}

function updateGame(dt, now) {
  const self = me();
  const m = chaosMods(S.chaos);

  if (self && S.mapReady) {
    const look = input.takeLook();
    if (input.locked && !S.paused) rig.look(look.x, look.y, prefs.sensitivity, prefs.invertY);

    const canMove = !S.paused && S.phase !== 'countdown' && S.phase !== 'results';
    if (input.take('jump')) mover.jumpBuffer = 0.12;
    if (input.take('dive')) mover.wantDive = true;
    if (input.take('use') && self.state.item && canMove) net.send({ t: 'use' });
    const ax = input.axes();
    const dir = rig.moveDir(ax.x, ax.y);
    const inp = { x: dir.x, z: dir.z, locked: !canMove };

    S.physAcc = Math.min(S.physAcc + dt, 0.25);
    while (S.physAcc >= STEP) {
      mover.step(STEP, inp, m, moverEvents);
      S.physAcc -= STEP;
      if (mover.pos.y < world.map.killY) {
        moverEvents.length = 0;
        respawn();
      }
      if (moverEvents.length) handleMoverEvents(self);
    }

    // render own player between physics states
    const a = S.physAcc / STEP;
    const pr = mover.prev;
    const p = mover.pos;
    self.root.position.set(pr.x + (p.x - pr.x) * a, pr.y + (p.y - pr.y) * a + mover.smoothY, pr.z + (p.z - pr.z) * a);
    self.root.rotation.y = mover.facing;
    self.setAnim(mover.anim());

    // network send
    S.sendAcc += dt;
    if (S.sendAcc >= 1 / SEND_RATE) {
      S.sendAcc %= 1 / SEND_RATE;
      const r = (v) => Math.round(v * 100) / 100;
      net.send({ t: 's', p: [r(p.x), r(p.y), r(p.z)], ry: r(mover.facing % (Math.PI * 2)), a: mover.anim(), tp: S.tpSeq });
    }
  }

  // remote players
  for (const v of S.views.values()) {
    if (v.isSelf) continue;
    v.sample(now, dt);
    const rp = v.root.position;
    const pad = world.padAt(rp.x, rp.y, rp.z);
    if (pad && !v.onPad) {
      world.squish(pad);
      audio.play('bounce', { at: rp, volume: 0.6 });
      v.stretch(1.5);
    }
    v.onPad = !!pad;
  }

  // views
  const fuseNow = S.fuse != null ? Math.max(0, S.fuse - (now - S.snapAt) / 1000) : null;
  const runRate = Math.max(0.6, Math.hypot(mover.vel.x, mover.vel.z) / 9);
  for (const v of S.views.values()) {
    v.update(dt, { scale: m.scale, fuse: fuseNow, darkness: world.darkness, runRate: v.isSelf ? runRate : 1, countdown: S.phase === 'countdown' });
  }

  updateHud(now, fuseNow, m);

  // camera
  if (S.phase === 'results' && S.results) {
    const w = S.views.get(S.results[0]?.id) || self;
    if (w) orbitCamera(w.root.position, now / 1000, 5.5, 1.6);
  } else if (self) {
    const boosting = self.state.fx.includes('boost') || mover.boost > 0;
    rig.update(dt, self.root.position, self.scale, world.boxes, prefs.fov, effects.shake, (boosting ? 10 : 0) + (m.speed > 1 ? 6 : 0));
  }
}

function updateHud(now, fuseNow, m) {
  const self = me();
  const match = S.phase === 'countdown' || S.phase === 'play';
  const timeNow = S.time != null ? Math.max(0, S.time - (now - S.snapAt) / 1000) : null;

  if (S.phase === 'play') ui.setTimer(timeNow);
  else ui.setTimer(null);
  if (S.phase === 'results') ui.setResultsTimer(timeNow ?? 0);

  let it = null;
  for (const v of S.views.values()) if (v.state.it) it = v;
  const iAmIt = !!(it && it.isSelf && match);
  ui.setFuse(match && it ? fuseNow : null, S.fuseMax);
  ui.setItLabel(match && it ? infoOf(it.id) : null, iAmIt);
  ui.setYouAreIt(iAmIt);
  ui.setFrozenVignette(!!self && S.phase !== 'countdown' && (self.state.fx.includes('frozen') || mover.frozen > 0));

  if (self) {
    ui.setScore(self.state.score);
    ui.setItem(self.state.item);
  }

  // chaos badge
  if (match && S.chaos && CHAOS[S.chaos]) {
    const left = CHAOS_DURATION - (now - S.chaosAt) / 1000;
    ui.chaosBadge(CHAOS[S.chaos].name, left, left / CHAOS_DURATION);
  } else ui.chaosBadge(null);

  // fuse ticking: faster near zero, louder for IT
  if (S.phase === 'play' && fuseNow != null && it && now >= S.nextBeep) {
    const interval = fuseNow < 3 ? 0.22 : fuseNow < 6 ? 0.5 : 1;
    if (iAmIt || fuseNow < 6) audio.play('beep', { volume: iAmIt ? 0.45 : 0.18, rate: fuseNow < 3 ? 1.5 : 1.2, jitter: 0 });
    S.nextBeep = now + interval * 1000;
  }

  // Tab scoreboard
  const showBoard = match && input.isDown('scores');
  if (showBoard) {
    const rows = [...S.views.values()]
      .map((v) => ({ id: v.id, name: v.name, color: v.color, score: v.state.score, it: v.state.it }))
      .sort((a, b) => b.score - a.score);
    ui.setScoreboard(true, rows, S.myId);
  } else ui.setScoreboard(false);

  ui.setCrosshair(input.locked && S.phase !== 'results');
}

// camera orbit around a point, subject shifted right of center (UI card sits on the left)
const orbitDir = new THREE.Vector3();
function orbitCamera(p, t, radius, height) {
  const a = Math.sin(t * 0.25) * 0.7;
  const head = new THREE.Vector3(p.x, p.y + 1.2, p.z);
  orbitDir.set(Math.sin(a) * radius, height - 1.2, Math.cos(a) * radius);
  const len = orbitDir.length();
  orbitDir.divideScalar(len);
  const dist = Math.max(1.5, Math.min(len, raycastBoxes(world.boxes || [], head, orbitDir, len + 0.3) - 0.3));
  camera.position.copy(head).addScaledVector(orbitDir, dist);
  const right = new THREE.Vector3(Math.cos(a), 0, -Math.sin(a));
  const look = new THREE.Vector3(p.x, p.y + 1.1, p.z).addScaledVector(right, -1.5);
  camera.lookAt(look);
  if (camera.fov !== prefs.fov) {
    camera.fov = prefs.fov;
    camera.updateProjectionMatrix();
  }
}

// ---------- main loop ----------
let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (S.screen === 'loading') return;

  if (S.screen === 'game') updateGame(dt, now);
  else if (S.preview) {
    S.preview.root.rotation.y = 0;
    S.preview.update(dt, { scale: 1, fuse: null, darkness: 0 });
    orbitCamera(S.preview.root.position, now / 1000, 5.2, 1.5);
  }

  world.update(dt, camera.position);
  effects.resize(renderer.domElement.height, camera);
  effects.update(dt);
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
  audio.setListener(camera.position, right);
  renderer.render(scene, camera);
}

// ---------- input wiring ----------
initInput(canvas, (locked) => {
  if (!locked) S.unlockAt = performance.now();
  if (S.screen !== 'game') return;
  ui.setLockHint(!locked && !S.paused && S.phase !== 'results');
  if (!locked && !S.paused && S.phase !== 'lobby' && S.phase !== 'results') openPause();
});

// buttons shouldn't keep focus, or Space (jump) would press them again
addEventListener('click', (e) => {
  if (e.target.closest?.('button')) setTimeout(() => document.activeElement?.blur?.(), 0);
});

canvas.addEventListener('click', () => {
  if (S.screen === 'game' && !S.paused) input.requestLock();
});

addEventListener('keydown', (e) => {
  if (e.code !== 'Escape') return;
  if (ui.settingsOpen()) return ui.closeSettings();
  if (S.screen !== 'game' || performance.now() - S.unlockAt < 250) return;
  if (S.paused) resume();
  else openPause();
});

ui.initUI({
  create: () => connect(null),
  join: (code) => connect(code),
  color: () => S.screen === 'menu' && makePreview(),
  settings: () => {
    audio.setVolume(prefs.volume);
    if (S.screen !== 'game') {
      camera.fov = prefs.fov;
      camera.updateProjectionMatrix();
    }
  },
  start: () => net.send({ t: 'start' }),
  map: (map) => net.send({ t: 'map', map }),
  pause: () => openPause(),
  resume: () => resume(),
  leave: () => goMenu(),
});
audio.setVolume(prefs.volume);

// ---------- boot ----------
requestAnimationFrame(frame);
loadAssets(ui.setLoading).then(() => {
  ui.setLoading(1);
  setTimeout(() => goMenu(), 250);
});
