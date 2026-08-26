import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import worker, { CRON_HEARTBEAT_KEY } from '../../worker/index';
import locationData from '../../src/config/locations.json';
import type { ForecastLocation } from '../../src/config/locationTypes';
import { FORECAST_PAYLOAD_VERSION } from '../../src/features/forecast/types';
import {
  CURRENT_RELEASE,
} from '../../src/features/forecast/releaseContract';
import { buildSunSchedule } from '../../src/features/forecast/sun';
import type { ForecastData, HealthLocationEntry, HealthPayload } from '../../worker/domain';
import { buildHealthPayload, statusResponse } from '../../worker/health';
import {
  RELEASE_HEADER,
  assembledForecastKey,
  generationKeyPrefix,
  initializationStateKey,
  marineIngredientKey,
} from '../../worker/generation';
import {
  DMI_RUN_MANIFEST_KEY,
  DMI_RUN_MANIFEST_SCHEMA_VERSION,
  dmiCollectionListKey,
} from '../../worker/providers';
import { completeMarineEnvelope, completeMarineSeries } from './marineTestData';

const LOCATIONS = locationData as ForecastLocation[];
const LAST_COMPLETED_CHECK = new Date(Date.now() - 5 * 60_000).toISOString();
const WORKER_VERSION_ID = 'cba7bd5e-93f4-4df7-8b61-8f00d5b6f3a1';
const WARM_TOKEN = 'test-only-frank-warm-token-with-256-bits-of-entropy';
const WARM_BUILD_NOW = Date.parse('2031-08-23T11:59:00.000Z');
const WARM_FORECAST_HOUR = '2031-08-23T13:00:00.000Z';
const WARM_CURRENT_RUN = '2031-08-23T060000Z';
const WARM_RETAINED_RUN = '2031-08-23T000000Z';
const subtleWithTimingSafeEqual = crypto.subtle as SubtleCrypto & {
  timingSafeEqual?: (left: ArrayBuffer | ArrayBufferView, right: ArrayBuffer | ArrayBufferView) => boolean;
};
const nativeTimingSafeEqual = subtleWithTimingSafeEqual.timingSafeEqual;

beforeAll(() => {
  if (nativeTimingSafeEqual) return;
  Object.defineProperty(subtleWithTimingSafeEqual, 'timingSafeEqual', {
    configurable: true,
    value(left: ArrayBuffer | ArrayBufferView, right: ArrayBuffer | ArrayBufferView): boolean {
      const leftBytes = ArrayBuffer.isView(left)
        ? new Uint8Array(left.buffer, left.byteOffset, left.byteLength)
        : new Uint8Array(left);
      const rightBytes = ArrayBuffer.isView(right)
        ? new Uint8Array(right.buffer, right.byteOffset, right.byteLength)
        : new Uint8Array(right);
      if (leftBytes.byteLength !== rightBytes.byteLength) throw new TypeError('Unequal lengths');
      let difference = 0;
      for (let index = 0; index < leftBytes.byteLength; index += 1) {
        difference |= leftBytes[index] ^ rightBytes[index];
      }
      return difference === 0;
    },
  });
});

afterAll(() => {
  if (!nativeTimingSafeEqual) delete subtleWithTimingSafeEqual.timingSafeEqual;
});

function locationById(id: string): ForecastLocation {
  const location = LOCATIONS.find((candidate) => candidate.id === id);
  if (!location) throw new Error(`Unknown test location: ${id}`);
  return location;
}

function currentDmiRunId(nowMs = Date.now()): string {
  const run = new Date(nowMs);
  run.setUTCMinutes(0, 0, 0);
  run.setUTCHours(Math.floor(run.getUTCHours() / 6) * 6);
  return run.toISOString().replace(/:/g, '').replace('.000', '');
}

function cachedForecast(locationId = 'horsens'): ForecastData {
  const location = locationById(locationId);
  const forecastTime = new Date(Date.now() + 60 * 60_000).toISOString();
  const sun = buildSunSchedule([forecastTime], location);
  const currentRun = currentDmiRunId();
  return {
    hourly: [{
      time: forecastTime,
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
      isDay: sun.isDayByTime.get(forecastTime) ?? false,
      weatherSource: 'met-locationforecast',
      marineSource: 'dmi-dkss-wam',
    }],
    sunrise: sun.sunrise,
    sunset: sun.sunset,
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
          water: { collection: 'dkss_idw', id: currentRun },
          waves: { collection: 'wam_nsb', id: currentRun },
        },
      },
    },
  };
}

function makeRuntime(options: {
  exact?: boolean;
  seed?: Record<string, unknown>;
  failPut?: (key: string) => boolean;
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
        if (options.failPut?.(key)) throw new Error(`Test KV write failure for ${key}`);
        store.set(key, value);
      },
    },
    FRANK_WARM_TOKEN: WARM_TOKEN,
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

const authorizedWarmRequest = (path: string, token = WARM_TOKEN, method = 'GET') =>
  new Request(`https://frank.test${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
  });

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function rejectProviderWork() {
  return vi.spyOn(globalThis, 'fetch').mockRejectedValue(
    new Error('Browser route unexpectedly contacted a provider'),
  );
}

function warmHeartbeat(locationId: string, nowMs = WARM_BUILD_NOW) {
  return {
    schemaVersion: 2,
    lastTickAt: new Date(nowMs - 60_000).toISOString(),
    locations: {
      [locationId]: new Date(nowMs - 43 * 60_000).toISOString(),
    },
    unreachable: {},
  };
}

function warmManifest(location: ForecastLocation, runId = WARM_CURRENT_RUN) {
  const discoveredAt = new Date(WARM_BUILD_NOW).toISOString();
  const declaredEndMs = Date.parse(WARM_FORECAST_HOUR);
  return {
    schemaVersion: DMI_RUN_MANIFEST_SCHEMA_VERSION,
    entries: {
      [dmiCollectionListKey(location.dmiCollections.water)]: {
        collection: location.dmiCollections.water[0],
        id: runId,
        declaredEndMs,
        discoveredAt,
      },
      [dmiCollectionListKey(location.dmiCollections.waves)]: {
        collection: location.dmiCollections.waves[0],
        id: runId,
        declaredEndMs,
        discoveredAt,
      },
    },
  };
}

function retainedMarineIngredient(
  location: ForecastLocation,
  kind: 'water' | 'waves',
) {
  return completeMarineEnvelope(location, kind, WARM_RETAINED_RUN);
}

function warmMetResponse(): Response {
  return Response.json({
    properties: {
      timeseries: [{
        time: WARM_FORECAST_HOUR,
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
  }, {
    headers: {
      Expires: new Date(WARM_BUILD_NOW + 60 * 60_000).toUTCString(),
      'Last-Modified': new Date(WARM_BUILD_NOW).toUTCString(),
    },
  });
}

function installWarmProviderResponses(marineBusy = false) {
  const calls: string[] = [];
  const providerFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('api.met.no/')) return warmMetResponse();
      if (url.includes('feeds.meteoalarm.org/')) {
        return new Response('<feed></feed>', { status: 200 });
      }
      if (url.includes('/instances/')) {
        if (marineBusy) {
          return new Response('Server is busy', {
            status: 429,
            headers: { 'Retry-After': '1200' },
          });
        }
        const water = url.includes('/collections/dkss_');
        const series = completeMarineSeries(
          water ? 'water' : 'waves',
          WARM_CURRENT_RUN,
          water ? 'dkss_idw' : 'wam_nsb',
        );
        return Response.json({
          features: series.map((point) => ({
            properties: water
              ? {
                  step: point.time,
                  'sea-mean-deviation': point.tideLevel,
                  'water-temperature': point.tempWater,
                  'current-u': 0,
                  'current-v': 0,
                }
              : {
                  step: point.time,
                  'significant-wave-height': point.waveHeight,
                  'mean-wave-dir': point.waveDirection,
                  'mean-wave-period': point.wavePeriod,
                },
          })),
        });
      }
      if (url.endsWith('/instances') && marineBusy) {
        return new Response('Server is busy', {
          status: 429,
          headers: { 'Retry-After': '1200' },
        });
      }
      throw new Error(`Unexpected provider URL: ${url}`);
    },
  );
  return { calls, providerFetch };
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

  it('/health keeps a recently contacted degraded city out of not-checking', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // Advance past the isolate-local heartbeat memo without making the other
      // three five-minute-old fixtures stale.
      const now = Date.now() + 31_000;
      vi.setSystemTime(now);
      const location = locationById('kolding');
      const degraded = cachedForecast(location.id);
      degraded.sources.fetchedAt = new Date(now - 13 * 60_000).toISOString();
      degraded.sources.cacheHealth = {
        ...degraded.sources.cacheHealth!,
        lastAttemptAt: new Date(now - 2 * 60 * 60_000).toISOString(),
        degradedSources: ['waves'],
      };
      const lastTickAt = new Date(now - 60_000).toISOString();
      const runtime = makeRuntime({
        seed: {
          [assembledForecastKey(location)]: degraded,
          [CRON_HEARTBEAT_KEY]: {
            schemaVersion: 2,
            lastTickAt,
            locations: {
              [location.id]: new Date(now - 4 * 60_000).toISOString(),
            },
            unreachable: {},
          },
        },
      });

      const response = await worker.fetch(request('/health'), runtime.env, runtime.ctx);
      const body = await response.json() as HealthPayload;
      const kolding = body.locations.find(({ id }) => id === location.id);

      expect(response.status).toBe(200);
      expect(body.reason).toBeNull();
      expect(body.stalled).not.toContain(location.id);
      expect(kolding?.cacheHealth?.lastAttemptAt).toBe(lastTickAt);
      expect(kolding?.cacheHealth?.degradedSources).toEqual(['waves']);
    } finally {
      vi.useRealTimers();
    }
  });

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
    // Anchored to the section, not a sentence: this test is about the security
    // headers, and it should not fail because the operator notes were reworded.
    expect(body).toContain('How to read this instrument');
    expect(body).toContain('Only those operational paths may start provider');
    expect(body).not.toContain("visitor's request prompts a check");
    expect(body).toContain('Forecast locations');
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
    // The status message is a sentence with an indicator, not a glass panel:
    // an operations page is read, not admired, and the CSP forbids the
    // external font the panel was set in, so it never rendered as one anyway.
    expect(body).toContain('class="status-readout"');
    expect(body).toContain('class="status-dot"');
    expect(body).not.toContain('class="frank-display"');
    // The generation target moved out of a boxed panel and onto the device's
    // meta line, alongside the heartbeat.
    expect(body).toContain('class="device-meta"');
    expect(body).toContain(CURRENT_RELEASE.dataGenerationId);
    expect(body).not.toContain('aria-label="Status page operations"');
    expect(body).not.toContain('<span>Auto refresh</span>');
    expect(body).toContain('class="pixel-sky"');
    expect(body).toContain("--font-heading:'Inter'");
    expect(body).not.toContain('--font-crt');
    expect(body).toContain('--bg-gradient:linear-gradient(180deg,#e5f2fc 0%,#eef7fd 38rem,#f5f7fa 78rem)');
    expect(body).toContain('--panel-bg:#f9fcff');
    expect(body).toContain('--crt-screen:#0a0e14');
    expect(body).toContain('class="instrument-panel"');
    expect(body.match(/class="board-group [^"]*" data-location=/g) ?? []).toHaveLength(LOCATIONS.length);
    expect(body).toContain('<table class="board">');
    expect(body).toContain('@media (max-width:720px)');
    expect(body).toContain('@media (max-width:480px)');
    expect(body).toContain('@media (max-width:360px)');
    const narrowCssStart = body.indexOf('@media (max-width:360px)');
    const narrowCssEnd = body.indexOf('@media (prefers-reduced-motion:reduce)');
    expect(narrowCssStart).toBeGreaterThan(-1);
    expect(narrowCssEnd).toBeGreaterThan(narrowCssStart);
    const narrowCss = body.slice(narrowCssStart, narrowCssEnd);
    const phoneCss = body.slice(body.indexOf('@media (max-width:480px)'), narrowCssStart);
    // The status message must survive the narrowest screen. An earlier rule hid
    // the display and kept the refresh-interval panel, so the smallest phone
    // showed a face and a constant but not the state.
    // The narrow block used to restate the grid it already inherits; pin the
    // base areas instead, and pin that nothing narrow takes the display away.
    expect(body).toContain("grid-template-areas:\n      'crt display'\n      'name display';");
    expect(narrowCss).not.toMatch(/\.frank-(?:cell-)?display[^}]*display:none/);
    // Two bays, not three. A third track with no grid area assigned to it left
    // 104px of blank housing beside the message and squeezed the glass to about
    // 128px, which wrapped even 'all locations current' onto three lines.
    expect(phoneCss).toContain('grid-template-columns:64px minmax(0,1fr);');
    expect(body).toMatch(/\.cell-name \{[^}]*display:flex;[^}]*gap:8px;/);
    // The generation badge is no longer demoted when healthy - it is not
    // rendered at all. A row only carries it when the location is off target,
    // so it is always an exception and always earns its colour.
    expect(body).not.toContain('generation-state good');
    expect(body).not.toContain('EXACT GENERATION READY');
    expect(body).toContain(`${locationById('horsens').areaName}`);
    expect(body).not.toContain('class="location-index"');
    expect(body).not.toContain('.location-index {');
    expect(body).not.toContain('.neutral {');
    expect(body).not.toContain('.dim {');
    expect(body).not.toContain('.mono {');
    expect(body.match(/data-source="weather"/g) ?? []).toHaveLength(LOCATIONS.length);
    expect(body.match(/data-source="water"/g) ?? []).toHaveLength(LOCATIONS.length);
    expect(body.match(/data-source="waves"/g) ?? []).toHaveLength(LOCATIONS.length);
    expect(body.match(/data-source="warnings"/g) ?? []).toHaveLength(LOCATIONS.length);
    // Provider attribution is stated once as a legend rather than repeated in
    // every location's card head.
    expect(body).toContain('<span><b>Weather</b> MET Norway</span>');
    // The legend also names which six-hourly DMI run each source is on. When
    // cities diverge onto different runs - the failure that took a night to
    // diagnose - every run is listed, so the split is visible at a glance.
    // Dated in full: an hour alone cannot say whether a city is on today's
    // midnight run or yesterday's, which is the question during a stall.
    expect(body).toMatch(/<span><b>Water<\/b> DMI DKSS \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC<\/span>/);
    expect(body).toMatch(/<span><b>Waves<\/b> DMI WAM \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC<\/span>/);
    expect(body).toContain('<span><b>Warnings</b> MeteoAlarm</span>');
    expect(body).toContain('Polled with the forecast');
    // A real data table now, with header cells and row scopes - not the layout
    // table this assertion originally guarded against.
    expect(body).toContain('<table class="board">');
    expect(body).toContain('<th scope="row" class="cell-name">');
    expect(body).not.toContain('F · R · A · N · K');
    expect(body).not.toContain('backdrop-filter');
    expect(body).not.toContain('class="banner');
    expect(body).not.toContain('<script');
    expect(body).not.toContain('@import');
    expect(body).not.toContain('url(');
  });

  it('renders exceptional cache states in one lowercase register', async () => {
    const now = Date.parse('2026-08-20T18:00:00.000Z');
    const location = locationById('horsens');
    const missing: HealthLocationEntry = {
      id: location.id,
      areaName: location.areaName,
      hasCache: false,
      exactGenerationReady: false,
      availabilitySource: 'none',
    };
    const initializing: HealthLocationEntry = {
      ...missing,
      initialization: {
        schemaVersion: 2,
        status: 'initializing',
        locationId: location.id,
        forecastConfigRevision: location.forecastConfigRevision,
        lastAttemptAt: new Date(now).toISOString(),
        retryAfterSeconds: 600,
        provider: 'marine',
        busy: false,
      },
    };
    const available: HealthLocationEntry = {
      ...missing,
      hasCache: true,
      exactGenerationReady: true,
      availabilitySource: 'generation',
      fetchedAt: new Date(now).toISOString(),
      cacheHealth: {
        status: 'current',
        lastAttemptAt: new Date(now).toISOString(),
      },
    };
    const [awaitingBody, initializingBody, storageBody] = await Promise.all([
      statusResponse(buildHealthPayload([missing], false, now)).text(),
      statusResponse(buildHealthPayload([initializing], false, now)).text(),
      statusResponse(buildHealthPayload([available], true, now)).text(),
    ]);
    const cacheState = (body: string): string | undefined => body.match(
      /<tr class="board-note[^"]*"><td colspan="7">([^<·]+)/,
    )?.[1]?.trim();

    expect(cacheState(awaitingBody)).toBe('awaiting data');
    expect(cacheState(initializingBody)).toBe('initializing');
    expect(cacheState(storageBody)).toBe('storage unavailable');
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

  it('shows degraded sources and the busy provider in the human status cards', async () => {
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
    const horsensCard = body.match(/<tbody class="board-group[^"]*" data-location="horsens">[\s\S]*?<\/tbody>/)?.[0] ?? '';

    expect(body).toContain('provider busy · marine');
    expect(horsensCard).toMatch(/tone-warn" data-source="waves"[\s\S]*?Provider busy/);
    // A healthy source carries no tone class and no annotation: on this panel
    // colour and commentary are reserved for exceptions.
    expect(horsensCard).toMatch(/class="num " data-source="water"/);
    expect(horsensCard).not.toMatch(/data-source="water"[^>]*>(?:(?!<\/td>)[\s\S])*?Provider busy/);
  });

  it('keeps every value cell on the board a duration', async () => {
    const now = Date.parse('2026-08-20T18:00:00.000Z');
    const entries: HealthLocationEntry[] = [{
      id: 'horsens',
      areaName: 'Horsens Fjord',
      hasCache: true,
      exactGenerationReady: true,
      availabilitySource: 'generation',
      fetchedAt: '2026-08-20T17:45:00.000Z',
      cacheHealth: {
        status: 'current',
        lastAttemptAt: '2026-08-20T17:50:00.000Z',
        weatherLastModified: '2026-08-20T17:30:00.000Z',
        marineInstances: {
          water: { collection: 'dkss_idw', id: '2026-08-20T120000Z' },
          waves: { collection: 'wam_nsb', id: '2026-08-20T120000Z' },
        },
      },
    }];
    const body = await statusResponse(buildHealthPayload(entries, false, now)).text();
    const card = body.match(/<tbody class="board-group[^"]*" data-location="horsens">[\s\S]*?<\/tbody>/)?.[0] ?? '';

    // One column reading "00:00Z" while its neighbours read "16 min" makes the
    // row scan as two different measurements. Every value is an age, a dash, or
    // an explicit "not recorded" - never a clock stamp.
    const values = [...card.matchAll(/<span class="cell-value">([^<]*)<\/span>/g)].map((m) => m[1].trim());
    expect(values.length).toBeGreaterThanOrEqual(6);
    for (const value of values) {
      expect(value).toMatch(/^(\d+h \d+m|\d+ min|—|not recorded|initializing)$/);
    }
  });

  it('names an overdue run and its expected publication time without colouring it', async () => {
    // 2026-08-20T00:00Z run, read at 11:30Z. DKSS publishes the next one at
    // 00:00 + 6h + 3h20 = 09:20Z, so by 11:30 we have been waiting 2h10 for a
    // run that exists - which is a fact worth stating, not a fault worth
    // colouring: the forecast on screen remains inside the 12-hour fallback
    // limit. At 12:30 this fixture would be expired, not ordinarily due.
    const now = Date.parse('2026-08-20T11:30:00.000Z');
    const entries: HealthLocationEntry[] = [{
      id: 'horsens',
      areaName: 'Horsens Fjord',
      hasCache: true,
      exactGenerationReady: true,
      availabilitySource: 'generation',
      fetchedAt: '2026-08-20T11:25:00.000Z',
      cacheHealth: {
        status: 'current',
        lastAttemptAt: '2026-08-20T11:28:00.000Z',
        weatherLastModified: '2026-08-20T11:00:00.000Z',
        marineInstances: {
          water: { collection: 'dkss_idw', id: '2026-08-20T000000Z' },
          waves: { collection: 'wam_nsb', id: '2026-08-20T000000Z' },
        },
      },
    }];

    const body = await statusResponse(buildHealthPayload(entries, false, now)).text();
    const card = body.match(/<tbody class="board-group[^"]*" data-location="horsens">[\s\S]*?<\/tbody>/)?.[0] ?? '';
    const waterCell = card.match(/<td class="num " data-source="water"[\s\S]*?<\/td>/)?.[0] ?? '';

    // Waiting for the next run is ordinary operation - we hold a valid run and
    // the rotation picks the new one up within minutes - so it carries no tone.
    // Only provider-busy and last-good fallback, which mean something is
    // actually broken, colour a cell.
    // Rendered as two note lines rather than one long nowrap string, which used
    // to make this column wider than the numbers above it and stretch the board.
    expect(waterCell).toContain('<span class="cell-note">Waiting for 06:00Z run</span>');
    expect(waterCell).toContain('<span class="cell-note">due 09:20 UTC, 2h 10m ago</span>');
    expect(card).not.toContain('Run overdue');
    expect(card).not.toMatch(/tone-warn" data-source="water"/);
    expect(card).not.toMatch(/tone-warn" data-source="waves"/);
    // The value uses the held run's estimated release (00:00Z + 3h20), while
    // the note separately labels lateness against the awaited 06:00Z run.
    expect(waterCell).toContain('8h 10m');
  });

  it('names an awaited run before its expected publication time without colouring it', async () => {
    // The 06:00Z DKSS run opens its next gate at 15:10Z, ten minutes before
    // DMI's published completion estimate for the awaited 12:00Z run.
    const now = Date.parse('2026-08-20T15:15:00.000Z');
    const entries: HealthLocationEntry[] = [{
      id: 'horsens',
      areaName: 'Horsens Fjord',
      hasCache: true,
      exactGenerationReady: true,
      availabilitySource: 'generation',
      fetchedAt: '2026-08-20T15:10:00.000Z',
      cacheHealth: {
        status: 'current',
        lastAttemptAt: '2026-08-20T15:12:00.000Z',
        weatherLastModified: '2026-08-20T15:00:00.000Z',
        marineInstances: {
          water: { collection: 'dkss_idw', id: '2026-08-20T060000Z' },
          waves: { collection: 'wam_nsb', id: '2026-08-20T120000Z' },
        },
      },
    }];

    const body = await statusResponse(buildHealthPayload(entries, false, now)).text();
    const card = body.match(/<tbody class="board-group[^"]*" data-location="horsens">[\s\S]*?<\/tbody>/)?.[0] ?? '';
    const waterCell = card.match(/<td class="num " data-source="water"[\s\S]*?<\/td>/)?.[0] ?? '';

    expect(waterCell).toContain('<span class="cell-note">Waiting for 12:00Z run</span>');
    expect(waterCell).toContain('<span class="cell-note">expected 15:20 UTC</span>');
    expect(waterCell).not.toContain('due 15:20 UTC');
    expect(card).not.toMatch(/tone-warn" data-source="water"/);
  });

  it('shows a newer manifest run as neutral operator evidence until it is accepted', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(WARM_BUILD_NOW);
    const location = locationById('horsens');
    const held = cachedForecast(location.id);
    held.sources.fetchedAt = new Date(WARM_BUILD_NOW - 5 * 60_000).toISOString();
    held.sources.cacheHealth!.lastAttemptAt = held.sources.fetchedAt;
    held.sources.cacheHealth!.marineInstances!.water = {
      collection: location.dmiCollections.water[0],
      id: WARM_RETAINED_RUN,
    };
    const runtime = makeRuntime({
      seed: {
        [assembledForecastKey(location)]: held,
        [DMI_RUN_MANIFEST_KEY]: warmManifest(location, WARM_CURRENT_RUN),
      },
    });

    const response = await worker.fetch(request('/status'), runtime.env, runtime.ctx);
    const body = await response.text();
    const horsensCard = body.match(
      /<tbody class="board-group[^"]*" data-location="horsens">[\s\S]*?<\/tbody>/,
    )?.[0] ?? '';

    expect(response.status).toBe(200);
    expect(runtime.gets.filter((key) => key === DMI_RUN_MANIFEST_KEY)).toHaveLength(1);
    expect(horsensCard).toContain('Catalogue candidate 06:00Z discovered');
    expect(horsensCard).toContain('complete position series not yet accepted');
    expect(horsensCard).toMatch(/class="num " data-source="water"/);
    expect(horsensCard).not.toMatch(/tone-warn" data-source="water"/);

    held.sources.cacheHealth!.marineInstances!.water = {
      collection: location.dmiCollections.water[0],
      id: WARM_CURRENT_RUN,
    };
    const accepted = makeRuntime({
      seed: {
        [assembledForecastKey(location)]: held,
        [DMI_RUN_MANIFEST_KEY]: warmManifest(location, WARM_CURRENT_RUN),
      },
    });
    const acceptedBody = await (
      await worker.fetch(request('/status'), accepted.env, accepted.ctx)
    ).text();
    expect(acceptedBody).not.toContain('Catalogue candidate 06:00Z discovered');
  });

  it('keeps run-manifest candidates out of the machine health route', async () => {
    const location = locationById('horsens');
    const runtime = makeRuntime({
      seed: { [DMI_RUN_MANIFEST_KEY]: warmManifest(location, WARM_CURRENT_RUN) },
    });

    const response = await worker.fetch(request('/health'), runtime.env, runtime.ctx);
    const body = await response.text();

    expect(runtime.gets).not.toContain(DMI_RUN_MANIFEST_KEY);
    expect(body).not.toContain('discoveredAt');
    expect(body).not.toContain('run found');
  });

  it('clamps a not-yet-released marine run to a nonnegative age', async () => {
    // The 12:00Z DKSS run is valid provenance at 15:15Z, while its published
    // completion estimate is still five minutes away at 15:20Z.
    const now = Date.parse('2026-08-20T15:15:00.000Z');
    const entries: HealthLocationEntry[] = [{
      id: 'horsens',
      areaName: 'Horsens Fjord',
      hasCache: true,
      exactGenerationReady: true,
      availabilitySource: 'generation',
      fetchedAt: '2026-08-20T15:10:00.000Z',
      cacheHealth: {
        status: 'current',
        lastAttemptAt: '2026-08-20T15:12:00.000Z',
        weatherLastModified: '2026-08-20T15:00:00.000Z',
        marineInstances: {
          water: { collection: 'dkss_idw', id: '2026-08-20T120000Z' },
          waves: { collection: 'wam_nsb', id: '2026-08-20T120000Z' },
        },
      },
    }];

    const body = await statusResponse(buildHealthPayload(entries, false, now)).text();
    const card = body.match(/<tbody class="board-group[^"]*" data-location="horsens">[\s\S]*?<\/tbody>/)?.[0] ?? '';
    const waterCell = card.match(/<td class="num " data-source="water"[\s\S]*?<\/td>/)?.[0] ?? '';
    const waterValue = waterCell.match(/<span class="cell-value">([^<]*)<\/span>/)?.[1];

    expect(waterValue).toBe('0 min');
    expect(waterValue).not.toMatch(/^-|NaN/);
    expect(waterCell).not.toContain('Run time in future');
    expect(waterCell).not.toContain('Age not recorded');
  });

  it('warns on each invalid marine provenance class instead of calling it an expected run', async () => {
    const now = Date.parse('2026-08-20T18:00:00.000Z');
    const validWaves = { collection: 'wam_nsb', id: '2026-08-20T120000Z' };
    const cases = [
      {
        name: 'missing provenance',
        water: undefined,
        expectedState: 'Run provenance missing',
        degraded: false,
      },
      {
        name: 'malformed run id',
        water: { collection: 'dkss_idw', id: 'not-a-dmi-run' },
        expectedState: 'Run time malformed',
        degraded: false,
      },
      {
        name: 'future run id',
        water: { collection: 'dkss_idw', id: '2026-08-21T000000Z' },
        expectedState: 'Run time in future',
        degraded: false,
      },
      {
        name: 'expired run id',
        water: { collection: 'dkss_idw', id: '2026-08-20T000000Z' },
        expectedState: 'Run expired',
        degraded: true,
      },
      {
        name: 'unknown collection',
        water: { collection: 'unknown_marine_model', id: '2026-08-20T120000Z' },
        expectedState: 'Collection unknown',
        degraded: false,
      },
    ] as const;

    for (const faultCase of cases) {
      const entries: HealthLocationEntry[] = [{
        id: 'horsens',
        areaName: 'Horsens Fjord',
        hasCache: true,
        exactGenerationReady: true,
        availabilitySource: 'generation',
        fetchedAt: '2026-08-20T17:45:00.000Z',
        cacheHealth: {
          status: 'current',
          lastAttemptAt: '2026-08-20T17:50:00.000Z',
          weatherLastModified: '2026-08-20T17:30:00.000Z',
          degradedSources: faultCase.degraded ? ['water'] : [],
          marineInstances: {
            water: faultCase.water,
            waves: validWaves,
          } as unknown as NonNullable<HealthLocationEntry['cacheHealth']>['marineInstances'],
        },
      }];

      const body = await statusResponse(buildHealthPayload(entries, false, now)).text();
      const card = body.match(/<tbody class="board-group[^"]*" data-location="horsens">[\s\S]*?<\/tbody>/)?.[0] ?? '';
      const waterCell = card.match(/<td class="num tone-warn" data-source="water"[\s\S]*?<\/td>/)?.[0] ?? '';

      expect(waterCell, faultCase.name).toContain(faultCase.expectedState);
      if (faultCase.degraded) {
        expect(waterCell, faultCase.name).toContain('Last-good fallback');
      }
      expect(waterCell, faultCase.name).not.toContain('Waiting for');
      expect(waterCell, faultCase.name).not.toContain('Next run expected');
      if (faultCase.name === 'expired run id') {
        // Even a faulted known collection keeps the release clock: 00:00Z plus
        // DKSS's 3h20 completion delay is an estimated 03:20Z release.
        expect(waterCell).toContain('<span class="cell-value">14h 40m</span>');
      }
      expect(body, faultCase.name).not.toContain('NaN');
    }
  });

  it('shows comparable provider release ages without claiming MeteoAlarm health', async () => {
    const now = Date.parse('2026-08-20T18:00:00.000Z');
    const entries: HealthLocationEntry[] = [{
      id: 'horsens',
      areaName: 'Horsens Fjord',
      hasCache: true,
      exactGenerationReady: true,
      availabilitySource: 'generation',
      fetchedAt: '2026-08-20T17:45:00.000Z',
      cacheHealth: {
        status: 'current',
        lastAttemptAt: '2026-08-20T17:50:00.000Z',
        weatherLastModified: '2026-08-20T17:30:00.000Z',
        marineInstances: {
          water: { collection: 'dkss_idw', id: '2026-08-20T120000Z' },
          waves: { collection: 'wam_nsb', id: '2026-08-20T120000Z' },
        },
      },
    }];

    const body = await statusResponse(buildHealthPayload(entries, false, now)).text();

    expect(body).toContain('30 min');
    // A 12:00Z run at 18:00 is the newest one due. Its release-clock ages are
    // 2h40 for DKSS (published completion +3h20) and 3h15 for WAM NSB (+2h45).
    // The run identity remains the legend's job and the cell title's.
    const provenanceCard = body.match(/<tbody class="board-group[^"]*" data-location="horsens">[\s\S]*?<\/tbody>/)?.[0] ?? '';
    const waterCell = provenanceCard.match(/<td class="num " data-source="water"[\s\S]*?<\/td>/)?.[0] ?? '';
    const wavesCell = provenanceCard.match(/<td class="num " data-source="waves"[\s\S]*?<\/td>/)?.[0] ?? '';
    expect(waterCell).toContain('<span class="cell-value">2h 40m</span>');
    expect(wavesCell).toContain('<span class="cell-value">3h 15m</span>');
    expect(provenanceCard).not.toMatch(/cell-value">\d{2}:\d{2}Z/);
    expect(provenanceCard).toMatch(/class="num " data-source="water"/);
    expect(provenanceCard).toMatch(/class="num " data-source="waves"/);
    // The run is still named where it belongs.
    expect(provenanceCard).toContain('Model run 2026-08-20 12:00 UTC');
    expect(body).toContain('Forecast issued 2026-08-20 17:30 UTC');
    expect(body).not.toContain('Forecast issued 2026-08-20 17:30:00 UTC');
    expect(body).toContain('Model run 2026-08-20 12:00 UTC');
    expect(body).not.toContain('Model run 2026-08-20 12:00:00 UTC');
    expect(body).toContain('Page rendered 2026-08-20 18:00:00 UTC');
    // The Warnings card must not invent a clock. It previously showed
    // `${formatAge(age.ageMs)} snapshot`, which was the Forecast age vital
    // relabelled as a warnings fact - two identical numbers, one of them
    // mislabelled. Warnings ride the forecast poll and have no age of their own.
    expect(body).toContain('—');
    expect(body).toContain('Polled with the forecast');
    expect(body).not.toContain('MeteoAlarm current');
    expect(body).not.toMatch(/\d+\s*min snapshot/);
  });

  it('keeps scheduler, provider-contact, and forecast ages separate on /status', async () => {
    const now = Date.parse('2026-08-20T18:00:00.000Z');
    const entries: HealthLocationEntry[] = [{
      id: 'horsens',
      areaName: 'Horsens Fjord',
      hasCache: true,
      exactGenerationReady: true,
      availabilitySource: 'generation',
      fetchedAt: '2026-08-20T17:15:00.000Z',
      cacheHealth: {
        status: 'current',
        lastAttemptAt: '2026-08-20T17:40:00.000Z',
        checkedBy: 'release-candidate',
      },
    }];
    const heartbeat = {
      schemaVersion: 1 as const,
      lastTickAt: '2026-08-20T17:55:00.000Z',
      locations: {},
    };

    const body = await statusResponse(
      buildHealthPayload(entries, false, now, heartbeat),
    ).text();
    const horsensCard = body.match(
      /<tbody class="board-group[^"]*" data-location="horsens">[\s\S]*?<\/tbody>/,
    )?.[0] ?? '';

    expect(body).toContain('Cron heartbeat: live · 5m ago');
    expect(horsensCard).toContain('>45 min<');
    expect(horsensCard).toContain('>20 min<');
    expect(horsensCard).toContain('release-candidate');
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
    expect(response.headers.get(RELEASE_HEADER.apiSchema))
      .toBe(String(CURRENT_RELEASE.apiSchemaVersion));
    expect(response.headers.get(RELEASE_HEADER.modelRevision))
      .toBe(String(CURRENT_RELEASE.modelRevision));
    expect(response.headers.get(RELEASE_HEADER.dataGeneration))
      .toBe(CURRENT_RELEASE.dataGenerationId);
    expect(response.headers.get(RELEASE_HEADER.assembledCacheSchema))
      .toBe(String(CURRENT_RELEASE.assembledCacheSchema));
    expect(response.headers.get(RELEASE_HEADER.marineCacheSchema))
      .toBe(String(CURRENT_RELEASE.marineCacheSchema));
    expect(response.headers.get(RELEASE_HEADER.payloadVersion))
      .toBe(String(CURRENT_RELEASE.payloadVersion));
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
      retryAfterSeconds: 600,
      location: { id: 'aarhus' },
    });
    expect(runtime.puts).toHaveLength(0);
    expect(runtime.waits).toHaveLength(0);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it.each([
    ['missing authorization', request('/api/v1/forecast/aarhus?warm=1')],
    ['wrong authorization', authorizedWarmRequest('/api/v1/forecast/aarhus?warm=true', 'wrong-token')],
  ])('hides candidate warming for %s before any cache or provider I/O', async (_label, warmRequest) => {
    const runtime = makeRuntime({ exact: false });
    const providerFetch = rejectProviderWork();

    const response = await worker.fetch(warmRequest, runtime.env, runtime.ctx);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
    expect(runtime.gets).toHaveLength(0);
    expect(runtime.puts).toHaveLength(0);
    expect(runtime.waits).toHaveLength(0);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('requires warm authorization before method handling', async () => {
    const runtime = makeRuntime({ exact: false });
    const response = await worker.fetch(
      request('/api/v1/forecast/aarhus?warm=1', 'OPTIONS'),
      runtime.env,
      runtime.ctx,
    );

    expect(response.status).toBe(404);
    expect(runtime.gets).toHaveLength(0);
  });

  it('fails closed when the required warm secret binding is unavailable', async () => {
    const runtime = makeRuntime({ exact: false });
    runtime.env.FRANK_WARM_TOKEN = '';
    const providerFetch = rejectProviderWork();

    const response = await worker.fetch(
      authorizedWarmRequest('/api/v1/forecast/aarhus?warm=1'),
      runtime.env,
      runtime.ctx,
    );

    expect(response.status).toBe(404);
    expect(runtime.gets).toHaveLength(0);
    expect(runtime.puts).toHaveLength(0);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('does not expose candidate warming through the unversioned alias', async () => {
    const runtime = makeRuntime({ exact: false });
    const providerFetch = rejectProviderWork();
    const response = await worker.fetch(
      authorizedWarmRequest('/forecast/aarhus?warm=1'),
      runtime.env,
      runtime.ctx,
    );
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe('FORECAST_INITIALIZING');
    expect(runtime.puts).toHaveLength(0);
    expect(runtime.waits).toHaveLength(0);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('records and throttles candidate contact without advancing scheduler liveness', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(WARM_BUILD_NOW);
      const location = locationById('aarhus');
      const previousHeartbeat = warmHeartbeat(location.id);
      const runtime = makeRuntime({
        exact: false,
        seed: {
          [CRON_HEARTBEAT_KEY]: previousHeartbeat,
          [DMI_RUN_MANIFEST_KEY]: warmManifest(location),
        },
        // Keep the generation cold so the second request genuinely reaches
        // providers and exercises the heartbeat throttle rather than the
        // route's already-prepared early return.
        failPut: (key) => key === assembledForecastKey(location),
      });
      const { calls, providerFetch } = installWarmProviderResponses();
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const response = await worker.fetch(
        authorizedWarmRequest('/api/v1/forecast/aarhus?warm=1'),
        runtime.env,
        runtime.ctx,
      );
      const body = await response.json<ForecastData>();
      await Promise.all(runtime.waits);

      expect(response.status).toBe(200);
      expect(calls.filter((url) => url.includes('api.met.no/'))).toHaveLength(1);
      expect(calls.filter((url) => url.includes('/instances/'))).toHaveLength(2);
      const attemptedAt = body.sources.cacheHealth?.lastAttemptAt;
      expect(attemptedAt).toBe(new Date(WARM_BUILD_NOW).toISOString());
      const heartbeat = JSON.parse(runtime.store.get(CRON_HEARTBEAT_KEY)!);
      expect(heartbeat.locations[location.id]).toBe(attemptedAt);
      expect(heartbeat.lastTickAt).toBe(previousHeartbeat.lastTickAt);
      expect(runtime.puts.filter(({ key }) => key === CRON_HEARTBEAT_KEY)).toHaveLength(1);
      expect(runtime.store.has(assembledForecastKey(location))).toBe(false);

      // Model an equal-time scheduled failure becoming visible between two
      // warm attempts. The second contact does not outrank it, so it is not a
      // recovery and must not force its way through the cadence throttle.
      const equalFailureHeartbeat = {
        ...heartbeat,
        unreachable: { [location.id]: attemptedAt },
      };
      runtime.store.set(CRON_HEARTBEAT_KEY, JSON.stringify(equalFailureHeartbeat));
      const providerCallsAfterBuild = providerFetch.mock.calls.length;
      const heartbeatWritesAfterBuild = runtime.puts.filter(
        ({ key }) => key === CRON_HEARTBEAT_KEY,
      ).length;
      const repeated = await worker.fetch(
        authorizedWarmRequest('/api/v1/forecast/aarhus?warm=1'),
        runtime.env,
        runtime.ctx,
      );
      expect(repeated.status).toBe(200);
      await Promise.all(runtime.waits);
      expect(providerFetch.mock.calls.length).toBeGreaterThan(providerCallsAfterBuild);
      expect(runtime.puts.filter(({ key }) => key === CRON_HEARTBEAT_KEY))
        .toHaveLength(heartbeatWritesAfterBuild);
      expect(JSON.parse(runtime.store.get(CRON_HEARTBEAT_KEY)!)).toEqual(equalFailureHeartbeat);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns a successful warm response before its heartbeat write completes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(WARM_BUILD_NOW);
      const location = locationById('aarhus');
      const previousHeartbeat = warmHeartbeat(location.id);
      const runtime = makeRuntime({
        exact: false,
        seed: {
          [CRON_HEARTBEAT_KEY]: previousHeartbeat,
          [DMI_RUN_MANIFEST_KEY]: warmManifest(location),
        },
      });
      installWarmProviderResponses();
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const originalPut = runtime.env.FRANK_FORECAST_CACHE.put;
      let signalHeartbeatWriteStarted = () => {};
      const heartbeatWriteStarted = new Promise<void>((resolve) => {
        signalHeartbeatWriteStarted = resolve;
      });
      let releaseHeartbeatWrite = () => {};
      const heartbeatWriteGate = new Promise<void>((resolve) => {
        releaseHeartbeatWrite = resolve;
      });
      let heartbeatWriteCompleted = false;
      runtime.env.FRANK_FORECAST_CACHE.put = async (key: string, value: string) => {
        if (key === CRON_HEARTBEAT_KEY) {
          signalHeartbeatWriteStarted();
          await heartbeatWriteGate;
        }
        await originalPut(key, value);
        if (key === CRON_HEARTBEAT_KEY) heartbeatWriteCompleted = true;
      };

      let responseSettled = false;
      const responsePromise = worker.fetch(
        authorizedWarmRequest('/api/v1/forecast/aarhus?warm=1'),
        runtime.env,
        runtime.ctx,
      ).then((response) => {
        responseSettled = true;
        return response;
      });

      try {
        await heartbeatWriteStarted;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));

        expect(responseSettled).toBe(true);
        expect(heartbeatWriteCompleted).toBe(false);
        expect(runtime.waits).toHaveLength(2);

        let waitUntilSettled = false;
        const waitUntilWork = Promise.all(runtime.waits).then(() => {
          waitUntilSettled = true;
        });
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        expect(waitUntilSettled).toBe(false);

        releaseHeartbeatWrite();
        const response = await responsePromise;
        await waitUntilWork;

        expect(response.status).toBe(200);
        expect(heartbeatWriteCompleted).toBe(true);
        const heartbeat = JSON.parse(runtime.store.get(CRON_HEARTBEAT_KEY)!);
        expect(heartbeat.locations[location.id]).toBe(
          new Date(WARM_BUILD_NOW).toISOString(),
        );
        expect(heartbeat.lastTickAt).toBe(previousHeartbeat.lastTickAt);
      } finally {
        releaseHeartbeatWrite();
        await Promise.allSettled([responsePromise, ...runtime.waits]);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not turn a malformed cold DMI run into an initialization cooldown', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(WARM_BUILD_NOW);
      const location = locationById('aarhus');
      const runtime = makeRuntime({
        exact: false,
        seed: { [DMI_RUN_MANIFEST_KEY]: warmManifest(location) },
      });
      const providerFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(
        async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.includes('api.met.no/')) return warmMetResponse();
          if (url.includes('feeds.meteoalarm.org/')) {
            return new Response('<feed></feed>', { status: 200 });
          }
          if (url.includes('/instances/')) {
            const water = url.includes('/collections/dkss_');
            const series = completeMarineSeries(
              water ? 'water' : 'waves',
              WARM_CURRENT_RUN,
              water ? 'dkss_idw' : 'wam_nsb',
            );
            return Response.json({
              features: series.map((point, index) => ({
                properties: water
                  ? {
                      step: point.time,
                      ...(index === 10 ? {} : { 'sea-mean-deviation': point.tideLevel }),
                      'water-temperature': point.tempWater,
                      'current-u': 0,
                      'current-v': 0,
                    }
                  : {
                      step: point.time,
                      'significant-wave-height': point.waveHeight,
                      'mean-wave-dir': point.waveDirection,
                      'mean-wave-period': point.wavePeriod,
                    },
              })),
            });
          }
          throw new Error(`Unexpected provider URL: ${url}`);
        },
      );
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const first = await worker.fetch(
        authorizedWarmRequest('/api/v1/forecast/aarhus?warm=1'),
        runtime.env,
        runtime.ctx,
      );
      const firstCalls = providerFetch.mock.calls.length;

      expect(first.status).toBe(503);
      expect(await first.json()).not.toMatchObject({ code: 'FORECAST_INITIALIZING' });
      expect(runtime.puts.map(({ key }) => key)).not.toContain(initializationStateKey(location));

      const repeated = await worker.fetch(
        authorizedWarmRequest('/api/v1/forecast/aarhus?warm=1'),
        runtime.env,
        runtime.ctx,
      );
      expect(repeated.status).toBe(503);
      expect(providerFetch.mock.calls.length).toBeGreaterThan(firstCalls);
      expect(runtime.puts.map(({ key }) => key)).not.toContain(initializationStateKey(location));
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps candidate 429 state inside the target generation and honors its cooldown', async () => {
    const location = locationById('aarhus');
    const previousHeartbeat = warmHeartbeat(location.id, Date.now());
    const runtime = makeRuntime({
      exact: false,
      seed: { [CRON_HEARTBEAT_KEY]: previousHeartbeat },
    });
    const providerFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response('Server is busy: private detail', { status: 429 }),
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const first = await worker.fetch(
      authorizedWarmRequest('/api/v1/forecast/aarhus?warm=1'),
      runtime.env,
      runtime.ctx,
    );
    expect(first.status).toBe(503);
    expect(first.headers.get('Retry-After')).toBe('90');
    expect(await first.json()).toMatchObject({
      code: 'FORECAST_INITIALIZING',
      retryAfterSeconds: 90,
    });
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
      retryAfterSeconds: 600,
      provider: 'marine',
      busy: true,
    });
    expect(JSON.parse(runtime.store.get(CRON_HEARTBEAT_KEY)!)).toEqual(previousHeartbeat);
    expect(runtime.puts.filter(({ key }) => key === CRON_HEARTBEAT_KEY)).toHaveLength(0);

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
    expect(statusBody).toMatch(/board-note[^>]*><td colspan="7">initializing/);
    expect(statusBody).not.toContain('INITIALIZING');
    expect(statusBody).toContain('initialization attempt ·');
    expect(statusBody).toContain('provider busy · marine');
    expect(statusBody).not.toContain('private detail');

    const callsAfterFirst = providerFetch.mock.calls.length;
    const repeated = await worker.fetch(
      authorizedWarmRequest('/api/v1/forecast/aarhus?warm=1'),
      runtime.env,
      runtime.ctx,
    );
    expect(repeated.status).toBe(503);
    expect(repeated.headers.get('Retry-After')).toBe('90');
    expect(await repeated.json()).toMatchObject({ retryAfterSeconds: 90 });
    expect(providerFetch).toHaveBeenCalledTimes(callsAfterFirst);

    const publicResponse = await worker.fetch(
      request('/api/v1/forecast/aarhus'),
      runtime.env,
      runtime.ctx,
    );
    expect(publicResponse.status).toBe(503);
    expect(publicResponse.headers.get('Retry-After')).toBe('600');
    expect(await publicResponse.json()).toMatchObject({ retryAfterSeconds: 600 });
    expect(providerFetch).toHaveBeenCalledTimes(callsAfterFirst);
  });

  it('records MET contact when a candidate build falls back to degraded marine data', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(WARM_BUILD_NOW);
      const location = locationById('vejle');
      const previousHeartbeat = warmHeartbeat(location.id);
      const runtime = makeRuntime({
        exact: false,
        seed: {
          [CRON_HEARTBEAT_KEY]: previousHeartbeat,
          [marineIngredientKey(location, 'water')]: retainedMarineIngredient(location, 'water'),
          [marineIngredientKey(location, 'waves')]: retainedMarineIngredient(location, 'waves'),
        },
      });
      const { calls } = installWarmProviderResponses(true);
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const response = await worker.fetch(
        authorizedWarmRequest('/api/v1/forecast/vejle?warm=1'),
        runtime.env,
        runtime.ctx,
      );
      const body = await response.json<ForecastData>();
      await Promise.all(runtime.waits);

      expect(response.status).toBe(200);
      expect(calls.filter((url) => url.endsWith('/instances'))).toHaveLength(2);
      expect(calls.filter((url) => url.includes('/instances/'))).toHaveLength(0);
      expect(calls.filter((url) => url.includes('api.met.no/'))).toHaveLength(1);
      expect(body.sources.cacheHealth).toMatchObject({
        status: 'current',
        degradedSources: ['water', 'waves'],
      });
      const attemptedAt = body.sources.cacheHealth?.lastAttemptAt;
      const heartbeat = JSON.parse(runtime.store.get(CRON_HEARTBEAT_KEY)!);
      expect(heartbeat.locations[location.id]).toBe(attemptedAt);
      expect(heartbeat.lastTickAt).toBe(previousHeartbeat.lastTickAt);
      expect(runtime.puts.filter(({ key }) => key === CRON_HEARTBEAT_KEY)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets the same isolate retry authenticated warming after 90 seconds', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2030-08-23T10:00:00.000Z'));
      const runtime = makeRuntime({ exact: false });
      const providerFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(
        async () => new Response('Server is busy', { status: 429 }),
      );
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const first = await worker.fetch(
        authorizedWarmRequest('/api/v1/forecast/kolding?warm=1'),
        runtime.env,
        runtime.ctx,
      );
      expect(first.status).toBe(503);
      expect(first.headers.get('Retry-After')).toBe('90');
      const callsAfterFirst = providerFetch.mock.calls.length;
      await Promise.all(runtime.waits);

      vi.setSystemTime(new Date('2030-08-23T10:01:31.000Z'));
      const second = await worker.fetch(
        authorizedWarmRequest('/api/v1/forecast/kolding?warm=1'),
        runtime.env,
        runtime.ctx,
      );
      expect(second.status).toBe(503);
      expect(second.headers.get('Retry-After')).toBe('90');
      expect(providerFetch.mock.calls.length).toBeGreaterThan(callsAfterFirst);
      await Promise.all(runtime.waits);
    } finally {
      vi.useRealTimers();
    }
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
      authorizedWarmRequest('/api/v1/forecast/kolding?warm=1'),
      runtime.env,
      runtime.ctx,
    );
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('90');
    expect(await response.json()).toMatchObject({
      code: 'FORECAST_INITIALIZING',
      retryAfterSeconds: 90,
    });
    expect(runtime.gets).toContain(initializationStateKey(location));
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
      authorizedWarmRequest('/api/v1/forecast/vejle?warm=1'),
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
      authorizedWarmRequest('/api/v1/forecast/vejle?warm=1'),
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
