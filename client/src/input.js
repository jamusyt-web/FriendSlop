// Keyboard + mouse state. Actions are edge-triggered and consumed once (`take`).

const held = new Set();
const pressed = new Set();
let lookX = 0;
let lookY = 0;

const BINDS = {
  KeyW: 'fwd', ArrowUp: 'fwd',
  KeyS: 'back', ArrowDown: 'back',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
  Space: 'jump',
  ShiftLeft: 'dive', ShiftRight: 'dive',
  KeyE: 'use',
  KeyV: 'view',
  KeyF: 'dance',
  Tab: 'scores',
};

export const input = {
  enabled: true, // false while a menu overlay is open
  locked: false, // pointer lock active
  canvas: null,

  isDown: (action) => input.enabled && held.has(action),
  take(action) {
    const had = pressed.has(action);
    pressed.delete(action);
    return had && input.enabled;
  },
  // camera-relative move axes: x = right, y = forward
  axes() {
    if (!input.enabled) return { x: 0, y: 0 };
    return {
      x: (held.has('right') ? 1 : 0) - (held.has('left') ? 1 : 0),
      y: (held.has('fwd') ? 1 : 0) - (held.has('back') ? 1 : 0),
    };
  },
  takeLook() {
    const d = { x: lookX, y: lookY };
    lookX = lookY = 0;
    return d;
  },
  clear() {
    held.clear();
    pressed.clear();
    lookX = lookY = 0;
  },
  requestLock() {
    if (!input.canvas || input.locked) return;
    try {
      const p = input.canvas.requestPointerLock();
      if (p && p.catch) p.catch(() => {}); // Chrome refuses re-lock right after Esc; the hint stays up
    } catch {
      // ignore
    }
  },
  releaseLock() {
    if (document.pointerLockElement) document.exitPointerLock();
  },
};

const typing = (e) => e.target instanceof HTMLInputElement && e.target.type === 'text';

export function initInput(canvas, onLockChange) {
  input.canvas = canvas;
  addEventListener('keydown', (e) => {
    if (typing(e)) return;
    const a = BINDS[e.code];
    if (!a) return;
    if (a === 'scores' || a === 'jump') e.preventDefault();
    if (!held.has(a)) pressed.add(a);
    held.add(a);
  });
  addEventListener('keyup', (e) => {
    const a = BINDS[e.code];
    if (a) held.delete(a);
  });
  addEventListener('blur', () => held.clear());
  addEventListener('mousemove', (e) => {
    if (!input.locked) return;
    lookX += e.movementX;
    lookY += e.movementY;
  });
  addEventListener('mousedown', (e) => {
    if (!input.locked) return;
    if (e.button === 0) {
      pressed.add('use');
      held.add('use'); // hold to keep firing a gun
    }
    if (e.button === 2) pressed.add('dive');
  });
  addEventListener('mouseup', (e) => {
    if (e.button === 0) held.delete('use');
  });
  addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('pointerlockchange', () => {
    input.locked = document.pointerLockElement === canvas;
    lookX = lookY = 0;
    onLockChange(input.locked);
  });
}
