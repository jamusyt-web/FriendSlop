// DOM UI: menu, settings, lobby panel, HUD, scoreboard, results, pause, toasts.
// main.js owns game state and calls into here; button presses go back through the `on` handlers.
import { MAPS, MAP_IDS } from '../../shared/maps.js';
import { ITEMS } from '../../shared/items.js';
import { COLORS, prefs, savePrefs } from './prefs.js';

const $ = (id) => document.getElementById(id);
const hex = (c) => '#' + (c >>> 0).toString(16).padStart(6, '0');
export const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
export const nameHtml = (p) => (p ? `<b style="color:${hex(p.color)}">${esc(p.name)}</b>` : '<b>???</b>');

const TITLE_COLORS = ['#ffd23f', '#ff4fa3', '#2ee6ff', '#8cff5a', '#ff8c3a', '#b98cff'];
let on = {};

export function initUI(handlers) {
  on = handlers;

  // title letters
  $('title').innerHTML = [...'FriendSlop']
    .map((ch, i) => `<span style="color:${TITLE_COLORS[i % TITLE_COLORS.length]};animation-delay:${i * 0.09}s">${ch}</span>`)
    .join('');

  // name
  const nameInput = $('name-input');
  nameInput.value = prefs.name;
  nameInput.addEventListener('input', () => {
    prefs.name = nameInput.value.trim().slice(0, 16);
    savePrefs();
  });
  nameInput.addEventListener('blur', () => {
    if (!nameInput.value.trim()) nameInput.value = prefs.name = 'Slopper' + Math.floor(Math.random() * 90 + 10);
    savePrefs();
  });

  // color swatches
  const sw = $('swatches');
  sw.innerHTML = COLORS.map((c) => `<button class="swatch" data-c="${c}" style="background:${hex(c)}" aria-label="color"></button>`).join('');
  const markSwatch = () => sw.querySelectorAll('.swatch').forEach((b) => b.classList.toggle('selected', +b.dataset.c === prefs.color));
  markSwatch();
  sw.addEventListener('click', (e) => {
    const b = e.target.closest('.swatch');
    if (!b) return;
    prefs.color = +b.dataset.c;
    savePrefs();
    markSwatch();
    on.color?.(prefs.color);
  });

  // create / join
  const code = $('code-input');
  const validCode = () => /^[A-Z]{4}$/.test(code.value);
  const syncJoin = () => ($('btn-join').disabled = !validCode());
  code.addEventListener('input', () => {
    code.value = code.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
    syncJoin();
  });
  code.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && validCode()) on.join(code.value);
  });
  syncJoin();
  $('btn-create').onclick = () => on.create();
  $('btn-join').onclick = () => validCode() && on.join(code.value);
  $('btn-cancel-connect').onclick = () => on.leave();

  // settings
  $('btn-menu-settings').onclick = () => openSettings();
  $('btn-pause-settings').onclick = () => openSettings();
  $('btn-settings-back').onclick = () => $('settings').classList.add('hidden');
  const bindRange = (id, key, label, fmt) => {
    const el = $(id);
    el.value = prefs[key];
    const show = () => ($(label).textContent = fmt(prefs[key]));
    show();
    el.addEventListener('input', () => {
      prefs[key] = +el.value;
      show();
      savePrefs();
      on.settings();
    });
  };
  bindRange('set-sens', 'sensitivity', 'sens-val', (v) => v.toFixed(2) + '×');
  bindRange('set-fov', 'fov', 'fov-val', (v) => v + '°');
  bindRange('set-vol', 'volume', 'vol-val', (v) => Math.round(v * 100) + '%');
  const inv = $('set-invert');
  inv.checked = prefs.invertY;
  inv.onchange = () => {
    prefs.invertY = inv.checked;
    savePrefs();
  };
  const fs = $('set-fullscreen');
  fs.onchange = () => {
    if (fs.checked) document.documentElement.requestFullscreen?.().catch(() => (fs.checked = false));
    else if (document.fullscreenElement) document.exitFullscreen();
  };
  document.addEventListener('fullscreenchange', () => (fs.checked = !!document.fullscreenElement));

  // lobby
  $('room-code').onclick = () => {
    const text = $('room-code').textContent;
    navigator.clipboard?.writeText(text).then(
      () => toast(`Copied ${text} — send it to your friends!`),
      () => toast(`Room code: ${text}`),
    );
  };
  $('btn-start').onclick = () => on.start();
  $('btn-lobby-menu').onclick = () => on.pause();
  $('map-list').innerHTML = MAP_IDS.map(
    (id) => {
      const c = MAPS[id].sky;
      const dark = ((c >> 16) & 255) * 0.3 + ((c >> 8) & 255) * 0.59 + (c & 255) * 0.11 < 110;
      return `<button class="map-card${dark ? ' dark' : ''}" data-map="${id}" style="background:${hex(c)}">${esc(MAPS[id].name)}</button>`;
    },
  ).join('');
  $('map-list').addEventListener('click', (e) => {
    const b = e.target.closest('.map-card');
    if (b && !b.disabled) on.map(b.dataset.map);
  });

  // pause
  $('btn-resume').onclick = () => on.resume();
  $('btn-leave').onclick = () => on.leave();
}

function openSettings() {
  $('settings').classList.remove('hidden');
}

// ---------- screens ----------
const SCREENS = ['loading', 'menu', 'connecting'];
export function showScreen(name) {
  for (const s of SCREENS) $(s).classList.toggle('hidden', s !== name);
  const inGame = name === 'game';
  $('hud').classList.toggle('hidden', !inGame);
  if (!inGame) {
    $('lobby').classList.add('hidden');
    $('results').classList.add('hidden');
    $('pause').classList.add('hidden');
  }
}

export function setLoading(p) {
  $('load-fill').style.width = Math.round(p * 100) + '%';
}

export function setConnectingText(t) {
  $('connecting-text').textContent = t;
}

export function isOverlayOpen() {
  return !$('pause').classList.contains('hidden') || !$('settings').classList.contains('hidden');
}
export function settingsOpen() {
  return !$('settings').classList.contains('hidden');
}
export function closeSettings() {
  $('settings').classList.add('hidden');
}
export function showPause(v) {
  $('pause').classList.toggle('hidden', !v);
  if (!v) closeSettings();
}

export function toast(msg, error = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (error ? ' error' : '');
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.classList.add('out'), 3200);
  setTimeout(() => el.remove(), 3700);
}

// ---------- lobby ----------
export function showLobby(v) {
  $('lobby').classList.toggle('hidden', !v);
}

export function updateLobby(room, myId) {
  $('room-code').textContent = room.code || '----';
  const isHost = room.host === myId;
  $('player-count').textContent = `(${room.players.length})`;
  $('player-list').innerHTML = room.players
    .map(
      (p) => `<li><span class="dot" style="background:${hex(p.color)}"></span><span class="nm">${esc(p.name)}</span>` +
        `${p.id === myId ? '<span class="you">you</span>' : ''}${p.id === room.host ? '<span title="Host">👑</span>' : ''}</li>`,
    )
    .join('');
  $('map-list').querySelectorAll('.map-card').forEach((b) => {
    b.classList.toggle('selected', b.dataset.map === room.map);
    b.disabled = !isHost;
  });
  $('btn-start').classList.toggle('hidden', !isHost);
  $('wait-host').classList.toggle('hidden', isHost);
}

// ---------- HUD ----------
export function setMatchHud(v) {
  for (const id of ['score-box']) $(id).classList.toggle('hidden', !v);
  if (!v) {
    $('timer').classList.add('hidden');
    $('fuse').classList.add('hidden');
    $('it-label').classList.add('hidden');
    $('chaos-badge').classList.add('hidden');
    setYouAreIt(false);
  }
}

export function setTimer(sec) {
  const el = $('timer');
  if (sec == null) return el.classList.add('hidden');
  el.classList.remove('hidden');
  const s = Math.max(0, Math.ceil(sec));
  el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  el.classList.toggle('low', s <= 10);
}

export function setFuse(fuse, max) {
  const el = $('fuse');
  if (fuse == null) return el.classList.add('hidden');
  el.classList.remove('hidden');
  const f = Math.max(0, fuse);
  const frac = Math.max(0, Math.min(1, f / (max || 1)));
  el.querySelector('i').style.width = frac * 100 + '%';
  el.querySelector('.spark').style.left = frac * 100 + '%';
  el.querySelector('.fuse-num').textContent = f.toFixed(1);
  el.classList.toggle('hot', f < 5);
}

let lastIt = null;
export function setItLabel(p, isMe) {
  const el = $('it-label');
  const key = p && !isMe ? p.id + p.name : null;
  if (key === lastIt) return;
  lastIt = key;
  if (!key) return el.classList.add('hidden');
  el.classList.remove('hidden');
  el.innerHTML = `💣 ${esc(p.name)} is IT — run!`;
}

let youIt = false;
let bannerTimer = 0;
export function setYouAreIt(v) {
  const banner = $('it-banner');
  $('vignette').classList.toggle('it', v);
  if (v === youIt) return;
  youIt = v;
  clearTimeout(bannerTimer);
  banner.classList.toggle('hidden', !v);
  banner.classList.remove('small');
  if (v) {
    banner.style.animation = 'none';
    void banner.offsetWidth;
    banner.style.animation = '';
    bannerTimer = setTimeout(() => banner.classList.add('small'), 1800);
  }
}

export function setFrozenVignette(v) {
  $('vignette').classList.toggle('frozen', v && !youIt);
}

let lastScore = null;
export function setScore(n) {
  if (n === lastScore) return;
  const el = $('score');
  el.textContent = n;
  if (lastScore != null && n !== lastScore) {
    el.classList.remove('bump');
    void el.offsetWidth;
    el.classList.add('bump');
  }
  lastScore = n;
}

let lastItem;
export function setItem(id) {
  if (id === lastItem) return;
  lastItem = id;
  const el = $('item-slot');
  const item = id && ITEMS[id];
  el.classList.toggle('empty', !item);
  el.classList.toggle('full', !!item);
  el.querySelector('.item-icon').textContent = item ? item.icon : '';
  el.querySelector('.item-name').textContent = item ? item.name : 'No item — grab a ? box';
  if (item) {
    el.classList.remove('pop');
    void el.offsetWidth;
    el.classList.add('pop');
  }
}

export function setItemVisible(v) {
  $('item-slot').classList.toggle('hidden', !v);
}

export function feed(html, mine = false) {
  const box = $('killfeed');
  const el = document.createElement('div');
  el.className = 'feed' + (mine ? ' me' : '');
  el.innerHTML = html;
  box.prepend(el);
  while (box.children.length > 6) box.lastChild.remove();
  setTimeout(() => el.classList.add('fade'), 5000);
  setTimeout(() => el.remove(), 5600);
}

export function bigText(html, cls = '') {
  const box = $('big-text');
  box.innerHTML = `<div class="shout ${cls}">${html}</div>`;
}

export function chaosBadge(name, remaining, frac) {
  const el = $('chaos-badge');
  if (!name) return el.classList.add('hidden');
  el.classList.remove('hidden');
  el.querySelector('.chaos-name').textContent = '🌀 ' + name;
  el.querySelector('.chaos-time').textContent = remaining > 0 ? Math.ceil(remaining) + 's' : '';
  el.querySelector('.chaos-bar i').style.width = Math.max(0, Math.min(1, frac)) * 100 + '%';
}

export function setLockHint(v) {
  $('lock-hint').classList.toggle('hidden', !v);
}

export function setCrosshair(v) {
  $('crosshair').classList.toggle('hidden', !v);
}

function scoreRows(rows, myId, winner) {
  return rows
    .map(
      (r, i) =>
        `<li class="${r.id === myId ? 'me' : ''} ${r.it ? 'it' : ''} ${winner && i === 0 ? 'winner' : ''}">` +
        `<span class="rank">${winner && i === 0 ? '👑' : i + 1}</span><span class="dot" style="background:${hex(r.color)}"></span>` +
        `<span class="nm">${esc(r.name)}${r.it ? ' 💣' : ''}${r.id === myId ? ' <small>(you)</small>' : ''}</span><span class="pts">${r.score}</span></li>`,
    )
    .join('');
}

export function setScoreboard(visible, rows, myId) {
  $('scoreboard').classList.toggle('hidden', !visible);
  if (!visible) return;
  const list = $('scoreboard-list');
  list.className = 'score-list';
  list.innerHTML = scoreRows(rows, myId, false);
}

// ---------- results ----------
export function showResults(scores, myId) {
  $('results').classList.remove('hidden');
  const w = scores[0];
  $('winner-name').innerHTML = w ? `${esc(w.name)} wins!` : 'Nobody wins?!';
  const list = $('results-list');
  list.className = 'score-list';
  list.innerHTML = scoreRows(scores, myId, true);
}

export function hideResults() {
  $('results').classList.add('hidden');
}

export function setResultsTimer(sec) {
  $('results-timer').textContent = sec > 0 ? `Back to the lobby in ${Math.ceil(sec)}…` : 'Back to the lobby…';
}
