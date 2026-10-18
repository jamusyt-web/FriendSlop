// Server-side bots: a shared/physics.js Mover (same movement as humans) driven by a small AI.
// IT chases the nearest catchable runner; runners flee the closest IT, loot ? boxes and use items.
// Each plan samples walk directions with safe ground ahead; ledges, gaps and walls are handled every tick.
// Moving boxes and conveyors carry bots through physics; blinking boxes that are off or about to go are no ground.

import { PLAYER, MOVE } from '../shared/config.js';
import { setMapTime } from '../shared/maps.js';
import { ITEMS } from '../shared/items.js';
import { mods } from '../shared/chaos.js';
import { Mover, raycastBoxes } from '../shared/physics.js';

export const BOT_NAMES = [
  'Bonkers', 'Sir Slips', 'Turbo Toast', 'Noodle', 'Wobbles', 'Beep Boop',
  'Captain Chaos', 'Pickles', 'Zoomba', 'Doofus', 'Mr. Wiggles', 'Big Chungo',
  'Sprocket', 'Jellybean', 'Gizmo', 'Tater Tot', 'Fumbles', 'Rubber Duck',
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
const CONFUSED = 1; // seconds of dizzy before we figure out the reversed controls
const TAUNT = 1.2; // dance after passing the bomb on

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

// The AI's view of a box: a moving lava box fills its whole path (rising lava pools), so it's never trusted to stay low.
function worstCase(b) {
  if (!b.move || b.kind !== 'lava') return b;
  const { base, move: { to } } = b;
  return { kind: 'lava', min: base.min.map((n, i) => Math.min(n, n + to[i])), max: base.max.map((n, i) => Math.max(n, n + to[i])) };
}

// A body at feet (x, y, z) touches lava.
function inLava(boxes, x, y, z) {
  const r = PLAYER.radius + 0.05;
  return boxes.some((b) => b.kind === 'lava' && x > b.min[0] - r && x < b.max[0] + r && z > b.min[2] - r && z < b.max[2] + r && y < b.max[1] && y + PLAYER.height > b.min[1]);
}

// Lowest box bottom that a body rising from feet y0 to y1 at (x, z) bonks its head on, or null.
function ceiling(boxes, x, z, y0, y1) {
  const r = PLAYER.radius;
  const h = PLAYER.height;
  let best = null;
  for (const b of boxes) {
    if (x > b.min[0] - r && x < b.max[0] + r && z > b.min[2] - r && z < b.max[2] + r && b.min[1] >= y0 + h - 0.05 && b.min[1] < y1 + h && (best == null || b.min[1] < best)) best = b.min[1];
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
    this.boxes = []; // boxes the AI trusts this tick: map (minus blinking-out ones, moving lava at its worst) + walls
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
    this.danger = []; // positions of the ITs we can see (runners steer clear)
    this.confused = null; // dizzy: time we figure out the reversed controls
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
    } else if (k === 'float') mv.float = m.dur;
    else if (k === 'dizzy') mv.dizzy = m.dur;
    else if (k === 'tp') mv.teleport(m.p);
  }

  // We just tagged someone: a little dance while they're stunned.
  taunt() {
    this.mover.dancing = TAUNT;
  }

  update(room, pl, t, dt) {
    const map = room.map;
    const mv = this.mover;
    mv.boxes = room.walls.length ? map.boxes.concat(room.walls) : map.boxes;
    this.boxes = mv.boxes.filter((b) => !b.off && !b.warn).map(worstCase);
    const md = mods(room.chaos);
    md.speed *= SPEED;
    this.g = MOVE.gravity * md.gravity * (mv.float > 0 ? ITEMS.balloon.gravity : 1);
    this.maxSpeed = MOVE.speed * md.speed;
    this.friction = MOVE.friction * md.friction;
    this.airAccel = MOVE.airAccel * md.accel;
    const locked = room.phase === 'countdown' || room.phase === 'results';
    if (!locked) {
      this.think -= dt;
      if (this.think <= 0) {
        this.think = THINK + Math.random() * 0.1;
        this.plan(room, pl, t);
      }
      this.pilot(this.boxes, t, dt);
    }
    // bots see through BACKWARDS DAY right away; dizzy (reversed too) takes them a moment to figure out
    if (mv.dizzy <= 0) this.confused = null;
    else this.confused ??= t + CONFUSED;
    const reversed = !!md.reverse !== (this.confused != null && t >= this.confused);
    const flip = (reversed ? -1 : 1) * (md.friction < 0.5 ? 0.5 : 1); // tiptoe on ice
    const inp = { x: this.wish[0] * flip, z: this.wish[1] * flip, locked };
    const events = [];
    this.acc = Math.min(this.acc + dt, 0.25);
    while (this.acc >= STEP) {
      this.acc -= STEP;
      setMapTime(map, room.mt - this.acc); // dynamic boxes as of the end of this step
      mv.step(STEP, inp, md, events);
      if (mv.pos.y < map.killY || events.some((e) => e.k === 'lava')) {
        mv.teleport(pick(map.spawns)); // respawn, like a client
        room.fell(pl, t);
      }
      events.length = 0;
    }
    setMapTime(map, room.mt);
    pl.p = [round2(mv.pos.x), round2(mv.pos.y), round2(mv.pos.z)];
    pl.ry = round2(mv.facing % (Math.PI * 2));
    pl.a = mv.anim();
  }

  plan(room, pl, t) {
    const mv = this.mover;
    const boxes = this.boxes;
    const me = pl.p;
    const play = room.phase === 'play';
    const amIt = play && pl.fuse != null;
    const others = room.others(pl).filter((o) => !room.has(o, 'ghost', t) || hdist(o.p, me) < 4); // ghosts: only up close
    const its = play ? others.filter((o) => o.fuse != null) : [];
    this.danger = amIt ? [] : its.map((o) => o.p);
    // easiest catch: close, not far above, not running away from us; stick with the current target a bit
    const cost = (o) => {
      const away = -this.approach(o, me, t);
      return hdist(o.p, me) + 2 * Math.max(0, o.p[1] - me[1]) + Math.max(0, away) - (o.id === this.chasing ? 6 : 0);
    };
    const nearest = (list) => list.reduce((a, o) => (!a || cost(o) < cost(a) ? o : a), null);
    const it = amIt ? null : its.reduce((a, o) => (!a || hdist(o.p, me) < hdist(a.p, me) ? o : a), null); // the closest bomb
    let enemy = it;
    let goal = null;
    let sign = 1; // toward the goal, -1 = away from it
    // runners notice a close IT coming at them after a short (human) delay
    const near = !!it && hdist(it.p, me) < FLEE_DIST && (hdist(it.p, me) < 5 || this.approach(it, me, t) > 2);
    if (!near) this.alarm = null;
    else this.alarm ??= t + NOTICE[0] + Math.random() * (NOTICE[1] - NOTICE[0]);
    if (amIt) {
      const back = pl.noTag && t < pl.noTag.until ? pl.noTag.id : null;
      const catchable = others.filter((o) => o.fuse == null && o.id !== back);
      enemy = nearest(catchable.filter((o) => !room.has(o, 'shield', t) && !room.has(o, 'giant', t))) || nearest(catchable);
      this.chasing = enemy?.id;
      const box = enemy && hdist(enemy.p, me) > 6 && this.loot(room, pl, t);
      if (box && hdist(box, me) < 8) goal = box; // a freeze ray would help...
      else if (enemy) goal = this.lead(enemy, t, hdist(enemy.p, me) / 12);
    } else if (near && t >= this.alarm) {
      goal = it.p;
      sign = -1;
    } else {
      if (!play) enemy = nearest(others); // lobby: anyone is fair game for items
      goal = this.loot(room, pl, t) || this.roam(room.map, me, t, it ? it.p : null);
    }

    // dance: after a tag (while that IT can't tag us back), and now and then in the lobby; never on a vanishing floor
    if (!play && mv.grounded && Math.random() < 0.01) mv.dancing = 2;
    if ((near && !(it.noTag?.id === pl.id && t < it.noTag.until)) || this.doomed()) mv.dancing = 0;

    if (this.stuck > 1.5) {
      // wedged somewhere: walk a random way for a moment
      const a = Math.random() * Math.PI * 2;
      this.wish = [Math.sin(a), Math.cos(a)];
      this.stuck = 0;
      this.escape = t + 0.8;
    }
    const footing = mv.grounded || ground(boxes, mv.pos.x, mv.pos.z, mv.pos.y); // mid-jump over a gap: pilot steers
    if (mv.dancing > 0) this.wish = [0, 0];
    else if (t >= this.escape && footing) this.wish = goal ? this.choose(boxes, mv.pos, sign > 0 ? this.climb(boxes, me, goal) : goal, sign, t) : [0, 0];

    // dive: IT lunges at a target right in front of it, runners lunge away from IT (never off a ledge)
    if (enemy && mv.grounded && mv.dancing <= 0 && (amIt || sign < 0) && hdist(enemy.p, me) < (amIt ? 4.5 : 2.5) && Math.abs(enemy.p[1] - me[1]) < 1.5) {
      const [dx, dz] = [enemy.p[0] - me[0], enemy.p[2] - me[2]];
      const d = Math.hypot(dx, dz) || 1;
      const inFront = (Math.sin(mv.facing) * dx + Math.cos(mv.facing) * dz) / d > 0.5;
      const [wx, wz] = amIt ? (inFront ? [dx / d, dz / d] : [0, 0]) : this.wish;
      const v = { x: wx * MOVE.diveSpeed, y: MOVE.diveUp, z: wz * MOVE.diveSpeed };
      if ((wx || wz) && (amIt || Math.random() < 0.3) && this.lands(boxes, mv.pos, v, true, [wx, wz])) {
        this.wish = [wx, wz];
        mv.wantDive = true;
      }
    }

    this.useItem(room, pl, t, { enemy, it, amIt, its, fleeing: sign < 0 });
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
    if (mv.grounded && (!ground(boxes, p.x, p.z, p.y) || inLava(boxes, p.x + v.x * 0.1, p.y, p.z + v.z * 0.1))) {
      // lava within reach or drifting into it (a rising pool's edge), or a floor about to vanish:
      // step to the safe side, our way if we can
      const safe = RING.filter(([dx, dz]) => ground(boxes, p.x + dx * 0.8, p.z + dz * 0.8, p.y) && !inLava(boxes, p.x + dx * 0.8, p.y, p.z + dz * 0.8));
      if (safe.length) {
        this.wish = safe.reduce((a, d) => (d[0] * wx + d[1] * wz > a[0] * wx + a[1] * wz ? d : a));
        return;
      }
    }
    this.stuck = mv.grounded && mv.frozen <= 0 && mv.slip <= 0 && (wx || wz) && hs < 1.5 ? this.stuck + dt : 0; // frozen isn't stuck
    if (!wx && !wz) return;
    const wall = raycastBoxes(boxes, { x: p.x, y: p.y + 0.7, z: p.z }, { x: wx, y: 0, z: wz }, 1) < 1;
    if (!mv.grounded) {
      if (v.y < 0 && mv.jumpsLeft > 0 && (wall || Math.random() < 0.02)) mv.jumpBuffer = 0.1; // double jump up walls (and for style)
    } else if (!ahead(0.6 + hs / this.friction)) {
      // ledge within stopping distance: walk off if we land safe, else jump the gap if a (double) jump makes it,
      // else brake and re-plan (unless the floor is about to vanish anyway: then jump for it)
      const k = 0.6 + hs / this.friction;
      const run = { x: wx * this.maxSpeed, y: 0, z: wz * this.maxSpeed };
      if (this.lands(boxes, { x: p.x + wx * k, y: p.y, z: p.z + wz * k }, run, false, this.wish)) return;
      if (this.lands(boxes, p, { ...run, y: MOVE.jump }, true, this.wish) || (this.doomed() && !ahead(0.3))) mv.jumpBuffer = 0.1;
      else if (!this.doomed()) {
        this.ledge = { d: this.wish, until: t + 2 }; // don't pick this way again right away
        this.wish = hs > 1 ? [-v.x / hs, -v.z / hs] : [0, 0];
        this.think = 0;
      }
    } else if (wall || this.stuck > 0.3) mv.jumpBuffer = 0.1;
  }

  // Standing on a blinking box that's about to vanish.
  doomed() {
    const g = this.mover.grounded && this.mover.ground;
    return !!g && !this.boxes.includes(g);
  }

  // Look-ahead of a flight from p with velocity v, air-steering along `steer`, with our double jump at the apex
  // if `jump`: where do we come down? [x, y, z] on something safe, null in void / lava. Still flying after
  // `maxT` s counts as safe (decide later): returns where we are then.
  flight(boxes, p, v, jump, steer, maxT = 1.6) {
    const dt = 0.05;
    const cap = Math.max(this.maxSpeed, Math.hypot(v.x, v.z));
    let { x, y, z } = p;
    let [vx, vy, vz] = [v.x, v.y, v.z];
    for (let t = 0; t < maxT; t += dt) {
      if (jump && vy < 0) [vy, jump] = [MOVE.jump, false];
      vx += steer[0] * this.airAccel * dt;
      vz += steer[1] * this.airAccel * dt;
      const s = Math.hypot(vx, vz);
      if (s > cap) [vx, vz] = [(vx * cap) / s, (vz * cap) / s];
      let ny = y + vy * dt;
      vy -= this.g * dt;
      x += vx * dt;
      z += vz * dt;
      const top = ny > y ? ceiling(boxes, x, z, y, ny) : null; // bonk our head (jumping up under a platform)
      if (top != null) [ny, vy] = [top - PLAYER.height, 0];
      const b = floorAt(boxes, x, z, y + 0.2); // low lips (slime, pads) get stepped onto
      if (b && b.max[1] >= ny) return b.kind !== 'lava' ? [x, b.max[1], z] : null;
      if (ny < p.y - 12 || inLava(boxes, x, ny, z)) return null; // flying into the side of raised lava burns too
      y = ny;
    }
    return [x, y, z];
  }

  lands(boxes, p, v, jump, steer) {
    return !!this.flight(boxes, p, v, jump, steer);
  }

  // Best of DIRS directions (+ straight at the goal) toward (sign 1) or away from (sign -1) `goal`,
  // judged by where we can get that way (hopping short gaps), walls, visible ITs and turning. [0, 0] if nowhere.
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
      const [ex, ez] = [p.x + dx * far, p.z + dz * far];
      let s = -sign * Math.hypot(ex - goal[0], ez - goal[2]) + 1.5 * (dx * this.wish[0] + dz * this.wish[1]);
      if (this.ledge && t < this.ledge.until && dx * this.ledge.d[0] + dz * this.ledge.d[1] > 0.8) s -= 30;
      if (raycastBoxes(boxes, { x: p.x, y: p.y + 1.4, z: p.z }, { x: dx, y: 0, z: dz }, far) < far) s -= 6; // wall that way
      for (const q of this.danger) s -= 3 * Math.max(0, 8 - Math.hypot(ex - q[0], ez - q[2])); // don't run into another bomb
      if (s > bestScore) [best, bestScore] = [[dx, dz], s];
    }
    return best;
  }

  // Goal way above us: go bounce on a pad around our height first.
  climb(boxes, me, goal) {
    if (goal[1] - me[1] < 2.5) return goal;
    const on = floorAt(boxes, goal[0], goal[2], goal[1] + 0.1); // what the target stands on
    const reach = (c) => (on ? Math.hypot(Math.max(on.min[0] - c[0], 0, c[0] - on.max[0]), Math.max(on.min[2] - c[2], 0, c[2] - on.max[2])) : hdist(c, goal));
    let best = null;
    for (const b of boxes) {
      if (b.kind !== 'bounce' || Math.abs(b.max[1] - me[1]) > 1) continue;
      const c = [(b.min[0] + b.max[0]) / 2, b.max[1], (b.min[2] + b.max[2]) / 2];
      if (hdist(c, me) < 25 && reach(c) < 10 && (!best || hdist(c, me) < hdist(best, me))) best = c; // one bounce carries ~12 m
    }
    return best || goal;
  }

  // Nearest available ? box, skipping ones we recently failed to reach.
  loot(room, pl, t) {
    if (pl.item) return null;
    const spots = room.map.items;
    let best = -1;
    spots.forEach((s, i) => {
      if (!room.boxReady(i, t) || this.skip[i] > t || hdist(s, pl.p) > LOOT_DIST) return;
      if (best < 0 || hdist(s, pl.p) < hdist(spots[best], pl.p)) best = i;
    });
    if (best < 0) return null;
    if (this.looting?.i !== best) this.looting = { i: best, until: t + 6 };
    if (t < this.looting.until) return spots[best];
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

  eye(room, pl) {
    return [pl.p[0], pl.p[1] + PLAYER.eye * mods(room.chaos).scale, pl.p[2]];
  }

  // Unit aim from our eye at `o` (led, with spread), or null without line of sight.
  aim(room, pl, o, item, t) {
    const s = mods(room.chaos).scale;
    const eye = this.eye(room, pl);
    const rocket = item === 'rocket';
    const at = this.lead(o, t, rocket ? dist(o.p, eye) / ITEMS.rocket.speed : 0);
    const v = [at[0] - eye[0], at[1] + (rocket ? 0.3 : PLAYER.height * s * 0.5) - eye[1], at[2] - eye[2]]; // rockets: at the feet
    const d = Math.hypot(...v);
    if (d < 0.5 || raycastBoxes(room.solids, xyz(eye), xyz(v.map((n) => n / d)), d) < d - 0.3) return null;
    const e = v.map((n) => n / d + (Math.random() - 0.5) * 2 * AIM_ERROR);
    const len = Math.hypot(...e);
    return e.map((n) => n / len);
  }

  // Use the held item when it makes sense: guns at the enemy, getaway tools when an IT is close,
  // catching tools as IT. In the lobby anything goes now and then.
  useItem(room, pl, t, { enemy, it, amIt, its, fleeing }) {
    const item = pl.item;
    if (!item) return;
    const me = pl.p;
    const d = enemy ? dist(enemy.p, me) : Infinity;
    const itD = it ? hdist(it.p, me) : Infinity; // closest IT (we're a runner)
    const play = room.phase === 'play';
    if (item === 'grapple' || item === 'pearl') {
      const dir = this.dash(room, pl, item, enemy, it, amIt, play);
      if (dir) room.useItem(pl, dir);
      return;
    }
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
    const threat = itD < 6;
    const f = this.mover.facing;
    const behind = !!it && (Math.sin(f) * (it.p[0] - me[0]) + Math.cos(f) * (it.p[2] - me[2])) / (itD || 1) < -0.5;
    const { radius: pull } = ITEMS.magnet;
    const rules = {
      glove: !!enemy && (amIt ? d > ITEMS.glove.range + 2 : d < ITEMS.glove.range - 0.5), // IT: only away from its target
      freeze: d < ITEMS.freeze.radius - 1,
      banana: itD < 10,
      swap: play && Math.random() < 0.05,
      boots: threat || (amIt && d > 8),
      spring: threat || (amIt && d < 6 && enemy.p[1] - me[1] > 2.5),
      ghost: threat || (amIt && d < 10),
      shield: threat,
      balloon: threat || (amIt && d < 8 && enemy.p[1] - me[1] > 2.5),
      mushroom: itD < 5 || (amIt && d < 8), // giant runners bonk IT away, giant ITs reach further
      stink: itD < ITEMS.stink.radius - 1 || (amIt && d < ITEMS.stink.radius - 1),
      // IT pulls runners in; a runner far from any IT yanks the crowd around (off ledges, with luck)
      magnet: amIt ? d > 3 && d < pull : play && itD > pull && room.others(pl).filter((o) => dist(o.p, me) < pull * 0.7).length >= 2,
      wall: fleeing && itD < 8 && behind, // drops behind us, between us and IT
      // an IT about to pass its bomb on: make it shorter (never when we're the one in reach)
      fuse: play && !amIt && itD > 6 && its.some((o) => room.runners().some((r) => r !== pl && hdist(r.p, o.p) < 5)),
    };
    if (!rules[item] && (play || Math.random() > 0.03)) return;
    if (item === 'glove' && enemy) pl.ry = this.mover.facing = Math.atan2(enemy.p[0] - me[0], enemy.p[2] - me[2]); // turn and punch
    room.useItem(pl, null);
  }

  // Grapple / pearl: get away from a close IT, catch up as IT, or just zip around in the lobby. Aim or null.
  dash(room, pl, item, enemy, it, amIt, play) {
    const me = pl.p;
    const yaw = (q, sign) => Math.atan2((q[0] - me[0]) * sign, (q[2] - me[2]) * sign);
    if (it && hdist(it.p, me) < 6) {
      const d0 = hdist(it.p, me);
      return this.travel(room, pl, item, yaw(it.p, -1), (s) => hdist(s, it.p) - d0 - 6); // at least 6 m farther
    }
    if (amIt && enemy && hdist(enemy.p, me) > 10) {
      const d0 = hdist(enemy.p, me);
      return this.travel(room, pl, item, yaw(enemy.p, 1), (s) => d0 - hdist(s, enemy.p) - 6); // at least 6 m closer
    }
    if (!play && Math.random() < 0.03) return this.travel(room, pl, item, this.mover.facing, () => 1);
    return null;
  }

  // Best of a fan of aims around `yaw` by where each one puts us (safe ground only): score(spot) > 0 to be worth it.
  travel(room, pl, item, yaw, score) {
    const eye = this.eye(room, pl);
    let best = null;
    let bestScore = 0;
    for (const da of [0, 0.5, -0.5]) {
      for (const pitch of item === 'pearl' ? [0.15, 0.4, 0.7] : [0.3, 0.55, 0.8]) {
        const a = yaw + da;
        const dir = [Math.sin(a) * Math.cos(pitch), Math.sin(pitch), Math.cos(a) * Math.cos(pitch)];
        const spot = item === 'pearl' ? this.pearlSpot(room, eye, dir) : this.grappleSpot(room, eye, dir, [Math.sin(a), Math.cos(a)]);
        const s = spot ? score(spot) : 0;
        if (s > bestScore) [best, bestScore] = [dir, s];
      }
    }
    return best;
  }

  // Where the grapple's pull would land us (it needs something to hook within range), or null.
  grappleSpot(room, eye, dir, steer) {
    const { range, force, up } = ITEMS.grapple;
    const d = raycastBoxes(room.solids, xyz(eye), xyz(dir), range);
    if (d >= range || d < 4) return null; // nothing to hook, or too close to bother
    const { pos, vel } = this.mover;
    const v = { x: vel.x + dir[0] * force, y: Math.max(vel.y, 0) + dir[1] * force + up, z: vel.z + dir[2] * force };
    return this.flight(this.boxes, pos, v, true, steer, 3);
  }

  // Where a pearl thrown along dir would warp us (same rule as the server, players ignored), or null.
  pearlSpot(room, eye, dir) {
    const { speed, gravity, life } = ITEMS.pearl;
    const dt = 0.05;
    let p = eye;
    const v = dir.map((n) => n * speed);
    for (let t = 0; t < life && p[1] > room.map.killY; t += dt) {
      v[1] -= gravity * dt;
      const s = Math.hypot(...v);
      const u = v.map((n) => n / s);
      const step = s * dt;
      const d = raycastBoxes(room.solids, xyz(p), xyz(u), step);
      p = p.map((n, i) => n + u[i] * (d < step ? Math.max(0, d - 0.1) : step));
      if (d < step) break;
    }
    const hs = Math.hypot(v[0], v[2]);
    const back = hs > 0.1 ? PLAYER.radius / hs : 0;
    const [x, z] = [p[0] - v[0] * back, p[2] - v[2] * back];
    const b = floorAt(this.boxes, x, z, p[1] + 0.3);
    return b && b.kind !== 'lava' ? [x, b.max[1], z] : null;
  }
}
