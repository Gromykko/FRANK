import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import locationData from '../../src/config/locations.json';
import type { ForecastLocation } from '../../src/config/locationTypes';
import { CURRENT_RELEASE } from '../../src/features/forecast/releaseContract';
import { buildSunSchedule } from '../../src/features/forecast/sun';
import { FORECAST_PAYLOAD_VERSION } from '../../src/features/forecast/types';
import type { ForecastData } from '../../worker/domain';
import { CRON_PERIOD_MS } from '../../worker/execution';
import { assembledForecastKey } from '../../worker/generation';
import worker, {
  CRON_HEARTBEAT_KEY,
  CRON_HEARTBEAT_THROTTLE_TICKS,
  tickOrder,
} from '../../worker/index';
import {
  DMI_RUN_MANIFEST_KEY,
  DMI_RUN_MANIFEST_SCHEMA_VERSION,
  dmiCollectionListKey,
} from '../../worker/providers';

const LOCATIONS = locationData as ForecastLocation[];
const FIRST_TICK_MS = Date.parse('2026-08-20T16:00:00.000Z');
const MARINE_RUN = '2026-08-20T160000Z';
const DUE_MARINE_RUN = '2026-08-20T060000Z';

interface KvWriteEvent {
  event: 'kv_write';
  category: string;
}

function isKvWriteEvent(value: unknown): value is KvWriteEvent {
  return typeof value === 'object'
    && value !== null
    && Reflect.get(value, 'event') === 'kv_write'
    && typeof Reflect.get(value, 'category') === 'string';
}

function kvWriteEvents(calls: readonly (readonly unknown[])[]): KvWriteEvent[] {
  return calls.flatMap(([message]) => {
    if (typeof message !== 'string' || !message.startsWith('{')) return [];
    try {
      const value: unknown = JSON.parse(message);
      return isKvWriteEvent(value) ? [value] : [];
    } catch {
      return [];
    }
  });
}

function cachedForecast(location: ForecastLocation, marineRun: string): ForecastData {
  const fetchedAt = new Date(FIRST_TICK_MS - 30 * 60_000).toISOString();
  const hour = new Date(FIRST_TICK_MS + 60 * 60_000).toISOString();
  const sun = buildSunSchedule([hour], location);
  return {
    hourly: [{
      time: hour,
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
      isDay: sun.isDayByTime.get(hour) ?? false,
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
      fetchedAt,
      cacheHealth: {
        status: 'current',
        lastAttemptAt: fetchedAt,
        checkedBy: 'cron',
        // Exactly the production maximum: fetchedAt + 90 minutes.
        weatherExpires: new Date(FIRST_TICK_MS + 60 * 60_000).toISOString(),
        marineInstances: {
          water: { collection: 'dkss_idw', id: marineRun },
          waves: { collection: 'wam_nsb', id: marineRun },
        },
      },
    },
  };
}

function runtime(marineRun = MARINE_RUN) {
  const store = new Map<string, string>();
  for (const location of LOCATIONS) {
    store.set(assembledForecastKey(location), JSON.stringify(cachedForecast(location, marineRun)));
  }
  const gets: string[] = [];
  const puts: string[] = [];
  const env = {
    FRANK_FORECAST_CACHE: {
      async get(key: string, type?: string) {
        gets.push(key);
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
  return { env, store, gets, puts };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(FIRST_TICK_MS);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('scheduled city rotation', () => {
  it('refreshes exactly one city per tick and covers all cities in four ticks', async () => {
    const { env, gets } = runtime();
    const provider = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('A source fetch is not due in this fixture.'),
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const expectedCycle = Array.from({ length: LOCATIONS.length }, (_, index) => {
      const scheduledTime = FIRST_TICK_MS + index * CRON_PERIOD_MS;
      return tickOrder(scheduledTime)[0];
    });
    expect(new Set(expectedCycle.map(({ id }) => id)).size).toBe(LOCATIONS.length);

    const forecastKeys = new Set(LOCATIONS.map(assembledForecastKey));
    for (const [index, expectedLocation] of expectedCycle.entries()) {
      const scheduledTime = FIRST_TICK_MS + index * CRON_PERIOD_MS;
      vi.setSystemTime(scheduledTime);
      const readsBeforeTick = gets.length;

      await worker.scheduled(
        { scheduledTime } as ScheduledController,
        env as Env,
        {} as ExecutionContext,
      );

      const locationReads = [...new Set(
        gets.slice(readsBeforeTick).filter((key) => forecastKeys.has(key)),
      )];
      expect(locationReads).toEqual([assembledForecastKey(expectedLocation)]);
    }

    expect(provider).not.toHaveBeenCalled();
  });

  it('does not read the run manifest or probe the catalogue when no marine run is due', async () => {
    const { env, gets } = runtime();
    const scheduledTime = FIRST_TICK_MS + 2 * LOCATIONS.length * CRON_PERIOD_MS;
    const location = tickOrder(scheduledTime)[0];
    const provider = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('The outer marine probe gate should prevent this request.'),
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.setSystemTime(scheduledTime);

    await worker.scheduled(
      { scheduledTime } as ScheduledController,
      env as Env,
      {} as ExecutionContext,
    );

    expect(gets).toContain(assembledForecastKey(location));
    expect(gets).not.toContain(DMI_RUN_MANIFEST_KEY);
    expect(provider).not.toHaveBeenCalled();
  });

  it('does not report an equal manifest-only run as a fresh city contact', async () => {
    const { env, store, gets, puts } = runtime(DUE_MARINE_RUN);
    const scheduledTime = FIRST_TICK_MS + 3 * LOCATIONS.length * CRON_PERIOD_MS;
    const location = tickOrder(scheduledTime)[0];
    const forecastKey = assembledForecastKey(location);
    const cachedBefore = store.get(forecastKey)!;
    const previousSuccess = scheduledTime - 8 * CRON_PERIOD_MS;
    const previousFailure = scheduledTime - 4 * CRON_PERIOD_MS;
    store.set(CRON_HEARTBEAT_KEY, JSON.stringify({
      schemaVersion: 2,
      lastTickAt: new Date(
        scheduledTime - CRON_HEARTBEAT_THROTTLE_TICKS * CRON_PERIOD_MS,
      ).toISOString(),
      locations: { [location.id]: new Date(previousSuccess).toISOString() },
      unreachable: { [location.id]: new Date(previousFailure).toISOString() },
    }));
    const discoveredAt = new Date(scheduledTime).toISOString();
    store.set(DMI_RUN_MANIFEST_KEY, JSON.stringify({
      schemaVersion: DMI_RUN_MANIFEST_SCHEMA_VERSION,
      entries: {
        [dmiCollectionListKey(location.dmiCollections.water)]: {
          collection: location.dmiCollections.water[0],
          id: DUE_MARINE_RUN,
          discoveredAt,
        },
        [dmiCollectionListKey(location.dmiCollections.waves)]: {
          collection: location.dmiCollections.waves[0],
          id: DUE_MARINE_RUN,
          discoveredAt,
        },
      },
    }));
    const provider = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('A manifest-only verification must not reach the catalogue.'),
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.setSystemTime(scheduledTime);

    await worker.scheduled(
      { scheduledTime } as ScheduledController,
      env as Env,
      {} as ExecutionContext,
    );

    expect(gets.filter((key) => key === DMI_RUN_MANIFEST_KEY)).toHaveLength(1);
    expect(provider).not.toHaveBeenCalled();
    expect(store.get(forecastKey)).toBe(cachedBefore);
    expect(puts).not.toContain(forecastKey);
    expect(JSON.parse(store.get(CRON_HEARTBEAT_KEY)!)).toEqual({
      schemaVersion: 2,
      lastTickAt: new Date(scheduledTime).toISOString(),
      locations: { [location.id]: new Date(previousSuccess).toISOString() },
      unreachable: { [location.id]: new Date(previousFailure).toISOString() },
    });
  });

  it('falls back from corrupt manifest JSON through a clean scheduled verdict check', async () => {
    const { env, store, gets, puts } = runtime(DUE_MARINE_RUN);
    const scheduledTime = FIRST_TICK_MS + 4 * LOCATIONS.length * CRON_PERIOD_MS;
    const location = tickOrder(scheduledTime)[0];
    const forecastKey = assembledForecastKey(location);
    const before = JSON.parse(store.get(forecastKey)!) as ForecastData;
    store.set(DMI_RUN_MANIFEST_KEY, '{');
    const provider = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/instances')) {
        return Response.json({ instances: [{ id: DUE_MARINE_RUN }] });
      }
      throw new Error(`Unexpected provider URL: ${url}`);
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.setSystemTime(scheduledTime);

    await worker.scheduled(
      { scheduledTime } as ScheduledController,
      env as Env,
      {} as ExecutionContext,
    );

    expect(gets.filter((key) => key === DMI_RUN_MANIFEST_KEY)).toHaveLength(1);
    expect(provider).toHaveBeenCalledTimes(2);
    expect(puts).not.toContain(DMI_RUN_MANIFEST_KEY);
    const after = JSON.parse(store.get(forecastKey)!) as ForecastData;
    expect(after.hourly).toEqual(before.hourly);
    expect(after.sources.cacheHealth?.status).toBe('current');
    expect(JSON.parse(store.get(CRON_HEARTBEAT_KEY)!)).toEqual({
      schemaVersion: 2,
      lastTickAt: new Date(scheduledTime).toISOString(),
      locations: { [location.id]: new Date(scheduledTime).toISOString() },
      unreachable: {},
    });
  });

  it('skips heartbeat writes inside five minutes and writes once the interval elapses', async () => {
    const { env, store, puts } = runtime();
    const provider = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('A source fetch is not due in this fixture.'),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const startTick = 10;
    const runTick = async (offset: number) => {
      const scheduledTime = FIRST_TICK_MS + (startTick + offset) * CRON_PERIOD_MS;
      vi.setSystemTime(scheduledTime);
      await worker.scheduled(
        { scheduledTime } as ScheduledController,
        env as Env,
        {} as ExecutionContext,
      );
      return scheduledTime;
    };
    const heartbeatWrites = () => puts.filter((key) => key === CRON_HEARTBEAT_KEY);

    await runTick(0);
    const firstHeartbeat = store.get(CRON_HEARTBEAT_KEY);
    expect(firstHeartbeat).toBeDefined();
    expect(heartbeatWrites()).toHaveLength(1);

    for (const offset of [1, 2, 3, 4]) await runTick(offset);
    expect(heartbeatWrites()).toHaveLength(1);
    expect(store.get(CRON_HEARTBEAT_KEY)).toBe(firstHeartbeat);

    const elapsedTick = await runTick(5);
    expect(heartbeatWrites()).toHaveLength(2);
    const heartbeat = JSON.parse(store.get(CRON_HEARTBEAT_KEY)!) as {
      lastTickAt: string;
      locations: Record<string, string>;
      unreachable: Record<string, string>;
    };
    expect(heartbeat).toEqual({
      schemaVersion: 2,
      lastTickAt: new Date(elapsedTick).toISOString(),
      // Publication-window ticks are healthy but contact no provider, so they
      // advance only app-wide liveness—not per-city contact history.
      locations: {},
      unreachable: {},
    });
    expect(kvWriteEvents(log.mock.calls).map(({ category }) => category)).toEqual([
      'heartbeat-cadence',
      'heartbeat-cadence',
    ]);
    expect(provider).not.toHaveBeenCalled();
  });

  it('treats a duplicate recent check as neutral instead of inventing an anomaly', async () => {
    const { env, store, puts } = runtime();
    const scheduledTime = FIRST_TICK_MS + 2 * LOCATIONS.length * CRON_PERIOD_MS;
    const provider = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('A source fetch is not due in this fixture.'),
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.setSystemTime(scheduledTime);

    for (let duplicate = 0; duplicate < 2; duplicate += 1) {
      await worker.scheduled(
        { scheduledTime } as ScheduledController,
        env as Env,
        {} as ExecutionContext,
      );
    }

    expect(provider).not.toHaveBeenCalled();
    expect(puts.filter((key) => key === CRON_HEARTBEAT_KEY)).toHaveLength(1);
    expect(JSON.parse(store.get(CRON_HEARTBEAT_KEY)!)).toEqual({
      schemaVersion: 2,
      lastTickAt: new Date(scheduledTime).toISOString(),
      locations: {},
      unreachable: {},
    });
  });

  it('limits a selected city to three attempts per failing 5xx catalogue stage', async () => {
    const { env, store } = runtime(DUE_MARINE_RUN);
    const provider = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response('temporary provider failure', { status: 503 }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    // Twenty minutes after the fixture epoch the rotation is back on Horsens
    // and any isolate-local two-minute suppression stamp from earlier fixtures
    // is safely in the past.
    const scheduledTime = FIRST_TICK_MS + 5 * LOCATIONS.length * CRON_PERIOD_MS;
    vi.setSystemTime(scheduledTime);
    await worker.scheduled(
      { scheduledTime } as ScheduledController,
      env as Env,
      {} as ExecutionContext,
    );

    // Water and wave catalogue stages run in parallel. Each gets one initial
    // request plus two retries; neither can spend the 45-request event reserve.
    expect(provider).toHaveBeenCalledTimes(6);
    const heartbeat = JSON.parse(store.get(CRON_HEARTBEAT_KEY)!) as {
      locations: Record<string, string>;
      unreachable: Record<string, string>;
    };
    expect(heartbeat.locations).toEqual({});
    expect(heartbeat.unreachable).toEqual({
      horsens: new Date(scheduledTime).toISOString(),
    });
  });

  it('writes the first unsuccessful transition immediately inside the five-tick throttle', async () => {
    const { env, store, puts } = runtime(DUE_MARINE_RUN);
    const provider = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response('temporary provider failure', { status: 503 }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const scheduledTime = FIRST_TICK_MS + 10 * LOCATIONS.length * CRON_PERIOD_MS;
    const previousTick = scheduledTime - CRON_PERIOD_MS;
    const previousSuccess = scheduledTime - LOCATIONS.length * CRON_PERIOD_MS;
    store.set(CRON_HEARTBEAT_KEY, JSON.stringify({
      schemaVersion: 2,
      lastTickAt: new Date(previousTick).toISOString(),
      locations: { horsens: new Date(previousSuccess).toISOString() },
      unreachable: {},
    }));

    vi.setSystemTime(scheduledTime);
    await worker.scheduled(
      { scheduledTime } as ScheduledController,
      env as Env,
      {} as ExecutionContext,
    );

    expect(provider).toHaveBeenCalledTimes(6);
    expect(puts.filter((key) => key === CRON_HEARTBEAT_KEY)).toHaveLength(1);
    expect(JSON.parse(store.get(CRON_HEARTBEAT_KEY)!)).toEqual({
      schemaVersion: 2,
      lastTickAt: new Date(scheduledTime).toISOString(),
      locations: { horsens: new Date(previousSuccess).toISOString() },
      unreachable: { horsens: new Date(scheduledTime).toISOString() },
    });
    expect(kvWriteEvents(log.mock.calls)
      .filter(({ category }) => category.startsWith('heartbeat-'))
      .map(({ category }) => category)).toEqual(['heartbeat-anomaly']);
  });

  it('throttles an unchanged anomaly but refreshes it when five ticks have elapsed', async () => {
    const { env, store, puts } = runtime(DUE_MARINE_RUN);
    const provider = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response('temporary provider failure', { status: 503 }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const repeatedTick = FIRST_TICK_MS + 11 * LOCATIONS.length * CRON_PERIOD_MS;
    const location = tickOrder(repeatedTick)[0];
    const previousTick = repeatedTick - CRON_PERIOD_MS;
    const previousFailure = repeatedTick - LOCATIONS.length * CRON_PERIOD_MS;
    const previousSuccess = repeatedTick - 2 * LOCATIONS.length * CRON_PERIOD_MS;
    const storedHeartbeat = JSON.stringify({
      schemaVersion: 2,
      lastTickAt: new Date(previousTick).toISOString(),
      locations: { [location.id]: new Date(previousSuccess).toISOString() },
      unreachable: { [location.id]: new Date(previousFailure).toISOString() },
    });
    store.set(CRON_HEARTBEAT_KEY, storedHeartbeat);

    vi.setSystemTime(repeatedTick);
    await worker.scheduled(
      { scheduledTime: repeatedTick } as ScheduledController,
      env as Env,
      {} as ExecutionContext,
    );

    expect(provider).toHaveBeenCalledTimes(6);
    expect(puts.filter((key) => key === CRON_HEARTBEAT_KEY)).toHaveLength(0);
    expect(store.get(CRON_HEARTBEAT_KEY)).toBe(storedHeartbeat);

    const elapsedTick = repeatedTick
      + (CRON_HEARTBEAT_THROTTLE_TICKS - 1) * CRON_PERIOD_MS;
    expect(tickOrder(elapsedTick)[0].id).toBe(location.id);
    vi.setSystemTime(elapsedTick);
    await worker.scheduled(
      { scheduledTime: elapsedTick } as ScheduledController,
      env as Env,
      {} as ExecutionContext,
    );

    // The first 503 established provider retry-backoff. That no-probe repeat is
    // still an unchanged unreachable outcome, without another upstream burst.
    expect(provider).toHaveBeenCalledTimes(6);
    expect(puts.filter((key) => key === CRON_HEARTBEAT_KEY)).toHaveLength(1);
    expect(JSON.parse(store.get(CRON_HEARTBEAT_KEY)!)).toEqual({
      schemaVersion: 2,
      lastTickAt: new Date(elapsedTick).toISOString(),
      locations: { [location.id]: new Date(previousSuccess).toISOString() },
      unreachable: { [location.id]: new Date(elapsedTick).toISOString() },
    });
  });

  it('does not let a healthy no-probe tick clear an active anomaly', async () => {
    const { env, store, puts } = runtime();
    const scheduledTime = FIRST_TICK_MS + (10 * LOCATIONS.length + 1) * CRON_PERIOD_MS;
    const location = tickOrder(scheduledTime)[0];
    const previousTick = scheduledTime - 5 * CRON_PERIOD_MS;
    const previousFailure = scheduledTime - 6 * CRON_PERIOD_MS;
    const previousSuccess = scheduledTime - 8 * CRON_PERIOD_MS;
    store.set(CRON_HEARTBEAT_KEY, JSON.stringify({
      schemaVersion: 2,
      lastTickAt: new Date(previousTick).toISOString(),
      locations: { [location.id]: new Date(previousSuccess).toISOString() },
      unreachable: { [location.id]: new Date(previousFailure).toISOString() },
    }));
    const provider = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('A source fetch is not due in this fixture.'),
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});

    vi.setSystemTime(scheduledTime);
    await worker.scheduled(
      { scheduledTime } as ScheduledController,
      env as Env,
      {} as ExecutionContext,
    );

    expect(provider).not.toHaveBeenCalled();
    expect(puts.filter((key) => key === CRON_HEARTBEAT_KEY)).toHaveLength(1);
    expect(JSON.parse(store.get(CRON_HEARTBEAT_KEY)!)).toEqual({
      schemaVersion: 2,
      lastTickAt: new Date(scheduledTime).toISOString(),
      locations: { [location.id]: new Date(previousSuccess).toISOString() },
      unreachable: { [location.id]: new Date(previousFailure).toISOString() },
    });
  });

  it('writes a contacted recovery immediately after throttling an unchanged failure', async () => {
    const { env, store, puts } = runtime(DUE_MARINE_RUN);
    const scheduledTime = FIRST_TICK_MS + 12 * LOCATIONS.length * CRON_PERIOD_MS;
    const location = tickOrder(scheduledTime)[0];
    const previousTick = scheduledTime - CRON_PERIOD_MS;
    const previousFailure = scheduledTime - 2 * CRON_PERIOD_MS;
    const previousSuccess = scheduledTime - 5 * CRON_PERIOD_MS;
    store.set(CRON_HEARTBEAT_KEY, JSON.stringify({
      schemaVersion: 2,
      lastTickAt: new Date(previousTick).toISOString(),
      locations: { [location.id]: new Date(previousSuccess).toISOString() },
      unreachable: { [location.id]: new Date(previousFailure).toISOString() },
    }));
    const provider = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response('temporary provider failure', { status: 503 }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.setSystemTime(scheduledTime);
    await worker.scheduled(
      { scheduledTime } as ScheduledController,
      env as Env,
      {} as ExecutionContext,
    );

    expect(puts.filter((key) => key === CRON_HEARTBEAT_KEY)).toHaveLength(0);

    const interveningTick = scheduledTime + CRON_PERIOD_MS;
    const interveningLocation = tickOrder(interveningTick)[0];
    expect(interveningLocation.id).not.toBe(location.id);
    vi.setSystemTime(interveningTick);
    await worker.scheduled(
      { scheduledTime: interveningTick } as ScheduledController,
      env as Env,
      {} as ExecutionContext,
    );

    expect(puts.filter((key) => key === CRON_HEARTBEAT_KEY)).toHaveLength(1);

    provider.mockClear();
    provider.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/instances')) {
        return Response.json({ instances: [{ id: DUE_MARINE_RUN }] });
      }
      throw new Error(`Unexpected provider URL: ${url}`);
    });

    const recoveryTick = scheduledTime + LOCATIONS.length * CRON_PERIOD_MS;
    expect(tickOrder(recoveryTick)[0].id).toBe(location.id);
    vi.setSystemTime(recoveryTick);
    await worker.scheduled(
      { scheduledTime: recoveryTick } as ScheduledController,
      env as Env,
      {} as ExecutionContext,
    );

    expect(provider).toHaveBeenCalledTimes(2);
    expect(puts.filter((key) => key === CRON_HEARTBEAT_KEY)).toHaveLength(2);
    expect(JSON.parse(store.get(CRON_HEARTBEAT_KEY)!)).toEqual({
      schemaVersion: 2,
      lastTickAt: new Date(recoveryTick).toISOString(),
      locations: { [location.id]: new Date(recoveryTick).toISOString() },
      unreachable: {
        [location.id]: new Date(previousFailure).toISOString(),
        [interveningLocation.id]: new Date(interveningTick).toISOString(),
      },
    });
    expect(kvWriteEvents(log.mock.calls)
      .filter(({ category }) => category.startsWith('heartbeat-'))
      .map(({ category }) => category)).toEqual([
        'heartbeat-anomaly',
        'heartbeat-anomaly',
      ]);
  });

  it('records a city\'s first actual provider contact inside the normal throttle', async () => {
    const { env, store, puts } = runtime(DUE_MARINE_RUN);
    const scheduledTime = FIRST_TICK_MS + 12 * LOCATIONS.length * CRON_PERIOD_MS;
    const location = tickOrder(scheduledTime)[0];
    store.set(CRON_HEARTBEAT_KEY, JSON.stringify({
      schemaVersion: 2,
      lastTickAt: new Date(scheduledTime - CRON_PERIOD_MS).toISOString(),
      locations: {},
      unreachable: {},
    }));
    const provider = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/instances')) {
        return Response.json({ instances: [{ id: DUE_MARINE_RUN }] });
      }
      throw new Error(`Unexpected provider URL: ${url}`);
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    vi.setSystemTime(scheduledTime);
    await worker.scheduled(
      { scheduledTime } as ScheduledController,
      env as Env,
      {} as ExecutionContext,
    );

    expect(provider).toHaveBeenCalledTimes(2);
    expect(puts.filter((key) => key === CRON_HEARTBEAT_KEY)).toHaveLength(1);
    expect(JSON.parse(store.get(CRON_HEARTBEAT_KEY)!)).toEqual({
      schemaVersion: 2,
      lastTickAt: new Date(scheduledTime).toISOString(),
      locations: { [location.id]: new Date(scheduledTime).toISOString() },
      unreachable: {},
    });
    expect(kvWriteEvents(log.mock.calls)
      .filter(({ category }) => category.startsWith('heartbeat-'))
      .map(({ category }) => category)).toEqual(['heartbeat-cadence']);
  });

  it('rejects a late heartbeat write from an older scheduled tick', async () => {
    const { env, store, puts } = runtime();
    const scheduledTime = FIRST_TICK_MS + 15 * LOCATIONS.length * CRON_PERIOD_MS;
    const storedTick = scheduledTime + 5 * CRON_PERIOD_MS;
    const storedHeartbeat = JSON.stringify({
      schemaVersion: 2,
      lastTickAt: new Date(storedTick).toISOString(),
      locations: { horsens: new Date(storedTick - CRON_PERIOD_MS).toISOString() },
      unreachable: {},
    });
    store.set(CRON_HEARTBEAT_KEY, storedHeartbeat);
    vi.setSystemTime(storedTick + 5 * CRON_PERIOD_MS);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('A source fetch is not due in this fixture.'),
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await worker.scheduled(
      { scheduledTime } as ScheduledController,
      env as Env,
      {} as ExecutionContext,
    );

    expect(puts.filter((key) => key === CRON_HEARTBEAT_KEY)).toHaveLength(0);
    expect(store.get(CRON_HEARTBEAT_KEY)).toBe(storedHeartbeat);
  });
});
