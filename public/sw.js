// FRANK service worker. Goal: the app reliably opens offline at the launch
// ramp (with no signal) and shows the last forecast the client saved in
// localStorage. It caches the app SHELL + the content-hashed build assets; it
// deliberately does NOT cache the forecast API responses (those are cross-origin
// and the client already keeps last-good data in localStorage — a stale SW copy
// would only get in the way).
const CACHE = 'frank-v0.2.2';
const scope = self.registration.scope; // e.g. https://…/FRANK/
const BASE = new URL('', scope).toString();

// Stable-named shell files (the hashed /assets/* bundles can't be listed here —
// they're cached at runtime on first fetch instead).
const SHELL = ['', 'index.html', 'manifest.json', 'favicon.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png']
  .map((path) => new URL(path, scope).toString());

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Only same-origin traffic (the app shell + built assets). The forecast Worker,
  // MET, DMI and MeteoAlarm are cross-origin and go straight to network.
  if (url.origin !== self.location.origin) return;

  // App navigations: network-first so a fresh deploy is picked up, but fall back
  // to the cached shell so the app still opens with no connection.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          // Only a healthy page may become the offline shell — caching a 404/500
          // navigation response would replace the app with an error page at the
          // one moment the cache matters (offline at the launch ramp).
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(BASE, copy));
          }
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match(BASE)))
    );
    return;
  }

  // Built assets are content-hashed (immutable), so cache-first is safe — and we
  // populate the cache on the first successful fetch so a later offline visit has
  // the code it needs to boot.
  e.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      // No cached copy and the network failed: nothing to serve — let the
      // request reject. (A `.catch(() => cached)` here would always resolve
      // undefined, since this branch only runs when `cached` was falsy.)
      return fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      });
    })
  );
});
