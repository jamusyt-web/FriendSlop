// FriendSlop desktop app (Electron) for Steam. One window that shows the client built into dist-desktop/
// (npm run build:desktop). Pages load from app://friendslop/ so absolute paths like /assets/... and
// /fonts/... resolve inside dist-desktop/. The client talks to the hosted server baked in at build time
// (also written to dist-desktop/server.txt so this file can allow it through the network lock below).
// Electron allows pointer lock + fullscreen by default, so the game's mouse look just works.

import { app, BrowserWindow, Menu, net, protocol, screen, session, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.join(import.meta.dirname, '..', 'dist-desktop');
const HOME = 'app://friendslop/';

let serverHost = null; // e.g. friendslop.onrender.com
try {
  const url = fs.readFileSync(path.join(ROOT, 'server.txt'), 'utf8').trim();
  serverHost = new URL(url).host;
  console.log('[friendslop] game server', url);
} catch {
  console.error('[friendslop] dist-desktop/server.txt missing: run npm run build:desktop');
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);
Menu.setApplicationMenu(null);

// app://friendslop/some/file -> absolute path inside dist-desktop/, or null (missing / outside the folder).
function fileFor(url) {
  let rel;
  try {
    rel = decodeURIComponent(new URL(url).pathname);
  } catch {
    return null;
  }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT + path.sep)) return null;
  try {
    return fs.statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

function createWindow() {
  // 1280x720, but never bigger than the screen (a 1080p laptop at 150% zoom only has about 1280x680 free).
  const free = screen.getPrimaryDisplay().workAreaSize;
  const win = new BrowserWindow({
    title: 'FriendSlop',
    width: Math.min(1280, free.width),
    height: Math.min(720, free.height),
    minWidth: 800,
    minHeight: 450,
    backgroundColor: '#8fd3ff',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }, // Electron's safe defaults, spelled out
  });
  const web = win.webContents;

  // Links to websites open in the player's browser, never inside the game window.
  const openOutside = (url) => /^https?:\/\//.test(url) && shell.openExternal(url);
  web.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: 'deny' };
  });
  web.on('will-navigate', (e) => {
    if (e.url.startsWith(HOME)) return;
    e.preventDefault();
    openOutside(e.url);
  });

  // F11 toggles fullscreen.
  web.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') {
      e.preventDefault();
      win.setFullScreen(!win.isFullScreen());
    }
  });

  // Logs go to the terminal (handy when a player reports a problem).
  web.on('did-finish-load', () => console.log('[friendslop] loaded', web.getURL()));
  web.on('did-fail-load', (_e, code, desc, url) => console.error('[friendslop] load failed', code, desc, url));
  web.on('console-message', (e) => {
    if (e.level === 'error') console.error('[page]', e.message);
  });

  win.loadURL(HOME);
}

app.whenReady().then(() => {
  protocol.handle('app', (req) => {
    const file = fileFor(req.url);
    if (!file) {
      console.error('[friendslop] not found', req.url);
      return new Response('Not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(file).toString());
  });

  // Network lock: the game window may only reach the game server. Any other http(s)/ws(s) request is blocked.
  session.defaultSession.webRequest.onBeforeRequest((details, done) => {
    const url = new URL(details.url);
    const blocked = /^(https?|wss?):$/.test(url.protocol) && url.host !== serverHost;
    if (blocked) console.error('[friendslop] blocked', details.url);
    done({ cancel: blocked });
  });

  createWindow();
});

app.on('window-all-closed', () => app.quit());
