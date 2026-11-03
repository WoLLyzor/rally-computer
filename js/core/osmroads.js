// Roads from OpenStreetMap (the Overpass API) for any rally area, as the same compact map the app ships for
// Ashtabula–Erie (app/map/roads.json, read by mapview.decodeMap): roads split where they meet, with their
// class, name, other names and route numbers, and covered bridges. Fetched in 0.1° tiles, so an area grows
// as the route needs it and each tile is fetched once.

export const TILE = 0.1;   // degrees
const Q = 1e5;             // coordinates in 1e-5 degrees, delta-coded (as roads.json)
const CLASSES = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'service', 'track'];
const KINDS = 'motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|track|road|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link';

export const tileId = (lat, lon) => `${Math.floor(lat / TILE)}_${Math.floor(lon / TILE)}`;
export function tileBox(id) {   // [s, w, n, e]
  const [a, o] = id.split('_').map(Number);
  return [a * TILE, o * TILE, (a + 1) * TILE, (o + 1) * TILE].map((x) => Math.round(x * 1e6) / 1e6);
}
// The tiles within `rings` of the one holding (lat, lon): rings 1 is the 3×3 block around it.
export function tilesAround(lat, lon, rings = 1) {
  const a0 = Math.floor(lat / TILE), o0 = Math.floor(lon / TILE), out = [];
  for (let a = a0 - rings; a <= a0 + rings; a++) for (let o = o0 - rings; o <= o0 + rings; o++) out.push(`${a}_${o}`);
  return out;
}

// The Overpass query for one tile: drivable roads, not driveways or parking aisles, with tags, node ids and
// coordinates.
export function overpassQuery([s, w, n, e]) {
  return `[out:json][timeout:90];way["highway"~"^(${KINDS})$"]["service"!~"^(driveway|parking_aisle|drive-through|emergency_access)$"]["access"!~"^(private|no)$"](${s},${w},${n},${e});out body geom qt;`;
}

const cls = (hw) => {
  const i = CLASSES.indexOf(String(hw).replace(/_link$/, ''));
  return i >= 0 ? i : 6;   // living_street, road: like residential
};
const listOf = (v) => (v ? String(v).split(';').map((x) => x.trim()).filter(Boolean) : []);

// Overpass ways (elements with tags, nodes, geometry) from any number of tiles -> a roads.json-style doc.
// Ways are split at every node another way shares, so roads meet at their end points (routeproj.buildGraph).
export function osmToDoc(ways, { attribution = '© OpenStreetMap contributors' } = {}) {
  const seen = new Set(), use = new Map(), list = [];
  for (const w of ways) {
    if (w.type !== 'way' || !w.nodes || !w.geometry || w.nodes.length !== w.geometry.length || seen.has(w.id)) continue;   // a way in two tiles: once
    seen.add(w.id); list.push(w);
    w.nodes.forEach((id, i) => use.set(id, (use.get(id) || 0) + (i === 0 || i === w.nodes.length - 1 ? 2 : 1)));
  }
  const names = [''], nameIdx = new Map([['', 0]]);
  const nid = (s) => { if (!s) return 0; if (!nameIdx.has(s)) { nameIdx.set(s, names.length); names.push(s); } return nameIdx.get(s); };
  const roads = [], bridges = [];
  let s = 90, wB = 180, n = -90, eB = -180;
  for (const w of list) {
    const t = w.tags || {}, refs = listOf(t.ref), label = t.name || refs[0] || '';
    const alts = [...new Set([...listOf(t.alt_name), ...listOf(t.old_name), ...listOf(t.official_name), ...refs])].filter((x) => x && x !== label).map(nid);
    const c = cls(t.highway), lab = nid(label);
    // Split where another way meets it (a shared node), so junctions are road ends.
    let from = 0;
    for (let i = 1; i < w.nodes.length; i++) {
      if (i < w.nodes.length - 1 && (use.get(w.nodes[i]) || 0) < 2) continue;
      const flat = [];
      let pa = 0, po = 0;
      for (let j = from; j <= i; j++) {
        const { lat, lon } = w.geometry[j], a = Math.round(lat * Q), o = Math.round(lon * Q);
        flat.push(a - pa, o - po); pa = a; po = o;
        if (lat < s) s = lat; if (lat > n) n = lat; if (lon < wB) wB = lon; if (lon > eB) eB = lon;
      }
      roads.push([c, lab, alts.length ? alts : 0, flat]);
      from = i;
    }
    if (t.bridge && t.bridge !== 'no' && (t.covered === 'yes' || t['bridge:structure'] === 'covered')) {
      const m = w.geometry[Math.floor(w.geometry.length / 2)];
      bridges.push([Math.round(m.lat * Q), Math.round(m.lon * Q), nid(t['bridge:name'] || t.name || 'Covered bridge')]);
    }
  }
  return { v: 1, attribution, created: new Date().toISOString(), bbox: [s, wB, n, eB], q: Q, classes: CLASSES, names, roads, bridges, osm: true };
}
