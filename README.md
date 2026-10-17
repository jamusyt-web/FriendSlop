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

## Play over internet

```
npm run build && npm start
```

Deploy to any Node host (Render, Fly, Railway): build command `npm install && npm run build`, start command `npm start`. Host sets `PORT`.

## Controls

WASD move · mouse look · Space jump (double) · Shift / right click dive · E / left click use item · Tab scores · Esc pause

See DESIGN.md for rules + protocol. Assets: Kenney (CC0), see client/public/assets/CREDITS.md.
