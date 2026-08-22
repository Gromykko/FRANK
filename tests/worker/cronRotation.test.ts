import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import locationData from '../../src/config/locations.json';
import type { ForecastLocation } from '../../src/config/locationTypes';
import { CURRENT_RELEASE } from '../../src/features/forecast/releaseContract';
import { buildSunSchedule } from '../../src/features/forecast/sun';
import { FORECAST_PAYLOAD_VERSION } from '../../src/features/forecast/types';
import type { ForecastData } from '../../worker/domain';
import { CRON_PERIOD_MS } from '../../worker/execution';
import { assembledForecastKey } from '../../worker/generation';
import worker, { CRON_HEARTBEAT_KEY, tickOrder } from '../../worker/index';

const LOCATIONS = locationData as ForecastLocation[];
const FIRST_TICK_MS = Date.parse('2026-08-20T16:00:00.000Z');
const MARINE_RUN = '2026-08-20T160000Z';
const DUE_MARINE_RUN = '2026-08-20T060000Z';

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
    const { env, store, puts } = runtime();
    const provider = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('A source fetch is not due in this fixture.'),
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const expectedCycle = Array.from({ length: LOCATIONS.length }, (_, index) => {
      const scheduledTime = FIRST_TICK_MS + index * CRON_PERIOD_MS;
      return tickOrder(scheduledTime)[0];
    });
    expect(new Set(expectedCycle.map(({ id }) => id)).size).toBe(LOCATIONS.length);

    const previousAttempts: Record<string, string> = {};
    for (const [index, expectedLocation] of expectedCycle.entries()) {
      const scheduledTime = FIRST_TICK_MS + index * CRON_PERIOD_MS;
      vi.setSystemTime(scheduledTime);

      await worker.scheduled(
        { scheduledTime } as ScheduledController,
        env as Env,
        {} as ExecutionContext,
      );

      const rawHeartbeat = store.get(CRON_HEARTBEAT_KEY);
      expect(rawHeartbeat).toBeDefined();
      const heartbeat = JSON.parse(rawHeartbeat!) as {
        lastTickAt: string;
        locations: Record<string, string>;
      };
      const changedThisTick = Object.entries(heartbeat.locations)
        .filter(([id, attemptedAt]) => previousAttempts[id] !== attemptedAt)
        .map(([id]) => id);

      expect(changedThisTick).toEqual([expectedLocation.id]);
      expect(heartbeat.locations[expectedLocation.id]).toBe(new Date(scheduledTime).toISOString());
      Object.assign(previousAttempts, heartbeat.locations);
    }

    expect(Object.keys(previousAttempts).sort()).toEqual(LOCATIONS.map(({ id }) => id).sort());
    expect(puts.filter((key) => key === CRON_HEARTBEAT_KEY)).toHaveLength(LOCATIONS.length);
    expect(provider).not.toHaveBeenCalled();
  });

  it('limits a selected city to three attempts per failing 5xx provider stage', async () => {
    const { env, store } = runtime(DUE_MARINE_RUN);
    const provider = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response('temporary provider failure', { status: 503 }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    // Twenty minutes later the rotation returns to Horsens, and the prior
    // test's isolate-local gate is outside its two-minute suppression window.
    const scheduledTime = FIRST_TICK_MS + LOCATIONS.length * CRON_PERIOD_MS;
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
    };
    expect(heartbeat.locations).toEqual({
      horsens: new Date(scheduledTime).toISOString(),
    });
  });
});
