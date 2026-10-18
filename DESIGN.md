# FriendSlop — design + protocol

Chaotic 3D multiplayer tag for 2–16 friends in the browser. Built to be wrapped as a desktop/Steam app later, so:
real game flow (menu → lobby → match → results), settings, pause menu, no dev-only hacks in the client.
Keep code simple (YAGNI). Plain JS modules, no TypeScript, no frameworks besides three.js on the client and ws on the server.

## Layout

```
shared/   config.js (tunables) maps.js (map data) items.js chaos.js  ← contract, used by both sides
server/   index.js (http + ws + vite dev middleware), room.js (rooms + game rules)
client/   index.html, src/*.js, public/assets/ (assets.json manifest, models/, sfx/)
```

- `npm run dev` → `node server/index.js` on PORT 3000. In dev it mounts Vite in middleware mode (HMR) on the same http server; in production (`NODE_ENV=production`) it serves `dist/` statically. WebSocket lives at path `/ws` (only upgrade requests to `/ws` go to ws; leave others for Vite HMR).
- `npm run build` → `dist/`. `npm start` → production server.
- Client connects to `import.meta.env.VITE_SERVER_URL || (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'` so a packaged desktop build can point at a hosted server.

## Rules (hot-potato tag)

Phases: `lobby` → `countdown` → `play` → `results` → `lobby`.


- Lobby: everyone spawns on the host-selected map and can run around; no tagging, items still spawn (fun warm-up). Host picks map, game settings (enabled items, round length from ROUND_TIMES, chaos on/off), adds bots, clicks Start (≥1 player; solo allowed for testing).
- Countdown (COUNTDOWN s): everyone teleported to spawns and frozen. bombCount(players) random players become IT, each with their own BOMB and random fuse in BOMB_FUSE (1 bomb up to 6 players, 2 for 7–12, 3 for 13–16). Everything below applies per bomb; an IT can't tag another IT.
- Play (ROUND_TIME s):
  - Not-IT players earn +1 point per second. IT earns nothing.
  - IT touches someone (horizontal dist < TAG_DIST × chaos scale, vertical < TAG_HEIGHT) → they become IT, tagger gets +TAG_BONUS. New IT frozen IT_STUN s and can't tag their tagger back for NO_TAGBACK s. Bomb fuse is NOT reset — it passes along.
  - Shielded player touched by IT: shield pops, no tag, IT gets knocked back.
  - Fuse hits 0 → BOOM: IT loses BOMB_PENALTY points and is launched into the air; a random non-IT player becomes the new IT with a fresh fuse.
  - Every CHAOS_EVERY s (if chaos is on) a random chaos event (shared/chaos.js) is announced; `mods` last CHAOS_DURATION s. Instant ones: swap (shuffle positions), rain (everyone gets a random item, all boxes respawn).
  - Mystery boxes at map `items` spots. Walk into one while empty-handed → random enabled item (by weight). Box respawns after ITEM_RESPAWN s. No items enabled → no boxes.
  - Falling below map.killY or touching a lava box → client respawns itself at a random spawn and sends `fell`. During play: −FALL_PENALTY, and whoever last knocked/froze/slipped/swapped/magneted you within KNOCKOFF_WINDOW s gets +KNOCKOFF_BONUS (a "knockoff").
- Results (RESULTS_TIME s): everyone moved to a spawn (winner on their own) and item effects/leftovers cleared so nobody falls mid-celebration; scoreboard, winner dances, fun awards from per-player stats (most tags, most knockoffs, clumsiest = most falls, most booms). Then back to lobby automatically.

## Controls

WASD move (camera-relative), mouse look (pointer lock), Space jump (double jump in air), Shift or Right Click dive (forward lunge, MOVE.diveCooldown), E or Left Click use item / shoot, V toggle first/third person (saved in settings), F dance/taunt (anim `dance` while held or for ~2s), Tab scoreboard, Esc pause menu.

## Guns

Knockback/stun guns, no damage, from ? boxes (shared/items.js, `gun: true`). Aim = camera forward. Server shoots from player feet + PLAYER.eye × chaos scale.
- Boom Blaster: hitscan, knocks target along shot dir (force) + up.
- Freeze Ray: hitscan, freezes target.
- Rocket Launcher: server-simulated projectile (speed, life). Explodes on box/player/timeout: radial knockback within radius to everyone INCLUDING the shooter (rocket jumps).
Hitscan and rockets stop at map boxes. Player hitbox for shots: AABB radius 0.5, height PLAYER.height × scale.

## Items (shared/items.js)

Non-gun: boots (speed fx), banana (peel behind, slips), glove (punch in front), swap (random swap), ghost (invisible), freeze (radius freeze), spring (launch up), shield (blocks one tag),
balloon (fx float: gravity × item.gravity for duration, balloon over head), mushroom (fx flag giant: scale × item.scale for duration → bigger tag reach; a giant non-IT touching anyone knocks them away, per-victim cooldown 0.6 s),
wall (temporary solid box item.size [width, height, thickness], item.dist behind you, perpendicular to your facing (axis-aligned by dominant axis), bottom at your feet; lasts duration; everyone collides with it),
stink (cloud at your feet for duration; anyone else within radius gets fx dizzy (reversed controls, refreshed while inside)),
fuse (every active bomb's fuse −cut s, min 1 s), magnet (everyone within radius knocked toward you: dir × force + up).
Aimed (`gun: true`, aim = camera forward, ammo + cooldown): blaster, freezeray, rocket (see Guns), grapple (hitscan vs map boxes only within range; on hit, knock yourself toward the hit point: dir × force + up; ev shot draws a rope), pearl (projectile with gravity; on box/player hit or life end, teleport the thrower to a safe spot at the impact point; ev warp).

## Dynamic + big maps

Maps may have moving boxes (`move`), blinking boxes (`blink`) and `conveyor` boxes (see shared/maps.js header). Server and every client keep a private copy (`instantiate(id)`) and call `setMapTime(map, t)` with the shared map time `mt` before physics/raycasts. Map time starts at 0 when the room (re)loads a map; the server sends `mt` in every snap and clients run their own clock that follows it.
Physics (shared/physics.js Mover): ignores `off` boxes everywhere; riders on a moving box are carried by its `dv`; standing on a conveyor adds its `push`; a moving box that overlaps a player pushes them out; teleport never leaves the player inside a box.
Size L maps are built for 9–16 players (16 spawns, more ? boxes). Spawns are reused if there are more players than spawns.

## Bots

Host adds/removes bots in the lobby. Bots are normal players (count toward MAX_PLAYERS, score, can be IT) with no socket. The server simulates them with shared/physics.js `Mover` (same movement as humans) and simple AI: IT → chase nearest catchable player; else flee IT, grab ? boxes when safe, use items/guns sensibly, avoid ledges/lava, jump gaps and obstacles, use bounce pads to reach higher targets. Slightly worse than a good human (speed ×0.92, aim error, reaction delay). Server applies fx to bots directly. Bots also use the new items, avoid `off`/`warn` blinking boxes and lava, ride platforms/conveyors (physics does it), and play the dynamic/big maps.

## Movement (client-authoritative)

Each client simulates its own player with shared/config.js MOVE and the map boxes:
player is an AABB (PLAYER.radius × 2 wide, PLAYER.height tall), feet position = player position. Per-axis sweep vs map boxes, step-up ≤ MOVE.stepHeight when grounded.
Landing on `bounce` top → vy = MOVE.bounce (× sqrt of gravity mod is fine). On `ice` top → friction/accel × 0.1. Touch `lava` → respawn. fx float → gravity × balloon gravity. fx dizzy → reversed input.
Chaos mods multiply gravity/speed/friction/accel; `autoBounce` → jump automatically on landing; `reverse` → invert move input; `scale` only affects visuals + server tag range (collision box unchanged); `dark` → client lighting.

## Protocol (JSON over WebSocket, every message has `t`)

Client → server:
| msg | when |
|---|---|
| `{t:'join', name, color, code?}` | first message. No/unknown-empty code → create room. color is a hex number |
| `{t:'map', map}` | host, lobby only |
| `{t:'start'}` | host, lobby only |
| `{t:'s', p:[x,y,z], ry, a, tp}` | own state at SEND_RATE. `a` = anim: idle/run/jump/fall/dive/slip/dance. `tp` = last teleport seq received (see fx tp) |
| `{t:'use', dir:[x,y,z]}` | use held item / fire gun. `dir` = unit camera-forward aim vector (required for guns) |
| `{t:'bot', add}` | host, lobby only. add=true adds a bot (if room not full), false removes the newest bot |
| `{t:'settings', items:[ids], round, chaos}` | host, lobby only. items = enabled item ids (subset of ITEM_IDS, may be empty), round ∈ ROUND_TIMES, chaos bool. Server sanitizes |
| `{t:'fell'}` | I just respawned after falling below killY / touching lava |

Server → client:
| msg | meaning |
|---|---|
| `{t:'joined', id, code}` | you joined room `code` as player `id` |
| `{t:'error', msg}` | e.g. room not found / full; client shows it and returns to menu |
| `{t:'room', code, host, map, phase, settings:{items,round,chaos}, players:[{id,name,color,bot}]}` | on any lobby/player/settings change. `bot` true for bots. Default settings: all items, ROUND_TIME, chaos true |
| `{t:'snap', phase, time, mt, chaos, players:[{id,p,ry,a,it,fuse,fx,score,item,ammo}], boxes:[bool], peels:[{id,p}], projectiles:[{id,p,item}], walls:[{id,min,max}], clouds:[{id,p}]}` | TICK_RATE. `time` = seconds left in phase. `mt` = map time (s). `chaos` = active chaos id or null. `fuse` = that IT's bomb seconds left, else null. `fx` = array of active flags: ghost, shield, frozen, boost, slip, float, giant, dizzy. projectiles = rockets + pearls in flight (item = 'rocket'/'pearl'). walls = active pop-up walls (solid boxes for physics). clouds = active stink clouds. `item` = held item id or null. `ammo` = shots left for guns, else null. `boxes[i]` = map.items[i] box available |
| `{t:'fx', k, ...}` | to the affected player only. `k:'knock', v:[x,y,z]` add velocity. `k:'freeze', dur` no input. `k:'slip', dur` spin out, no input, keep sliding. `k:'boost', dur, speed`. `k:'float', dur`. `k:'dizzy', dur`. `k:'tp', p:[x,y,z], seq` set position + zero velocity, then echo `seq` as `tp` in state msgs (server ignores older state until echoed) |
| `{t:'ev', k, ...}` | to everyone, for juice/announcements/sfx. `k:'tag', a, b` (a tagged b) · `k:'boom', id` · `k:'chaos', id` · `k:'pickup', id, item` · `k:'use', id, item, p` · `k:'slip', id` · `k:'pop', id` (shield popped) · `k:'countdown', n` · `k:'go'` · `k:'shot', id, item, from:[x,y,z], to:[x,y,z], hit:id\|null` (every gun shot; for rockets `to` is null, rocket appears in snaps) · `k:'blast', p, id` (rocket exploded at p, id = shooter) · `k:'warp', id, p` (pearl teleport) · `k:'fell', id, by` (by = knockoff credit id or null; sent in lobby too, no scoring there) · `k:'bonk', a, b` (giant a knocked b) |
| `{t:'results', scores:[{id,name,color,score,bot,stats:{tags,knockoffs,falls,booms}}]}` | sorted desc, phase results |

Server is authoritative for: rooms, phases, timers, IT, tags, scores, items, peels, chaos, teleports. It never simulates movement — it uses the latest reported positions.
Room codes: 4 uppercase letters. Host leaves → next player becomes host. Empty room deleted.
