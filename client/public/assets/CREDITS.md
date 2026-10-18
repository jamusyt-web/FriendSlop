# Asset credits

All third-party assets in this folder are by **Kenney** (www.kenney.nl), released under
**Creative Commons Zero (CC0 1.0)**: http://creativecommons.org/publicdomain/zero/1.0/
Credit is not required. We give it anyway: thanks, Kenney!

FriendSlop modified some of these files: re-scaled them, renamed or trimmed them, re-encoded them, and mixed some together. Those modified files are also released under CC0.

## Models

| File | Source pack | Source file | Changes |
|---|---|---|---|
| `models/character.glb` | Mini Characters 1.0, https://kenney.nl/assets/mini-characters | `Models/GLB format/character-male-c.glb` + `Textures/colormap.png` | Texture embedded. Scaled to 1.8 units tall, torso centred on the origin, facing +Z. Clips trimmed and renamed (idle, sprint→run, jump, fall, attack-melee-right→punch, die→hit). New `dive` and `dance` clips hand-keyed on the same rig. Cap and shirt split into a greyscale `tint` material. Tangents and UV1 removed. |
| `models/banana.glb` | Food Kit 2.0, https://kenney.nl/assets/food-kit | `Models/GLB format/banana.glb` + `Textures/colormap.png` | Texture embedded. Scaled to 0.5 units long, centred, sitting on y=0. Tangents removed. |

## Sound effects

Every sound is mono Ogg Vorbis at 44.1 kHz. Each one has its silence trimmed and its peak normalised to -1.5 dBFS.

| File | Source pack | Source file(s) |
|---|---|---|
| `sfx/jump.ogg` | Digital Audio, https://kenney.nl/assets/digital-audio | `phaseJump1.ogg` |
| `sfx/land.ogg` | Impact Sounds, https://kenney.nl/assets/impact-sounds | `impactSoft_medium_000.ogg` |
| `sfx/tag.ogg` | Impact Sounds + Digital Audio | `impactPunch_medium_000.ogg` mixed with `twoTone1.ogg` |
| `sfx/pickup.ogg` | Digital Audio | `powerUp2.ogg` |
| `sfx/use.ogg` | Digital Audio | `phaserUp1.ogg` |
| `sfx/punch.ogg` | Impact Sounds | `impactPunch_heavy_000.ogg` |
| `sfx/slip.ogg` | Digital Audio | `phaserDown1.ogg` |
| `sfx/boom.ogg` | Sci-fi Sounds, https://kenney.nl/assets/sci-fi-sounds | `explosionCrunch_000.ogg` |
| `sfx/beep.ogg` | Digital Audio | `tone1.ogg` |
| `sfx/go.ogg` | Voiceover Pack, https://kenney.nl/assets/voiceover-pack | `Male/go.ogg` |
| `sfx/whoosh.ogg` | RPG Audio, https://kenney.nl/assets/rpg-audio | `cloth1.ogg` |
| `sfx/freeze.ogg` | Interface Sounds, https://kenney.nl/assets/interface-sounds + Impact Sounds | `glass_001.ogg` mixed with `impactGlass_light_000.ogg` |
| `sfx/bounce.ogg` | Digital Audio | `highUp.ogg` |
| `sfx/win.ogg` | Music Jingles, https://kenney.nl/assets/music-jingles | `Steel jingles/jingles_STEEL10.ogg` |
| `sfx/shoot.ogg` | Sci-fi Sounds | `laserRetro_000.ogg` |
| `sfx/rocket.ogg` | Sci-fi Sounds | `laserLarge_000.ogg` mixed with the first 0.8 s of `thrusterFire_000.ogg` (faded out) |
