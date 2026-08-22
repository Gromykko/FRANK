// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

const SCOPE = 'https://example.test/FRANK/';
const BUILD_A = 'build-a';
const BUILD_B = 'build-b';
const RELEASE = `${SCOPE}frank-release.json`;
const MANIFEST = `${SCOPE}frank-precache.json`;
const METADATA = `${SCOPE}__frank-shell-metadata__`;
const STATIC_SHELL = [
  'theme-init.js',
  'manifest.json',
  'favicon.svg',
  'icon-192.png',
  'icon-512.png',
  'apple-touch-icon.png',
];

type RequestLike = string | { url: string; method?: string; mode?: string };

function cacheName(buildId: string) {
  return `frank-app-${encodeURIComponent(buildId)}`;
}

function buildAssets(buildId: string) {
  return [
    `assets/WeatherCharts-${buildId}.js`,
    `assets/index-${buildId}.js`,
    `assets/index-${buildId}.css`,
  ];
}

function indexHtml(buildId: string) {
  return `<!doctype html>
    <meta name="frank-build-id" content="${buildId}">
    <div id="root">${buildId}</div>
    <script type="module" src="/FRANK/assets/index-${buildId}.js"></script>
    <link rel="stylesheet" href="/FRANK/assets/index-${buildId}.css">`;
}

function releaseDescriptor(buildId: string) {
  const query = encodeURIComponent(buildId);
  return {
    schemaVersion: 1,
    buildId,
    builtAt: buildId === BUILD_A ? '2026-08-20T10:00:00.000Z' : '2026-08-20T11:00:00.000Z',
    baseUrl: '/FRANK/',
    serviceWorkerUrl: `/FRANK/sw.js?build=${query}`,
    shellUrl: `/FRANK/index.html?frank-build=${query}`,
    precacheManifestUrl: `/FRANK/frank-precache.json?frank-build=${query}`,
    staticShellUrls: STATIC_SHELL.map((path) => `/FRANK/${path}?frank-build=${query}`),
  };
}

function requestUrl(request: RequestLike) {
  return typeof request === 'string' ? request : request.url;
}

class MemoryCache {
  readonly entries = new Map<string, Response>();

  constructor(private readonly failPutUrls: Set<string>) {}

  async put(request: RequestLike, response: Response) {
    const url = requestUrl(request);
    if (this.failPutUrls.has(url)) throw new Error('simulated cache quota failure');
    this.entries.set(url, response.clone());
  }

  async match(request: RequestLike) {
    return this.entries.get(requestUrl(request))?.clone();
  }
}

class MemoryCacheStorage {
  readonly stores = new Map<string, MemoryCache>();
  readonly deleted: string[] = [];
  readonly failPutUrls = new Set<string>();

  async open(name: string) {
    let cache = this.stores.get(name);
    if (!cache) {
      cache = new MemoryCache(this.failPutUrls);
      this.stores.set(name, cache);
    }
    return cache;
  }

  async delete(name: string) {
    this.deleted.push(name);
    return this.stores.delete(name);
  }

  async keys() {
    return [...this.stores.keys()];
  }
}

function response(body: BodyInit, contentType: string, status = 200) {
  return new Response(body, { status, headers: { 'content-type': contentType } });
}

function shellResponseFor(urlString: string, publishedBuildId: string) {
  const url = new URL(urlString);
  if (url.pathname.endsWith('/frank-release.json')) {
    return response(JSON.stringify(releaseDescriptor(publishedBuildId)), 'application/json');
  }
  if (url.pathname.endsWith('/index.html')) {
    return response(indexHtml(publishedBuildId), 'text/html; charset=utf-8');
  }
  if (url.pathname.endsWith('/frank-precache.json')) {
    return response(JSON.stringify({
      schemaVersion: 1,
      buildId: publishedBuildId,
      assets: buildAssets(publishedBuildId),
    }), 'application/json');
  }
  if (url.pathname.endsWith('.js')) return response(`export const build = '${publishedBuildId}';`, 'text/javascript');
  if (url.pathname.endsWith('.css')) return response(`body::before { content: '${publishedBuildId}' }`, 'text/css');
  if (url.pathname.endsWith('.json')) return response('{}', 'application/json');
  if (url.pathname.endsWith('.svg')) return response('<svg/>', 'image/svg+xml');
  return response(new Uint8Array([1, 2, 3]), 'image/png');
}

interface HarnessOptions {
  buildId?: string;
  publishedBuildId?: string;
  cacheStorage?: MemoryCacheStorage;
  fetchOverride?: (request: RequestLike) => Promise<Response> | Response;
  windowClients?: () => Array<{ url: string }>;
}

function createHarness(options: HarnessOptions = {}) {
  const buildId = options.buildId ?? BUILD_A;
  const publishedBuildId = options.publishedBuildId ?? buildId;
  const handlers = new Map<string, (event: any) => void>();
  const cacheStorage = options.cacheStorage ?? new MemoryCacheStorage();
  const skipWaiting = vi.fn(async () => undefined);
  const claim = vi.fn(async () => undefined);
  const matchAll = vi.fn(async () => options.windowClients?.() ?? []);
  const fetchMock = vi.fn(async (request: RequestLike) => {
    if (options.fetchOverride) return options.fetchOverride(request);
    return shellResponseFor(requestUrl(request), publishedBuildId);
  });
  const self = {
    registration: { scope: SCOPE },
    location: { href: `${SCOPE}sw.js?build=${encodeURIComponent(buildId)}`, origin: new URL(SCOPE).origin },
    clients: { claim, matchAll },
    skipWaiting,
    addEventListener(name: string, handler: (event: any) => void) {
      handlers.set(name, handler);
    },
  };

  const source = readFileSync(resolve(process.cwd(), 'public/sw.js'), 'utf8');
  vm.runInNewContext(source, {
    self,
    caches: cacheStorage,
    fetch: fetchMock,
    URL,
    Response,
    Request,
    Headers,
    Date,
    setTimeout,
    clearTimeout,
    encodeURIComponent,
  }, { filename: 'public/sw.js' });

  async function lifecycle(name: 'install' | 'activate') {
    let work: Promise<unknown> | undefined;
    handlers.get(name)?.({ waitUntil(value: Promise<unknown>) { work = Promise.resolve(value); } });
    if (!work) throw new Error(`${name} did not call waitUntil`);
    return work;
  }

  async function message(data: unknown) {
    let work: Promise<unknown> | undefined;
    handlers.get('message')?.({ data, waitUntil(value: Promise<unknown>) { work = Promise.resolve(value); } });
    return work;
  }

  function fetchEvent(request: RequestLike) {
    let result: Promise<Response> | undefined;
    handlers.get('fetch')?.({
      request,
      respondWith(value: Promise<Response>) { result = Promise.resolve(value); },
    });
    return result;
  }

  return { buildId, cacheStorage, claim, fetchEvent, fetchMock, lifecycle, matchAll, message, skipWaiting };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('FRANK service-worker lifecycle', () => {
  it('installs a complete build and retains exactly the current and previous FRANK shells', async () => {
    const harness = createHarness();
    await harness.cacheStorage.open('frank-app-very-old');
    await harness.cacheStorage.open('frank-app-previous');
    await harness.cacheStorage.open('another-app-cache');

    await harness.lifecycle('install');

    const installed = harness.cacheStorage.stores.get(cacheName(BUILD_A));
    expect(installed).toBeDefined();
    expect([...installed!.entries.keys()].sort()).toEqual([
      SCOPE,
      `${SCOPE}index.html`,
      RELEASE,
      MANIFEST,
      METADATA,
      ...STATIC_SHELL.map((path) => `${SCOPE}${path}`),
      ...buildAssets(BUILD_A).map((path) => `${SCOPE}${path}`),
    ].sort());
    expect(harness.skipWaiting).not.toHaveBeenCalled();

    await harness.lifecycle('activate');

    expect(harness.cacheStorage.stores.has('frank-app-very-old')).toBe(false);
    expect(harness.cacheStorage.stores.has('frank-app-previous')).toBe(true);
    expect(harness.cacheStorage.stores.has(cacheName(BUILD_A))).toBe(true);
    expect(harness.cacheStorage.stores.has('another-app-cache')).toBe(true);
    expect(harness.claim).not.toHaveBeenCalled();
  });

  it('deletes only a partial candidate cache when a cache write fails', async () => {
    const harness = createHarness();
    const previous = await harness.cacheStorage.open('frank-app-previous');
    await previous.put(SCOPE, response('working previous shell', 'text/html'));
    await harness.cacheStorage.open('another-app-cache');
    harness.cacheStorage.failPutUrls.add(`${SCOPE}assets/index-${BUILD_A}.css`);

    await expect(harness.lifecycle('install')).rejects.toThrow('simulated cache quota failure');

    expect(harness.cacheStorage.stores.has(cacheName(BUILD_A))).toBe(false);
    expect(harness.cacheStorage.stores.has('frank-app-previous')).toBe(true);
    expect(harness.cacheStorage.stores.has('another-app-cache')).toBe(true);
    expect(harness.skipWaiting).not.toHaveBeenCalled();
  });

  it('rejects a 200 HTML fallback for a JavaScript asset before opening the candidate cache', async () => {
    const storage = new MemoryCacheStorage();
    await storage.open('frank-app-previous');
    const harness = createHarness({
      cacheStorage: storage,
      fetchOverride(request) {
        const url = requestUrl(request);
        if (new URL(url).pathname.endsWith(`/assets/index-${BUILD_A}.js`)) {
          return response('<!doctype html><title>fallback</title>', 'text/html; charset=utf-8');
        }
        return shellResponseFor(url, BUILD_A);
      },
    });

    await expect(harness.lifecycle('install')).rejects.toThrow('wrong MIME type (text/html)');

    expect(storage.stores.has(cacheName(BUILD_A))).toBe(false);
    expect(storage.stores.has('frank-app-previous')).toBe(true);
    expect(harness.skipWaiting).not.toHaveBeenCalled();
  });

  it('rejects a release descriptor from another deployment before opening a candidate cache', async () => {
    const harness = createHarness({ buildId: BUILD_A, publishedBuildId: BUILD_B });
    await harness.cacheStorage.open('frank-app-previous');

    await expect(harness.lifecycle('install')).rejects.toThrow('release descriptor does not match this build');

    expect(harness.cacheStorage.stores.has(cacheName(BUILD_A))).toBe(false);
    expect(harness.cacheStorage.stores.has('frank-app-previous')).toBe(true);
  });

  it('preserves A when its old script URL sees B after publication', async () => {
    const harness = createHarness({ buildId: BUILD_A, publishedBuildId: BUILD_B });
    const activeCache = await harness.cacheStorage.open(cacheName(BUILD_A));
    await activeCache.put(SCOPE, response('verified A shell', 'text/html'));

    await expect(harness.lifecycle('install')).rejects.toThrow('release descriptor does not match this build');

    expect(harness.cacheStorage.stores.has(cacheName(BUILD_A))).toBe(true);
    expect(await (await activeCache.match(SCOPE))!.text()).toBe('verified A shell');
    expect(harness.cacheStorage.deleted).not.toContain(cacheName(BUILD_A));
  });

  it('uses the bounded activation handshake only for the matching build when no FRANK window remains', async () => {
    const harness = createHarness({ windowClients: () => [] });
    await harness.message({ type: 'FRANK_ACTIVATE_WHEN_IDLE', buildId: BUILD_B });
    expect(harness.skipWaiting).not.toHaveBeenCalled();

    await harness.message({ type: 'FRANK_ACTIVATE_WHEN_IDLE', buildId: BUILD_A });
    expect(harness.matchAll).toHaveBeenCalledWith({ type: 'window', includeUncontrolled: true });
    expect(harness.skipWaiting).toHaveBeenCalledOnce();
  });
});

describe('FRANK blue-green app-shell handover', () => {
  it('keeps navigation on A while complete B waits, then serves only B after activation', async () => {
    const storage = new MemoryCacheStorage();
    const workerA = createHarness({ buildId: BUILD_A, publishedBuildId: BUILD_A, cacheStorage: storage });
    await workerA.lifecycle('install');
    await workerA.lifecycle('activate');

    const workerB = createHarness({ buildId: BUILD_B, publishedBuildId: BUILD_B, cacheStorage: storage });
    await workerB.lifecycle('install');
    expect(workerB.skipWaiting).not.toHaveBeenCalled();
    expect(storage.stores.has(cacheName(BUILD_A))).toBe(true);
    expect(storage.stores.has(cacheName(BUILD_B))).toBe(true);

    const aNavigation = await workerA.fetchEvent({ method: 'GET', mode: 'navigate', url: SCOPE });
    const aHtml = await aNavigation!.text();
    expect(aHtml).toContain(BUILD_A);
    expect(aHtml).not.toContain(BUILD_B);

    await workerB.lifecycle('activate');
    const bNavigation = await workerB.fetchEvent({ method: 'GET', mode: 'navigate', url: SCOPE });
    const bHtml = await bNavigation!.text();
    expect(bHtml).toContain(BUILD_B);
    expect(bHtml).not.toContain(BUILD_A);
  });

  it('leaves complete A usable when B cannot finish installing', async () => {
    const storage = new MemoryCacheStorage();
    const workerA = createHarness({ buildId: BUILD_A, publishedBuildId: BUILD_A, cacheStorage: storage });
    await workerA.lifecycle('install');
    await workerA.lifecycle('activate');
    storage.failPutUrls.add(`${SCOPE}assets/index-${BUILD_B}.css`);

    const workerB = createHarness({ buildId: BUILD_B, publishedBuildId: BUILD_B, cacheStorage: storage });
    await expect(workerB.lifecycle('install')).rejects.toThrow('simulated cache quota failure');

    expect(storage.stores.has(cacheName(BUILD_A))).toBe(true);
    expect(storage.stores.has(cacheName(BUILD_B))).toBe(false);
    const navigation = await workerA.fetchEvent({ method: 'GET', mode: 'navigate', url: SCOPE });
    expect(await navigation!.text()).toContain(BUILD_A);
  });

  it('serves an old tab\'s lazy A chunk from the retained previous cache after B activates offline', async () => {
    const storage = new MemoryCacheStorage();
    const workerA = createHarness({ buildId: BUILD_A, publishedBuildId: BUILD_A, cacheStorage: storage });
    await workerA.lifecycle('install');
    await workerA.lifecycle('activate');
    const oldLazyChunk = `${SCOPE}assets/WeatherCharts-${BUILD_A}.js`;

    const workerB = createHarness({
      buildId: BUILD_B,
      publishedBuildId: BUILD_B,
      cacheStorage: storage,
      fetchOverride: () => Promise.reject(new Error('offline')),
    });
    // Install B while online, then replace its network behaviour with an
    // offline worker harness sharing the same verified caches.
    const installerB = createHarness({ buildId: BUILD_B, publishedBuildId: BUILD_B, cacheStorage: storage });
    await installerB.lifecycle('install');
    await installerB.lifecycle('activate');

    const lazyResponse = await workerB.fetchEvent({ method: 'GET', mode: 'cors', url: oldLazyChunk });
    expect(await lazyResponse!.text()).toContain(BUILD_A);
    expect(workerB.fetchMock).not.toHaveBeenCalled();
  });
});

describe('FRANK service-worker fetch policy', () => {
  it('serves cached A navigation without consulting a network already publishing B', async () => {
    const storage = new MemoryCacheStorage();
    const installer = createHarness({ buildId: BUILD_A, publishedBuildId: BUILD_A, cacheStorage: storage });
    await installer.lifecycle('install');
    await installer.lifecycle('activate');
    const activeA = createHarness({ buildId: BUILD_A, publishedBuildId: BUILD_B, cacheStorage: storage });

    const result = await activeA.fetchEvent({ method: 'GET', mode: 'navigate', url: SCOPE });

    expect(await result!.text()).toContain(BUILD_A);
    expect(activeA.fetchMock).not.toHaveBeenCalled();
  });

  it('does not intercept release discovery, forecast/API traffic, or unknown same-origin paths', async () => {
    const harness = createHarness();
    await harness.lifecycle('install');

    expect(harness.fetchEvent({ method: 'GET', mode: 'cors', url: `${RELEASE}?check=unique` })).toBeUndefined();
    expect(harness.fetchEvent({ method: 'GET', mode: 'cors', url: 'https://forecast.example/api' })).toBeUndefined();
    expect(harness.fetchEvent({ method: 'GET', mode: 'cors', url: `${SCOPE}api/forecast` })).toBeUndefined();
  });
});
