import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// @ts-expect-error - the worker is plain JS with no type declarations
import {
  fetchMarineSeriesWithFallback,
  deriveMarineSeedsFromPayload,
  classifyBuildFailure,
  degradedSourcesAfterProbe,
  isMarineRunWithinFallbackAge,
  marineRunAgeMs,
  shouldCheckInBackground,
} from '../../worker/index.js';
import { FORECAST_PAYLOAD_VERSION } from '../../src/features/forecast/types';

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
const CURRENT_INGREDIENT_KEY = `frank-marine-ingredient:v${FORECAST_PAYLOAD_VERSION}:water:test`;
const retainedEnvelope = (id: string, series: unknown[]) => ({
  schemaVersion: FORECAST_PAYLOAD_VERSION,
  collection: 'dkss_idw',
  id,
  series,
});

const originalFetch = globalThis.fetch;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime('2026-07-11T13:00:00Z');
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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
    expect(JSON.parse(env.store.get(CURRENT_INGREDIENT_KEY)!)).toMatchObject({
      schemaVersion: FORECAST_PAYLOAD_VERSION,
      collection: 'dkss_idw',
      id: '2026-07-11T120000Z',
    });
  });

  it('reuses the retained run WITHOUT a network call when the run id is unchanged', async () => {
    const retained = [{ time: '2026-07-11T12:00:00Z', timeMs: Date.parse('2026-07-11T12:00:00Z'), tideLevel: 0.5 }];
    const env = makeEnv({ [CURRENT_INGREDIENT_KEY]: retainedEnvelope('2026-07-11T120000Z', retained) });
    let fetched = false;
    globalThis.fetch = (async () => { fetched = true; throw new Error('should not fetch'); }) as typeof fetch;

    // Requested instance id === retained id → no fetch, not a fallback.
    const result = await fetchMarineSeriesWithFallback(env, LOCATION, 'water', WATER_INSTANCE, ['x'], identityMap);

    expect(fetched).toBe(false);
    expect(result.fallback).toBe(false);
    expect(result.series).toEqual(retained);
  });

  it('never re-blesses a normalized ingredient written by an older payload version', async () => {
    const legacy = [{ time: '2026-07-11T12:00:00Z', timeMs: Date.parse('2026-07-11T12:00:00Z'), tideLevel: 999 }];
    const fresh = [{ time: '2026-07-11T12:00:00Z', timeMs: Date.parse('2026-07-11T12:00:00Z'), tideLevel: 0.4 }];
    const env = makeEnv({
      'frank-marine-ingredient:water:test': {
        collection: 'dkss_idw',
        id: '2026-07-11T120000Z',
        series: legacy,
      },
    });
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      return { ok: true, status: 200, json: async () => ({ features: fresh }) };
    }) as typeof fetch;

    const result = await fetchMarineSeriesWithFallback(env, LOCATION, 'water', WATER_INSTANCE, ['x'], identityMap);

    expect(fetches).toBe(1);
    expect(result.series).toEqual(fresh);
    expect(JSON.parse(env.store.get(CURRENT_INGREDIENT_KEY)!)).toMatchObject({
      schemaVersion: FORECAST_PAYLOAD_VERSION,
      series: fresh,
    });
  });

  it('serves the retained ingredient (its own older run id) when the provider is busy - DEGRADED', async () => {
    stubFetchBusy();
    const retained = [{ time: '2026-07-11T06:00:00Z', timeMs: Date.parse('2026-07-11T06:00:00Z'), tideLevel: 0.2 }];
    const env = makeEnv({ [CURRENT_INGREDIENT_KEY]: retainedEnvelope('2026-07-11T060000Z', retained) });

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
    const env = makeEnv({ [CURRENT_INGREDIENT_KEY]: retainedEnvelope('2026-07-11T060000Z', retained) });

    const result = await fetchMarineSeriesWithFallback(env, LOCATION, 'water', WATER_INSTANCE, ['x'], identityMap);

    expect(result.fallback).toBe(true);
    expect(result.notReady).toBe(true);
    expect(result.degraded).toBeUndefined(); // not degradation -> no amber
    expect(result.series).toEqual(retained);
  });

  it('bootstraps from the seed series when busy and nothing is retained yet', async () => {
    stubFetchBusy();
    const seed = [{ time: '2026-07-11T09:00:00Z', timeMs: Date.parse('2026-07-11T09:00:00Z'), tideLevel: 0.3 }];

    const result = await fetchMarineSeriesWithFallback(
      makeEnv(),
      LOCATION,
      'water',
      WATER_INSTANCE,
      ['x'],
      identityMap,
      seed,
      WATER_INSTANCE,
    );

    expect(result.fallback).toBe(true);
    expect(result.series).toEqual(seed);
  });

  it('throws when busy with neither retained nor seed data', async () => {
    stubFetchBusy();
    await expect(
      fetchMarineSeriesWithFallback(makeEnv(), LOCATION, 'water', WATER_INSTANCE, ['x'], identityMap)
    ).rejects.toThrow(/429|busy/i);
  });

  it('does not use retained or seeded marine runs older than two publication cycles', async () => {
    stubFetchBusy();
    const oldId = '2026-07-10T180000Z'; // 19h old at the fixed 13:00 clock
    const oldSeries = [{ time: '2026-07-10T18:00:00Z', timeMs: Date.parse('2026-07-10T18:00:00Z'), tideLevel: 0.9 }];
    const env = makeEnv({ [CURRENT_INGREDIENT_KEY]: retainedEnvelope(oldId, oldSeries) });

    await expect(fetchMarineSeriesWithFallback(
      env,
      LOCATION,
      'water',
      WATER_INSTANCE,
      ['x'],
      identityMap,
      oldSeries,
      { collection: 'dkss_idw', id: oldId },
    )).rejects.toThrow(/429|busy/i);
  });

  it('refuses an old or unparseable requested run before cache or network work begins', async () => {
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      throw new Error('must not fetch');
    }) as typeof fetch;

    await expect(fetchMarineSeriesWithFallback(
      makeEnv(),
      LOCATION,
      'water',
      { collection: 'dkss_idw', id: '2026-07-10T180000Z' },
      ['x'],
      identityMap,
    )).rejects.toThrow(/12-hour marine safety limit/i);
    await expect(fetchMarineSeriesWithFallback(
      makeEnv(),
      LOCATION,
      'water',
      { collection: 'dkss_idw', id: 'not-a-dmi-run' },
      ['x'],
      identityMap,
    )).rejects.toThrow(/12-hour marine safety limit/i);
    expect(fetched).toBe(false);
  });

  it('rechecks the 12-hour boundary after an in-flight provider response', async () => {
    const exactBoundary = Date.parse('2026-07-11T18:00:00Z');
    vi.setSystemTime(exactBoundary);
    const boundaryRun = { collection: 'dkss_idw', id: '2026-07-11T060000Z' };
    globalThis.fetch = (async () => {
      // The run was exactly 12h old when the request began, but became unsafe
      // while the provider call was in flight. A 200 must not re-date it.
      vi.setSystemTime(exactBoundary + 1);
      return { ok: true, status: 200, json: async () => ({ features: [{ timeMs: exactBoundary }] }) };
    }) as typeof fetch;

    await expect(fetchMarineSeriesWithFallback(
      makeEnv(),
      LOCATION,
      'water',
      boundaryRun,
      ['x'],
      identityMap,
    )).rejects.toThrow(/12-hour marine safety limit/i);
  });
});

describe('isMarineRunWithinFallbackAge (12-hour safety boundary)', () => {
  const run = { collection: 'dkss_idw', id: '2026-07-11T060000Z' };
  const exactBoundary = Date.parse('2026-07-11T18:00:00Z');

  it('allows exactly two missed six-hour cycles, inclusively', () => {
    expect(isMarineRunWithinFallbackAge(run, exactBoundary)).toBe(true);
  });

  it('rejects the first millisecond past the boundary', () => {
    expect(isMarineRunWithinFallbackAge(run, exactBoundary + 1)).toBe(false);
  });

  it('rejects unparseable and future-dated provenance', () => {
    expect(isMarineRunWithinFallbackAge({ id: 'garbage' }, exactBoundary)).toBe(false);
    expect(isMarineRunWithinFallbackAge({ id: '2026-07-11T180001Z' }, exactBoundary)).toBe(false);
    expect(isMarineRunWithinFallbackAge(undefined, exactBoundary)).toBe(false);
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

describe('degradedSourcesAfterProbe', () => {
  it('marks both marine ingredients degraded when the run catalogue could not be checked', () => {
    expect(degradedSourcesAfterProbe([], true)).toEqual(['water', 'waves']);
    expect(degradedSourcesAfterProbe(['weather', 'waves'], true)).toEqual(['weather', 'waves', 'water']);
  });

  it('leaves a successful probe\'s source state unchanged', () => {
    expect(degradedSourcesAfterProbe(['weather'], false)).toEqual(['weather']);
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

// ---------------------------------------------------------------------------
// The gate that decides whether the Worker contacts upstream at all. It reads
// both the persisted stamp and an in-memory "when did THIS isolate last check"
// clock. Stamping that clock BEFORE the gate read it (in the caller, rather
// than after the gate passed) made every call see "checked 0 ms ago" and
// short-circuit — the 10-minute cron silently became a no-op and nothing
// rebuilt for as long as the isolate lived. Caught in production after 11 hours
// of a frozen forecast.
// ---------------------------------------------------------------------------
describe('shouldCheckInBackground', () => {
  const loc = { id: 'horsens' } as never;
  const TEN_MIN = 10 * 60 * 1000;
  const withStamp = (msAgo: number) => ({
    sources: { cacheHealth: { lastAttemptAt: new Date(Date.now() - msAgo).toISOString() } },
  }) as never;

  it('checks when the last check is older than the interval', () => {
    expect(shouldCheckInBackground(loc, withStamp(30 * 60 * 1000), TEN_MIN, 0)).toBe(true);
  });

  it('skips when a check just happened', () => {
    expect(shouldCheckInBackground(loc, withStamp(60 * 1000), TEN_MIN, 0)).toBe(false);
  });

  it('a fresh memory clock suppresses the check even against an ancient stamp', () => {
    // This IS the gate's contract, and it is also why the caller's placement
    // matters so much: recording the check before the gate reads it hands the
    // gate a memory clock of `now` on every call, so this correct behaviour
    // becomes a permanent short-circuit. The outage was the placement, not this
    // rule — the rule is what makes the placement load-bearing.
    expect(shouldCheckInBackground(loc, withStamp(6 * 60 * 60 * 1000), TEN_MIN, Date.now())).toBe(false);
    // Once a correctly-placed clock ages past the interval, checking resumes.
    expect(shouldCheckInBackground(loc, withStamp(6 * 60 * 60 * 1000), TEN_MIN, Date.now() - 11 * 60 * 1000)).toBe(true);
  });

  it('takes whichever of stamp and memory is more recent', () => {
    // Fresh memory, stale stamp -> skip. Stale memory, fresh stamp -> skip.
    expect(shouldCheckInBackground(loc, withStamp(60 * 60 * 1000), TEN_MIN, Date.now() - 60 * 1000)).toBe(false);
    expect(shouldCheckInBackground(loc, withStamp(60 * 1000), TEN_MIN, Date.now() - 60 * 60 * 1000)).toBe(false);
  });

  it('checks when nothing is known at all', () => {
    expect(shouldCheckInBackground(loc, undefined as never, TEN_MIN, 0)).toBe(true);
    expect(shouldCheckInBackground(loc, { sources: { cacheHealth: { lastAttemptAt: 'garbage' } } } as never, TEN_MIN, 0)).toBe(true);
  });
});
