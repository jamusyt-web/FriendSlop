// HTTP + WebSocket entry point.
// Dev: Vite in middleware mode (HMR on the same http server). Production: serves dist/ statically.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { PORT as DEFAULT_PORT } from '../shared/config.js';
import { handleConnection } from './room.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const PORT = Number(process.env.PORT) || DEFAULT_PORT;
const PROD = process.env.NODE_ENV === 'production';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

// Resolves a URL path to a file inside DIST, or null if missing / outside DIST.
function resolveStatic(urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (rel.includes('\0')) return null;
  const file = path.join(DIST, path.normalize(rel));
  if (file !== DIST && !file.startsWith(DIST + path.sep)) return null;
  try {
    return fs.statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

function sendFile(req, res, file) {
  const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

function serveStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    return res.end();
  }
  const pathname = (req.url || '/').split('?')[0]; // not new URL(): it throws on malformed targets
  // SPA fallback for routes, but a missing asset (has an extension) is a real 404
  const file = resolveStatic(pathname) || (path.extname(pathname) ? null : resolveStatic('/index.html'));
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  sendFile(req, res, file);
}

async function main() {
  const server = http.createServer();

  if (PROD) {
    server.on('request', serveStatic);
  } else {
    const { createServer } = await import('vite');
    const vite = await createServer({
      configFile: path.join(ROOT, 'vite.config.js'),
      root: path.join(ROOT, 'client'), // same as vite.config.js, but independent of cwd
      server: { middlewareMode: true, hmr: { server } },
      appType: 'spa',
    });
    server.on('request', (req, res) => {
      try {
        vite.middlewares(req, res);
      } catch {
        res.writeHead(400); // its URL parser throws on malformed targets like `http://[`
        res.end();
      }
    });
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 });
  wss.on('connection', (ws) => {
    ws.alive = true;
    ws.on('pong', () => (ws.alive = true));
    handleConnection(ws);
  });
  // Drop dead connections (closed laptop, lost wifi) so they don't linger in rooms.
  setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) ws.terminate();
      else {
        ws.alive = false;
        ws.ping();
      }
    }
  }, 15000);
  server.on('upgrade', (req, socket, head) => {
    if ((req.url || '').split('?')[0] === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } else if (PROD) {
      socket.destroy(); // in dev, Vite HMR handles its own upgrades
    }
  });

  server.listen(PORT, () => {
    console.log(`FriendSlop ${PROD ? 'production' : 'dev'} server: http://localhost:${PORT}  (ws: /ws)`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
