// Following the car on the locked route (core/routelock.js, stored with the route): where along it the car is
// (s, metres along the path), its official mileage there (from the steps' places, so the rallymaster's odometer
// is matched step by step), and whether it has left the route.
//
// Each GPS fix is put on the path near where the car was last (within reach of how far it can have gone), so a
// road the route uses twice, or passes close to, doesn't throw it. Off the route: more than OFF_M from the path
// for OFF_S seconds while moving; back on: within ON_M of the path again, going the route's way.

const OFF_M = 40, ON_M = 25, OFF_S = 5, REACH_M = 400;

export class RouteTracker {
  // lock: { path: { ll: [[lat, lon]], cum: [m] }, rows: [{ n, D, s }] }
  constructor(lock) {
    const ll = lock.path.ll;
    this.lat0 = ll.reduce((a, p) => a + p[0], 0) / ll.length;
    this.lon0 = ll.reduce((a, p) => a + p[1], 0) / ll.length;
    this.kx = 111320 * Math.cos(this.lat0 * Math.PI / 180); this.ky = 110540;
    this.pts = ll.map(([la, lo]) => this.toLocal(la, lo));
    this.cum = lock.path.cum;
    this.len = this.cum[this.cum.length - 1] ?? 0;
    // Official miles against path metres: the rows' places, in order (a reset odometer is already in D).
    this.anchors = lock.rows.filter((r) => Number.isFinite(r.D) && Number.isFinite(r.s)).map((r) => ({ s: r.s, D: r.D })).sort((a, b) => a.s - b.s || a.D - b.D);
    this.s = null; this.t = null; this.dist = null; this.on = true; this.offSince = null; this.leftAt = null;
    this.lastOnS = null;   // the last place the car was clearly on the route: where it left, when it goes off
  }
  toLocal(lat, lon) { return [(lon - this.lon0) * this.kx, (lat - this.lat0) * this.ky]; }

  // Official miles at path distance s, and back.
  D(s) { return interp(this.anchors, s, 's', 'D'); }
  sOf(D) { return interp(this.anchors, D, 'D', 's'); }

  // The nearest point on the path to (x, y) for s in [lo, hi]: { s, d, k } (k: segment, heading of the path there).
  nearest(x, y, lo = 0, hi = Infinity) {
    const { pts, cum } = this;
    let best = null;
    for (let k = 0; k + 1 < pts.length; k++) {
      if (cum[k + 1] < lo || cum[k] > hi) continue;
      const [ax, ay] = pts[k], [bx, by] = pts[k + 1], dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)) : 0;
      const d = Math.hypot(x - ax - t * dx, y - ay - t * dy), s = cum[k] + t * (cum[k + 1] - cum[k]);
      if (s < lo - 1 || s > hi + 1) continue;
      if (!best || d < best.d) best = { s, d, k, head: Math.atan2(dx, dy) * 180 / Math.PI };
    }
    return best;
  }

  // A GPS fix: t seconds, lat/lon, speed m/s, heading degrees or null. sHint: where the app thinks the car is
  // (path metres), used before the first fix and after a long gap. Returns { s, d, on, left } (left: just went off).
  update({ t, lat, lon, speed = 0, heading = null }, sHint = null) {
    const [x, y] = this.toLocal(lat, lon);
    const gap = this.t === null ? Infinity : Math.max(0, t - this.t);
    const base = this.s ?? sHint;
    // Within reach of the last place (how far the car can have gone, plus GPS error); else the whole path.
    const reach = base === null || gap > 60 ? Infinity : REACH_M + 45 * gap;
    let m = this.nearest(x, y, base === null ? 0 : base - Math.min(reach, 150), base === null ? Infinity : base + reach);
    if (!m || (m.d > OFF_M && reach !== Infinity)) { const all = this.nearest(x, y); if (all && (!m || all.d < m.d - 30)) m = all; }
    this.t = t;
    if (!m) return { s: this.s, d: null, on: this.on, left: false };
    const along = heading === null || speed < 2 || Math.cos((heading - m.head) * Math.PI / 180) > -0.3;   // not driving the route backwards
    let left = false;
    if (m.d <= ON_M && along) {
      this.on = true; this.offSince = null; this.s = m.s; this.lastOnS = m.s;
    } else if (m.d > OFF_M && speed > 2) {
      this.offSince ??= t;
      if (this.on && t - this.offSince >= OFF_S) { this.on = false; this.leftAt = this.lastOnS ?? this.s; this.s = this.leftAt; left = true; }
    } else if (this.on) this.s = m.s;   // between ON and OFF: still on, a poor fix
    this.dist = m.d;
    return { s: this.s, d: m.d, on: this.on, left };
  }
}

// Piecewise-linear lookup in sorted anchors (by key a), giving key b; extrapolated past the ends at the last slope.
function interp(an, v, a, b) {
  if (!an.length) return null;
  if (an.length === 1) return an[0][b];
  let i = 0;
  while (i + 2 < an.length && an[i + 1][a] <= v) i++;
  const p = an[i], q = an[i + 1], span = q[a] - p[a];
  if (span <= 0) return v <= p[a] ? p[b] : q[b];
  return p[b] + (v - p[a]) / span * (q[b] - p[b]);
}
