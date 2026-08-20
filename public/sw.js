// FRANK service worker. Each worker owns one complete, verified app shell.
// Forecast responses are deliberately never cached here: the forecast client
// owns its last-good data and freshness policy in localStorage.
const APP_CACHE_PREFIX = 'frank-app-';
const BUILD_ID = new URL(self.location.href).searchParams.get('build') ?? 'missing-build-id';
const CACHE = `${APP_CACHE_PREFIX}${encodeURIComponent(BUILD_ID)}`;
const SCOPE = self.registration.scope;
const BASE = new URL('', SCOPE).toString();
const INDEX = new URL('index.html', SCOPE).toString();
const RELEASE_DESCRIPTOR = new URL('frank-release.json', SCOPE).toString();
const PRECACHE_MANIFEST = new URL('frank-precache.json', SCOPE).toString();
const CACHE_METADATA = new URL('__frank-shell-metadata__', SCOPE).toString();
const ASSET_ROOT = new URL('assets/', SCOPE);
const ACTIVATION_POLL_MS = 100;
const ACTIVATION_WAIT_MS = 2_000;

// Cache API matching normally honours Vary. Vite's asset requests can carry a
// different Origin header from the install-time requests, so ignoring Vary is
// necessary to avoid an offline white screen on otherwise identical URLs.
const MATCH = { ignoreVary: true };

const STATIC_SHELL_PATHS = [
  'manifest.json',
  'favicon.svg',
  'icon-192.png',
  'icon-512.png',
  'apple-touch-icon.png',
];
const STATIC_SHELL = STATIC_SHELL_PATHS.map((path) => new URL(path, SCOPE).toString());
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
  const response = await fetch(url, {
    cache: 'no-store',
    credentials: 'same-origin',
  });
  return assertSuccessful(response, url);
}

function releaseCheckUrl() {
  const url = new URL(RELEASE_DESCRIPTOR);
  url.searchParams.set('build', BUILD_ID);
  url.searchParams.set('check', `${Date.now()}`);
  return url.toString();
}

function scopedUrl(value, expectedPath, label) {
  if (typeof value !== 'string') throw new Error(`The release descriptor has no ${label}`);
  const url = new URL(value, SCOPE);
  const scope = new URL(SCOPE);
  const expected = new URL(expectedPath, SCOPE);
  if (url.origin !== scope.origin || url.pathname !== expected.pathname) {
    throw new Error(`The release descriptor ${label} escaped the FRANK scope`);
  }
  return url;
}

function parseReleaseDescriptor(value) {
  if (value?.schemaVersion !== 1 || value?.buildId !== BUILD_ID) {
    throw new Error('The release descriptor does not match this build');
  }

  const baseUrl = scopedUrl(value.baseUrl, '', 'base URL');
  if (baseUrl.toString() !== BASE) {
    throw new Error('The release descriptor has the wrong app base URL');
  }

  const serviceWorkerUrl = scopedUrl(value.serviceWorkerUrl, 'sw.js', 'service-worker URL');
  if (serviceWorkerUrl.searchParams.get('build') !== BUILD_ID) {
    throw new Error('The release descriptor service worker does not match this build');
  }

  const shellUrl = scopedUrl(value.shellUrl, 'index.html', 'shell URL');
  const manifestUrl = scopedUrl(value.precacheManifestUrl, 'frank-precache.json', 'precache manifest URL');
  if (
    shellUrl.searchParams.get('frank-build') !== BUILD_ID
    || manifestUrl.searchParams.get('frank-build') !== BUILD_ID
  ) {
    throw new Error('The release descriptor shell URLs do not match this build');
  }

  if (!Array.isArray(value.staticShellUrls) || value.staticShellUrls.length !== STATIC_SHELL_PATHS.length) {
    throw new Error('The release descriptor has an incomplete static shell');
  }
  const staticShellUrls = value.staticShellUrls.map((item, index) => {
    const url = scopedUrl(item, STATIC_SHELL_PATHS[index], `static shell URL ${index + 1}`);
    if (url.searchParams.get('frank-build') !== BUILD_ID) {
      throw new Error('The release descriptor static shell does not match this build');
    }
    return url.toString();
  });

  const builtAt = Date.parse(value.builtAt);
  if (!Number.isFinite(builtAt)) throw new Error('The release descriptor has an invalid build time');

  return {
    builtAt: value.builtAt,
    shellUrl: shellUrl.toString(),
    manifestUrl: manifestUrl.toString(),
    staticShellUrls,
  };
}

function assetUrl(fileName) {
  if (typeof fileName !== 'string' || !fileName.startsWith('assets/')) {
    throw new Error('Invalid service-worker precache asset path');
  }

  const url = new URL(fileName, SCOPE);
  if (
    url.origin !== self.location.origin
    || !url.pathname.startsWith(ASSET_ROOT.pathname)
    || url.search
    || url.hash
  ) {
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

function buildReferencedByHtml(html) {
  return html.match(/<meta\s+name=["']frank-build-id["']\s+content=["']([^"']+)["']/i)?.[1];
}

async function cacheHasCompleteBuild(cache, urls) {
  try {
    const metadata = await cache.match(CACHE_METADATA, MATCH);
    const value = await metadata?.json();
    if (value?.schemaVersion !== 1 || value?.buildId !== BUILD_ID) return false;
    const matches = await Promise.all(urls.map((url) => cache.match(url, MATCH)));
    return matches.every(Boolean);
  } catch {
    return false;
  }
}

async function installBuild() {
  let createdCache = false;

  try {
    const releaseResponse = await fetchRequired(releaseCheckUrl());
    const release = parseReleaseDescriptor(await releaseResponse.clone().json());
    const [indexResponse, manifestResponse] = await Promise.all([
      fetchRequired(release.shellUrl),
      fetchRequired(release.manifestUrl),
    ]);

    const contentType = indexResponse.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().includes('text/html')) {
      throw new Error('The service-worker shell was not HTML');
    }

    const [html, manifest] = await Promise.all([
      indexResponse.clone().text(),
      manifestResponse.clone().json(),
    ]);

    if (
      manifest?.schemaVersion !== 1
      || manifest?.buildId !== BUILD_ID
      || !Array.isArray(manifest.assets)
      || manifest.assets.length === 0
    ) {
      throw new Error('The service-worker precache manifest does not match this build');
    }

    const assetUrls = [...new Set(manifest.assets.map(assetUrl))];
    const assetSet = new Set(assetUrls);
    const htmlAssets = assetsReferencedByHtml(html);
    if (buildReferencedByHtml(html) !== BUILD_ID) {
      throw new Error('index.html does not identify this build');
    }
    if (htmlAssets.length === 0 || htmlAssets.some((url) => !assetSet.has(url))) {
      throw new Error('index.html references assets outside its build manifest');
    }

    // Fetch and validate the entire shell before opening the new cache. If any
    // response fails, the active worker and its previous cache remain usable.
    const fetchedUrls = [...release.staticShellUrls, ...assetUrls];
    const fetchedResponses = await Promise.all(fetchedUrls.map(fetchRequired));
    const canonicalUrls = [
      BASE,
      INDEX,
      RELEASE_DESCRIPTOR,
      PRECACHE_MANIFEST,
      ...STATIC_SHELL,
      ...assetUrls,
    ];
    const cacheNames = await caches.keys();

    if (cacheNames.includes(CACHE)) {
      const existing = await caches.open(CACHE);
      if (await cacheHasCompleteBuild(existing, canonicalUrls)) return;
      await caches.delete(CACHE);
    }

    const cache = await caches.open(CACHE);
    createdCache = true;
    await cache.put(BASE, indexResponse.clone());
    await cache.put(INDEX, indexResponse.clone());
    await cache.put(RELEASE_DESCRIPTOR, releaseResponse.clone());
    await cache.put(PRECACHE_MANIFEST, manifestResponse.clone());
    await Promise.all(
      release.staticShellUrls.map((url, index) => cache.put(STATIC_SHELL[index], fetchedResponses[index])),
    );
    await Promise.all(
      assetUrls.map((url, index) => cache.put(url, fetchedResponses[release.staticShellUrls.length + index])),
    );
    await cache.put(CACHE_METADATA, new Response(JSON.stringify({
      schemaVersion: 1,
      buildId: BUILD_ID,
      builtAt: release.builtAt,
      installedAt: new Date().toISOString(),
    }), { headers: { 'content-type': 'application/json' } }));

    // No unconditional skipWaiting(): open tabs can still import lazy chunks
    // from the active build. Natural activation happens after those tabs close.
  } catch (error) {
    if (createdCache) await caches.delete(CACHE);
    throw error;
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(installBuild());
});

async function cacheAge(name, index) {
  try {
    const cache = await caches.open(name);
    const response = await cache.match(CACHE_METADATA, MATCH);
    const metadata = await response?.json();
    const time = Date.parse(metadata?.installedAt ?? metadata?.builtAt ?? '');
    return { name, time: Number.isFinite(time) ? time : index };
  } catch {
    return { name, time: index };
  }
}

async function retainCurrentAndPreviousShells() {
  const keys = await caches.keys();
  const appCaches = keys.filter((key) => key.startsWith(APP_CACHE_PREFIX));
  const records = await Promise.all(appCaches.map(cacheAge));
  const previous = records
    .filter(({ name }) => name !== CACHE)
    .sort((a, b) => a.time - b.time)
    .at(-1)?.name;
  const retained = new Set([CACHE, previous].filter(Boolean));
  await Promise.all(
    appCaches
      .filter((key) => !retained.has(key))
      .map((key) => caches.delete(key)),
  );
}

self.addEventListener('activate', (event) => {
  event.waitUntil(retainCurrentAndPreviousShells());
  // Deliberately no clients.claim(). Existing documents change builds only at
  // a clean navigation, and the previous shell remains available for old lazy
  // chunks during the handover.
});

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function scopedWindowClients() {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return clients.filter((client) => client.url.startsWith(SCOPE));
}

async function activateWhenIdle(buildId) {
  if (buildId !== BUILD_ID) return;
  const deadline = Date.now() + ACTIVATION_WAIT_MS;
  do {
    if ((await scopedWindowClients()).length === 0) {
      await self.skipWaiting();
      return;
    }
    await delay(ACTIVATION_POLL_MS);
  } while (Date.now() < deadline);
}

self.addEventListener('message', (event) => {
  if (event.data?.type !== 'FRANK_ACTIVATE_WHEN_IDLE') return;
  event.waitUntil(activateWhenIdle(event.data.buildId));
});

async function matchCurrent(request) {
  const cache = await caches.open(CACHE);
  return cache.match(request, MATCH);
}

async function matchPrevious(request) {
  const keys = (await caches.keys())
    .filter((key) => key.startsWith(APP_CACHE_PREFIX) && key !== CACHE)
    .reverse();
  for (const key of keys) {
    const response = await (await caches.open(key)).match(request, MATCH);
    if (response) return response;
  }
  return undefined;
}

async function matchVerifiedShell() {
  const cache = await caches.open(CACHE);
  return (await cache.match(BASE, MATCH)) ?? cache.match(INDEX, MATCH);
}

async function verifiedShellOrRecover() {
  const shell = await matchVerifiedShell();
  if (shell) return shell;

  // Recover only if the currently published descriptor still names this exact
  // build. installBuild rejects a newer descriptor, preventing A's active
  // worker from ever returning B's HTML with A's runtime.
  await installBuild();
  const recovered = await matchVerifiedShell();
  if (recovered) return recovered;
  throw new Error('No verified FRANK shell is available');
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // This excludes the cross-origin forecast Worker, MET, DMI and MeteoAlarm.
  // Same-origin API-like paths are also excluded by the allowlist below.
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    // The active worker always returns its own cached HTML. A newer release is
    // downloaded into a waiting worker, never mixed into this document.
    event.respondWith(verifiedShellOrRecover());
    return;
  }

  const isBuildAsset = url.pathname.startsWith(ASSET_ROOT.pathname);
  if (!isBuildAsset && !CACHE_FIRST_URLS.has(url.toString())) return;

  event.respondWith((async () => {
    const current = await matchCurrent(request);
    if (current) return current;
    if (isBuildAsset) {
      const previous = await matchPrevious(request);
      if (previous) return previous;
    }
    return fetch(request);
  })());
});
