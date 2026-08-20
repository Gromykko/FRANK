import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error - the Worker is plain JS with no type declarations
import worker from '../../worker/index.js';
import { FORECAST_PAYLOAD_VERSION } from '../../src/features/forecast/types';

const LAST_COMPLETED_CHECK = new Date(Date.now() - 5 * 60_000).toISOString();
const CURRENT_RUN = new Date().toISOString();

function cachedForecast() {
  return {
    hourly: [{
      time: new Date(Date.now() + 60 * 60_000).toISOString(),
      tempAir: 15,
      precipitation: 0,
      symbolCode: 'clearsky_day',
      weatherCode: 0,
      windSpeed: 2,
      windDirection: 180,
      windGust: 3,
      waveHeight: 0.1,
      waveDirection: 180,
      wavePeriod: 3,
      tempWater: 16,
      tideLevel: 0,
      currentSpeed: 0,
      currentDirection: 0,
      isDay: true,
    }],
    sunrise: [],
    sunset: [],
    warnings: [],
    sources: {
      payloadVersion: FORECAST_PAYLOAD_VERSION,
      weather: 'MET Norway Locationforecast',
      waves: 'DMI wam_nsb',
      water: 'DMI dkss_idw',
      coordinate: { latitude: 55.858, longitude: 9.905 },
      fetchedAt: LAST_COMPLETED_CHECK,
      cacheHealth: {
        status: 'current',
        lastAttemptAt: LAST_COMPLETED_CHECK,
        weatherExpires: new Date(Date.now() + 30 * 60_000).toISOString(),
        marineInstances: {
          water: { collection: 'dkss_idw', id: CURRENT_RUN },
          waves: { collection: 'wam_nsb', id: CURRENT_RUN },
        },
      },
    },
  };
}

function makeRuntime(
  initialPayload = cachedForecast(),
  extraSeed: Record<string, unknown> = {},
) {
  let payload = initialPayload;
  const extraStore = new Map(
    Object.entries(extraSeed).map(([key, value]) => [key, JSON.stringify(value)]),
  );
  const waits: Promise<unknown>[] = [];
  const puts: Array<{ key: string; value: string }> = [];
  const env = {
    FRANK_FORECAST_CACHE: {
      get: async (key: string, type?: string) => {
        if (key.startsWith('forecast:')) {
          return type === 'json' ? payload : JSON.stringify(payload);
        }
        const raw = extraStore.get(key);
        if (raw == null) return null;
        return type === 'json' ? JSON.parse(raw) : raw;
      },
      put: async (key: string, value: string) => {
        puts.push({ key, value });
        if (key.startsWith('forecast:')) payload = JSON.parse(value);
        else extraStore.set(key, value);
      },
    },
  };
  const ctx = {
    waitUntil(value: Promise<unknown>) {
      waits.push(Promise.resolve(value));
    },
  };
  return { env, ctx, waits, puts, extraStore, getPayload: () => payload };
}

const request = (path: string, method = 'GET') =>
  new Request(`https://frank.test${path}`, { method });

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Worker route HTTP contract', () => {
  const knownPaths = ['/', '/health', '/status', '/forecast/horsens'];

  function useFakeAbortTimeouts() {
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      const controller = new AbortController();
      setTimeout(() => {
        controller.abort(new DOMException('The operation timed out', 'TimeoutError'));
      }, ms);
      return controller.signal;
    });
  }

  const metForecastAt = (time: string) => ({
    properties: {
      timeseries: [{
        time,
        data: {
          instant: {
            details: {
              air_temperature: 15,
              wind_speed: 2,
              wind_speed_of_gust: 3,
              wind_from_direction: 180,
            },
          },
          next_1_hours: {
            summary: { symbol_code: 'clearsky_day' },
            details: { precipitation_amount: 0 },
          },
        },
      }],
    },
  });

  const marineIngredients = (locationId: string, runId: string, time: string) => ({
    [`frank-marine-ingredient:v${FORECAST_PAYLOAD_VERSION}:water:${locationId}`]: {
      schemaVersion: FORECAST_PAYLOAD_VERSION,
      collection: 'dkss_idw',
      id: runId,
      series: [{
        time,
        timeMs: Date.parse(time),
        tempWater: 16,
        tideLevel: 0,
        currentSpeed: 0,
        currentDirection: 0,
      }],
    },
    [`frank-marine-ingredient:v${FORECAST_PAYLOAD_VERSION}:waves:${locationId}`]: {
      schemaVersion: FORECAST_PAYLOAD_VERSION,
      collection: 'wam_nsb',
      id: runId,
      series: [{
        time,
        timeMs: Date.parse(time),
        waveHeight: 0.1,
        waveDirection: 180,
        wavePeriod: 3,
      }],
    },
  });

  async function expectBrowserBackgroundDeadline(path: string, lastCheckAgeMs: number) {
    vi.useFakeTimers();
    vi.setSystemTime('2026-08-20T12:00:00Z');
    const payload = cachedForecast();
    payload.sources.cacheHealth.lastAttemptAt = new Date(Date.now() - lastCheckAgeMs).toISOString();
    payload.sources.cacheHealth.weatherExpires = new Date(Date.now() + 30 * 60_000).toISOString();
    const { env, ctx, waits } = makeRuntime(payload);
    // The forecast is already current, so the background check reaches its KV
    // stamp write. Simulate a binding call that never resolves: the absolute
    // event policy, not the provider timeout, must still settle waitUntil.
    env.FRANK_FORECAST_CACHE.put = () => new Promise<void>(() => {});

    const startedAt = Date.now();
    const response = await worker.fetch(request(path), env, ctx);
    expect(response.status).toBe(200);
    expect(waits).toHaveLength(1);

    let settled = false;
    void waits[0].then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await vi.advanceTimersByTimeAsync(23_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await waits[0];
    expect(settled).toBe(true);
    expect(Date.now() - startedAt).toBe(24_000);
    expect(Date.now() - startedAt).toBeLessThan(25_000);
  }

  async function refreshWithFailedMarineProbe(options: {
    clock: string;
    path: string;
    runAgeMs: number;
    fetchedAgeMs: number;
    failureStatus?: number;
  }) {
    vi.useFakeTimers();
    vi.setSystemTime(options.clock);
    const fetchedAt = new Date(Date.now() - options.fetchedAgeMs).toISOString();
    const knownRun = new Date(Date.now() - options.runAgeMs).toISOString();
    const payload = cachedForecast();
    payload.sources.fetchedAt = fetchedAt;
    payload.sources.cacheHealth.lastAttemptAt = new Date(Date.now() - 5 * 60_000).toISOString();
    payload.sources.cacheHealth.weatherExpires = new Date(Date.now() + 30 * 60_000).toISOString();
    payload.sources.cacheHealth.marineInstances.water.id = knownRun;
    payload.sources.cacheHealth.marineInstances.waves.id = knownRun;

    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return {
        ok: false,
        status: options.failureStatus ?? 429,
        text: async () => options.failureStatus === 503
          ? 'Upstream failed: internal provider detail'
          : 'Server is busy: internal provider detail',
      } as Response;
    }) as typeof fetch;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const runtime = makeRuntime(payload);

    const response = await worker.fetch(request(options.path), runtime.env, runtime.ctx);
    expect(response.status).toBe(200);
    expect(runtime.waits).toHaveLength(1);
    await Promise.all(runtime.waits);

    return { ...runtime, calls, errorSpy, fetchedAt };
  }

  it.each(knownPaths)('rejects mutating methods consistently on %s', async (path) => {
    const { env, ctx } = makeRuntime();
    const response = await worker.fetch(request(path, 'POST'), env, ctx);

    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET, HEAD, OPTIONS');
    expect(await response.json()).toEqual({ error: 'Method not allowed' });
  });

  it.each(knownPaths)('answers OPTIONS consistently on %s', async (path) => {
    const { env, ctx } = makeRuntime();
    const response = await worker.fetch(request(path, 'OPTIONS'), env, ctx);

    expect(response.status).toBe(204);
    expect(response.headers.get('Allow')).toBe('GET, HEAD, OPTIONS');
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, HEAD, OPTIONS');
    expect(await response.text()).toBe('');
  });

  it.each(knownPaths)('models HEAD without a response body on %s', async (path) => {
    const { env, ctx } = makeRuntime();
    const response = await worker.fetch(request(path, 'HEAD'), env, ctx);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
  });

  it.each([
    { path: '/forecast/horsens', method: 'GET', status: 503, kind: 'forecast' },
    { path: '/forecast/horsens', method: 'HEAD', status: 503, kind: 'head' },
    { path: '/health', method: 'GET', status: 503, kind: 'health' },
    { path: '/health', method: 'HEAD', status: 503, kind: 'head' },
    { path: '/status', method: 'GET', status: 200, kind: 'status' },
    { path: '/status', method: 'HEAD', status: 200, kind: 'head' },
  ])('bounds a stalled initial KV read on $method $path', async ({ path, method, status, kind }) => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-08-25T12:00:00Z');
    const runtime = makeRuntime();
    runtime.env.FRANK_FORECAST_CACHE.get = () => new Promise<never>(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const startedAt = Date.now();
    const pending = worker.fetch(request(path, method), runtime.env, runtime.ctx);
    let settled = false;
    void pending.then(
      () => { settled = true; },
      () => { settled = true; },
    );

    await vi.advanceTimersByTimeAsync(1_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const response = await pending;
    expect(response.status).toBe(status);
    expect(Date.now() - startedAt).toBe(2_000);

    if (kind === 'head') {
      expect(await response.text()).toBe('');
    } else if (kind === 'forecast') {
      expect(await response.json()).toEqual({
        error: 'Forecast service failed',
        message: 'An internal error occurred while fetching or processing forecast data.',
      });
    } else if (kind === 'health') {
      const body = await response.json();
      expect(body).toMatchObject({
        ok: false,
        reason: 'forecast storage unavailable',
      });
      expect(JSON.stringify(body)).not.toContain('Execution deadline');
    } else {
      const body = await response.text();
      expect(body).toContain('forecast storage unavailable');
      expect(body).toContain('STORAGE UNAVAILABLE');
      expect(body).not.toContain('Execution deadline');
    }
  });

  it('hardens the human status page against framing and referrer leakage', async () => {
    const { env, ctx } = makeRuntime();
    const response = await worker.fetch(request('/status'), env, ctx);

    expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
  });

  it('does not advertise unknown paths through OPTIONS', async () => {
    const { env, ctx } = makeRuntime();
    const response = await worker.fetch(request('/missing', 'OPTIONS'), env, ctx);

    expect(response.status).toBe(404);
  });

  it('returns pending for a manual refresh without moving the completed-check timestamp', async () => {
    const { env, ctx, waits } = makeRuntime();
    const response = await worker.fetch(request('/forecast/horsens?refresh=1'), env, ctx);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.sources.cacheHealth).toMatchObject({
      status: 'pending',
      lastAttemptAt: LAST_COMPLETED_CHECK,
      checkedBy: 'manual',
    });
    expect(waits).toHaveLength(1);
    await Promise.all(waits);
  });

  it.each(['/forecast/horsens', '/forecast/horsens?refresh=1'])('does not re-read a known null forecast cache on %s', async (path) => {
    const runId = new Date(Date.now() - 60 * 60_000).toISOString();
    const forecastTime = new Date(Date.now() + 60 * 60_000).toISOString();
    const runtime = makeRuntime(cachedForecast(), marineIngredients('horsens', runId, forecastTime));
    const originalGet = runtime.env.FRANK_FORECAST_CACHE.get;
    const originalPut = runtime.env.FRANK_FORECAST_CACHE.put;
    const getKeys: string[] = [];
    let forecastStored = false;

    runtime.env.FRANK_FORECAST_CACHE.get = async (key: string, type?: string) => {
      getKeys.push(key);
      if (key.startsWith('forecast:') && !forecastStored) return null;
      return originalGet(key, type);
    };
    runtime.env.FRANK_FORECAST_CACHE.put = async (key: string, value: string) => {
      if (key.startsWith('forecast:')) forecastStored = true;
      await originalPut(key, value);
    };

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/instances')) {
        return new Response(JSON.stringify({ instances: [{ id: runId }] }), { status: 200 });
      }
      if (url.includes('api.met.no')) {
        return new Response(JSON.stringify(metForecastAt(forecastTime)), {
          status: 200,
          headers: {
            'Last-Modified': new Date(Date.now() - 60_000).toUTCString(),
            Expires: new Date(Date.now() + 30 * 60_000).toUTCString(),
          },
        });
      }
      if (url.includes('feeds.meteoalarm.org')) {
        return new Response('<feed></feed>', { status: 200 });
      }
      throw new Error(`Unexpected cold-build fetch: ${url}`);
    }) as typeof fetch;

    const response = await worker.fetch(request(path), runtime.env, runtime.ctx);

    expect(response.status).toBe(200);
    expect(getKeys.filter((key) => key.startsWith('forecast:'))).toHaveLength(1);
    expect(runtime.puts.some(({ key }) => key.startsWith('forecast:'))).toBe(true);
  });

  it('settles manual waitUntil work within the 25-second ceiling', async () => {
    await expectBrowserBackgroundDeadline('/forecast/kolding?refresh=1', 11 * 60_000);
  });

  it('settles automatic user-background work within the same ceiling', async () => {
    await expectBrowserBackgroundDeadline('/forecast/vejle', 16 * 60_000);
  });

  it('reserves enough time after an upstream timeout to persist stale/degraded health', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-08-23T12:00:00Z');
    useFakeAbortTimeouts();
    const originalFetchedAt = new Date(Date.now() - 60 * 60_000).toISOString();
    const knownRun = new Date(Date.now() - 6 * 60 * 60_000).toISOString();
    const payload = cachedForecast();
    payload.sources.fetchedAt = originalFetchedAt;
    payload.sources.cacheHealth.lastAttemptAt = new Date(Date.now() - 5 * 60_000).toISOString();
    payload.sources.cacheHealth.weatherExpires = new Date(Date.now() + 30 * 60_000).toISOString();
    payload.sources.cacheHealth.marineInstances.water.id = knownRun;
    payload.sources.cacheHealth.marineInstances.waves.id = knownRun;

    const calls: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(input));
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }) as typeof fetch;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const runtime = makeRuntime(payload);
    const startedAt = Date.now();

    const response = await worker.fetch(request('/forecast/horsens?refresh=1'), runtime.env, runtime.ctx);
    expect(response.status).toBe(200);
    expect(runtime.waits).toHaveLength(1);
    let settled = false;
    void runtime.waits[0].then(() => { settled = true; }, () => { settled = true; });

    await vi.advanceTimersByTimeAsync(14_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await runtime.waits[0];

    const retained = runtime.getPayload();
    expect(Date.now() - startedAt).toBe(15_000);
    expect(24_000 - (Date.now() - startedAt)).toBe(9_000);
    expect(calls).toHaveLength(2); // one water + one wave attempt, no retry cascade
    expect(runtime.puts.some(({ key }) => key.startsWith('forecast:'))).toBe(true);
    expect(retained.sources.fetchedAt).toBe(originalFetchedAt);
    expect(retained.sources.cacheHealth).toMatchObject({
      status: 'stale',
      degradedSources: ['water', 'waves'],
      message: 'Marine service unavailable; keeping the last completed forecast.',
    });
    expect(retained.sources.cacheHealth.providerBusy).toBeUndefined();
  });

  it('does not let a stalled advisory warning feed abort a complete forecast build', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-08-24T12:00:00Z');
    useFakeAbortTimeouts();
    const originalFetchedAt = new Date(Date.now() - 60 * 60_000).toISOString();
    const runId = new Date(Date.now() - 60 * 60_000).toISOString();
    const forecastTime = new Date(Date.now() + 60 * 60_000).toISOString();
    const payload = cachedForecast();
    payload.sources.fetchedAt = originalFetchedAt;
    payload.sources.cacheHealth.lastAttemptAt = new Date(Date.now() - 5 * 60_000).toISOString();
    payload.sources.cacheHealth.weatherExpires = new Date(Date.now() - 60_000).toISOString();
    payload.sources.cacheHealth.marineInstances.water.id = runId;
    payload.sources.cacheHealth.marineInstances.waves.id = runId;
    (payload as unknown as { warnings: Array<Record<string, unknown>> }).warnings = [{
      id: 'held-warning',
      expires: new Date(Date.now() + 60 * 60_000).toISOString(),
    }];

    const calls: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('api.met.no')) {
        return Promise.resolve(new Response(JSON.stringify(metForecastAt(forecastTime)), {
          status: 200,
          headers: {
            'Last-Modified': new Date(Date.now() - 60_000).toUTCString(),
            Expires: new Date(Date.now() + 30 * 60_000).toUTCString(),
          },
        }));
      }
      if (url.includes('feeds.meteoalarm.org')) {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    }) as typeof fetch;
    const runtime = makeRuntime(
      payload,
      marineIngredients('kolding', runId, forecastTime),
    );

    const response = await worker.fetch(request('/forecast/kolding?refresh=1'), runtime.env, runtime.ctx);
    expect(response.status).toBe(200);
    let settled = false;
    void runtime.waits[0].then(() => { settled = true; }, () => { settled = true; });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await runtime.waits[0];

    const fresh = runtime.getPayload();
    expect(fresh.sources.fetchedAt).not.toBe(originalFetchedAt);
    expect(fresh.sources.cacheHealth.status).toBe('current');
    expect(fresh.warnings).toEqual([expect.objectContaining({ id: 'held-warning' })]);
    expect(calls.filter((url) => url.includes('feeds.meteoalarm.org'))).toHaveLength(1);
    expect(calls.some((url) => url.includes('opendataapi.dmi.dk'))).toBe(false);
  });

  it('fails closed on a future-dated retained MET Last-Modified value', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-08-25T12:00:00Z');
    const originalFetchedAt = new Date(Date.now() - 60 * 60_000).toISOString();
    const runId = new Date(Date.now() - 60 * 60_000).toISOString();
    const forecastTime = new Date(Date.now() + 60 * 60_000).toISOString();
    const payload = cachedForecast();
    payload.sources.fetchedAt = originalFetchedAt;
    payload.sources.cacheHealth.lastAttemptAt = new Date(Date.now() - 5 * 60_000).toISOString();
    payload.sources.cacheHealth.weatherExpires = new Date(Date.now() - 60_000).toISOString();
    payload.sources.cacheHealth.marineInstances.water.id = runId;
    payload.sources.cacheHealth.marineInstances.waves.id = runId;
    const futureLastModified = new Date(Date.now() + 60 * 60_000).toUTCString();
    const seed = {
      ...marineIngredients('vejle', runId, forecastTime),
      'met-raw:vejle': {
        lastModified: futureLastModified,
        body: metForecastAt(forecastTime),
      },
    };

    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('api.met.no')) {
        return new Response('upstream failed: internal provider detail', { status: 503 });
      }
      if (url.includes('feeds.meteoalarm.org')) {
        return new Response('<feed xmlns="http://www.w3.org/2005/Atom"></feed>', { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const runtime = makeRuntime(payload, seed);

    const response = await worker.fetch(request('/forecast/vejle?refresh=1'), runtime.env, runtime.ctx);
    expect(response.status).toBe(200);
    await Promise.all(runtime.waits);

    const retained = runtime.getPayload();
    expect(retained.sources.fetchedAt).toBe(originalFetchedAt);
    expect(retained.sources.cacheHealth).toMatchObject({
      status: 'stale',
      message: 'Forecast refresh failed; keeping the last completed forecast.',
    });
    expect(retained.sources.cacheHealth.message).not.toContain('internal provider detail');
    expect(calls.some((url) => url.includes('opendataapi.dmi.dk'))).toBe(false);
  });

  it('keeps the original assembled timestamp when marine provenance is over 12 hours old', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-08-20T12:00:00Z');
    const oldFetchedAt = new Date(Date.now() - 4 * 60 * 60_000).toISOString();
    const oldRun = new Date(Date.now() - 13 * 60 * 60_000).toISOString();
    const payload = cachedForecast();
    payload.sources.fetchedAt = oldFetchedAt;
    payload.sources.cacheHealth.lastAttemptAt = new Date(Date.now() - 5 * 60_000).toISOString();
    payload.sources.cacheHealth.weatherExpires = new Date(Date.now() - 60_000).toISOString();
    payload.sources.cacheHealth.marineInstances.water.id = oldRun;
    payload.sources.cacheHealth.marineInstances.waves.id = oldRun;

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/instances')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ instances: [{ id: oldRun }] }),
        } as Response;
      }
      return {
        ok: false,
        status: 429,
        text: async () => 'Server is busy',
      } as Response;
    }) as typeof fetch;

    const { env, ctx, waits, getPayload } = makeRuntime(payload);
    const response = await worker.fetch(request('/forecast/aarhus?refresh=1'), env, ctx);
    expect(response.status).toBe(200);
    expect(waits).toHaveLength(1);
    await Promise.all(waits);

    const retained = getPayload();
    expect(retained.sources.fetchedAt).toBe(oldFetchedAt);
    expect(retained.sources.cacheHealth.status).toBe('stale');

    // The unchanged fetchedAt is load-bearing: it lets the dead-man health
    // check fail once old marine data can no longer be safely reassembled.
    const health = await worker.fetch(request('/health'), env, ctx);
    expect(health.status).toBe(503);
    expect((await health.json()).reason).toContain('not rebuilding');
  });

  it('marks a failed marine probe stale even while MET remains unexpired', async () => {
    const result = await refreshWithFailedMarineProbe({
      clock: '2026-08-26T12:00:00Z',
      path: '/forecast/kolding?refresh=1',
      runAgeMs: 6 * 60 * 60_000,
      fetchedAgeMs: 60 * 60_000,
    });
    const retained = result.getPayload();

    expect(retained.sources.fetchedAt).toBe(result.fetchedAt);
    expect(retained.sources.cacheHealth).toMatchObject({
      status: 'stale',
      degradedSources: ['water', 'waves'],
      providerBusy: true,
      busyProvider: 'marine',
      message: 'Marine service busy; keeping the last completed forecast.',
    });
    expect(retained.sources.cacheHealth.message).not.toContain('internal provider detail');
    expect(result.calls).toHaveLength(2);
    expect(result.calls.every((url) => url.includes('/instances'))).toBe(true);
    expect(result.errorSpy).toHaveBeenCalledWith(expect.stringContaining('"event":"marine_instance_probe_failed"'));
  });

  it('does not call an ordinary marine probe failure “service busy”', async () => {
    const result = await refreshWithFailedMarineProbe({
      clock: '2026-08-27T12:00:00Z',
      path: '/forecast/aarhus?refresh=1',
      runAgeMs: 6 * 60 * 60_000,
      fetchedAgeMs: 60 * 60_000,
      failureStatus: 503,
    });
    const health = result.getPayload().sources.cacheHealth;

    expect(health).toMatchObject({
      status: 'stale',
      degradedSources: ['water', 'waves'],
      message: 'Marine service unavailable; keeping the last completed forecast.',
    });
    expect(health.providerBusy).toBeUndefined();
    expect(health.busyProvider).toBeUndefined();
    expect(health.message).not.toContain('internal provider detail');
    expect(result.calls).toHaveLength(2);
    expect(result.calls.every((url) => url.includes('/instances'))).toBe(true);
    expect(result.errorSpy).toHaveBeenCalledWith(expect.stringContaining('"event":"marine_instance_probe_failed"'));
  });

  it('never lets an unexpired MET window bless a known marine run older than 12 hours', async () => {
    const result = await refreshWithFailedMarineProbe({
      clock: '2026-08-28T12:00:00Z',
      path: '/forecast/vejle?refresh=1',
      runAgeMs: 13 * 60 * 60_000,
      fetchedAgeMs: 4 * 60 * 60_000,
    });
    const retained = result.getPayload();

    expect(retained.sources.fetchedAt).toBe(result.fetchedAt);
    expect(retained.sources.cacheHealth).toMatchObject({
      status: 'stale',
      needsRebuild: true,
      degradedSources: ['water', 'waves'],
      providerBusy: true,
      busyProvider: 'marine',
    });
    expect(result.calls.every((url) => url.includes('/instances'))).toBe(true);

    const health = await worker.fetch(request('/health'), result.env, result.ctx);
    expect(health.status).toBe(503);
    expect((await health.json()).reason).toContain('not rebuilding');
  });
});
