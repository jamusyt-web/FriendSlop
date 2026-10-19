// Camera rig. Third person: mouse yaw/pitch orbit around the player, pulls in when a map box blocks the
// view, shifts over the shoulder while holding a gun. First person: at eye height, same yaw/pitch.
// Both: FOV kick, recoil kick, screen shake, and the aim direction for guns.
// Spectating: the view turns to follow a player, and cuts between players fly the camera over smoothly.
import * as THREE from 'three';
import { PLAYER } from '../../shared/config.js';
import { raycastBoxes } from '../../shared/physics.js';

const BASE_DIST = 6.5;
const SHOULDER = 0.8; // sideways offset while holding a gun (and 30% closer), so your head isn't under the crosshair
const AIM_FAR = 150;
const BLEND = 0.9; // s: a spectator cut flies from the old shot to the new one
const TURN = 1.6; // rad/s: fastest the third-person spectator view swings around after its player
const back = new THREE.Vector3(); // from the pivot toward the TP camera (= -view direction)
const right = new THREE.Vector3();
const desired = new THREE.Vector3();
const aimPoint = new THREE.Vector3();
const look = new THREE.Vector3();
const offset = new THREE.Vector3();

export class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.yaw = 0;
    this.pitch = 0.3;
    this.dist = BASE_DIST;
    this.distK = 1; // third-person distance multiplier (clips: closer shots for vertical video)
    this.target = new THREE.Vector3();
    this.pivot = new THREE.Vector3(); // what the camera looks at (TP) / sits at (FP), without shake
    this.fwd = new THREE.Vector3(0, 0, -1); // view direction, without shake
    this.fovKick = 0;
    this.recoil = 0;
    this.aimT = 0; // 0..1 blend into the over-the-shoulder gun camera
    this.firstPerson = false;
    this.snapNext = true;
    this.blend = null; // spectator cut in progress: { t, look, dir, len } of the old shot
  }

  setFirstPerson(v) {
    this.firstPerson = v;
    this.clampPitch();
    this.snapNext = true;
  }

  look(dx, dy, sensitivity, invertY) {
    const k = 0.0024 * sensitivity;
    this.yaw -= dx * k;
    this.pitch += dy * k * (invertY ? -1 : 1);
    this.clampPitch();
  }

  clampPitch() {
    const [lo, hi] = this.firstPerson ? [-1.5, 1.5] : [-0.75, 1.25];
    this.pitch = Math.max(lo, Math.min(hi, this.pitch));
  }

  // world-space move direction for camera-relative input (x = right, y = forward)
  moveDir(ax, ay) {
    const s = Math.sin(this.yaw);
    const c = Math.cos(this.yaw);
    let x = -s * ay + c * ax;
    let z = -c * ay - s * ax;
    const len = Math.hypot(x, z);
    if (len > 1) {
      x /= len;
      z /= len;
    }
    return { x, z };
  }

  kick(amount) {
    this.fovKick = Math.max(this.fovKick, amount);
  }

  // gun recoil: view tilts up a bit and settles back
  punch(amount) {
    this.recoil = Math.min(0.2, this.recoil + amount);
  }

  // spectating: turn the view toward behind (third person, gently) or along (first person) a player facing ry
  chase(dt, ry) {
    let d = (ry + Math.PI - this.yaw) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    if (this.firstPerson) this.yaw += d * Math.min(1, dt * 12);
    else this.yaw += Math.max(-TURN * dt, Math.min(TURN * dt, d * (1 - Math.exp(-dt * 1.5))));
    this.pitch = this.firstPerson ? 0.08 : 0.32;
  }

  // The next updates fly the camera over from the current shot to the new one (spectator cuts): the point looked
  // at slides across, and the camera keeps a blend of both shots' offsets from it, so it never flies through
  // the player it's leaving.
  blendFromHere() {
    const cam = this.camera;
    const at = cam.getWorldDirection(new THREE.Vector3()).multiplyScalar(this.firstPerson ? 10 : this.dist).add(cam.position);
    const off = cam.position.clone().sub(at);
    this.blend = { t: 0, look: at, len: off.length(), dir: off.normalize() };
  }

  // Unit aim direction for a shot fired from `from` (the server's muzzle: feet + eye height). In third
  // person the shot goes toward whatever is under the crosshair, so it lands there despite the offset.
  aimDir(boxes, from, out) {
    if (this.firstPerson) return out.copy(this.fwd);
    aimPoint.copy(this.pivot).addScaledVector(this.fwd, raycastBoxes(boxes, this.pivot, this.fwd, AIM_FAR));
    out.copy(aimPoint).sub(from);
    return out.lengthSq() > 1 ? out.normalize() : out.copy(this.fwd);
  }

  // focus: player feet position; scale: chaos scale; boxes: map collision; shake: {x,y,z,roll};
  // gun: holding a gun (shoulder offset in third person)
  update(dt, focus, scale, boxes, baseFov, shake, extraFov = 0, gun = false) {
    this.recoil *= Math.exp(-dt * 12);
    const pitch = Math.max(-1.55, this.pitch - this.recoil); // never past straight up
    const cp = Math.cos(pitch);
    back.set(Math.sin(this.yaw) * cp, Math.sin(pitch), Math.cos(this.yaw) * cp);
    this.fwd.copy(back).negate();
    const cam = this.camera;

    if (this.firstPerson) {
      this.pivot.set(focus.x, focus.y + PLAYER.eye * scale, focus.z);
      this.snapNext = true; // third person starts fresh when switched back
      cam.position.set(this.pivot.x + shake.x * 0.3, this.pivot.y + shake.y * 0.3, this.pivot.z + shake.z * 0.3);
      cam.lookAt(desired.copy(cam.position).add(this.fwd));
    } else {
      const head = new THREE.Vector3(focus.x, focus.y + 1.55 * scale, focus.z);
      if (this.snapNext || this.target.distanceToSquared(head) > 64) {
        this.target.copy(head);
        this.aimT = gun ? 1 : 0;
        this.snapNext = false;
      } else {
        this.target.x += (head.x - this.target.x) * Math.min(1, dt * 22);
        this.target.z += (head.z - this.target.z) * Math.min(1, dt * 22);
        this.target.y += (head.y - this.target.y) * Math.min(1, dt * 12);
      }

      // over the shoulder (not into a wall)
      this.aimT += ((gun ? 1 : 0) - this.aimT) * Math.min(1, dt * 8);
      const shoulder = this.aimT * SHOULDER * scale;
      right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      const side = shoulder > 0.01 ? Math.max(0, Math.min(shoulder, raycastBoxes(boxes, this.target, right, shoulder + 0.3) - 0.3)) : 0;
      this.pivot.copy(this.target).addScaledVector(right, side);

      const want = BASE_DIST * this.distK * Math.max(0.7, Math.sqrt(scale)) * (1 - 0.3 * this.aimT);
      const hit = raycastBoxes(boxes, this.pivot, back, want + 0.3) - 0.3;
      const allowed = Math.max(0.6, Math.min(want, hit));
      // pull in instantly, ease back out
      this.dist = allowed < this.dist ? allowed : this.dist + (allowed - this.dist) * Math.min(1, dt * 5);

      desired.copy(this.pivot).addScaledVector(back, this.dist);
      cam.position.copy(desired);
      cam.position.x += shake.x;
      cam.position.y += shake.y;
      cam.position.z += shake.z;
      cam.lookAt(this.pivot);
    }
    cam.rotateZ(shake.roll);

    if (this.blend) {
      const b = this.blend;
      b.t += dt;
      const k = Math.min(1, b.t / BLEND);
      const e = k * k * (3 - 2 * k);
      cam.getWorldDirection(look).multiplyScalar(this.firstPerson ? 10 : this.dist).add(cam.position); // the new shot
      offset.copy(cam.position).sub(look);
      const len = b.len + (offset.length() - b.len) * e;
      offset.normalize().multiplyScalar(e).addScaledVector(b.dir, 1 - e);
      if (offset.lengthSq() < 1e-4) offset.set(0, 1, 0); // opposite shots: over the top
      offset.normalize();
      const lift = Math.min(3, b.look.distanceTo(look) * 0.1) * Math.sin(Math.PI * e); // a bit up, over what's in between
      look.lerpVectors(b.look, look, e);
      look.y += lift;
      const d = Math.max(0.6, Math.min(len, raycastBoxes(boxes, look, offset, len + 0.3) - 0.3));
      cam.position.copy(look).addScaledVector(offset, d);
      cam.lookAt(look);
      if (k >= 1) this.blend = null;
    }

    this.fovKick += (0 - this.fovKick) * Math.min(1, dt * 4);
    const fov = baseFov + this.fovKick + extraFov;
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
  }
}
