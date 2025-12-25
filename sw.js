// sw.js  — place this file next to your HTML (e.g., /projects/sw.js)
const CACHE_PREFIX = 'inch-calc';
const VERSION = '2025-12-24-3';            // bump this when you change assets
const CACHE_NAME = `${CACHE_PREFIX}-${VERSION}`;

const ASSETS = [
  './',                                   // folder index (helps GH Pages)
  './index.html',
  './styles.css',
  './app.js',             // <-- change if your entry html has a different name
  './manifest.webmanifest',
  './sw.js',
  './calcicon-192.png',
  './calcicon-512.png',
  './maskable-512.png',
  './apple-touch-icon.png'
];

// -------- Install: precache app shell --------
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

// -------- Activate: cleanup + take control --------
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys
        .filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME)
        .map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

// Optional: minimal offline page (only used if neither network nor cache has the nav)
const OFFLINE_HTML = `
<!doctype html><meta charset="utf-8">
<title>Inch Calc — Offline</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:system-ui;margin:2rem;color:#eee;background:#0e2a2a}
.card{max-width:640px;margin:auto;background:#122525;border-radius:12px;padding:16px}
h1{margin:0 0 8px}p{opacity:.9}</style>
<div class="card"><h1>Offline</h1><p>This app is installed but the page wasn’t in cache yet. Reconnect and open it once to prime offline use.</p></div>
`;

// -------- Fetch: choose strategies --------
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // 1) Navigations (HTML pages): network-first, fallback to cache, then offline page
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const net = await fetch(req);
        // Stash a copy for offline next time
        const cache = await caches.open(CACHE_NAME);
        cache.put(req, net.clone());
        return net;
      } catch {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(req);
        if (cached) return cached;
        return new Response(OFFLINE_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' }});
      }
    })());
    return;
  }

  // 2) Same-origin assets: cache-first
  const sameOrigin = new URL(req.url).origin === self.location.origin;
  if (sameOrigin) {
    event.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      try {
        const net = await fetch(req);
        const cache = await caches.open(CACHE_NAME);
        cache.put(req, net.clone());
        return net;
      } catch {
        return caches.match('./index.html'); // last resort
      }
    })());
    return;
  }

  // 3) Cross-origin (CDNs): network, fallback to cache if previously seen
  event.respondWith((async () => {
    try {
      const net = await fetch(req);
      // Cache a copy for resilience
      const cache = await caches.open(CACHE_NAME);
      cache.put(req, net.clone());
      return net;
    } catch {
      const cached = await caches.match(req);
      if (cached) return cached;
      throw new Error('Network failed and no cache');
    }
  })());
});

// -------- Message channel: allow page to trigger skipWaiting --------
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});






