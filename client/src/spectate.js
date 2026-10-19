// Spectator auto director: picks the most interesting player to follow. That's an IT closing in on someone or
// with the fuse about to blow, or whoever was just in a tag / boom / shot / knockoff. It holds every shot at
// least HOLD ms, and longer while its player is in the middle of something, so the camera doesn't jump around.

const HOLD = 3000; // ms before cutting to someone else
const BUSY = 2000; // ms: and not while the one we follow just had a moment (e.g. still flying from a boom)
const URGENT = 3; // s: or holds a bomb about to blow
const COOL = 4000; // ms for an event's heat to fade
// event -> heat for the players it names. fell: only the knocker (the faller just respawned somewhere boring)
const HEAT = { tag: 10, boom: 9, fell: 7, bonk: 6, blast: 5, pop: 5, slip: 4, shot: 3, warp: 3, use: 2 };

export class Director {
  constructor() {
    this.heat = new Map(); // id -> { v, at }
    this.id = null; // who we follow
    this.since = 0; // when we cut to them
  }

  // e: server `ev` message
  event(e, now) {
    const v = HEAT[e.k];
    if (!v) return;
    const ids = e.k === 'fell' ? [e.by] : [e.a, e.b, e.id, e.hit];
    for (const id of ids) if (id != null) this.heat.set(id, { v: Math.max(v, this.heatOf(id, now)), at: now });
  }

  heatOf(id, now) {
    const h = this.heat.get(id);
    return h ? h.v * Math.max(0, 1 - (now - h.at) / COOL) : 0;
  }

  // views: the room's placed PlayerViews; fuse(v): that IT's bomb seconds left. Returns the id to follow, or null.
  pick(views, now, fuse) {
    const its = views.filter((v) => v.state.it);
    const runners = views.filter((v) => !v.state.it);
    const nearest = (v, list) => Math.min(Infinity, ...list.filter((o) => o !== v).map((o) => o.root.position.distanceTo(v.root.position)));
    let best = null;
    let bestScore = -Infinity;
    for (const v of views) {
      let s = this.heatOf(v.id, now);
      if (v.state.it) s += 3 + 6 * Math.max(0, 1 - nearest(v, runners) / 12) + 8 * Math.max(0, 1 - (fuse(v) ?? 99) / 4);
      else s += 4 * Math.max(0, 1 - nearest(v, its) / 10);
      if (!v.root.visible) s -= 6; // ghosts can't be seen
      if (v.id === this.id) s += 2; // a bit sticky
      if (s > bestScore) [best, bestScore] = [v, s];
    }
    if (!best) return (this.id = null);
    const cur = views.find((v) => v.id === this.id);
    const busy = now - (this.heat.get(this.id)?.at ?? -Infinity) < BUSY || (cur?.state.it && (fuse(cur) ?? 99) < URGENT);
    if (best.id !== this.id && (!cur || (now - this.since >= HOLD && !busy))) {
      this.id = best.id;
      this.since = now;
    }
    return this.id;
  }
}
