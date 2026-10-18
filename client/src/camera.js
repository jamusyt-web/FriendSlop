// Third-person orbit camera: mouse yaw/pitch around the player, pulls in when a map box blocks the view,
// smooth follow, FOV kick and screen shake.
import * as THREE from 'three';
import { raycastBoxes } from './physics.js';

const BASE_DIST = 6.5;
const tmpDir = new THREE.Vector3();
const desired = new THREE.Vector3();

export class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.yaw = 0;
    this.pitch = 0.3;
    this.dist = BASE_DIST;
    this.target = new THREE.Vector3();
    this.fovKick = 0;
    this.snapNext = true;
  }

  look(dx, dy, sensitivity, invertY) {
    const k = 0.0024 * sensitivity;
    this.yaw -= dx * k;
    this.pitch += dy * k * (invertY ? -1 : 1);
    this.pitch = Math.max(-0.75, Math.min(1.25, this.pitch));
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

  // focus: player feet position; scale: chaos scale; boxes: map collision; shake: {x,y,z,roll}
  update(dt, focus, scale, boxes, baseFov, shake, extraFov = 0) {
    const head = new THREE.Vector3(focus.x, focus.y + 1.55 * scale, focus.z);
    if (this.snapNext || this.target.distanceToSquared(head) > 64) {
      this.target.copy(head);
      this.snapNext = false;
    } else {
      this.target.x += (head.x - this.target.x) * Math.min(1, dt * 22);
      this.target.z += (head.z - this.target.z) * Math.min(1, dt * 22);
      this.target.y += (head.y - this.target.y) * Math.min(1, dt * 12);
    }

    const cp = Math.cos(this.pitch);
    tmpDir.set(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp);
    const want = BASE_DIST * Math.max(0.7, Math.sqrt(scale));
    const hit = raycastBoxes(boxes, this.target, tmpDir, want + 0.3) - 0.3;
    const allowed = Math.max(0.6, Math.min(want, hit));
    // pull in instantly, ease back out
    this.dist = allowed < this.dist ? allowed : this.dist + (allowed - this.dist) * Math.min(1, dt * 5);

    desired.copy(this.target).addScaledVector(tmpDir, this.dist);
    const cam = this.camera;
    cam.position.copy(desired);
    cam.position.x += shake.x;
    cam.position.y += shake.y;
    cam.position.z += shake.z;
    cam.lookAt(this.target);
    cam.rotateZ(shake.roll);

    this.fovKick += (0 - this.fovKick) * Math.min(1, dt * 4);
    const fov = baseFov + this.fovKick + extraFov;
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
  }
}
