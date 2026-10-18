// Player profile + settings, persisted in localStorage.

export const COLORS = [0xff5a5f, 0xff9f1c, 0xffd60a, 0x5ce65c, 0x2ec4ff, 0x5b6cff, 0xb15cff, 0xff70c8];

const KEY = 'friendslop.prefs.v1';
const NAMES = ['Noodle', 'Gremlin', 'Bean', 'Wobbler', 'Goober', 'Sploot', 'Pickle', 'Blorp', 'Dingus', 'Toast'];
const pick = (a) => a[Math.floor(Math.random() * a.length)];

const defaults = () => ({
  name: pick(NAMES) + Math.floor(Math.random() * 90 + 10),
  color: pick(COLORS),
  sensitivity: 1,
  invertY: false,
  fov: 75,
  firstPerson: false,
  volume: 0.7,
});

function load() {
  try {
    return { ...defaults(), ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return defaults();
  }
}

export const prefs = load();

export function savePrefs() {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // storage may be unavailable (private mode); settings just won't persist
  }
}
