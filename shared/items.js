// Items come from mystery boxes. One held at a time. Server owns all effects.
// Guns (gun: true) are aimed with the camera, fire `ammo` times with `cooldown` between shots, then the item is gone.
// weight = relative chance from a box (default 1). Host can switch items off in the lobby.

export const ITEMS = {
  boots: { name: 'Zoom Boots', icon: '👟', desc: 'Super speed', duration: 4, speed: 1.8 },
  banana: { name: 'Banana', icon: '🍌', desc: 'Drop a peel. Slip!', life: 25, slip: 1.6 },
  glove: { name: 'Boxing Glove', icon: '🥊', desc: 'Punch people away', range: 4, force: 20, up: 8 },
  swap: { name: 'Swap Ray', icon: '🌀', desc: 'Swap places with someone random' },
  ghost: { name: 'Ghost', icon: '👻', desc: 'Go invisible', duration: 5 },
  freeze: { name: 'Freeze Bomb', icon: '🧊', desc: 'Freeze everyone nearby', radius: 7, duration: 2 },
  spring: { name: 'Spring', icon: '🦘', desc: 'Mega jump', up: 24 },
  shield: { name: 'Bubble', icon: '🫧', desc: 'Block one tag', duration: 8 },
  blaster: { name: 'Boom Blaster', icon: '🔫', desc: 'Blast people away', gun: true, weight: 2, ammo: 6, cooldown: 0.35, range: 30, force: 18, up: 7 },
  freezeray: { name: 'Freeze Ray', icon: '❄️', desc: 'Shoot to freeze', gun: true, weight: 2, ammo: 3, cooldown: 0.6, range: 35, duration: 1.5 },
  grapple: { name: 'Grapple Hook', icon: '🪝', desc: 'Yank yourself to where you aim', gun: true, ammo: 3, cooldown: 0.5, range: 40, force: 26, up: 6 },
  pearl: { name: 'Warp Pearl', icon: '🔮', desc: 'Throw it, teleport where it lands', gun: true, ammo: 1, cooldown: 0, speed: 26, gravity: 18, life: 3 },
  balloon: { name: 'Balloon', icon: '🎈', desc: 'Float like a balloon', duration: 6, gravity: 0.25 },
  mushroom: { name: 'Mega Mushroom', icon: '🍄', desc: 'Grow huge, bonk people away', duration: 6, scale: 1.8, force: 14, up: 6 },
  wall: { name: 'Pop-up Wall', icon: '🧱', desc: 'Drop a wall behind you', duration: 6, size: [4, 3, 0.6], dist: 1.5 },
  stink: { name: 'Stink Bomb', icon: '💨', desc: 'Gross cloud scrambles controls', duration: 6, radius: 4 },
  fuse: { name: 'Short Fuse', icon: '⏱️', desc: 'Every bomb loses 6 seconds', cut: 6 },
  magnet: { name: 'Magnet', icon: '🧲', desc: 'Yank everyone nearby toward you', radius: 12, force: 16, up: 5 },
  rocket: { name: 'Rocket Launcher', icon: '🚀', desc: 'Boom! Rocket jump yourself', gun: true, weight: 2, ammo: 3, cooldown: 0.9, speed: 32, life: 3, radius: 4, force: 22, up: 10 },
};

export const ITEM_IDS = Object.keys(ITEMS);
