// Route projection for the Drive map: where the rally route goes from the car, on the offline road map
// (mapview.js), so the map can draw it to the next few turns with arrows and a "Route guess NN%".
// buildGraph(map) links the roads at their shared end points (once per map). projectRoute(graph, …) snaps
// the car to a road, follows the main road, and makes each turn of the instructions at the junction that
// best fits its mileage, direction and road name.
//
// Each turn is looked for at the junctions on the main road within ±max(60 m, 4% of its leg) of its mileage;
// the leg runs from the previous turn projected, or for the first turn from the previous turn row (where the
// app last re-synced D), as the car's own mileage drifts since then. Confidence of one turn (0…1), product of
//   mileage    1 − 0.6·(err/window)³: flat near the mileage, 0.4 at the window's edge
//   angle      R/L 1 at 55–125° (0.85 at 45° and 140°, 0 at 20° and 165°); BR/BL 1 at 20–55° (0 at −5°
//              and 95°), 0.9 for the right/left way of a fork, ×0.5 if another way of the fork is further
//              that side ("L at Y" counts as BL); S 1 within ±12° (0 at ±40°)
//   name       onto (else, softer, an "at" sign's text) is the map's name → 1, close spelling 0.9, road
//              unnamed on the map 0.85 (×0.7 more if a road of that name is in the window), another name
//              0.5; no onto → 1
//   kind       service road 0.4, track 0.35, motorway 0.3, trunk 0.7 (1 when the name matches); cue T where
//              the road goes on straight ×0.5; cue Y with no fork ×0.6; STOP/yield/signal where the car's
//              road goes on straight and meets no bigger road ×0.75
//   ambiguity  runner-up (another junction, or another way out) at ratio q of the best score:
//              ×(1 − 0.55·(q − 0.35)/0.65) for q > 0.35, so a tie halves it
// The line's conf multiplies its turns' and ×0.85 per ambiguous fork of the main road passed on the way (not
// in the short tail after the last turn), so an early wrong turn spoils everything after it. A turn found
// only out to twice its window ×0.6; a turn no junction fits ends the line at its mileage ×0.4.

import { roadKey, roadKeys, nearestRoad } from './mapview.js';

const DEG = 180 / Math.PI;
const HEAD_M = 25;        // a road's direction at a junction: over its first 25 m
const SNAP_M = 30;        // the car must be this close to a road
const TAIL_M = 250;       // line drawn past the last turn projected
const LOOK_M = 60;        // a turn up to 60 m behind the car's mileage may not have been made yet
const FORK = 0.85;
const UNRESOLVED = 0.4;
const WIDE = 0.6;         // the turn found only outside its window (searched to twice its width)
const MIN_SCORE = 0.12;   // a junction scoring lower doesn't count as the turn

const norm = (a) => ((a % 360) + 540) % 360 - 180;   // −180…180, + = right

// Bearing (degrees from north) leaving a road at its first (dir 1) or last (dir −1) point, over HEAD_M.
function leaving(xy, dir) {
  const n = xy.length / 2, i0 = dir > 0 ? 0 : n - 1, x0 = xy[2 * i0], y0 = xy[2 * i0 + 1];
  let px = x0, py = y0, acc = 0;
  for (let j = i0 + dir; j >= 0 && j < n; j += dir) {
    const qx = xy[2 * j], qy = xy[2 * j + 1], d = Math.hypot(qx - px, qy - py);
    if (acc + d >= HEAD_M) { const f = (HEAD_M - acc) / d; px += (qx - px) * f; py += (qy - py) * f; break; }
    acc += d; px = qx; py = qy;
  }
  return Math.atan2(px - x0, py - y0) * DEG;
}

// Vertices are road end points (identical coordinates where roads meet). Half-edge p at vertex v leaves v
// along road hRoad[p], forward (from its first point) when hFwd[p].
export function buildGraph(map) {
  const roads = map.roads, nR = roads.length;
  const ra = new Int32Array(nR), rb = new Int32Array(nR), len = new Float64Array(nR);
  const hA = new Float32Array(nR), hB = new Float32Array(nR);
  const ids = new Map(), vx = [], vy = [];
  const vid = (x, y) => {
    const key = (Math.round(x * 8) + 8388608) * 16777216 + Math.round(y * 8) + 8388608;
    let v = ids.get(key);
    if (v === undefined) { v = vx.length; ids.set(key, v); vx.push(x); vy.push(y); }
    return v;
  };
  for (let i = 0; i < nR; i++) {
    const xy = roads[i].xy, n = xy.length;
    ra[i] = vid(xy[0], xy[1]); rb[i] = vid(xy[n - 2], xy[n - 1]);
    let L = 0;
    for (let k = 2; k < n; k += 2) L += Math.hypot(xy[k] - xy[k - 2], xy[k + 1] - xy[k - 1]);
    len[i] = L; hA[i] = leaving(xy, 1); hB[i] = leaving(xy, -1);
  }
  const nV = vx.length, start = new Int32Array(nV + 1), linked = (i) => ra[i] !== rb[i] || len[i] >= 1;   // not a dot
  for (let i = 0; i < nR; i++) if (linked(i)) { start[ra[i] + 1]++; start[rb[i] + 1]++; }
  for (let v = 0; v < nV; v++) start[v + 1] += start[v];
  const fill = start.slice(0, nV), hRoad = new Int32Array(2 * nR), hFwd = new Uint8Array(2 * nR);
  for (let i = 0; i < nR; i++) {
    if (!linked(i)) continue;
    let p = fill[ra[i]]++; hRoad[p] = i; hFwd[p] = 1;
    p = fill[rb[i]]++; hRoad[p] = i; hFwd[p] = 0;
  }
  return { map, ra, rb, len, hA, hB, vx: Float64Array.from(vx), vy: Float64Array.from(vy), start, hRoad, hFwd };
}

export const out = (g, r, f) => (f ? g.hA[r] : g.hB[r]);          // heading leaving the vertex along r
export const arrive = (g, r, f) => norm((f ? g.hB[r] : g.hA[r]) + 180);   // heading arriving at the far end

// Ways on from vertex v for a car arriving along road `road` (travelled forward if `fwd`) heading `hin`.
export function branches(g, v, road, fwd, hin) {
  const bs = [];
  for (let p = g.start[v]; p < g.start[v + 1]; p++) {
    const r = g.hRoad[p], f = g.hFwd[p] === 1;
    if (r === road && f !== fwd) continue;   // back the way we came
    const a = norm(out(g, r, f) - hin);
    bs.push({ road: r, fwd: f, a, ad: Math.abs(a), c: g.map.roads[r].c });
  }
  return bs;
}

const shares = (road, ref) => ref.length > 0 && roadKeys(road).some((k) => ref.includes(k));

// The main road on from cursor c: the same road name (bending up to 120°), else the smallest bend
// (service roads and tracks only when nothing else goes on). amb: another way on is about as plausible.
export function mainRoad(g, c) {
  const bs = branches(g, c.v, c.road, c.fwd, c.hin), roads = g.map.roads;
  if (!bs.length) return null;
  if (bs.length === 1) return { ...bs[0], amb: false };
  const byBend = (p, q) => p.ad - q.ad;
  const same = bs.filter((b) => b.ad <= 120 && shares(roads[b.road], c.ref)).sort(byBend);
  if (same.length) {
    const pick = same[0], rival = same[1];
    const split = rival && rival.ad <= 30;   // carriageways of a divided road: either way is the road
    const amb = (rival && rival.ad - pick.ad < 25 && !split) || (pick.ad > 45 && bs.some((b) => !same.includes(b) && b.c <= 6 && b.ad < 20));
    return { ...pick, amb };
  }
  const inC = roads[c.road].c, pool = bs.filter((b) => b.c <= Math.max(6, inC)).sort(byBend);
  const list = pool.length ? pool : bs.sort(byBend);
  return { ...list[0], amb: list.length > 1 && list[1].ad - list[0].ad < 25 };
}

// Path: points from the car and their distances along it.
export function push(P, x, y) {
  const n = P.pts.length, [px, py] = P.pts[n - 1], d = Math.hypot(x - px, y - py);
  if (d < 1e-6) return;
  P.pts.push([x, y]); P.cum.push(P.cum[n - 1] + d);
}
export const plen = (P) => P.cum[P.cum.length - 1];
export function cutCount(P, n) { P.pts.length = n; P.cum.length = n; }
function cutAt(P, s) {
  const cum = P.cum;
  if (cum[cum.length - 1] <= s) return;
  if (s <= 0) { cutCount(P, 1); return; }
  let j = 1;
  while (cum[j] <= s) j++;
  const f = (s - cum[j - 1]) / (cum[j] - cum[j - 1]), [ax, ay] = P.pts[j - 1], [bx, by] = P.pts[j];
  cutCount(P, j);
  P.pts.push([ax + (bx - ax) * f, ay + (by - ay) * f]); P.cum.push(s);
}

// Drive road r (forward if f) to its far end. ref: the road names being followed (kept over unnamed roads).
export function traverse(g, P, r, f, ref) {
  const road = g.map.roads[r], xy = road.xy, n = xy.length;
  if (f) for (let j = 2; j < n; j += 2) push(P, xy[j], xy[j + 1]);
  else for (let j = n - 4; j >= 0; j -= 2) push(P, xy[j], xy[j + 1]);
  const keys = roadKeys(road);
  return { v: f ? g.rb[r] : g.ra[r], road: r, fwd: f, hin: arrive(g, r, f), ref: keys.length ? keys : ref };
}

// Follow the main road from cursor c until the path is `until` long (or a dead end), noting each vertex.
export function walk(g, P, c, until) {
  const steps = [];
  for (let guard = 0; guard < 5000; guard++) {
    const st = { ...c, s: plen(P), n: P.pts.length, amb: false };
    steps.push(st);
    if (st.s >= until) break;
    const m = mainRoad(g, c);
    if (!m) break;
    st.amb = m.amb;
    c = traverse(g, P, m.road, m.fwd, c.ref);
  }
  return steps;
}
// Ambiguous forks among the first j choices of a walk, or among those made before distance s.
export const forks = (steps, j) => { let k = 0; for (let i = 0; i < j && i < steps.length; i++) if (steps[i].amb) k++; return FORK ** k; };
const forksBefore = (steps, s) => { const j = steps.findIndex((st) => st.s >= s); return forks(steps, j < 0 ? steps.length : j); };

// How well a turn angle (+ = right) fits a direction: piecewise linear through [angle, fit] points.
const FIT = { R: [[20, 0], [45, 0.85], [55, 1], [125, 1], [140, 0.85], [165, 0]], BR: [[-5, 0], [12, 0.85], [20, 1], [55, 1], [70, 0.85], [95, 0]],
  S: [[-40, 0], [-25, 0.85], [-12, 1], [12, 1], [25, 0.85], [40, 0]] };
FIT.L = FIT.R.map(([a, f]) => [-a, f]).reverse();
FIT.BL = FIT.BR.map(([a, f]) => [-a, f]).reverse();
export function angleFit(dir, a) {
  const t = FIT[dir];
  if (!t || a <= t[0][0] || a >= t[t.length - 1][0]) return 0;
  let i = 1;
  while (t[i][0] < a) i++;
  const [a0, f0] = t[i - 1], [a1, f1] = t[i];
  return f0 + (f1 - f0) * (a - a0) / (a1 - a0);
}

const CLASS_FIT = [0.3, 0.7, 1, 1, 1, 1, 1, 0.4, 0.35];   // motorway … residential, service, track
const TYPE = new Set(['RD', 'ST', 'AVE', 'DR', 'LN', 'HWY', 'BLVD', 'CT', 'PL', 'PKWY', 'CIR', 'TER', 'TRL', 'EXT', 'WAY', 'PIKE']);
function core(k) {   // "OLD FRENCH RD" ~ "OLD FRENCH"; route numbers by number ("S19" ~ "US19")
  const m = k.match(/^(?:US|S|T|C)(\d+[A-Z]?)$/);
  if (m) return `#${m[1]}`;
  const w = k.split(' ');
  if (w.length > 1 && TYPE.has(w[w.length - 1])) w.pop();
  return w.join(' ');
}
export function nameFit(road, key, soft) {
  if (!key) return 1;
  const keys = roadKeys(road);
  if (!keys.length) return soft ? 0.9 : 0.85;
  if (keys.includes(key)) return 1;
  const c = core(key);
  if (c.length >= 2 && keys.some((k) => core(k) === c)) return 0.9;
  return soft ? 0.75 : 0.5;
}

// The name a turn should be onto: onto, else the text of a sign it turns at (weaker: signs aren't always names).
export function turnName(row) {
  const key = roadKey(row.onto);
  if (key) return { key, soft: false };
  if (row.cue === 'sign' && row.sign_text && (!row.sign_rel || row.sign_rel === 'at')) return { key: roadKey(row.sign_text), soft: true };
  return { key: '', soft: false };
}

// The nearest real junction (3+ roads) behind the car within `limit` metres, through plain bends:
// { v, d (metres back), road, fwd (the road leaving it toward the car) } or null.
function junctionBehind(g, road, f, d, limit) {
  for (let guard = 0; guard < 50 && d <= limit; guard++) {
    const v = f ? g.ra[road] : g.rb[road], deg = g.start[v + 1] - g.start[v];
    if (deg >= 3) return { v, d, road, fwd: f };
    if (deg < 2) return null;
    let p = g.start[v];
    if (g.hRoad[p] === road && (g.hFwd[p] === 1) === f) p++;
    road = g.hRoad[p]; f = g.hFwd[p] !== 1; d += g.len[road];
  }
  return null;
}

// Score every way to make `row`'s turn: branches of the junctions on the main road within the window, plus
// (first turn only) "already made" at the junction just behind the car. Returns the best with its conf.
// Every way to make `row`'s turn at the junctions of `steps` within E ± W metres, scored (unsorted).
export function turnCandidates(g, steps, row, E, W, maxM) {
  const roads = g.map.roads, { key, soft } = turnName(row);
  const dir = row.cue === 'Y' && (row.dir === 'L' || row.dir === 'R') ? `B${row.dir}` : row.dir;   // "L at Y": the left way
  const cands = [];
  for (let j = 0; j < steps.length; j++) {
    const st = steps[j];
    if (st.s < E - W || st.s > E + W || st.s > maxM) continue;
    const bs = branches(g, st.v, st.road, st.fwd, st.hin);
    if (bs.length < 2) continue;
    const straight = bs.some((b) => b.ad <= 30 && b.c <= 6);
    // A stop, yield or signal: where the car's road ends, or meets a bigger road.
    const minor = !straight || bs.some((b) => b.c < roads[st.road].c);
    const fork = bs.filter((o) => o.ad <= 70 && o.c <= 6);
    for (const b of bs) {
      let fit = Math.max(angleFit(dir, b.a), angleFit(row.dir, b.a));
      if (dir === 'BR' || dir === 'BL') {   // the right-/leftmost way of a fork
        const side = dir === 'BR' ? 1 : -1;
        if (fork.some((o) => o !== b && o.a * side > b.a * side)) fit *= 0.5;
        else if (fork.length >= 2 && fork.includes(b) && b.a * side > -15) fit = Math.max(fit, 0.9);
      }
      if (fit <= 0) continue;
      const name = nameFit(roads[b.road], key, soft);
      let kind = name === 1 && key ? 1 : CLASS_FIT[b.c] ?? 1;
      if (row.cue === 'T' && straight) kind *= 0.5;
      if (row.cue === 'Y' && !bs.some((o) => o !== b && o.ad <= 70)) kind *= 0.6;
      if ((row.cue === 'stop' || row.cue === 'yield' || row.cue === 'signal') && !minor) kind *= 0.75;
      const e = Math.abs(st.s - E) / W;
      cands.push({ j, b, v: st.v, head: out(g, b.road, b.fwd), score: fit * name * kind * (1 - 0.6 * e * e * e), unnamed: !roadKeys(roads[b.road]).length, exact: name === 1 && !!key });
    }
  }
  return cands;
}

function pickTurn(g, steps, row, E, W, maxM, behind) {
  const roads = g.map.roads, { key, soft } = turnName(row);
  const dir = row.cue === 'Y' && (row.dir === 'L' || row.dir === 'R') ? `B${row.dir}` : row.dir;   // "L at Y": the left way
  const cands = turnCandidates(g, steps, row, E, W, maxM);
  if (behind) {
    const jb = behind, h = out(g, jb.road, jb.fwd);
    let fit = 0;
    for (let p = g.start[jb.v]; p < g.start[jb.v + 1]; p++) {
      const r = g.hRoad[p], f = g.hFwd[p] === 1;
      if (r === jb.road && f === jb.fwd) continue;
      const a = norm(h - out(g, r, f) - 180);
      fit = Math.max(fit, angleFit(dir, a), angleFit(row.dir, a));
    }
    const e = Math.abs(-jb.d - E) / W;
    if (fit > 0 && e <= 1) {
      const name = Math.max(nameFit(roads[jb.road], key, soft), nameFit(roads[jb.car], key, soft));
      const kind = name === 1 && key ? 1 : CLASS_FIT[roads[jb.road].c] ?? 1;
      cands.push({ behind: true, d: jb.d, v: jb.v, head: h, score: fit * name * kind * (1 - 0.6 * e * e * e) });
    }
  }
  if (!cands.length) return null;
  // A road of the turn's name is here, so the map names roads here: an unnamed one is less likely meant.
  if (cands.some((c) => c.exact)) for (const c of cands) if (c.unnamed) c.score *= 0.7;
  cands.sort((p, q) => q.score - p.score);
  const best = cands[0];
  if (best.score < MIN_SCORE) return null;
  // The runner-up is another outcome: made already vs. ahead, another junction, or another way out.
  const same = (c) => !c.behind === !best.behind && Math.hypot(g.vx[c.v] - g.vx[best.v], g.vy[c.v] - g.vy[best.v]) <= 15 && Math.abs(norm(c.head - best.head)) <= 30;
  const rival = cands.find((c) => c !== best && !same(c));
  const q = rival ? rival.score / best.score : 0;
  const amb = q <= 0.35 ? 1 : 1 - 0.55 * Math.min(1, (q - 0.35) / 0.65);
  return { ...best, conf: best.score * amb, amb, margin: 1 - q, name: key };
}

// Turn rows to project, in order. A U-turn or a turn without mileage ends the list (stop: true); a turn
// without mileage that may be behind the car counts as made once the car is on its road.
function turnsAhead(rows, D, look, carKeys) {
  const list = [];
  let ahead = false, prev = 0;   // prev: the last turn's mileage (where the app last re-synced D)
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i], known = Number.isFinite(r.D), before = prev;
    if (known && r.D > D) ahead = true;
    if (r.action !== 'turn' || !r.dir) continue;
    if (known) prev = r.D;
    if (!known) {
      if (!ahead) {
        const next = rows.slice(i + 1).find((q) => Number.isFinite(q.D));
        if (!next || next.D <= D) continue;
        const k = roadKey(r.onto);
        if (k && carKeys.includes(k)) continue;
      }
      list.push({ row: r, stop: true });
      break;
    }
    if (r.D <= D - look) continue;
    list.push({ row: r, stop: r.dir === 'U', prev: before });
    if (r.dir === 'U') break;
  }
  return list;
}

function project(g, snap, x, y, fwd, o) {
  const roads = g.map.roads, i = snap.i, k = snap.k, xy = roads[i].xy;
  const ax = xy[k], ay = xy[k + 1], dx = xy[k + 2] - ax, dy = xy[k + 3] - ay, L2 = dx * dx + dy * dy;
  const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)) : 0;
  const P = { pts: [[ax + t * dx, ay + t * dy]], cum: [0] };
  if (fwd) for (let j = k + 2; j < xy.length; j += 2) push(P, xy[j], xy[j + 1]);
  else for (let j = k; j >= 0; j -= 2) push(P, xy[j], xy[j + 1]);
  const back = Math.max(0, g.len[i] - plen(P));   // metres from the road's start (as driven) to the car
  const carKeys = roadKeys(roads[i]);
  let c = { v: fwd ? g.rb[i] : g.ra[i], road: i, fwd, hin: arrive(g, i, fwd), ref: carKeys };
  const turns = [];
  let conf = 1, anchorS = 0, anchorD = o.D, tail = true;
  for (const { row, stop, prev } of turnsAhead(o.rows, o.D, LOOK_M / o.mPerMile, carKeys)) {
    if (turns.length >= o.maxTurns || !Number.isFinite(row.D)) break;
    let E = anchorS + (row.D - anchorD) * o.mPerMile;
    if (turns.length && E < anchorS) E = anchorS;
    // The car's own mileage drifts from the last turn (its re-sync), so the first turn's window spans its whole leg.
    const leg = anchorS === 0 && !turns.length ? Math.max(E, (row.D - prev) * o.mPerMile) : E - anchorS;
    const W = Math.max(60, 0.04 * Math.abs(leg));
    if (stop) {   // U-turn: the line ends where it is
      const s = Math.max(0, Math.min(E, o.maxM));
      conf *= forksBefore(walk(g, P, c, s), s); cutAt(P, s); tail = false;
      break;
    }
    if (E + W > o.maxM) {   // beyond the horizon: the main road up to it
      conf *= forksBefore(walk(g, P, c, o.maxM), o.maxM); cutAt(P, o.maxM); tail = false;
      break;
    }
    const n0 = P.pts.length;
    let steps = walk(g, P, c, E + W);
    const behind = !turns.length && E - W < 0 ? junctionBehind(g, i, fwd, back, W - E) : null;
    if (behind) behind.car = i;
    let pick = pickTurn(g, steps, row, E, W, o.maxM, behind);
    if (!pick && (turns.length || E >= W)) {   // nothing fits in the window: look twice as far, trusting it less
      cutCount(P, n0);
      steps = walk(g, P, c, E + 2 * W);
      pick = pickTurn(g, steps, row, E, 2 * W, o.maxM, null);
      if (pick) pick.conf *= WIDE;
    }
    if (!pick || pick.behind) {
      cutCount(P, n0);
      if (pick) { conf *= pick.amb; anchorS = -pick.d; anchorD = row.D; continue; }   // made already
      if (!turns.length && E < W) { conf *= 0.9; continue; }                         // probably made already
      const s = Math.max(0, E);
      conf *= forksBefore(walk(g, P, c, s), s) * UNRESOLVED; cutAt(P, s); tail = false;
      break;
    }
    const st = steps[pick.j];
    cutCount(P, st.n);
    conf *= forks(steps, pick.j) * pick.conf;
    c = traverse(g, P, pick.b.road, pick.b.fwd, pick.name ? [pick.name] : []);
    const to = roads[pick.b.road].name || null;
    turns.push({ n: row.n, x: g.vx[st.v], y: g.vy[st.v], dir: row.dir, conf: pick.conf, onto: row.onto ?? to, dist_m: st.s,
      angle: Math.round(pick.b.a), road: to, margin: pick.margin, path_conf: conf });
    anchorS = st.s; anchorD = row.D;
  }
  if (tail) {   // a short way past the last turn (or the car), along the main road
    const s = Math.min(o.maxM, (turns.length ? turns[turns.length - 1].dist_m : 0) + TAIL_M);
    walk(g, P, c, s); cutAt(P, s);
  }
  return { path: P.pts, turns, conf, road: roads[i].name };
}

// x, y: the car (local metres, map.toLocal); headingDeg: GPS course or null; D: the car's route miles on
// the scale of rows[].D (buildSchedule rows). Null when the car isn't within 30 m of a road.
export function projectRoute(graph, { x, y, headingDeg = null, D, rows, maxTurns = 3, maxM = 6000, mPerMile = 1609.344 } = {}) {
  if (!graph || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(D)) return null;
  const known = Number.isFinite(headingDeg);
  const snap = nearestRoad(graph.map, x, y, known ? headingDeg : null, SNAP_M);
  if (!snap) return null;
  const o = { D, rows: rows || [], maxTurns, maxM, mPerMile };
  if (known) {
    const xy = graph.map.roads[snap.i].xy, k = snap.k;
    const seg = Math.atan2(xy[k + 2] - xy[k], xy[k + 3] - xy[k + 1]) * DEG;
    return project(graph, snap, x, y, Math.cos((headingDeg - seg) / DEG) >= 0, o);
  }
  // No heading: the way along the road that fits the instructions better, less sure the closer the other.
  const a = project(graph, snap, x, y, true, o), b = project(graph, snap, x, y, false, o);
  const [best, other] = a.conf >= b.conf ? [a, b] : [b, a];
  const f = best.conf > 0 ? 1 - 0.5 * other.conf / best.conf : 0.5;
  best.conf *= f;
  for (const t of best.turns) t.path_conf *= f;
  return best;
}
