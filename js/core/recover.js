// "Get me back on course": the shortest way on the road map from the car to a point on the route (where the car
// left it), and the speed that gets there at that point's perfect time.

import { nearestRoad } from './mapview.js';

// A tiny binary heap of [key, value].
class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(k, v) {
    const a = this.a; a.push([k, v]);
    let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
}

// Where (x, y) sits on the road graph: the road it's on and its two end vertices with the metres to each.
function onRoad(g, x, y, maxM) {
  const snap = nearestRoad(g.map, x, y, null, maxM);
  if (!snap) return null;
  const xy = g.map.roads[snap.i].xy, k = snap.k;
  const ax = xy[k], ay = xy[k + 1], dx = xy[k + 2] - ax, dy = xy[k + 3] - ay, L2 = dx * dx + dy * dy;
  const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)) : 0;
  let toA = 0;
  for (let j = 2; j <= k; j += 2) toA += Math.hypot(xy[j] - xy[j - 2], xy[j + 1] - xy[j - 1]);
  toA += t * Math.sqrt(L2);
  return { road: snap.i, px: ax + t * dx, py: ay + t * dy, k, toA, toB: g.len[snap.i] - toA, a: g.ra[snap.i], b: g.rb[snap.i] };
}

// The road's points from its end `fromEnd` ('a' or 'b') to its point at metres `m` from end a (inclusive).
function partial(g, road, fromEnd, m) {
  const xy = g.map.roads[road].xy, n = xy.length / 2, pts = [];
  const all = []; let acc = 0;
  for (let j = 0; j < n; j++) { if (j) acc += Math.hypot(xy[2 * j] - xy[2 * j - 2], xy[2 * j + 1] - xy[2 * j - 1]); all.push([xy[2 * j], xy[2 * j + 1], acc]); }
  if (fromEnd === 'a') { for (const p of all) { if (p[2] >= m) break; pts.push([p[0], p[1]]); } }
  else { for (let j = all.length - 1; j >= 0; j--) { if (all[j][2] <= m) break; pts.push([all[j][0], all[j][1]]); } }
  return pts;
}

// The shortest way from (fx, fy) to (tx, ty) along roads (either way along each road), searched out to maxM.
// Returns { pts: [[x, y]], len } in local metres, or null.
export function routeBack(g, { x: fx, y: fy }, { x: tx, y: ty }, { maxM = 30000, snapM = 150 } = {}) {   // snapM: a car in a lot or a drive is still near its road
  const A = onRoad(g, fx, fy, snapM), B = onRoad(g, tx, ty, snapM);
  if (!A || !B) return null;
  // Both on the same road: along it.
  if (A.road === B.road) return { pts: simpleAlong(g, A, B), len: Math.abs(A.toA - B.toA) };
  const dist = new Map(), prev = new Map(), heap = new Heap();
  const seed = (v, d, via) => { if (!(dist.get(v) <= d)) { dist.set(v, d); prev.set(v, via); heap.push(d, v); } };
  seed(A.a, A.toA, { start: 'a' }); seed(A.b, A.toB, { start: 'b' });
  const goal = new Map([[B.a, B.toA], [B.b, B.toB]]);
  let best = null;
  while (heap.size) {
    const [d, v] = heap.pop();
    if (d > dist.get(v) || d > maxM) continue;
    if (best && d >= best.d) break;
    if (goal.has(v)) { const tot = d + goal.get(v); if (!best || tot < best.d) best = { d: tot, v }; }
    for (let p = g.start[v]; p < g.start[v + 1]; p++) {
      const r = g.hRoad[p], f = g.hFwd[p] === 1, w = f ? g.rb[r] : g.ra[r];
      seed(w, d + g.len[r], { v, road: r, fwd: f });
    }
  }
  if (!best) return null;
  // The roads back from the goal vertex to the start, then the bits on the car's and the target's roads.
  const chain = [];
  for (let v = best.v; ;) { const via = prev.get(v); if (!via || via.start) { chain.push({ end: via?.start }); break; } chain.push({ ...via, to: v }); v = via.v; }
  chain.reverse();
  const pts = [[A.px, A.py], ...partial(g, A.road, chain[0].end, A.toA).reverse()];   // from the car to the end it leaves by
  for (const c of chain.slice(1)) {
    const xy = g.map.roads[c.road].xy, n = xy.length / 2;
    if (c.fwd) for (let j = 1; j < n; j++) pts.push([xy[2 * j], xy[2 * j + 1]]);
    else for (let j = n - 2; j >= 0; j--) pts.push([xy[2 * j], xy[2 * j + 1]]);
  }
  pts.push(...partial(g, B.road, best.v === B.a ? 'a' : 'b', B.toA), [B.px, B.py]);
  return { pts, len: best.d };
}

function simpleAlong(g, A, B) {
  const xy = g.map.roads[A.road].xy, n = xy.length / 2, pts = [[A.px, A.py]];
  let acc = 0; const at = [0];
  for (let j = 1; j < n; j++) { acc += Math.hypot(xy[2 * j] - xy[2 * j - 2], xy[2 * j + 1] - xy[2 * j - 1]); at.push(acc); }
  const lo = Math.min(A.toA, B.toA), hi = Math.max(A.toA, B.toA), mid = [];
  for (let j = 0; j < n; j++) if (at[j] > lo && at[j] < hi) mid.push([xy[2 * j], xy[2 * j + 1]]);
  if (A.toA > B.toA) mid.reverse();
  pts.push(...mid, [B.px, B.py]);
  return pts;
}

// The speed (mph) to arrive at the rejoin point at its perfect time: metres to go, seconds left. Late already (or
// no time left): null, and the crew drives the CAST plus what is safe.
export function speedBack(lenM, secondsLeft) {
  if (!(secondsLeft > 0)) return null;
  return lenM / secondsLeft / 0.44704;
}
