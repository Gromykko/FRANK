import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { CRON_HEARTBEAT_KEY, tickOrder } from '../../worker/index';
import locationData from '../../src/config/locations.json';
import type { ForecastLocation } from '../../src/config/locationTypes';
import { CURRENT_RELEASE } from '../../src/features/forecast/releaseContract';
import { FORECAST_PAYLOAD_VERSION } from '../../src/features/forecast/types';
import { buildSunSchedule } from '../../src/features/forecast/sun';
import type { ForecastData } from '../../worker/domain';
import { assembledForecastKey, marineIngredientKey } from '../../worker/generation';
import { CRON_PERIOD_MS } from '../../worker/execution';
import { makeCacheHealth } from './fixtures';
import { completeMarineEnvelope } from './marineTestData';

const LOCATIONS = locationData as ForecastLocation[];
const NOW = Date.parse('2026-08-20T16:00:00.000Z');
const NEW_RUN = '2026-08-20T120000Z';
const OLD_RUN = '2026-08-20T060000Z';
const HOUR = '2026-08-20T17:00:00.000Z';
const LOCATION_IDS = LOCATIONS.map(({ id }) => id);

function requireLocation(id: string): ForecastLocation {
  const location = LOCATIONS.find((candidate) => candidate.id === id);
  if (!location) throw new Error(`Missing ${id} test location`);
  return location;
}

function primaryCollection(location: ForecastLocation, kind: 'water' | 'waves'): string {
  const collection = location.dmiCollections[kind][0];
  if (!collection) throw new Error(`Missing ${kind} collection for ${location.id}`);
  return collection;
}

function selectedTickAtOrAfter(location: ForecastLocation, earliestMs: number): number {
  for (let offset = 0; offset < LOCATIONS.length; offset += 1) {
    const candidate = earliestMs + offset * CRON_PERIOD_MS;
    if (tickOrder(candidate, LOCATION_IDS)[0] === location.id) return candidate;
  }
  throw new Error(`No rotated tick selected ${location.id}`);
}

function cachedForecast(location: ForecastLocation, marineRun: string): ForecastData {
  const checkedAt = new Date(NOW - 30 * 60_000).toISOString();
  const sun = buildSunSchedule([HOUR], location);
  const waterCollection = primaryCollection(location, 'water');
  const waveCollection = primaryCollection(location, 'waves');
  return {
    hourly: [{
      time: HOUR,
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
      waves: `DMI ${waveCollection}`,
      water: `DMI ${waterCollection}`,
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
          water: { collection: waterCollection, id: marineRun },
          waves: { collection: waveCollection, id: marineRun },
        },
      },
    },
  };
}

function runtime(currentLocationIds: ReadonlySet<string>) {
  const store = new Map<string, string>();
  for (const location of LOCATIONS) {
    // Callers choose which locations hold the current publication so each test
    // can select a production location without depending on manifest size.
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
    const vejle = requireLocation('vejle');
    const untouchedLocations = LOCATIONS.filter(({ id }) => id !== vejle.id);
    const vejleCached = forecast(store, vejle);
    vejleCached.sources.cacheHealth!.weatherExpires = new Date(NOW - 1).toISOString();
    store.set(assembledForecastKey(vejle), JSON.stringify(vejleCached));
    const calls: string[] = [];
    let vejleAttempts = 0;
    const vejlePoint = `POINT(${vejle.coordinate.longitude} ${vejle.coordinate.latitude})`;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('api.met.no/')) return metResponse();
      if (url.includes('feeds.meteoalarm.org/')) {
        return new Response('<feed></feed>', { status: 200 });
      }
      if (url.includes('/instances/')) {
        const coords = new URL(url).searchParams.get('coords');
        if (coords === vejlePoint) {
          vejleAttempts += 1;
          return new Response('Server is busy', {
            status: 429,
            headers: { 'Retry-After': '1200' },
          });
        }
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
      if (url.endsWith('/instances')) {
        return Response.json({ instances: [{ id: NEW_RUN }] });
      }
      throw new Error(`Unexpected provider URL: ${url}`);
    }) as typeof fetch;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const vejleTick = selectedTickAtOrAfter(vejle, NOW + 5 * 60_000);
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
    expect(positionCalls.every((url) =>
      new URL(url).searchParams.get('coords') === vejlePoint)).toBe(true);
    expect(calls.filter((url) => url.endsWith('/instances'))).toHaveLength(0);
    expect(calls.filter((url) => url.includes('api.met.no/'))).toHaveLength(1);

    expect(forecast(store, vejle).sources.cacheHealth).toMatchObject({
      status: 'current',
      providerBusy: true,
      busyProvider: 'marine',
      degradedSources: ['water', 'waves'],
    });
    expect(JSON.parse(store.get(CRON_HEARTBEAT_KEY)!)).toEqual({
      schemaVersion: 2,
      lastTickAt: new Date(vejleTick).toISOString(),
      locations: { [vejle.id]: new Date(vejleTick).toISOString() },
      unreachable: {},
    });

    // A selected city's failure must not mutate any other production location.
    for (const untouched of untouchedLocations) {
      expect(forecast(store, untouched).sources.cacheHealth).toMatchObject({
        status: 'current',
      });
      expect(forecast(store, untouched).sources.cacheHealth)
        .not.toHaveProperty('providerBusy');
    }
  });

  it('keeps successful contact evidence when later forecast assembly fails', async () => {
    const { env, store } = runtime(new Set(LOCATIONS.map(({ id }) => id)));
    const location = requireLocation('vejle');
    const scheduledTime = selectedTickAtOrAfter(location, NOW + 9 * 60_000);
    const previousSuccess = scheduledTime - 8 * 60_000;
    const cached = forecast(store, location);
    cached.sources.cacheHealth!.weatherExpires = new Date(NOW - 1).toISOString();
    cached.sources.cacheHealth!.marineInstances = {
      water: { collection: primaryCollection(location, 'water'), id: NEW_RUN },
      waves: { collection: primaryCollection(location, 'waves'), id: NEW_RUN },
    };
    store.set(assembledForecastKey(location), JSON.stringify(cached));
    store.set(
      marineIngredientKey(location, 'water'),
      JSON.stringify(completeMarineEnvelope(
        location,
        'water',
        NEW_RUN,
        primaryCollection(location, 'water'),
      )),
    );
    store.set(
      marineIngredientKey(location, 'waves'),
      JSON.stringify(completeMarineEnvelope(
        location,
        'waves',
        NEW_RUN,
        primaryCollection(location, 'waves'),
      )),
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
    const kolding = requireLocation('kolding');
    const deferred = forecast(store, kolding);
    deferred.sources.cacheHealth = makeCacheHealth({
      ...deferred.sources.cacheHealth,
      status: 'stale',
      checkedBy: 'cron-deferred',
      providerBusy: true,
      busyProvider: 'marine',
      degradedSources: ['water', 'waves'],
      message: 'Marine check deferred after the provider became busy earlier in this refresh cycle; keeping the last completed forecast.',
    });
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

    const nextKoldingFirstTick = selectedTickAtOrAfter(kolding, NOW + 10 * 60_000);
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
    const kolding = requireLocation('kolding');

    const recoveryTick = selectedTickAtOrAfter(kolding, NOW + 30 * 60_000);
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

  it('clears a warm fallback label on the first publication-window check', async () => {
    const allCurrent = new Set(LOCATIONS.map(({ id }) => id));
    const { env, store, puts } = runtime(allCurrent);
    const kolding = requireLocation('kolding');

    const recoveryTick = selectedTickAtOrAfter(kolding, NOW + 34 * 60_000);
    const previousAttemptAt = new Date(recoveryTick - 5 * 60_000).toISOString();
    const warmFallback = forecast(store, kolding);
    const fetchedAt = warmFallback.sources.fetchedAt;
    const hourly = warmFallback.hourly;
    warmFallback.sources.cacheHealth = {
      ...warmFallback.sources.cacheHealth,
      status: 'current',
      lastAttemptAt: previousAttemptAt,
      checkedBy: 'deployment-warm',
      degradedSources: ['water', 'waves'],
      message: 'Provider partly unavailable; using last good data for: water, waves.',
    };
    store.set(assembledForecastKey(kolding), JSON.stringify(warmFallback));

    const provider = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('A publication-window recovery must not call a provider.'),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.setSystemTime(recoveryTick);
    await worker.scheduled(
      { scheduledTime: recoveryTick } as ScheduledController,
      env as Env,
      {} as ExecutionContext,
    );

    expect(provider).not.toHaveBeenCalled();
    expect(puts.filter((key) => key === assembledForecastKey(kolding))).toHaveLength(1);
    const recovered = forecast(store, kolding);
    expect(recovered.sources.fetchedAt).toBe(fetchedAt);
    expect(recovered.hourly).toEqual(hourly);
    expect(recovered.sources.cacheHealth).toMatchObject({
      status: 'current',
      checkedBy: 'cron',
      lastAttemptAt: previousAttemptAt,
    });
    expect(recovered.sources.cacheHealth).not.toHaveProperty('degradedSources');
    expect(recovered.sources.cacheHealth).not.toHaveProperty('providerBusy');
    expect(recovered.sources.cacheHealth).not.toHaveProperty('busyProvider');
    expect(recovered.sources.cacheHealth).not.toHaveProperty('message');
    const completionEvents = log.mock.calls.flatMap(([message]) => {
      if (typeof message !== 'string' || !message.startsWith('{')) return [];
      try {
        const value: unknown = JSON.parse(message);
        return typeof value === 'object'
          && value !== null
          && Reflect.get(value, 'event') === 'cron_tick_completed'
          ? [value]
          : [];
      } catch {
        return [];
      }
    });
    expect(completionEvents).toEqual([
      expect.objectContaining({
        locationId: kolding.id,
        probeDecisionReason: 'publication-window',
        canSkipProbe: true,
        outcome: 'healthy-no-probe',
        subrequestCount: 0,
      }),
    ]);
  });
});
