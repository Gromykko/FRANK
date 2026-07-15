import { describe, it, expect, afterEach } from 'vitest';
// @ts-expect-error - the worker is plain JS with no type declarations
import { fetchMarineSeriesWithFallback, deriveMarineSeedsFromPayload, classifyBuildFailure, marineRunAgeMs } from '../../worker/index.js';

// An in-memory stand-in for the KV binding (get(key,'json') / put(key,string)).
function makeEnv(seed: Record<string, unknown> = {}) {
  const store = new Map<string, string>();
  for (const [k, v] of Object.entries(seed)) store.set(k, JSON.stringify(v));
  return {
    store,
    FRANK_FORECAST_CACHE: {
      get: async (key: string, type?: string) => {
        const raw = store.get(key);
        if (raw == null) return null;
        return type === 'json' ? JSON.parse(raw) : raw;
      },
      put: async (key: string, value: string) => { store.set(key, value); },
    },
  };
}

const LOCATION = { id: 'test', areaName: 'Test Fjord', coordinate: { longitude: 9.9, latitude: 55.8 } };
const WATER_INSTANCE = { collection: 'dkss_idw', id: '2026-07-11T120000Z' };
const identityMap = (features: unknown) => features as Array<{ timeMs: number }>;

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

// 429 is terminal (no retry), so a busy provider fails fast.
function stubFetchBusy() {
  globalThis.fetch = (async () => ({ ok: false, status: 429, text: async () => 'Server is busy' })) as typeof fetch;
}

describe('fetchMarineSeriesWithFallback (split retention)', () => {
  it('stores the series and reports no fallback on a successful fetch', async () => {
    const series = [{ time: '2026-07-11T12:00:00Z', timeMs: Date.parse('2026-07-11T12:00:00Z'), tideLevel: 0.1 }];
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ features: series }) })) as typeof fetch;
    const env = makeEnv();

    const result = await fetchMarineSeriesWithFallback(env, LOCATION, 'water', WATER_INSTANCE, ['x'], identityMap);

    expect(result.fallback).toBe(false);
    expect(result.series).toEqual(series);
    // Retained for the next outage, tagged with the run it came from.
    expect(JSON.parse(env.store.get('frank-marine-ingredient:water:test')!)).toMatchObject({ collection: 'dkss_idw', id: '2026-07-11T120000Z' });
  });

  it('reuses the retained run WITHOUT a network call when the run id is unchanged', async () => {
    const retained = [{ time: '2026-07-11T12:00:00Z', timeMs: Date.parse('2026-07-11T12:00:00Z'), tideLevel: 0.5 }];
    const env = makeEnv({ 'frank-marine-ingredient:water:test': { collection: 'dkss_idw', id: '2026-07-11T120000Z', series: retained } });
    let fetched = false;
    globalThis.fetch = (async () => { fetched = true; throw new Error('should not fetch'); }) as typeof fetch;

    // Requested instance id === retained id → no fetch, not a fallback.
    const result = await fetchMarineSeriesWithFallback(env, LOCATION, 'water', WATER_INSTANCE, ['x'], identityMap);

    expect(fetched).toBe(false);
    expect(result.fallback).toBe(false);
    expect(result.series).toEqual(retained);
  });

  it('serves the retained ingredient (its own older run id) when the provider is busy - DEGRADED', async () => {
    stubFetchBusy();
    const retained = [{ time: '2026-07-11T06:00:00Z', timeMs: Date.parse('2026-07-11T06:00:00Z'), tideLevel: 0.2 }];
    const env = makeEnv({ 'frank-marine-ingredient:water:test': { collection: 'dkss_idw', id: '2026-07-11T060000Z', series: retained } });

    const result = await fetchMarineSeriesWithFallback(env, LOCATION, 'water', WATER_INSTANCE, ['x'], identityMap);

    expect(result.fallback).toBe(true);
    expect(result.degraded).toBe(true); // 429 = a real failure to refresh
    expect(result.busy).toBe(true);
    expect(result.series).toEqual(retained);
    expect(result.instance).toEqual({ collection: 'dkss_idw', id: '2026-07-11T060000Z' });
  });

  it('a newly-listed run that returns EMPTY is NOT degraded - the held run is still latest (stays green)', async () => {
    // 200 OK but no features for the requested (new) run = not published yet.
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ features: [] }) })) as typeof fetch;
    const retained = [{ time: '2026-07-11T06:00:00Z', timeMs: Date.parse('2026-07-11T06:00:00Z'), tideLevel: 0.2 }];
    const env = makeEnv({ 'frank-marine-ingredient:water:test': { collection: 'dkss_idw', id: '2026-07-11T060000Z', series: retained } });

    const result = await fetchMarineSeriesWithFallback(env, LOCATION, 'water', WATER_INSTANCE, ['x'], identityMap);

    expect(result.fallback).toBe(true);
    expect(result.notReady).toBe(true);
    expect(result.degraded).toBeUndefined(); // not degradation -> no amber
    expect(result.series).toEqual(retained);
  });

  it('bootstraps from the seed series when busy and nothing is retained yet', async () => {
    stubFetchBusy();
    const seed = [{ time: '2026-07-11T09:00:00Z', timeMs: Date.parse('2026-07-11T09:00:00Z'), tideLevel: 0.3 }];

    const result = await fetchMarineSeriesWithFallback(makeEnv(), LOCATION, 'water', WATER_INSTANCE, ['x'], identityMap, seed);

    expect(result.fallback).toBe(true);
    expect(result.series).toEqual(seed);
  });

  it('throws when busy with neither retained nor seed data', async () => {
    stubFetchBusy();
    await expect(
      fetchMarineSeriesWithFallback(makeEnv(), LOCATION, 'water', WATER_INSTANCE, ['x'], identityMap)
    ).rejects.toThrow(/429|busy/i);
  });
});

describe('marineRunAgeMs (probe gate)', () => {
  const now = Date.parse('2026-07-11T18:30:00Z');
  it('measures age from the OLDER of the two runs', () => {
    const inst = { water: { collection: 'dkss_idw', id: '2026-07-11T120000Z' }, waves: { collection: 'wam_nsb', id: '2026-07-11T180000Z' } };
    // older run is 12Z -> 6.5h old at 18:30Z
    expect(marineRunAgeMs(inst, now)).toBe(6.5 * 3600_000);
  });
  it('a run under 5h old gates the probe; a 6h-old run does not', () => {
    const fresh = { water: { id: '2026-07-11T180000Z' }, waves: { id: '2026-07-11T180000Z' } };
    const stale = { water: { id: '2026-07-11T120000Z' }, waves: { id: '2026-07-11T120000Z' } };
    expect(marineRunAgeMs(fresh, now)).toBeLessThan(5 * 3600_000);   // skip probe
    expect(marineRunAgeMs(stale, now)).toBeGreaterThan(5 * 3600_000); // probe
  });
  it('is Infinity (forces a probe) when a run id is missing', () => {
    expect(marineRunAgeMs({ water: { id: '2026-07-11T120000Z' } }, now)).toBe(Infinity);
    expect(marineRunAgeMs(undefined, now)).toBe(Infinity);
  });
});

describe('classifyBuildFailure', () => {
  it('flags a DMI 429 as a busy marine provider', () => {
    expect(classifyBuildFailure('Failed to build forecast: DMI dkss_idw failed: 429 Server is busy'))
      .toEqual({ busy: true, busyProvider: 'marine' });
  });

  it('flags a MET 429 as a busy weather provider', () => {
    expect(classifyBuildFailure('MET Norway weather failed: 429 Too Many Requests'))
      .toEqual({ busy: true, busyProvider: 'weather' });
  });

  it('reports both when weather and marine are named', () => {
    expect(classifyBuildFailure('DMI wam failed: 429, MET locationforecast failed: 429').busyProvider).toBe('services');
  });

  it('is not busy for a non-429 error', () => {
    expect(classifyBuildFailure('DMI dkss_idw failed: 500 Internal Server Error').busy).toBe(false);
  });
});

describe('deriveMarineSeedsFromPayload', () => {
  it('reconstructs water and wave series from hourly rows, excluding block rows', () => {
    const cached = {
      hourly: [
        { time: '2026-07-11T12:00:00Z', tempWater: 18.1, tideLevel: 0.4, currentSpeed: 0.2, currentDirection: 90, waveHeight: 0.12, waveDirection: 200, wavePeriod: 3 },
        { time: '2026-07-11T13:00:00Z', tempWater: 18.2, tideLevel: 0.3, currentSpeed: 0.1, currentDirection: 95, waveHeight: 0.14, waveDirection: 210, wavePeriod: 3.1 },
        { time: '2026-07-13T14:00:00Z', blockSpanHours: 6, tempWater: 19, tideLevel: 0, waveHeight: 0.2 },
      ],
    };

    const seeds = deriveMarineSeedsFromPayload(cached);

    expect(seeds!.water).toHaveLength(2);
    expect(seeds!.waves).toHaveLength(2);
    // Field shape must match mapWaterFeatures/mapWaveFeatures output exactly
    expect(seeds!.water[0]).toEqual({ time: '2026-07-11T12:00:00Z', timeMs: Date.parse('2026-07-11T12:00:00Z'), tempWater: 18.1, tideLevel: 0.4, currentSpeed: 0.2, currentDirection: 90 });
    expect(seeds!.waves[1]).toEqual({ time: '2026-07-11T13:00:00Z', timeMs: Date.parse('2026-07-11T13:00:00Z'), waveHeight: 0.14, waveDirection: 210, wavePeriod: 3.1 });
  });

  it('returns null when there are no usable hourly rows', () => {
    expect(deriveMarineSeedsFromPayload({ hourly: [{ time: '2026-07-11T14:00:00Z', blockSpanHours: 6 }] })).toBeNull();
    expect(deriveMarineSeedsFromPayload({})).toBeNull();
    expect(deriveMarineSeedsFromPayload(null)).toBeNull();
  });
});
