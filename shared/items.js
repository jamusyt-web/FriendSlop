// Items come from mystery boxes. One held at a time. Server owns all effects.

export const ITEMS = {
  boots: { name: 'Zoom Boots', icon: '👟', desc: 'Super speed', duration: 4, speed: 1.8 },
  banana: { name: 'Banana', icon: '🍌', desc: 'Drop a peel. Slip!', life: 25, slip: 1.6 },
  glove: { name: 'Boxing Glove', icon: '🥊', desc: 'Punch people away', range: 4, force: 20, up: 8 },
  swap: { name: 'Swap Ray', icon: '🌀', desc: 'Swap places with someone random' },
  ghost: { name: 'Ghost', icon: '👻', desc: 'Go invisible', duration: 5 },
  freeze: { name: 'Freeze Bomb', icon: '🧊', desc: 'Freeze everyone nearby', radius: 7, duration: 2 },
  spring: { name: 'Spring', icon: '🦘', desc: 'Mega jump', up: 24 },
  shield: { name: 'Bubble', icon: '🫧', desc: 'Block one tag', duration: 8 },
};

export const ITEM_IDS = Object.keys(ITEMS);
