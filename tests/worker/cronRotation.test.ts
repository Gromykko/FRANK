import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import locationData from '../../src/config/locations.json';
import type { ForecastLocation } from '../../src/config/locationTypes';
import { CURRENT_RELEASE } from '../../src/features/forecast/releaseContract';
import { buildSunSchedule } from '../../src/features/forecast/sun';
import { FORECAST_PAYLOAD_VERSION } from '../../src/features/forecast/types';
import type { ForecastData } from '../../worker/domain';
import {
  CRON_PERIOD_MS,
  CRON_SUBREQUEST_CALL_GRAPH,
  CRON_TICK_BUDGET_MS,
  cronExecutionPolicy,
} from '../../worker/execution';
import { assembledForecastKey, marineIngredientKey } from '../../worker/generation';
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
import { completeMarineEnvelope, completeMarineSeries } from './marineTestData';

const LOCATIONS = locationData as ForecastLocation[];
const FIRST_TICK_MS = Date.parse('2026-08-20T16:00:00.000Z');
const MARINE_RUN = '2026-08-20T120000Z';
const DUE_MARINE_RUN = '2026-08-20T060000Z';
const DUE_MARINE_DECLARED_END_MS = Date.parse('2026-08-25T06:00:00.000Z');
const DECLARED_RUN_SPAN_MS = 5 * 24 * 60 * 60_000;

function declaredEndMsForRun(run: string): number {
  const match = run.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!match) throw new Error(`Expected a compact DMI run id, received ${run}.`);
  const runMs = Date.parse(
    `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`,
  );
  return runMs + DECLARED_RUN_SPAN_MS;
}

function catalogueInstance(run: string) {
  const declaredEndMs = declaredEndMsForRun(run);
  return {
    id: run,
    extent: {
      temporal: {
        interval: [[
          new Date(declaredEndMs - DECLARED_RUN_SPAN_MS).toISOString(),
          new Date(declaredEndMs).toISOString(),
        ]],
      },
    },
  };
}
// The static CRON_*_MAX_ATTEMPTS values are upper bounds. Since attempts are
// budgeted at their real ~6s cost (minus the completion reserve), the policy
// usually grants fewer, and a simulation keyed to the ceiling describes a run
// that cannot happen. Derive from the policy instead.
const CRON_EFFECTIVE_CATALOGUE_ATTEMPTS =
  cronExecutionPolicy(0, CRON_TICK_BUDGET_MS, 1)!.marineCatalogueMaxAttempts;
const EXHAUSTED_FIRST_COLLECTION_REQUESTS =
  CRON_SUBREQUEST_CALL_GRAPH.marineKinds
  * CRON_EFFECTIVE_CATALOGUE_ATTEMPTS;

interface KvWriteEvent {
  event: 'kv_write';
  category: string;
}

interface CronTickCompletedEvent {
  event: 'cron_tick_completed';
  locationId: string | null;
  scheduledAt: string;
  durationMs: number;
  probeDecisionReason: string | null;
  canSkipProbe: boolean | null;
  outcome: string;
  subrequestCount: number;
  providerDeadlineReached: boolean;
}

function isCronTickCompletedEvent(value: unknown): value is CronTickCompletedEvent {
  return typeof value === 'object'
    && value !== null
    && Reflect.get(value, 'event') === 'cron_tick_completed'
    && typeof Reflect.get(value, 'scheduledAt') === 'string'
    && typeof Reflect.get(value, 'durationMs') === 'number'
    && typeof Reflect.get(value, 'subrequestCount') === 'number'
    && typeof Reflect.get(value, 'providerDeadlineReached') === 'boolean';
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

function cronTickEvents(calls: readonly (readonly unknown[])[]): CronTickCompletedEvent[] {
  return calls.flatMap(([message]) => {
    if (typeof message !== 'string' || !message.startsWith('{')) return [];
    try {
      const value: unknown = JSON.parse(message);
      return isCronTickCompletedEvent(value) ? [value] : [];
    } catch {
      return [];
    }
  });
}

function cachedForecast(
  location: ForecastLocation,
  marineRun: string | { water: string; waves: string },
): ForecastData {
  const waterRun = typeof marineRun === 'string' ? marineRun : marineRun.water;
  const wavesRun = typeof marineRun === 'string' ? marineRun : marineRun.waves;
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
          water: {
            collection: 'dkss_idw',
            id: waterRun,
            declaredEndMs: declaredEndMsForRun(waterRun),
          },
          waves: {
            collection: 'wam_nsb',
            id: wavesRun,
            declaredEndMs: declaredEndMsForRun(wavesRun),
          },
        },
      },
    },
  };
}

function runtime(marineRun: string | { water: string; waves: string } = MARINE_RUN) {
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
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

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
    const completed = cronTickEvents(log.mock.calls);
    expect(completed).toHaveLength(LOCATIONS.length);
    expect(completed).toEqual(expectedCycle.map((location, index) => ({
      event: 'cron_tick_completed',
      locationId: location.id,
      scheduledAt: new Date(FIRST_TICK_MS + index * CRON_PERIOD_MS).toISOString(),
      durationMs: 0,
      probeDecisionReason: 'publication-window',
      canSkipProbe: true,
      outcome: 'healthy-no-probe',
      subrequestCount: 0,
      providerDeadlineReached: false,
    })));
    expect(log.mock.calls.some(([message]) =>
      typeof message === 'string' && message.includes('cron tick done in'))).toBe(false);
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

  it('keeps a budget-truncated selected city unreachable without moving its last success', async () => {
    const { env, store } = runtime();
    const scheduledTime = FIRST_TICK_MS + 20 * LOCATIONS.length * CRON_PERIOD_MS;
    const location = tickOrder(scheduledTime)[0];
    const forecastKey = assembledForecastKey(location);
    const cachedBefore = store.get(forecastKey)!;
    const previousSuccess = scheduledTime - 4 * CRON_PERIOD_MS;
    store.set(CRON_HEARTBEAT_KEY, JSON.stringify({
      schemaVersion: 2,
      lastTickAt: new Date(scheduledTime - CRON_PERIOD_MS).toISOString(),
      locations: { [location.id]: new Date(previousSuccess).toISOString() },
      unreachable: {},
    }));
    const provider = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('A budget-truncated tick must not start provider work.'),
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.setSystemTime(scheduledTime);
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(scheduledTime)
      .mockReturnValueOnce(scheduledTime)
      .mockReturnValue(scheduledTime + CRON_TICK_BUDGET_MS + 1);

    await worker.scheduled(
      { scheduledTime } as ScheduledController,
      env as Env,
      {} as ExecutionContext,
    );

    expect(provider).not.toHaveBeenCalled();
    expect(store.get(forecastKey)).toBe(cachedBefore);
    expect(JSON.parse(store.get(CRON_HEARTBEAT_KEY)!)).toEqual({
      schemaVersion: 2,
      lastTickAt: new Date(scheduledTime).toISOString(),
      locations: { [location.id]: new Date(previousSuccess).toISOString() },
      unreachable: { [location.id]: new Date(scheduledTime).toISOString() },
    });
  });

  it('discloses an equal manifest-only run after grace without inventing contact', async () => {
    const { env, store, gets, puts } = runtime(DUE_MARINE_RUN);
    const scheduledTime = FIRST_TICK_MS + 3 * LOCATIONS.length * CRON_PERIOD_MS;
    const location = tickOrder(scheduledTime)[0];
    const forecastKey = assembledForecastKey(location);
    const cachedBefore = store.get(forecastKey)!;
    const previousAttemptAt = (JSON.parse(cachedBefore) as ForecastData)
      .sources.cacheHealth?.lastAttemptAt;
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
          declaredEndMs: DUE_MARINE_DECLARED_END_MS,
          discoveredAt,
        },
        [dmiCollectionListKey(location.dmiCollections.waves)]: {
          collection: location.dmiCollections.waves[0],
          id: DUE_MARINE_RUN,
          declaredEndMs: DUE_MARINE_DECLARED_END_MS,
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
    expect(store.get(forecastKey)).not.toBe(cachedBefore);
    expect(puts).toContain(forecastKey);
    const checked = JSON.parse(store.get(forecastKey)!) as ForecastData;
    expect(checked.sources.cacheHealth).toMatchObject({
      status: 'current',
      degradedSources: ['water', 'waves'],
      lastAttemptAt: previousAttemptAt,
    });
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
        return Response.json({ instances: [catalogueInstance(DUE_MARINE_RUN)] });
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

  it('does not degrade an ahead sibling when only the lagging source is due', async () => {
    const { env, store } = runtime({
      water: DUE_MARINE_RUN,
      waves: '2026-08-20T120000Z',
    });
    const scheduledTime = FIRST_TICK_MS + LOCATIONS.length * CRON_PERIOD_MS;
    const location = tickOrder(scheduledTime)[0];
    const provider = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/instances') && url.includes('/collections/dkss_')) {
        return Response.json({ instances: [catalogueInstance(DUE_MARINE_RUN)] });
      }
      if (url.endsWith('/instances') && url.includes('/collections/wam_')) {
        return new Response('temporary provider failure', { status: 503 });
      }
      throw new Error(`Unexpected provider URL: ${url}`);
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.setSystemTime(scheduledTime);

    await worker.scheduled(
      { scheduledTime } as ScheduledController,
      env as Env,
      {} as ExecutionContext,
    );

    const checked = JSON.parse(store.get(assembledForecastKey(location))!) as ForecastData;
    expect(provider.mock.calls.some(([input]) => String(input).includes('/collections/dkss_')))
      .toBe(true);
    expect(provider.mock.calls.some(([input]) => String(input).includes('/collections/wam_')))
      .toBe(true);
    expect(checked.sources.cacheHealth?.marineInstances).toEqual({
      water: {
        collection: 'dkss_idw',
        id: DUE_MARINE_RUN,
        declaredEndMs: DUE_MARINE_DECLARED_END_MS,
      },
      waves: {
        collection: 'wam_nsb',
        id: '2026-08-20T120000Z',
        declaredEndMs: declaredEndMsForRun('2026-08-20T120000Z'),
      },
    });
    expect(checked.sources.cacheHealth?.degradedSources).toEqual(['water']);
    expect(checked.sources.cacheHealth?.providerBusy).toBeUndefined();
    expect(checked.sources.cacheHealth?.message).toBeUndefined();
    expect(JSON.parse(store.get(CRON_HEARTBEAT_KEY)!)).toEqual({
      schemaVersion: 2,
      lastTickAt: new Date(scheduledTime).toISOString(),
      locations: { [location.id]: new Date(scheduledTime).toISOString() },
      unreachable: {},
    });
  });

  it.each([
    {
      name: 'generic failure is visible as soon as the run is due',
      scheduledAt: '2026-08-20T15:40:00.000Z',
      waterResponse: () => new Response('temporary provider failure', {
        status: 503,
        headers: { 'Retry-After': '1200' },
      }),
      expectedDegraded: ['water'],
      expectedBusy: false,
      expectedMessage: 'Marine service unavailable',
    },
    {
      name: 'verified 429 remains neutral inside publication grace',
      scheduledAt: '2026-08-20T15:41:00.000Z',
      waterResponse: () => new Response('busy', {
        status: 429,
        headers: { 'Retry-After': '1200' },
      }),
      expectedDegraded: undefined,
      expectedBusy: false,
      expectedMessage: undefined,
    },
    {
      name: 'verified 429 becomes busy at the exact grace boundary',
      scheduledAt: '2026-08-20T15:50:00.000Z',
      waterResponse: () => new Response('busy', {
        status: 429,
        headers: { 'Retry-After': '1200' },
      }),
      expectedDegraded: ['water'],
      expectedBusy: true,
      expectedMessage: 'Marine service busy',
    },
    {
      name: 'valid empty catalogue remains neutral inside publication grace',
      scheduledAt: '2026-08-20T15:43:00.000Z',
      waterResponse: () => Response.json({ instances: [] }),
      expectedDegraded: undefined,
      expectedBusy: false,
      expectedMessage: undefined,
    },
  ])('$name', async ({
    scheduledAt,
    waterResponse,
    expectedDegraded,
    expectedBusy,
    expectedMessage,
  }) => {
    const scheduledTime = Date.parse(scheduledAt);
    const { env, store } = runtime({
      water: DUE_MARINE_RUN,
      waves: '2026-08-20T120000Z',
    });
    const location = tickOrder(scheduledTime)[0];
    const provider = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/instances') && url.includes('/collections/dkss_')) {
        return waterResponse();
      }
      if (url.endsWith('/instances') && url.includes('/collections/wam_')) {
        return Response.json({ instances: [catalogueInstance('2026-08-20T120000Z')] });
      }
      throw new Error(`Unexpected provider URL: ${url}`);
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.setSystemTime(scheduledTime);

    await worker.scheduled(
      { scheduledTime } as ScheduledController,
      env as Env,
      {} as ExecutionContext,
    );

    const checked = JSON.parse(store.get(assembledForecastKey(location))!) as ForecastData;
    expect(checked.sources.cacheHealth?.degradedSources).toEqual(expectedDegraded);
    expect(checked.sources.cacheHealth?.providerBusy).toBe(expectedBusy || undefined);
    expect(checked.sources.cacheHealth?.busyProvider)
      .toBe(expectedBusy ? 'marine' : undefined);
    if (expectedMessage) {
      expect(checked.sources.cacheHealth?.message).toContain(expectedMessage);
    } else {
      expect(checked.sources.cacheHealth?.message).toBeUndefined();
    }
    expect(provider.mock.calls.some(([input]) => String(input).includes('/collections/dkss_')))
      .toBe(true);
    expect(provider.mock.calls.some(([input]) => String(input).includes('/collections/wam_')))
      .toBe(true);
  });

  it('keeps a partial run invisible and retries it on the next city rotation', async () => {
    const firstTick = Date.parse('2026-08-20T15:44:00.000Z');
    const secondTick = firstTick + LOCATIONS.length * CRON_PERIOD_MS;
    const location = tickOrder(firstTick)[0];
    expect(tickOrder(secondTick)[0].id).toBe(location.id);
    const { env, store, puts } = runtime({
      water: DUE_MARINE_RUN,
      waves: '2026-08-20T120000Z',
    });
    const waterKey = marineIngredientKey(location, 'water');
    const wavesKey = marineIngredientKey(location, 'waves');
    store.set(
      waterKey,
      JSON.stringify(completeMarineEnvelope(location, 'water', DUE_MARINE_RUN)),
    );
    store.set(
      wavesKey,
      JSON.stringify(completeMarineEnvelope(location, 'waves', '2026-08-20T120000Z')),
    );
    const candidate = completeMarineSeries('water', '2026-08-20T120000Z');
    let waterPositionCalls = 0;
    const provider = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('api.met.no/')) {
        return Response.json({
          properties: {
            timeseries: [{
              time: '2026-08-20T17:00:00.000Z',
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
            Expires: 'Thu, 20 Aug 2026 18:00:00 GMT',
            'Last-Modified': 'Thu, 20 Aug 2026 15:30:00 GMT',
          },
        });
      }
      if (url.includes('feeds.meteoalarm.org/')) {
        return new Response('<feed></feed>', { status: 200 });
      }
      if (url.endsWith('/instances')) {
        return Response.json({
          instances: [catalogueInstance('2026-08-20T120000Z')],
        });
      }
      if (url.includes('/collections/dkss_') && url.includes('/instances/')) {
        waterPositionCalls += 1;
        const visible = waterPositionCalls === 1 ? candidate.slice(0, 12) : candidate;
        return Response.json({
          features: visible.map((point) => ({
            properties: {
              step: point.time,
              'sea-mean-deviation': point.tideLevel,
              'water-temperature': point.tempWater,
              'current-u': 0,
              'current-v': 0,
            },
          })),
        });
      }
      throw new Error(`Unexpected provider URL: ${url}`);
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.setSystemTime(firstTick);
    await worker.scheduled(
      { scheduledTime: firstTick } as ScheduledController,
      env as Env,
      {} as ExecutionContext,
    );

    const afterPartial = JSON.parse(
      store.get(assembledForecastKey(location))!,
    ) as ForecastData;
    expect(afterPartial.sources.cacheHealth?.marineInstances?.water?.id)
      .toBe(DUE_MARINE_RUN);
    expect(afterPartial.sources.cacheHealth?.degradedSources).toBeUndefined();
    expect(JSON.parse(store.get(waterKey)!)).toMatchObject({ id: DUE_MARINE_RUN });
    expect(puts.filter((key) => key === waterKey)).toHaveLength(0);
    expect(waterPositionCalls).toBe(1);

    vi.setSystemTime(secondTick);
    await worker.scheduled(
      { scheduledTime: secondTick } as ScheduledController,
      env as Env,
      {} as ExecutionContext,
    );

    const afterComplete = JSON.parse(
      store.get(assembledForecastKey(location))!,
    ) as ForecastData;
    expect(afterComplete.sources.cacheHealth?.marineInstances?.water?.id)
      .toBe('2026-08-20T120000Z');
    expect(JSON.parse(store.get(waterKey)!)).toMatchObject({
      id: '2026-08-20T120000Z',
      seriesEndMs: Date.parse('2026-08-25T12:00:00.000Z'),
    });
    expect(puts.filter((key) => key === waterKey)).toHaveLength(1);
    expect(waterPositionCalls).toBe(2);
    expect(provider).toHaveBeenCalled();
  });

  it('never relabels expired assembled rows with an unaccepted partial run', async () => {
    const firstTick = Date.parse('2026-08-20T15:44:00.000Z');
    const secondTick = firstTick + LOCATIONS.length * CRON_PERIOD_MS;
    const location = tickOrder(firstTick)[0];
    const expiredWaterRun = '2026-08-20T000000Z';
    const candidateWaterRun = '2026-08-20T120000Z';
    const wavesRun = '2026-08-20T120000Z';
    const { env, store, puts } = runtime({ water: expiredWaterRun, waves: wavesRun });
    const waterKey = marineIngredientKey(location, 'water');
    const wavesKey = marineIngredientKey(location, 'waves');
    // There is deliberately no usable raw water ingredient. The only water
    // rows live in the assembled payload and are already beyond the 12-hour
    // safety limit; a fresh catalogue id must never re-date those bytes.
    store.set(
      wavesKey,
      JSON.stringify(completeMarineEnvelope(location, 'waves', wavesRun)),
    );
    const partialWater = completeMarineSeries('water', candidateWaterRun).slice(0, 12);
    let waterPositionCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('api.met.no/')) {
        return Response.json({
          properties: {
            timeseries: [{
              time: '2026-08-20T17:00:00.000Z',
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
            Expires: 'Thu, 20 Aug 2026 18:00:00 GMT',
            'Last-Modified': 'Thu, 20 Aug 2026 15:30:00 GMT',
          },
        });
      }
      if (url.includes('feeds.meteoalarm.org/')) {
        return new Response('<feed></feed>', { status: 200 });
      }
      if (url.endsWith('/instances')) {
        return Response.json({ instances: [catalogueInstance(candidateWaterRun)] });
      }
      if (url.includes('/collections/dkss_') && url.includes('/instances/')) {
        waterPositionCalls += 1;
        return Response.json({
          features: partialWater.map((point) => ({
            properties: {
              step: point.time,
              'sea-mean-deviation': point.tideLevel,
              'water-temperature': point.tempWater,
              'current-u': 0,
              'current-v': 0,
            },
          })),
        });
      }
      throw new Error(`Unexpected provider URL: ${url}`);
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    for (const scheduledTime of [firstTick, secondTick]) {
      vi.setSystemTime(scheduledTime);
      await worker.scheduled(
        { scheduledTime } as ScheduledController,
        env as Env,
        {} as ExecutionContext,
      );

      const held = JSON.parse(store.get(assembledForecastKey(location))!) as ForecastData;
      expect(held.sources.cacheHealth).toMatchObject({
        status: 'stale',
        needsRebuild: true,
        marineInstances: {
          water: { collection: 'dkss_idw', id: expiredWaterRun },
        },
      });
      expect(store.has(waterKey)).toBe(false);
      expect(puts.filter((key) => key === waterKey)).toHaveLength(0);
    }

    // The next rotation must really retry DMI. Before the provenance fix, the
    // first failure stamped candidateWaterRun onto the old payload and the
    // second build reused those expired rows as if they belonged to that run.
    expect(waterPositionCalls).toBe(2);
  });

  it('does not add waves, busy copy, or contact when an ahead sibling probe fails', async () => {
    const { env, store } = runtime({
      water: DUE_MARINE_RUN,
      waves: '2026-08-20T120000Z',
    });
    const scheduledTime = FIRST_TICK_MS + 6 * LOCATIONS.length * CRON_PERIOD_MS;
    const location = tickOrder(scheduledTime)[0];
    const previousSuccess = scheduledTime - 4 * CRON_PERIOD_MS;
    store.set(CRON_HEARTBEAT_KEY, JSON.stringify({
      schemaVersion: 2,
      lastTickAt: new Date(
        scheduledTime - CRON_HEARTBEAT_THROTTLE_TICKS * CRON_PERIOD_MS,
      ).toISOString(),
      locations: { [location.id]: new Date(previousSuccess).toISOString() },
      unreachable: {},
    }));
    store.set(DMI_RUN_MANIFEST_KEY, JSON.stringify({
      schemaVersion: DMI_RUN_MANIFEST_SCHEMA_VERSION,
      entries: {
        [dmiCollectionListKey(location.dmiCollections.water)]: {
          collection: location.dmiCollections.water[0],
          id: DUE_MARINE_RUN,
          declaredEndMs: DUE_MARINE_DECLARED_END_MS,
          discoveredAt: new Date(scheduledTime).toISOString(),
        },
      },
    }));
    const provider = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/instances') && url.includes('/collections/wam_')) {
        return new Response('not due sibling unavailable', {
          status: 503,
          headers: { 'Retry-After': '1200' },
        });
      }
      throw new Error(`Unexpected provider URL: ${url}`);
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.setSystemTime(scheduledTime);

    await worker.scheduled(
      { scheduledTime } as ScheduledController,
      env as Env,
      {} as ExecutionContext,
    );

    expect(provider.mock.calls.some(([input]) => String(input).includes('/collections/dkss_')))
      .toBe(false);
    expect(provider.mock.calls.some(([input]) => String(input).includes('/collections/wam_')))
      .toBe(true);
    const checked = JSON.parse(store.get(assembledForecastKey(location))!) as ForecastData;
    expect(checked.sources.cacheHealth?.degradedSources).toEqual(['water']);
    expect(checked.sources.cacheHealth?.providerBusy).toBeUndefined();
    expect(checked.sources.cacheHealth?.message).toBeUndefined();
    expect(JSON.parse(store.get(CRON_HEARTBEAT_KEY)!)).toEqual({
      schemaVersion: 2,
      // The manifest is not contact, while the WAM request was genuinely
      // attempted and failed. Data-health grace does not erase that evidence.
      lastTickAt: new Date(scheduledTime).toISOString(),
      locations: { [location.id]: new Date(previousSuccess).toISOString() },
      unreachable: { [location.id]: new Date(scheduledTime).toISOString() },
    });
  });

  it('records contact when a due manifest hit is paired with a valid empty sibling catalogue', async () => {
    const { env, store } = runtime({
      water: DUE_MARINE_RUN,
      waves: '2026-08-20T120000Z',
    });
    const scheduledTime = FIRST_TICK_MS + 8 * LOCATIONS.length * CRON_PERIOD_MS;
    const location = tickOrder(scheduledTime)[0];
    const previousSuccess = scheduledTime - 4 * CRON_PERIOD_MS;
    store.set(CRON_HEARTBEAT_KEY, JSON.stringify({
      schemaVersion: 2,
      lastTickAt: new Date(
        scheduledTime - CRON_HEARTBEAT_THROTTLE_TICKS * CRON_PERIOD_MS,
      ).toISOString(),
      locations: { [location.id]: new Date(previousSuccess).toISOString() },
      unreachable: {},
    }));
    store.set(DMI_RUN_MANIFEST_KEY, JSON.stringify({
      schemaVersion: DMI_RUN_MANIFEST_SCHEMA_VERSION,
      entries: {
        [dmiCollectionListKey(location.dmiCollections.water)]: {
          collection: location.dmiCollections.water[0],
          id: DUE_MARINE_RUN,
          declaredEndMs: DUE_MARINE_DECLARED_END_MS,
          discoveredAt: new Date(scheduledTime).toISOString(),
        },
      },
    }));
    const provider = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/instances') && url.includes('/collections/wam_')) {
        return Response.json({ instances: [] });
      }
      throw new Error(`Unexpected provider URL: ${url}`);
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.setSystemTime(scheduledTime);

    await worker.scheduled(
      { scheduledTime } as ScheduledController,
      env as Env,
      {} as ExecutionContext,
    );

    expect(provider).toHaveBeenCalled();
    expect(JSON.parse(store.get(CRON_HEARTBEAT_KEY)!)).toEqual({
      schemaVersion: 2,
      lastTickAt: new Date(scheduledTime).toISOString(),
      locations: { [location.id]: new Date(scheduledTime).toISOString() },
      unreachable: {},
    });
  });

  it('records valid empty catalogues as contact while retaining due runs', async () => {
    const { env, store } = runtime(DUE_MARINE_RUN);
    const scheduledTime = FIRST_TICK_MS + 7 * LOCATIONS.length * CRON_PERIOD_MS;
    const location = tickOrder(scheduledTime)[0];
    const previousSuccess = scheduledTime - 4 * CRON_PERIOD_MS;
    const previousFailure = scheduledTime - 2 * CRON_PERIOD_MS;
    store.set(CRON_HEARTBEAT_KEY, JSON.stringify({
      schemaVersion: 2,
      lastTickAt: new Date(scheduledTime - CRON_PERIOD_MS).toISOString(),
      locations: { [location.id]: new Date(previousSuccess).toISOString() },
      unreachable: { [location.id]: new Date(previousFailure).toISOString() },
    }));
    const provider = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/instances')) return Response.json({ instances: [] });
      throw new Error(`Unexpected provider URL: ${url}`);
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.setSystemTime(scheduledTime);

    await worker.scheduled(
      { scheduledTime } as ScheduledController,
      env as Env,
      {} as ExecutionContext,
    );

    expect(provider).toHaveBeenCalledTimes(
      location.dmiCollections.water.length + location.dmiCollections.waves.length,
    );
    expect(provider.mock.calls.some(([input]) => String(input).includes('/position')))
      .toBe(false);
    const checked = JSON.parse(store.get(assembledForecastKey(location))!) as ForecastData;
    expect(checked.sources.cacheHealth).toMatchObject({
      degradedSources: ['water', 'waves'],
    });
    expect(JSON.parse(store.get(CRON_HEARTBEAT_KEY)!)).toEqual({
      schemaVersion: 2,
      lastTickAt: new Date(scheduledTime).toISOString(),
      locations: { [location.id]: new Date(scheduledTime).toISOString() },
      unreachable: { [location.id]: new Date(previousFailure).toISOString() },
    });
  });

  it('skips heartbeat writes inside the throttle window and writes once it elapses', async () => {
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

    for (let offset = 1; offset < CRON_HEARTBEAT_THROTTLE_TICKS; offset++) {
      await runTick(offset);
    }
    expect(heartbeatWrites()).toHaveLength(1);
    expect(store.get(CRON_HEARTBEAT_KEY)).toBe(firstHeartbeat);

    const elapsedTick = await runTick(CRON_HEARTBEAT_THROTTLE_TICKS);
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
    const location = tickOrder(scheduledTime)[0];
    const provider = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('A source fetch is not due in this fixture.'),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
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
    expect(cronTickEvents(log.mock.calls)).toEqual([
      expect.objectContaining({
        locationId: location.id,
        probeDecisionReason: 'publication-window',
        canSkipProbe: true,
        outcome: 'healthy-no-probe',
      }),
      expect.objectContaining({
        locationId: location.id,
        probeDecisionReason: 'recent-check',
        canSkipProbe: null,
        outcome: 'healthy-no-probe',
      }),
    ]);
  });

  it('uses the raised catalogue ceiling and retains a current cache without position work', async () => {
    const { env, store } = runtime(DUE_MARINE_RUN);
    const provider = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response('temporary provider failure', { status: 503 }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
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

    // Water and wave catalogue stages run in parallel. A 5xx does not qualify
    // for collection fallback, so each spends exactly its catalogue ceiling
    // and this still-current assembled forecast needs no position endpoint.
    expect(provider).toHaveBeenCalledTimes(EXHAUSTED_FIRST_COLLECTION_REQUESTS);
    expect(provider.mock.calls.some(([input]) =>
      /\/position(?:\?|$)/.test(String(input)))).toBe(false);
    const heartbeat = JSON.parse(store.get(CRON_HEARTBEAT_KEY)!) as {
      locations: Record<string, string>;
      unreachable: Record<string, string>;
    };
    expect(heartbeat.locations).toEqual({});
    expect(heartbeat.unreachable).toEqual({
      horsens: new Date(scheduledTime).toISOString(),
    });
    expect(cronTickEvents(log.mock.calls)).toEqual([
      expect.objectContaining({
        locationId: 'horsens',
        probeDecisionReason: 'due',
        canSkipProbe: false,
        outcome: 'unreachable',
        subrequestCount: EXHAUSTED_FIRST_COLLECTION_REQUESTS,
        providerDeadlineReached: false,
      }),
    ]);
  });

  it('reports when provider work reaches its reserved completion boundary', async () => {
    const { env } = runtime(DUE_MARINE_RUN);
    const scheduledTime = FIRST_TICK_MS + 7 * LOCATIONS.length * CRON_PERIOD_MS;
    const location = tickOrder(scheduledTime)[0];
    const policy = cronExecutionPolicy(
      scheduledTime,
      scheduledTime + CRON_TICK_BUDGET_MS,
      1,
    );
    if (!policy) throw new Error('Expected a full cron policy.');
    const providerDeadlineAt = policy.deadlineAt - policy.completionReserveMs;
    const provider = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      vi.setSystemTime(providerDeadlineAt);
      throw new Error('Provider remained unavailable through its working window.');
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.setSystemTime(scheduledTime);

    await worker.scheduled(
      { scheduledTime } as ScheduledController,
      env as Env,
      {} as ExecutionContext,
    );

    expect(provider).toHaveBeenCalledTimes(1);
    expect(cronTickEvents(log.mock.calls)).toEqual([
      expect.objectContaining({
        locationId: location.id,
        probeDecisionReason: 'due',
        canSkipProbe: false,
        outcome: 'unreachable',
        subrequestCount: 1,
        providerDeadlineReached: true,
      }),
    ]);
  });

  it('does not let a completion-log failure reject a healthy scheduled tick', async () => {
    const { env, store } = runtime();
    const scheduledTime = FIRST_TICK_MS + 9 * LOCATIONS.length * CRON_PERIOD_MS;
    const provider = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('A source fetch is not due in this fixture.'),
    );
    vi.spyOn(console, 'log').mockImplementation((message) => {
      if (typeof message !== 'string' || !message.startsWith('{')) return;
      const parsed: unknown = JSON.parse(message);
      if (typeof parsed === 'object'
        && parsed !== null
        && Reflect.get(parsed, 'event') === 'cron_tick_completed') {
        throw new Error('Logging sink unavailable.');
      }
    });
    vi.setSystemTime(scheduledTime);

    await expect(worker.scheduled(
      { scheduledTime } as ScheduledController,
      env as Env,
      {} as ExecutionContext,
    )).resolves.toBeUndefined();

    expect(provider).not.toHaveBeenCalled();
    expect(JSON.parse(store.get(CRON_HEARTBEAT_KEY)!)).toEqual({
      schemaVersion: 2,
      lastTickAt: new Date(scheduledTime).toISOString(),
      locations: {},
      unreachable: {},
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

    expect(provider).toHaveBeenCalledTimes(EXHAUSTED_FIRST_COLLECTION_REQUESTS);
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

  it('throttles an unchanged anomaly but refreshes it once the throttle has elapsed', async () => {
    const { env, store, puts } = runtime(DUE_MARINE_RUN);
    const provider = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response('temporary provider failure', { status: 503 }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const repeatedTick = FIRST_TICK_MS + 11 * LOCATIONS.length * CRON_PERIOD_MS;
    const location = tickOrder(repeatedTick)[0];
    // Sits far enough back that one further rotation crosses the throttle,
    // while the first run is still inside it (throttle - L, then + L = throttle).
    const previousTick = repeatedTick
      - (CRON_HEARTBEAT_THROTTLE_TICKS - LOCATIONS.length) * CRON_PERIOD_MS;
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

    expect(provider).toHaveBeenCalledTimes(EXHAUSTED_FIRST_COLLECTION_REQUESTS);
    expect(puts.filter((key) => key === CRON_HEARTBEAT_KEY)).toHaveLength(0);
    expect(store.get(CRON_HEARTBEAT_KEY)).toBe(storedHeartbeat);

    // Exactly one rotation later, so the same city comes round and the
    // failed-contact backoff has elapsed once - widening this would let the
    // catalogue retry again and change the fetch count asserted below.
    const elapsedTick = repeatedTick + LOCATIONS.length * CRON_PERIOD_MS;
    expect(tickOrder(elapsedTick)[0].id).toBe(location.id);
    vi.setSystemTime(elapsedTick);
    await worker.scheduled(
      { scheduledTime: elapsedTick } as ScheduledController,
      env as Env,
      {} as ExecutionContext,
    );

    // The first 503 marks marine degraded, so one city rotation later the
    // failed-contact backoff has elapsed and the catalogue is tried again. The
    // repeated failure is still an unchanged unreachable heartbeat outcome.
    expect(provider).toHaveBeenCalledTimes(2 * EXHAUSTED_FIRST_COLLECTION_REQUESTS);
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
    const previousTick = scheduledTime
      - CRON_HEARTBEAT_THROTTLE_TICKS * CRON_PERIOD_MS;
    const previousFailure = previousTick - CRON_PERIOD_MS;
    const previousSuccess = previousTick - 3 * CRON_PERIOD_MS;
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
        return Response.json({ instances: [catalogueInstance(DUE_MARINE_RUN)] });
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

  it('keeps a zero-attempt retry-backoff out of unreachable history', async () => {
    const { env, store, puts } = runtime(DUE_MARINE_RUN);
    // Use a later full rotation so module-scoped recent-check state left by
    // earlier same-city fixtures cannot hide the retry-backoff branch this test
    // is meant to pin.
    const scheduledTime = FIRST_TICK_MS + 14 * LOCATIONS.length * CRON_PERIOD_MS;
    const location = tickOrder(scheduledTime)[0];
    const forecastKey = assembledForecastKey(location);
    const cached = JSON.parse(store.get(forecastKey)!) as ForecastData;
    const previousSuccess = scheduledTime - 3 * CRON_PERIOD_MS;
    cached.sources.cacheHealth = {
      ...cached.sources.cacheHealth!,
      lastAttemptAt: new Date(previousSuccess).toISOString(),
      degradedSources: ['water'],
    };
    const cachedBefore = JSON.stringify(cached);
    store.set(forecastKey, cachedBefore);
    store.set(CRON_HEARTBEAT_KEY, JSON.stringify({
      schemaVersion: 2,
      lastTickAt: new Date(
        scheduledTime - CRON_HEARTBEAT_THROTTLE_TICKS * CRON_PERIOD_MS,
      ).toISOString(),
      locations: { [location.id]: new Date(previousSuccess).toISOString() },
      unreachable: {},
    }));
    const provider = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('Retry-backoff must not start a provider request.'),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    vi.setSystemTime(scheduledTime);
    await worker.scheduled(
      { scheduledTime } as ScheduledController,
      env as Env,
      {} as ExecutionContext,
    );

    expect(provider).not.toHaveBeenCalled();
    expect(store.get(forecastKey)).toBe(cachedBefore);
    expect(puts).not.toContain(forecastKey);
    expect(JSON.parse(store.get(CRON_HEARTBEAT_KEY)!)).toEqual({
      schemaVersion: 2,
      lastTickAt: new Date(scheduledTime).toISOString(),
      locations: { [location.id]: new Date(previousSuccess).toISOString() },
      unreachable: {},
    });
    expect(cronTickEvents(log.mock.calls)).toEqual([
      expect.objectContaining({
        locationId: location.id,
        probeDecisionReason: 'retry-backoff',
        canSkipProbe: true,
        outcome: 'healthy-no-probe',
        subrequestCount: 0,
      }),
    ]);
  });

  it('keeps retry-backoff unreachable when recovery attempts providers and fails', async () => {
    const { env, store } = runtime(DUE_MARINE_RUN);
    const scheduledTime = FIRST_TICK_MS + 15 * LOCATIONS.length * CRON_PERIOD_MS;
    const location = tickOrder(scheduledTime)[0];
    const forecastKey = assembledForecastKey(location);
    const cached = JSON.parse(store.get(forecastKey)!) as ForecastData;
    const previousSuccess = scheduledTime - 8 * CRON_PERIOD_MS;
    cached.sources.cacheHealth = {
      ...cached.sources.cacheHealth!,
      status: 'stale',
      lastAttemptAt: new Date(scheduledTime - 3 * CRON_PERIOD_MS).toISOString(),
      degradedSources: ['water', 'waves'],
    };
    store.set(forecastKey, JSON.stringify(cached));
    store.set(CRON_HEARTBEAT_KEY, JSON.stringify({
      schemaVersion: 2,
      lastTickAt: new Date(scheduledTime - CRON_PERIOD_MS).toISOString(),
      locations: { [location.id]: new Date(previousSuccess).toISOString() },
      unreachable: {},
    }));
    const provider = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response('provider busy', {
        status: 429,
        headers: { 'Retry-After': '1200' },
      }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.setSystemTime(scheduledTime);
    await worker.scheduled(
      { scheduledTime } as ScheduledController,
      env as Env,
      {} as ExecutionContext,
    );

    expect(provider).toHaveBeenCalled();
    expect(JSON.parse(store.get(CRON_HEARTBEAT_KEY)!)).toEqual({
      schemaVersion: 2,
      lastTickAt: new Date(scheduledTime).toISOString(),
      locations: { [location.id]: new Date(previousSuccess).toISOString() },
      unreachable: { [location.id]: new Date(scheduledTime).toISOString() },
    });
    const completed = cronTickEvents(log.mock.calls);
    expect(completed).toEqual([
      expect.objectContaining({
        locationId: location.id,
        probeDecisionReason: 'retry-backoff',
        canSkipProbe: false,
        outcome: 'unreachable',
      }),
    ]);
    expect(completed[0]?.subrequestCount).toBe(provider.mock.calls.length);
    expect(completed[0]?.subrequestCount).toBeGreaterThan(0);
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
        return Response.json({ instances: [catalogueInstance(DUE_MARINE_RUN)] });
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
