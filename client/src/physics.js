// Own-player movement: AABB vs map boxes, per-axis resolution, step-up, double jump, dive,
// bounce / ice / lava, chaos mods and server fx (knock, freeze, slip, boost, tp).
import { MOVE, PLAYER } from '../../shared/config.js';

const R = PLAYER.radius;
const H = PLAYER.height;
const EPS = 1e-4;
const SKIN = 0.05; // tolerance for "standing on" a top face
const MAX_FALL = 50;

// Ray vs boxes (slab test). Returns distance to first hit or maxT.
export function raycastBoxes(boxes, o, d, maxT) {
  let best = maxT;
  for (const b of boxes) {
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
    if (x > b.min[0] && x < b.max[0] && z > b.min[2] && z < b.max[2] && b.max[1] <= y + SKIN && b.max[1] > top) top = b.max[1];
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
    this.smoothY = 0; // visual offset that hides step-up pops
    this.airTime = 0;
  }

  // Effect timers survive (the server keeps them through swaps and respawns). y is used as is: positions
  // are rounded to 0.01 and map faces sit on that grid, so a reported spot never ends up inside a box.
  teleport(p) {
    const { frozen, slip, boost, boostSpeed } = this;
    this.reset();
    Object.assign(this, { frozen, slip, boost, boostSpeed });
    this.pos.x = this.prev.x = p[0];
    this.pos.y = this.prev.y = p[1];
    this.pos.z = this.prev.z = p[2];
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
    this.slide -= dt;
    this.smoothY *= Math.exp(-dt * 14);

    const control = !inp.locked && this.frozen <= 0 && this.slip <= 0;
    let wx = control ? inp.x : 0;
    let wz = control ? inp.z : 0;
    if (mods.reverse) {
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

    v.y = Math.max(v.y - MOVE.gravity * mods.gravity * dt, -MAX_FALL);

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
        v.y = MOVE.bounce * Math.sqrt(mods.gravity);
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
      if (!this.overlaps(b, 0)) continue;
      const rise = b.max[1] - p.y;
      // full steps when grounded; tiny lips (ice strips, pads) always, so we never get shoved sideways off them
      const stepOk = (canStep && this.vel.y <= 0 && rise <= MOVE.stepHeight + 0.01) || rise <= 0.15;
      if (rise > 0 && stepOk && this.fits(b.max[1])) {
        p.y = b.max[1];
        this.smoothY -= rise;
        continue;
      }
      p[axis] = d > 0 ? b.min[i] - R - EPS : b.max[i] + R + EPS;
      this.vel[axis] = 0;
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
        if (!this.overlapsXZ(b)) continue;
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
        if (!this.overlapsXZ(b)) continue;
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

  fits(y) {
    const save = this.pos.y;
    this.pos.y = y + EPS;
    let ok = true;
    for (const b of this.boxes) {
      if (this.overlaps(b, 0)) {
        ok = false;
        break;
      }
    }
    this.pos.y = save;
    return ok;
  }

  touchingLava() {
    if (this.ground?.kind === 'lava') return true;
    for (const b of this.boxes) if (b.kind === 'lava' && this.overlaps(b, 0.03)) return true;
    return false;
  }

  anim() {
    if (this.slip > 0) return 'slip';
    if (this.diving || this.slide > 0) return 'dive';
    if (!this.grounded && this.airTime > 0.06) return this.vel.y > 0 ? 'jump' : 'fall';
    return Math.hypot(this.vel.x, this.vel.z) > 1 ? 'run' : 'idle';
  }
}
