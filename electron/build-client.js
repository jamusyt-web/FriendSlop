// Builds the game client for the desktop app into dist-desktop/, pointed at the online server.
// Server address comes from the SERVER_URL env var. Your Render link works as-is:
//   https://friendslop.onrender.com  ->  wss://friendslop.onrender.com/ws
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'vite';

const DEFAULT = 'https://friendslop.onrender.com';
if (!process.env.SERVER_URL) console.warn(`\n  WARNING: SERVER_URL is not set, so this build uses ${DEFAULT}\n`);

let url = (process.env.SERVER_URL || DEFAULT).trim().replace(/^["']|["']$/g, '').replace(/\/+$/, '');
if (!/^[a-z]+:\/\//i.test(url)) url = 'https://' + url; // "friendslop.onrender.com" -> https://...
url = url.replace(/^http(s?):\/\//i, 'ws$1://');
if (!url.endsWith('/ws')) url += '/ws';
try {
  url = new URL(url).href; // also lowercases "HTTPS://Name.onrender.com"
  if (!/^wss?:$/.test(new URL(url).protocol)) throw new Error();
} catch {
  console.error(`SERVER_URL "${process.env.SERVER_URL}" is not a link. Use your Render link, like ${DEFAULT}`);
  process.exit(1);
}
process.env.VITE_SERVER_URL = url;
console.log(`Desktop build will connect to: ${url}`);

const root = path.join(import.meta.dirname, '..');
const out = path.join(root, 'dist-desktop');
await build({
  configFile: path.join(root, 'vite.config.js'),
  root: path.join(root, 'client'),
  build: { outDir: out, emptyOutDir: true },
  logLevel: 'warn',
});
fs.writeFileSync(path.join(out, 'server.txt'), url + '\n'); // electron/main.js only lets the game reach this server
console.log('Built dist-desktop/');
