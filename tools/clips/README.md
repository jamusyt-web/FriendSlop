# Clips: record matches, render them to video

Marketing footage (Steam page, trailers, TikTok / YouTube Shorts) straight from the game, rendered frame by frame so
it's perfectly smooth even on a machine without a GPU. Everything lands in `marketing/` (gitignored, never commit it).

1. **Record** a bots match as a replay: `record.mjs` joins as a spectator host, sets up the room, adds bots, plays a
   round and saves every server message with its time.
2. **Render** any part of it: `capture.mjs` plays the replay in headless Chromium with the game clock stopped and
   steps it one exact frame at a time, takes a screenshot per frame and encodes an H.264 MP4 with the game's own
   sound effects mixed in.

Needs: `npm install`, ffmpeg (with libx264 + aac), and Playwright with Chromium. Playwright is not a project
dependency: install it globally (`npm i -g playwright && npx playwright install chromium`) or point `PLAYWRIGHT` at an
existing install (`PLAYWRIGHT=/path/to/node_modules/playwright`). Without a GPU Chromium renders with SwiftShader.

## 1. Record

```sh
node tools/clips/record.mjs --name factory1 --map factory --bots 10
```

| option | default | |
|---|---|---|
| `--name` | `<map>-<bots>bots-<id>` | → `marketing/replays/<name>.json` |
| `--map` | `factory` | `castle sky maze lava factory disco city park` |
| `--bots` | `8` | 1–16. Bombs: 1 up to 6 players, 2 for 7–12, 3 for 13–16 |
| `--round` | `90` | 90, 150 or 240 s |
| `--chaos` | `1` | `0` turns chaos events off |
| `--items` | `all` | `none` or a list: `--items rocket,blaster,mushroom,balloon` |
| `--lobby` | `1` | seconds of lobby warm-up before the round starts |
| `--duration` | (whole round) | stop after this many seconds instead of after the results |
| `--server` | (own server) | record from a running server instead, e.g. `ws://localhost:3000/ws` |

It starts its own production server on a free port and stops it when done. At the end it prints a timeline
(`GO`, tags, BOOMs, chaos, knockoffs, rockets... with replay times) and the player names; both are also saved in the
replay JSON (`timeline`, `players`). Use them to pick clip windows and `--follow` names. A full 90 s round with
results is about 105 s of replay and a few MB.

## 2. Render

```sh
npm run build    # capture plays the built client from dist/ — rebuild after changing client code
node tools/clips/capture.mjs marketing/replays/factory1.json --start 20 --end 32 --nohud
```

| option | default | |
|---|---|---|
| `--start` / `--end` | whole replay | seconds of replay time |
| `--out` | `marketing/clips/<replay>-<start>-<end>[-follow][-fp].mp4` | |
| `--width` / `--height` | `1920` / `1080` | vertical for Shorts / TikTok: `--width 1080 --height 1920` |
| `--fps` | `60` | |
| `--follow` | `auto` | auto director, or a player's name: `--follow "Tater Tot"` |
| `--fp` | off | first person through the followed player's eyes (their gun viewmodel too) |
| `--nohud` | off | clean shot: no HUD, lobby or results panels |
| `--feed` | off | with `--nohud`: keep the kill feed |
| `--dist` | `1` | third-person camera distance multiplier: `0.7` for punchier, closer vertical shots |
| `--workers` | `2` | Chromium processes sharing the frames (1–3) |
| `--keep-frames` | off | keep the PNGs in `marketing/frames/<clip>/` (thumbnails / screenshots for the store page) |
| `--no-audio` | off | video only |

The auto director follows whoever is most interesting (an IT closing in, a bomb about to blow, whoever was just in a
tag / BOOM / shot / knockoff), holds every shot at least 3 s and flies the camera smoothly between players.

Watch a replay in real time in a browser first, to find good moments (same view options):

```sh
node tools/clips/capture.mjs marketing/replays/factory1.json --serve --nohud    # prints a localhost URL
```

In the browser: Click / Space cycles through the players (then back to the auto director), V toggles first person.

### Speed (4 CPUs, no GPU, SwiftShader)

| size | s / frame | 10 s clip @ 60 fps |
|---|---|---|
| 1280×720 | ~0.5–0.65 | ~5–6 min |
| 1920×1080 | ~1.2–1.3 | ~12–13 min |

Measured with 1 vs 2 workers: SwiftShader already uses every core, so a second Chromium only gains ~10% here; it
helps more on machines with more cores. Seeking to `--start` is cheap (the game is simulated without drawing, about
0.4 ms per frame). A 30 s 1080p trailer clip is roughly 35–40 minutes: start it and do something else.

### Why it's exact

`capture.mjs` loads `?replay=/replay.json&capture=1`. In capture mode the game has no animation loop; each frame is
`window.__capture.step(1 / fps)`: the game clock moves by exactly one frame, the recorded messages up to then are
delivered with their recorded times, the game updates and renders, and HUD CSS animations are advanced by the same
amount. `Math.random` is seeded per frame, so every worker plays the identical game: a frame rendered by any worker
is bit-identical (`--workers 1` and `--workers 3` produce the same video). Sounds go through the game's own
`audio.play` (gain by distance from the followed player, pan, pitch jitter) into a log that is mixed into the
soundtrack, so the audio matches what a player would have heard.

## Recipes

```sh
# a big chaotic match on a big map, 16 players = 3 bombs
node tools/clips/record.mjs --name city16 --map city --bots 16 --round 90
# vertical 1080x1920 short, clean, with kill feed
node tools/clips/capture.mjs marketing/replays/city16.json --start 30 --end 45 --width 1080 --height 1920 --nohud --feed --dist 0.7
# guns only: rockets + blasters, first person through one bot's eyes
node tools/clips/record.mjs --name guns --map castle --bots 8 --items rocket,blaster,freezeray,grapple
node tools/clips/capture.mjs marketing/replays/guns.json --start 15 --end 25 --follow Pickles --fp --nohud   # a name record.mjs printed
# store page screenshots: keep the frames and pick the best PNGs
node tools/clips/capture.mjs marketing/replays/factory1.json --start 40 --end 42 --nohud --keep-frames --no-audio
```
