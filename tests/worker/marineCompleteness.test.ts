import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import locationData from '../../src/config/locations.json';
import type { ForecastLocation } from '../../src/config/locationTypes';
import { getCacheStatusView } from '../../src/features/forecast/cacheStatusView';
import { marineIngredientKey } from '../../worker/generation';
import {
  assembleForecastFromSources,
  heldMarineFallback,
} from '../../worker/forecastModel';
import {
  fetchLatestInstanceForCollections,
  fetchMarineSeriesWithFallback,
} from '../../worker/providers';

const LOCATION = locationData[0] as ForecastLocation;
const RUN_ID = '2026-08-25T060000Z';
const NOW_MS = Date.parse('2026-08-25T10:30:00Z');
const COLLECTION = LOCATION.dmiCollections.water[0];

function makeEnv() {
  const values = new Map<string, string>();
  const puts: string[] = [];
  return {
    values,
    puts,
    env: {
      FRANK_FORECAST_CACHE: {
        async get(key: string, type?: string) {
          const value = values.get(key);
          if (value === undefined) return null;
          return type === 'json' ? JSON.parse(value) : value;
        },
        async put(key: string, value: string) {
          puts.push(key);
          values.set(key, value);
        },
      },
    } as Env,
  };
}

async function constructStoredEnvelope(
  series: Array<{ time: string; timeMs: number; tideLevel: number }>,
  declaredEnd: string | null,
) {
  const store = makeEnv();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith('/instances')) {
      return Response.json({
        instances: [{
          id: RUN_ID,
          ...(declaredEnd === null
            ? {}
            : {
                extent: { temporal: { interval: [[
                  '2026-08-25T06:00:00Z',
                  declaredEnd,
                ]] } },
              }),
        }],
      });
    }
    return Response.json({ features: series });
  });

  const instance = await fetchLatestInstanceForCollections([COLLECTION]);
  const marineResult = await fetchMarineSeriesWithFallback(
    store.env,
    LOCATION,
    'water',
    instance,
    ['waterlevel'],
    (features) => features as typeof series,
  );
  const key = marineIngredientKey(LOCATION, 'water');
  return {
    ...store,
    instance,
    marineResult,
    envelope: JSON.parse(store.values.get(key)!),
  };
}

function assembleWithWater(
  water: NonNullable<ReturnType<typeof heldMarineFallback>>,
  time: string,
) {
  const timeMs = Date.parse(time);
  return assembleForecastFromSources(LOCATION, {
    met: {
      weatherSeries: [{
        time,
        timeMs,
        tempAir: 16,
        precipitation: 0,
        symbolCode: 'clearsky_day',
        weatherCode: 0,
        windSpeed: 3,
        windDirection: 90,
        windGust: 4,
      }],
      blocks: [],
      weatherExpires: '2026-08-25T11:00:00.000Z',
      weatherLastModified: 'Tue, 25 Aug 2026 10:00:00 GMT',
      fallback: false,
      providerContacted: true,
    },
    water,
    wave: {
      series: [{ time, timeMs, waveHeight: 0.2, wavePeriod: 3, waveDirection: 90 }],
      instance: { collection: 'wam_nsb', id: RUN_ID },
      fallback: false,
      providerContacted: true,
    },
    warnings: [],
  }, NOW_MS);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW_MS);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('provider-declared marine run completeness', () => {
  it('constructs complete coverage from the real catalogue parser and keeps assembly healthy', async () => {
    const time = '2026-08-25T10:00:00.000Z';
    const timeMs = Date.parse(time);
    const built = await constructStoredEnvelope(
      [{ time, timeMs, tideLevel: 0.2 }],
      '2026-08-25T10:00:00Z',
    );

    expect(built.envelope).toMatchObject({
      seriesEndMs: timeMs,
      declaredEndMs: timeMs,
    });
    expect(built.marineResult.fallback).toBe(false);
    expect(assembleWithWater(built.marineResult, time).degradedSources)
      .not.toContain('water');
    const held = heldMarineFallback(
      built.envelope,
      undefined,
      undefined,
      built.instance,
      { providerContacted: false, degraded: true, busy: true },
      NOW_MS,
    );
    expect(held?.sameCollectionAsRequested).toBe(true);
    expect(assembleWithWater(held!, time).degradedSources).not.toContain('water');

    const extendedEndMs = Date.parse('2026-08-25T12:00:00Z');
    const extendedSeries = [{
      time: '2026-08-25T12:00:00.000Z',
      timeMs: extendedEndMs,
      tideLevel: 0.3,
    }];
    const refetch = vi.fn(async () => Response.json({ features: extendedSeries }));
    vi.mocked(globalThis.fetch).mockImplementation(refetch);
    await fetchMarineSeriesWithFallback(
      built.env,
      LOCATION,
      'water',
      { ...built.instance, declaredEndMs: extendedEndMs },
      ['waterlevel'],
      (features) => features as typeof extendedSeries,
    );
    expect(refetch).toHaveBeenCalledOnce();
  });

  it('records and discloses a partial run instead of blessing it as complete', async () => {
    const time = '2026-08-25T08:00:00.000Z';
    const timeMs = Date.parse(time);
    const declaredEndMs = Date.parse('2026-08-25T10:00:00Z');
    const built = await constructStoredEnvelope(
      [{ time, timeMs, tideLevel: 0.2 }],
      '2026-08-25T10:00:00Z',
    );

    const held = heldMarineFallback(
      built.envelope,
      undefined,
      undefined,
      built.instance,
      { providerContacted: false, degraded: true, busy: false },
      NOW_MS,
    );
    expect(built.envelope).toMatchObject({ seriesEndMs: timeMs, declaredEndMs });
    expect(built.marineResult).toMatchObject({
      fallback: true,
      degraded: true,
      sameCollectionAsRequested: false,
    });
    expect(held?.sameCollectionAsRequested).toBe(false);
    const assembled = assembleWithWater(built.marineResult, time);
    expect(assembled.degradedSources).toContain('water');
    expect(getCacheStatusView({
      refreshing: false,
      cacheHealth: { status: 'current', degradedSources: assembled.degradedSources },
      forecastAtLabel: '08:00',
    }).degradedSourceDisclosure).toContain('water from an earlier update');

    const coverageLog = vi.mocked(console.log).mock.calls
      .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
      .find((line) => line.event === 'kv_write' && line.category === 'raw-marine');
    expect(coverageLog).toEqual(expect.objectContaining({
      locationId: LOCATION.id,
      marineKind: 'water',
      seriesPointCount: 1,
      seriesEndMs: timeMs,
      declaredEndMs,
      coverageStatus: 'partial',
      coverageGapMs: declaredEndMs - timeMs,
    }));
    expect(built.puts).toHaveLength(1);

    const callsBeforeRepeat = vi.mocked(globalThis.fetch).mock.calls.length;
    const repeated = await fetchMarineSeriesWithFallback(
      built.env,
      LOCATION,
      'water',
      built.instance,
      ['waterlevel'],
      (features) => features as Array<{
        time: string;
        timeMs: number;
        tideLevel: number;
      }>,
    );
    expect(repeated).toMatchObject({ fallback: true, degraded: true });
    expect(vi.mocked(globalThis.fetch).mock.calls).toHaveLength(callsBeforeRepeat + 1);
    expect(built.puts).toHaveLength(1);

    const completeTime = '2026-08-25T10:00:00.000Z';
    const completeSeries = [{
      time: completeTime,
      timeMs: declaredEndMs,
      tideLevel: 0.25,
    }];
    const refetch = vi.fn(async () => Response.json({ features: completeSeries }));
    vi.mocked(globalThis.fetch).mockImplementation(refetch);
    await fetchMarineSeriesWithFallback(
      built.env,
      LOCATION,
      'water',
      built.instance,
      ['waterlevel'],
      (features) => features as typeof completeSeries,
    );
    expect(refetch).toHaveBeenCalledOnce();
    expect(JSON.parse(built.values.get(marineIngredientKey(LOCATION, 'water'))!))
      .toMatchObject({
        seriesEndMs: declaredEndMs,
        declaredEndMs,
      });
    expect(built.puts).toHaveLength(2);
  });

  it('treats missing catalogue extent as unknown and never fabricates completeness', async () => {
    const time = '2026-08-25T10:00:00.000Z';
    const built = await constructStoredEnvelope(
      [{ time, timeMs: Date.parse(time), tideLevel: 0.2 }],
      null,
    );
    const held = heldMarineFallback(
      built.envelope,
      undefined,
      undefined,
      built.instance,
      { providerContacted: false, degraded: true, busy: false },
      NOW_MS,
    );

    expect(built.envelope.declaredEndMs).toBeNull();
    expect(built.marineResult).toMatchObject({
      fallback: true,
      degraded: true,
      sameCollectionAsRequested: false,
    });
    expect(held?.sameCollectionAsRequested).toBe(false);
    const coverageLog = vi.mocked(console.log).mock.calls
      .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
      .find((line) => line.event === 'kv_write' && line.category === 'raw-marine');
    expect(coverageLog?.coverageStatus).toBe('unknown');
  });
});
