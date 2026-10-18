// Rooms + game rules. The server is authoritative for rooms, phases, timers, IT, tags, scores,
// items, guns, rockets, peels, chaos and teleports. It uses the positions humans report and only
// simulates movement for bots (server/bot.js).

import {
  TICK_RATE, MAX_PLAYERS, COUNTDOWN, ROUND_TIME, RESULTS_TIME,
  TAG_DIST, TAG_HEIGHT, NO_TAGBACK, IT_STUN, TAG_BONUS, BOMB_FUSE, BOMB_PENALTY,
  CHAOS_EVERY, CHAOS_DURATION, ITEM_RESPAWN, PICKUP_DIST, PEEL_DIST, PLAYER,
} from '../shared/config.js';
import { MAPS, MAP_IDS } from '../shared/maps.js';
import { ITEMS, ITEM_IDS } from '../shared/items.js';
import { CHAOS_IDS, mods } from '../shared/chaos.js';
import { raycastBoxes } from '../shared/physics.js';
import { Bot, BOT_NAMES } from './bot.js';

const ANIMS = new Set(['idle', 'run', 'jump', 'fall', 'dive', 'slip']);
const FX_FLAGS = ['ghost', 'shield', 'frozen', 'boost', 'slip'];
const COLORS = [0xff595e, 0xffca3a, 0x8ac926, 0x1982c4, 0x6a4c93, 0xff924c, 0x52a675, 0xf15bb5];
const NAME_MAX = 16;
const MAX_COORD = 1e4;
const PEEL_BEHIND = 1.2; // banana peel drop distance behind the user
const PEEL_HEIGHT = 1; // max vertical distance to slip on a peel
const GLOVE_CONE = 0.3; // min cos(angle) between facing and target: "in front"
const SHIELD_KNOCK = { force: 12, up: 6 }; // IT bounced off a shield
const BOOM_KNOCK = { force: 6, up: 22 }; // IT launched by the bomb
const HIT_R = 0.5; // player hitbox half-width for shots and rockets
const SHOT_GRACE = 0.1; // a shot may arrive this early (network jitter); the fire rate still averages out to the cooldown

const rooms = new Map(); // code -> Room
let nextId = 1;

// ---------- helpers ----------

const now = () => performance.now() / 1000;
const rand = (min, max) => min + Math.random() * (max - min);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const round2 = (n) => Math.round(n * 100) / 100;
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const hdist = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const forward = (ry) => [Math.sin(ry), 0, Math.cos(ry)];
const xyz = (a) => ({ x: a[0], y: a[1], z: a[2] });

// Weighted random item id (ITEMS[id].weight, default 1).
const TOTAL_WEIGHT = ITEM_IDS.reduce((sum, id) => sum + (ITEMS[id].weight ?? 1), 0);
function randomItem() {
  let r = Math.random() * TOTAL_WEIGHT;
  for (const id of ITEM_IDS) {
    r -= ITEMS[id].weight ?? 1;
    if (r < 0) return id;
  }
  return ITEM_IDS.at(-1);
}

// Top of the highest map box under (x, z) that is not above y (so a drop lands on it), else y.
function groundBelow(boxes, x, z, y) {
  let top = -Infinity;
  for (const b of boxes) {
    if (x > b.min[0] && x < b.max[0] && z > b.min[2] && z < b.max[2] && b.max[1] <= y + 0.1 && b.max[1] > top) top = b.max[1];
  }
  return top > -Infinity ? top : y;
}

function shuffle(arr) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Horizontal push from `from` toward `to` (random direction if they overlap), plus `up`.
function push(from, to, force, up) {
  let dx = to[0] - from[0];
  let dz = to[2] - from[2];
  let d = Math.hypot(dx, dz);
  if (d < 0.01) {
    const a = Math.random() * Math.PI * 2;
    [dx, dz, d] = [Math.sin(a), Math.cos(a), 1];
  }
  return [(dx / d) * force, up, (dz / d) * force];
}

function cleanName(name) {
  if (typeof name !== 'string') return '';
  const chars = [...name.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim()];
  return chars.slice(0, NAME_MAX).join('').trim();
}

const cleanColor = (c) => (Number.isInteger(c) && c >= 0 && c <= 0xffffff ? c : pick(COLORS));
const isVec3 = (p) => Array.isArray(p) && p.length === 3 && p.every((n) => isNum(n) && Math.abs(n) < MAX_COORD);

// Client aim vector -> unit vector, or null if missing / invalid.
function unit(d) {
  if (!isVec3(d)) return null;
  const len = Math.hypot(...d);
  return len > 1e-6 ? d.map((n) => n / len) : null;
}

function newCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
  } while (rooms.has(code));
  return code;
}

// ---------- item effects: (room, user, t) ----------

const USE = {
  boots(room, pl, t) {
    const { duration, speed } = ITEMS.boots;
    pl.fx.boost = t + duration;
    room.fx(pl, 'boost', { dur: duration, speed });
  },
  banana(room, pl, t) {
    const f = forward(pl.ry);
    const [x, z] = [pl.p[0] - f[0] * PEEL_BEHIND, pl.p[2] - f[2] * PEEL_BEHIND];
    const p = [x, groundBelow(MAPS[room.map].boxes, x, z, pl.p[1]), z]; // lands even if dropped mid-air
    room.peels.push({ id: room.nextPeelId++, owner: pl.id, p, until: t + ITEMS.banana.life });
  },
  glove(room, pl) {
    const { range, force, up } = ITEMS.glove;
    const f = forward(pl.ry);
    for (const other of room.others(pl)) {
      const dx = other.p[0] - pl.p[0];
      const dz = other.p[2] - pl.p[2];
      const d = Math.hypot(dx, dz);
      if (d > range || Math.abs(other.p[1] - pl.p[1]) > TAG_HEIGHT) continue;
      if (d > 0.01 && (dx * f[0] + dz * f[2]) / d < GLOVE_CONE) continue; // not in front
      room.knock(other, d > 0.01 ? push(pl.p, other.p, force, up) : [f[0] * force, up, f[2] * force]);
    }
  },
  swap(room, pl) {
    const other = pick(room.others(pl));
    if (!other) return;
    const [a, b] = [pl.p, other.p];
    room.teleport(pl, b);
    room.teleport(other, a);
  },
  ghost(room, pl, t) {
    pl.fx.ghost = t + ITEMS.ghost.duration;
  },
  freeze(room, pl) {
    const { radius, duration } = ITEMS.freeze;
    for (const other of room.others(pl)) {
      if (dist(other.p, pl.p) <= radius) room.freeze(other, duration);
    }
  },
  spring(room, pl) {
    room.knock(pl, [0, ITEMS.spring.up, 0]);
  },
  shield(room, pl, t) {
    pl.fx.shield = t + ITEMS.shield.duration;
  },
};

// ---------- Room ----------

class Room {
  constructor(code) {
    this.code = code;
    this.players = new Map(); // id -> player, in join order
    this.host = null;
    this.map = MAP_IDS[0];
    this.phase = 'lobby';
    this.phaseEnd = 0;
    this.count = 0; // last countdown number announced
    this.it = null; // id of IT player
    this.fuse = null; // bomb seconds left
    this.chaos = null; // active chaos id (mods only)
    this.chaosEnd = 0;
    this.nextChaos = 0;
    this.lastChaos = null;
    this.boxes = []; // per map.items spot: time it becomes available
    this.peels = [];
    this.nextPeelId = 1;
    this.rockets = []; // { id, owner, p, dir, until }
    this.nextRocketId = 1;
    this.resetBoxes();
    this.last = now();
    this.timer = setInterval(() => this.tick(), 1000 / TICK_RATE);
  }

  // --- messaging ---

  // bots have no socket
  send(pl, msg) {
    if (pl.ws && pl.ws.readyState === pl.ws.OPEN) pl.ws.send(JSON.stringify(msg));
  }

  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const pl of this.players.values()) {
      if (pl.ws && pl.ws.readyState === pl.ws.OPEN) pl.ws.send(data);
    }
  }

  ev(k, data = {}) {
    this.broadcast({ t: 'ev', k, ...data });
  }

  // bots apply effects to their own physics, like a client would
  fx(pl, k, data) {
    if (pl.bot) pl.bot.fx(k, data);
    else this.send(pl, { t: 'fx', k, ...data });
  }

  broadcastRoom() {
    this.broadcast({
      t: 'room',
      code: this.code,
      host: this.host,
      map: this.map,
      phase: this.phase,
      players: [...this.players.values()].map(({ id, name, color, bot }) => ({ id, name, color, bot: !!bot })),
    });
  }

  // --- players ---

  // ws = null + bot = Bot for a bot player
  add(ws, name, color, bot = null) {
    const id = nextId++;
    const pl = {
      id, ws, bot, name: name || `Player ${id}`, color,
      p: [...pick(MAPS[this.map].spawns)], ry: 0, a: 'idle',
      seq: 0, // last teleport seq sent; state older than this is ignored
      score: 0, item: null,
      ammo: null, // shots left while holding a gun
      nextShot: 0, // gun cooldown end time
      fx: {}, // flag -> end time
      noTag: null, // { id, until }: while IT, can't tag this player
    };
    this.players.set(id, pl);
    if (this.host == null && !bot) this.host = id;
    bot?.mover.teleport(pl.p);
    this.send(pl, { t: 'joined', id, code: this.code });
    this.broadcastRoom();
    return pl;
  }

  addBot() {
    const taken = [...this.players.values()];
    const name = pick(BOT_NAMES.filter((n) => !taken.some((o) => o.name === n))) || 'Bot';
    const color = pick(COLORS.filter((c) => !taken.some((o) => o.color === c))) ?? Math.floor(Math.random() * 0x1000000);
    this.add(null, name, color, new Bot());
  }

  // Bots stay when humans leave; the room goes away with its last human.
  remove(pl) {
    this.players.delete(pl.id);
    const humans = [...this.players.values()].filter((o) => !o.bot);
    if (humans.length === 0) return this.destroy();
    if (this.host === pl.id) this.host = humans[0].id;
    if (this.it === pl.id) this.it = pick([...this.players.keys()]); // bomb (and fuse) passes on
    if (this.players.size === 1 && (this.phase === 'countdown' || this.phase === 'play')) return this.startResults(); // no opponents left
    this.broadcastRoom();
  }

  others(pl) {
    return [...this.players.values()].filter((o) => o !== pl);
  }

  destroy() {
    clearInterval(this.timer);
    rooms.delete(this.code);
  }

  // --- effects ---

  has(pl, flag, t) {
    return pl.fx[flag] > t;
  }

  teleport(pl, p) {
    pl.seq++;
    pl.p = [...p];
    this.fx(pl, 'tp', { p: pl.p, seq: pl.seq });
  }

  knock(pl, v) {
    this.fx(pl, 'knock', { v: v.map(round2) });
  }

  freeze(pl, dur) {
    pl.fx.frozen = Math.max(pl.fx.frozen || 0, now() + dur);
    this.fx(pl, 'freeze', { dur });
  }

  slip(pl, t) {
    const dur = ITEMS.banana.slip;
    pl.fx.slip = t + dur;
    this.fx(pl, 'slip', { dur });
    this.ev('slip', { id: pl.id });
  }

  give(pl, item) {
    pl.item = item;
    pl.ammo = ITEMS[item].gun ? ITEMS[item].ammo : null;
    pl.nextShot = 0;
    this.ev('pickup', { id: pl.id, item });
  }

  eye(pl) {
    return [pl.p[0], pl.p[1] + PLAYER.eye * mods(this.chaos).scale, pl.p[2]];
  }

  // Nearest hit along a unit ray: map boxes stop it, players (shot hitbox) are hit. Returns { d, hit }.
  trace(from, dir, range, skipId) {
    const o = xyz(from);
    const d = xyz(dir);
    const h = PLAYER.height * mods(this.chaos).scale;
    let best = raycastBoxes(MAPS[this.map].boxes, o, d, range);
    let hit = null;
    for (const pl of this.players.values()) {
      if (pl.id === skipId) continue;
      const [x, y, z] = pl.p;
      const t = raycastBoxes([{ min: [x - HIT_R, y, z - HIT_R], max: [x + HIT_R, y + h, z + HIT_R] }], o, d, best);
      if (t < best) [best, hit] = [t, pl];
    }
    return { d: best, hit };
  }

  // --- client messages ---

  onMessage(pl, msg) {
    if (msg.t === 's') this.onState(pl, msg);
    else if (msg.t === 'use') this.useItem(pl, unit(msg.dir));
    else if (msg.t === 'map') this.setMap(pl, msg.map);
    else if (msg.t === 'start') this.start(pl);
    else if (msg.t === 'bot') this.setBots(pl, msg.add);
  }

  onState(pl, msg) {
    const tp = Number.isInteger(msg.tp) ? msg.tp : 0;
    if (tp < pl.seq) return; // hasn't seen our latest teleport yet
    if (isVec3(msg.p)) pl.p = [...msg.p];
    if (isNum(msg.ry)) pl.ry = msg.ry;
    if (ANIMS.has(msg.a)) pl.a = msg.a;
  }

  setMap(pl, map) {
    if (pl.id !== this.host || this.phase !== 'lobby' || !MAP_IDS.includes(map) || map === this.map) return;
    this.map = map;
    this.peels = [];
    this.rockets = [];
    this.resetBoxes();
    this.broadcastRoom();
    this.toSpawns();
  }

  start(pl) {
    if (pl.id !== this.host || this.phase !== 'lobby') return;
    this.startCountdown();
  }

  // add = true: one more bot (if there's room), false: remove the newest bot
  setBots(pl, add) {
    if (pl.id !== this.host || this.phase !== 'lobby') return;
    if (add) {
      if (this.players.size < MAX_PLAYERS) this.addBot();
      return;
    }
    const bot = [...this.players.values()].reverse().find((o) => o.bot);
    if (bot) this.remove(bot);
  }

  // dir: unit aim vector or null (guns need it)
  useItem(pl, dir) {
    const t = now();
    if (!pl.item || this.phase === 'countdown' || this.has(pl, 'frozen', t) || this.has(pl, 'slip', t)) return;
    const item = pl.item;
    if (ITEMS[item].gun) return this.shoot(pl, item, dir, t);
    pl.item = null;
    this.ev('use', { id: pl.id, item, p: pl.p.map(round2) });
    USE[item](this, pl, t);
  }

  // Hitscan (blaster, freeze ray) or a rocket. The gun is gone after its last shot. Shields don't block guns.
  shoot(pl, item, dir, t) {
    const gun = ITEMS[item];
    if (!dir || t < pl.nextShot - SHOT_GRACE) return;
    pl.nextShot = Math.max(pl.nextShot, t) + gun.cooldown;
    if (--pl.ammo <= 0) {
      pl.item = null;
      pl.ammo = null;
    }
    const from = this.eye(pl);
    const shot = { id: pl.id, item, from: from.map(round2), to: null, hit: null };
    if (item === 'rocket') {
      this.rockets.push({ id: this.nextRocketId++, owner: pl.id, p: from, dir, until: t + gun.life });
      return this.ev('shot', shot);
    }
    const { d, hit } = this.trace(from, dir, gun.range, pl.id);
    if (hit && item === 'blaster') this.knock(hit, [dir[0] * gun.force, Math.max(dir[1] * gun.force, 0) + gun.up, dir[2] * gun.force]);
    if (hit && item === 'freezeray') this.freeze(hit, gun.duration);
    shot.to = from.map((n, i) => round2(n + dir[i] * d));
    shot.hit = hit ? hit.id : null;
    this.ev('shot', shot);
  }

  // --- phases ---

  setPhase(phase, duration) {
    this.phase = phase;
    this.phaseEnd = now() + duration;
    this.broadcastRoom();
  }

  // Teleports everyone to distinct (shuffled) spawns.
  toSpawns() {
    const spawns = shuffle(MAPS[this.map].spawns);
    [...this.players.values()].forEach((pl, i) => this.teleport(pl, spawns[i % spawns.length]));
  }

  startCountdown() {
    this.count = 0;
    this.chaos = null;
    this.lastChaos = null;
    this.peels = [];
    this.rockets = [];
    this.resetBoxes();
    for (const pl of this.players.values()) {
      Object.assign(pl, { score: 0, item: null, ammo: null, fx: {}, noTag: null });
      pl.bot?.mover.reset(); // clients reset their own effects too
    }
    this.it = pick([...this.players.keys()]);
    this.fuse = rand(...BOMB_FUSE);
    this.setPhase('countdown', COUNTDOWN);
    this.toSpawns();
    for (const pl of this.players.values()) this.freeze(pl, COUNTDOWN);
  }

  startPlay(t) {
    this.nextChaos = t + CHAOS_EVERY;
    this.setPhase('play', ROUND_TIME);
    this.ev('go');
  }

  startResults() {
    const scores = [...this.players.values()]
      .sort((a, b) => b.score - a.score)
      .map(({ id, name, color, score }) => ({ id, name, color, score: Math.floor(score) }));
    this.it = null;
    this.fuse = null;
    this.chaos = null;
    this.broadcast({ t: 'results', scores });
    this.setPhase('results', RESULTS_TIME);
  }

  // --- tick ---

  tick() {
    const t = now();
    const dt = Math.min(t - this.last, 0.25);
    this.last = t;
    const left = this.phaseEnd - t;

    for (const pl of this.players.values()) {
      if (!pl.bot) continue;
      try {
        pl.bot.update(this, pl, t, dt);
      } catch (err) {
        console.error('bot error', err); // a confused bot must not take the room down
      }
    }

    if (this.phase === 'countdown') this.tickCountdown(t, left);
    else if (this.phase === 'play') this.tickPlay(t, dt, left);
    else if (this.phase === 'results' && left <= 0) this.setPhase('lobby', 0);

    if (this.phase !== 'countdown') {
      this.tickBoxes(t);
      this.tickPeels(t);
      this.tickRockets(t, dt);
    }
    this.broadcast(this.snapshot(t));
  }

  tickCountdown(t, left) {
    if (left <= 0) return this.startPlay(t);
    const n = Math.ceil(left);
    if (n !== this.count) {
      this.count = n;
      this.ev('countdown', { n });
    }
  }

  tickPlay(t, dt, left) {
    if (left <= 0) return this.startResults();
    for (const pl of this.players.values()) {
      if (pl.id !== this.it) pl.score += dt;
    }
    if (t >= this.chaosEnd) this.chaos = null;
    if (t >= this.nextChaos) this.startChaos(t);
    this.fuse -= dt;
    if (this.fuse <= 0) this.boom(t);
    else this.checkTag(t);
  }

  checkTag(t) {
    const it = this.players.get(this.it);
    if (!it || this.has(it, 'frozen', t)) return;
    const range = TAG_DIST * mods(this.chaos).scale;
    for (const pl of this.others(it)) {
      if (it.noTag && it.noTag.id === pl.id && t < it.noTag.until) continue;
      if (hdist(it.p, pl.p) >= range || Math.abs(it.p[1] - pl.p[1]) >= TAG_HEIGHT) continue;
      if (this.has(pl, 'shield', t)) this.popShield(it, pl, t);
      else this.tag(it, pl, t);
      return;
    }
  }

  tag(it, pl, t) {
    it.score += TAG_BONUS;
    it.noTag = null;
    this.it = pl.id;
    pl.noTag = { id: it.id, until: t + NO_TAGBACK };
    this.freeze(pl, IT_STUN);
    this.ev('tag', { a: it.id, b: pl.id });
  }

  popShield(it, pl, t) {
    pl.fx.shield = 0;
    it.noTag = { id: pl.id, until: t + NO_TAGBACK }; // don't instantly tag them after the bounce
    this.knock(it, push(pl.p, it.p, SHIELD_KNOCK.force, SHIELD_KNOCK.up));
    this.ev('pop', { id: pl.id });
  }

  boom(t) {
    const it = this.players.get(this.it);
    if (!it) return;
    it.score -= BOMB_PENALTY;
    this.knock(it, push(it.p, it.p, BOOM_KNOCK.force, BOOM_KNOCK.up)); // random sideways + up
    this.ev('boom', { id: it.id });
    const next = pick(this.others(it)) || it;
    this.it = next.id;
    next.noTag = { id: it.id, until: t + NO_TAGBACK }; // the launched player is still in reach for a tick or two
    this.fuse = rand(...BOMB_FUSE);
  }

  startChaos(t) {
    const id = pick(CHAOS_IDS.filter((c) => c !== this.lastChaos));
    this.lastChaos = id;
    this.nextChaos = t + CHAOS_EVERY;
    this.ev('chaos', { id });
    if (id === 'swap') this.swapAll();
    else if (id === 'rain') this.itemRain();
    else {
      this.chaos = id;
      this.chaosEnd = t + CHAOS_DURATION;
    }
  }

  // Everyone moves to someone else's position (rotation over a shuffled order).
  swapAll() {
    const list = shuffle([...this.players.values()]);
    if (list.length < 2) return;
    const spots = list.map((pl) => pl.p);
    list.forEach((pl, i) => this.teleport(pl, spots[(i + 1) % spots.length]));
  }

  itemRain() {
    for (const pl of this.players.values()) this.give(pl, randomItem());
    this.boxes.fill(0);
  }

  resetBoxes() {
    this.boxes = MAPS[this.map].items.map(() => 0);
  }

  tickBoxes(t) {
    const spots = MAPS[this.map].items;
    for (const pl of this.players.values()) {
      if (pl.item) continue;
      const i = spots.findIndex((s, j) =>
        this.boxes[j] <= t && hdist(pl.p, s) < PICKUP_DIST && Math.abs(pl.p[1] - s[1]) < PLAYER.height);
      if (i < 0) continue;
      this.boxes[i] = t + ITEM_RESPAWN;
      this.give(pl, randomItem());
    }
  }

  tickPeels(t) {
    const players = [...this.players.values()];
    this.peels = this.peels.filter((peel) => {
      if (t >= peel.until) return false;
      const victim = players.find((pl) =>
        pl.id !== peel.owner && hdist(pl.p, peel.p) < PEEL_DIST && Math.abs(pl.p[1] - peel.p[1]) < PEEL_HEIGHT);
      if (!victim) return true;
      this.slip(victim, t);
      return false;
    });
  }

  // Rockets fly straight; each tick traces the whole step so they can't skip through thin boxes or players.
  tickRockets(t, dt) {
    const step = ITEMS.rocket.speed * dt;
    this.rockets = this.rockets.filter((r) => {
      const { d } = this.trace(r.p, r.dir, step, r.owner);
      const move = d < step ? Math.max(0, d - 0.1) : step; // stop just short of what it hit
      r.p = r.p.map((n, i) => n + r.dir[i] * move);
      if (d >= step && t < r.until) return true;
      this.blast(r);
      return false;
    });
  }

  // Radial knockback around the explosion, shooter included (rocket jumps). `up` is the least lift.
  blast(r) {
    const { radius, force, up } = ITEMS.rocket;
    const h = PLAYER.height * mods(this.chaos).scale;
    for (const pl of this.players.values()) {
      const c = [pl.p[0], pl.p[1] + h / 2, pl.p[2]];
      const d = dist(c, r.p);
      if (d > radius) continue;
      const k = 1 - d / radius / 2; // full push at the center, half at the edge
      const n = d > 0.01 ? c.map((v, i) => (v - r.p[i]) / d) : [0, 1, 0];
      this.knock(pl, [n[0] * force * k, Math.max(n[1] * force, up) * k, n[2] * force * k]);
    }
    this.ev('blast', { p: r.p.map(round2), id: r.owner });
  }

  snapshot(t) {
    return {
      t: 'snap',
      phase: this.phase,
      time: this.phase === 'lobby' ? 0 : round2(Math.max(0, this.phaseEnd - t)),
      chaos: this.chaos,
      fuse: this.fuse == null ? null : round2(Math.max(0, this.fuse)),
      players: [...this.players.values()].map((pl) => ({
        id: pl.id,
        p: pl.p.map(round2),
        ry: round2(pl.ry),
        a: pl.a,
        it: pl.id === this.it,
        fx: FX_FLAGS.filter((k) => this.has(pl, k, t)),
        score: Math.floor(pl.score),
        item: pl.item,
        ammo: pl.ammo,
      })),
      boxes: this.boxes.map((at) => at <= t),
      peels: this.peels.map(({ id, p }) => ({ id, p: p.map(round2) })),
      rockets: this.rockets.map(({ id, p }) => ({ id, p: p.map(round2) })),
    };
  }
}

// ---------- connections ----------

function parse(data, isBinary) {
  if (isBinary) return null;
  try {
    const msg = JSON.parse(data.toString());
    return msg && typeof msg === 'object' && !Array.isArray(msg) && typeof msg.t === 'string' ? msg : null;
  } catch {
    return null;
  }
}

// Returns the room to join, creating one when no code is given, or null after sending an error.
function findRoom(ws, code) {
  code = typeof code === 'string' ? code.trim().toUpperCase() : '';
  const fail = (msg) => {
    ws.send(JSON.stringify({ t: 'error', msg }));
    return null;
  };
  if (!code) {
    const room = new Room(newCode());
    rooms.set(room.code, room);
    return room;
  }
  const room = rooms.get(code);
  if (!room) return fail('Room not found');
  if (room.players.size >= MAX_PLAYERS) return fail('Room is full');
  return room;
}

export function handleConnection(ws) {
  let room = null;
  let player = null;
  ws.on('message', (data, isBinary) => {
    const msg = parse(data, isBinary);
    if (!msg) return;
    if (player) return room.onMessage(player, msg);
    if (msg.t !== 'join') return;
    room = findRoom(ws, msg.code);
    if (room) player = room.add(ws, cleanName(msg.name), cleanColor(msg.color));
  });
  ws.on('close', () => {
    if (player) room.remove(player);
    player = room = null;
  });
  ws.on('error', () => {});
}
