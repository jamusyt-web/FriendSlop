// Camera rig. Third person: mouse yaw/pitch orbit around the player, pulls in when a map box blocks the
// view, shifts over the shoulder while holding a gun. First person: at eye height, same yaw/pitch.
// Both: FOV kick, recoil kick, screen shake, and the aim direction for guns.
import * as THREE from 'three';
import { PLAYER } from '../../shared/config.js';
import { raycastBoxes } from '../../shared/physics.js';

const BASE_DIST = 6.5;
const SHOULDER = 0.8; // sideways offset while holding a gun (and 30% closer), so your head isn't under the crosshair
const AIM_FAR = 150;
const back = new THREE.Vector3(); // from the pivot toward the TP camera (= -view direction)
const right = new THREE.Vector3();
const desired = new THREE.Vector3();
const aimPoint = new THREE.Vector3();

export class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.yaw = 0;
    this.pitch = 0.3;
    this.dist = BASE_DIST;
    this.target = new THREE.Vector3();
    this.pivot = new THREE.Vector3(); // what the camera looks at (TP) / sits at (FP), without shake
    this.fwd = new THREE.Vector3(0, 0, -1); // view direction, without shake
    this.fovKick = 0;
    this.recoil = 0;
    this.aimT = 0; // 0..1 blend into the over-the-shoulder gun camera
    this.firstPerson = false;
    this.snapNext = true;
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

      const want = BASE_DIST * Math.max(0.7, Math.sqrt(scale)) * (1 - 0.3 * this.aimT);
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

    this.fovKick += (0 - this.fovKick) * Math.min(1, dt * 4);
    const fov = baseFov + this.fovKick + extraFov;
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
  }
}
