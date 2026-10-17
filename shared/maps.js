// Maps are axis-aligned boxes. Shared so client (render + collision) and server (spawns, items) agree.
// Box kinds: solid | bounce (launch up on landing) | lava (touch = respawn) | ice (slippery top)
// spawns / items are [x, y, z] with y = surface height the player stands on.

const box = (x, z, w, d, y, h, kind = 'solid', color) => ({
  min: [x - w / 2, y, z - d / 2],
  max: [x + w / 2, y + h, z + d / 2],
  kind,
  color,
});
const pad = (x, z, y = 0) => box(x, z, 2, 2, y, 0.2, 'bounce');
const corners = (f) => [[1, 1], [-1, 1], [1, -1], [-1, -1]].flatMap(([sx, sz]) => f(sx, sz));
const walls = (half, h, color) => [
  box(0, -half - 0.5, half * 2 + 2, 1, 0, h, 'solid', color),
  box(0, half + 0.5, half * 2 + 2, 1, 0, h, 'solid', color),
  box(-half - 0.5, 0, 1, half * 2 + 2, 0, h, 'solid', color),
  box(half + 0.5, 0, 1, half * 2 + 2, 0, h, 'solid', color),
];
// stairs climbing toward (x, z) from direction (dx, dz); top step ends at height `top`
const stairs = (x, z, dx, dz, top, width = 3, color) => {
  const out = [];
  const n = Math.round(top / 0.6) - 1;
  for (let i = 1; i <= n; i++) {
    const off = 0.6 + (n - i) * 1.2;
    const w = dx ? 1.2 : width;
    const d = dz ? 1.2 : width;
    out.push(box(x + dx * off, z + dz * off, w, d, 0, 0.6 * i, 'solid', color));
  }
  return out;
};

// ---------- 1. Bounce Castle: open playground, central keep, bridges ----------
const castle = (() => {
  const G = 0x7ec850, W = 0xf4a261, S = 0xe9c46a, T = 0x2a9d8f, P = 0xe76f51;
  return {
    name: 'Bounce Castle',
    sky: 0x8fd3ff,
    killY: -20,
    boxes: [
      box(0, 0, 60, 60, -1, 1, 'solid', G),
      ...walls(30, 4, W),
      box(0, 0, 10, 10, 0, 3, 'solid', S), // keep
      ...stairs(0, 5, 0, 1, 3, 3, S),
      ...stairs(0, -5, 0, -1, 3, 3, S),
      box(0, 0, 4, 4, 3, 4, 'solid', P), // tower, top 7
      pad(3.5, 3.5, 3),
      box(-20, 0, 8, 8, 0, 3, 'solid', T),
      box(20, 0, 8, 8, 0, 3, 'solid', T),
      box(-10.5, 0, 11, 2, 2.6, 0.4, 'solid', S), // bridges
      box(10.5, 0, 11, 2, 2.6, 0.4, 'solid', S),
      ...stairs(24, 0, 1, 0, 3, 3, T),
      ...stairs(-24, 0, -1, 0, 3, 3, T),
      pad(20, 7), pad(-20, 7), pad(20, -7), pad(-20, -7),
      ...corners((sx, sz) => [
        box(sx * 21, sz * 18, 8, 1, 0, 2.2, 'solid', W),
        box(sx * 18, sz * 21, 1, 8, 0, 2.2, 'solid', W),
        box(sx * 10, sz * 18, 1.5, 1.5, 0, 4, 'solid', P),
        box(sx * 8, sz * 12, 1, 5, 0, 1.2, 'solid', W),
      ]),
    ],
    spawns: [[12, 0, 12], [-12, 0, 12], [12, 0, -12], [-12, 0, -12], [0, 0, 22], [0, 0, -22], [26, 0, 8], [-26, 0, -8]],
    items: [[0, 7, 0], [20, 3, 0], [-20, 3, 0], [0, 0, 26], [0, 0, -26], [24, 0, 24], [-24, 0, -24]],
  };
})();

// ---------- 2. Sky Slop: floating islands over the void ----------
const sky = (() => {
  const I = 0x9be564, D = 0x8d6e63, B = 0xffffff, C = 0xffe66d;
  const island = (x, z, s) => [box(x, z, s, s, -3, 2.6, 'solid', D), box(x, z, s, s, -0.4, 0.4, 'solid', I)];
  return {
    name: 'Sky Slop',
    sky: 0xffc8dd,
    killY: -15,
    boxes: [
      ...island(0, 0, 16),
      ...island(24, 0, 10), ...island(-24, 0, 10), ...island(0, 24, 10), ...island(0, -24, 10),
      ...corners((sx, sz) => island(sx * 17, sz * 17, 7)),
      box(13.5, 0, 11, 1.6, -0.4, 0.4, 'solid', B), // east bridge
      box(0, 13.5, 1.6, 11, -0.4, 0.4, 'ice', B), // north bridge, icy
      box(0, -13.5, 1.6, 11, -0.4, 0.4, 'solid', B), // south bridge
      box(-9.9, 0, 3.8, 1.6, -0.4, 0.4, 'solid', B), // west bridge, gap in the middle
      box(-17.1, 0, 3.8, 1.6, -0.4, 0.4, 'solid', B),
      ...corners((sx, sz) => [
        box(sx * 21.5, sz * 9.25, 2.5, 2.5, -0.5, 1, 'solid', C), // stepping stones
        box(sx * 9.25, sz * 21.5, 2.5, 2.5, -0.5, 1, 'solid', C),
        pad(sx * 5, sz * 5),
        box(sx * 9, sz * 9, 4, 4, 4.6, 0.4, 'solid', B), // clouds, top 5
        pad(sx * 17, sz * 17),
      ]),
      box(0, 0, 3, 3, 0, 6, 'solid', C), // spire, top 6
      pad(0, 3),
    ],
    spawns: [[5, 0, 0], [-5, 0, 0], [0, 0, 5], [0, 0, -5], [24, 0, 0], [-24, 0, 0], [0, 0, 24], [0, 0, -24]],
    items: [[0, 6, 0], [24, 0, 3], [-24, 0, -3], [3, 0, 24], [-3, 0, -24], [9, 5, 9], [-9, 5, -9]],
  };
})();

// ---------- 3. Crate Maze: warehouse with crate walls, catwalks, slime pit ----------
const maze = (() => {
  const F = 0x4a4e69, W = 0x9a8c98, K = 0xc68b59, Y = 0xf2e94e;
  const crateWall = (x, z, w, d, h = 2.4) => box(x, z, w, d, 0, h, 'solid', K);
  return {
    name: 'Crate Maze',
    sky: 0x22223b,
    killY: -20,
    boxes: [
      box(0, 0, 48, 48, -1, 1, 'solid', F),
      ...walls(24, 9, W),
      box(0, -22.5, 48, 3, 4.1, 0.4, 'solid', Y), // catwalks, top 4.5
      box(0, 22.5, 48, 3, 4.1, 0.4, 'solid', Y),
      box(-22.5, 0, 3, 48, 4.1, 0.4, 'solid', Y),
      box(22.5, 0, 3, 48, 4.1, 0.4, 'solid', Y),
      ...corners((sx, sz) => [pad(sx * 18, sz * 18)]),
      crateWall(-12, -12, 8, 2), crateWall(12, 12, 8, 2), crateWall(-12, 12, 2, 8), crateWall(12, -12, 2, 8),
      crateWall(0, -6, 10, 2), crateWall(0, 6, 10, 2), crateWall(-6, 0, 2, 6), crateWall(6, 0, 2, 6),
      crateWall(-18, 0, 2, 10), crateWall(18, 0, 2, 10), crateWall(0, -18, 10, 2), crateWall(0, 18, 10, 2),
      crateWall(-3, -12, 1.2, 1.2, 1.2), crateWall(3, 12, 1.2, 1.2, 1.2),
      crateWall(-12, 3, 1.2, 1.2, 1.2), crateWall(12, -3, 1.2, 1.2, 1.2),
      crateWall(-19.5, 8, 2, 2, 1.2), crateWall(-19.5, 10, 2, 2, 2.4), crateWall(-19.5, 12, 2, 2, 3.6), // climb to catwalk
      crateWall(19.5, -8, 2, 2, 1.2), crateWall(19.5, -10, 2, 2, 2.4), crateWall(19.5, -12, 2, 2, 3.6),
      box(0, 0, 4, 4, 0, 0.1, 'lava'), // slime pit
      box(0, 21, 14, 4, 0, 0.05, 'ice'),
      box(0, -21, 14, 4, 0, 0.05, 'ice'),
    ],
    spawns: [[9, 0, 9], [-9, 0, -9], [9, 0, -9], [-9, 0, 9], [15, 0, 3], [-15, 0, -3], [3, 0, 15], [-3, 0, -15]],
    items: [[0, 1.2, 0], [0, 4.5, -22.5], [0, 4.5, 22.5], [12, 0, 0], [-12, 0, 0], [-21, 0, -21], [21, 0, 21]],
  };
})();

// ---------- 4. Floor Is Lava: pillar hopping ----------
const lava = (() => {
  const W = 0x3d405b, colors = [0xf4f1de, 0x81b29a, 0xf2cc8f, 0xe07a5f];
  const boxes = [box(0, 0, 36, 36, -1, 1, 'lava'), ...walls(18, 7, W)];
  const tops = {};
  const grid = [-12, -6, 0, 6, 12];
  grid.forEach((x, i) => grid.forEach((z, j) => {
    if ((i === 1 && j === 3) || (i === 3 && j === 1)) return; // holes: dive across
    const h = x === 0 && z === 0 ? 4.5 : 1 + ((i * 7 + j * 3) % 5) * 0.5;
    tops[`${x},${z}`] = h;
    boxes.push(box(x, z, 4, 4, -1, h + 1, 'solid', colors[(i + j) % 4]));
  }));
  boxes.push(pad(-6, -6, tops['-6,-6']), pad(6, 6, tops['6,6']), pad(-12, 12, tops['-12,12']), pad(12, -12, tops['12,-12']));
  const at = (x, z) => [x, tops[`${x},${z}`], z];
  return {
    name: 'Floor Is Lava',
    sky: 0xffb4a2,
    killY: -10,
    boxes,
    spawns: [at(-12, -12), at(12, 12), at(-12, 0), at(12, 0), at(0, -12), at(0, 12), at(-6, 0), at(6, 0)],
    items: [at(0, 0), at(-12, 6), at(12, -6), at(6, 12), at(-6, -12)],
  };
})();

export const MAPS = { castle, sky, maze, lava };
export const MAP_IDS = Object.keys(MAPS);
