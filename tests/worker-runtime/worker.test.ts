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

function requireHorsensLocation(): ForecastLocation {
  const location = (locationData as ForecastLocation[]).find(({ id }) => id === 'horsens');
  if (!location) throw new Error('Canonical Horsens location is missing from the manifest');
  return location;
}

const HORSENS = requireHorsensLocation();
const FORECAST_KEY = `forecast:${HORSENS.id}:weather-data:v${FORECAST_PAYLOAD_VERSION}`;
const LEGACY_FORECAST_KEY = `forecast:${HORSENS.id}:weather-data:v1`;
type PublicHealthPayload = Omit<HealthPayload, 'ages' | 'storageUnavailable'>;

function currentHorsensForecast(nowMs = Date.now()): ForecastData {
  const checkedAt = new Date(nowMs).toISOString();
  const runId = checkedAt;
  return {
    hourly: [{
      time: new Date(nowMs + 60 * 60_000).toISOString(),
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
      weather: 'MET Norway Locationforecast',
      waves: 'DMI wam_nsb',
      water: 'DMI dkss_idw',
      coordinate: HORSENS.coordinate,
      location: {
        id: HORSENS.id,
        name: HORSENS.name,
        areaName: HORSENS.areaName,
      },
      fetchedAt: checkedAt,
      cacheHealth: {
        status: 'current',
        lastAttemptAt: checkedAt,
        weatherExpires: new Date(nowMs + 30 * 60_000).toISOString(),
        marineInstances: {
          water: { collection: 'dkss_idw', id: runId },
          waves: { collection: 'wam_nsb', id: runId },
        },
      },
    },
  };
}

async function dispatch(path: string, method = 'GET'): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://frank.test${path}`, { method }),
    env,
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

    const response = await dispatch('/forecast/horsens');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('access-control-expose-headers')).toContain('X-FRANK-Worker-Version');
    expectCurrentWorkerVersion(response);

    const body = await response.json<ForecastData>();
    expect(body.sources.location).toEqual({
      id: HORSENS.id,
      name: HORSENS.name,
      areaName: HORSENS.areaName,
    });
    expect(body.sources.payloadVersion).toBe(FORECAST_PAYLOAD_VERSION);
    expect(body.sources.cacheHealth?.status).toBe('current');
    expect(body.hourly).toHaveLength(1);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('serves deployment cache-readiness mode from real KV without provider work', async () => {
    const providerFetch = rejectLiveNetwork();
    const response = await dispatch('/forecast/horsens?warm=1');

    expect(response.status).toBe(200);
    const body = await response.json<ForecastData>();
    expect(body.sources.location?.id).toBe(HORSENS.id);
    expect(body.sources.payloadVersion).toBe(FORECAST_PAYLOAD_VERSION);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('writes the current assembled cache without altering the legacy v1 rollback cache', async () => {
    expect(FORECAST_PAYLOAD_VERSION).toBeGreaterThan(1);
    const providerFetch = rejectLiveNetwork();
    const nowMs = Date.now();
    const legacy = currentHorsensForecast(nowMs - 20 * 60_000);
    legacy.sources.payloadVersion = 1;
    legacy.sources.cacheHealth = {
      ...legacy.sources.cacheHealth!,
      message: 'legacy rollback sentinel',
    };
    const legacyRaw = JSON.stringify(legacy);
    await env.FRANK_FORECAST_CACHE.put(LEGACY_FORECAST_KEY, legacyRaw);

    const current = currentHorsensForecast(nowMs - 11 * 60_000);
    await env.FRANK_FORECAST_CACHE.put(FORECAST_KEY, JSON.stringify(current));

    const response = await dispatch('/forecast/horsens?refresh=1');
    expect(response.status).toBe(200);
    expect((await response.json<ForecastData>()).sources.cacheHealth?.status).toBe('pending');

    const storedCurrent = await env.FRANK_FORECAST_CACHE.get<ForecastData>(FORECAST_KEY, 'json');
    expect(Date.parse(storedCurrent?.sources.cacheHealth?.lastAttemptAt ?? ''))
      .toBeGreaterThan(Date.parse(current.sources.cacheHealth?.lastAttemptAt ?? ''));
    expect(await env.FRANK_FORECAST_CACHE.get(LEGACY_FORECAST_KEY)).toBe(legacyRaw);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('persists and honors a real-KV initialization cooldown after a typed 429', async () => {
    await env.FRANK_FORECAST_CACHE.delete(FORECAST_KEY);
    const providerFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response('Server is busy: private provider detail', { status: 429 }),
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const first = await dispatch('/forecast/horsens');
    expect(first.status).toBe(503);
    expect(first.headers.get('retry-after')).toBe('600');
    expectCurrentWorkerVersion(first);
    const body = await first.json<ForecastInitializingPayload>();
    expect(body).toMatchObject({
      schemaVersion: 1,
      status: 'initializing',
      code: 'FORECAST_INITIALIZING',
      retryAfterSeconds: 600,
      location: { id: HORSENS.id },
    });
    expect(JSON.stringify(body)).not.toContain('private provider detail');

    const marker = await env.FRANK_FORECAST_CACHE.get(
      'forecast-initialization:horsens:v1',
      'json',
    );
    expect(marker).toMatchObject({
      schemaVersion: 1,
      status: 'initializing',
      locationId: HORSENS.id,
      retryAfterSeconds: 600,
    });

    const callsAfterFirst = providerFetch.mock.calls.length;
    const repeatedWarm = await dispatch('/forecast/horsens?warm=1');
    expect(repeatedWarm.status).toBe(503);
    expect(providerFetch).toHaveBeenCalledTimes(callsAfterFirst);
  });

  it('preserves the read-only HTTP contract for HEAD, OPTIONS, and unknown paths', async () => {
    const providerFetch = rejectLiveNetwork();

    const head = await dispatch('/forecast/horsens', 'HEAD');
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect(head.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expectCurrentWorkerVersion(head);

    const options = await dispatch('/forecast/horsens', 'OPTIONS');
    expect(options.status).toBe(204);
    expect(options.headers.get('allow')).toBe('GET, HEAD, OPTIONS');
    expect(options.headers.get('access-control-allow-methods')).toBe('GET, HEAD, OPTIONS');
    expectCurrentWorkerVersion(options);

    const unknown = await dispatch('/does-not-exist');
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: 'Not found' });
    expect(unknown.headers.get('access-control-allow-origin')).toBe('*');
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
      cacheHealth: { status: 'current' },
    });
    expect(body.locations.some((location) => !location.hasCache)).toBe(true);
    expect(body.missing).toEqual(expect.arrayContaining(['vejle', 'kolding', 'aarhus']));
    expect(providerFetch).not.toHaveBeenCalled();
  });
});
