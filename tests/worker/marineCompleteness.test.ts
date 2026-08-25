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
import type { SeriesPoint } from '../../src/features/forecast/types';
import { getCacheStatusView } from '../../src/features/forecast/cacheStatusView';
import { marineIngredientKey } from '../../worker/generation';
import {
  FORECAST_PROVIDER_PARAMETERS,
  assessMarineRunCoverage,
  assembleForecastFromSources,
  dmiForecastUrl,
  marineIngredientHasCompleteCoverage,
  marineRunContract,
} from '../../worker/forecastModel';
import { fetchMarineSeriesWithFallback } from '../../worker/providers';
import { ProviderUnavailableError } from '../../worker/providerAvailability';
import {
  completeMarineEnvelope,
  completeMarineSeries,
} from './marineTestData';

const LOCATION = locationData[0] as ForecastLocation;
const COLLECTION = LOCATION.dmiCollections.water[0];
const OLD_RUN_ID = '2026-08-25T000000Z';
const CANDIDATE_RUN_ID = '2026-08-25T060000Z';
const INSIDE_GRACE_MS = Date.parse('2026-08-25T10:19:59.999Z');
const GRACE_END_MS = Date.parse('2026-08-25T10:20:00.000Z');

function makeEnv(initial?: Record<string, unknown>) {
  const values = new Map<string, string>(
    Object.entries(initial ?? {}).map(([key, value]) => [key, JSON.stringify(value)]),
  );
  const puts: Array<{ key: string; value: string }> = [];
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
          puts.push({ key, value });
          values.set(key, value);
        },
      },
    } as Env,
  };
}

function candidateInstance(declaredEndMs?: number) {
  return {
    collection: COLLECTION,
    id: CANDIDATE_RUN_ID,
    ...(declaredEndMs === undefined ? {} : { declaredEndMs }),
  };
}

async function fetchCandidate(
  store: ReturnType<typeof makeEnv>,
  series: SeriesPoint[],
  sourceFeatures: unknown[] = series,
) {
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
    Response.json({ features: sourceFeatures }),
  );
  return fetchMarineSeriesWithFallback(
    store.env,
    LOCATION,
    'water',
    candidateInstance(),
    [...FORECAST_PROVIDER_PARAMETERS.water],
    () => series,
  );
}

function assembleWithWater(water: Awaited<ReturnType<typeof fetchCandidate>>, nowMs: number) {
  const timeMs = nowMs + 60 * 60 * 1000;
  const time = new Date(timeMs).toISOString();
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
      weatherExpires: new Date(nowMs + 60 * 60 * 1000).toISOString(),
      fallback: false,
      providerContacted: true,
    },
    water,
    wave: {
      series: completeMarineSeries('waves', CANDIDATE_RUN_ID),
      instance: { collection: 'wam_nsb', id: CANDIDATE_RUN_ID },
      fallback: false,
      providerContacted: true,
    },
    warnings: [],
  }, nowMs);
}

function parsedLogs(): Array<Record<string, unknown>> {
  return vi.mocked(console.log).mock.calls.flatMap(([line]) => {
    try {
      const value: unknown = JSON.parse(String(line));
      return value && typeof value === 'object' ? [value as Record<string, unknown>] : [];
    } catch {
      return [];
    }
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(INSIDE_GRACE_MS);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('independent DMI run contract', () => {
  it('pins the official inclusive DKSS and WAM horizons', () => {
    const dkss = marineRunContract('dkss_idw', CANDIDATE_RUN_ID);
    const wam = marineRunContract('wam_nsb', CANDIDATE_RUN_ID);

    expect(dkss).toMatchObject({
      kind: 'water',
      horizonHours: 120,
      expectedPointCount: 121,
      runStartMs: Date.parse('2026-08-25T06:00:00.000Z'),
      expectedEndMs: Date.parse('2026-08-30T06:00:00.000Z'),
    });
    expect(wam).toMatchObject({
      kind: 'waves',
      horizonHours: 132,
      expectedPointCount: 133,
      expectedEndMs: Date.parse('2026-08-30T18:00:00.000Z'),
    });
    expect(marineRunContract('dkss_idw', '2028-02-29T120000Z')).not.toBeNull();
    expect(marineRunContract('dkss_idw', '2026-02-29T120000Z')).toBeNull();
    expect(marineRunContract('dkss_idw', '2026-08-25T050000Z')).toBeNull();
    expect(marineRunContract('future_dkss', CANDIDATE_RUN_ID)).toBeNull();
  });

  it('makes a pinned EDR URL independent of the wall clock and catalogue extent', () => {
    vi.setSystemTime('2026-08-25T07:00:00Z');
    const first = dmiForecastUrl(
      COLLECTION,
      [...FORECAST_PROVIDER_PARAMETERS.water],
      LOCATION,
      CANDIDATE_RUN_ID,
    );
    vi.setSystemTime('2026-08-26T07:00:00Z');
    const second = dmiForecastUrl(
      COLLECTION,
      [...FORECAST_PROVIDER_PARAMETERS.water],
      LOCATION,
      CANDIDATE_RUN_ID,
    );

    expect(second).toBe(first);
    expect(new URL(first).searchParams.get('datetime')).toBe(
      '2026-08-25T06:00:00.000Z/2026-08-30T06:00:00.000Z',
    );
  });
});

describe('exact marine coverage proof', () => {
  it('accepts complete 121/133-point runs without trusting catalogue extent', () => {
    const water = completeMarineSeries('water', CANDIDATE_RUN_ID);
    const waves = completeMarineSeries('waves', CANDIDATE_RUN_ID);

    expect(assessMarineRunCoverage(
      'water',
      candidateInstance(Date.parse('2026-08-25T08:00:00Z')),
      water,
    )?.status).toBe('complete');
    expect(assessMarineRunCoverage(
      'waves',
      { collection: 'wam_nsb', id: CANDIDATE_RUN_ID },
      waves,
    )?.status).toBe('complete');
  });

  it('accepts only an exact valid prefix as publication-pending', () => {
    const full = completeMarineSeries('water', CANDIDATE_RUN_ID);
    expect(assessMarineRunCoverage(
      'water',
      candidateInstance(),
      full.slice(0, 12),
    )).toMatchObject({ status: 'partial', missingPointCount: 109 });

    const missingMiddle = full.filter((_, index) => index !== 40);
    const duplicated = [...full];
    duplicated[40] = duplicated[39];
    const offGrid = [...full];
    offGrid[40] = {
      ...offGrid[40],
      time: '2026-08-26T22:30:00.000Z',
      timeMs: Date.parse('2026-08-26T22:30:00.000Z'),
    };
    const extra = [
      ...full,
      {
        ...full.at(-1)!,
        time: '2026-08-30T07:00:00.000Z',
        timeMs: Date.parse('2026-08-30T07:00:00.000Z'),
      },
    ];
    const mismatchedTime = [...full];
    mismatchedTime[5] = { ...mismatchedTime[5], time: '2026-02-30T110000Z' };

    for (const candidate of [missingMiddle, duplicated, offGrid, extra, mismatchedTime]) {
      expect(assessMarineRunCoverage('water', candidateInstance(), candidate)?.status)
        .toBe('invalid');
    }
    expect(assessMarineRunCoverage('water', candidateInstance(), full, full.length + 1)?.status)
      .toBe('invalid');
  });

  it('requires every safety reading, permits zero, and leaves display-only fields optional', () => {
    const water = completeMarineSeries('water', CANDIDATE_RUN_ID)
      .map((point) => ({ ...point, currentSpeed: undefined, currentDirection: undefined }));
    water[0] = { ...water[0], tideLevel: 0, tempWater: 0 };
    expect(assessMarineRunCoverage('water', candidateInstance(), water)?.status)
      .toBe('complete');

    for (const field of ['tideLevel', 'tempWater'] as const) {
      const missing = water.map((point) => ({ ...point }));
      missing[10][field] = undefined;
      expect(assessMarineRunCoverage('water', candidateInstance(), missing)?.status)
        .toBe('invalid');
    }

    const waves = completeMarineSeries('waves', CANDIDATE_RUN_ID)
      .map((point) => ({ ...point, wavePeriod: undefined, waveDirection: undefined }));
    waves[0] = { ...waves[0], waveHeight: 0 };
    expect(assessMarineRunCoverage(
      'waves',
      { collection: 'wam_nsb', id: CANDIDATE_RUN_ID },
      waves,
    )?.status).toBe('complete');
    waves[10] = { ...waves[10], waveHeight: undefined };
    expect(assessMarineRunCoverage(
      'waves',
      { collection: 'wam_nsb', id: CANDIDATE_RUN_ID },
      waves,
    )?.status).toBe('invalid');
  });

  it('recomputes retained proof instead of trusting stored boundary stamps', () => {
    const envelope = completeMarineEnvelope(LOCATION, 'water', OLD_RUN_ID);
    envelope.series.splice(40, 1);
    envelope.series.push({ ...envelope.series.at(-1)! });
    expect(marineIngredientHasCompleteCoverage(envelope)).toBe(false);
  });

  it('rejects malformed current-schema KV without throwing during coverage validation', async () => {
    const key = marineIngredientKey(LOCATION, 'water');
    const corrupt = {
      ...completeMarineEnvelope(LOCATION, 'water', OLD_RUN_ID),
      series: [{}],
    };
    const store = makeEnv({ [key]: corrupt });
    const complete = completeMarineSeries('water', CANDIDATE_RUN_ID);

    await expect(fetchCandidate(store, complete)).resolves.toMatchObject({
      fallback: false,
      instance: { id: CANDIDATE_RUN_ID },
    });
    expect(store.puts).toHaveLength(1);
  });
});

describe('atomic DMI handover', () => {
  it('never fetches or stores an older run over a newer complete raw ingredient', async () => {
    const key = marineIngredientKey(LOCATION, 'water');
    const retained = completeMarineEnvelope(LOCATION, 'water', CANDIDATE_RUN_ID);
    const store = makeEnv({ [key]: retained });
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    vi.spyOn(console, 'warn').mockImplementationOnce(() => {
      throw new Error('logging unavailable');
    });

    const result = await fetchMarineSeriesWithFallback(
      store.env,
      LOCATION,
      'water',
      { collection: COLLECTION, id: OLD_RUN_ID },
      [...FORECAST_PROVIDER_PARAMETERS.water],
      () => completeMarineSeries('water', OLD_RUN_ID),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      fallback: false,
      providerContacted: false,
      instance: { collection: COLLECTION, id: CANDIDATE_RUN_ID },
    });
    expect(store.puts).toHaveLength(0);
    expect(JSON.parse(store.values.get(key)!)).toMatchObject({ id: CANDIDATE_RUN_ID });
  });

  it('discloses a newer sibling-collection raw run while refusing to overwrite it', async () => {
    const key = marineIngredientKey(LOCATION, 'water');
    const retained = completeMarineEnvelope(
      LOCATION,
      'water',
      CANDIDATE_RUN_ID,
      'dkss_nsbs',
    );
    const store = makeEnv({ [key]: retained });
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    const result = await fetchMarineSeriesWithFallback(
      store.env,
      LOCATION,
      'water',
      { collection: COLLECTION, id: OLD_RUN_ID },
      [...FORECAST_PROVIDER_PARAMETERS.water],
      () => completeMarineSeries('water', OLD_RUN_ID),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      fallback: true,
      degraded: true,
      sameCollectionAsRequested: false,
      providerContacted: false,
      instance: { collection: 'dkss_nsbs', id: CANDIDATE_RUN_ID },
    });
    expect(assembleWithWater(result, INSIDE_GRACE_MS).degradedSources).toContain('water');
    expect(store.puts).toHaveLength(0);
    expect(JSON.parse(store.values.get(key)!)).toMatchObject({
      collection: 'dkss_nsbs',
      id: CANDIDATE_RUN_ID,
    });
  });

  it('keeps a valid partial candidate out of KV and invisible during grace', async () => {
    const key = marineIngredientKey(LOCATION, 'water');
    const retained = completeMarineEnvelope(LOCATION, 'water', OLD_RUN_ID);
    const store = makeEnv({ [key]: retained });
    const originalBytes = store.values.get(key);
    const prefix = completeMarineSeries('water', CANDIDATE_RUN_ID).slice(0, 12);

    const result = await fetchCandidate(store, prefix);

    expect(result).toMatchObject({
      fallback: true,
      providerContacted: true,
      notReady: true,
      instance: { collection: COLLECTION, id: OLD_RUN_ID },
    });
    expect(result).not.toHaveProperty('degraded');
    expect(result.series).toEqual(retained.series);
    expect(store.values.get(key)).toBe(originalBytes);
    expect(store.puts).toHaveLength(0);

    const assembled = assembleWithWater(result, INSIDE_GRACE_MS);
    expect(assembled.degradedSources).not.toContain('water');
    expect(getCacheStatusView({
      refreshing: false,
      cacheHealth: { status: 'current', degradedSources: assembled.degradedSources },
      forecastAtLabel: '10:00',
    }).degradedSourceDisclosure).toBe('');

    expect(parsedLogs()).toContainEqual(expect.objectContaining({
      event: 'marine_coverage_observed',
      status: 'partial',
      expectedPointCount: 121,
      withinPublicationGrace: true,
    }));
    expect(parsedLogs().some((line) => line.event === 'kv_write')).toBe(false);
  });

  it('never hides a sibling-collection substitution during grace', async () => {
    const key = marineIngredientKey(LOCATION, 'water');
    const retained = completeMarineEnvelope(
      LOCATION,
      'water',
      OLD_RUN_ID,
      'dkss_nsbs',
    );
    const store = makeEnv({ [key]: retained });
    const prefix = completeMarineSeries('water', CANDIDATE_RUN_ID).slice(0, 12);

    const result = await fetchCandidate(store, prefix);

    expect(result).toMatchObject({
      fallback: true,
      degraded: true,
      sameCollectionAsRequested: false,
      instance: { collection: 'dkss_nsbs', id: OLD_RUN_ID },
    });
    expect(store.puts).toHaveLength(0);
    expect(assembleWithWater(result, INSIDE_GRACE_MS).degradedSources).toContain('water');
  });

  it('discloses the same partial candidate at the exact grace boundary without storing it', async () => {
    vi.setSystemTime(GRACE_END_MS);
    const key = marineIngredientKey(LOCATION, 'water');
    const retained = completeMarineEnvelope(LOCATION, 'water', OLD_RUN_ID);
    const store = makeEnv({ [key]: retained });
    const prefix = completeMarineSeries('water', CANDIDATE_RUN_ID).slice(0, 12);

    const result = await fetchCandidate(store, prefix);

    expect(result).toMatchObject({ fallback: true, degraded: true });
    expect(result.instance.id).toBe(OLD_RUN_ID);
    expect(store.puts).toHaveLength(0);
    expect(assembleWithWater(result, GRACE_END_MS).degradedSources).toContain('water');
  });

  it('treats an empty candidate like publication lag only until the grace boundary', async () => {
    const key = marineIngredientKey(LOCATION, 'water');
    const retained = completeMarineEnvelope(LOCATION, 'water', OLD_RUN_ID);
    const store = makeEnv({ [key]: retained });

    const pending = await fetchCandidate(store, []);
    expect(pending).toMatchObject({ fallback: true, notReady: true });
    expect(pending).not.toHaveProperty('degraded');
    expect(store.puts).toHaveLength(0);

    vi.setSystemTime(GRACE_END_MS);
    const overdue = await fetchCandidate(store, []);
    expect(overdue).toMatchObject({ fallback: true, degraded: true });
    expect(store.puts).toHaveLength(0);
  });

  it('samples the publication grace after an in-flight candidate response completes', async () => {
    const key = marineIngredientKey(LOCATION, 'water');
    const retained = completeMarineEnvelope(LOCATION, 'water', OLD_RUN_ID);
    const store = makeEnv({ [key]: retained });
    const prefix = completeMarineSeries('water', CANDIDATE_RUN_ID).slice(0, 12);
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => {
      vi.setSystemTime(GRACE_END_MS);
      return Response.json({ features: prefix });
    });

    const result = await fetchMarineSeriesWithFallback(
      store.env,
      LOCATION,
      'water',
      candidateInstance(),
      [...FORECAST_PROVIDER_PARAMETERS.water],
      () => prefix,
    );

    expect(result).toMatchObject({ fallback: true, degraded: true });
    expect(result).not.toHaveProperty('notReady');
    expect(store.puts).toHaveLength(0);
  });

  it('rejects malformed coverage immediately and never writes it', async () => {
    const key = marineIngredientKey(LOCATION, 'water');
    const retained = completeMarineEnvelope(LOCATION, 'water', OLD_RUN_ID);
    const store = makeEnv({ [key]: retained });
    const malformed = completeMarineSeries('water', CANDIDATE_RUN_ID);
    malformed[10] = { ...malformed[10], tideLevel: undefined };

    const result = await fetchCandidate(store, malformed);

    expect(result).toMatchObject({
      fallback: true,
      degraded: true,
      degradationIsImmediate: true,
      instance: { id: OLD_RUN_ID },
    });
    expect(store.puts).toHaveLength(0);
    expect(assembleWithWater(result, INSIDE_GRACE_MS).degradedSources).toContain('water');
  });

  it('keeps a cold candidate preparing until a complete run exists', async () => {
    const store = makeEnv();
    const prefix = completeMarineSeries('water', CANDIDATE_RUN_ID).slice(0, 12);

    await expect(fetchCandidate(store, prefix)).rejects.toMatchObject({
      name: 'ProviderUnavailableError',
      provider: 'marine',
    });
    expect(store.puts).toHaveLength(0);
  });

  it('rejects a cold malformed candidate as a contract error, not publication lag', async () => {
    const store = makeEnv();
    const malformed = completeMarineSeries('water', CANDIDATE_RUN_ID);
    malformed[10] = { ...malformed[10], tideLevel: undefined };

    const request = fetchCandidate(store, malformed);
    await expect(request).rejects.toThrow(/invalid water run/i);
    await expect(request).rejects.not.toBeInstanceOf(ProviderUnavailableError);
    expect(store.puts).toHaveLength(0);
  });

  it('retries a prefix without writing, then replaces the old run once after exact proof', async () => {
    const key = marineIngredientKey(LOCATION, 'water');
    const retained = completeMarineEnvelope(LOCATION, 'water', OLD_RUN_ID);
    const store = makeEnv({ [key]: retained });
    const prefix = completeMarineSeries('water', CANDIDATE_RUN_ID).slice(0, 12);

    await fetchCandidate(store, prefix);
    await fetchCandidate(store, prefix);
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(2);
    expect(store.puts).toHaveLength(0);

    const complete = completeMarineSeries('water', CANDIDATE_RUN_ID);
    const result = await fetchCandidate(store, complete);
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(3);

    expect(result).toMatchObject({
      fallback: false,
      providerContacted: true,
      instance: { id: CANDIDATE_RUN_ID },
    });
    expect(store.puts).toHaveLength(1);
    expect(JSON.parse(store.values.get(key)!)).toMatchObject({
      marineKind: 'water',
      id: CANDIDATE_RUN_ID,
      expectedStartMs: Date.parse('2026-08-25T06:00:00.000Z'),
      expectedEndMs: Date.parse('2026-08-30T06:00:00.000Z'),
      seriesEndMs: Date.parse('2026-08-30T06:00:00.000Z'),
    });
    expect(parsedLogs()).toContainEqual(expect.objectContaining({
      event: 'kv_write',
      category: 'raw-marine',
      coverageStatus: 'complete',
      expectedPointCount: 121,
    }));
  });
});
