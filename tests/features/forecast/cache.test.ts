import { afterEach, describe, expect, it, vi } from 'vitest';
import { CURRENT_LOCATION } from '../../../src/config/locations';
import { deriveCacheStatus } from '../../../src/features/forecast/cacheStatusView';
import { loadCachedWeatherData, saveCachedWeatherData } from '../../../src/features/forecast/cache';
import { FORECAST_PAYLOAD_VERSION } from '../../../src/features/forecast/types';
import type { HourlyData, WeatherData } from '../../../src/features/forecast/types';
import { isValidForecastPayload } from '../../../src/features/forecast/validatePayload';

const NOW = Date.parse('2026-08-12T12:00:00Z');
const CACHE_KEY = `frank_weather_data_v2_${CURRENT_LOCATION.id}`;

function hour(time: string, blockSpanHours?: number): HourlyData {
  return {
    time,
    tempAir: 17,
    precipitation: 0,
    symbolCode: 'clearsky_day',
    weatherCode: 0,
    windSpeed: 3,
    windDirection: 90,
    windGust: 4,
    waveHeight: 0.2,
    waveDirection: 90,
    wavePeriod: 3,
    tempWater: 16,
    tideLevel: 0,
    currentSpeed: 0,
    currentDirection: 0,
    isDay: true,
    ...(blockSpanHours === undefined
      ? {}
      : { blockSpanHours, isOutlook: true, isLowConfidence: true }),
  };
}

function weatherData(hourly: HourlyData[]): WeatherData {
  const fetchedAt = new Date(NOW - 7 * 60 * 60 * 1000).toISOString();
  return {
    hourly,
    sunrise: [],
    sunset: [],
    sources: {
      payloadVersion: 6,
      weather: 'MET Norway Locationforecast',
      waves: 'DMI WAM',
      water: 'DMI DKSS',
      coordinate: CURRENT_LOCATION.coordinate,
      location: {
        id: CURRENT_LOCATION.id,
        name: CURRENT_LOCATION.name,
        areaName: CURRENT_LOCATION.areaName,
      },
      fetchedAt,
      cacheHealth: { status: 'current', lastAttemptAt: fetchedAt },
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('forecast payload trust boundary', () => {
  it('accepts older compatible versions and limits the unversioned exception to legacy cache reads', () => {
    const older = weatherData([hour(new Date(NOW + 60 * 60 * 1000).toISOString())]);
    expect(isValidForecastPayload(older, CURRENT_LOCATION)).toBe(true);

    const unversioned = structuredClone(older);
    delete unversioned.sources.payloadVersion;

    expect(isValidForecastPayload(unversioned, CURRENT_LOCATION)).toBe(false);
    expect(isValidForecastPayload(unversioned, CURRENT_LOCATION, { allowLegacyMissingVersion: true })).toBe(true);
  });

  it('rejects partial rows while preserving revived NaN as an unavailable reading', () => {
    const unavailable = weatherData([hour(new Date(NOW + 60 * 60 * 1000).toISOString())]);
    unavailable.hourly[0].waveHeight = Number.NaN;
    unavailable.hourly[0].windGustMax = Number.NaN;
    expect(isValidForecastPayload(unavailable, CURRENT_LOCATION)).toBe(true);

    const missingRequiredReading = structuredClone(unavailable);
    Reflect.deleteProperty(missingRequiredReading.hourly[0], 'windSpeed');
    expect(isValidForecastPayload(missingRequiredReading, CURRENT_LOCATION)).toBe(false);

    const infiniteReading = structuredClone(unavailable);
    infiniteReading.hourly[0].windSpeed = Number.POSITIVE_INFINITY;
    expect(isValidForecastPayload(infiniteReading, CURRENT_LOCATION)).toBe(false);

    expect(isValidForecastPayload({ hourly: unavailable.hourly }, CURRENT_LOCATION)).toBe(false);
  });

  it('rejects impossible negative magnitudes and bearings without rejecting valid negative tide or temperature', () => {
    const base = weatherData([hour(new Date(NOW + 60 * 60 * 1000).toISOString())]);

    for (const field of ['precipitation', 'windSpeed', 'windGust', 'waveHeight', 'wavePeriod', 'currentSpeed'] as const) {
      const invalid = structuredClone(base);
      invalid.hourly[0][field] = -999;
      expect(isValidForecastPayload(invalid, CURRENT_LOCATION), field).toBe(false);
    }

    for (const field of ['windDirection', 'waveDirection', 'currentDirection'] as const) {
      for (const invalidBearing of [-1, 360]) {
        const invalid = structuredClone(base);
        invalid.hourly[0][field] = invalidBearing;
        expect(isValidForecastPayload(invalid, CURRENT_LOCATION), `${field}:${invalidBearing}`).toBe(false);
      }
    }

    const legitimateNegatives = structuredClone(base);
    legitimateNegatives.hourly[0].tideLevel = -0.4;
    legitimateNegatives.hourly[0].tempAir = -8;
    legitimateNegatives.hourly[0].tempWater = -1;
    expect(isValidForecastPayload(legitimateNegatives, CURRENT_LOCATION)).toBe(true);
  });

  it('rejects invalid, duplicate, decreasing, and overlapping timestamps', () => {
    const first = new Date(NOW + 60 * 60 * 1000).toISOString();
    const second = new Date(NOW + 2 * 60 * 60 * 1000).toISOString();

    expect(isValidForecastPayload(weatherData([hour('not-a-date')]), CURRENT_LOCATION)).toBe(false);
    expect(isValidForecastPayload(weatherData([hour(first), hour(first)]), CURRENT_LOCATION)).toBe(false);
    expect(isValidForecastPayload(weatherData([hour(second), hour(first)]), CURRENT_LOCATION)).toBe(false);
    expect(isValidForecastPayload(weatherData([hour(first, 6), hour(second, 6)]), CURRENT_LOCATION)).toBe(false);

    const invalidSun = weatherData([hour(first)]);
    invalidSun.sunrise = ['not-a-date'];
    expect(isValidForecastPayload(invalidSun, CURRENT_LOCATION)).toBe(false);
  });

  it('rejects unsupported block spans and non-finite structural numbers', () => {
    const start = new Date(NOW + 60 * 60 * 1000).toISOString();
    expect(isValidForecastPayload(weatherData([hour(start, 5)]), CURRENT_LOCATION)).toBe(false);
    expect(isValidForecastPayload(weatherData([hour(start, Number.POSITIVE_INFINITY)]), CURRENT_LOCATION)).toBe(false);

    const invalidCoordinate = weatherData([hour(start)]);
    invalidCoordinate.sources.coordinate = { latitude: Number.NaN, longitude: 9.905 };
    expect(isValidForecastPayload(invalidCoordinate, CURRENT_LOCATION)).toBe(false);
  });

  it('requires outlook flags and block span to travel as one canonical tuple', () => {
    const start = new Date(NOW + 60 * 60 * 1000).toISOString();

    const blockWithoutFlags = weatherData([hour(start, 6)]);
    delete blockWithoutFlags.hourly[0].isOutlook;
    delete blockWithoutFlags.hourly[0].isLowConfidence;
    expect(isValidForecastPayload(blockWithoutFlags, CURRENT_LOCATION)).toBe(false);

    const flagsWithoutBlock = weatherData([hour(start)]);
    flagsWithoutBlock.hourly[0].isOutlook = true;
    flagsWithoutBlock.hourly[0].isLowConfidence = true;
    expect(isValidForecastPayload(flagsWithoutBlock, CURRENT_LOCATION)).toBe(false);

    const validBlock = weatherData([hour(start, 6)]);
    validBlock.hourly[0].isOutlook = true;
    validBlock.hourly[0].isLowConfidence = true;
    expect(isValidForecastPayload(validBlock, CURRENT_LOCATION)).toBe(true);
  });

  it('binds location by stable id and nearby coordinate without coupling to display copy', () => {
    const start = new Date(NOW + 60 * 60 * 1000).toISOString();
    const wrongLocation = weatherData([hour(start)]);
    wrongLocation.sources.location = { id: 'vejle', name: 'Vejle', areaName: 'Vejle Fjord' };
    expect(isValidForecastPayload(wrongLocation, CURRENT_LOCATION)).toBe(false);

    const renamedArea = weatherData([hour(start)]);
    renamedArea.sources.location = { ...renamedArea.sources.location!, name: 'Horsens Harbour', areaName: 'Horsens Fjord East' };
    expect(isValidForecastPayload(renamedArea, CURRENT_LOCATION)).toBe(true);

    const roundedCoordinate = weatherData([hour(start)]);
    roundedCoordinate.sources.coordinate = {
      latitude: CURRENT_LOCATION.coordinate.latitude + 0.0005,
      longitude: CURRENT_LOCATION.coordinate.longitude - 0.0005,
    };
    expect(isValidForecastPayload(roundedCoordinate, CURRENT_LOCATION)).toBe(true);

    const wrongCoordinate = weatherData([hour(start)]);
    wrongCoordinate.sources.coordinate = {
      latitude: CURRENT_LOCATION.coordinate.latitude,
      longitude: CURRENT_LOCATION.coordinate.longitude + 0.01,
    };
    expect(isValidForecastPayload(wrongCoordinate, CURRENT_LOCATION)).toBe(false);
  });

  it('rejects a payload from a newer contract', () => {
    const start = new Date(NOW + 60 * 60 * 1000).toISOString();
    const futureContract = weatherData([hour(start)]);
    futureContract.sources.payloadVersion = FORECAST_PAYLOAD_VERSION + 1;
    expect(isValidForecastPayload(futureContract, CURRENT_LOCATION)).toBe(false);
  });
});

describe('browser forecast cache recovery', () => {
  it('never persists a transient pending response over the durable last-good copy', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const stable = weatherData([hour(new Date(NOW + 60 * 60 * 1000).toISOString())]);
    saveCachedWeatherData(stable, CURRENT_LOCATION);

    const pending = structuredClone(stable);
    pending.sources.cacheHealth = {
      ...pending.sources.cacheHealth!,
      status: 'pending',
      checkedBy: 'manual',
    };
    saveCachedWeatherData(pending, CURRENT_LOCATION);

    const loaded = await loadCachedWeatherData(CURRENT_LOCATION);
    expect(loaded.data?.sources.cacheHealth?.status).toBe('current');
    expect(JSON.parse(localStorage.getItem(CACHE_KEY)!).sources.cacheHealth.status).toBe('current');
  });

  it('uses stable local health for a live pending Worker response without persisting pending', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const stable = weatherData([hour(new Date(NOW + 60 * 60 * 1000).toISOString())]);
    saveCachedWeatherData(stable, CURRENT_LOCATION);
    const pending = structuredClone(stable);
    pending.sources.cacheHealth = {
      ...pending.sources.cacheHealth!,
      status: 'pending',
      checkedBy: 'manual',
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => structuredClone(pending),
    }));

    const loaded = await loadCachedWeatherData(CURRENT_LOCATION, {
      preferWorker: true,
      forceWorkerRefresh: true,
    });

    expect(loaded.from).toBe('worker');
    expect(loaded.data?.sources.cacheHealth?.status).toBe('current');
    expect(JSON.parse(localStorage.getItem(CACHE_KEY)!).sources.cacheHealth.status).toBe('current');
  });

  it('uses a newer pending Worker forecast in memory instead of substituting an older local snapshot', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const local = weatherData([hour(new Date(NOW + 60 * 60 * 1000).toISOString())]);
    saveCachedWeatherData(local, CURRENT_LOCATION);

    const pendingWorker = weatherData([hour(new Date(NOW + 2 * 60 * 60 * 1000).toISOString())]);
    pendingWorker.sources.fetchedAt = new Date(NOW - 60 * 60 * 1000).toISOString();
    pendingWorker.sources.cacheHealth = {
      status: 'pending',
      lastAttemptAt: pendingWorker.sources.fetchedAt,
      checkedBy: 'manual',
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => structuredClone(pendingWorker),
    }));

    const loaded = await loadCachedWeatherData(CURRENT_LOCATION, {
      preferWorker: true,
      forceWorkerRefresh: true,
    });

    expect(loaded.from).toBe('worker');
    expect(loaded.data?.sources.fetchedAt).toBe(pendingWorker.sources.fetchedAt);
    expect(loaded.data?.sources.cacheHealth?.status).toBe('pending');
    // Pending is response-only: the durable fallback remains the old completed
    // snapshot even though the newer forecast can be shown in memory now.
    expect(JSON.parse(localStorage.getItem(CACHE_KEY)!).sources.fetchedAt).toBe(local.sources.fetchedAt);
    expect(JSON.parse(localStorage.getItem(CACHE_KEY)!).sources.cacheHealth.status).toBe('current');
  });

  it('returns pending only in memory when no durable copy exists', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const pending = weatherData([hour(new Date(NOW + 60 * 60 * 1000).toISOString())]);
    pending.sources.cacheHealth = { ...pending.sources.cacheHealth!, status: 'pending' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => structuredClone(pending),
    }));

    const loaded = await loadCachedWeatherData(CURRENT_LOCATION, { preferWorker: true });
    expect(loaded.data?.sources.cacheHealth?.status).toBe('pending');
    expect(localStorage.getItem(CACHE_KEY)).toBeNull();
  });

  it('heals pending values written by older clients to conservative stable health', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const legacyPending = weatherData([hour(new Date(NOW + 60 * 60 * 1000).toISOString())]);
    legacyPending.sources.cacheHealth = { ...legacyPending.sources.cacheHealth!, status: 'pending' };
    localStorage.setItem(CACHE_KEY, JSON.stringify(legacyPending));

    const loaded = await loadCachedWeatherData(CURRENT_LOCATION);
    expect(loaded.data?.sources.cacheHealth?.status).toBe('stale');
    expect(JSON.parse(localStorage.getItem(CACHE_KEY)!).sources.cacheHealth.status).toBe('stale');
  });

  it('loads a forecast built over six hours ago when it still has future hours', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const cached = weatherData([hour(new Date(NOW + 60 * 60 * 1000).toISOString())]);
    saveCachedWeatherData(cached, CURRENT_LOCATION);

    const loaded = await loadCachedWeatherData(CURRENT_LOCATION);

    expect(loaded.from).toBe('local');
    expect(loaded.data?.sources.fetchedAt).toBe(cached.sources.fetchedAt);
    expect(fetchMock).not.toHaveBeenCalled();

    // Loading and freshness are intentionally separate: the useful saved
    // forecast renders, while the existing six-hour warning remains active.
    const status = deriveCacheStatus({
      sources: loaded.data!.sources,
      refreshing: false,
      online: false,
      nowMs: NOW,
      workerContactedAtMs: null,
    });
    expect(status.showRefreshWarning).toBe(true);
    expect(status.forecastAgeLabel).toBe('7 h');
  });

  it('recognises a longer-range block that still spans the current time', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const blockStart = new Date(NOW - 5 * 60 * 60 * 1000).toISOString();
    saveCachedWeatherData(weatherData([hour(blockStart, 6)]), CURRENT_LOCATION);

    const loaded = await loadCachedWeatherData(CURRENT_LOCATION);

    expect(loaded.from).toBe('local');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects saved data whose forecast window has fully elapsed', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const fetchMock = vi.fn().mockResolvedValue({ ok: false });
    vi.stubGlobal('fetch', fetchMock);
    const elapsedHour = new Date(NOW - 2 * 60 * 60 * 1000).toISOString();
    saveCachedWeatherData(weatherData([hour(elapsedHour)]), CURRENT_LOCATION);

    const loaded = await loadCachedWeatherData(CURRENT_LOCATION);

    expect(loaded).toEqual({ data: null, from: null });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('loads a structurally valid legacy local copy with no version stamp', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const legacy = weatherData([hour(new Date(NOW + 60 * 60 * 1000).toISOString())]);
    delete legacy.sources.payloadVersion;
    localStorage.setItem(CACHE_KEY, JSON.stringify(legacy));

    const loaded = await loadCachedWeatherData(CURRENT_LOCATION);

    expect(loaded.from).toBe('local');
    expect(loaded.data?.sources.payloadVersion).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts and persists an older compatible Worker payload', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const olderWorker = weatherData([hour(new Date(NOW + 60 * 60 * 1000).toISOString())]);
    olderWorker.sources.fetchedAt = new Date(NOW).toISOString();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => structuredClone(olderWorker) });
    vi.stubGlobal('fetch', fetchMock);

    const loaded = await loadCachedWeatherData(CURRENT_LOCATION, { preferWorker: true });
    expect(loaded).toEqual({ data: olderWorker, from: 'worker' });

    const persisted = await loadCachedWeatherData(CURRENT_LOCATION);
    expect(persisted).toEqual({ data: olderWorker, from: 'local' });
  });

  it('never lets an older Worker build regress the durable offline cache', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const newerLocal = weatherData([hour(new Date(NOW + 3 * 60 * 60 * 1000).toISOString())]);
    newerLocal.sources.fetchedAt = new Date(NOW - 30 * 60 * 1000).toISOString();
    newerLocal.sources.cacheHealth = {
      status: 'current',
      lastAttemptAt: newerLocal.sources.fetchedAt,
    };
    saveCachedWeatherData(newerLocal, CURRENT_LOCATION);

    const olderWorker = weatherData([hour(new Date(NOW + 2 * 60 * 60 * 1000).toISOString())]);
    olderWorker.sources.fetchedAt = new Date(NOW - 2 * 60 * 60 * 1000).toISOString();
    olderWorker.sources.cacheHealth = {
      status: 'stale',
      lastAttemptAt: new Date(NOW).toISOString(),
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => structuredClone(olderWorker),
    }));

    const loaded = await loadCachedWeatherData(CURRENT_LOCATION, { preferWorker: true });
    expect(loaded).toEqual({ data: olderWorker, from: 'worker' });
    expect(JSON.parse(localStorage.getItem(CACHE_KEY)!).sources.fetchedAt).toBe(newerLocal.sources.fetchedAt);

    const offline = await loadCachedWeatherData(CURRENT_LOCATION, { localOnly: true });
    expect(offline.data?.sources.fetchedAt).toBe(newerLocal.sources.fetchedAt);
  });

  it('replaces a corrupt durable value with the next validated forecast', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    localStorage.setItem(CACHE_KEY, '{not-json');
    const valid = weatherData([hour(new Date(NOW + 60 * 60 * 1000).toISOString())]);

    saveCachedWeatherData(valid, CURRENT_LOCATION);

    expect(JSON.parse(localStorage.getItem(CACHE_KEY)!)).toEqual(valid);
  });

  it('migrates an unversioned legacy copy when the same build arrives with a contract stamp', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const versioned = weatherData([hour(new Date(NOW + 60 * 60 * 1000).toISOString())]);
    const legacy = structuredClone(versioned);
    delete legacy.sources.payloadVersion;
    localStorage.setItem(CACHE_KEY, JSON.stringify(legacy));

    saveCachedWeatherData(versioned, CURRENT_LOCATION);

    expect(JSON.parse(localStorage.getItem(CACHE_KEY)!).sources.payloadVersion).toBe(versioned.sources.payloadVersion);
  });

  it('aligns browser timeouts with cached and true cold-start Worker paths', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const worker = weatherData([hour(new Date(NOW + 60 * 60 * 1000).toISOString())]);
    worker.sources.fetchedAt = new Date(NOW).toISOString();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => structuredClone(worker),
    }));

    await loadCachedWeatherData(CURRENT_LOCATION, { preferWorker: true });
    expect(timeout).toHaveBeenLastCalledWith(30_000);

    const local = structuredClone(worker);
    local.sources.fetchedAt = new Date(NOW + 60_000).toISOString();
    local.sources.cacheHealth = { status: 'current', lastAttemptAt: local.sources.fetchedAt };
    saveCachedWeatherData(local, CURRENT_LOCATION);

    await loadCachedWeatherData(CURRENT_LOCATION, { preferWorker: true });
    expect(timeout).toHaveBeenLastCalledWith(12_000);

    await loadCachedWeatherData(CURRENT_LOCATION, {
      preferWorker: true,
      allowColdWorkerBuild: true,
    });
    expect(timeout).toHaveBeenLastCalledWith(30_000);
  });

  it('does not let a newer incompatible Worker overwrite the compatible last-good cache', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const lastGood = weatherData([hour(new Date(NOW + 60 * 60 * 1000).toISOString())]);
    saveCachedWeatherData(lastGood, CURRENT_LOCATION);

    const futureWorker = weatherData([hour(new Date(NOW + 2 * 60 * 60 * 1000).toISOString())]);
    futureWorker.sources.payloadVersion = FORECAST_PAYLOAD_VERSION + 1;
    futureWorker.sources.fetchedAt = new Date(NOW).toISOString();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => structuredClone(futureWorker) });
    vi.stubGlobal('fetch', fetchMock);

    const loaded = await loadCachedWeatherData(CURRENT_LOCATION, { preferWorker: true });
    expect(loaded).toEqual({ data: lastGood, from: 'local' });

    const stillLastGood = await loadCachedWeatherData(CURRENT_LOCATION);
    expect(stillLastGood).toEqual({ data: lastGood, from: 'local' });
  });
});
