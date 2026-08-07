// FRANK service worker. Goal: the app reliably opens offline at the launch
// ramp (with no signal) and shows the last forecast the client saved in
// localStorage. It caches the app SHELL + the content-hashed build assets; it
// deliberately does NOT cache the forecast API responses (those are cross-origin
// and the client already keeps last-good data in localStorage — a stale SW copy
// would only get in the way).
const CACHE = 'frank-v0.4.0';
const scope = self.registration.scope; // e.g. https://…/FRANK/
const BASE = new URL('', scope).toString();

// Every cache read MUST pass this. The Cache API honours `Vary`, and our
// entries are stored against requests the SW made (no `Origin` header), while
// Vite emits the asset tags with `crossorigin` — so the PAGE requests them in
// CORS mode WITH an `Origin`. Any host that sends `Vary` (vite preview sends
// `Vary: Origin`) then misses on every asset, falls through to the network,
// and offline that rejects: the navigation still serves the cached shell, so
// the user gets a correct title above a completely blank body. Verified: this
// is exactly what `npm run preview` does today. GitHub Pages only escapes it
// by sending `Vary: Accept-Encoding`, which happens to match.
const MATCH = { ignoreVary: true };

// Stable-named shell files (the hashed /assets/* bundles can't be listed here —
// they're cached at runtime on first fetch instead).
const SHELL = ['', 'index.html', 'manifest.json', 'favicon.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png']
  .map((path) => new URL(path, scope).toString());

// The hashed bundle names change every build, so they can't be listed above.
// Read them out of index.html instead. Without this the app is UNBOOTABLE
// offline after a first visit: the JS/CSS are requested before this worker
// activates, so they never pass through the fetch handler and never get cached
// — install the PWA, drive to the ramp with no signal, get a white screen.
// In dev, index.html points at /src/*, which this pattern deliberately misses.
async function precacheBuildAssets(cache) {
  try {
    const res = await fetch(new URL('index.html', scope).toString(), { cache: 'reload' });
    if (!res.ok) return;
    const html = await res.text();
    const assets = [...html.matchAll(/(?:src|href)="([^"]*\/assets\/[^"]+)"/g)]
      .map((match) => new URL(match[1], scope).toString());
    if (assets.length) await cache.addAll([...new Set(assets)]);
  } catch {
    // Offline or a partial fetch during install — the runtime cache-first
    // handler below still populates these on the next successful load.
  }
}

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then(async (cache) => {
        // allSettled, not addAll: addAll is atomic, so ONE failed shell URL (a
        // flaky first load, a renamed icon, a captive portal redirect) rejected
        // the whole install — skipWaiting never ran and the user silently got
        // no offline capability at all. Partial precache beats none.
        await Promise.allSettled(SHELL.map((url) => cache.add(url)));
        await precacheBuildAssets(cache);
      })
      .then(() => self.skipWaiting())
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
    const fromCache = () => caches.match(req, MATCH).then((r) => r || caches.match(BASE, MATCH));
    const network = fetch(req).then((res) => {
      // Only a healthy page may become the offline shell — caching a 404/500
      // navigation response would replace the app with an error page at the
      // one moment the cache matters (offline at the launch ramp).
      if (res.ok) {
        const copy = res.clone();
        e.waitUntil(caches.open(CACHE).then((cache) => cache.put(BASE, copy)));
      }
      return res;
    });
    // A dead network REJECTS; one bar of signal or a marina captive portal
    // that accepts the connection and then stalls does not — it just hangs,
    // for up to ~300s in Chrome, showing a white screen while a perfectly good
    // shell sits in the cache. Being fully offline worked better than being
    // barely online. Race the network against the cache instead of waiting.
    const timedFallback = new Promise((resolve) => setTimeout(resolve, 3000))
      .then(fromCache);
    e.respondWith(
      Promise.race([network, timedFallback])
        // Cache miss inside the race window: keep waiting on the network.
        .then((res) => res || network)
        .catch(fromCache)
    );
    return;
  }

  // Cache-first is only safe for URLs whose content can never change: the
  // content-hashed build assets and the precached shell files above. Anything
  // else same-origin goes straight to the network — above all Vite's dev
  // modules, which serve changing content behind a STABLE url (/src/App.tsx).
  // Caching those made every source edit invisible in the browser until the
  // cache was manually cleared.
  if (!url.pathname.includes('/assets/') && !SHELL.includes(url.toString())) return;

  // Built assets are content-hashed (immutable), so cache-first is safe — and we
  // populate the cache on the first successful fetch so a later offline visit has
  // the code it needs to boot.
  e.respondWith(
    caches.match(req, MATCH).then((cached) => {
      if (cached) return cached;
      // No cached copy and the network failed: nothing to serve — let the
      // request reject. (A `.catch(() => cached)` here would always resolve
      // undefined, since this branch only runs when `cached` was falsy.)
      return fetch(req).then((res) => {
        // 206 is `ok` but cache.put rejects on it.
        if (res.ok && res.status !== 206) {
          const copy = res.clone();
          e.waitUntil(caches.open(CACHE).then((cache) => cache.put(req, copy)));
        }
        return res;
      });
    })
  );
});
