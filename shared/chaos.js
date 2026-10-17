// Chaos events: one fires every CHAOS_EVERY seconds during play.
// `mods` last CHAOS_DURATION and are read by client physics/rendering
// (scale also by the server for tag range). `instant` ones are done by the server once.

export const CHAOS = {
  lowgrav: { name: 'LOW GRAVITY', mods: { gravity: 0.35 } },
  zoomies: { name: 'ZOOMIES', mods: { speed: 1.6 } },
  ice: { name: 'ICE AGE', mods: { friction: 0.08, accel: 0.25 } },
  tiny: { name: 'TINY TIME', mods: { scale: 0.5 } },
  giant: { name: 'GIANTS', mods: { scale: 1.8 } },
  dark: { name: 'LIGHTS OUT', mods: { dark: true } },
  bouncy: { name: 'BOUNCY CASTLE', mods: { autoBounce: true } },
  reverse: { name: 'BACKWARDS DAY', mods: { reverse: true } },
  swap: { name: 'SWAPPAROO', instant: true }, // shuffle everyone's positions
  rain: { name: 'ITEM RAIN', instant: true }, // everyone gets a random item, all boxes respawn
};

export const CHAOS_IDS = Object.keys(CHAOS);

export const NO_MODS = { gravity: 1, speed: 1, friction: 1, accel: 1, scale: 1 };

export function mods(chaosId) {
  return { ...NO_MODS, ...(CHAOS[chaosId]?.mods || {}) };
}
