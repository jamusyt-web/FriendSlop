// Maps are axis-aligned boxes. Shared so client (render + collision) and server (spawns, items) agree.
// Box kinds: solid | bounce (launch up on landing) | lava (touch = respawn) | ice (slippery top)
//            | conveyor (push: [vx, vz] m/s carries anyone standing on top)
// Dynamic boxes (optional, any kind):
//   move:  { to: [dx, dy, dz], period, phase? } smooth ping-pong between base position and base + to
//   blink: { period, on, phase? } solid only while (t / period + phase) % 1 < on
// Maps are shared module data: call instantiate(id) for a private mutable copy, then setMapTime(map, t)
// before stepping physics. spawns / items are [x, y, z] with y = surface height the player stands on.
// size: S | M | L (L = built for 9-16 players).

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
const belt = (x, z, w, d, y, h, push, color = 0x2b2d42) => ({ ...box(x, z, w, d, y, h, 'conveyor', color), push });
const moving = (b, to, period, phase = 0) => ({ ...b, move: { to, period, phase } });
const blinking = (b, period, on, phase = 0) => ({ ...b, blink: { period, on, phase } });
// 3x3 elevator resting on the ground (top 0.4), rides up until its top is at `top`
const lift = (x, z, top, period, phase, color = 0xffc300) => moving(box(x, z, 3, 3, 0, 0.4, 'solid', color), [0, top - 0.4, 0], period, phase);
// square conveyor loop around the center, half-size a, belts `w` wide at height y, clockwise from above.
// Each belt includes the corner where it starts, so riders turn the corner instead of shooting off it.
const loop = (a, w, y, h, speed, color) => [
  belt(-w / 2, -a, a * 2, w, y, h, [speed, 0], color),
  belt(a, -w / 2, w, a * 2, y, h, [0, speed], color),
  belt(w / 2, a, a * 2, w, y, h, [-speed, 0], color),
  belt(-a, w / 2, w, a * 2, y, h, [0, -speed], color),
];

// ---------- 1. Bounce Castle: open playground, central keep, bridges ----------
const castle = (() => {
  const G = 0x7ec850, W = 0xf4a261, S = 0xe9c46a, T = 0x2a9d8f, P = 0xe76f51;
  return {
    name: 'Bounce Castle',
    size: 'M',
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
    size: 'M',
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
    size: 'M',
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
    size: 'S',
    sky: 0xffb4a2,
    killY: -10,
    boxes,
    spawns: [at(-12, -12), at(12, 12), at(-12, 0), at(12, 0), at(0, -12), at(0, 12), at(-6, 0), at(6, 0)],
    items: [at(0, 0), at(-12, 6), at(12, -6), at(6, 12), at(-6, -12)],
  };
})();

// ---------- 5. Slop Factory: conveyor loop, piston lane over a slime trough, elevators to catwalks ----------
const factory = (() => {
  const F = 0x5c6370, W = 0x8d99ae, Y = 0xffc300, K = 0xc68b59, P = 0xe63946, M = 0x457b9d;
  const crate = (x, z, h, w = 2) => box(x, z, w, 2, 0, h, 'solid', K);
  return {
    name: 'Slop Factory',
    size: 'M',
    sky: 0x3d3b4f,
    killY: -20,
    boxes: [
      box(0, 0, 56, 56, -1, 1, 'solid', F),
      ...walls(28, 10, W),
      box(0, -26.5, 56, 3, 4.6, 0.4, 'solid', Y), // catwalks, top 5
      box(0, 26.5, 56, 3, 4.6, 0.4, 'solid', Y),
      box(-26.5, 0, 3, 56, 4.6, 0.4, 'solid', Y),
      box(26.5, 0, 3, 56, 4.6, 0.4, 'solid', Y),
      lift(-23.5, 0, 5, 7, 0), // elevators up to the side catwalks
      lift(23.5, 0, 5, 7, 0.5),
      ...loop(10, 3, 0, 0.15, 4), // conveyor loop around the machine
      box(0, 0, 6, 6, 0, 3, 'solid', M), // machine, top 3
      ...stairs(0, 3, 0, 1, 3, 3, M),
      pad(-5.5, 0),
      // piston lane: belt runs east past pistons that shove you across into the slime
      belt(0, 17.5, 44, 3, 0, 0.15, [3, 0]),
      ...[-15, -5, 5, 15].map((x, i) => moving(box(x, 13.5, 4, 2, 0, 1.6, 'solid', P), [0, 0, 5.3], 3.2, i * 0.25)),
      box(0, 20.8, 40, 2, 0, 0.1, 'lava'),
      // launch belts: ride north onto a pad that throws you up to the catwalk
      belt(-18, -16, 3, 12, 0, 0.15, [0, -4]), pad(-18, -23),
      belt(18, -16, 3, 12, 0, 0.15, [0, -4]), pad(18, -23),
      crate(-8, -23.5, 1.2), crate(-6, -23.5, 2.4), crate(-4, -23.5, 3.6), // climb to the north catwalk
      crate(-12, -18, 1.2), crate(12, -18, 1.2), crate(0, -18, 2.4, 4),
      crate(-24, 8, 1.2), crate(24, -8, 1.2), crate(-24, -6, 2.4), crate(24, 6, 2.4),
    ],
    spawns: [[-18, 0, -6], [18, 0, 6], [-18, 0, 6], [18, 0, -6], [0, 0, -6], [6, 0, 0], [-6, 0, -18], [6, 0, -18], [-22, 0, -14], [22, 0, -14]],
    items: [[0, 3, 0], [0, 5, -26.5], [0, 5, 26.5], [0, 0, 23.5], [-12, 1.2, -18], [24, 0, 14], [-24, 0, 14], [26.5, 5, -14]],
  };
})();

// ---------- 6. Disco Drop: blinking dance floor over the void ----------
const disco = (() => {
  const SAFE = 0xf8f8ff, colors = [0xff3cac, 0x2bd2ff, 0xfff35c, 0x7cff6b, 0xa45cff, 0xff9f1c];
  const spawnTiles = ['0,0', '0,8', '8,0', '8,8', '0,4', '4,0', '8,4', '4,8'];
  const boxes = [];
  for (let i = 0; i < 9; i++) {
    for (let j = 0; j < 9; j++) {
      const x = (i - 4) * 4;
      const z = (j - 4) * 4;
      const ring = Math.max(Math.abs(i - 4), Math.abs(j - 4));
      if (ring <= 1 || spawnTiles.includes(`${i},${j}`)) {
        boxes.push(box(x, z, 4, 4, -0.5, 0.5, 'solid', SAFE)); // white tiles never blink
        continue;
      }
      const tile = box(x, z, 4, 4, -0.5, 0.5, 'solid', colors[(i + j * 2) % colors.length]);
      if (ring === 2) boxes.push(blinking(tile, 5, 0.6, ((i + j) % 2) * 0.5)); // checkerboard
      else if (ring === 3) boxes.push(blinking(tile, 12, 0.7, Math.atan2(z, x) / (Math.PI * 2) + 0.5)); // radar sweep
      else boxes.push(blinking(tile, 8, 0.7, j / 9)); // rows sweeping
    }
  }
  return {
    name: 'Disco Drop',
    size: 'M',
    sky: 0x1b0f3b,
    killY: -15,
    boxes: [
      ...boxes,
      box(0, 0, 4, 2, 0, 1.2, 'solid', 0x222244), // DJ booth
      pad(4, 4),
      box(10, 10, 4, 4, 5.6, 0.4, 'solid', SAFE), // floating stage, top 6
      box(27, 0, 4, 4, -0.5, 0.5, 'solid', SAFE), // outer islands, reached by ferry
      box(-27, 0, 4, 4, -0.5, 0.5, 'solid', SAFE),
      moving(box(19.5, 0, 3, 3, -0.5, 0.5, 'solid', 0xff3cac), [4, 0, 0], 6),
      moving(box(-19.5, 0, 3, 3, -0.5, 0.5, 'solid', 0x2bd2ff), [-4, 0, 0], 6, 0.5),
    ],
    spawns: [[-16, 0, -16], [-16, 0, 16], [16, 0, -16], [16, 0, 16], [-16, 0, 0], [0, 0, -16], [16, 0, 0], [0, 0, 16]],
    items: [[0, 1.2, 0], [-4, 0, 4], [4, 0, -4], [27, 0, 0], [-27, 0, 0], [10, 6, 10]],
  };
})();

// ---------- 7. Slop City: big city blocks, rooftops, elevators, conveyor highway ----------
const city = (() => {
  const R = 0x575d6b, W = 0x3d405b, colors = [0xe07a5f, 0x3d5a80, 0x98c1d9, 0xf2cc8f, 0x81b29a, 0xb5838d, 0xffb4a2, 0x6d597a];
  const bld = (x, z, w, d, h, c) => box(x, z, w, d, 0, h, 'solid', colors[c]);
  return {
    name: 'Slop City',
    size: 'L',
    sky: 0xa8dadc,
    killY: -20,
    boxes: [
      box(0, 0, 120, 120, -1, 1, 'solid', R),
      ...walls(60, 8, W),
      // towers, top 16, with an elevator each
      bld(0, -48, 10, 10, 16, 7), lift(-6.5, -48, 16, 12, 0),
      bld(0, 48, 10, 10, 16, 7), lift(6.5, 48, 16, 12, 0.5),
      // tall blocks, top 12, elevators facing the plaza
      bld(-48, 0, 14, 14, 12, 1), lift(-39.5, 0, 12, 10, 0),
      bld(48, 0, 14, 14, 12, 1), lift(39.5, 0, 12, 10, 0.5),
      // plaza neighbors, top 4.2, stairs from the plaza
      bld(-24, 0, 14, 14, 4.2, 3), ...stairs(-17, 0, 1, 0, 4.2, 3, colors[3]),
      bld(24, 0, 14, 14, 4.2, 3), ...stairs(17, 0, -1, 0, 4.2, 3, colors[3]),
      box(0, 0, 6, 6, 0, 0.6, 'solid', 0x98c1d9), pad(0, 0, 0.6), // fountain
      box(0, -24, 4, 4, 0, 2.4, 'solid', 0xf4a261), box(0, 24, 4, 4, 0, 2.4, 'solid', 0xf4a261), // kiosks
      ...corners((sx, sz) => [
        // outer rows: two roofs at 7.2 joined by a sky bridge, pad up from the street
        bld(sx * 48, sz * 48, 14, 14, 7.2, 0), bld(sx * 24, sz * 48, 14, 14, 7.2, 4),
        box(sx * 36, sz * 48, 10, 3, 6.8, 0.4, 'solid', 0xffffff), pad(sx * 14, sz * 48),
        // side blocks, top 4.8, stairs from the street
        bld(sx * 48, sz * 24, 14, 14, 4.8, 2), ...stairs(sx * 41, sz * 24, -sx, 0, 4.8, 3, colors[2]),
        // two buildings split by a hiding alley; pad to the low roof, roof pad to the high one
        bld(sx * 20, sz * 24, 6, 14, 6, 5), bld(sx * 28, sz * 24, 6, 14, 9.6, 6),
        pad(sx * 14, sz * 24), pad(sx * 20, sz * 28, 6),
      ]),
      // two-lane conveyor highway
      belt(0, 34.5, 112, 3, 0, 0.15, [6, 0]),
      belt(0, 37.5, 112, 3, 0, 0.15, [-6, 0]),
    ],
    spawns: [
      [12, 0, 12], [-12, 0, 12], [12, 0, -12], [-12, 0, -12], [36, 0, 12], [-36, 0, 12], [36, 0, -12], [-36, 0, -12],
      [12, 0, -36], [-12, 0, -36], [36, 0, -36], [-36, 0, -36], [12, 0, 40], [-12, 0, 40], [36, 0, 40], [-36, 0, 40],
    ],
    items: [
      [0, 16, -48], [0, 16, 48], [-48, 12, 0], [48, 12, 0], [8, 0, 8], [-8, 0, -8], [24, 0, 24], [-24, 0, -24],
      [24, 7.2, -48], [-24, 7.2, 48], [48, 7.2, 48], [-48, 7.2, -48], [48, 4.8, -24], [-48, 4.8, 24],
    ],
  };
})();

// ---------- 8. Splash Park: lava river with ferries, rising lava pool, coaster ring, bouncy castle ----------
const park = (() => {
  const G = 0x7bd389, F = 0xf6f1d1, C = 0xff006e, T = 0x5e60ce, S = 0xc9ada7, P = 0xff8fab, Q = 0xffc8dd;
  return {
    name: 'Splash Park',
    size: 'L',
    sky: 0x9bf6ff,
    killY: -20,
    boxes: [
      box(0, -28.5, 100, 43, -1, 1, 'solid', G), // north and south lawns
      box(0, 28.5, 100, 43, -1, 1, 'solid', G),
      box(0, 0, 100, 14, -3, 2.4, 'lava'), // river, top -0.6
      ...walls(50, 4, F),
      box(-32, 0, 4, 14, -0.5, 0.5, 'solid', S), box(32, 0, 4, 14, -0.5, 0.5, 'solid', S), // bridges
      ...[-16, 0, 16].map((x, i) => moving(box(x, -5, 4, 4, -0.5, 0.5, 'solid', 0xffbe0b), [0, 0, 10], 7, i / 3)), // ferries
      // lava pool: level rises over the stepping stones, the center pillar stays dry
      box(-28, -35.5, 16, 1, 0, 0.6, 'solid', S), box(-28, -20.5, 16, 1, 0, 0.6, 'solid', S),
      box(-35.5, -28, 1, 14, 0, 0.6, 'solid', S), box(-20.5, -28, 1, 14, 0, 0.6, 'solid', S),
      moving(box(-28, -28, 14, 14, -1.4, 1.6, 'lava'), [0, 1.2, 0], 10),
      box(-32, -28, 2, 2, 0, 0.9, 'solid', S), box(-24, -28, 2, 2, 0, 0.9, 'solid', S),
      box(-28, -32, 2, 2, 0, 0.9, 'solid', S), box(-28, -24, 2, 2, 0, 0.9, 'solid', S),
      box(-28, -28, 2, 2, 0, 2, 'solid', Q),
      // drop tower with an elevator, top 14
      box(28, -28, 6, 6, 0, 14, 'solid', T), lift(23.5, -28, 14, 12, 0),
      // bouncy castle: pads everywhere, turrets on the corners
      box(-28, 28, 14, 14, 0, 0.6, 'solid', P),
      ...[-32, -28, -24].flatMap((x) => [24, 28, 32].map((z) => pad(x, z, 0.6))),
      ...[[-34, 22], [-22, 22], [-34, 34], [-22, 34]].map(([x, z]) => box(x, z, 2, 2, 0.6, 4, 'solid', Q)),
      // coaster: raised conveyor ring, top 3, stairs up from the lawns
      ...loop(40, 3, 2.6, 0.4, 7, C),
      ...corners((sx, sz) => [box(sx * 40, sz * 40, 1, 1, 0, 2.6, 'solid', F)]),
      ...stairs(0, 38.5, 0, -1, 3, 3, F), ...stairs(0, -38.5, 0, 1, 3, 3, F),
      // picnic tables
      ...corners((sx, sz) => [box(28 + sx * 4, 28 + sz * 4, 3, 1.2, 0, 0.8, 'solid', 0xb08968)]),
    ],
    spawns: [
      [-10, 0, -15], [10, 0, -15], [0, 0, -26], [-14, 0, -32], [14, 0, -32], [-28, 0, -14], [28, 0, -14], [-45, 0, -20],
      [-10, 0, 15], [10, 0, 15], [0, 0, 26], [-14, 0, 32], [14, 0, 32], [28, 0, 16], [-28, 0, 14], [45, 0, 20],
    ],
    items: [
      [-28, 2, -28], [28, 14, -28], [-34, 4.6, 34], [-22, 4.6, 22], [40, 3, 0], [-40, 3, 0],
      [32, 0, 0], [-32, 0, 0], [28, 0, 28], [0, 0, -14], [0, 0, 14], [-30, 0.6, 26],
    ],
  };
})();

export const MAPS = { castle, sky, maze, lava, factory, disco, city, park };
export const MAP_IDS = Object.keys(MAPS);

const BLINK_WARN = 0.75; // seconds of `warn` before a blinking box switches off

// Private mutable copy of a map (each room / client gets its own so dynamic boxes don't clash).
export function instantiate(id) {
  const map = structuredClone(MAPS[id]);
  for (const b of map.boxes) if (b.move || b.blink) b.base = { min: [...b.min], max: [...b.max] };
  setMapTime(map, 0);
  return map;
}

// Updates dynamic boxes in place for map time t (seconds): min/max, dv (velocity, for carrying riders),
// off (blinked out: ignore for collision), warn (about to blink out: render flashing).
export function setMapTime(map, t) {
  for (const b of map.boxes) {
    if (b.move) {
      const { to, period, phase = 0 } = b.move;
      const a = 2 * Math.PI * (t / period + phase);
      const k = (1 - Math.cos(a)) / 2;
      const dk = (Math.PI / period) * Math.sin(a);
      for (let i = 0; i < 3; i++) {
        b.min[i] = b.base.min[i] + to[i] * k;
        b.max[i] = b.base.max[i] + to[i] * k;
      }
      b.dv = [to[0] * dk, to[1] * dk, to[2] * dk];
    }
    if (b.blink) {
      const { period, on, phase = 0 } = b.blink;
      const f = (((t / period + phase) % 1) + 1) % 1;
      b.off = f >= on;
      b.warn = !b.off && (on - f) * period < BLINK_WARN;
    }
  }
}
