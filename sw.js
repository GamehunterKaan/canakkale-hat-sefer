// Service worker — Web Push + offline caching for app shell, JSON data, tiles.
// Bump VERSION to invalidate every cache on the next activate.

const VERSION     = 'v4';
const SHELL_CACHE = `bm-shell-${VERSION}`;
const DATA_CACHE  = `bm-data-${VERSION}`;
const TILE_CACHE  = `bm-tiles-${VERSION}`;
const TILE_MAX    = 7000;  // covers all of MAP_BOUNDS at z13-16 (~5500 tiles) plus headroom
const SHELL_ASSETS = [
  './',
  './index.html',
  './site.webmanifest',
  './icons/web-app-manifest-192x192.png',
  './icons/web-app-manifest-512x512.png',
  './icons/favicon-96x96.png',
  './icons/favicon.svg',
  './icons/apple-touch-icon.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(SHELL_CACHE)
      .then(c => Promise.all(SHELL_ASSETS.map(u =>
        c.add(u).catch(() => {})   // tolerate one-off CDN hiccup; don't fail install
      )))
      // Don't auto skipWaiting — wait for the page to ask via SKIP_WAITING so
      // the in-page "Update available" toast can prompt the user instead of
      // swapping the SW out from under them mid-interaction.
  );
});

self.addEventListener('message', e => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', e => {
  const keep = new Set([SHELL_CACHE, DATA_CACHE, TILE_CACHE]);
  e.waitUntil(
    caches.keys()
      .then(names => Promise.all(names.map(n => keep.has(n) ? null : caches.delete(n))))
      .then(() => clients.claim())
  );
});

// ── Fetch handler: routes by URL pattern ────────────────────────────────────
async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const networkPromise = fetch(req).then(resp => {
    if (resp.ok) cache.put(req, resp.clone());
    return resp;
  }).catch(() => null);
  return cached || networkPromise || fetch(req);
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) return cached;
  const resp = await fetch(req);
  if (resp.ok) cache.put(req, resp.clone());
  return resp;
}

async function cacheFirstTile(req) {
  const cache = await caches.open(TILE_CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  const resp = await fetch(req);
  if (resp.ok) {
    cache.put(req, resp.clone()).then(async () => {
      // FIFO trim: simple approximation — drop oldest entries when over cap
      const keys = await cache.keys();
      if (keys.length > TILE_MAX) {
        const excess = keys.length - TILE_MAX;
        for (let i = 0; i < excess; i++) await cache.delete(keys[i]);
      }
    });
  }
  return resp;
}

async function networkFirstShell(req) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const resp = await fetch(req);
    if (resp.ok) cache.put(req, resp.clone());
    return resp;
  } catch {
    const cached = await cache.match(req) || await cache.match('./index.html') || await cache.match('./');
    if (cached) return cached;
    throw new Error('offline and no cached shell');
  }
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  // Same-origin HTML / navigation → network-first, fall back to cached shell
  if (sameOrigin && (req.mode === 'navigate' || req.destination === 'document' || url.pathname.endsWith('.html') || url.pathname === '/' )) {
    event.respondWith(networkFirstShell(req));
    return;
  }

  // Same-origin JSON data → stale-while-revalidate. A cache-busting query
  // (?_=…, used by the app's background freshness check / manual refresh) is
  // passed straight to the network and NOT cached, so those one-off URLs don't
  // pile up in DATA_CACHE. The app falls back to the plain (cached) URL offline.
  if (sameOrigin && url.pathname.startsWith('/data/') && url.pathname.endsWith('.json')) {
    if (url.search) return; // network passthrough, no cache
    event.respondWith(staleWhileRevalidate(req, DATA_CACHE));
    return;
  }

  // Same-origin shell assets (icons, manifest, etc.) → cache-first
  if (sameOrigin) {
    event.respondWith(cacheFirst(req, SHELL_CACHE));
    return;
  }

  // Leaflet CDN → cache-first
  if (url.hostname === 'unpkg.com' && url.pathname.includes('/leaflet@')) {
    event.respondWith(cacheFirst(req, SHELL_CACHE));
    return;
  }

  // OSM tiles → cache-first with FIFO cap
  if (url.hostname.endsWith('.tile.openstreetmap.org')) {
    event.respondWith(cacheFirstTile(req));
    return;
  }

  // kentkart live data, everything else → passthrough (no cache)
});

self.addEventListener('push', event => {
  let title = 'Çanakkale Hat & Sefer';
  let body  = 'Otobüs yaklaşıyor.';
  let tag   = 'bus-notify';

  if (event.data) {
    try {
      const d = event.data.json();
      title = d.title || title;
      body  = d.body  || body;
      tag   = d.tag   || tag;
    } catch {}
  }

  const base = self.registration.scope;
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      icon:  base + 'icons/web-app-manifest-192x192.png',
      badge: base + 'icons/favicon-96x96.png',
      data:  { url: base },
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = event.notification.data?.url || self.location.origin;
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.startsWith(target) && 'focus' in c) return c.focus();
      }
      return clients.openWindow(target);
    })
  );
});
