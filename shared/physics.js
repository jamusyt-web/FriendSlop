// Own-player movement: AABB vs map boxes, per-axis resolution, step-up, double jump, dive,
// bounce / ice / lava / conveyors, riding moving boxes, chaos mods and server fx (knock, freeze, slip, boost,
// float, dizzy, tp). Blinked-out boxes (`off`) are ignored everywhere.
import { MOVE, PLAYER } from './config.js';
import { ITEMS } from './items.js';

const R = PLAYER.radius;
const H = PLAYER.height;
const EPS = 1e-4;
const SKIN = 0.05; // tolerance for "standing on" a top face
const MAX_FALL = 50;
const ZERO = [0, 0, 0];
const LOOKAHEAD = 0.1; // s: a moving box prefers pushing you where it will be, so it never tunnels through you

// Velocity a floor carries its riders with: moving box (dv) + conveyor belt (push). null if neither.
const floorVel = (b) => {
  if (!b || b.off || !(b.dv || b.push)) return null;
  const dv = b.dv || ZERO;
  const push = b.push || ZERO;
  return [dv[0] + push[0], dv[1], dv[2] + push[1]];
};

// Ray vs boxes (slab test). Returns distance to first hit or maxT.
export function raycastBoxes(boxes, o, d, maxT) {
  let best = maxT;
  for (const b of boxes) {
    if (b.off) continue;
    let t0 = 0;
    let t1 = best;
    let hit = true;
    for (let i = 0; i < 3; i++) {
      const oi = i === 0 ? o.x : i === 1 ? o.y : o.z;
      const di = i === 0 ? d.x : i === 1 ? d.y : d.z;
      if (Math.abs(di) < 1e-8) {
        if (oi < b.min[i] || oi > b.max[i]) {
          hit = false;
          break;
        }
        continue;
      }
      let a = (b.min[i] - oi) / di;
      let c = (b.max[i] - oi) / di;
      if (a > c) [a, c] = [c, a];
      t0 = Math.max(t0, a);
      t1 = Math.min(t1, c);
      if (t0 > t1) {
        hit = false;
        break;
      }
    }
    if (hit && t0 < best) best = t0;
  }
  return best;
}

// Highest box top under (x,z) that is at or below y (for blob shadows). -Infinity if none.
export function groundBelow(boxes, x, z, y) {
  let top = -Infinity;
  for (const b of boxes) {
    if (!b.off && x > b.min[0] && x < b.max[0] && z > b.min[2] && z < b.max[2] && b.max[1] <= y + SKIN && b.max[1] > top) top = b.max[1];
  }
  return top;
}

const angleTo = (from, to) => {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};

export class Mover {
  constructor() {
    this.pos = { x: 0, y: 0, z: 0 };
    this.prev = { x: 0, y: 0, z: 0 };
    this.vel = { x: 0, y: 0, z: 0 };
    this.boxes = [];
    this.facing = 0;
    this.reset();
  }

  reset() {
    this.vel.x = this.vel.y = this.vel.z = 0;
    this.grounded = false;
    this.ground = null;
    this.jumpsLeft = 1;
    this.coyote = 0;
    this.jumpBuffer = 0;
    this.wantDive = false;
    this.diving = false;
    this.slide = 0;
    this.diveCooldown = 0;
    this.frozen = 0;
    this.slip = 0;
    this.boost = 0;
    this.boostSpeed = 1;
    this.float = 0; // balloon: low gravity
    this.dizzy = 0; // stink: reversed controls
    this.dancing = 0; // emote timer set by the caller
    this.smoothY = 0; // visual offset that hides step-up pops
    this.airTime = 0;
  }

  // Effect timers survive (the server keeps them through swaps and respawns). A spot inside a box (moving
  // platform moved on, pearl in a wall) is fixed up: onto its top if that's a short climb, else nudged out.
  teleport(p) {
    const { frozen, slip, boost, boostSpeed, float, dizzy } = this;
    this.reset();
    Object.assign(this, { frozen, slip, boost, boostSpeed, float, dizzy });
    this.pos.x = p[0];
    this.pos.y = p[1];
    this.pos.z = p[2];
    this.unstick(true);
    this.prev.x = this.pos.x;
    this.prev.y = this.pos.y;
    this.prev.z = this.pos.z;
  }

  // Server fx knock (spring, glove, blasts, ...). Own velocity is relative to the floor, so leaving it from
  // outside step() has to take the floor's speed along (a spring on a ferry doesn't drop you behind it).
  knock(v) {
    const f = this.grounded ? floorVel(this.ground) : null;
    if (f) {
      this.vel.x += f[0];
      this.vel.z += f[2];
      this.vel.y += Math.max(0, f[1]);
    }
    if (v[1] > 0) this.vel.y = Math.max(this.vel.y, 0); // launches (spring, boom) aren't eaten by fall speed
    this.vel.x += v[0];
    this.vel.y += v[1];
    this.vel.z += v[2];
    this.grounded = false;
    this.diving = false;
  }

  // inp: {x, z} world-space wish direction (length <= 1), locked: bool. Returns list of events.
  step(dt, inp, mods, events) {
    const p = this.pos;
    const v = this.vel;
    this.prev.x = p.x;
    this.prev.y = p.y;
    this.prev.z = p.z;
    this.jumpBuffer -= dt;
    this.coyote -= dt;
    this.diveCooldown -= dt;
    this.frozen -= dt;
    this.slip -= dt;
    this.boost -= dt;
    this.float -= dt;
    this.dizzy -= dt;
    this.dancing -= dt;
    this.slide -= dt;
    this.smoothY *= Math.exp(-dt * 14);

    // ride the floor: lifts carry us on all axes, conveyors push us. Own velocity is relative to the floor.
    // Boxes moved since last step, so get out of any we're in first: the sweeps below assume we start outside.
    const floor = this.grounded ? this.ground : null;
    const fv0 = floorVel(floor);
    if (fv0 && floor.dv && this.overlapsXZ(floor)) p.y = floor.max[1]; // stick to lifts going up or down
    this.unstick(false);
    if (fv0) {
      this.moveH('x', 0, fv0[0] * dt, true);
      this.moveH('z', 2, fv0[2] * dt, true);
    }

    const control = !inp.locked && this.frozen <= 0 && this.slip <= 0;
    let wx = control ? inp.x : 0;
    let wz = control ? inp.z : 0;
    if (!!mods.reverse !== this.dizzy > 0) { // backwards day + dizzy cancel out
      wx = -wx;
      wz = -wz;
    }
    const moving = wx !== 0 || wz !== 0;
    const speedMul = mods.speed * (this.boost > 0 ? this.boostSpeed : 1);
    const maxSpeed = MOVE.speed * speedMul;

    // jump / double jump (buffered + coyote time)
    if (control && this.jumpBuffer > 0) {
      if (this.grounded || this.coyote > 0) {
        v.y = MOVE.jump;
        this.grounded = false;
        this.coyote = 0;
        this.jumpBuffer = 0;
        this.diving = false;
        events.push({ k: 'jump' });
      } else if (this.jumpsLeft > 0) {
        v.y = MOVE.jump;
        this.jumpsLeft--;
        this.jumpBuffer = 0;
        this.diving = false;
        events.push({ k: 'doublejump' });
      }
    }

    // dive: forward lunge
    if (this.wantDive) {
      this.wantDive = false;
      if (control && this.diveCooldown <= 0 && !this.diving) {
        const dir = moving ? Math.atan2(wx, wz) : this.facing;
        const s = MOVE.diveSpeed * Math.max(1, speedMul * 0.85);
        v.x = Math.sin(dir) * s;
        v.z = Math.cos(dir) * s;
        v.y = Math.max(v.y, MOVE.diveUp);
        this.facing = dir;
        this.diving = true;
        this.grounded = false;
        this.diveCooldown = MOVE.diveCooldown;
        events.push({ k: 'dive' });
      }
    }

    // horizontal velocity
    const onIce = this.grounded && this.ground?.kind === 'ice';
    const iceK = onIce ? 0.1 : 1;
    if (this.grounded && !this.diving) {
      const sliding = this.slide > 0 || this.slip > 0;
      if (moving && !sliding) {
        const accel = MOVE.accel * mods.accel * iceK * dt;
        const dx = wx * maxSpeed - v.x;
        const dz = wz * maxSpeed - v.z;
        const len = Math.hypot(dx, dz);
        const k = len > accel ? accel / len : 1;
        v.x += dx * k;
        v.z += dz * k;
      } else {
        const fric = MOVE.friction * mods.friction * iceK * (sliding ? 0.2 : 1);
        const k = Math.max(0, 1 - fric * dt);
        v.x *= k;
        v.z *= k;
      }
    } else if (moving) {
      // air control keeps momentum above max speed (dive, knock, bounce) but lets you steer
      const before = Math.hypot(v.x, v.z);
      const a = MOVE.airAccel * mods.accel * dt;
      v.x += wx * a;
      v.z += wz * a;
      const after = Math.hypot(v.x, v.z);
      const cap = Math.max(maxSpeed, before);
      if (after > cap) {
        v.x *= cap / after;
        v.z *= cap / after;
      }
    }

    const gravity = mods.gravity * (this.float > 0 ? ITEMS.balloon.gravity : 1);
    v.y = Math.max(v.y - MOVE.gravity * gravity * dt, -MAX_FALL);

    // move per axis
    const wasGrounded = this.grounded;
    const fallSpeed = -v.y;
    this.moveH('x', 0, v.x * dt, wasGrounded);
    this.moveH('z', 2, v.z * dt, wasGrounded);
    this.moveY(v.y * dt);

    if (this.grounded) {
      this.airTime = 0;
      this.jumpsLeft = 1;
      if (!wasGrounded) {
        if (this.diving) {
          this.diving = false;
          this.slide = 0.3;
        }
        events.push({ k: 'land', speed: fallSpeed });
      }
      if (this.ground.kind === 'bounce') {
        v.y = MOVE.bounce * Math.sqrt(gravity);
        this.grounded = false;
        this.jumpsLeft = 1;
        events.push({ k: 'bounce', box: this.ground });
      } else if (mods.autoBounce) {
        v.y = MOVE.jump;
        this.grounded = false;
        events.push({ k: 'jump', auto: true });
      }
    } else {
      this.airTime += dt;
      if (wasGrounded && v.y <= 0) this.coyote = 0.1;
    }

    // stepped on/off a moving floor (jump, walk off, land): keep world momentum
    const fv1 = this.grounded ? floorVel(this.ground) : null;
    if (fv0 || fv1) {
      const a = fv0 || ZERO;
      const b = fv1 || ZERO;
      v.x += a[0] - b[0];
      v.z += a[2] - b[2];
      if (!this.grounded) v.y += Math.max(0, a[1]); // jumping off a rising lift goes higher
    }

    // facing
    if (this.slip > 0) this.facing += dt * 14;
    else if (moving && !this.diving) {
      const target = Math.atan2(wx, wz);
      const d = angleTo(this.facing, target);
      this.facing += d * Math.min(1, dt * 14);
    }

    if (this.touchingLava()) events.push({ k: 'lava' });
  }

  // horizontal axis move with step-up
  moveH(axis, i, d, canStep) {
    if (!d) return;
    const p = this.pos;
    p[axis] += d;
    for (const b of this.boxes) {
      if (b.off || !this.overlaps(b, 0)) continue;
      const rise = b.max[1] - p.y;
      // full steps when grounded; tiny lips (ice strips, pads) always, so we never get shoved sideways off them
      const stepOk = (canStep && this.vel.y <= 0 && rise <= MOVE.stepHeight + 0.01) || rise <= 0.15;
      if (rise > 0 && stepOk && this.standAt('y', b.max[1] + EPS) !== null) {
        p.y = b.max[1];
        this.smoothY -= rise;
        continue;
      }
      p[axis] = d > 0 ? b.min[i] - R - EPS : b.max[i] + R + EPS;
      if (this.vel[axis] * d > 0) this.vel[axis] = 0; // a floor carrying us into a wall doesn't eat our own speed
    }
  }

  // Get out of any box we are inside (pushers, lifts, pop-up walls, blink tiles coming back, teleports):
  // cheapest way out that fits, biased toward where the box is going so pushers push instead of letting us
  // tunnel through. `lift` favors climbing on top (teleports).
  unstick(lift) {
    const p = this.pos;
    const v = this.vel;
    for (let n = 0; n < 4; n++) {
      const b = this.inside();
      if (!b) return;
      const dv = b.dv || ZERO;
      const ways = [
        ['x', 0, b.max[0] + R + EPS], ['x', 0, b.min[0] - R - EPS],
        ['y', 1, b.max[1]], ['y', 1, b.min[1] - H - EPS],
        ['z', 2, b.max[2] + R + EPS], ['z', 2, b.min[2] - R - EPS],
      ].map(([axis, i, to]) => {
        const d = to - p[axis];
        const cost = Math.abs(d) - Math.sign(d) * dv[i] * LOOKAHEAD - (lift && i === 1 && d > 0 ? H : 0);
        return { axis, i, to, d, cost };
      });
      const up = ways[2];
      let way = up; // nothing fits (crushed): climb on top
      let y = up.to;
      for (const w of ways.sort((a, c) => a.cost - c.cost)) {
        const at = this.standAt(w.axis, w.to);
        if (at !== null) {
          way = w;
          y = at;
          break;
        }
      }
      if (way.i !== 1) {
        p[way.axis] = way.to;
        this.smoothY -= y - p.y; // stepped onto a belt / step on the way out
      }
      p.y = y;
      if (way === up) {
        if (v.y < dv[1]) v.y = Math.min(v.y, 0); // landed on it: riding takes over next step
      } else if ((v[way.axis] - dv[way.i]) * way.d < 0) v[way.axis] = dv[way.i]; // shoved: move with the box
    }
  }

  // vertical sweep: land on the highest top crossed, bonk on the lowest bottom crossed
  moveY(d) {
    const p = this.pos;
    const y0 = p.y;
    const y1 = y0 + d;
    this.grounded = false;
    this.ground = null;
    if (d <= 0) {
      let top = -Infinity;
      let hit = null;
      for (const b of this.boxes) {
        if (b.off || !this.overlapsXZ(b)) continue;
        const t = b.max[1];
        if (t <= y0 + SKIN && t >= y1 - EPS && t > top) {
          top = t;
          hit = b;
        }
      }
      if (hit) {
        p.y = top;
        this.vel.y = 0;
        this.grounded = true;
        this.ground = hit;
      } else p.y = y1;
    } else {
      let bottom = Infinity;
      for (const b of this.boxes) {
        if (b.off || !this.overlapsXZ(b)) continue;
        const t = b.min[1];
        if (t >= y0 + H - SKIN && t <= y1 + H && t < bottom) bottom = t;
      }
      if (bottom < Infinity) {
        p.y = bottom - H - EPS;
        this.vel.y = 0;
      } else p.y = y1;
    }
  }

  overlapsXZ(b) {
    const p = this.pos;
    return p.x - R < b.max[0] - EPS && p.x + R > b.min[0] + EPS && p.z - R < b.max[2] - EPS && p.z + R > b.min[2] + EPS;
  }

  overlaps(b, grow) {
    const p = this.pos;
    return (
      p.x - R - grow < b.max[0] - EPS && p.x + R + grow > b.min[0] + EPS &&
      p.y - grow < b.max[1] - EPS && p.y + H + grow > b.min[1] + EPS &&
      p.z - R - grow < b.max[2] - EPS && p.z + R + grow > b.min[2] + EPS
    );
  }

  // first box the player is inside, if any
  inside() {
    return this.boxes.find((b) => !b.off && this.overlaps(b, 0));
  }

  // y the player fits at with pos[axis] = to, or null. Sideways moves step up onto low lips like walking does.
  standAt(axis, to) {
    const p = this.pos;
    const { x, y, z } = p;
    p[axis] = to;
    if (axis !== 'y') {
      for (const b of this.boxes) if (!b.off && this.overlaps(b, 0) && b.max[1] - y <= MOVE.stepHeight + 0.01) p.y = Math.max(p.y, b.max[1]);
    }
    const at = this.inside() ? null : p.y;
    p.x = x;
    p.y = y;
    p.z = z;
    return at;
  }

  touchingLava() {
    if (this.ground?.kind === 'lava') return true;
    for (const b of this.boxes) if (b.kind === 'lava' && !b.off && this.overlaps(b, 0.03)) return true;
    return false;
  }

  anim() {
    if (this.slip > 0) return 'slip';
    if (this.diving || this.slide > 0) return 'dive';
    if (!this.grounded && this.airTime > 0.06) return this.vel.y > 0 ? 'jump' : 'fall';
    const speed = Math.hypot(this.vel.x, this.vel.z);
    if (this.dancing > 0 && speed < 1) return 'dance';
    return speed > 1 ? 'run' : 'idle';
  }
}
