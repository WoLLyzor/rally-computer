// Offline cache (A7: full function in airplane mode after the study period). Cache-first for the app's
// own files; anything cross-origin (the Claude API during the study period) goes to the network.
const VERSION = '5d73874e9c22';   // tools/build_precache.mjs writes a content hash here
const CACHE = `rally-${VERSION}`;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const list = await (await fetch('precache.json', { cache: 'no-store' })).json();
    const cache = await caches.open(CACHE);
    await cache.addAll(list);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE && key.startsWith('rally-')) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(event.request, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(event.request);
      if (res.ok) cache.put(event.request, res.clone());
      return res;
    } catch {
      return (await cache.match('index.html')) || Response.error();
    }
  })());
});
