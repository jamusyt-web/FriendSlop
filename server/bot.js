// Server-side bots: a shared/physics.js Mover (same movement as humans) driven by a small AI.
// IT chases the nearest catchable player; everyone else flees IT, loots ? boxes and uses items.
// Each plan samples walk directions with safe ground ahead; ledges, gaps and walls are handled every tick.

import { PLAYER, MOVE } from '../shared/config.js';
import { MAPS } from '../shared/maps.js';
import { ITEMS } from '../shared/items.js';
import { mods } from '../shared/chaos.js';
import { Mover, raycastBoxes } from '../shared/physics.js';

export const BOT_NAMES = [
  'Bonkers', 'Sir Slips', 'Turbo Toast', 'Noodle', 'Wobbles', 'Beep Boop',
  'Captain Chaos', 'Pickles', 'Zoomba', 'Doofus', 'Mr. Wiggles', 'Big Chungo',
];

const STEP = 1 / 120; // same fixed physics step as the client
const SPEED = 0.92; // a bit slower than a human
const THINK = 0.25; // seconds between plans (+ random reaction delay)
const AIM_ERROR = 0.06; // random aim spread per axis
const FLEE_DIST = 10; // run from IT when it's closer than this...
const NOTICE = [0.3, 0.9]; // ...after noticing it (seconds)
const LOOT_DIST = 25; // go for ? boxes this close when IT is far
const DIRS = 12; // walk directions sampled per plan
const RING = Array.from({ length: 8 }, (_, i) => [Math.sin((i * Math.PI) / 4), Math.cos((i * Math.PI) / 4)]);

const round2 = (n) => Math.round(n * 100) / 100;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const hdist = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const xyz = (a) => ({ x: a[0], y: a[1], z: a[2] });

// Highest box under (x, z) with its top at or below `top`, or null. Lava counts from a body width away (touch = burn).
function floorAt(boxes, x, z, top) {
  let best = null;
  for (const b of boxes) {
    const g = b.kind === 'lava' ? PLAYER.radius + 0.1 : 0;
    if (x > b.min[0] - g && x < b.max[0] + g && z > b.min[2] - g && z < b.max[2] + g && b.max[1] <= top && (!best || b.max[1] > best.max[1])) best = b;
  }
  return best;
}

// Something non-lava to stand on at (x, z), coming from height y (a double jump up counts).
function ground(boxes, x, z, y) {
  const b = floorAt(boxes, x, z, y + 2.5);
  return !!b && b.kind !== 'lava';
}

export class Bot {
  constructor() {
    this.mover = new Mover();
    this.acc = 0; // physics time not simulated yet
    this.think = 0; // seconds to next plan
    this.wish = [0, 0]; // unit walk direction (x, z)
    this.stuck = 0; // seconds grounded, wanting to move, not moving
    this.escape = 0; // walking a random direction until this time
    this.seen = new Map(); // player id -> { p, t } at the last plan (to lead moving targets)
    this.spot = null; // roam waypoint
    this.spotUntil = 0;
    this.looting = null; // { i, until }: ? box we're heading for
    this.skip = {}; // box index -> time: gave up on it until then
    this.ledge = null; // { d, until }: direction we refused to walk off a ledge
    this.chasing = null; // id of the player we're chasing as IT
    this.alarm = null; // time we start running from a close IT
  }

  // Server fx applied to our own physics, exactly like the client's applyFx.
  fx(k, m) {
    const mv = this.mover;
    if (k === 'knock') {
      if (m.v[1] > 0) mv.vel.y = Math.max(mv.vel.y, 0);
      mv.vel.x += m.v[0];
      mv.vel.y += m.v[1];
      mv.vel.z += m.v[2];
      mv.grounded = false;
      mv.diving = false;
    } else if (k === 'freeze') mv.frozen = Math.max(mv.frozen, m.dur);
    else if (k === 'slip') mv.slip = m.dur;
    else if (k === 'boost') {
      mv.boost = m.dur;
      mv.boostSpeed = m.speed;
    } else if (k === 'tp') mv.teleport(m.p);
  }

  update(room, pl, t, dt) {
    const map = MAPS[room.map];
    const mv = this.mover;
    mv.boxes = map.boxes;
    const md = mods(room.chaos);
    md.speed *= SPEED;
    this.g = MOVE.gravity * md.gravity;
    this.maxSpeed = MOVE.speed * md.speed;
    this.friction = MOVE.friction * md.friction;
    this.airAccel = MOVE.airAccel * md.accel;
    const locked = room.phase === 'countdown' || room.phase === 'results';
    if (!locked) {
      this.think -= dt;
      if (this.think <= 0) {
        this.think = THINK + Math.random() * 0.1;
        this.plan(room, pl, t, map);
      }
      this.pilot(map.boxes, t, dt);
    }
    const flip = (md.reverse ? -1 : 1) * (md.friction < 0.5 ? 0.5 : 1); // bots see through BACKWARDS DAY, tiptoe on ice
    const inp = { x: this.wish[0] * flip, z: this.wish[1] * flip, locked };
    const events = [];
    this.acc = Math.min(this.acc + dt, 0.25);
    while (this.acc >= STEP) {
      this.acc -= STEP;
      mv.step(STEP, inp, md, events);
      if (mv.pos.y < map.killY || events.some((e) => e.k === 'lava')) mv.teleport(pick(map.spawns)); // respawn, like a client
      events.length = 0;
    }
    pl.p = [round2(mv.pos.x), round2(mv.pos.y), round2(mv.pos.z)];
    pl.ry = round2(mv.facing % (Math.PI * 2));
    pl.a = mv.anim();
  }

  plan(room, pl, t, map) {
    const mv = this.mover;
    const me = pl.p;
    const it = room.phase === 'play' ? room.players.get(room.it) : null;
    const amIt = it === pl;
    const others = room.others(pl).filter((o) => !room.has(o, 'ghost', t) || hdist(o.p, me) < 4); // ghosts: only up close
    // easiest catch: close, not far above, not running away from us; stick with the current target a bit
    const cost = (o) => {
      const away = -this.approach(o, me, t);
      return hdist(o.p, me) + 2 * Math.max(0, o.p[1] - me[1]) + Math.max(0, away) - (o.id === this.chasing ? 6 : 0);
    };
    const nearest = (list) => list.reduce((a, o) => (!a || cost(o) < cost(a) ? o : a), null);
    const seesIt = !!it && others.includes(it);
    let enemy = seesIt ? it : null;
    let goal = null;
    let sign = 1; // toward the goal, -1 = away from it
    // runners notice a close IT coming at them after a short (human) delay
    const near = seesIt && !amIt && hdist(it.p, me) < FLEE_DIST && (hdist(it.p, me) < 5 || this.approach(it, me, t) > 2);
    if (!near) this.alarm = null;
    else this.alarm ??= t + NOTICE[0] + Math.random() * (NOTICE[1] - NOTICE[0]);
    if (amIt) {
      const back = pl.noTag && t < pl.noTag.until ? pl.noTag.id : null;
      const catchable = others.filter((o) => o.id !== back);
      enemy = nearest(catchable.filter((o) => !room.has(o, 'shield', t))) || nearest(catchable);
      this.chasing = enemy?.id;
      const box = enemy && hdist(enemy.p, me) > 6 && this.loot(room, pl, t, map);
      if (box && hdist(box, me) < 8) goal = box; // a freeze ray would help...
      else if (enemy) goal = this.lead(enemy, t, hdist(enemy.p, me) / 12);
    } else if (near && t >= this.alarm) {
      goal = it.p;
      sign = -1;
    } else {
      if (!it) enemy = nearest(others); // lobby: anyone is fair game for items
      goal = this.loot(room, pl, t, map) || this.roam(map, me, t, seesIt ? it.p : null);
    }

    if (this.stuck > 1.5) {
      // wedged somewhere: walk a random way for a moment
      const a = Math.random() * Math.PI * 2;
      this.wish = [Math.sin(a), Math.cos(a)];
      this.stuck = 0;
      this.escape = t + 0.8;
    }
    const footing = mv.grounded || ground(map.boxes, mv.pos.x, mv.pos.z, mv.pos.y); // mid-jump over a gap: pilot steers
    if (t >= this.escape && footing) this.wish = goal ? this.choose(map.boxes, mv.pos, sign > 0 ? this.climb(map, me, goal) : goal, sign, t) : [0, 0];

    // dive: IT lunges at a target right in front of it, runners lunge away from IT (never off a ledge)
    if (enemy && mv.grounded && (amIt || sign < 0) && hdist(enemy.p, me) < (amIt ? 4.5 : 2.5) && Math.abs(enemy.p[1] - me[1]) < 1.5) {
      const [dx, dz] = [enemy.p[0] - me[0], enemy.p[2] - me[2]];
      const d = Math.hypot(dx, dz) || 1;
      const inFront = (Math.sin(mv.facing) * dx + Math.cos(mv.facing) * dz) / d > 0.5;
      const [wx, wz] = amIt ? (inFront ? [dx / d, dz / d] : [0, 0]) : this.wish;
      const v = { x: wx * MOVE.diveSpeed, y: MOVE.diveUp, z: wz * MOVE.diveSpeed };
      if ((wx || wz) && (amIt || Math.random() < 0.3) && this.lands(map.boxes, mv.pos, v, true, [wx, wz])) {
        this.wish = [wx, wz];
        mv.wantDive = true;
      }
    }

    this.useItem(room, pl, t, enemy, it);
    this.seen = new Map([...room.players.values()].map((o) => [o.id, { p: o.p, t }]));
  }

  // Per tick: jump gaps, walls and when stuck; stop at deadly ledges; save bad falls.
  pilot(boxes, t, dt) {
    const mv = this.mover;
    const p = mv.pos;
    const v = mv.vel;
    const hs = Math.hypot(v.x, v.z);
    const ahead = (k, [dx, dz] = this.wish) => ground(boxes, p.x + dx * k, p.z + dz * k, p.y);
    if (!mv.grounded && !this.lands(boxes, p, v, false, this.wish)) {
      // this flight ends in void / lava: steer (our way first) so it doesn't, without or else with the double jump
      const dirs = [this.wish, ...RING];
      let d = dirs.find((r) => this.lands(boxes, p, v, false, r));
      if (!d && mv.jumpsLeft > 0) {
        d = dirs.find((r) => this.lands(boxes, p, v, true, r));
        if (v.y < 0) mv.jumpBuffer = 0.1; // now (also as a last hope)
      }
      if (d) this.wish = d;
      return;
    }
    const [wx, wz] = this.wish;
    this.stuck = mv.grounded && mv.frozen <= 0 && mv.slip <= 0 && (wx || wz) && hs < 1.5 ? this.stuck + dt : 0; // frozen isn't stuck
    if (!wx && !wz) return;
    const wall = raycastBoxes(boxes, { x: p.x, y: p.y + 0.7, z: p.z }, { x: wx, y: 0, z: wz }, 1) < 1;
    if (!mv.grounded) {
      if (v.y < 0 && (wall || Math.random() < 0.02)) mv.jumpBuffer = 0.1; // double jump up walls (and for style)
    } else if (!ahead(0.6 + hs / this.friction)) {
      // ledge within stopping distance: walk off if we land safe, else jump the gap if a (double) jump makes it,
      // else brake and re-plan
      const k = 0.6 + hs / this.friction;
      const run = { x: wx * this.maxSpeed, y: 0, z: wz * this.maxSpeed };
      if (this.lands(boxes, { x: p.x + wx * k, y: p.y, z: p.z + wz * k }, run, false, this.wish)) return;
      if (this.lands(boxes, p, { ...run, y: MOVE.jump }, true, this.wish)) mv.jumpBuffer = 0.1;
      else {
        this.ledge = { d: this.wish, until: t + 2 }; // don't pick this way again right away
        this.wish = hs > 1 ? [-v.x / hs, -v.z / hs] : [0, 0];
        this.think = 0;
      }
    } else if (wall || this.stuck > 0.3) mv.jumpBuffer = 0.1;
  }

  // Look-ahead of a flight from p with velocity v, air-steering along `steer`, with our double jump at the apex
  // if `jump`: do we come down on something safe? Still flying after 1.6 s counts as yes (decide later).
  lands(boxes, p, v, jump, steer) {
    const dt = 0.05;
    const cap = Math.max(this.maxSpeed, Math.hypot(v.x, v.z));
    let { x, y, z } = p;
    let [vx, vy, vz] = [v.x, v.y, v.z];
    for (let t = 0; t < 1.6; t += dt) {
      if (jump && vy < 0) [vy, jump] = [MOVE.jump, false];
      vx += steer[0] * this.airAccel * dt;
      vz += steer[1] * this.airAccel * dt;
      const s = Math.hypot(vx, vz);
      if (s > cap) [vx, vz] = [(vx * cap) / s, (vz * cap) / s];
      const ny = y + vy * dt;
      vy -= this.g * dt;
      x += vx * dt;
      z += vz * dt;
      const b = floorAt(boxes, x, z, y + 0.2); // low lips (slime, pads) get stepped onto
      if (b && b.max[1] >= ny) return b.kind !== 'lava';
      if (ny < p.y - 12) return false;
      y = ny;
    }
    return true;
  }

  // Best of DIRS directions (+ straight at the goal) toward (sign 1) or away from (sign -1) `goal`,
  // judged by where we can get that way (hopping short gaps), walls and turning. [0, 0] if nowhere.
  choose(boxes, p, goal, sign, t) {
    const [gx, gz] = [goal[0] - p.x, goal[2] - p.z];
    const gd = Math.hypot(gx, gz) || 1;
    const max = sign > 0 ? Math.min(Math.max(gd, 1), 6) : 6; // no need to look past the goal
    const off = Math.random() * Math.PI;
    let best = [0, 0];
    let bestScore = -Infinity;
    for (let i = -1; i < DIRS; i++) {
      const a = off + (i * Math.PI * 2) / DIRS;
      const [dx, dz] = i < 0 ? [gx / gd, gz / gd] : [Math.sin(a), Math.cos(a)];
      let far = 0; // last safe probe that way; up to 2 unsafe ones in a row are a gap we can hop
      for (let k = 1; k <= max && k - far <= 3; k++) if (ground(boxes, p.x + dx * k, p.z + dz * k, p.y)) far = k;
      if (!far) continue;
      let s = -sign * Math.hypot(p.x + dx * far - goal[0], p.z + dz * far - goal[2]) + 1.5 * (dx * this.wish[0] + dz * this.wish[1]);
      if (this.ledge && t < this.ledge.until && dx * this.ledge.d[0] + dz * this.ledge.d[1] > 0.8) s -= 30;
      if (raycastBoxes(boxes, { x: p.x, y: p.y + 1.4, z: p.z }, { x: dx, y: 0, z: dz }, far) < far) s -= 6; // wall that way
      if (s > bestScore) [best, bestScore] = [[dx, dz], s];
    }
    return best;
  }

  // Goal way above us: go bounce on a pad around our height first.
  climb(map, me, goal) {
    if (goal[1] - me[1] < 2.5) return goal;
    const on = floorAt(map.boxes, goal[0], goal[2], goal[1] + 0.1); // what the target stands on
    const reach = (c) => (on ? Math.hypot(Math.max(on.min[0] - c[0], 0, c[0] - on.max[0]), Math.max(on.min[2] - c[2], 0, c[2] - on.max[2])) : hdist(c, goal));
    let best = null;
    for (const b of map.boxes) {
      if (b.kind !== 'bounce' || Math.abs(b.max[1] - me[1]) > 1) continue;
      const c = [(b.min[0] + b.max[0]) / 2, b.max[1], (b.min[2] + b.max[2]) / 2];
      if (hdist(c, me) < 25 && reach(c) < 10 && (!best || hdist(c, me) < hdist(best, me))) best = c; // one bounce carries ~12 m
    }
    return best || goal;
  }

  // Nearest available ? box, skipping ones we recently failed to reach.
  loot(room, pl, t, map) {
    if (pl.item) return null;
    let best = -1;
    map.items.forEach((s, i) => {
      if (room.boxes[i] > t || this.skip[i] > t || hdist(s, pl.p) > LOOT_DIST) return;
      if (best < 0 || hdist(s, pl.p) < hdist(map.items[best], pl.p)) best = i;
    });
    if (best < 0) return null;
    if (this.looting?.i !== best) this.looting = { i: best, until: t + 6 };
    if (t < this.looting.until) return map.items[best];
    this.skip[best] = t + 20;
    this.looting = null;
    return null;
  }

  // Wander between spawns and box spots, preferring ones far from IT.
  roam(map, me, t, away) {
    if (!this.spot || hdist(this.spot, me) < 2 || t > this.spotUntil) {
      const spots = [...map.spawns, ...map.items];
      const options = [pick(spots), pick(spots), pick(spots)];
      this.spot = away ? options.reduce((a, b) => (hdist(b, away) > hdist(a, away) ? b : a)) : options[0];
      this.spotUntil = t + 8;
    }
    return this.spot;
  }

  // Where `o` will be in `ahead` seconds, from how it moved since our last plan.
  lead(o, t, ahead) {
    const s = this.seen.get(o.id);
    if (!s || t - s.t > 1 || t <= s.t) return o.p;
    const k = Math.min(ahead, 0.6) / (t - s.t);
    return o.p.map((n, i) => n + Math.max(-4, Math.min(4, (n - s.p[i]) * k)));
  }

  // Speed at which `o` is coming toward point `p`.
  approach(o, p, t) {
    const f = this.lead(o, t, 1);
    const d = hdist(o.p, p) || 1;
    return ((f[0] - o.p[0]) * (p[0] - o.p[0]) + (f[2] - o.p[2]) * (p[2] - o.p[2])) / d;
  }

  // Unit aim from our eye at `o` (led, with spread), or null without line of sight.
  aim(room, pl, o, item, t) {
    const s = mods(room.chaos).scale;
    const eye = [pl.p[0], pl.p[1] + PLAYER.eye * s, pl.p[2]];
    const rocket = item === 'rocket';
    const at = this.lead(o, t, rocket ? dist(o.p, eye) / ITEMS.rocket.speed : 0);
    const v = [at[0] - eye[0], at[1] + (rocket ? 0.3 : PLAYER.height * s * 0.5) - eye[1], at[2] - eye[2]]; // rockets: at the feet
    const d = Math.hypot(...v);
    if (d < 0.5 || raycastBoxes(MAPS[room.map].boxes, xyz(eye), xyz(v.map((n) => n / d)), d) < d - 0.3) return null;
    const e = v.map((n) => n / d + (Math.random() - 0.5) * 2 * AIM_ERROR);
    const len = Math.hypot(...e);
    return e.map((n) => n / len);
  }

  // Use the held item when it makes sense: guns at the enemy, the rest when IT is close (or to help catch).
  useItem(room, pl, t, enemy, it) {
    const item = pl.item;
    if (!item) return;
    const me = pl.p;
    const d = enemy ? dist(enemy.p, me) : Infinity;
    const amIt = it === pl;
    if (ITEMS[item].gun) {
      const range = item === 'rocket' ? 25 : ITEMS[item].range;
      // IT never pushes its own target away: it freezes it, and blasts the nearest other (visible) player instead
      const near = (a, o) => (!a || dist(o.p, me) < dist(a.p, me) ? o : a);
      const foe = amIt && item !== 'freezeray' ? room.others(pl).filter((o) => o !== enemy && !room.has(o, 'ghost', t)).reduce(near, null) : enemy;
      const fd = foe ? dist(foe.p, me) : Infinity;
      const dir = fd < range && (item !== 'rocket' || fd > 4) && this.aim(room, pl, foe, item, t);
      if (dir) room.useItem(pl, dir);
      return;
    }
    const threat = it ? !amIt && hdist(it.p, me) < 6 : Math.random() < 0.03;
    const rules = {
      glove: !!enemy && (amIt ? d > ITEMS.glove.range + 2 : d < ITEMS.glove.range - 0.5), // IT: only away from its target
      freeze: d < ITEMS.freeze.radius - 1,
      banana: threat || (!!it && !amIt && hdist(it.p, me) < 10),
      swap: Math.random() < 0.05,
      boots: threat || (amIt && d > 8),
      spring: threat || (amIt && d < 6 && enemy.p[1] - me[1] > 2.5),
      ghost: threat || (amIt && d < 10),
    };
    if (!(item in rules ? rules[item] : threat)) return; // shield: when IT is close
    if (item === 'glove') pl.ry = this.mover.facing = Math.atan2(enemy.p[0] - me[0], enemy.p[2] - me[2]); // turn and punch
    room.useItem(pl, null);
  }
}
