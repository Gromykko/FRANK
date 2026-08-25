import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { CRON_HEARTBEAT_KEY } from '../../worker/index';
import locationData from '../../src/config/locations.json';
import type { ForecastLocation } from '../../src/config/locationTypes';
import { CURRENT_RELEASE } from '../../src/features/forecast/releaseContract';
import { FORECAST_PAYLOAD_VERSION } from '../../src/features/forecast/types';
import { buildSunSchedule } from '../../src/features/forecast/sun';
import type { ForecastData } from '../../worker/domain';
import { assembledForecastKey, marineIngredientKey } from '../../worker/generation';
import { completeMarineEnvelope } from './marineTestData';

const LOCATIONS = locationData as ForecastLocation[];
const NOW = Date.parse('2026-08-20T16:00:00.000Z');
const NEW_RUN = '2026-08-20T120000Z';
const OLD_RUN = '2026-08-20T060000Z';
const HOUR = '2026-08-20T17:00:00.000Z';

function cachedForecast(location: ForecastLocation, marineRun: string): ForecastData {
  const checkedAt = new Date(NOW - 30 * 60_000).toISOString();
  const sun = buildSunSchedule([HOUR], location);
  return {
    hourly: [{
      time: HOUR,
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
      isDay: sun.isDayByTime.get(HOUR) ?? false,
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
      fetchedAt: checkedAt,
      cacheHealth: {
        status: 'current',
        lastAttemptAt: checkedAt,
        weatherExpires: new Date(NOW + 60 * 60_000).toISOString(),
        marineInstances: {
          water: { collection: 'dkss_idw', id: marineRun },
          waves: { collection: 'wam_nsb', id: marineRun },
        },
      },
    },
  };
}

function runtime(
  currentLocationIds: ReadonlySet<string> = new Set(['horsens', 'aarhus']),
) {
  const store = new Map<string, string>();
  for (const location of LOCATIONS) {
    // Horsens and Aarhus already hold the current publication. Vejle and
    // Kolding retain an older run so tests can select either one's rotated tick.
    store.set(
      assembledForecastKey(location),
      JSON.stringify(cachedForecast(
        location,
        currentLocationIds.has(location.id) ? NEW_RUN : OLD_RUN,
      )),
    );
  }
  const puts: string[] = [];
  const env = {
    FRANK_FORECAST_CACHE: {
      async get(key: string, type?: string) {
        const raw = store.get(key);
        if (raw === undefined) return null;
        return type === 'json' ? JSON.parse(raw) : raw;
      },
      async put(key: string, value: string) {
        puts.push(key);
        store.set(key, value);
      },
    },
  };
  return { env, store, puts };
}

function metResponse(time = HOUR): Response {
  return Response.json({
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
  }, {
    headers: {
      Expires: new Date(NOW + 60 * 60_000).toUTCString(),
      'Last-Modified': new Date(NOW).toUTCString(),
    },
  });
}

function forecast(store: Map<string, string>, location: ForecastLocation): ForecastData {
  const raw = store.get(assembledForecastKey(location));
  if (!raw) throw new Error(`Missing test forecast for ${location.id}`);
  return JSON.parse(raw) as ForecastData;
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('scheduled DMI retries and location isolation', () => {
  it('opens the 429 circuit while recording the successful MET contact', async () => {
    const allCurrent = new Set(LOCATIONS.map(({ id }) => id));
    const { env, store } = runtime(allCurrent);
    const [horsens, vejle, kolding, aarhus] = LOCATIONS;
    const vejleCached = forecast(store, vejle);
    vejleCached.sources.cacheHealth!.weatherExpires = new Date(NOW - 1).toISOString();
    store.set(assembledForecastKey(vejle), JSON.stringify(vejleCached));
    const calls: string[] = [];
    let vejleAttempts = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('api.met.no/')) return metResponse();
      if (url.includes('feeds.meteoalarm.org/')) {
        return new Response('<feed></feed>', { status: 200 });
      }
      if (url.includes('/instances/')) {
        const coords = new URL(url).searchParams.get('coords');
        if (coords === 'POINT(9.68 55.705)') {
          vejleAttempts += 1;
          return new Response('Server is busy', {
            status: 429,
            headers: { 'Retry-After': '1200' },
          });
        }
        if (coords === 'POINT(9.659 55.512)') {
          const properties = url.includes('/collections/dkss_')
            ? {
                step: HOUR,
                'sea-mean-deviation': 0,
                'water-temperature': 16,
                'current-u': 0,
                'current-v': 0,
              }
            : {
                step: HOUR,
                'significant-wave-height': 0.1,
                'mean-wave-dir': 180,
                'mean-wave-period': 3,
              };
          return Response.json({ features: [{ properties }] });
        }
        return new Response('Server is busy', {
          status: 429,
          headers: { 'Retry-After': '1200' },
        });
      }
      if (url.endsWith('/instances')) {
        return Response.json({ instances: [{ id: NEW_RUN }] });
      }
      throw new Error(`Unexpected provider URL: ${url}`);
    }) as typeof fetch;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const vejleTick = NOW + 5 * 60_000;
    vi.setSystemTime(vejleTick);
    await worker.scheduled(
      { scheduledTime: vejleTick } as ScheduledController,
      env as Env,
      {} as ExecutionContext,
    );

    const positionCalls = calls.filter((url) => url.includes('/position?'));
    // This tick belongs only to Vejle. Water and waves were already in flight
    // together when the first refusal arrived; the event circuit stops retries.
    expect(vejleAttempts).toBe(2);
    expect(positionCalls).toHaveLength(2);
    expect(positionCalls.some((url) =>
      new URL(url).searchParams.get('coords') === 'POINT(9.659 55.512)')).toBe(false);
    expect(calls.filter((url) => url.endsWith('/instances'))).toHaveLength(0);
    expect(calls.filter((url) => url.includes('api.met.no/'))).toHaveLength(1);

    expect(forecast(store, horsens).sources.cacheHealth).toMatchObject({
      status: 'current',
    });
    expect(forecast(store, horsens).sources.cacheHealth).not.toHaveProperty('providerBusy');

    expect(forecast(store, vejle).sources.cacheHealth).toMatchObject({
      status: 'current',
      providerBusy: true,
      busyProvider: 'marine',
      degradedSources: ['water', 'waves'],
    });
    expect(JSON.parse(store.get(CRON_HEARTBEAT_KEY)!)).toEqual({
      schemaVersion: 2,
      lastTickAt: new Date(vejleTick).toISOString(),
      locations: { vejle: new Date(vejleTick).toISOString() },
      unreachable: {},
    });

    // Kolding's turn is the next one-minute tick, so this invocation must not
    // mutate its cached health in response to Vejle's provider failure.
    expect(forecast(store, kolding).sources.cacheHealth).toMatchObject({
      status: 'current',
    });
    expect(forecast(store, kolding).sources.cacheHealth).not.toHaveProperty('providerBusy');

    // Aarhus held run is schedule-valid and remains green
    expect(forecast(store, aarhus).sources.cacheHealth).toMatchObject({
      status: 'current',
    });
    expect(forecast(store, aarhus).sources.cacheHealth).not.toHaveProperty('providerBusy');
  });

  it('keeps successful contact evidence when later forecast assembly fails', async () => {
    const { env, store } = runtime(new Set(LOCATIONS.map(({ id }) => id)));
    const scheduledTime = NOW + 9 * 60_000;
    const location = LOCATIONS.find(({ id }) => id === 'vejle')!;
    const previousSuccess = scheduledTime - 8 * 60_000;
    const cached = forecast(store, location);
    cached.sources.cacheHealth!.weatherExpires = new Date(NOW - 1).toISOString();
    cached.sources.cacheHealth!.marineInstances = {
      water: { collection: 'dkss_idw', id: NEW_RUN },
      waves: { collection: 'wam_nsb', id: NEW_RUN },
    };
    store.set(assembledForecastKey(location), JSON.stringify(cached));
    store.set(
      marineIngredientKey(location, 'water'),
      JSON.stringify(completeMarineEnvelope(location, 'water', NEW_RUN, 'dkss_idw')),
    );
    store.set(
      marineIngredientKey(location, 'waves'),
      JSON.stringify(completeMarineEnvelope(location, 'waves', NEW_RUN, 'wam_nsb')),
    );
    store.set(CRON_HEARTBEAT_KEY, JSON.stringify({
      schemaVersion: 2,
      lastTickAt: new Date(scheduledTime - 60_000).toISOString(),
      locations: { [location.id]: new Date(previousSuccess).toISOString() },
      unreachable: { [location.id]: new Date(scheduledTime - 4 * 60_000).toISOString() },
    }));
    const nonOverlappingHour = '2026-08-20T04:00:00.000Z';
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('api.met.no/')) return metResponse(nonOverlappingHour);
      if (url.includes('feeds.meteoalarm.org/')) {
        return new Response('<feed></feed>', { status: 200 });
      }
      throw new Error(`Unexpected provider URL: ${url}`);
    }) as typeof fetch;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.setSystemTime(scheduledTime);

    await worker.scheduled(
      { scheduledTime } as ScheduledController,
      env as Env,
      {} as ExecutionContext,
    );

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('api.met.no/'),
      expect.anything(),
    );
    expect(forecast(store, location).sources.cacheHealth).toMatchObject({
      status: 'stale',
      message: 'Forecast refresh failed; keeping the last completed forecast.',
    });
    expect(errorLog.mock.calls.some(([message]) =>
      typeof message === 'string'
      && message.includes('No overlapping weather + marine hours'))).toBe(true);
    expect(JSON.parse(store.get(CRON_HEARTBEAT_KEY)!)).toEqual({
      schemaVersion: 2,
      lastTickAt: new Date(scheduledTime).toISOString(),
      locations: { [location.id]: new Date(scheduledTime).toISOString() },
      // Failure history remains available for observability; the newer
      // successful-contact stamp is what makes the current state reachable.
      unreachable: { [location.id]: new Date(scheduledTime - 4 * 60_000).toISOString() },
    });
  });

  it('clears a deferred marker after a successful same-run catalogue check', async () => {
    const allCurrent = new Set(LOCATIONS.map(({ id }) => id));
    const { env, store } = runtime(allCurrent);
    const kolding = LOCATIONS.find(({ id }) => id === 'kolding');
    if (!kolding) throw new Error('Missing Kolding test location');
    const deferred = forecast(store, kolding);
    deferred.sources.cacheHealth = {
      ...deferred.sources.cacheHealth,
      status: 'stale',
      checkedBy: 'cron-deferred',
      providerBusy: true,
      busyProvider: 'marine',
      degradedSources: ['water', 'waves'],
      message: 'Marine check deferred after the provider became busy earlier in this refresh cycle; keeping the last completed forecast.',
    };
    store.set(assembledForecastKey(kolding), JSON.stringify(deferred));

    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/instances')) {
        return Response.json({ instances: [{ id: NEW_RUN }] });
      }
      throw new Error(`Unexpected provider URL: ${url}`);
    }) as typeof fetch;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const nextKoldingFirstTick = NOW + 10 * 60_000;
    vi.setSystemTime(nextKoldingFirstTick);
    await worker.scheduled(
      { scheduledTime: nextKoldingFirstTick } as ScheduledController,
      env as Env,
      {} as ExecutionContext,
    );

    expect(calls.filter((url) => url.endsWith('/instances'))).toHaveLength(2);
    expect(calls.filter((url) => url.includes('/position?'))).toHaveLength(0);
    const recovered = forecast(store, kolding).sources.cacheHealth;
    expect(recovered).toMatchObject({ status: 'current', checkedBy: 'cron' });
    expect(recovered).not.toHaveProperty('providerBusy');
    expect(recovered).not.toHaveProperty('busyProvider');
    expect(recovered).not.toHaveProperty('degradedSources');
    expect(recovered).not.toHaveProperty('message');
  });

  it('keeps a recent recovery write throttled on the checked-cache call site', async () => {
    const allCurrent = new Set(LOCATIONS.map(({ id }) => id));
    const { env, store, puts } = runtime(allCurrent);
    const kolding = LOCATIONS.find(({ id }) => id === 'kolding');
    if (!kolding) throw new Error('Missing Kolding test location');

    const recoveryTick = NOW + 30 * 60_000;
    const deferred = forecast(store, kolding);
    deferred.sources.cacheHealth = {
      ...deferred.sources.cacheHealth,
      status: 'stale',
      lastAttemptAt: new Date(recoveryTick - 5 * 60_000).toISOString(),
      checkedBy: 'cron-deferred',
      providerBusy: true,
      busyProvider: 'marine',
      degradedSources: ['water', 'waves'],
      message: 'Marine service busy; keeping the last completed forecast.',
    };
    store.set(assembledForecastKey(kolding), JSON.stringify(deferred));

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/instances')) {
        return Response.json({ instances: [{ id: NEW_RUN }] });
      }
      throw new Error(`Unexpected provider URL: ${url}`);
    }) as typeof fetch;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.setSystemTime(recoveryTick);
    await worker.scheduled(
      { scheduledTime: recoveryTick } as ScheduledController,
      env as Env,
      {} as ExecutionContext,
    );

    expect(puts.filter((key) => key === assembledForecastKey(kolding))).toHaveLength(0);
    expect(forecast(store, kolding).sources.cacheHealth).toMatchObject({
      status: 'stale',
      checkedBy: 'cron-deferred',
    });
  });
});
