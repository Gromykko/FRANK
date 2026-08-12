// FRANK service worker. It keeps one complete, build-specific app shell so the
// app can open at the launch ramp without a connection. Forecast responses are
// deliberately never cached here: the forecast client owns its last-good data
// and freshness policy in localStorage.
const FRANK_CACHE_PREFIX = 'frank-';
const BUILD_ID = new URL(self.location.href).searchParams.get('build') ?? 'missing-build-id';
const CACHE = `${FRANK_CACHE_PREFIX}app-${encodeURIComponent(BUILD_ID)}`;
const SCOPE = self.registration.scope;
const BASE = new URL('', SCOPE).toString();
const INDEX = new URL('index.html', SCOPE).toString();
const PRECACHE_MANIFEST = new URL('frank-precache.json', SCOPE).toString();
const ASSET_ROOT = new URL('assets/', SCOPE);
const NAVIGATION_TIMEOUT_MS = 3000;

// Cache API matching normally honours Vary. Vite's asset requests can carry a
// different Origin header from the install-time requests, so ignoring Vary is
// necessary to avoid an offline white screen on otherwise identical URLs.
const MATCH = { ignoreVary: true };

// These stable files complete the installable shell. index.html and every
// generated /assets/ file are handled separately below.
const STATIC_SHELL = [
  'manifest.json',
  'favicon.svg',
  'icon-192.png',
  'icon-512.png',
  'apple-touch-icon.png',
].map((path) => new URL(path, SCOPE).toString());
const CACHE_FIRST_URLS = new Set([INDEX, PRECACHE_MANIFEST, ...STATIC_SHELL]);

function assertSuccessful(response, url) {
  if (!response?.ok || response.status === 206) {
    throw new Error(`Required shell resource failed (${response?.status ?? 'network error'}): ${url}`);
  }

  // A captive portal may follow a redirect and return a 200 HTML page. Never
  // let a cross-origin redirect become part of the verified offline shell.
  if (response.redirected && new URL(response.url).origin !== self.location.origin) {
    throw new Error(`Required shell resource redirected off-origin: ${url}`);
  }

  return response;
}

async function fetchRequired(url) {
  const response = await fetch(url, { cache: 'reload', credentials: 'same-origin' });
  return assertSuccessful(response, url);
}

function assetUrl(fileName) {
  if (typeof fileName !== 'string' || !fileName.startsWith('assets/')) {
    throw new Error('Invalid service-worker precache asset path');
  }

  const url = new URL(fileName, SCOPE);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(ASSET_ROOT.pathname)) {
    throw new Error(`Precache asset escaped the FRANK asset scope: ${fileName}`);
  }
  return url.toString();
}

function assetsReferencedByHtml(html) {
  return [...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)]
    .map((match) => new URL(match[1], SCOPE))
    .filter((url) => url.origin === self.location.origin && url.pathname.startsWith(ASSET_ROOT.pathname))
    .map((url) => url.toString());
}

async function installBuild() {
  let createdCache = false;

  try {
    const [indexResponse, manifestResponse] = await Promise.all([
      fetchRequired(INDEX),
      fetchRequired(PRECACHE_MANIFEST),
    ]);

    const contentType = indexResponse.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().includes('text/html')) {
      throw new Error('The service-worker shell was not HTML');
    }

    const [html, manifest] = await Promise.all([
      indexResponse.clone().text(),
      manifestResponse.clone().json(),
    ]);

    if (manifest?.buildId !== BUILD_ID || !Array.isArray(manifest.assets) || manifest.assets.length === 0) {
      throw new Error('The service-worker precache manifest does not match this build');
    }

    const assetUrls = [...new Set(manifest.assets.map(assetUrl))];
    const assetSet = new Set(assetUrls);
    const htmlAssets = assetsReferencedByHtml(html);
    if (htmlAssets.length === 0 || htmlAssets.some((url) => !assetSet.has(url))) {
      throw new Error('index.html references assets outside its build manifest');
    }

    // Fetch and validate the entire shell before opening the new cache. If any
    // response fails, the old worker/cache remains active and usable.
    const resourceUrls = [...STATIC_SHELL, ...assetUrls];
    const resourceResponses = await Promise.all(resourceUrls.map(fetchRequired));
    const cacheAlreadyExisted = (await caches.keys()).includes(CACHE);
    const cache = await caches.open(CACHE);
    createdCache = !cacheAlreadyExisted;

    // Cache one verified HTML response under both navigation forms. Cache puts
    // can still fail (for example due to quota), so any partial writes are
    // removed by the catch below.
    await cache.put(BASE, indexResponse.clone());
    await cache.put(INDEX, indexResponse.clone());
    await cache.put(PRECACHE_MANIFEST, manifestResponse.clone());
    await Promise.all(resourceUrls.map((url, index) => cache.put(url, resourceResponses[index])));

    // Deliberately do not call skipWaiting(). During an upgrade, an open tab
    // still imports chunks from the old build. Let the browser activate this
    // worker only after those old controlled tabs have gone away.
  } catch (error) {
    // A browser may check the OLD registered script URL after a new deployment:
    // new sw.js bytes then run with the old ?build= id and correctly fail the
    // manifest check. Never delete that id's pre-existing cache here -- it may
    // be the shell still serving the active worker. Only clean a cache this
    // install attempt actually created.
    if (createdCache) await caches.delete(CACHE);
    throw error;
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(installBuild());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => key.startsWith(FRANK_CACHE_PREFIX) && key !== CACHE)
        .map((key) => caches.delete(key)),
    );
    // Deliberately do not claim existing clients. Natural activation means new
    // navigations use this build without changing the controller underneath a
    // page that was already running another build.
  })());
});

async function matchCurrent(request) {
  const cache = await caches.open(CACHE);
  return cache.match(request, MATCH);
}

async function matchVerifiedShell() {
  const cache = await caches.open(CACHE);
  return (await cache.match(BASE, MATCH)) ?? cache.match(INDEX, MATCH);
}

async function shellOrThrow(reason) {
  const shell = await matchVerifiedShell();
  if (shell) return shell;
  throw reason instanceof Error ? reason : new Error('No verified offline shell is available');
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // This excludes the cross-origin forecast Worker, MET, DMI and MeteoAlarm.
  // Same-origin API-like paths are also excluded by the allowlist below.
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    const network = fetch(request).then((response) => {
      if (!response.ok) {
        throw new Error(`Navigation returned ${response.status}`);
      }
      return response;
    });
    let timeoutId;
    const timeoutFallback = new Promise((resolve) => {
      timeoutId = setTimeout(resolve, NAVIGATION_TIMEOUT_MS);
    }).then(matchVerifiedShell);

    event.respondWith(
      Promise.race([network, timeoutFallback])
        // A manually cleared cache should not turn the 3-second timer into an
        // undefined response; in that unusual case keep waiting for network.
        .then((response) => response ?? network)
        .catch(shellOrThrow)
        .finally(() => clearTimeout(timeoutId)),
    );
    return;
  }

  const isBuildAsset = url.pathname.startsWith(ASSET_ROOT.pathname);
  if (!isBuildAsset && !CACHE_FIRST_URLS.has(url.toString())) return;

  // Every current build asset was installed transactionally. Unknown/obsolete
  // asset URLs may use the network but are never added to this build's cache.
  event.respondWith(matchCurrent(request).then((cached) => cached ?? fetch(request)));
});
