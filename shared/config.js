// Tunables shared by client and server. Units: meters, seconds.

export const PORT = 3000;
export const TICK_RATE = 20; // server sim + snapshot Hz
export const SEND_RATE = 20; // client -> server state Hz
export const MAX_PLAYERS = 16;

export const COUNTDOWN = 3;
export const ROUND_TIME = 150; // default; host can pick any of ROUND_TIMES
export const ROUND_TIMES = [90, 150, 240];
export const RESULTS_TIME = 10;

export const TAG_DIST = 1.4; // horizontal center distance, multiplied by chaos scale
export const TAG_HEIGHT = 1.8; // max vertical center distance
export const NO_TAGBACK = 2; // new IT can't tag the one who tagged them for this long
export const IT_STUN = 1.2; // new IT is frozen this long
export const TAG_BONUS = 3; // points for tagging someone
export const BOMB_FUSE = [18, 32]; // random fuse range; passed with the tag, not reset
export const BOMB_PENALTY = 10;
export const bombCount = (players) => (players >= 13 ? 3 : players >= 7 ? 2 : 1); // bombs in play for big groups

export const FALL_PENALTY = 5; // falling off the map / into lava during play
export const KNOCKOFF_BONUS = 3; // to whoever knocked/froze/swapped you within KNOCKOFF_WINDOW s before the fall
export const KNOCKOFF_WINDOW = 5;

export const CHAOS_EVERY = 22; // seconds between chaos events
export const CHAOS_DURATION = 10;

export const ITEM_RESPAWN = 8;
export const PICKUP_DIST = 1.5;
export const PEEL_DIST = 1.0;

export const PLAYER = { radius: 0.4, height: 1.8, eye: 1.5 }; // eye: first-person camera + gun origin height

export const MOVE = {
  speed: 9,
  accel: 70,
  airAccel: 25,
  friction: 12,
  gravity: 30,
  jump: 10.5, // also used for the double jump
  diveSpeed: 17,
  diveUp: 4,
  diveCooldown: 1.2,
  stepHeight: 0.6,
  bounce: 22, // bounce pad launch speed
};
