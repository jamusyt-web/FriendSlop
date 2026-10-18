# FriendSlop

Chaotic 3D hot-potato tag for 2–8 friends. Browser game, Node server.

- Hold the bomb when it blows = bad. Tag someone to pass it.
- Mystery boxes give items (boots, banana, boxing glove, swap ray, ghost, freeze bomb, spring, bubble).
- Chaos event every 22s (low gravity, ice, giants, lights out, swapparoo...).
- 4 maps: Bounce Castle, Sky Slop, Crate Maze, Floor Is Lava.

## Run

```
npm install
npm run dev          # http://localhost:3000
```

Friends on same network open `http://<your-ip>:3000`. Create room, share 4-letter code.

## Host online

One always-on server on Render. Click-by-click steps are in [HOSTING.md](HOSTING.md) (`render.yaml` + `Dockerfile`).
The same Dockerfile runs on Fly.io, Railway, or any VPS. To run production locally: `npm run build && npm start`
(the host sets `PORT`).

## Desktop / Steam

The Electron app in `electron/` loads the client from `dist-desktop/` and connects to the hosted server:

```
npm run desktop                                         # build + run locally
SERVER_URL=https://friendslop.onrender.com npm run dist:win    # -> release/win-unpacked/FriendSlop.exe
SERVER_URL=https://friendslop.onrender.com npm run dist:linux  # -> release/linux-unpacked/friendslop
```

Steamworks setup, SteamPipe upload scripts (`steam/`) and store page checklist: [STEAM.md](STEAM.md).

## Controls

WASD move · mouse look · Space jump (double) · Shift / right click dive · E / left click use item · Tab scores · Esc pause

See DESIGN.md for rules + protocol. Assets: Kenney (CC0), see client/public/assets/CREDITS.md.
