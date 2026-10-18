// Items come from mystery boxes. One held at a time. Server owns all effects.
// Guns (gun: true) are aimed with the camera, fire `ammo` times with `cooldown` between shots, then the item is gone.
// weight = relative chance from a box (default 1).

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
  rocket: { name: 'Rocket Launcher', icon: '🚀', desc: 'Boom! Rocket jump yourself', gun: true, weight: 2, ammo: 3, cooldown: 0.9, speed: 32, life: 3, radius: 4, force: 22, up: 10 },
};

export const ITEM_IDS = Object.keys(ITEMS);
