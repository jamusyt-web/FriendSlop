// Rooms + game rules. The server is authoritative for rooms, phases, timers, IT, tags, scores,
// items, guns, projectiles, peels, walls, clouds, chaos and teleports. It uses the positions humans
// report and only simulates movement for bots (server/bot.js). Each room keeps its own map copy
// (moving / blinking boxes) and runs the shared map time `mt`.

import {
  TICK_RATE, MAX_PLAYERS, COUNTDOWN, ROUND_TIME, ROUND_TIMES, RESULTS_TIME,
  TAG_DIST, TAG_HEIGHT, NO_TAGBACK, IT_STUN, TAG_BONUS, BOMB_FUSE, BOMB_PENALTY, bombCount,
  FALL_PENALTY, KNOCKOFF_BONUS, KNOCKOFF_WINDOW,
  CHAOS_EVERY, CHAOS_DURATION, ITEM_RESPAWN, PICKUP_DIST, PEEL_DIST, PLAYER,
} from '../shared/config.js';
import { MAP_IDS, instantiate, setMapTime } from '../shared/maps.js';
import { ITEMS, ITEM_IDS } from '../shared/items.js';
import { CHAOS_IDS, mods } from '../shared/chaos.js';
import { raycastBoxes } from '../shared/physics.js';
import { Bot, BOT_NAMES } from './bot.js';

const ANIMS = new Set(['idle', 'run', 'jump', 'fall', 'dive', 'slip', 'dance']);
const FX_FLAGS = ['ghost', 'shield', 'frozen', 'boost', 'slip', 'float', 'giant', 'dizzy'];
const COLORS = [
  0xff595e, 0xffca3a, 0x8ac926, 0x1982c4, 0x6a4c93, 0xff924c, 0x52a675, 0xf15bb5,
  0x00bbf9, 0xfee440, 0x9b5de5, 0x00f5d4, 0xb5651d, 0xf72585, 0xc0c0c0, 0x3a0ca3,
];
const NAME_MAX = 16;
const MAX_COORD = 1e4;
const PEEL_BEHIND = 1.2; // banana peel drop distance behind the user
const PEEL_HEIGHT = 1; // max vertical distance to slip on a peel
const GLOVE_CONE = 0.3; // min cos(angle) between facing and target: "in front"
const SHIELD_KNOCK = { force: 12, up: 6 }; // IT bounced off a shield
const BOOM_KNOCK = { force: 6, up: 22 }; // IT launched by the bomb
const HIT_R = 0.5; // player hitbox half-width for shots and projectiles
const SHOT_GRACE = 0.1; // a shot may arrive this early (network jitter); the fire rate still averages out to the cooldown
const DIZZY = 1.5; // stink: dizzy lingers this long after leaving the cloud
const BONK_COOLDOWN = 0.6; // a giant bonks the same victim at most this often
const FELL_LIMIT = 1; // seconds between counted falls per player

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

// Weighted random item id among the enabled `ids` (ITEMS[id].weight, default 1). null if none are enabled.
function randomItem(ids) {
  let r = Math.random() * ids.reduce((sum, id) => sum + (ITEMS[id].weight ?? 1), 0);
  for (const id of ids) {
    r -= ITEMS[id].weight ?? 1;
    if (r < 0) return id;
  }
  return ids.at(-1) ?? null;
}

// Highest box under (x, z) with its top not above y (so a drop lands on it), or null.
function floorBelow(boxes, x, z, y) {
  let best = null;
  for (const b of boxes) {
    if (x > b.min[0] && x < b.max[0] && z > b.min[2] && z < b.max[2] && b.max[1] <= y + 0.1 && (!best || b.max[1] > best.max[1])) best = b;
  }
  return best;
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

const newStats = () => ({ tags: 0, knockoffs: 0, falls: 0, booms: 0 }); // per round, for the results awards

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
    const p = [x, floorBelow(room.solids, x, z, pl.p[1])?.max[1] ?? pl.p[1], z]; // lands even if dropped mid-air
    room.peels.push({ id: room.nextObj++, owner: pl.id, p, until: t + ITEMS.banana.life });
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
      room.knock(other, d > 0.01 ? push(pl.p, other.p, force, up) : [f[0] * force, up, f[2] * force], pl.id);
    }
  },
  swap(room, pl) {
    const other = pick(room.others(pl));
    if (!other) return;
    const [a, b] = [pl.p, other.p];
    room.teleport(pl, b);
    room.teleport(other, a);
    room.hit(other, pl.id);
  },
  ghost(room, pl, t) {
    pl.fx.ghost = t + ITEMS.ghost.duration;
  },
  freeze(room, pl) {
    const { radius, duration } = ITEMS.freeze;
    for (const other of room.others(pl)) {
      if (dist(other.p, pl.p) <= radius) room.freeze(other, duration, pl.id);
    }
  },
  spring(room, pl) {
    room.knock(pl, [0, ITEMS.spring.up, 0]);
  },
  shield(room, pl, t) {
    pl.fx.shield = t + ITEMS.shield.duration;
  },
  balloon(room, pl, t) {
    const { duration } = ITEMS.balloon;
    pl.fx.float = t + duration;
    room.fx(pl, 'float', { dur: duration });
  },
  mushroom(room, pl, t) {
    pl.fx.giant = t + ITEMS.mushroom.duration; // bigger tag reach; giants that aren't IT bonk people (tickGiants)
  },
  // Solid box behind you, across your facing (axis-aligned by its dominant axis), standing at your feet.
  wall(room, pl, t) {
    const { size: [w, h, thick], dist: back, duration } = ITEMS.wall;
    const f = forward(pl.ry);
    const [x, y, z] = [pl.p[0] - f[0] * back, pl.p[1], pl.p[2] - f[2] * back];
    const [hx, hz] = Math.abs(f[0]) > Math.abs(f[2]) ? [thick / 2, w / 2] : [w / 2, thick / 2];
    const min = [x - hx, y, z - hz].map(round2);
    const max = [x + hx, y + h, z + hz].map(round2);
    room.walls.push({ id: room.nextObj++, min, max, kind: 'solid', until: t + duration });
  },
  stink(room, pl, t) {
    room.clouds.push({ id: room.nextObj++, owner: pl.id, p: [...pl.p], until: t + ITEMS.stink.duration });
  },
  fuse(room) {
    const { cut } = ITEMS.fuse;
    for (const o of room.players.values()) if (o.fuse != null) o.fuse = Math.min(o.fuse, Math.max(1, o.fuse - cut));
  },
  magnet(room, pl) {
    const { radius, force, up } = ITEMS.magnet;
    for (const other of room.others(pl)) {
      if (dist(other.p, pl.p) <= radius) room.knock(other, push(other.p, pl.p, force, up), pl.id);
    }
  },
};

// ---------- Room ----------

class Room {
  constructor(code) {
    this.code = code;
    this.players = new Map(); // id -> player, in join order
    this.spectators = new Map(); // id -> { id, ws, name, spectator }: watch (and may host), never play
    this.host = null;
    this.settings = { items: [...ITEM_IDS], round: ROUND_TIME, chaos: true }; // host picks in the lobby
    this.phase = 'lobby';
    this.phaseEnd = 0;
    this.count = 0; // last countdown number announced
    this.chaos = null; // active chaos id (mods only)
    this.chaosEnd = 0;
    this.nextChaos = 0;
    this.lastChaos = null;
    this.nextObj = 1; // ids for peels, projectiles, walls, clouds
    this.loadMap(MAP_IDS[0]);
    this.last = now();
    this.timer = setInterval(() => this.tick(), 1000 / TICK_RATE);
  }

  // Fresh private copy of the map; map time restarts at 0.
  loadMap(id) {
    this.mapId = id;
    this.map = instantiate(id);
    this.mapStart = now();
    this.mt = 0;
    this.solids = this.map.boxes.filter((b) => !b.off);
    this.clearWorld();
    this.resetBoxes();
  }

  clearWorld() {
    this.peels = []; // { id, owner, p, until }
    this.projectiles = []; // rockets + pearls: { id, owner, item, p, v, until }
    this.walls = []; // pop-up walls (solid boxes): { id, min, max, kind, until }
    this.clouds = []; // stink: { id, owner, p, until }
  }

  // --- messaging ---

  // bots have no socket
  send(pl, msg) {
    if (pl.ws && pl.ws.readyState === pl.ws.OPEN) pl.ws.send(JSON.stringify(msg));
  }

  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const pl of [...this.players.values(), ...this.spectators.values()]) {
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
      map: this.mapId,
      phase: this.phase,
      settings: this.settings,
      players: [...this.players.values()].map(({ id, name, color, bot }) => ({ id, name, color, bot: !!bot })),
      spectators: [...this.spectators.values()].map(({ id, name }) => ({ id, name })),
    });
  }

  // --- players ---

  // ws = null + bot = Bot for a bot player
  add(ws, name, color, bot = null) {
    const id = nextId++;
    const pl = {
      id, ws, bot, name: name || `Player ${id}`, color,
      p: [...pick(this.map.spawns)], ry: 0, a: 'idle',
      seq: 0, // last teleport seq sent; state older than this is ignored
      score: 0, item: null,
      ammo: null, // shots left while holding a gun
      nextShot: 0, // gun cooldown end time
      fx: {}, // flag -> end time
      fuse: null, // bomb seconds left while IT, else null
      noTag: null, // { id, until }: while IT, can't tag this player
      lastHit: null, // { id, t }: who last knocked / froze / slipped us (knockoff credit)
      bonkUntil: 0, // giants can't bonk us again until then
      nextFall: 0, // falls before this time are ignored
      boomedAt: 0, // when our bomb last went off (no fresh bomb back in the same tick)
      stats: newStats(),
    };
    this.players.set(id, pl);
    if (this.host == null && !bot) this.host = id;
    bot?.mover.teleport(pl.p);
    this.send(pl, { t: 'joined', id, code: this.code });
    this.broadcastRoom();
    return pl;
  }

  // Watches without playing: gets every broadcast and can host, but has no body, is never IT and takes no player slot.
  addSpectator(ws, name) {
    const id = nextId++;
    const sp = { id, ws, name: name || `Viewer ${id}`, spectator: true };
    this.spectators.set(id, sp);
    this.host ??= id;
    this.send(sp, { t: 'joined', id, code: this.code, spectate: true });
    this.broadcastRoom();
    return sp;
  }

  addBot() {
    const taken = [...this.players.values()];
    const name = pick(BOT_NAMES.filter((n) => !taken.some((o) => o.name === n))) || 'Bot';
    const color = pick(COLORS.filter((c) => !taken.some((o) => o.color === c))) ?? Math.floor(Math.random() * 0x1000000);
    this.add(null, name, color, new Bot());
  }

  // Bots stay when humans leave; the room goes away with its last human (player or spectator).
  // The host role goes to the first human player left, else to a spectator.
  remove(pl) {
    if (pl.spectator) this.spectators.delete(pl.id);
    else this.players.delete(pl.id);
    const humans = [...this.players.values()].filter((o) => !o.bot);
    if (humans.length === 0 && this.spectators.size === 0) return this.destroy();
    if (this.host === pl.id) this.host = humans[0]?.id ?? this.spectators.keys().next().value;
    if (pl.fuse != null) {
      const next = pick(this.runners()); // bomb (and fuse) passes on; nobody left to take it: it's gone
      if (next) next.fuse = pl.fuse;
    }
    if (!pl.spectator && this.players.size === 1 && (this.phase === 'countdown' || this.phase === 'play')) return this.startResults(); // no opponents left
    this.broadcastRoom();
  }

  others(pl) {
    return [...this.players.values()].filter((o) => o !== pl);
  }

  // players without a bomb
  runners() {
    return [...this.players.values()].filter((o) => o.fuse == null);
  }

  destroy() {
    clearInterval(this.timer);
    rooms.delete(this.code);
  }

  // --- effects ---

  has(pl, flag, t) {
    return pl.fx[flag] > t;
  }

  // Size multiplier for tag reach and shot hitboxes: chaos scale, times the mushroom's while giant.
  scale(pl, t) {
    return mods(this.chaos).scale * (this.has(pl, 'giant', t) ? ITEMS.mushroom.scale : 1);
  }

  // Remember who last messed with pl, for knockoff credit if pl falls off soon.
  hit(pl, byId) {
    if (byId != null && byId !== pl.id) pl.lastHit = { id: byId, t: now() };
  }

  teleport(pl, p) {
    pl.seq++;
    pl.p = [...p];
    this.fx(pl, 'tp', { p: pl.p, seq: pl.seq });
  }

  knock(pl, v, byId) {
    this.hit(pl, byId);
    this.fx(pl, 'knock', { v: v.map(round2) });
  }

  freeze(pl, dur, byId) {
    this.hit(pl, byId);
    pl.fx.frozen = Math.max(pl.fx.frozen || 0, now() + dur);
    this.fx(pl, 'freeze', { dur });
  }

  slip(pl, t, byId) {
    const dur = ITEMS.banana.slip;
    this.hit(pl, byId);
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

  // Nearest hit along a unit ray: map boxes + walls stop it, players (shot hitbox) are hit. Returns { d, hit }.
  trace(from, dir, range, skipId) {
    const t = now();
    const o = xyz(from);
    const d = xyz(dir);
    let best = raycastBoxes(this.solids, o, d, range);
    let hit = null;
    for (const pl of this.players.values()) {
      if (pl.id === skipId) continue;
      const [x, y, z] = pl.p;
      const h = PLAYER.height * this.scale(pl, t);
      const tt = raycastBoxes([{ min: [x - HIT_R, y, z - HIT_R], max: [x + HIT_R, y + h, z + HIT_R] }], o, d, best);
      if (tt < best) [best, hit] = [tt, pl];
    }
    return { d: best, hit };
  }

  // A player fell off the map or into lava and respawned (humans tell us, bots call this directly).
  // During play it costs points, and whoever knocked them off recently gets a knockoff.
  fell(pl, t) {
    if (t < pl.nextFall) return; // one per respawn is plenty (and no spamming)
    pl.nextFall = t + FELL_LIMIT;
    const last = pl.lastHit;
    const by = (last && t - last.t <= KNOCKOFF_WINDOW && this.players.get(last.id)) || null;
    pl.lastHit = null;
    if (this.phase === 'play') {
      pl.score -= FALL_PENALTY;
      pl.stats.falls++;
      if (by) {
        by.score += KNOCKOFF_BONUS;
        by.stats.knockoffs++;
      }
    }
    this.ev('fell', { id: pl.id, by: by ? by.id : null });
  }

  // --- client messages ---

  onMessage(pl, msg) {
    if (msg.t === 'map') this.setMap(pl, msg.map);
    else if (msg.t === 'settings') this.setSettings(pl, msg);
    else if (msg.t === 'start') this.start(pl);
    else if (msg.t === 'bot') this.setBots(pl, msg.add);
    else if (pl.spectator) return; // spectators only watch (and host)
    else if (msg.t === 's') this.onState(pl, msg);
    else if (msg.t === 'use') this.useItem(pl, unit(msg.dir));
    else if (msg.t === 'fell') this.fell(pl, now());
  }

  onState(pl, msg) {
    const tp = Number.isInteger(msg.tp) ? msg.tp : 0;
    if (tp < pl.seq) return; // hasn't seen our latest teleport yet
    if (isVec3(msg.p)) pl.p = [...msg.p];
    if (isNum(msg.ry)) pl.ry = msg.ry;
    if (ANIMS.has(msg.a)) pl.a = msg.a;
  }

  setMap(pl, map) {
    if (pl.id !== this.host || this.phase !== 'lobby' || !MAP_IDS.includes(map) || map === this.mapId) return;
    this.loadMap(map);
    this.broadcastRoom();
    this.toSpawns();
  }

  // Invalid fields keep their current value. items: enabled subset of ITEM_IDS (may be empty).
  setSettings(pl, msg) {
    if (pl.id !== this.host || this.phase !== 'lobby') return;
    const s = this.settings;
    if (Array.isArray(msg.items)) s.items = ITEM_IDS.filter((id) => msg.items.includes(id));
    if (ROUND_TIMES.includes(msg.round)) s.round = msg.round;
    if (typeof msg.chaos === 'boolean') s.chaos = msg.chaos;
    this.broadcastRoom();
  }

  start(pl) {
    if (pl.id !== this.host || this.phase !== 'lobby' || this.players.size === 0) return; // a spectator host needs players (or bots)
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

  // Hitscan (blaster, freeze ray), grapple (map only, pulls the shooter) or a projectile (rocket, pearl).
  // The gun is gone after its last shot. Shields don't block guns.
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
    if (gun.speed) { // rocket, pearl: flies on its own (tickProjectiles)
      this.projectiles.push({ id: this.nextObj++, owner: pl.id, item, p: from, v: dir.map((n) => n * gun.speed), until: t + gun.life });
      return this.ev('shot', shot);
    }
    let d, hit;
    if (item === 'grapple') {
      d = raycastBoxes(this.solids, xyz(from), xyz(dir), gun.range);
      if (d < gun.range) this.knock(pl, [dir[0] * gun.force, dir[1] * gun.force + gun.up, dir[2] * gun.force]);
    } else ({ d, hit } = this.trace(from, dir, gun.range, pl.id));
    if (hit && item === 'blaster') this.knock(hit, [dir[0] * gun.force, Math.max(dir[1] * gun.force, 0) + gun.up, dir[2] * gun.force], pl.id);
    if (hit && item === 'freezeray') this.freeze(hit, gun.duration, pl.id);
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

  // Teleports everyone to shuffled spawns, distinct while there are enough. When some must share,
  // only runners do: every IT starts on a spawn of its own.
  toSpawns() {
    const spawns = shuffle(this.map.spawns);
    const its = [...this.players.values()].filter((pl) => pl.fuse != null);
    its.forEach((pl, i) => this.teleport(pl, spawns[i % spawns.length]));
    const rest = spawns.length > its.length ? spawns.slice(its.length) : spawns;
    this.runners().forEach((pl, i) => this.teleport(pl, rest[i % rest.length]));
  }

  startCountdown() {
    this.count = 0;
    this.chaos = null;
    this.lastChaos = null;
    this.clearWorld();
    this.resetBoxes();
    for (const pl of this.players.values()) {
      Object.assign(pl, { score: 0, item: null, ammo: null, fx: {}, fuse: null, noTag: null, lastHit: null, bonkUntil: 0, stats: newStats() });
      pl.bot?.mover.reset(); // clients reset their own effects too
    }
    const bombs = bombCount(this.players.size);
    for (const pl of shuffle([...this.players.values()]).slice(0, bombs)) pl.fuse = rand(...BOMB_FUSE);
    this.setPhase('countdown', COUNTDOWN);
    this.toSpawns();
    for (const pl of this.players.values()) this.freeze(pl, COUNTDOWN);
  }

  startPlay(t) {
    this.nextChaos = t + CHAOS_EVERY;
    this.setPhase('play', this.settings.round);
    this.ev('go');
  }

  // Everyone celebrates on a spawn, the winner on one of their own: nobody can move during results, but
  // floors keep blinking out and pistons / rising lava keep going. Effects and leftovers (giants bonking,
  // peels, pearls in flight, ghosts) are cleared so nobody gets knocked off or hidden while the scores show.
  startResults() {
    const ranked = [...this.players.values()].sort((a, b) => b.score - a.score);
    const scores = ranked.map(({ id, name, color, score, bot, stats }) => ({ id, name, color, score: Math.floor(score), bot: !!bot, stats }));
    for (const pl of this.players.values()) Object.assign(pl, { fuse: null, fx: {} });
    this.clearWorld();
    const [first, ...rest] = shuffle(this.map.spawns);
    ranked.forEach((pl, i) => this.teleport(pl, i === 0 ? first : rest[(i - 1) % rest.length]));
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
    this.mt = t - this.mapStart;
    setMapTime(this.map, this.mt);
    this.walls = this.walls.filter((w) => t < w.until);
    this.solids = this.map.boxes.filter((b) => !b.off).concat(this.walls);

    for (const pl of this.players.values()) {
      if (!pl.bot) continue;
      try {
        pl.bot.update(this, pl, t, dt); // steps the map along with its physics, then sets it back to mt
      } catch (err) {
        console.error('bot error', err); // a confused bot must not take the room down
      }
    }

    if (this.phase !== 'countdown') {
      this.tickBoxes(t);
      this.tickPeels(t);
      this.tickProjectiles(t, dt);
      this.tickClouds(t);
      this.tickGiants(t);
    }

    if (this.phase === 'countdown') this.tickCountdown(t, left);
    else if (this.phase === 'play') this.tickPlay(t, dt, left);
    else if (this.phase === 'results' && left <= 0) this.setPhase('lobby', 0);

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
      if (pl.fuse == null) pl.score += dt;
    }
    if (t >= this.chaosEnd) this.chaos = null;
    if (this.settings.chaos && t >= this.nextChaos) this.startChaos(t);
    for (const pl of this.players.values()) {
      if (pl.fuse == null) continue;
      pl.fuse -= dt;
      if (pl.fuse <= 0) this.boom(pl, t);
    }
    this.checkTags(t);
  }

  // Every unfrozen IT tags the first runner in reach. ITs can't tag each other.
  checkTags(t) {
    const range = TAG_DIST * mods(this.chaos).scale;
    for (const it of this.players.values()) {
      if (it.fuse == null || this.has(it, 'frozen', t)) continue;
      const reach = range * (this.has(it, 'giant', t) ? ITEMS.mushroom.scale : 1);
      for (const pl of this.others(it)) {
        if (pl.fuse != null || (it.noTag && it.noTag.id === pl.id && t < it.noTag.until)) continue;
        if (hdist(it.p, pl.p) >= reach || Math.abs(it.p[1] - pl.p[1]) >= TAG_HEIGHT) continue;
        if (this.has(pl, 'shield', t)) this.popShield(it, pl, t);
        else this.tag(it, pl, t);
        break;
      }
    }
  }

  tag(it, pl, t) {
    it.score += TAG_BONUS;
    it.stats.tags++;
    it.noTag = null;
    pl.fuse = it.fuse; // the bomb passes along, fuse and all
    it.fuse = null;
    pl.noTag = { id: it.id, until: t + NO_TAGBACK };
    this.freeze(pl, IT_STUN);
    this.ev('tag', { a: it.id, b: pl.id });
    it.bot?.taunt();
  }

  popShield(it, pl, t) {
    pl.fx.shield = 0;
    it.noTag = { id: pl.id, until: t + NO_TAGBACK }; // don't instantly tag them after the bounce
    this.knock(it, push(pl.p, it.p, SHIELD_KNOCK.force, SHIELD_KNOCK.up), pl.id);
    this.ev('pop', { id: pl.id });
  }

  // The bomb goes off on `it`; a random runner gets a fresh one. Nobody left to take it: it's gone.
  boom(it, t) {
    it.score -= BOMB_PENALTY;
    it.stats.booms++;
    it.fuse = null;
    it.boomedAt = t;
    this.knock(it, push(it.p, it.p, BOOM_KNOCK.force, BOOM_KNOCK.up)); // random sideways + up
    this.ev('boom', { id: it.id });
    const next = pick(this.runners().filter((o) => o !== it && o.boomedAt !== t)); // nor someone whose bomb just went off too
    if (!next) return;
    next.fuse = rand(...BOMB_FUSE);
    next.noTag = { id: it.id, until: t + NO_TAGBACK }; // the launched player is still in reach for a tick or two
  }

  startChaos(t) {
    const id = pick(CHAOS_IDS.filter((c) => c !== this.lastChaos && (c !== 'rain' || this.settings.items.length)));
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
    for (const pl of this.players.values()) this.give(pl, randomItem(this.settings.items));
    this.boxes.fill(0);
  }

  resetBoxes() {
    this.boxes = this.map.items.map(() => 0); // per map.items spot: time it becomes available
  }

  // ? box i can be picked up (no enabled items: no boxes at all)
  boxReady(i, t) {
    return this.settings.items.length > 0 && this.boxes[i] <= t;
  }

  tickBoxes(t) {
    const spots = this.map.items;
    for (const pl of this.players.values()) {
      if (pl.item) continue;
      const i = spots.findIndex((s, j) =>
        this.boxReady(j, t) && hdist(pl.p, s) < PICKUP_DIST && Math.abs(pl.p[1] - s[1]) < PLAYER.height);
      if (i < 0) continue;
      this.boxes[i] = t + ITEM_RESPAWN;
      this.give(pl, randomItem(this.settings.items));
    }
  }

  tickPeels(t) {
    const players = [...this.players.values()];
    this.peels = this.peels.filter((peel) => {
      if (t >= peel.until) return false;
      const victim = players.find((pl) =>
        pl.id !== peel.owner && hdist(pl.p, peel.p) < PEEL_DIST && Math.abs(pl.p[1] - peel.p[1]) < PEEL_HEIGHT);
      if (!victim) return true;
      this.slip(victim, t, peel.owner);
      return false;
    });
  }

  // Rockets fly straight, pearls arc. Each tick traces the whole step so they can't skip through thin boxes or players.
  tickProjectiles(t, dt) {
    this.projectiles = this.projectiles.filter((s) => {
      s.v[1] -= (ITEMS[s.item].gravity || 0) * dt;
      const speed = Math.hypot(...s.v) || 1e-6; // a pearl thrown straight up stalls at the top
      const dir = s.v.map((n) => n / speed);
      const step = speed * dt;
      const { d } = this.trace(s.p, dir, step, s.owner);
      const move = d < step ? Math.max(0, d - 0.1) : step; // stop just short of what it hit
      s.p = s.p.map((n, i) => n + dir[i] * move);
      if (d >= step && t < s.until && s.p[1] > this.map.killY) return true;
      if (s.item === 'rocket') this.blast(s);
      else this.warp(s);
      return false;
    });
  }

  // Radial knockback around the explosion, shooter included (rocket jumps). `up` is the least lift.
  blast(s) {
    const { radius, force, up } = ITEMS.rocket;
    const t = now();
    for (const pl of this.players.values()) {
      const c = [pl.p[0], pl.p[1] + (PLAYER.height * this.scale(pl, t)) / 2, pl.p[2]];
      const d = dist(c, s.p);
      if (d > radius) continue;
      const k = 1 - d / radius / 2; // full push at the center, half at the edge
      const n = d > 0.01 ? c.map((v, i) => (v - s.p[i]) / d) : [0, 1, 0];
      this.knock(pl, [n[0] * force * k, Math.max(n[1] * force, up) * k, n[2] * force * k], s.owner);
    }
    this.ev('blast', { p: s.p.map(round2), id: s.owner });
  }

  // Pearl landed: the thrower warps onto the floor under where it stopped (a body width back from a wall).
  // Over the void, on lava or close enough to touch it there's no safe spot, and the pearl is just lost.
  warp(s) {
    const pl = this.players.get(s.owner);
    if (!pl) return;
    const hs = Math.hypot(s.v[0], s.v[2]);
    const back = hs > 0.1 ? PLAYER.radius / hs : 0;
    const [x, z] = [s.p[0] - s.v[0] * back, s.p[2] - s.v[2] * back];
    const floor = floorBelow(this.solids, x, z, s.p[1] + 0.2);
    if (!floor || floor.kind === 'lava') return;
    const y = floor.max[1];
    const r = PLAYER.radius + 0.05; // the body's edge, a hair more than the client's lava check
    const top = (b) => b.max[1] + Math.max(0, b.dv?.[1] ?? 0); // rising lava: where it'll be in a second
    if (this.solids.some((b) => b.kind === 'lava' && x + r > b.min[0] && x - r < b.max[0] && z + r > b.min[2] &&
      z - r < b.max[2] && y < top(b) + 0.05 && y + PLAYER.height > b.min[1])) return;
    const p = [x, y, z].map(round2);
    this.teleport(pl, p);
    this.ev('warp', { id: pl.id, p });
  }

  // Anyone but the owner inside a stink cloud is dizzy, refreshed while they stay in.
  tickClouds(t) {
    this.clouds = this.clouds.filter((c) => t < c.until);
    for (const c of this.clouds) {
      for (const pl of this.players.values()) {
        if (pl.id === c.owner || dist(pl.p, c.p) > ITEMS.stink.radius || pl.fx.dizzy > t + DIZZY / 2) continue;
        pl.fx.dizzy = t + DIZZY;
        this.hit(pl, c.owner);
        this.fx(pl, 'dizzy', { dur: DIZZY });
      }
    }
  }

  // A giant who isn't IT bonks away anyone it touches. A bonked IT can't tag the giant right after.
  tickGiants(t) {
    const { scale, force, up } = ITEMS.mushroom;
    const reach = TAG_DIST * mods(this.chaos).scale * scale;
    for (const g of this.players.values()) {
      if (g.fuse != null || !this.has(g, 'giant', t)) continue;
      for (const pl of this.others(g)) {
        if (t < pl.bonkUntil || hdist(g.p, pl.p) >= reach || Math.abs(g.p[1] - pl.p[1]) >= TAG_HEIGHT * scale) continue;
        pl.bonkUntil = t + BONK_COOLDOWN;
        if (pl.fuse != null) pl.noTag = { id: g.id, until: t + NO_TAGBACK };
        this.knock(pl, push(g.p, pl.p, force, up), g.id);
        this.ev('bonk', { a: g.id, b: pl.id });
      }
    }
  }

  snapshot(t) {
    return {
      t: 'snap',
      phase: this.phase,
      time: this.phase === 'lobby' ? 0 : round2(Math.max(0, this.phaseEnd - t)),
      mt: round2(this.mt),
      chaos: this.chaos,
      players: [...this.players.values()].map((pl) => ({
        id: pl.id,
        p: pl.p.map(round2),
        ry: round2(pl.ry),
        a: pl.a,
        it: pl.fuse != null,
        fuse: pl.fuse == null ? null : round2(Math.max(0, pl.fuse)),
        fx: FX_FLAGS.filter((k) => this.has(pl, k, t)),
        score: Math.floor(pl.score),
        item: pl.item,
        ammo: pl.ammo,
      })),
      boxes: this.boxes.map((_, i) => this.boxReady(i, t)),
      peels: this.peels.map(({ id, p }) => ({ id, p: p.map(round2) })),
      projectiles: this.projectiles.map(({ id, p, item }) => ({ id, p: p.map(round2), item })),
      walls: this.walls.map(({ id, min, max }) => ({ id, min, max })),
      clouds: this.clouds.map(({ id, p }) => ({ id, p: p.map(round2) })),
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
// Spectators don't take a player slot, so they can watch a full room.
function findRoom(ws, code, spectate) {
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
  if (!spectate && room.players.size >= MAX_PLAYERS) return fail('Room is full');
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
    const spectate = msg.spectate === true;
    room = findRoom(ws, msg.code, spectate);
    if (room) player = spectate ? room.addSpectator(ws, cleanName(msg.name)) : room.add(ws, cleanName(msg.name), cleanColor(msg.color));
  });
  ws.on('close', () => {
    if (player) room.remove(player);
    player = room = null;
  });
  ws.on('error', () => {});
}
