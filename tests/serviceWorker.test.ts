// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

const SCOPE = 'https://example.test/FRANK/';
const BUILD_ID = 'build-1';
const CACHE_NAME = `frank-app-${encodeURIComponent(BUILD_ID)}`;
const INDEX_HTML = `<!doctype html>
  <div id="root"></div>
  <script type="module" src="/FRANK/assets/index-abc123.js"></script>
  <link rel="stylesheet" href="/FRANK/assets/index-def456.css">`;
const BUILD_ASSETS = [
  'assets/WeatherCharts-ghi789.js',
  'assets/index-abc123.js',
  'assets/index-def456.css',
];
const STATIC_SHELL = [
  'manifest.json',
  'favicon.svg',
  'icon-192.png',
  'icon-512.png',
  'apple-touch-icon.png',
];

type RequestLike = string | { url: string; method?: string; mode?: string };

function requestUrl(request: RequestLike) {
  return typeof request === 'string' ? request : request.url;
}

class MemoryCache {
  readonly entries = new Map<string, Response>();

  constructor(private readonly failPutUrl?: string) {}

  async put(request: RequestLike, response: Response) {
    const url = requestUrl(request);
    if (url === this.failPutUrl) throw new Error('simulated cache quota failure');
    this.entries.set(url, response.clone());
  }

  async match(request: RequestLike) {
    return this.entries.get(requestUrl(request))?.clone();
  }
}

class MemoryCacheStorage {
  readonly stores = new Map<string, MemoryCache>();
  readonly deleted: string[] = [];

  constructor(private readonly failPutUrl?: string) {}

  async open(name: string) {
    let cache = this.stores.get(name);
    if (!cache) {
      cache = new MemoryCache(name === CACHE_NAME ? this.failPutUrl : undefined);
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

function shellResponseFor(url: string) {
  if (url === `${SCOPE}index.html`) return response(INDEX_HTML, 'text/html; charset=utf-8');
  if (url === `${SCOPE}frank-precache.json`) {
    return response(JSON.stringify({ buildId: BUILD_ID, assets: BUILD_ASSETS }), 'application/json');
  }
  if (url.endsWith('.js')) return response('export {};', 'text/javascript');
  if (url.endsWith('.css')) return response('body {}', 'text/css');
  if (url.endsWith('.json')) return response('{}', 'application/json');
  if (url.endsWith('.svg')) return response('<svg/>', 'image/svg+xml');
  return response(new Uint8Array([1, 2, 3]), 'image/png');
}

interface HarnessOptions {
  failPutUrl?: string;
  fetchOverride?: (request: RequestLike) => Promise<Response> | Response;
}

function createHarness(options: HarnessOptions = {}) {
  const handlers = new Map<string, (event: any) => void>();
  const cacheStorage = new MemoryCacheStorage(options.failPutUrl);
  const skipWaiting = vi.fn(async () => undefined);
  const claim = vi.fn(async () => undefined);
  const fetchMock = vi.fn(async (request: RequestLike) => {
    if (options.fetchOverride) return options.fetchOverride(request);
    return shellResponseFor(requestUrl(request));
  });
  const self = {
    registration: { scope: SCOPE },
    location: { href: `${SCOPE}sw.js?build=${encodeURIComponent(BUILD_ID)}`, origin: new URL(SCOPE).origin },
    clients: { claim },
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

  function fetchEvent(request: RequestLike) {
    let result: Promise<Response> | undefined;
    handlers.get('fetch')?.({
      request,
      respondWith(value: Promise<Response>) { result = Promise.resolve(value); },
    });
    return result;
  }

  return { cacheStorage, claim, fetchEvent, fetchMock, lifecycle, skipWaiting };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('FRANK service-worker lifecycle', () => {
  it('installs a complete build, waits for safe activation, and removes only obsolete FRANK caches', async () => {
    const harness = createHarness();
    await harness.cacheStorage.open('frank-v0.4.0');
    await harness.cacheStorage.open('another-app-cache');

    await harness.lifecycle('install');

    const installed = harness.cacheStorage.stores.get(CACHE_NAME);
    expect(installed).toBeDefined();
    expect([...installed!.entries.keys()].sort()).toEqual([
      SCOPE,
      `${SCOPE}index.html`,
      `${SCOPE}frank-precache.json`,
      ...STATIC_SHELL.map((path) => `${SCOPE}${path}`),
      ...BUILD_ASSETS.map((path) => `${SCOPE}${path}`),
    ].sort());
    // Upgrades must not take over an already-open old app. Its lazy chunks
    // still belong to the old cache until that tab closes naturally.
    expect(harness.skipWaiting).not.toHaveBeenCalled();

    await harness.lifecycle('activate');

    expect(harness.cacheStorage.stores.has('frank-v0.4.0')).toBe(false);
    expect(harness.cacheStorage.stores.has(CACHE_NAME)).toBe(true);
    expect(harness.cacheStorage.stores.has('another-app-cache')).toBe(true);
    expect(harness.claim).not.toHaveBeenCalled();
  });

  it('deletes only the partial new cache and does not activate when a cache write fails', async () => {
    const failPutUrl = `${SCOPE}assets/index-def456.css`;
    const harness = createHarness({ failPutUrl });
    await harness.cacheStorage.open('frank-v0.4.0');
    await harness.cacheStorage.open('another-app-cache');

    await expect(harness.lifecycle('install')).rejects.toThrow('simulated cache quota failure');

    expect(harness.cacheStorage.stores.has(CACHE_NAME)).toBe(false);
    expect(harness.cacheStorage.stores.has('frank-v0.4.0')).toBe(true);
    expect(harness.cacheStorage.stores.has('another-app-cache')).toBe(true);
    expect(harness.skipWaiting).not.toHaveBeenCalled();
  });

  it('rejects a manifest from a different deployment without disturbing old caches', async () => {
    const harness = createHarness({
      fetchOverride(request) {
        const url = requestUrl(request);
        if (url === `${SCOPE}frank-precache.json`) {
          return response(JSON.stringify({ buildId: 'other-build', assets: BUILD_ASSETS }), 'application/json');
        }
        return shellResponseFor(url);
      },
    });
    await harness.cacheStorage.open('frank-v0.4.0');

    await expect(harness.lifecycle('install')).rejects.toThrow('does not match this build');

    expect(harness.cacheStorage.stores.has(CACHE_NAME)).toBe(false);
    expect(harness.cacheStorage.stores.has('frank-v0.4.0')).toBe(true);
    expect(harness.skipWaiting).not.toHaveBeenCalled();
  });

  it('preserves the active cache when an old script URL sees a newer deployment manifest', async () => {
    const harness = createHarness({
      fetchOverride(request) {
        const url = requestUrl(request);
        if (url === `${SCOPE}frank-precache.json`) {
          return response(JSON.stringify({ buildId: 'newer-build', assets: BUILD_ASSETS }), 'application/json');
        }
        return shellResponseFor(url);
      },
    });
    const activeCache = await harness.cacheStorage.open(CACHE_NAME);
    await activeCache.put(SCOPE, response('verified active shell', 'text/html'));

    await expect(harness.lifecycle('install')).rejects.toThrow('does not match this build');

    expect(harness.cacheStorage.stores.has(CACHE_NAME)).toBe(true);
    expect(await (await activeCache.match(SCOPE))!.text()).toBe('verified active shell');
    expect(harness.cacheStorage.deleted).not.toContain(CACHE_NAME);
    expect(harness.skipWaiting).not.toHaveBeenCalled();
  });
});

describe('FRANK service-worker fetch policy', () => {
  it.each([
    ['network rejection', () => Promise.reject(new Error('offline'))],
    ['non-OK response', () => response('maintenance', 'text/html', 503)],
  ])('falls back to the verified shell on %s', async (_label, navigationFetch) => {
    const harness = createHarness({
      fetchOverride(request) {
        if (typeof request !== 'string' && request.mode === 'navigate') return navigationFetch();
        return shellResponseFor(requestUrl(request));
      },
    });
    await harness.lifecycle('install');

    const result = await harness.fetchEvent({ method: 'GET', mode: 'navigate', url: SCOPE });

    expect(result).toBeDefined();
    expect(await result!.text()).toContain('<div id="root"></div>');
  });

  it('falls back to the verified shell when navigation stalls', async () => {
    vi.useFakeTimers();
    const harness = createHarness({
      fetchOverride(request) {
        if (typeof request !== 'string' && request.mode === 'navigate') {
          return new Promise<Response>(() => undefined);
        }
        return shellResponseFor(requestUrl(request));
      },
    });
    await harness.lifecycle('install');

    const pending = harness.fetchEvent({ method: 'GET', mode: 'navigate', url: SCOPE });
    await vi.advanceTimersByTimeAsync(3000);
    const result = await pending;

    expect(result).toBeDefined();
    expect(await result!.text()).toContain('<div id="root"></div>');
  });

  it('does not intercept forecast/API traffic or cache unknown same-origin paths', async () => {
    const harness = createHarness();
    await harness.lifecycle('install');

    expect(harness.fetchEvent({ method: 'GET', mode: 'cors', url: 'https://forecast.example/api' })).toBeUndefined();
    expect(harness.fetchEvent({ method: 'GET', mode: 'cors', url: `${SCOPE}api/forecast` })).toBeUndefined();
  });
});
