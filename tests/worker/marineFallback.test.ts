import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  fetchMarineSeriesWithFallback,
  deriveMarineSeedsFromPayload,
  degradedSourcesAfterProbe,
  isMarineRunWithinFallbackAge,
  marineProbeDecision,
  shouldCheckInBackground,
} from '../../worker/index';
import { MARINE_INGREDIENT_CACHE_SCHEMA_VERSION } from '../../src/features/forecast/releaseContract';
import { marineIngredientKey } from '../../worker/generation';

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

const LOCATION = {
  id: 'test',
  forecastConfigRevision: 1,
  areaName: 'Test Fjord',
  coordinate: { longitude: 9.9, latitude: 55.8 },
};
const WATER_INSTANCE = { collection: 'dkss_idw', id: '2026-07-11T120000Z' };
const identityMap = (features: unknown) => features as Array<{ timeMs: number }>;
const CURRENT_INGREDIENT_KEY = marineIngredientKey(LOCATION, 'water');
const retainedEnvelope = (id: string, series: unknown[]) => ({
  schemaVersion: MARINE_INGREDIENT_CACHE_SCHEMA_VERSION,
  locationId: LOCATION.id,
  forecastConfigRevision: LOCATION.forecastConfigRevision,
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
      schemaVersion: MARINE_INGREDIENT_CACHE_SCHEMA_VERSION,
      locationId: LOCATION.id,
      forecastConfigRevision: LOCATION.forecastConfigRevision,
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

  it('lets in-flight marine calls settle but starts no retries after a 429', async () => {
    const env = makeEnv();
    const eventMemo = new Map<string, Promise<unknown>>();
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      return url.includes('/collections/dkss_')
        ? new Response('Server is busy', { status: 429 })
        : new Response('Temporary upstream failure', { status: 503 });
    }) as typeof fetch;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const resultsPromise = Promise.allSettled([
      fetchMarineSeriesWithFallback(
        env,
        LOCATION,
        'water',
        WATER_INSTANCE,
        ['x'],
        identityMap,
        undefined,
        undefined,
        { maxAttempts: 3, retryDelayMs: 1, retryBusyDelayMs: 1 },
        eventMemo,
      ),
      fetchMarineSeriesWithFallback(
        env,
        LOCATION,
        'waves',
        { collection: 'wam_nsb', id: WATER_INSTANCE.id },
        ['x'],
        identityMap,
        undefined,
        undefined,
        { maxAttempts: 3, retryDelayMs: 1, retryBusyDelayMs: 1 },
        eventMemo,
      ),
    ]);

    await vi.runAllTimersAsync();
    const results = await resultsPromise;
    expect(results.every(({ status }) => status === 'rejected')).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('never reuses a retained ingredient stamped for another config revision', async () => {
    const retained = [{
      time: '2026-07-11T12:00:00Z',
      timeMs: Date.parse('2026-07-11T12:00:00Z'),
      tideLevel: 999,
    }];
    const fresh = [{
      time: '2026-07-11T12:00:00Z',
      timeMs: Date.parse('2026-07-11T12:00:00Z'),
      tideLevel: 0.4,
    }];
    const mismatchedEnvelope = {
      ...retainedEnvelope('2026-07-11T120000Z', retained),
      forecastConfigRevision: LOCATION.forecastConfigRevision + 1,
    };
    const env = makeEnv({ [CURRENT_INGREDIENT_KEY]: mismatchedEnvelope });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ features: fresh }),
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await fetchMarineSeriesWithFallback(
      env,
      LOCATION,
      'water',
      WATER_INSTANCE,
      ['x'],
      identityMap,
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.series).toEqual(fresh);
    expect(JSON.parse(env.store.get(CURRENT_INGREDIENT_KEY)!)).toMatchObject({
      locationId: LOCATION.id,
      forecastConfigRevision: LOCATION.forecastConfigRevision,
      series: fresh,
    });
  });

  it('never re-blesses a normalized ingredient written by an older cache schema', async () => {
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
      schemaVersion: MARINE_INGREDIENT_CACHE_SCHEMA_VERSION,
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
    ).rejects.toMatchObject({
      name: 'ProviderUnavailableError',
      provider: 'marine',
      busy: true,
    });
  });

  it('never relabels a mapper TypeError as transient provider availability', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      features: [{ time: '2026-07-11T13:00:00Z' }],
    }), { status: 200 })) as typeof fetch;

    await expect(fetchMarineSeriesWithFallback(
      makeEnv(),
      LOCATION,
      'water',
      WATER_INSTANCE,
      ['x'],
      () => {
        throw new TypeError('mapper implementation failed');
      },
    )).rejects.toMatchObject({
      name: 'TypeError',
      message: 'mapper implementation failed',
    });
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
    )).rejects.toMatchObject({
      name: 'ProviderUnavailableError',
      provider: 'marine',
      busy: true,
    });
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
    )).rejects.toMatchObject({
      name: 'ProviderUnavailableError',
      provider: 'marine',
      busy: false,
    });
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

describe('marineProbeDecision (DMI publication schedule)', () => {
  const sharedRun = {
    water: { collection: 'dkss_idw', id: '2026-07-11T120000Z' },
    waves: { collection: 'wam_nsb', id: '2026-07-11T120000Z' },
  };
  const expectedSharedRunAt = Date.parse('2026-07-11T21:30:00Z');

  it('waits for the slower collection when water and waves share a run', () => {
    expect(marineProbeDecision(
      sharedRun,
      undefined,
      expectedSharedRunAt - 1,
    )).toEqual({
      shouldProbe: false,
      nextProbeAtMs: expectedSharedRunAt,
      reason: 'publication-window',
    });
    expect(marineProbeDecision(sharedRun, undefined, expectedSharedRunAt).shouldProbe).toBe(true);
  });

  it('uses the other WAM completion delay when that is the slower shared-run source', () => {
    const wamOnly = {
      water: { collection: 'wam_nsb', id: '2026-07-11T120000Z' },
      waves: { collection: 'wam_dw', id: '2026-07-11T120000Z' },
    };
    expect(marineProbeDecision(
      wamOnly,
      undefined,
      Date.parse('2026-07-11T21:09:59.999Z'),
    ).nextProbeAtMs).toBe(Date.parse('2026-07-11T21:10:00Z'));
  });

  it('schedules from whichever held ingredient is on the older run', () => {
    const waterLags = {
      water: { collection: 'dkss_idw', id: '2026-07-11T120000Z' },
      waves: { collection: 'wam_nsb', id: '2026-07-11T180000Z' },
    };
    expect(marineProbeDecision(
      waterLags,
      undefined,
      Date.parse('2026-07-11T21:29:59.999Z'),
    ).nextProbeAtMs).toBe(Date.parse('2026-07-11T21:30:00Z'));

    const wavesLag = {
      water: { collection: 'dkss_idw', id: '2026-07-11T180000Z' },
      waves: { collection: 'wam_nsb', id: '2026-07-11T120000Z' },
    };
    expect(marineProbeDecision(
      wavesLag,
      undefined,
      Date.parse('2026-07-11T20:54:59.999Z'),
    ).nextProbeAtMs).toBe(Date.parse('2026-07-11T20:55:00Z'));
  });

  it('backs off for 20 minutes after a due check returned no newer run', () => {
    const attemptedAt = Date.parse('2026-07-11T21:31:00Z');
    expect(marineProbeDecision(
      sharedRun,
      new Date(attemptedAt).toISOString(),
      Date.parse('2026-07-11T21:40:00Z'),
    )).toEqual({
      shouldProbe: false,
      nextProbeAtMs: Date.parse('2026-07-11T21:51:00Z'),
      reason: 'retry-backoff',
    });
    expect(marineProbeDecision(
      sharedRun,
      new Date(attemptedAt).toISOString(),
      Date.parse('2026-07-11T21:51:00Z'),
    ).shouldProbe).toBe(true);
  });

  it('does not mistake pre-window or future stamps for a completed due probe', () => {
    expect(marineProbeDecision(
      sharedRun,
      '2026-07-11T21:29:59Z',
      expectedSharedRunAt,
    ).shouldProbe).toBe(true);
    expect(marineProbeDecision(
      sharedRun,
      '2026-07-12T00:00:00Z',
      expectedSharedRunAt,
    ).shouldProbe).toBe(true);
  });

  it('always probes missing, invalid, future, unknown, and over-12-hour provenance', () => {
    const now = Date.parse('2026-07-12T00:00:00.001Z');
    const cases = [
      undefined,
      { water: sharedRun.water },
      { water: { collection: 'dkss_idw', id: 'garbage' }, waves: sharedRun.waves },
      { water: { collection: 'unknown', id: '2026-07-11T180000Z' }, waves: sharedRun.waves },
      { water: { collection: 'dkss_idw', id: '2026-07-12T000001Z' }, waves: sharedRun.waves },
      sharedRun,
    ];
    for (const instances of cases) {
      expect(marineProbeDecision(
        instances,
        '2026-07-12T00:00:00Z',
        now,
      ).shouldProbe).toBe(true);
    }
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
