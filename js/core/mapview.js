// Offline road map (app/map/roads.json, built by tools/build_mapview.mjs): decoding, a grid index, road-name
// matching and the nearest road to a position. Coordinates are local metres (x east, y north) around the
// map's centre.

export function decodeMap(doc) {
  const [s, w, n, e] = doc.bbox, lat0 = (s + n) / 2, lon0 = (w + e) / 2, q = doc.q;
  const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
  const toLocal = (lat, lon) => [(lon - lon0) * kx, (lat - lat0) * ky];
  const toLatLon = (x, y) => [y / ky + lat0, x / kx + lon0];
  const roads = doc.roads.map(([c, label, alts, flat]) => {
    const xy = new Float32Array(flat.length);
    let a = 0, o = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < flat.length; i += 2) {
      a += flat[i]; o += flat[i + 1];
      const x = (o / q - lon0) * kx, y = (a / q - lat0) * ky;
      xy[i] = x; xy[i + 1] = y;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    return { c, name: doc.names[label], alts: alts ? alts.map((k) => doc.names[k]) : [], xy, box: [x0, y0, x1, y1] };
  });
  const bridges = doc.bridges.map(([a, o, k]) => { const [x, y] = toLocal(a / q, o / q); return { x, y, name: doc.names[k] }; });
  const CELL = 500, grid = new Map(), key = (gx, gy) => gx * 100003 + gy;
  roads.forEach((r, i) => {
    for (let gx = Math.floor(r.box[0] / CELL); gx <= Math.floor(r.box[2] / CELL); gx++)
      for (let gy = Math.floor(r.box[1] / CELL); gy <= Math.floor(r.box[3] / CELL); gy++) {
        let l = grid.get(key(gx, gy));
        if (!l) grid.set(key(gx, gy), l = []);
        l.push(i);
      }
  });
  // Roads whose cells touch the box [x0, y0, x1, y1].
  const query = (x0, y0, x1, y1) => {
    const out = new Set();
    for (let gx = Math.floor(x0 / CELL); gx <= Math.floor(x1 / CELL); gx++)
      for (let gy = Math.floor(y0 / CELL); gy <= Math.floor(y1 / CELL); gy++) for (const i of grid.get(key(gx, gy)) || []) out.add(i);
    return out;
  };
  const inside = (lat, lon) => lat >= s && lat <= n && lon >= w && lon <= e;
  return { roads, bridges, toLocal, toLatLon, query, inside, attribution: doc.attribution };
}

// One spelling for a road name or route number, so "TR 404", "T-404" and "Township Road 404" match, and
// "Mill Road" matches "MILL RD".
const SUFFIX = { ROAD: 'RD', STREET: 'ST', AVENUE: 'AVE', AV: 'AVE', DRIVE: 'DR', LANE: 'LN', HIGHWAY: 'HWY', BOULEVARD: 'BLVD',
  COURT: 'CT', PLACE: 'PL', PARKWAY: 'PKWY', CIRCLE: 'CIR', TERRACE: 'TER', TRAIL: 'TRL', EXTENSION: 'EXT',
  NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W' };
export function roadKey(s) {
  const u = String(s ?? '').toUpperCase().replace(/[.'’"]/g, '').replace(/[-_/]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!u) return '';
  let m;
  if ((m = u.match(/^(?:US|U S)(?: ROUTE| RT| HWY| HIGHWAY)? ?(\d+[A-Z]?)$/))) return `US${m[1]}`;
  if ((m = u.match(/^(?:OH|OHIO|PA|SR|STATE ROUTE|STATE RT|ST RT|ST RTE|RT|RTE|ROUTE|STATE HWY|HWY|HIGHWAY) ?(\d+[A-Z]?)$/))) return `S${m[1]}`;
  if ((m = u.match(/^(?:TR|T|TWP|TWP RD|TOWNSHIP|TOWNSHIP RD|TOWNSHIP ROAD) ?(\d+[A-Z]?)$/))) return `T${m[1]}`;
  if ((m = u.match(/^(?:CR|C|CO|CO RD|COUNTY|COUNTY RD|COUNTY ROAD) ?(\d+[A-Z]?)$/))) return `C${m[1]}`;
  return u.split(' ').map((x) => SUFFIX[x] ?? x).join(' ');
}

export function roadKeys(road) {
  return road.keys ??= [road.name, ...road.alts].map(roadKey).filter(Boolean);
}

// The road under the car: nearest segment within maxM metres, preferring one that runs the way the car
// is heading (either direction of travel). Returns { i, d, k } (road index, score, segment index) or null.
export function nearestRoad(map, x, y, headingDeg = null, maxM = 30) {
  let best = null;
  for (const i of map.query(x - maxM, y - maxM, x + maxM, y + maxM)) {
    const xy = map.roads[i].xy;
    for (let k = 0; k + 3 < xy.length; k += 2) {
      const ax = xy[k], ay = xy[k + 1], dx = xy[k + 2] - ax, dy = xy[k + 3] - ay, L2 = dx * dx + dy * dy;
      const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)) : 0;
      let d = Math.hypot(x - ax - t * dx, y - ay - t * dy);
      if (d > maxM) continue;
      if (headingDeg !== null && L2 > 0) {
        const seg = Math.atan2(dx, dy) * 180 / Math.PI;
        const diff = Math.abs((((headingDeg - seg) % 180) + 270) % 180 - 90);   // 0…90°
        d += diff > 40 ? 25 : diff * 0.2;
      }
      if (!best || d < best.d) best = { i, d, k };
    }
  }
  return best;
}
