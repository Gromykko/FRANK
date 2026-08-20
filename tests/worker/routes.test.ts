import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../../worker/index';
import locationData from '../../src/config/locations.json';
import type { ForecastLocation } from '../../src/config/locationTypes';
import { FORECAST_PAYLOAD_VERSION } from '../../src/features/forecast/types';
import { CURRENT_RELEASE } from '../../src/features/forecast/releaseContract';
import type { ForecastData, HealthLocationEntry } from '../../worker/domain';
import { buildHealthPayload, statusResponse } from '../../worker/health';
import {
  RELEASE_HEADER,
  assembledForecastKey,
  generationKeyPrefix,
  initializationStateKey,
} from '../../worker/generation';

const LOCATIONS = locationData as ForecastLocation[];
const LAST_COMPLETED_CHECK = new Date(Date.now() - 5 * 60_000).toISOString();
const CURRENT_RUN = new Date().toISOString();
const WORKER_VERSION_ID = 'cba7bd5e-93f4-4df7-8b61-8f00d5b6f3a1';

function locationById(id: string): ForecastLocation {
  const location = LOCATIONS.find((candidate) => candidate.id === id);
  if (!location) throw new Error(`Unknown test location: ${id}`);
  return location;
}

function cachedForecast(locationId = 'horsens'): ForecastData {
  const location = locationById(locationId);
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
      weatherSource: 'met-locationforecast',
      marineSource: 'dmi-dkss-wam',
    }],
    sunrise: [],
    sunset: [],
    warnings: [],
    sources: {
      payloadVersion: FORECAST_PAYLOAD_VERSION,
      release: { ...CURRENT_RELEASE },
      weather: 'MET Norway Locationforecast',
      waves: 'DMI wam_nsb',
      water: 'DMI dkss_idw',
      coordinate: location.coordinate,
      location: {
        id: location.id,
        forecastConfigRevision: location.forecastConfigRevision,
        name: location.name,
        areaName: location.areaName,
      },
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

function makeRuntime(options: {
  exact?: boolean;
  seed?: Record<string, unknown>;
} = {}) {
  const exact = options.exact ?? true;
  const store = new Map<string, string>();
  if (exact) {
    for (const location of LOCATIONS) {
      store.set(assembledForecastKey(location), JSON.stringify(cachedForecast(location.id)));
    }
  }
  for (const [key, value] of Object.entries(options.seed ?? {})) {
    store.set(key, JSON.stringify(value));
  }

  const waits: Promise<unknown>[] = [];
  const gets: string[] = [];
  const puts: Array<{ key: string; value: string }> = [];
  const env = {
    CF_VERSION_METADATA: {
      id: WORKER_VERSION_ID,
      tag: 'unit-test',
      timestamp: '2026-08-20T12:00:00.000Z',
    },
    FRANK_FORECAST_CACHE: {
      get: async (key: string, type?: string) => {
        gets.push(key);
        const raw = store.get(key);
        if (raw == null) return null;
        return type === 'json' ? JSON.parse(raw) : raw;
      },
      put: async (key: string, value: string) => {
        puts.push({ key, value });
        store.set(key, value);
      },
    },
  };
  const ctx = {
    waitUntil(value: Promise<unknown>) {
      waits.push(Promise.resolve(value));
    },
  };
  return { env, ctx, store, waits, gets, puts };
}

const request = (path: string, method = 'GET') =>
  new Request(`https://frank.test${path}`, { method });

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function rejectProviderWork() {
  return vi.spyOn(globalThis, 'fetch').mockRejectedValue(
    new Error('Browser route unexpectedly contacted a provider'),
  );
}

describe('Worker route HTTP contract', () => {
  const knownPaths = [
    '/',
    '/health',
    '/status',
    '/forecast/horsens',
    '/api/v1/forecast/horsens',
  ];

  it.each(knownPaths)('rejects mutating methods consistently on %s', async (path) => {
    const runtime = makeRuntime();
    const response = await worker.fetch(request(path, 'POST'), runtime.env, runtime.ctx);
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET, HEAD, OPTIONS');
  });

  it.each(knownPaths)('answers OPTIONS consistently on %s', async (path) => {
    const runtime = makeRuntime();
    const response = await worker.fetch(request(path, 'OPTIONS'), runtime.env, runtime.ctx);
    expect(response.status).toBe(204);
    expect(response.headers.get('Allow')).toBe('GET, HEAD, OPTIONS');
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, HEAD, OPTIONS');
    expect(response.headers.get('Access-Control-Expose-Headers')).toContain(
      RELEASE_HEADER.generationReady,
    );
  });

  it.each(['/health', '/forecast/horsens', '/api/v1/forecast/horsens'])(
    'models HEAD without a response body on %s',
    async (path) => {
      const runtime = makeRuntime();
      const response = await worker.fetch(request(path, 'HEAD'), runtime.env, runtime.ctx);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('');
    },
  );

  it('keeps routing strict and does not advertise unknown paths', async () => {
    const runtime = makeRuntime();
    const [unknown, futureApi, unknownOptions] = await Promise.all([
      worker.fetch(request('/forecast/not-a-place'), runtime.env, runtime.ctx),
      worker.fetch(request('/api/v2/forecast/horsens'), runtime.env, runtime.ctx),
      worker.fetch(request('/missing', 'OPTIONS'), runtime.env, runtime.ctx),
    ]);
    expect(unknown.status).toBe(404);
    expect(futureApi.status).toBe(404);
    expect(unknownOptions.status).toBe(404);
  });

  it('hardens the human status page against framing and referrer leakage', async () => {
    const runtime = makeRuntime();
    const response = await worker.fetch(request('/status'), runtime.env, runtime.ctx);
    expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    const body = await response.text();
    expect(body).toContain('Visitor requests only\n  read prepared snapshots');
    expect(body).not.toContain("visitor's request prompts a check");
    expect(body).toContain('EXACT GENERATION READY');
  });

  it('renders a self-contained FRANK status instrument with responsive location cards', async () => {
    const runtime = makeRuntime();
    const response = await worker.fetch(request('/status'), runtime.env, runtime.ctx);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    expect(body).toContain('class="frank-device-shell rating-');
    expect(body).toContain('class="frank-crt"');
    expect(body).toContain('class="gerty-face" viewBox="3 3.5 10 9"');
    expect(body).toContain('<rect x="4" y="5" width="1" height="1"/>');
    expect(body).toContain('<span class="frank-nameplate">FRANK</span>');
    expect(body).toContain('<span class="frank-location">Forecast worker</span>');
    expect(body).toContain('class="frank-display"');
    expect(body).toContain('class="pixel-sky"');
    expect(body).toContain("--font-heading:'Inter'");
    expect(body).toContain("--font-crt:'VT323'");
    expect(body).toContain('--bg-gradient:linear-gradient(180deg,#e5f2fc 0%,#eef7fd 38rem,#f5f7fa 78rem)');
    expect(body).toContain('--panel-bg:#f9fcff');
    expect(body).toContain('--crt-screen:#0a0e14');
    expect(body).toContain('class="instrument-panel"');
    expect(body).toContain('<thead>');
    expect(body).toContain('<tbody>');
    expect(body).toContain('@media (max-width:720px)');
    expect(body).toContain('@media (max-width:480px)');
    expect(body).toContain('@media (max-width:360px)');
    expect(body.match(/data-label="Location"/g) ?? []).toHaveLength(LOCATIONS.length);
    expect(body.match(/data-label="Status"/g) ?? []).toHaveLength(LOCATIONS.length);
    expect(body).not.toContain('F · R · A · N · K');
    expect(body).not.toContain('backdrop-filter');
    expect(body).not.toContain('class="banner');
    expect(body).not.toContain('<script');
    expect(body).not.toContain('@import');
    expect(body).not.toContain('url(');
  });

  it('maps healthy, partial, and failed health to the exact FRANK face expressions', async () => {
    const healthyRuntime = makeRuntime();
    const healthy = await worker.fetch(request('/status'), healthyRuntime.env, healthyRuntime.ctx);
    const healthyBody = await healthy.text();
    expect(healthyBody).toContain('class="frank-device-shell rating-safe"');
    expect(healthyBody).toContain('<rect x="4" y="9" width="1" height="1"/>');

    const now = Date.now();
    const partialEntries: HealthLocationEntry[] = LOCATIONS.map((location) => ({
      id: location.id,
      areaName: location.areaName,
      hasCache: true,
      exactGenerationReady: false,
      availabilitySource: 'generation:api1-model6',
      fetchedAt: new Date(now).toISOString(),
      cacheHealth: {
        status: 'current',
        lastAttemptAt: new Date(now).toISOString(),
      },
    }));
    const partialBody = await statusResponse(
      buildHealthPayload(partialEntries, false, now),
    ).text();
    expect(partialBody).toContain('class="frank-device-shell rating-caution"');
    expect(partialBody).toContain('<rect x="5" y="10" width="1" height="1"/>');
    expect(partialBody).not.toContain('<rect x="4" y="9" width="1" height="1"/>');

    const failedRuntime = makeRuntime({ exact: false });
    const failed = await worker.fetch(request('/status'), failedRuntime.env, failedRuntime.ctx);
    const failedBody = await failed.text();
    expect(failedBody).toContain('class="frank-device-shell rating-danger"');
    expect(failedBody).toContain('<rect x="5" y="9" width="1" height="1"/>');
    expect(failedBody).toContain('<rect x="4" y="10" width="1" height="1"/>');
  });

  it('shows degraded sources and the busy provider in the human status table', async () => {
    const horsens = cachedForecast();
    horsens.sources.cacheHealth = {
      ...horsens.sources.cacheHealth,
      providerBusy: true,
      busyProvider: 'marine',
      degradedSources: ['waves'],
    };
    const runtime = makeRuntime({
      seed: { [assembledForecastKey(locationById('horsens'))]: horsens },
    });

    const response = await worker.fetch(request('/status'), runtime.env, runtime.ctx);
    const body = await response.text();

    expect(body).toContain('provider busy · marine');
    expect(body).toContain('<span class="warn">waves</span>');
  });

  it('keeps the unversioned bootstrap route as an exact canonical alias', async () => {
    const runtime = makeRuntime();
    const providerFetch = rejectProviderWork();
    const [unversionedRoute, versionedRoute] = await Promise.all([
      worker.fetch(request('/forecast/horsens'), runtime.env, runtime.ctx),
      worker.fetch(request('/api/v1/forecast/horsens'), runtime.env, runtime.ctx),
    ]);
    expect(unversionedRoute.status).toBe(200);
    expect(versionedRoute.status).toBe(200);
    const unversionedBody = await unversionedRoute.json<ForecastData>();
    const versionedBody = await versionedRoute.json<ForecastData>();
    expect(unversionedBody).toEqual(versionedBody);
    expect(unversionedBody.sources.payloadVersion).toBe(7);
    expect(unversionedBody.sources.release).toEqual(CURRENT_RELEASE);
    expect(versionedBody.sources.payloadVersion).toBe(7);
    expect(versionedBody.sources.release).toEqual(CURRENT_RELEASE);
    expect(unversionedRoute.headers.get(RELEASE_HEADER.generationReady)).toBe('true');
    expect(versionedRoute.headers.get(RELEASE_HEADER.generationReady)).toBe('true');
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('returns exact release metadata in body and CORS-visible headers', async () => {
    const runtime = makeRuntime();
    const response = await worker.fetch(
      request('/api/v1/forecast/horsens'),
      runtime.env,
      runtime.ctx,
    );
    const body = await response.json<ForecastData>();
    expect(body.sources.release).toEqual(CURRENT_RELEASE);
    expect(response.headers.get(RELEASE_HEADER.apiSchema)).toBe('1');
    expect(response.headers.get(RELEASE_HEADER.modelRevision)).toBe('7');
    expect(response.headers.get(RELEASE_HEADER.dataGeneration)).toBe('api1-model7');
    expect(response.headers.get(RELEASE_HEADER.assembledCacheSchema)).toBe('1');
    expect(response.headers.get(RELEASE_HEADER.marineCacheSchema)).toBe('1');
    expect(response.headers.get(RELEASE_HEADER.payloadVersion)).toBe('7');
    expect(response.headers.get(RELEASE_HEADER.generationReady)).toBe('true');
    expect(response.headers.get('X-FRANK-Worker-Version')).toBe(WORKER_VERSION_ID);
  });

  it.each(['/forecast/horsens', '/forecast/horsens?refresh=1'])(
    'keeps browser request %s a pure prepared-snapshot read',
    async (path) => {
      const runtime = makeRuntime();
      const providerFetch = rejectProviderWork();
      const response = await worker.fetch(request(path), runtime.env, runtime.ctx);
      expect(response.status).toBe(200);
      expect((await response.json<ForecastData>()).sources.cacheHealth?.status).toBe('current');
      expect(response.headers.get('X-FRANK-Background-Check')).toBeNull();
      expect(runtime.waits).toHaveLength(0);
      expect(runtime.puts).toHaveLength(0);
      expect(providerFetch).not.toHaveBeenCalled();
    },
  );

  it('returns typed initialization without making a first visitor build data', async () => {
    const runtime = makeRuntime({ exact: false });
    const providerFetch = rejectProviderWork();
    const response = await worker.fetch(
      request('/forecast/aarhus'),
      runtime.env,
      runtime.ctx,
    );
    const body = await response.json();
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('600');
    expect(response.headers.get(RELEASE_HEADER.generationReady)).toBe('false');
    expect(body).toMatchObject({
      schemaVersion: 1,
      status: 'initializing',
      code: 'FORECAST_INITIALIZING',
      location: { id: 'aarhus' },
    });
    expect(runtime.puts).toHaveLength(0);
    expect(runtime.waits).toHaveLength(0);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('does not expose candidate warming through the unversioned alias', async () => {
    const runtime = makeRuntime({ exact: false });
    const providerFetch = rejectProviderWork();
    const response = await worker.fetch(
      request('/forecast/aarhus?warm=1'),
      runtime.env,
      runtime.ctx,
    );
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe('FORECAST_INITIALIZING');
    expect(runtime.puts).toHaveLength(0);
    expect(runtime.waits).toHaveLength(0);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('keeps candidate 429 state inside the target generation and honors its cooldown', async () => {
    const location = locationById('aarhus');
    const runtime = makeRuntime({ exact: false });
    const providerFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response('Server is busy: private detail', { status: 429 }),
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const first = await worker.fetch(
      request('/api/v1/forecast/aarhus?warm=1'),
      runtime.env,
      runtime.ctx,
    );
    expect(first.status).toBe(503);
    expect((await first.json()).code).toBe('FORECAST_INITIALIZING');
    expect(runtime.puts.map(({ key }) => key)).toEqual([initializationStateKey(location)]);
    expect(runtime.puts.every(({ key }) =>
      key.startsWith(`${generationKeyPrefix(CURRENT_RELEASE)}:`)))
      .toBe(true);
    await Promise.all(runtime.waits);

    const marker = JSON.parse(runtime.store.get(initializationStateKey(location)) ?? 'null');
    expect(marker).toMatchObject({
      schemaVersion: 2,
      status: 'initializing',
      locationId: location.id,
      forecastConfigRevision: location.forecastConfigRevision,
      provider: 'marine',
      busy: true,
    });

    const health = await worker.fetch(request('/health'), runtime.env, runtime.ctx);
    const healthBody = await health.json();
    expect(healthBody.locations.find(
      (entry: { id: string }) => entry.id === location.id,
    )).toMatchObject({
      hasCache: false,
      exactGenerationReady: false,
      initialization: {
        schemaVersion: 2,
        status: 'initializing',
        provider: 'marine',
        busy: true,
      },
    });

    const status = await worker.fetch(request('/status'), runtime.env, runtime.ctx);
    const statusBody = await status.text();
    expect(statusBody).toContain('INITIALIZING');
    expect(statusBody).toContain('initialization attempt ·');
    expect(statusBody).toContain('provider busy · marine');
    expect(statusBody).not.toContain('private detail');

    const callsAfterFirst = providerFetch.mock.calls.length;
    const repeated = await worker.fetch(
      request('/api/v1/forecast/aarhus?warm=1'),
      runtime.env,
      runtime.ctx,
    );
    expect(repeated.status).toBe(503);
    expect(providerFetch).toHaveBeenCalledTimes(callsAfterFirst);
  });

  it('honors a persisted generation-scoped cooldown without provider work', async () => {
    const location = locationById('kolding');
    const runtime = makeRuntime({
      exact: false,
      seed: {
        [initializationStateKey(location)]: {
          schemaVersion: 2,
          status: 'initializing',
          locationId: location.id,
          forecastConfigRevision: location.forecastConfigRevision,
          lastAttemptAt: new Date().toISOString(),
          retryAfterSeconds: 600,
          provider: 'marine',
          busy: false,
        },
      },
    });
    const providerFetch = rejectProviderWork();
    const response = await worker.fetch(
      request('/api/v1/forecast/kolding?warm=1'),
      runtime.env,
      runtime.ctx,
    );
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe('FORECAST_INITIALIZING');
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('distinguishes a non-busy provider outage while a first forecast initializes', async () => {
    const location = locationById('horsens');
    const marker = {
      schemaVersion: 2,
      status: 'initializing',
      locationId: location.id,
      forecastConfigRevision: location.forecastConfigRevision,
      lastAttemptAt: new Date().toISOString(),
      retryAfterSeconds: 600,
      provider: 'weather',
      busy: false,
    };
    const runtime = makeRuntime({
      exact: false,
      seed: { [initializationStateKey(location)]: marker },
    });
    const providerFetch = rejectProviderWork();

    const health = await worker.fetch(request('/health'), runtime.env, runtime.ctx);
    const healthBody = await health.json();
    expect(healthBody.locations.find(
      (entry: { id: string }) => entry.id === location.id,
    )?.initialization).toEqual(marker);

    const status = await worker.fetch(request('/status'), runtime.env, runtime.ctx);
    const statusBody = await status.text();
    expect(statusBody).toContain('provider unavailable · weather');
    expect(statusBody).not.toContain('provider busy · weather');
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('does not report an expired initialization marker as active', async () => {
    const location = locationById('horsens');
    const runtime = makeRuntime({
      exact: false,
      seed: {
        [initializationStateKey(location)]: {
          schemaVersion: 2,
          status: 'initializing',
          locationId: location.id,
          forecastConfigRevision: location.forecastConfigRevision,
          lastAttemptAt: new Date(Date.now() - 11 * 60_000).toISOString(),
          retryAfterSeconds: 600,
          provider: 'services',
          busy: true,
        },
      },
    });
    const providerFetch = rejectProviderWork();

    const health = await worker.fetch(request('/health'), runtime.env, runtime.ctx);
    const healthBody = await health.json();
    expect(healthBody.locations.find(
      (entry: { id: string }) => entry.id === location.id,
    )).not.toHaveProperty('initialization');

    const status = await worker.fetch(request('/status'), runtime.env, runtime.ctx);
    expect(await status.text()).toContain('awaiting provider data');
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('lets a completed target generation win over a leftover cooldown marker', async () => {
    const location = locationById('vejle');
    const runtime = makeRuntime({
      seed: {
        [initializationStateKey(location)]: {
          schemaVersion: 2,
          status: 'initializing',
          locationId: location.id,
          forecastConfigRevision: location.forecastConfigRevision,
          lastAttemptAt: new Date().toISOString(),
          retryAfterSeconds: 600,
          provider: 'weather',
          busy: true,
        },
      },
    });
    const providerFetch = rejectProviderWork();
    const response = await worker.fetch(
      request('/api/v1/forecast/vejle?warm=1'),
      runtime.env,
      runtime.ctx,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get(RELEASE_HEADER.generationReady)).toBe('true');
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('keeps malformed provider contracts on the hard failure path', async () => {
    const runtime = makeRuntime({ exact: false });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => (
      new Response(JSON.stringify({ unexpected: [] }), { status: 200 })
    ));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await worker.fetch(
      request('/api/v1/forecast/vejle?warm=1'),
      runtime.env,
      runtime.ctx,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: 'Forecast service failed',
      message: 'An internal error occurred while fetching or processing forecast data.',
    });
    expect(runtime.puts.some(({ key }) => key.includes(':state:initialization:'))).toBe(false);
    await Promise.all(runtime.waits);
  });

  it('ignores unmanaged historical keys instead of treating them as release data', async () => {
    const runtime = makeRuntime({
      exact: false,
      seed: {
        'forecast:horsens:weather-data:v7': cachedForecast('horsens'),
        'forecast:horsens:weather-data:v1': cachedForecast('horsens'),
      },
    });
    const providerFetch = rejectProviderWork();
    const response = await worker.fetch(
      request('/api/v1/forecast/horsens'),
      runtime.env,
      runtime.ctx,
    );
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe('FORECAST_INITIALIZING');
    expect(runtime.gets).not.toContain('forecast:horsens:weather-data:v7');
    expect(runtime.gets).not.toContain('forecast:horsens:weather-data:v1');
    expect(runtime.puts).toHaveLength(0);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('rejects corrupt target-generation KV as unavailable', async () => {
    const location = locationById('horsens');
    const runtime = makeRuntime({
      exact: false,
      seed: {
        [assembledForecastKey(location)]: {
          ...cachedForecast(location.id),
          hourly: [{ time: 'corrupt' }],
        },
      },
    });
    const response = await worker.fetch(
      request('/api/v1/forecast/horsens'),
      runtime.env,
      runtime.ctx,
    );
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe('FORECAST_INITIALIZING');
    expect(response.headers.get(RELEASE_HEADER.generationReady)).toBe('false');
    expect(runtime.puts).toHaveLength(0);
  });

  it('reports exact all-location readiness independently from availability health', async () => {
    const ids = LOCATIONS.map(({ id }) => id);
    const exactRuntime = makeRuntime();
    const exactResponse = await worker.fetch(
      request('/health'),
      exactRuntime.env,
      exactRuntime.ctx,
    );
    const exactBody = await exactResponse.json();
    expect(exactResponse.status).toBe(200);
    expect(exactBody.release).toEqual({
      target: CURRENT_RELEASE,
      allLocationsReady: true,
      ready: ids,
      available: ids,
      fallback: [],
      missing: [],
    });
    expect(exactBody.locations.every(
      (entry: { exactGenerationReady: boolean; availabilitySource: string }) =>
        entry.exactGenerationReady && entry.availabilitySource === 'generation',
    )).toBe(true);

    const emptyRuntime = makeRuntime({ exact: false });
    const emptyResponse = await worker.fetch(
      request('/health'),
      emptyRuntime.env,
      emptyRuntime.ctx,
    );
    const emptyBody = await emptyResponse.json();
    expect(emptyResponse.status).toBe(503);
    expect(emptyBody.ok).toBe(false);
    expect(emptyBody.release).toMatchObject({
      allLocationsReady: false,
      ready: [],
      available: [],
      fallback: [],
      missing: ids,
    });
  });
});
