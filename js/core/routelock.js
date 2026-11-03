// Route lock: the whole rally route worked out on the road map at import, so every step has a place (map
// metres and GPS) and the drive can then be followed by position instead of by odometer alone.
//
// A beam search over the instructions' turns. From the start, each line of the beam follows the main road;
// at each turn the junctions that fit its mileage, direction and road name (routeproj.turnCandidates) each
// carry the line on, and a turn that fits nowhere costs the line dearly. The best few lines are kept after
// every turn, so a later turn that fits nowhere can overrule an earlier near-tie. Mileage is measured from
// the last turn made, scaled by the line's own map-miles per official mile so far (the rallymaster's odometer
// against the map), so errors don't add up along the route.
//
// Result: the path (local metres, with distance along it), each step's place on it, and flags where the
// map doesn't settle a turn (a weak fit, or another line about as good turning elsewhere) for the crew, or
// Claude with map tools, to look at.

import { branches, walk, traverse, plen, forks, turnCandidates, turnName, arrive } from './routeproj.js';
import { roadKey, roadKeys, nearestRoad } from './mapview.js';

const M_PER_MI = 1609.344;
export const LOCK_V = 2;   // the stored lock's shape: an older one is worked out again (2: flagged turns' choices and misreads)
const BEAM = 8;          // lines kept after each turn
const PER_TURN = 4;      // junctions tried per line at each turn
const MIN_SCORE = 0.12;  // as routeproj: a junction scoring lower doesn't count as the turn
const WIDE = 0.6;        // found only out to twice the window
const MISS = 0.03;       // a turn no junction fits: the line goes on along the main road, trusted much less
const FLAG_SCORE = 0.5;  // a turn scoring under this is flagged
const RIVAL = Math.log(4);   // another line within this (log score) that turns elsewhere flags the turn
const RELAX_MILES = 0.25, RELAX_DIR = 0.15;   // a turn found only with its mileage, or direction, taken as misread

const LEAD = /^(?:AT\s+THE\s+END\s+OF|END\s+OF|FROM|ON|AT|BEGIN\s+AT|START\s+AT|START\s+ON)\s+/;
const DIRS = { R: 'R', RIGHT: 'R', L: 'L', LEFT: 'L', BR: 'BR', BL: 'BL', S: 'S', SO: 'S', STRAIGHT: 'S' };

// The start, from the first line's words: "At the end of GATEWAY AVENUE, R onto DORMAN ROAD" is the junction
// where those two roads meet, leaving along the second. Returns { c, P, from, onto } or null.
export function findStart(g, text, near = null) {
  const u = String(text ?? '').toUpperCase().replace(/["“”]/g, '');
  const m = u.match(/^(.*?),?\s+(RIGHT|LEFT|BR|BL|R|L|S|SO|STRAIGHT)\s+(?:ONTO|ON|TO)\s+(.+?)(?:[.;]|$)/);
  if (!m) return null;
  const fromKey = roadKey(m[1].replace(LEAD, '')), ontoKey = roadKey(m[3]), dir = DIRS[m[2]], end = /END\s+OF/.test(m[1]);
  if (!fromKey || !ontoKey) return null;
  const roads = g.map.roads, best = { score: 0 };
  for (let i = 0; i < roads.length; i++) {
    if (!roadKeys(roads[i]).includes(fromKey)) continue;
    for (const fwd of [true, false]) {   // arriving along road i at its far end
      const v = fwd ? g.rb[i] : g.ra[i], hin = arrive(g, i, fwd);
      const bs = branches(g, v, i, fwd, hin);
      // "At the end of": the road doesn't go on there.
      if (end && bs.some((b) => roadKeys(roads[b.road]).includes(fromKey))) continue;
      for (const b of bs) {
        if (!roadKeys(roads[b.road]).includes(ontoKey)) continue;
        const fit = dir === 'R' ? (b.a > 30 && b.a < 150 ? 1 : 0.2) : dir === 'L' ? (b.a < -30 && b.a > -150 ? 1 : 0.2) : 1;
        // Two junctions of those names (another town): the one nearer the tablet, when its position is known.
        const d = near ? Math.hypot(g.vx[v] - near.x, g.vy[v] - near.y) : 0;
        if (fit > best.score || (fit === best.score && d < best.d)) Object.assign(best, { score: fit, v, b, d });
      }
    }
  }
  if (!best.b) return null;
  const P = { pts: [[g.vx[best.v], g.vy[best.v]]], cum: [0] };
  const c = traverse(g, P, best.b.road, best.b.fwd, [ontoKey]);
  return { c, P, from: fromKey, onto: ontoKey };
}

// The start from a position (local metres) and, if known, a heading: the car on its road, whichever way
// along it the first turns fit better is decided by the search (both ways start a line).
export function startsAt(g, x, y, headingDeg = null) {
  const snap = nearestRoad(g.map, x, y, headingDeg, 60);
  if (!snap) return [];
  const out = [];
  for (const fwd of [true, false]) {
    const xy = g.map.roads[snap.i].xy, k = snap.k;
    const ax = xy[k], ay = xy[k + 1], dx = xy[k + 2] - ax, dy = xy[k + 3] - ay, L2 = dx * dx + dy * dy;
    const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)) : 0;
    const P = { pts: [[ax + t * dx, ay + t * dy]], cum: [0] };
    const n = xy.length;
    if (fwd) for (let j = k + 2; j < n; j += 2) pushPt(P, xy[j], xy[j + 1]);
    else for (let j = k; j >= 0; j -= 2) pushPt(P, xy[j], xy[j + 1]);
    if (headingDeg !== null) {
      const seg = Math.atan2(dx, dy) * 180 / Math.PI, along = Math.cos((headingDeg - seg) * Math.PI / 180) >= 0;
      if (along !== fwd) continue;
    }
    out.push({ c: { v: fwd ? g.rb[snap.i] : g.ra[snap.i], road: snap.i, fwd, hin: arrive(g, snap.i, fwd), ref: roadKeys(g.map.roads[snap.i]) }, P });
  }
  return out;
}

function pushPt(P, x, y) {
  const n = P.pts.length, [px, py] = P.pts[n - 1], d = Math.hypot(x - px, y - py);
  if (d < 1e-6) return;
  P.pts.push([x, y]); P.cum.push(P.cum[n - 1] + d);
}
const copyP = (P) => ({ pts: P.pts.slice(), cum: P.cum.slice() });
function cutTo(P, n) { return { pts: P.pts.slice(0, n), cum: P.cum.slice(0, n) }; }
function cutAtS(P, s) {   // the path up to distance s (kept for callers placing a point mid-road)
  const cum = P.cum;
  if (cum[cum.length - 1] <= s) return copyP(P);
  let j = 1;
  while (cum[j] <= s) j++;
  const f = (s - cum[j - 1]) / (cum[j] - cum[j - 1]), [ax, ay] = P.pts[j - 1], [bx, by] = P.pts[j];
  const Q = cutTo(P, j);
  Q.pts.push([ax + (bx - ax) * f, ay + (by - ay) * f]); Q.cum.push(s);
  return Q;
}

// rows: schedule rows (D: official miles from the start, cumulative across odometer resets).
// starts: [{ c, P }] (findStart, or startsAt for both ways along the road). Returns null without a start.
// pins: { n: { lat, lon, onto } } the crew (or Claude) chose for a turn: only junctions within 30 m of it, onto a
// road of that name when one is given, can make that turn.
export function lockRoute(g, rows, starts, { beam = BEAM, startD = 0, pins = null } = {}) {
  if (!starts?.length) return null;
  const turns = rows.filter((r) => r.action === 'turn' && r.dir && r.dir !== 'U' && Number.isFinite(r.D) && r.D > startD - 1e-9);
  let lines = starts.map((st) => ({ c: st.c, P: st.P, legs: [], S: 0, anchorD: startD, logp: 0, steps: [], odoS: 0, odoD: 0 }));
  const roads = g.map.roads;
  for (const row of turns) {
    const next = [];
    for (const L of lines) {
      // Map metres per official mile so far on this line (the odometer against the map), 1 at first.
      const scale = L.odoD >= 1 ? L.odoS / (L.odoD * M_PER_MI) : 1;
      const E = Math.max(0, (row.D - L.anchorD) * M_PER_MI * scale), W = Math.max(60, 0.04 * E);
      const Pw = copyP(L.P);
      const steps = walk(g, Pw, L.c, E + 2 * W);
      let cands = turnCandidates(g, steps, row, E, W, Infinity).map((c) => ({ ...c, steps, Pw })), wide = false;
      if (!cands.some((c) => c.score >= MIN_SCORE)) { cands = turnCandidates(g, steps, row, E, 2 * W, Infinity).map((c) => ({ ...c, steps, Pw })); wide = true; }
      if (!cands.some((c) => c.score >= MIN_SCORE)) {
        // Nothing near its mileage: a misread mileage (further off) or direction (L for R) is likelier than the
        // route going on straight, and losing it would spoil every turn after. Flagged for the crew to check.
        const RW = Math.max(500, 0.25 * E), Pr = copyP(L.P), far = walk(g, Pr, L.c, E + RW);
        cands = turnCandidates(g, far, row, E, RW, Infinity).map((c) => ({ ...c, steps: far, Pw: Pr, score: c.score * RELAX_MILES, relaxed: 'mileage' }));
        const flip = { L: 'R', R: 'L', BL: 'BR', BR: 'BL' }[row.dir];
        if (flip) cands.push(...turnCandidates(g, far, { ...row, dir: flip }, E, RW, Infinity).map((c) => ({ ...c, steps: far, Pw: Pr, score: c.score * RELAX_DIR, relaxed: 'direction', dir: flip })));
      }
      if (cands.some((c) => c.exact)) for (const c of cands) if (c.unnamed) c.score *= 0.7;
      cands = cands.filter((c) => c.score >= MIN_SCORE * (c.relaxed ? RELAX_DIR : 1)).sort((p, q) => q.score - p.score);
      const pin = pins?.[row.n], pinXY = pin && g.map.toLocal ? g.map.toLocal(pin.lat, pin.lon) : null;
      if (pinXY) {   // a pinned turn: that junction (and road) or nothing
        const ok = (c) => Math.hypot(g.vx[c.v] - pinXY[0], g.vy[c.v] - pinXY[1]) <= 30 && (!pin.onto || roadKeys(roads[c.b.road]).includes(roadKey(pin.onto)));
        const keep = cands.filter(ok);
        if (keep.length) cands = keep.map((c) => ({ ...c, score: Math.max(c.score, 0.95) }));   // the crew's choice is sure
      }
      cands = cands.slice(0, PER_TURN);
      // The junctions this line weighed for the turn: for the crew (or Claude) to choose from when it's flagged.
      const alts = cands.map((c) => ({ v: c.v, x: g.vx[c.v], y: g.vy[c.v], road: roads[c.b.road].name || null, angle: Math.round(c.b.a), err: Math.round(c.steps[c.j].s - E), score: Math.round(c.score * 100) / 100 }));
      const { key } = turnName(row);
      for (const cd of cands) {
        const st = cd.steps[cd.j], score = cd.score * forks(cd.steps, cd.j) * (wide && !cd.relaxed ? WIDE : 1);
        const P2 = { pts: [[g.vx[st.v], g.vy[st.v]]], cum: [0] };
        const c2 = traverse(g, P2, cd.b.road, cd.b.fwd, key ? [key] : []);
        // A misread mileage: the next leg is measured from where the map says this turn is, not from the misread
        // number (which would put every turn after it off too); and the leg doesn't count toward the odometer factor.
        const misread = cd.relaxed === 'mileage', at = misread ? L.anchorD + st.s / (M_PER_MI * scale) : row.D;
        next.push({ c: c2, P: P2, legs: [...L.legs, cutTo(cd.Pw, st.n)], S: L.S + st.s, anchorD: at, logp: L.logp + Math.log(score),
          odoS: L.odoS + (misread ? 0 : st.s), odoD: L.odoD + (misread ? 0 : row.D - L.anchorD),
          steps: [...L.steps, { n: row.n, D: row.D, s: L.S + st.s, x: g.vx[st.v], y: g.vy[st.v], v: st.v, score, wide, road: roads[cd.b.road].name || null, angle: Math.round(cd.b.a), alts, pinned: !!pinXY, relaxed: cd.relaxed ?? null, err: Math.round(st.s - E), dir: cd.dir ?? row.dir }] });
      }
      if (!cands.length && steps.length) {   // nothing fits: on along the main road to about its mileage, the turn not made
        let j = 0;
        for (let k = 0; k < steps.length; k++) if (steps[k].s <= E) j = k;
        const st = steps[j];
        next.push({ ...L, c: { v: st.v, road: st.road, fwd: st.fwd, hin: st.hin, ref: st.ref }, P: cutTo(Pw, st.n), logp: L.logp + Math.log(MISS),
          steps: [...L.steps, { n: row.n, D: row.D, s: L.S + st.s, x: g.vx[st.v], y: g.vy[st.v], v: st.v, score: 0, miss: true, road: null }] });
      }
    }
    // Lines that met again (same junction, same way out) keep the better one; then the best few.
    const seen = new Map();
    for (const L of next) {
      const last = L.steps[L.steps.length - 1], k = `${last.v ?? `${Math.round(last.x)},${Math.round(last.y)}`}|${L.c.road}|${L.c.fwd}`;
      if (!seen.has(k) || seen.get(k).logp < L.logp) seen.set(k, L);
    }
    lines = [...seen.values()].sort((p, q) => q.logp - p.logp).slice(0, beam);
    if (!lines.length) break;
  }
  const best = lines[0];
  if (!best) return null;
  // Flags: a weak or missing turn; another line about as good that turns somewhere else at that step.
  const rival = lines.find((L) => L !== best && best.logp - L.logp < RIVAL);
  const steps = best.steps.map((st, i) => {
    const r = rival?.steps[i], away = r && (r.v !== st.v || (r.v === null && Math.hypot(r.x - st.x, r.y - st.y) > 30));
    const why = st.pinned ? null : st.miss ? 'no junction fits this turn near its mileage'
      : st.relaxed === 'mileage' ? `the map's turn is ${Math.round(Math.abs(st.err) * 3.281)} ft ${st.err >= 0 ? 'past' : 'before'} its mileage: check the instruction's mileage`
        : st.relaxed === 'direction' ? `the map only has a ${st.dir === 'R' || st.dir === 'BR' ? 'right' : 'left'} turn here: check the instruction's direction`
          : st.score < FLAG_SCORE ? `weak fit (${Math.round(st.score * 100)}%)` : away ? 'another route about as good turns elsewhere' : null;
    return { ...st, flag: !!why, why };
  });
  // The whole path: the legs, then a short way on past the last turn.
  const path = { pts: [], cum: [] };
  for (const leg of [...best.legs, best.P]) for (let j = 0; j < leg.pts.length; j++) {
    if (path.pts.length && j === 0) continue;   // a leg starts where the last one ended
    const [x, y] = leg.pts[j];
    if (!path.pts.length) { path.pts.push([x, y]); path.cum.push(0); } else pushPt(path, x, y);
  }
  const scale = best.odoD >= 1 ? best.odoS / (best.odoD * M_PER_MI) : 1;
  return { path, steps, scale, logp: best.logp, conf: Math.exp(best.logp / Math.max(1, steps.length)), lines: lines.length };
}

// Every row's place on the locked path: turns where they were made; other rows by their mileage between the
// turns around them (so the odometer's error is spread over the leg, not carried along). Returns Map n -> s.
export function placeRows(rows, lock) {
  const anchors = [{ D: rows.find((r) => Number.isFinite(r.D))?.D ?? 0, s: 0 }, ...lock.steps.filter((st) => !st.miss).map((st) => ({ D: st.D, s: st.s }))];
  const end = lock.path.cum[lock.path.cum.length - 1] ?? 0, out = new Map();
  for (const r of rows) {
    if (!Number.isFinite(r.D)) continue;
    const t = lock.steps.find((st) => st.n === r.n && !st.miss);
    if (t) { out.set(r.n, t.s); continue; }
    let i = 0;
    while (i + 1 < anchors.length && anchors[i + 1].D <= r.D) i++;
    const a = anchors[i], b = anchors[i + 1];
    const s = b && b.D > a.D ? a.s + (r.D - a.D) / (b.D - a.D) * (b.s - a.s) : a.s + (r.D - a.D) * M_PER_MI * lock.scale;
    out.set(r.n, Math.max(0, Math.min(end, s)));
  }
  return out;
}

// A point at distance s along the path.
export function pointAt(path, s) {
  const { pts, cum } = path;
  if (!pts.length) return null;
  if (s <= 0) return pts[0];
  if (s >= cum[cum.length - 1]) return pts[pts.length - 1];
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; }
  const f = (s - cum[lo]) / (cum[hi] - cum[lo] || 1), [ax, ay] = pts[lo], [bx, by] = pts[hi];
  return [ax + (bx - ax) * f, ay + (by - ay) * f];
}

// The lock as stored with the route: GPS (6 decimals) for the path and for every row with a mileage (turns where
// they were made, the rest by mileage between turns), the turns' fit, and the flagged ones.
export function serializeLock(lock, rows, map) {
  const r6 = (x) => Math.round(x * 1e6) / 1e6, r1 = (x) => Math.round(x * 10) / 10;
  const placed = placeRows(rows, lock), byN = new Map(lock.steps.map((s) => [s.n, s])), byRow = new Map(rows.map((r) => [r.n, r]));
  const at = [...placed.entries()].map(([n, s]) => {
    const [lat, lon] = map.toLatLon(...pointAt(lock.path, s)), t = byN.get(n);
    return { n, D: byRow.get(n).D, s: r1(s), lat: r6(lat), lon: r6(lon), ...(t ? { turn: true, score: Math.round(t.score * 100) / 100, road: t.road, flag: t.flag, why: t.why } : {}) };
  });
  const choice = (s) => (s.alts || []).map((a, i) => { const [lat, lon] = map.toLatLon(a.x, a.y); return { id: String.fromCharCode(97 + i), lat: r6(lat), lon: r6(lon), road: a.road, angle: a.angle, err_m: a.err, score: a.score, chosen: a.v === s.v }; });
  return { v: LOCK_V, at: Date.now(), scale: lock.scale, conf: lock.conf, rows: at, flagged: lock.steps.filter((s) => s.flag).map((s) => ({ n: s.n, why: s.why, choices: choice(s), relaxed: s.relaxed ?? null, dir: s.dir ?? null, err_m: s.err ?? null })),
    pinned: lock.steps.filter((s) => s.pinned).map((s) => s.n),
    path: { ll: lock.path.pts.map(([x, y]) => map.toLatLon(x, y).map(r6)), cum: lock.path.cum.map(r1) } };
}
