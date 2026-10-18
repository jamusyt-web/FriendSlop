// FriendSlop client: screen/phase state machine, network message handling, game loop.
import './style.css';
import * as THREE from 'three';
import { SEND_RATE, COUNTDOWN, CHAOS_DURATION, TAG_BONUS, BOMB_PENALTY, PLAYER, FALL_PENALTY, KNOCKOFF_BONUS, bombCount } from '../../shared/config.js';
import { ITEMS } from '../../shared/items.js';
import { CHAOS, mods as chaosMods } from '../../shared/chaos.js';
import { setMapTime } from '../../shared/maps.js';
import * as net from './net.js';
import * as ui from './ui.js';
import * as audio from './audio.js';
import { prefs, savePrefs } from './prefs.js';
import { input, initInput } from './input.js';
import { loadAssets } from './assets.js';
import { World } from './world.js';
import { Effects } from './effects.js';
import { CameraRig } from './camera.js';
import { Mover, raycastBoxes } from '../../shared/physics.js';
import { PlayerView } from './player.js';
import { Viewmodel, Projectiles, Ropes, isGun, GUN_COLOR } from './guns.js';

const STEP = 1 / 120; // fixed physics step
const DANCE_TIME = 2; // F tap dances this long (holding F keeps dancing)
const GUN_SFX = { rocket: ['rocket', 1], freezeray: ['shoot', 0.7], grapple: ['shoot', 0.55], pearl: ['whoosh', 1.5] }; // [sfx, rate], default shoot
const BOMBS_TEXT = (n) => (n > 1 ? `${n} BOMBS!` : 'GET READY!');
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
const vm = new Viewmodel(scene.environment);
const projectiles = new Projectiles(scene, effects);
const ropes = new Ropes(scene);
const eyePos = new THREE.Vector3();
const aim = new THREE.Vector3();
const muzzle = new THREE.Vector3();

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  vm.resize(innerWidth / innerHeight);
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
  mt: 0, // map clock (drives moving / blinking boxes); follows the server's snapshot `mt` smoothly
  mtSnap: 0,
  mtSnapAt: 0,
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
  nextShot: 0, // own gun cooldown (performance.now ms)
  useBuf: 0, // a gun click during the cooldown fires when it ends (until this time)
  dizzyK: 0, // camera wobble blend
  tpFrom: null, // where the last teleport took us from (warp poofs)
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
  Object.assign(S, { myId: null, room: null, phase: null, time: null, chaos: null, results: null, paused: false, mapReady: false, tpSeq: 0, nextShot: 0, useBuf: 0, dizzyK: 0 });
  effects.clear();
  projectiles.clear();
  ropes.clear();
  vm.set(null);
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
  input.clear(); // keys pressed on the menu (V, Space, E) must not fire on the first game frame
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
    loadMap(room.map);
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
      else if (prev && !prev.players.some((q) => q.id === p.id)) ui.feed(`${p.bot ? '🤖' : '🎉'} ${ui.nameHtml(p)} joined`);
    }
  }

  ui.updateLobby(room, S.myId);
  setPhase(room.phase);
}

// the server restarts map time at 0 whenever it loads a map
function loadMap(id) {
  world.load(id);
  mover.boxes = world.solids;
  Object.assign(S, { mt: 0, mtSnap: 0, mtSnapAt: performance.now() });
  world.setTime(0);
}

// Map clock: runs at real speed, nudged toward the server's (snapshot mt + time since). Never steps back
// unless it's way off (joined late, tab was hidden). Riders are only carried as far as the physics steps go
// (frame dt, capped), so while we stand on a moving box the clock runs at exactly dt and catches up once we
// step off; otherwise a hitch or a slow frame would slide the box out from under us.
function tickMapClock(dt, now) {
  const target = S.mtSnap + (now - S.mtSnapAt) / 1000;
  const err = target - S.mt;
  if (mover.grounded && mover.ground?.dv) S.mt += dt;
  else S.mt = Math.abs(err) > 1 ? target : S.mt + dt * Math.min(2, Math.max(0.5, 1 + err * 2));
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
  if (s.mt != null) {
    S.mtSnap = s.mt;
    S.mtSnapAt = now;
  }
  const chaos = s.chaos ?? null;
  if (chaos !== S.chaos) {
    if (chaos && chaos !== S.chaos) S.chaosAt = now;
    S.chaos = chaos;
    world.setChaos(chaos, CHAOS[chaos]?.mods);
  }
  for (const p of s.players || []) {
    const v = S.views.get(p.id);
    if (!v) continue;
    const fuse = p.fuse ?? null;
    if (fuse != null && (v.state.fuse == null || fuse > v.state.fuse + 0.5)) v.fuseMax = fuse; // freshly lit bomb
    v.state.fuse = fuse;
    v.state.it = !!p.it;
    v.state.fx = p.fx || [];
    v.state.score = p.score ?? 0;
    v.state.item = p.item ?? null;
    v.state.ammo = p.ammo ?? null;
    if (!v.isSelf && p.p) v.push(now, p.p, p.ry ?? 0, p.a, s.mt);
  }
  world.setItems(s.boxes);
  world.setPeels(s.peels);
  world.setWalls(s.walls);
  world.setClouds(s.clouds);
  projectiles.sync(s.projectiles, now);
  // joined during results: the scores went out before we got here, so rebuild them from the snapshot
  if (s.phase === 'results' && !S.results && S.room) {
    const rows = S.room.players.filter((p) => p.id !== S.myId).map((p) => ({ ...p, score: S.views.get(p.id)?.state.score ?? 0 }));
    showResults(rows.sort((a, b) => b.score - a.score));
  }
}

function applyFx(m) {
  const self = me();
  switch (m.k) {
    case 'knock':
      mover.knock(m.v || [0, 0, 0]);
      effects.addShake(0.35);
      self?.stretch(1.3);
      break;
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
    case 'float':
      mover.float = Math.max(mover.float, m.dur ?? 1);
      break;
    case 'dizzy':
      mover.dizzy = Math.max(mover.dizzy, m.dur ?? 1);
      break;
    case 'tp': {
      const from = { ...mover.pos };
      S.tpFrom = from;
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
      const va = S.views.get(e.a);
      const vb = S.views.get(e.b);
      if (va && vb) {
        vb.fuseMax = va.fuseMax; // the bomb changes hands, fuse and all
        vb.state.fuse = va.state.fuse;
      }
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
      if (item?.gun) break; // guns have their own 'shot' event
      const p = e.p ? { x: e.p[0], y: e.p[1], z: e.p[2] } : at(e.id);
      itemFx(e.item, p, mine(e.id));
      if (e.item === 'glove') S.views.get(e.id)?.playOnce('punch');
      if (e.item === 'fuse') ui.feed(`${item.icon} ${ui.nameHtml(infoOf(e.id))} cut every fuse by ${item.cut}s!`, true);
      else if (item) ui.feed(`${ui.nameHtml(infoOf(e.id))} used ${item.icon} ${ui.esc(item.name)}`, mine(e.id));
      break;
    }
    case 'warp': {
      const to = e.p ? { x: e.p[0], y: e.p[1], z: e.p[2] } : null;
      const from = mine(e.id) ? S.tpFrom : at(e.id); // our own fx tp already moved us
      if (to) projectiles.removeNear(to, 'pearl');
      for (const q of [from, to]) if (q) warpPoof(q);
      audio.play('whoosh', { at: to, rate: 1.7 });
      audio.play('freeze', { at: to, rate: 1.9, volume: 0.45 });
      if (mine(e.id)) rig.kick(10);
      break;
    }
    case 'fell': {
      const play = S.phase === 'play';
      const by = e.by != null ? infoOf(e.by) : null;
      const who = ui.nameHtml(infoOf(e.id));
      if (by) ui.feed(`🥊 ${ui.nameHtml(by)} knocked ${who} off!${play ? ` <b>+${KNOCKOFF_BONUS}</b>` : ''}`, mine(e.id) || mine(e.by));
      else ui.feed(`💀 ${who} fell off!${play ? ` <b>−${FALL_PENALTY}</b>` : ''}`, mine(e.id));
      if (!play) break;
      if (mine(e.id)) ui.bigText(`FELL OFF! −${FALL_PENALTY}`, 'red small');
      else if (mine(e.by)) {
        ui.bigText(`KNOCKOFF! +${KNOCKOFF_BONUS}`, 'go small');
        audio.play('tag', { rate: 1.3 });
      }
      break;
    }
    case 'bonk': {
      const p = at(e.b);
      if (p) {
        effects.burst({ x: p.x, y: p.y + 1.2, z: p.z }, { count: 22, colors: [0xffe14d, 0xffffff, 0xff4fa3], speed: 9, up: 3, size: 0.35, additive: true });
        effects.ring(p, 0xffe14d, 2.5, 0.35);
      }
      audio.play('punch', { at: p, rate: 0.6 });
      audio.play('bounce', { at: p, rate: 0.7, volume: 0.6 });
      S.views.get(e.b)?.stretch(1.6);
      S.views.get(e.a)?.land(10);
      effects.addShake(mine(e.a) || mine(e.b) ? 0.45 : near(p) * 0.3);
      if (mine(e.a) || mine(e.b)) ui.feed(`🍄 ${ui.nameHtml(infoOf(e.a))} bonked ${ui.nameHtml(infoOf(e.b))}!`, true);
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
    case 'shot':
      shotFx(e, mine(e.id));
      break;
    case 'blast':
      blastFx(e);
      break;
    case 'countdown':
      ui.bigText(e.n === COUNTDOWN ? `${e.n}<small>${BOMBS_TEXT(bombCount(S.room?.players.length ?? 1))}</small>` : String(e.n), e.n === 1 ? 'red' : '');
      audio.play('beep', { jitter: 0 });
      break;
    case 'go': {
      const bombs = [...S.views.values()].filter((v) => v.state.it).length;
      ui.bigText(bombs > 1 ? `GO!<small>${bombs} BOMBS!</small>` : 'GO!', 'go');
      audio.play('go', { jitter: 0 });
      effects.addShake(0.2);
      break;
    }
  }
}

function warpPoof(p) {
  const c = { x: p.x, y: p.y + 0.9, z: p.z };
  effects.burst(c, { count: 26, colors: [0xc77dff, 0xffd6ff, 0x7b2cbf], speed: 6, up: 1, size: 0.3, life: 0.7, gravity: 0, drag: 3, additive: true });
  effects.burst(c, { count: 10, colors: [0xe0c8ff, 0xffffff], speed: 3, up: 0.5, size: 0.7, endSize: 1.3, gravity: -1, life: 0.6 });
  effects.ring(p, 0xc77dff, 2.2, 0.35);
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
    case 'balloon':
      audio.play('bounce', { at: p, rate: 1.5 });
      audio.play('whoosh', { at: p, rate: 0.8, volume: 0.5 });
      effects.burst({ x: p.x, y: p.y + 2.4, z: p.z }, { count: 16, colors: [0xff4fa3, 0xffffff, 0x2ee6ff], speed: 4, up: 2, size: 0.3 });
      break;
    case 'mushroom':
      audio.play('pickup', { at: p, rate: 0.55 });
      audio.play('bounce', { at: p, rate: 0.5 });
      effects.ring(p, 0xff2d55, 3, 0.45);
      effects.burst(c, { count: 30, colors: [0xff2d55, 0xffffff, 0xffd23f], speed: 8, up: 4, size: 0.4, additive: true });
      effects.addShake(mine ? 0.35 : near(p) * 0.3);
      break;
    case 'wall':
      audio.play('land', { at: p, rate: 0.7 });
      audio.play('punch', { at: p, rate: 0.5, volume: 0.6 });
      break;
    case 'stink':
      audio.play('whoosh', { at: p, rate: 0.55 });
      audio.play('slip', { at: p, rate: 0.6, volume: 0.6 });
      effects.burst(c, { count: 26, colors: [0x8cff5a, 0x5c9e2e, 0xc6ff8a], speed: 5, up: 1, size: 0.7, endSize: 1.6, gravity: -0.5, life: 1.2 });
      break;
    case 'fuse':
      audio.play('beep', { rate: 1.8, jitter: 0 });
      audio.play('whoosh', { rate: 1.6, volume: 0.6 });
      ui.fuseCut();
      for (const v of S.views.values()) {
        if (!v.state.it) continue;
        const q = v.bomb.getWorldPosition(new THREE.Vector3());
        effects.burst(q, { count: 18, colors: [0xffd23f, 0xff8c3a, 0xffffff], speed: 5, up: 3, size: 0.25, additive: true });
      }
      break;
    case 'magnet':
      audio.play('whoosh', { at: p, rate: 0.7 });
      audio.play('freeze', { at: p, rate: 0.6, volume: 0.5 });
      effects.ring(p, 0xff2d55, ITEMS.magnet.radius, 0.45, false, true);
      effects.ring(p, 0x2ee6ff, ITEMS.magnet.radius * 0.7, 0.35, false, true);
      effects.burst(c, { count: 20, colors: [0xff2d55, 0x2ee6ff, 0xffffff], speed: 4, up: 1, size: 0.3, additive: true });
      effects.addShake(mine ? 0.25 : near(p) * 0.3);
      break;
    default:
      audio.play('use', { at: p });
      effects.burst(c, { count: 14, colors: [0xffffff, 0xffd23f], speed: 4, up: 2, size: 0.3 });
  }
}

// ---------- guns ----------
function shotFx(e, mine) {
  const v = S.views.get(e.id);
  let from;
  if (mine && rig.firstPerson && vm.visible) from = vm.muzzleWorld(camera, muzzle);
  else if (v && (v.isSelf || v.placed)) from = v.muzzleWorld(muzzle);
  else if (e.from) from = muzzle.set(e.from[0], e.from[1], e.from[2]);
  else return;
  const color = GUN_COLOR[e.item] ?? 0xffffff;
  if (!mine) {
    v?.kickGun();
    const [sfx, rate] = GUN_SFX[e.item] || ['shoot', 1];
    audio.play(sfx, { at: from, rate });
  }
  effects.burst(from, { count: 6, colors: [color, 0xffffff], speed: 3, up: 0, size: 0.16, life: 0.15, gravity: 0, additive: true, jitter: 0.05 });
  if (e.item === 'rocket') {
    effects.burst(from, { count: 10, colors: [0xe8e8f0, 0xc8c8d8], speed: 2, up: 0.5, size: 0.35, endSize: 1, life: 0.6, gravity: -0.5, jitter: 0.1 });
    return;
  }
  if (e.item === 'pearl') return effects.burst(from, { count: 12, colors: [0xc77dff, 0xffd6ff], speed: 3, up: 0.5, size: 0.25, additive: true });
  if (!e.to) return;
  const to = { x: e.to[0], y: e.to[1], z: e.to[2] };
  if (e.item === 'grapple') {
    // the rope follows the shooter's hand while they get yanked toward the hook
    const src = (out) => {
      if (mine && rig.firstPerson && vm.visible) return vm.muzzleWorld(camera, out);
      const sv = S.views.get(e.id);
      return sv && (sv.isSelf || sv.placed) ? sv.muzzleWorld(out) : out.set(e.from[0], e.from[1], e.from[2]);
    };
    const caught = !!e.from && Math.hypot(...e.to.map((n, i) => n - e.from[i])) < ITEMS.grapple.range - 0.05;
    ropes.add(src, to, caught);
    if (caught) {
      effects.burst(to, { count: 14, colors: [0xffffff, 0x8cff5a, 0xdddddd], speed: 5, up: 1, size: 0.22, life: 0.4, additive: true });
      audio.play('punch', { at: to, rate: 1.6, volume: 0.6 });
      audio.play('whoosh', { at: from, rate: 1.2 });
    }
    return;
  }
  if (e.item === 'freezeray') {
    effects.beam(from, to, color, 0.13, 0.35);
    effects.beam(from, to, 0xffffff, 0.04, 0.2);
    const n = Math.min(24, Math.floor(from.distanceTo(to) / 1.2));
    for (let i = 1; i <= n; i++) {
      const k = i / (n + 1);
      const q = { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k, z: from.z + (to.z - from.z) * k };
      effects.burst(q, { count: 1, colors: [0xffffff, 0x9fe9ff], speed: 1, up: 0.2, size: 0.2, life: 0.6, gravity: 1, additive: true, jitter: 0.2 });
    }
    effects.burst(to, { count: 16, colors: [0xffffff, 0x9fe9ff, 0x5fd0ff], speed: 5, up: 1, size: 0.25, life: 0.6, gravity: 3, additive: true });
  } else {
    effects.beam(from, to, color, 0.07, 0.14);
    effects.beam(from, to, 0xffffff, 0.025, 0.08);
    effects.burst(to, { count: 12, colors: [color, 0xff8c3a, 0xffffff], speed: 6, up: 1, size: 0.2, life: 0.35, additive: true });
    effects.burst(to, { count: 4, colors: [0xdddddd], speed: 1, up: 0.5, size: 0.4, endSize: 0.8, life: 0.4, gravity: -1 });
  }
  if (e.hit == null) return;
  S.views.get(e.hit)?.stretch(1.4);
  effects.ring(to, color, 1.3, 0.25, true);
  audio.play(e.item === 'freezeray' ? 'freeze' : 'punch', { at: to, rate: 1.2 });
  if (mine) {
    ui.hitMarker();
    audio.play('beep', { volume: 0.35, rate: 2, jitter: 0 });
  }
  if (!mine && e.hit !== S.myId) return; // everyone's hits would flood the feed
  const verb = e.item === 'freezeray' ? 'froze' : 'blasted';
  ui.feed(`${ui.nameHtml(infoOf(e.id))} ${ITEMS[e.item]?.icon ?? ''} ${verb} ${ui.nameHtml(infoOf(e.hit))}`, true);
}

function blastFx(e) {
  if (!e.p) return;
  const p = { x: e.p[0], y: e.p[1], z: e.p[2] };
  projectiles.removeNear(p, 'rocket');
  const r = ITEMS.rocket.radius;
  effects.burst(p, { count: 60, colors: [0xffd23f, 0xff8c3a, 0xff2d55, 0xffffff], speed: 15, up: 3, size: 0.45, life: 0.7, additive: true });
  effects.burst(p, { count: 18, colors: [0x888899, 0xa0a0b0, 0xc0c0cc], speed: 5, up: 2, size: 0.8, endSize: 1.8, life: 1.1, gravity: -1, drag: 2.5 });
  effects.ring(p, 0xffb347, r, 0.35, true);
  effects.ring(p, 0xff8c3a, r * 1.4, 0.5);
  effects.flashAt({ x: p.x, y: p.y - 1, z: p.z }, 0xffaa44, 100);
  audio.play('boom', { at: p, rate: 1.25 });
  effects.addShake(Math.max(0, 1 - camera.position.distanceTo(p) / 25) * 0.9);
}

// own item use; guns aim with the camera and get instant recoil, the server's 'shot' draws the tracer
function useItem(self, gun, m, now) {
  const p = mover.pos;
  // the aim ray stops at players you can see too (server shot hitbox), or third person shoots past them
  const hb = [...world.solids];
  for (const v of S.views.values()) {
    if (v.isSelf || !v.root.visible) continue;
    const q = v.root.position;
    hb.push({ min: [q.x - 0.5, q.y, q.z - 0.5], max: [q.x + 0.5, q.y + PLAYER.height * v.scale, q.z + 0.5] });
  }
  const dir = rig.aimDir(hb, eyePos.set(p.x, p.y + PLAYER.eye * m.scale, p.z), aim);
  const r = (v) => Math.round(v * 1e4) / 1e4;
  net.send({ t: 'use', dir: [r(dir.x), r(dir.y), r(dir.z)] });
  S.useBuf = 0;
  if (!gun) return;
  S.nextShot = now + gun.cooldown * 1000 + 30; // a hair over the server's cooldown so no click is dropped
  const id = self.state.item;
  const big = id === 'rocket';
  vm.kick(big ? 1.5 : 1);
  rig.punch(big ? 0.09 : 0.035);
  self.kickGun();
  ui.crosshairKick();
  const [sfx, rate] = GUN_SFX[id] || ['shoot', 1];
  audio.play(sfx, { rate });
  if (big) effects.addShake(0.2);
  mover.facing = Math.atan2(dir.x, dir.z); // face the shot so others see where it went
}

function showResults(scores) {
  S.results = scores;
  ui.showResults(scores.map((s) => ({ ...s, bot: s.bot ?? infoOf(s.id)?.bot })), S.myId);
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

// fell off the map / into lava: back to a spawn, and the server scores it
function fell() {
  respawn();
  net.send({ t: 'fell' });
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
        fell();
        moverEvents.length = 0;
        return;
    }
  }
  moverEvents.length = 0;
}

// this player's bomb fuse right now (it only burns during play), or null
function fuseOf(v, now) {
  const f = v?.state.fuse;
  if (f == null) return null;
  return S.phase === 'play' ? Math.max(0, f - (now - S.snapAt) / 1000) : f;
}

function updateGame(dt, now) {
  const self = me();
  const m = chaosMods(S.chaos);
  tickMapClock(dt, now);
  const gunId = self && isGun(self.state.item) ? self.state.item : null;
  const orbiting = S.phase === 'results' && S.results;
  let look = { x: 0, y: 0 };

  if (self && S.mapReady) {
    if (input.take('view')) {
      prefs.firstPerson = !prefs.firstPerson;
      savePrefs();
    }
    if (rig.firstPerson !== prefs.firstPerson) rig.setFirstPerson(prefs.firstPerson);
    look = input.takeLook();
    if (input.locked && !S.paused) rig.look(look.x, look.y, prefs.sensitivity, prefs.invertY);

    const canMove = !S.paused && S.phase !== 'countdown' && S.phase !== 'results';
    if (input.take('jump')) mover.jumpBuffer = 0.12;
    if (input.take('dive')) mover.wantDive = true;
    // F: dance (tap = a couple of seconds, hold = keep going); moving stops it
    const ax = input.axes();
    if (input.take('dance')) mover.dancing = DANCE_TIME;
    if (input.isDown('dance')) mover.dancing = Math.max(mover.dancing, 0.2);
    else if ((ax.x || ax.y) && canMove) mover.dancing = 0;
    const gun = gunId && ITEMS[gunId];
    const pressed = input.take('use');
    if (pressed && gun) S.useBuf = now + 150;
    const wantUse = gun ? now < S.useBuf || input.isDown('use') : pressed;
    const stunned = mover.frozen > 0 || mover.slip > 0; // the server drops use while frozen or slipping
    if (wantUse && self.state.item && canMove && !stunned && (!gun || now >= S.nextShot)) useItem(self, gun, m, now);
    const dir = rig.moveDir(ax.x, ax.y);
    const inp = { x: dir.x, z: dir.z, locked: !canMove };

    // fixed steps, each with the map (moving boxes) at the time the step ends
    mover.boxes = world.solids;
    S.physAcc = Math.min(S.physAcc + dt, 0.25);
    while (S.physAcc >= STEP) {
      S.physAcc -= STEP;
      setMapTime(world.map, S.mt - S.physAcc);
      mover.step(STEP, inp, m, moverEvents);
      if (mover.pos.y < world.map.killY) {
        moverEvents.length = 0;
        fell();
      }
      if (moverEvents.length) handleMoverEvents(self);
    }

    // first person: body faces where you look (others see it, glove punches and dives go there)
    if (rig.firstPerson && mover.slip <= 0 && !mover.diving) mover.facing = rig.yaw + Math.PI;

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
  world.setTime(S.mt - STEP); // what's drawn: own player renders one step behind its physics

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

  projectiles.update(dt, now);

  // views
  if (self) self.hideBody = rig.firstPerson && !orbiting;
  const runRate = Math.max(0.6, Math.hypot(mover.vel.x, mover.vel.z) / 9);
  for (const v of S.views.values()) {
    v.update(dt, { scale: m.scale, fuse: fuseOf(v, now), darkness: world.darkness, runRate: v.isSelf ? runRate : 1, countdown: S.phase === 'countdown' });
  }

  // dizzy (stink cloud): wobbly camera
  const dizzy = mover.dizzy > 0 || !!self?.state.fx.includes('dizzy');
  S.dizzyK += ((dizzy ? 1 : 0) - S.dizzyK) * Math.min(1, dt * 3);

  updateHud(now, m, gunId);

  // camera
  if (orbiting) {
    const w = S.views.get(S.results[0]?.id) || self;
    if (w) orbitCamera(w.root.position, now / 1000, 5.5, 1.6);
  } else if (self) {
    const boosting = self.state.fx.includes('boost') || mover.boost > 0;
    const t = now / 1000;
    const shake = { ...effects.shake, roll: effects.shake.roll + Math.sin(t * 2.6) * 0.13 * S.dizzyK };
    const fov = (boosting ? 10 : 0) + (m.speed > 1 ? 6 : 0) + Math.sin(t * 1.9) * 6 * S.dizzyK;
    rig.update(dt, self.root.position, self.scale, world.solids, prefs.fov, shake, fov, !!gunId);
  }
  ropes.update(dt);

  // first-person gun
  vm.set(self && rig.firstPerson && !orbiting ? gunId : null);
  vm.update(dt, look, Math.hypot(mover.vel.x, mover.vel.z), mover.grounded, world.darkness);
}

function updateHud(now, m, gunId) {
  const self = me();
  const match = S.phase === 'countdown' || S.phase === 'play';
  const timeNow = S.time != null ? Math.max(0, S.time - (now - S.snapAt) / 1000) : null;

  if (S.phase === 'play') ui.setTimer(timeNow);
  else ui.setTimer(null);
  if (S.phase === 'results') ui.setResultsTimer(timeNow ?? 0);

  // bombs: your own fuse if you're IT, else the one about to blow
  const its = [...S.views.values()].filter((v) => v.state.it);
  const iAmIt = match && !!self?.state.it;
  let shown = iAmIt ? self : null;
  if (!iAmIt) for (const v of its) if (!shown || fuseOf(v, now) < fuseOf(shown, now)) shown = v;
  const fuseNow = match && shown ? fuseOf(shown, now) : null;
  ui.setFuse(fuseNow, shown?.fuseMax, its.length);
  ui.setItLabel(match ? its.filter((v) => !v.isSelf).map((v) => infoOf(v.id)).filter(Boolean) : [], iAmIt);
  ui.setYouAreIt(iAmIt);
  ui.setFrozenVignette(!!self && S.phase !== 'countdown' && (self.state.fx.includes('frozen') || mover.frozen > 0));
  ui.setDizzyVignette(S.dizzyK > 0.3);

  if (self) {
    ui.setScore(self.state.score);
    ui.setItem(self.state.item, self.state.ammo);
  }

  // chaos badge
  if (match && S.chaos && CHAOS[S.chaos]) {
    const left = CHAOS_DURATION - (now - S.chaosAt) / 1000;
    ui.chaosBadge(CHAOS[S.chaos].name, left, left / CHAOS_DURATION);
  } else ui.chaosBadge(null);

  // fuse ticking: faster near zero, louder for IT
  if (S.phase === 'play' && fuseNow != null && now >= S.nextBeep) {
    const interval = fuseNow < 3 ? 0.22 : fuseNow < 6 ? 0.5 : 1;
    if (iAmIt || fuseNow < 6) audio.play('beep', { volume: iAmIt ? 0.45 : 0.18, rate: fuseNow < 3 ? 1.5 : 1.2, jitter: 0 });
    S.nextBeep = now + interval * 1000;
  }

  // Tab scoreboard
  const showBoard = match && input.isDown('scores');
  if (showBoard) {
    const rows = [...S.views.values()]
      .map((v) => ({ id: v.id, name: v.name, color: v.color, score: v.state.score, it: v.state.it, bot: infoOf(v.id)?.bot }))
      .sort((a, b) => b.score - a.score);
    ui.setScoreboard(true, rows, S.myId);
  } else ui.setScoreboard(false);

  ui.setCrosshair(input.locked && S.phase !== 'results', gunId);
}

// camera orbit around a point, subject shifted right of center (UI card sits on the left)
const orbitDir = new THREE.Vector3();
function orbitCamera(p, t, radius, height) {
  const a = Math.sin(t * 0.25) * 0.7;
  const head = new THREE.Vector3(p.x, p.y + 1.2, p.z);
  orbitDir.set(Math.sin(a) * radius, height - 1.2, Math.cos(a) * radius);
  const len = orbitDir.length();
  orbitDir.divideScalar(len);
  const dist = Math.max(1.5, Math.min(len, raycastBoxes(world.solids || [], head, orbitDir, len + 0.3) - 0.3));
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

  world.update(dt, S.screen === 'game' && rig.firstPerson ? null : camera.position); // FP: no lens to hide boxes from
  world.assignLights(S.screen === 'game' ? [...S.views.values()] : [], camera.position);
  effects.resize(renderer.domElement.height, camera);
  effects.update(dt);
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
  audio.setListener(camera.position, right);
  renderer.render(scene, camera);
  if (S.screen === 'game' && vm.visible) vm.render(renderer);
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
  gameSettings: (st) => net.send({ t: 'settings', items: st.items, round: st.round, chaos: st.chaos }),
  bot: (add) => net.send({ t: 'bot', add }),
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
