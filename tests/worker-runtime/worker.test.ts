import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import {
  createExecutionContext,
  reset,
  waitOnExecutionContext,
} from 'cloudflare:test';
import worker from '../../worker/index';
import type {
  ForecastData,
  ForecastInitializingPayload,
  HealthPayload,
} from '../../worker/domain';
import locationData from '../../src/config/locations.json';
import type { ForecastLocation } from '../../src/config/locationTypes';
import { FORECAST_PAYLOAD_VERSION } from '../../src/features/forecast/types';
import { CURRENT_RELEASE } from '../../src/features/forecast/releaseContract';
import { buildSunSchedule } from '../../src/features/forecast/sun';
import {
  assembledForecastKey,
  initializationStateKey,
} from '../../worker/generation';

const LOCATIONS = locationData as ForecastLocation[];

function requireLocation(id: string): ForecastLocation {
  const location = LOCATIONS.find((candidate) => candidate.id === id);
  if (!location) throw new Error(`Canonical ${id} location is missing from the manifest`);
  return location;
}

const HORSENS = requireLocation('horsens');
const HORSENS_WATER_COLLECTION = HORSENS.dmiCollections.water[0];
const HORSENS_WAVE_COLLECTION = HORSENS.dmiCollections.waves[0];
if (!HORSENS_WATER_COLLECTION || !HORSENS_WAVE_COLLECTION) {
  throw new Error('Canonical Horsens marine collections are missing from the manifest');
}
const MISSING_LOCATION_IDS = LOCATIONS
  .map(({ id }) => id)
  .filter((id) => id !== HORSENS.id);
const FORECAST_KEY = assembledForecastKey(HORSENS);
const WARM_TOKEN = 'test-only-frank-warm-token-with-256-bits-of-entropy';
type PublicHealthPayload = Omit<HealthPayload, 'ages' | 'storageUnavailable'>;

function currentHorsensForecast(nowMs = Date.now()): ForecastData {
  const checkedAt = new Date(nowMs).toISOString();
  const runId = checkedAt;
  const forecastTime = new Date(nowMs + 60 * 60_000).toISOString();
  const sun = buildSunSchedule([forecastTime], HORSENS);
  return {
    hourly: [{
      time: forecastTime,
      tempAir: 15,
      precipitation: 0,
      symbolCode: 'clearsky_day',
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
      waves: `DMI ${HORSENS_WAVE_COLLECTION}`,
      water: `DMI ${HORSENS_WATER_COLLECTION}`,
      coordinate: HORSENS.coordinate,
      location: {
        id: HORSENS.id,
        forecastConfigRevision: HORSENS.forecastConfigRevision,
        name: HORSENS.name,
        areaName: HORSENS.areaName,
      },
      fetchedAt: checkedAt,
      cacheHealth: {
        status: 'current',
        lastAttemptAt: checkedAt,
        weatherExpires: new Date(nowMs + 30 * 60_000).toISOString(),
        marineInstances: {
          water: { collection: HORSENS_WATER_COLLECTION, id: runId },
          waves: { collection: HORSENS_WAVE_COLLECTION, id: runId },
        },
      },
    },
  };
}

async function dispatch(path: string, method = 'GET', warmToken?: string): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://frank.test${path}`, {
      method,
      ...(warmToken ? { headers: { Authorization: `Bearer ${warmToken}` } } : {}),
    }),
    {
      CF_VERSION_METADATA: env.CF_VERSION_METADATA,
      FRANK_FORECAST_CACHE: env.FRANK_FORECAST_CACHE,
      FRANK_WARM_TOKEN: WARM_TOKEN,
    },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

function expectCurrentWorkerVersion(response: Response): void {
  const versionId = response.headers.get('x-frank-worker-version');
  expect(versionId).toBe(env.CF_VERSION_METADATA.id);
  expect(versionId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
}

function rejectLiveNetwork() {
  return vi.spyOn(globalThis, 'fetch').mockRejectedValue(
    new Error('Unexpected live provider request from Worker runtime test'),
  );
}

beforeEach(async () => {
  await reset();
  await env.FRANK_FORECAST_CACHE.put(
    FORECAST_KEY,
    JSON.stringify(currentHorsensForecast()),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Worker runtime integration contract', () => {
  it('round-trips real KV and serves a current forecast without background provider work', async () => {
    const providerFetch = rejectLiveNetwork();
    const stored = await env.FRANK_FORECAST_CACHE.get<ForecastData>(FORECAST_KEY, 'json');
    expect(stored?.sources.location?.id).toBe(HORSENS.id);
    expect(stored?.sources.payloadVersion).toBe(FORECAST_PAYLOAD_VERSION);

    const response = await dispatch('/api/v2/forecast/horsens');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('access-control-expose-headers')).toContain('X-FRANK-Worker-Version');
    expect(response.headers.get('x-frank-api-schema'))
      .toBe(String(CURRENT_RELEASE.apiSchemaVersion));
    expect(response.headers.get('x-frank-model-revision'))
      .toBe(String(CURRENT_RELEASE.modelRevision));
    expect(response.headers.get('x-frank-data-generation'))
      .toBe(CURRENT_RELEASE.dataGenerationId);
    expect(response.headers.get('x-frank-generation-ready')).toBe('true');
    expectCurrentWorkerVersion(response);

    const body = await response.json<ForecastData>();
    expect(body.sources.location).toEqual({
      id: HORSENS.id,
      forecastConfigRevision: HORSENS.forecastConfigRevision,
      name: HORSENS.name,
      areaName: HORSENS.areaName,
    });
    expect(body.sources.payloadVersion).toBe(FORECAST_PAYLOAD_VERSION);
    expect(body.sources.cacheHealth?.status).toBe('current');
    expect(body.hourly).toHaveLength(1);
    expect(body.hourly[0]).not.toHaveProperty('weatherCode');
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('serves deployment cache-readiness mode from real KV without provider work', async () => {
    const providerFetch = rejectLiveNetwork();
    const response = await dispatch('/api/v2/forecast/horsens?warm=1', 'GET', WARM_TOKEN);

    expect(response.status).toBe(200);
    const body = await response.json<ForecastData>();
    expect(body.sources.location?.id).toBe(HORSENS.id);
    expect(body.sources.payloadVersion).toBe(FORECAST_PAYLOAD_VERSION);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('hides unauthenticated deployment warming without provider work', async () => {
    const providerFetch = rejectLiveNetwork();
    const response = await dispatch('/api/v2/forecast/horsens?warm=1');

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('ignores unmanaged historical keys in real KV', async () => {
    const providerFetch = rejectLiveNetwork();
    await env.FRANK_FORECAST_CACHE.delete(FORECAST_KEY);
    const historicalKey = 'forecast:horsens:weather-data:v7';
    const raw = JSON.stringify(currentHorsensForecast());
    await env.FRANK_FORECAST_CACHE.put(historicalKey, raw);

    const response = await dispatch('/api/v2/forecast/horsens');

    expect(response.status).toBe(503);
    expect(response.headers.get('X-FRANK-Generation-Ready')).toBe('false');
    expect((await response.json<ForecastInitializingPayload>()).code)
      .toBe('FORECAST_INITIALIZING');
    expect(await env.FRANK_FORECAST_CACHE.get(FORECAST_KEY)).toBeNull();
    expect(await env.FRANK_FORECAST_CACHE.get(historicalKey)).toBe(raw);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('persists real-KV state and honors the same-isolate cooldown after a typed 429', async () => {
    await env.FRANK_FORECAST_CACHE.delete(FORECAST_KEY);
    const providerFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response('Server is busy: private provider detail', { status: 429 }),
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const first = await dispatch('/api/v2/forecast/horsens?warm=1', 'GET', WARM_TOKEN);
    expect(first.status).toBe(503);
    expect(first.headers.get('retry-after')).toBe('90');
    expectCurrentWorkerVersion(first);
    const body = await first.json<ForecastInitializingPayload>();
    expect(body).toMatchObject({
      schemaVersion: 1,
      status: 'initializing',
      code: 'FORECAST_INITIALIZING',
      retryAfterSeconds: 90,
      location: { id: HORSENS.id },
    });
    expect(JSON.stringify(body)).not.toContain('private provider detail');

    const marker = await env.FRANK_FORECAST_CACHE.get(
      initializationStateKey(HORSENS),
      'json',
    );
    expect(marker).toMatchObject({
      schemaVersion: 2,
      status: 'initializing',
      locationId: HORSENS.id,
      forecastConfigRevision: HORSENS.forecastConfigRevision,
      retryAfterSeconds: 600,
      provider: 'marine',
      busy: true,
    });

    const callsAfterFirst = providerFetch.mock.calls.length;
    const repeatedWarm = await dispatch('/api/v2/forecast/horsens?warm=1', 'GET', WARM_TOKEN);
    expect(repeatedWarm.status).toBe(503);
    expect(repeatedWarm.headers.get('retry-after')).toBe('90');
    expect((await repeatedWarm.json<ForecastInitializingPayload>()).retryAfterSeconds).toBe(90);
    expect(providerFetch).toHaveBeenCalledTimes(callsAfterFirst);

    const publicResponse = await dispatch('/api/v2/forecast/horsens');
    expect(publicResponse.status).toBe(503);
    expect(publicResponse.headers.get('retry-after')).toBe('600');
    expect((await publicResponse.json<ForecastInitializingPayload>()).retryAfterSeconds).toBe(600);
    expect(providerFetch).toHaveBeenCalledTimes(callsAfterFirst);
  });

  it('preserves the read-only HTTP contract for HEAD, OPTIONS, and unknown paths', async () => {
    const providerFetch = rejectLiveNetwork();

    const head = await dispatch('/api/v2/forecast/horsens', 'HEAD');
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect(head.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expectCurrentWorkerVersion(head);

    const options = await dispatch('/api/v2/forecast/horsens', 'OPTIONS');
    expect(options.status).toBe(204);
    expect(options.headers.get('allow')).toBe('GET, HEAD, OPTIONS');
    expect(options.headers.get('access-control-allow-methods')).toBe('GET, HEAD, OPTIONS');
    expectCurrentWorkerVersion(options);

    const unknown = await dispatch('/does-not-exist');
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: 'Not found' });
    expect(unknown.headers.get('access-control-allow-origin')).toBe('*');

    const retiredAlias = await dispatch('/forecast/horsens');
    expect(retiredAlias.status).toBe(404);
    expect(await retiredAlias.json()).toEqual({ error: 'Not found' });
    expectCurrentWorkerVersion(unknown);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('reports partial cache health from the actual binding without contacting providers', async () => {
    const providerFetch = rejectLiveNetwork();
    const response = await dispatch('/health');
    expect(response.status).toBe(503);

    const body = await response.json<PublicHealthPayload>();
    expect(body).toMatchObject({
      ok: false,
      service: 'frank-forecast',
      storageAvailable: true,
    });
    expect(body).not.toHaveProperty('ages');
    expect(body).not.toHaveProperty('storageUnavailable');
    expect(body.locations.find((location) => location.id === HORSENS.id)).toMatchObject({
      hasCache: true,
      exactGenerationReady: true,
      availabilitySource: 'generation',
      cacheHealth: { status: 'current' },
    });
    expect(body.locations.some((location) => !location.hasCache)).toBe(true);
    expect(body.missing).toEqual(MISSING_LOCATION_IDS);
    expect(body.release).toMatchObject({
      target: CURRENT_RELEASE,
      allLocationsReady: false,
      ready: [HORSENS.id],
      available: [HORSENS.id],
      fallback: [],
      missing: MISSING_LOCATION_IDS,
    });
    expect(providerFetch).not.toHaveBeenCalled();
  });
});
