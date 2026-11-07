// Service worker: aplikace jde přidat na plochu a bez signálu ukáže poslední stažená data.
// Vždy se nejdřív ptá sítě (žádná zastaralá data, když je spojení), cache je jen záloha.
const CACHE = 'skialp-v2';
const BASE = new URL('./', self.location).pathname; // '/' lokálně, '/skialp/' na GitHub Pages

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

/** Klíč do cache bez parametrů, které se mění při každém dotazu (obcházení cache CDN). */
function cacheKey(url) {
  const u = new URL(url);
  for (const p of ['v', 't', 'force']) u.searchParams.delete(p);
  return u.pathname + u.search;
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  const path = url.pathname.slice(BASE.length - 1);
  // snímky kamer a výškový model necacheujeme (velké, rychle zastarávají)
  if (path.startsWith('/api/webcam') || path.startsWith('/tiles/')) return;
  e.respondWith((async () => {
    const key = cacheKey(url);
    try {
      const res = await fetch(e.request);
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(key, copy)).catch(() => {});
      }
      return res;
    } catch (err) {
      const hit = await caches.match(key) || await caches.match(url.pathname, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  })());
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then(list =>
    list.length ? list[0].focus() : self.clients.openWindow(BASE)));
});
