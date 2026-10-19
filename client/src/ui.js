// DOM UI: menu, settings, lobby panel (players, map, game settings), HUD, scoreboard, results + awards, pause, toasts.
// main.js owns game state and calls into here; button presses go back through the `on` handlers.
import { MAPS, MAP_IDS } from '../../shared/maps.js';
import { ITEMS, ITEM_IDS } from '../../shared/items.js';
import { MAX_PLAYERS, ROUND_TIME, ROUND_TIMES } from '../../shared/config.js';
import { COLORS, prefs, savePrefs } from './prefs.js';

const $ = (id) => document.getElementById(id);
const hex = (c) => '#' + (c >>> 0).toString(16).padStart(6, '0');
export const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
// on the dark HUD: very dark player colors are lifted toward white so the name stays readable
const light = (c) => {
  const [r, g, b] = [(c >> 16) & 255, (c >> 8) & 255, c & 255];
  const k = r * 0.3 + g * 0.59 + b * 0.11 < 90 ? 0.55 : 0;
  return ((r + (255 - r) * k) << 16) | ((g + (255 - g) * k) << 8) | (b + (255 - b) * k);
};
export const nameHtml = (p) => (p ? `<b style="color:${hex(light(p.color))}">${esc(p.name)}</b>` : '<b>???</b>');

const TITLE_COLORS = ['#ffd23f', '#ff4fa3', '#2ee6ff', '#8cff5a', '#ff8c3a', '#b98cff'];
const DEFAULT_SETTINGS = { items: ITEM_IDS, round: ROUND_TIME, chaos: true };
const SIZE_HINT = { S: 'Small map', M: 'Medium map', L: 'Big map for 9–16 players' };
const VERB = { grapple: 'to grapple', pearl: 'to throw' }; // other guns: shoot
const AWARDS = [ // [stat, icon, title, singular, plural]
  ['tags', '👉', 'Tag Master', 'tag', 'tags'],
  ['knockoffs', '🥊', 'Knockout King', 'knockoff', 'knockoffs'],
  ['falls', '🤕', 'Clumsiest', 'fall', 'falls'],
  ['booms', '💥', 'Boom Magnet', 'boom', 'booms'],
];
const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const settingsOf = (room) => room?.settings || DEFAULT_SETTINGS;
const sameSettings = (a, b) => a.items.join() === b.items.join() && a.round === b.round && a.chaos === b.chaos;
let on = {};
let lobbyRoom = null;
let lobbyHost = false;
let pending = null; // host: settings sent but not echoed back yet (older room messages must not undo quick clicks)
let itemsOff = false;

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
  const syncJoin = () => ($('btn-join').disabled = $('btn-watch').disabled = !validCode());
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
  $('btn-watch').onclick = () => validCode() && on.watch(code.value);
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
  const fp = $('set-fp');
  fp.onchange = () => {
    prefs.firstPerson = fp.checked;
    savePrefs();
    on.settings();
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
  $('btn-bot-add').onclick = () => on.bot(true);
  $('btn-bot-del').onclick = () => on.bot(false);
  $('btn-lobby-menu').onclick = () => on.pause();
  $('map-list').innerHTML = MAP_IDS.map((id) => {
    const map = MAPS[id];
    const c = map.sky;
    const dark = ((c >> 16) & 255) * 0.3 + ((c >> 8) & 255) * 0.59 + (c & 255) * 0.11 < 110;
    const size = map.size || 'M';
    const moving = map.boxes.some((b) => b.move || b.blink || b.push);
    return `<button class="map-card${dark ? ' dark' : ''}" data-map="${id}" style="background:${hex(c)}" title="${SIZE_HINT[size]}${moving ? ' · moving parts' : ''}">` +
      `<span class="map-size size-${size}">${size}</span>${moving ? '<span class="map-dyn">MOVING</span>' : ''}` +
      `${esc(map.name)}${size === 'L' ? '<small>9–16 players</small>' : ''}</button>`;
  }).join('');
  $('map-list').addEventListener('click', (e) => {
    const b = e.target.closest('.map-card');
    if (b && !b.disabled) on.map(b.dataset.map);
  });

  // game settings: the host edits, everyone else sees them read-only
  $('item-chips').innerHTML = ITEM_IDS.map((id) => {
    const it = ITEMS[id];
    return `<button class="chip" data-item="${id}" title="${esc(it.desc)}"><span>${it.icon}</span>${esc(it.name)}</button>`;
  }).join('');
  $('round-pick').innerHTML = ROUND_TIMES.map((t) => `<button class="seg-btn" data-round="${t}">${mmss(t)}</button>`).join('');
  const change = (patch) => {
    if (!lobbyRoom || !lobbyHost) return;
    pending = { ...(pending || settingsOf(lobbyRoom)), ...patch }; // show it now, the server's room message confirms
    renderSettings(pending);
    on.gameSettings(pending);
  };
  $('item-chips').addEventListener('click', (e) => {
    const id = e.target.closest('.chip')?.dataset.item;
    if (!id) return;
    const items = (pending || settingsOf(lobbyRoom)).items;
    change({ items: items.includes(id) ? items.filter((i) => i !== id) : ITEM_IDS.filter((i) => i === id || items.includes(i)) });
  });
  $('items-all').onclick = () => change({ items: [...ITEM_IDS] });
  $('items-none').onclick = () => change({ items: [] });
  $('round-pick').addEventListener('click', (e) => {
    const b = e.target.closest('.seg-btn');
    if (b) change({ round: +b.dataset.round });
  });
  $('chaos-toggle').onchange = () => change({ chaos: $('chaos-toggle').checked });

  // pause
  $('btn-resume').onclick = () => on.resume();
  $('btn-leave').onclick = () => on.leave();
}

function openSettings() {
  $('set-fp').checked = prefs.firstPerson; // V toggles it in game
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
        `${p.id === myId ? '<span class="you">you</span>' : ''}${p.bot ? '<span title="Bot">🤖</span>' : ''}${p.id === room.host ? '<span title="Host">👑</span>' : ''}</li>`,
    )
    .join('') + (room.spectators || [])
    .map(
      (p) => `<li class="spectator"><span title="Spectating">👀</span><span class="nm">${esc(p.name)}</span>` +
        `${p.id === myId ? '<span class="you">you</span>' : ''}${p.id === room.host ? '<span title="Host">👑</span>' : ''}</li>`,
    )
    .join('');
  $('map-list').querySelectorAll('.map-card').forEach((b) => {
    b.classList.toggle('selected', b.dataset.map === room.map);
    b.disabled = !isHost;
  });
  $('btn-start').classList.toggle('hidden', !isHost);
  $('btn-start').disabled = !room.players.length; // a spectating host needs someone to play (bots count)
  $('bot-row').classList.toggle('hidden', !isHost);
  $('btn-bot-add').disabled = room.players.length >= MAX_PLAYERS;
  $('btn-bot-del').disabled = !room.players.some((p) => p.bot);
  $('wait-host').classList.toggle('hidden', isHost);
  const st = settingsOf(room);
  if (!isHost || room.phase !== 'lobby' || room.code !== lobbyRoom?.code || (pending && sameSettings(st, pending))) pending = null;
  lobbyRoom = room;
  lobbyHost = isHost;
  renderSettings(pending || st);
}

function renderSettings(st) {
  $('item-chips').querySelectorAll('.chip').forEach((b) => {
    b.classList.toggle('on', st.items.includes(b.dataset.item));
    b.classList.toggle('ro', !lobbyHost); // not `disabled`: tooltips still work
  });
  $('item-count').textContent = `${st.items.length}/${ITEM_IDS.length}`;
  $('item-quick').classList.toggle('hidden', !lobbyHost);
  $('round-pick').querySelectorAll('.seg-btn').forEach((b) => {
    b.classList.toggle('on', +b.dataset.round === st.round);
    b.disabled = !lobbyHost;
  });
  $('chaos-toggle').checked = st.chaos;
  $('chaos-toggle').disabled = !lobbyHost;
  if (itemsOff !== !st.items.length) {
    itemsOff = !st.items.length;
    lastItem = undefined; // redraw the empty item slot
  }
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

// count: bombs in play (shown when there's more than one)
export function setFuse(fuse, max, count = 1) {
  const el = $('fuse');
  if (fuse == null) return el.classList.add('hidden');
  el.classList.remove('hidden');
  el.querySelector('.bomb-count').textContent = count > 1 ? '×' + count : '';
  const f = Math.max(0, fuse);
  const frac = Math.max(0, Math.min(1, f / (max || 1)));
  el.querySelector('i').style.width = frac * 100 + '%';
  el.querySelector('.spark').style.left = frac * 100 + '%';
  el.querySelector('.fuse-num').textContent = f.toFixed(1);
  el.classList.toggle('hot', f < 5);
}

// Short Fuse: the bar jumps
export function fuseCut() {
  restartAnim($('fuse'), 'cut');
}

// others: the other ITs (room player infos); isMe: you're IT too
let lastIt = null;
export function setItLabel(others, isMe) {
  const el = $('it-label');
  const key = others.length ? others.map((p) => p.id + p.name).join() + isMe : null;
  if (key === lastIt) return;
  lastIt = key;
  if (!key) return el.classList.add('hidden');
  el.classList.remove('hidden');
  const names = others.map((p) => esc(p.name));
  const who = names.length > 1 ? names.slice(0, -1).join(', ') + ' & ' + names[names.length - 1] : names[0];
  const are = names.length > 1 ? 'are' : 'is';
  el.innerHTML = isMe ? `💣 ${who} ${are} IT too` : `💣 ${who} ${are} IT — run!`;
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

export function setDizzyVignette(v) {
  $('vignette').classList.toggle('dizzy', v && !youIt);
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
let lastAmmo;
// ammo: shots left for guns
export function setItem(id, ammo = null) {
  if (id === lastItem && ammo === lastAmmo) return;
  const el = $('item-slot');
  const item = id && ITEMS[id];
  const ammoEl = el.querySelector('.item-ammo');
  ammoEl.textContent = item?.gun && ammo != null ? `${ammo}/${item.ammo}` : '';
  ammoEl.classList.toggle('low', ammo === 1);
  if (id === lastItem) {
    lastAmmo = ammo;
    return restartAnim(ammoEl, 'bump');
  }
  lastItem = id;
  lastAmmo = ammo;
  el.classList.toggle('empty', !item);
  el.classList.toggle('full', !!item);
  el.querySelector('.item-icon').textContent = item ? item.icon : '';
  el.querySelector('.item-label').textContent = item ? item.name : itemsOff ? 'Items are off' : 'No item — grab a ? box';
  el.querySelector('.item-verb').textContent = item?.gun ? VERB[id] || 'to shoot (hold for auto)' : 'to use';
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
  el.addEventListener('animationend', (e) => e.animationName === 'feedout' && el.remove()); // fades out after 5 s (CSS)
}

export function bigText(html, cls = '') {
  const box = $('big-text');
  box.innerHTML = `<div class="shout ${cls}">${html}</div>`;
}

// on leaving a room; otherwise the hidden HUD replays the last shout's animation when it's shown again
export function clearMessages() {
  $('big-text').innerHTML = '';
  $('killfeed').innerHTML = '';
}

export function chaosBadge(name, remaining, frac) {
  const el = $('chaos-badge');
  if (!name) return el.classList.add('hidden');
  el.classList.remove('hidden');
  el.querySelector('.chaos-name').textContent = '🌀 ' + name;
  el.querySelector('.chaos-time').textContent = remaining > 0 ? Math.ceil(remaining) + 's' : '';
  el.querySelector('.chaos-bar i').style.width = Math.max(0, Math.min(1, frac)) * 100 + '%';
}

// spectating: who the camera follows (p: room player info or null), auto: picked by the auto director
let lastSpectate = null;
export function setSpectating(p, auto) {
  const key = p ? p.id + p.name + auto : null;
  if (key === lastSpectate) return;
  lastSpectate = key;
  const el = $('spectate');
  el.classList.toggle('hidden', !p);
  if (p) el.innerHTML = `👀 SPECTATING ${nameHtml(p)}<small>${auto ? '🎬 auto · ' : ''}click / space: next player</small>`;
}

export function setLockHint(v) {
  $('lock-hint').classList.toggle('hidden', !v);
}

// gun: held gun id (bigger, colored reticle) or null (dot)
export function setCrosshair(v, gun = null) {
  const el = $('crosshair');
  el.classList.toggle('hidden', !v);
  el.classList.toggle('gun', !!gun);
  if (gun) el.dataset.gun = gun;
}

export function crosshairKick() {
  restartAnim($('crosshair'), 'kick');
}

// own shot hit someone
export function hitMarker() {
  restartAnim($('hitmarker'), 'show');
}

function restartAnim(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

function scoreRows(rows, myId, winner) {
  return rows
    .map(
      (r, i) =>
        `<li class="${r.id === myId ? 'me' : ''} ${r.it ? 'it' : ''} ${winner && i === 0 ? 'winner' : ''}">` +
        `<span class="rank">${winner && i === 0 ? '👑' : i + 1}</span><span class="dot" style="background:${hex(r.color)}"></span>` +
        `<span class="nm">${esc(r.name)}${r.bot ? ' 🤖' : ''}${r.it ? ' 💣' : ''}${r.id === myId ? ' <small>(you)</small>' : ''}</span><span class="pts">${r.score}</span></li>`,
    )
    .join('');
}

export function setScoreboard(visible, rows, myId) {
  $('scoreboard').classList.toggle('hidden', !visible);
  if (!visible) return;
  const list = $('scoreboard-list');
  list.className = 'score-list' + (rows.length > 8 ? ' compact' : '');
  list.innerHTML = scoreRows(rows, myId, false);
}

// ---------- results ----------
export function showResults(scores, myId) {
  $('results').classList.remove('hidden');
  const w = scores[0];
  $('winner-name').innerHTML = w ? `${esc(w.name)} wins!` : 'Nobody wins?!';
  const list = $('results-list');
  list.className = 'score-list' + (scores.length > 8 ? ' compact' : '');
  list.innerHTML = scoreRows(scores, myId, true);

  // fun awards from the round's stats (the first, i.e. highest scoring, wins ties)
  const awards = AWARDS.map(([key, icon, title, one, many], i) => {
    let best = null;
    for (const r of scores) if ((r.stats?.[key] ?? 0) > (best?.stats[key] ?? 0)) best = r;
    if (!best) return '';
    const n = best.stats[key];
    return `<div class="award" style="animation-delay:${0.4 + i * 0.15}s"><span class="award-icon">${icon}</span><span class="award-title">${title}</span>` +
      `<span class="award-who"><span class="dot" style="background:${hex(best.color)}"></span>${esc(best.name)}</span><small>${n} ${n === 1 ? one : many}</small></div>`;
  }).join('');
  $('awards').innerHTML = awards;
  $('awards').classList.toggle('hidden', !awards);
}

export function hideResults() {
  $('results').classList.add('hidden');
}

export function setResultsTimer(sec) {
  $('results-timer').textContent = sec > 0 ? `Back to the lobby in ${Math.ceil(sec)}…` : 'Back to the lobby…';
}
