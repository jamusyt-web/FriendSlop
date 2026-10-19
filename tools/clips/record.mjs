// Records a bots match for clips: joins as a spectator host, picks the map + settings, adds bots, starts a round
// and saves every server message with its time (ms since connecting) to marketing/replays/<name>.json.
// The client plays it back with ?replay= (tools/clips/capture.mjs renders it to video). See README.md.
//
//   node tools/clips/record.mjs --name factory1 --map factory --bots 8
//     [--round 90|150|240] [--chaos 1|0] [--items all|none|boots,banana,...] [--lobby 1] [--duration <s>]
//     [--server ws://host:port/ws]   (default: starts its own server on a free port)
//
// Stops after the results (back in the lobby) or after --duration seconds.

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { MAP_IDS } from '../../shared/maps.js';
import { ITEM_IDS } from '../../shared/items.js';
import { ROUND_TIME, ROUND_TIMES, MAX_PLAYERS } from '../../shared/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const arg = (k, d) => (argv.includes('--' + k) ? argv[argv.indexOf('--' + k) + 1] : d);

const map = arg('map', 'factory');
const bots = Number(arg('bots', 8));
const round = Number(arg('round', 90));
const chaos = arg('chaos', '1') !== '0';
const itemsArg = arg('items', 'all');
const items = itemsArg === 'all' ? ITEM_IDS : itemsArg === 'none' ? [] : itemsArg.split(',');
const lobby = Number(arg('lobby', 1)); // s of lobby warm-up before the round starts
const duration = Number(arg('duration', 0)); // s, 0 = until the results are over
const name = arg('name', `${map}-${bots}bots-${Date.now().toString(36)}`);
const out = path.join(ROOT, 'marketing/replays', name + '.json');

const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};
if (!MAP_IDS.includes(map)) fail(`--map must be one of ${MAP_IDS.join(', ')}`);
if (!(bots >= 1 && bots <= MAX_PLAYERS)) fail(`--bots must be 1..${MAX_PLAYERS}`);
if (!ROUND_TIMES.includes(round)) fail(`--round must be one of ${ROUND_TIMES.join(', ')} (default game: ${ROUND_TIME})`);
const unknown = items.filter((id) => !ITEM_IDS.includes(id));
if (unknown.length) fail(`unknown items: ${unknown.join(', ')} (have ${ITEM_IDS.join(', ')})`);

// our own production server (no Vite needed for the socket) on a free port, unless --server is given
let server = null;
async function startServer() {
  const port = await new Promise((resolve) => {
    const s = net.createServer().listen(0, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
  server = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], { env: { ...process.env, NODE_ENV: 'production', PORT: String(port) } });
  server.stderr.pipe(process.stderr);
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => d.toString().includes('server:') && resolve());
    server.on('exit', () => reject(new Error('server exited')));
  });
  return `ws://127.0.0.1:${port}/ws`;
}
const stopServer = () => server?.kill();
process.on('SIGINT', () => {
  stopServer();
  process.exit(130);
});

const url = arg('server') || (await startServer());
const ws = new WebSocket(url);
const send = (m) => ws.send(JSON.stringify(m));
const msgs = [];
const timeline = []; // [s, text]: what happened when, to pick clip windows
let t0 = 0;
let room = null;
let started = false;
let sawResults = false;
const nameOf = (id) => room?.players.find((p) => p.id === id)?.name ?? `#${id}`;
const sec = () => Math.round(performance.now() - t0) / 1000;

function note(m) {
  if (m.t === 'results') return timeline.push([sec(), `RESULTS  winner ${m.scores[0]?.name}`]);
  if (m.t !== 'ev') return;
  const text = {
    go: () => 'GO',
    tag: () => `tag      ${nameOf(m.a)} -> ${nameOf(m.b)}`,
    boom: () => `BOOM     ${nameOf(m.id)}`,
    chaos: () => `chaos    ${m.id}`,
    fell: () => (m.by != null ? `knockoff ${nameOf(m.by)} knocked ${nameOf(m.id)} off` : `fell     ${nameOf(m.id)}`),
    bonk: () => `bonk     ${nameOf(m.a)} -> ${nameOf(m.b)}`,
    blast: () => `rocket   ${nameOf(m.id)}`,
    pop: () => `shield   ${nameOf(m.id)}`,
  }[m.k];
  if (text) timeline.push([sec(), text()]);
}

function finish() {
  ws.close();
  stopServer();
  const dur = sec();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const players = room?.players.map((p) => p.name) ?? [];
  fs.writeFileSync(out, JSON.stringify({ v: 1, name, map, bots, round, chaos, items, duration: dur, players, timeline, msgs }));
  for (const [t, text] of timeline) console.log(`${t.toFixed(1).padStart(7)}s  ${text}`);
  console.log(`\nplayers: ${players.join(', ')}`);
  console.log(`saved ${path.relative(process.cwd(), out)} (${msgs.length} messages, ${dur.toFixed(1)} s, ${(fs.statSync(out).size / 1e6).toFixed(1)} MB)`);
  process.exit(0);
}

ws.on('open', () => {
  t0 = performance.now();
  send({ t: 'join', name: 'Camera', spectate: true });
});
ws.on('error', (e) => {
  stopServer();
  fail(`can't connect to ${url}: ${e.message}`);
});
ws.on('message', (data) => {
  const m = JSON.parse(data);
  msgs.push([Math.round((performance.now() - t0) * 10) / 10, m]);
  note(m);
  if (m.t === 'error') {
    stopServer();
    fail(`server: ${m.msg}`);
  }
  if (m.t === 'joined') {
    // the server handles these in order, so it's all set up before `start`
    send({ t: 'map', map });
    send({ t: 'settings', items, round, chaos });
    for (let i = 0; i < bots; i++) send({ t: 'bot', add: true });
    console.log(`room ${m.code}: ${map}, ${bots} bots, ${round}s round, chaos ${chaos ? 'on' : 'off'}, ${items.length} items`);
    setTimeout(() => {
      started = true;
      send({ t: 'start' });
    }, lobby * 1000);
  }
  if (m.t === 'room') {
    room = m;
    if (m.phase === 'results') sawResults = true;
    if (started && sawResults && m.phase === 'lobby') setTimeout(finish, 500); // results are over
  }
  if (duration && sec() >= duration) finish();
});
