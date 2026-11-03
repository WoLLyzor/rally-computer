// The rally area's roads, downloaded from OpenStreetMap (core/osmroads.js) in 0.1° tiles and kept on the
// tablet (Cache Storage), so the route lock and the Drive map work anywhere, and with no signal once
// downloaded. Best done at home before the rally: the public Overpass servers can take a minute or more a
// tile, so each tile goes to three of them at once and the first answer wins.

import { overpassQuery, osmToDoc, tileBox, tilesAround } from '../core/osmroads.js';

const SERVERS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
const CACHE = 'rally-osm-v1';
const key = (id) => `osm-tile/${id}`;

async function cache() { return caches.open(CACHE); }
export async function hasTile(id) { try { return !!(await (await cache()).match(key(id))); } catch { return false; } }
async function readTile(id) { const r = await (await cache()).match(key(id)); return r ? r.json() : null; }

// One tile from whichever server answers first; the others are cancelled.
async function fetchTile(id, timeoutMs = 240000) {
  const body = 'data=' + encodeURIComponent(overpassQuery(tileBox(id)));
  const ctrls = SERVERS.map(() => new AbortController());
  const timer = setTimeout(() => ctrls.forEach((c) => c.abort()), timeoutMs);
  try {
    const won = await Promise.any(SERVERS.map((url, i) => fetch(url, { method: 'POST', body, signal: ctrls[i].signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' } })
      .then(async (r) => { if (!r.ok) throw new Error(`${r.status}`); const j = await r.json(); if (!Array.isArray(j.elements)) throw new Error('no elements'); return { i, j }; })));
    ctrls.forEach((c, i) => { if (i !== won.i) c.abort(); });
    return won.j;
  } finally { clearTimeout(timer); }
}

// Make sure these tiles are on the tablet (two at a time). onProgress(done, total, id).
export async function ensureTiles(ids, onProgress = () => {}) {
  const todo = [];
  for (const id of ids) if (!(await hasTile(id))) todo.push(id);
  let done = ids.length - todo.length;
  onProgress(done, ids.length, null);
  const c = await cache();
  const work = async () => {
    while (todo.length) {
      const id = todo.shift();
      const j = await fetchTile(id);
      await c.put(key(id), new Response(JSON.stringify({ id, at: Date.now(), elements: j.elements }), { headers: { 'Content-Type': 'application/json' } }));
      onProgress(++done, ids.length, id);
    }
  };
  await Promise.all([work(), work()]);
}

// The downloaded tiles as one map doc (roads.json format), or null when none of them are on the tablet.
export async function areaDoc(ids) {
  const ways = [];
  for (const id of ids) { const t = await readTile(id).catch(() => null); if (t) ways.push(...t.elements); }
  return ways.length ? osmToDoc(ways) : null;
}

// The tiles for an area around a place: rings 1 is the 3×3 block, about 33 × 25 km; the route lock adds the
// tiles beyond where the route goes (main.js growArea).
export const areaTiles = (lat, lon, rings = 1) => tilesAround(lat, lon, rings);

// A town or address to a place, through OpenStreetMap's search (Nominatim). Returns { lat, lon, name } or null.
export async function findPlace(q) {
  const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`, { headers: { Accept: 'application/json' } });
  if (!r.ok) return null;
  const [hit] = await r.json();
  return hit ? { lat: Number(hit.lat), lon: Number(hit.lon), name: hit.display_name } : null;
}
