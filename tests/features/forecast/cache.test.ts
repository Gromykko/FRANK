import { afterEach, describe, expect, it, vi } from 'vitest';
import { CURRENT_LOCATION } from '../../../src/config/locations';
import { deriveCacheStatus } from '../../../src/features/forecast/cacheStatusView';
import {
  forecastReleaseCacheKey,
  loadCachedWeatherData,
  resolveForecastApiResponse,
  saveCachedWeatherData,
} from '../../../src/features/forecast/cache';
import { FORECAST_PAYLOAD_VERSION } from '../../../src/features/forecast/types';
import type { HourlyData, WeatherData } from '../../../src/features/forecast/types';
import { isValidForecastPayload } from '../../../src/features/forecast/validatePayload';
import { buildSunSchedule } from '../../../src/features/forecast/sun';
import {
  FORECAST_CLOCK_LEAD_TOLERANCE_MS,
  FORECAST_SERVER_CLOCK_LEAD_TOLERANCE_MS,
} from '../../../src/features/forecast/temporalPolicy';
import {
  CURRENT_RELEASE,
  FORECAST_API_SCHEMA_VERSION,
  FORECAST_RELEASE_HEADERS,
} from '../../../src/features/forecast/releaseContract';
import type { ReleaseMetadata } from '../../../src/features/forecast/releaseContract';

const NOW = Date.parse('2026-08-12T12:00:00Z');
const LEGACY_CACHE_KEY = `frank_weather_data_v2_${CURRENT_LOCATION.id}`;
const CACHE_KEY = `${LEGACY_CACHE_KEY}_v${FORECAST_PAYLOAD_VERSION}`;
const API_CACHE_KEY = forecastReleaseCacheKey(CURRENT_LOCATION, CURRENT_RELEASE);
const AUTHORITY_MARKER_PREFIX = `${LEGACY_CACHE_KEY}_config${CURRENT_LOCATION.forecastConfigRevision}_authority_`;

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
      payloadVersion: FORECAST_PAYLOAD_VERSION,
      weather: 'MET Norway Locationforecast',
      waves: 'DMI WAM',
      water: 'DMI DKSS',
      coordinate: CURRENT_LOCATION.coordinate,
      location: {
        id: CURRENT_LOCATION.id,
        forecastConfigRevision: CURRENT_LOCATION.forecastConfigRevision,
        name: CURRENT_LOCATION.name,
        areaName: CURRENT_LOCATION.areaName,
      },
      fetchedAt,
      cacheHealth: { status: 'current', lastAttemptAt: fetchedAt },
    },
  };
}

function apiWeatherData(hourly: HourlyData[]): WeatherData {
  const data = weatherData(hourly);
  const sun = buildSunSchedule(hourly.map(({ time }) => time), CURRENT_LOCATION);
  data.sunrise = sun.sunrise;
  data.sunset = sun.sunset;
  data.hourly.forEach((row) => {
    row.isDay = sun.isDayByTime.get(row.time) ?? false;
  });
  data.sources.release = { ...CURRENT_RELEASE };
  return data;
}

function releaseHeaders(release: ReleaseMetadata, ready = true): Headers {
  return new Headers({
    'Content-Type': 'application/json',
    [FORECAST_RELEASE_HEADERS.apiSchema]: String(release.apiSchemaVersion),
    [FORECAST_RELEASE_HEADERS.modelRevision]: String(release.modelRevision),
    [FORECAST_RELEASE_HEADERS.dataGeneration]: release.dataGenerationId,
    [FORECAST_RELEASE_HEADERS.assembledCacheSchema]: String(release.assembledCacheSchema),
    [FORECAST_RELEASE_HEADERS.marineCacheSchema]: String(release.marineCacheSchema),
    [FORECAST_RELEASE_HEADERS.payloadVersion]: String(release.payloadVersion),
    [FORECAST_RELEASE_HEADERS.generationReady]: String(ready),
  });
}

function authorityMarkerCacheKeys(): string[] {
  return Object.keys(localStorage)
    .filter((key) => key.startsWith(AUTHORITY_MARKER_PREFIX))
    .map((key) => JSON.parse(localStorage.getItem(key)!) as { cacheKey: string })
    .map(({ cacheKey }) => cacheKey);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('forecast payload trust boundary', () => {
  it('accepts the canonical payload and limits the unversioned exception to legacy cache reads', () => {
    const canonical = weatherData([hour(new Date(NOW + 60 * 60 * 1000).toISOString())]);
    expect(isValidForecastPayload(canonical, CURRENT_LOCATION)).toBe(true);

    const unversioned = structuredClone(canonical);
    delete unversioned.sources.payloadVersion;

    expect(isValidForecastPayload(unversioned, CURRENT_LOCATION)).toBe(false);
    expect(isValidForecastPayload(unversioned, CURRENT_LOCATION, { allowLegacyMissingVersion: true })).toBe(true);

    const unauditedOldVersion = structuredClone(canonical);
    unauditedOldVersion.sources.payloadVersion = FORECAST_PAYLOAD_VERSION - 1;
    expect(isValidForecastPayload(unauditedOldVersion, CURRENT_LOCATION)).toBe(false);
  });

  it('validates additive stable-API release identity without requiring it on legacy copies', () => {
    const legacy = weatherData([hour(new Date(NOW + 60 * 60 * 1000).toISOString())]);
    expect(isValidForecastPayload(legacy, CURRENT_LOCATION)).toBe(true);
    expect(isValidForecastPayload(legacy, CURRENT_LOCATION, { requireReleaseMetadata: true })).toBe(false);

    const current = apiWeatherData([hour(new Date(NOW + 60 * 60 * 1000).toISOString())]);
    expect(isValidForecastPayload(current, CURRENT_LOCATION, { requireReleaseMetadata: true })).toBe(true);

    const emptyCurrentSchedule = structuredClone(current);
    emptyCurrentSchedule.sunrise = [];
    emptyCurrentSchedule.sunset = [];
    expect(isValidForecastPayload(emptyCurrentSchedule, CURRENT_LOCATION)).toBe(false);
    // Release-less legacy/offline copies retain their documented compatibility
    // allowance because their historical schema did not guarantee sun arrays.
    expect(isValidForecastPayload(legacy, CURRENT_LOCATION)).toBe(true);

    const wrongApi = structuredClone(current);
    wrongApi.sources.release!.apiSchemaVersion = FORECAST_API_SCHEMA_VERSION + 1;
    expect(isValidForecastPayload(wrongApi, CURRENT_LOCATION)).toBe(false);

    const mismatchedLegacyStamp = structuredClone(current);
    mismatchedLegacyStamp.sources.release!.payloadVersion = 6;
    expect(isValidForecastPayload(mismatchedLegacyStamp, CURRENT_LOCATION)).toBe(false);
  });

  it('validates optional warning sent timestamps and rejects malformed values', () => {
    const withSent = weatherData([hour(new Date(NOW + 60 * 60 * 1000).toISOString())]);
    withSent.warnings = [{
      event: 'Wind',
      colour: 'orange',
      sent: '2026-08-12T05:30:00Z',
      effective: '2026-08-12T06:00:00Z',
      expires: '2026-08-12T18:00:00Z',
      url: 'https://www.dmi.dk/varsler',
    }];
    expect(isValidForecastPayload(withSent, CURRENT_LOCATION)).toBe(true);

    const withoutSent = structuredClone(withSent);
    delete withoutSent.warnings![0].sent;
    expect(isValidForecastPayload(withoutSent, CURRENT_LOCATION)).toBe(true);

    const malformedSent = structuredClone(withSent);
    malformedSent.warnings![0].sent = 'not-a-timestamp';
    expect(isValidForecastPayload(malformedSent, CURRENT_LOCATION)).toBe(false);
  });

  it('accepts cache health with or without marine provenance and rejects malformed references', () => {
    const withoutProvenance = weatherData([
      hour(new Date(NOW + 60 * 60 * 1000).toISOString()),
    ]);
    expect(withoutProvenance.sources.cacheHealth).not.toHaveProperty('marineInstances');
    expect(isValidForecastPayload(withoutProvenance, CURRENT_LOCATION)).toBe(true);

    const withProvenance = structuredClone(withoutProvenance);
    withProvenance.sources.cacheHealth!.marineInstances = {
      water: { collection: 'dkss_idw', id: '2026-08-12T060000Z' },
      waves: { collection: 'wam_nsb', id: '2026-08-12T060000Z' },
    };
    expect(isValidForecastPayload(withProvenance, CURRENT_LOCATION)).toBe(true);

    const partial = structuredClone(withoutProvenance);
    partial.sources.cacheHealth!.marineInstances = {
      water: { collection: 'dkss_idw', id: 'unparseable-but-structurally-valid' },
    };
    expect(isValidForecastPayload(partial, CURRENT_LOCATION)).toBe(true);

    for (const malformed of [
      null,
      [],
      { water: null },
      { water: {} },
      { water: { collection: '', id: '2026-08-12T060000Z' } },
      { waves: { collection: 'wam_nsb', id: '' } },
    ]) {
      const invalid = structuredClone(withoutProvenance);
      Reflect.set(invalid.sources.cacheHealth!, 'marineInstances', malformed);
      expect(isValidForecastPayload(invalid, CURRENT_LOCATION), JSON.stringify(malformed)).toBe(false);
    }
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

  it('validates the optional outlook p90 as a non-negative reading', () => {
    const base = weatherData([hour(new Date(NOW + 60 * 60 * 1000).toISOString(), 6)]);
    base.hourly[0].windSpeedP90 = 5;
    expect(isValidForecastPayload(base, CURRENT_LOCATION)).toBe(true);

    const negative = structuredClone(base);
    negative.hourly[0].windSpeedP90 = -1;
    expect(isValidForecastPayload(negative, CURRENT_LOCATION)).toBe(false);

    const infinite = structuredClone(base);
    infinite.hourly[0].windSpeedP90 = Number.POSITIVE_INFINITY;
    expect(isValidForecastPayload(infinite, CURRENT_LOCATION)).toBe(false);
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

  it('rejects isDay values that contradict the paired local sunrise and sunset', () => {
    const midnight = apiWeatherData([hour('2026-08-12T00:00:00Z')]);
    midnight.sunrise = ['2026-08-12T04:00:00Z'];
    midnight.sunset = ['2026-08-12T18:00:00Z'];
    midnight.hourly[0].isDay = true;

    // 02:00 in Copenhagen is before the 06:00 local sunrise.
    expect(isValidForecastPayload(midnight, CURRENT_LOCATION, { nowMs: NOW })).toBe(false);
    midnight.hourly[0].isDay = false;
    expect(isValidForecastPayload(midnight, CURRENT_LOCATION, { nowMs: NOW })).toBe(true);

    // A next-day sunset must not create one oversized "daylight" interval
    // across the night, even if a forged isDay flag agrees with that interval.
    const overnight = apiWeatherData([hour('2026-08-12T12:00:00Z')]);
    overnight.sunrise = ['2026-08-12T04:00:00Z'];
    overnight.sunset = ['2026-08-13T18:00:00Z'];
    expect(isValidForecastPayload(overnight, CURRENT_LOCATION, { nowMs: NOW })).toBe(false);

    // Sun is assembled before rows missing a nearby marine point are removed,
    // so a real payload may retain a valid schedule for an unrepresented day.
    const extraScheduleDay = apiWeatherData([hour('2026-08-12T12:00:00Z')]);
    extraScheduleDay.sunrise = ['2026-08-12T04:00:00Z', '2026-08-13T04:02:00Z'];
    extraScheduleDay.sunset = ['2026-08-12T18:00:00Z', '2026-08-13T17:58:00Z'];
    expect(isValidForecastPayload(extraScheduleDay, CURRENT_LOCATION, { nowMs: NOW })).toBe(true);
  });

  it('rejects implausibly future source and forecast timestamps', () => {
    const oneHourAhead = new Date(NOW + 60 * 60 * 1000).toISOString();
    const payload = apiWeatherData([hour(oneHourAhead)]);

    payload.sources.fetchedAt = new Date(NOW + FORECAST_CLOCK_LEAD_TOLERANCE_MS).toISOString();
    expect(isValidForecastPayload(payload, CURRENT_LOCATION, { nowMs: NOW })).toBe(true);

    payload.sources.fetchedAt = new Date(NOW + FORECAST_CLOCK_LEAD_TOLERANCE_MS + 1).toISOString();
    expect(isValidForecastPayload(payload, CURRENT_LOCATION, { nowMs: NOW })).toBe(false);

    const futureHealth = apiWeatherData([hour(oneHourAhead)]);
    futureHealth.sources.cacheHealth!.lastAttemptAt = new Date(NOW + FORECAST_CLOCK_LEAD_TOLERANCE_MS + 1).toISOString();
    expect(isValidForecastPayload(futureHealth, CURRENT_LOCATION, { nowMs: NOW })).toBe(false);

    const farFutureForecast = apiWeatherData([
      hour(new Date(NOW + 7 * 24 * 60 * 60 * 1000 + 1).toISOString()),
    ]);
    expect(isValidForecastPayload(farFutureForecast, CURRENT_LOCATION, { nowMs: NOW })).toBe(false);

    const poisonedProviderStamps = apiWeatherData([hour(oneHourAhead)]);
    poisonedProviderStamps.sources.fetchedAt = new Date(NOW).toISOString();
    poisonedProviderStamps.sources.cacheHealth!.weatherExpires =
      new Date(NOW + 90 * 60 * 1000 + 1).toISOString();
    expect(isValidForecastPayload(poisonedProviderStamps, CURRENT_LOCATION, { nowMs: NOW })).toBe(false);

    poisonedProviderStamps.sources.cacheHealth!.weatherExpires =
      new Date(NOW + 90 * 60 * 1000).toISOString();
    poisonedProviderStamps.sources.cacheHealth!.weatherLastModified =
      new Date(NOW + 5 * 60 * 1000 + 1).toISOString();
    expect(isValidForecastPayload(poisonedProviderStamps, CURRENT_LOCATION, { nowMs: NOW })).toBe(false);

    poisonedProviderStamps.sources.cacheHealth!.weatherLastModified =
      new Date(NOW + 5 * 60 * 1000).toISOString();
    expect(isValidForecastPayload(poisonedProviderStamps, CURRENT_LOCATION, { nowMs: NOW })).toBe(true);
  });

  it('accepts a genuine payload when the device clock is twelve hours behind', () => {
    const serverNow = NOW + 12 * 60 * 60 * 1000;
    const skewed = apiWeatherData([
      hour(new Date(serverNow + 60 * 60 * 1000).toISOString()),
    ]);
    skewed.sources.fetchedAt = new Date(serverNow).toISOString();
    skewed.sources.cacheHealth!.lastAttemptAt = new Date(serverNow).toISOString();

    expect(isValidForecastPayload(skewed, CURRENT_LOCATION, { nowMs: NOW })).toBe(true);
  });

  it('uses the stricter source-clock tolerance at the Worker KV boundary', () => {
    const sixMinutesAhead = apiWeatherData([
      hour(new Date(NOW + 60 * 60 * 1000).toISOString()),
    ]);
    sixMinutesAhead.sources.fetchedAt = new Date(NOW + 6 * 60 * 1000).toISOString();

    expect(isValidForecastPayload(sixMinutesAhead, CURRENT_LOCATION, { nowMs: NOW })).toBe(true);
    expect(isValidForecastPayload(sixMinutesAhead, CURRENT_LOCATION, {
      nowMs: NOW,
      requireReleaseMetadata: true,
      sourceClockLeadToleranceMs: FORECAST_SERVER_CLOCK_LEAD_TOLERANCE_MS,
    })).toBe(false);
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
    wrongLocation.sources.location = {
      id: 'vejle',
      forecastConfigRevision: CURRENT_LOCATION.forecastConfigRevision,
      name: 'Vejle',
      areaName: 'Vejle Fjord',
    };
    expect(isValidForecastPayload(wrongLocation, CURRENT_LOCATION)).toBe(false);

    const renamedArea = weatherData([hour(start)]);
    renamedArea.sources.location = { ...renamedArea.sources.location!, name: 'Horsens Harbour', areaName: 'Horsens Fjord East' };
    expect(isValidForecastPayload(renamedArea, CURRENT_LOCATION)).toBe(true);

    const previousLocationConfig = weatherData([hour(start)]);
    previousLocationConfig.sources.location!.forecastConfigRevision =
      CURRENT_LOCATION.forecastConfigRevision + 1;
    expect(isValidForecastPayload(previousLocationConfig, CURRENT_LOCATION)).toBe(false);

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
  it('derives browser slots from every representation axis even if the label is forgotten', () => {
    const unchangedLabel = {
      ...CURRENT_RELEASE,
      dataGenerationId: 'forgotten:id/with space',
    };
    const releases = [
      unchangedLabel,
      { ...unchangedLabel, apiSchemaVersion: unchangedLabel.apiSchemaVersion + 1 },
      { ...unchangedLabel, modelRevision: unchangedLabel.modelRevision + 1 },
      { ...unchangedLabel, payloadVersion: unchangedLabel.payloadVersion + 1 },
      { ...unchangedLabel, dataGenerationId: `${unchangedLabel.dataGenerationId}-next` },
    ];
    const keys = releases.map((release) =>
      forecastReleaseCacheKey(CURRENT_LOCATION, release));

    expect(new Set(keys).size).toBe(releases.length);
    expect(keys[0]).toBe(
      `${LEGACY_CACHE_KEY}_config${CURRENT_LOCATION.forecastConfigRevision}`
      + `_api${CURRENT_RELEASE.apiSchemaVersion}_model${CURRENT_RELEASE.modelRevision}`
      + '_generation_forgotten%3Aid%2Fwith%20space'
      + `_payload${CURRENT_RELEASE.payloadVersion}`,
    );
  });

  it('isolates offline slots when an existing location config revision changes', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const revisedLocation = {
      ...CURRENT_LOCATION,
      forecastConfigRevision: CURRENT_LOCATION.forecastConfigRevision + 1,
    };
    const current = apiWeatherData([
      hour(new Date(NOW + 60 * 60 * 1000).toISOString()),
    ]);
    const revised = structuredClone(current);
    revised.sources.location!.forecastConfigRevision = revisedLocation.forecastConfigRevision;

    saveCachedWeatherData(current, CURRENT_LOCATION);
    saveCachedWeatherData(revised, revisedLocation);

    const currentKey = forecastReleaseCacheKey(CURRENT_LOCATION, CURRENT_RELEASE);
    const revisedKey = forecastReleaseCacheKey(revisedLocation, CURRENT_RELEASE);
    expect(currentKey).not.toBe(revisedKey);
    expect(JSON.parse(localStorage.getItem(currentKey)!)).toEqual(current);
    expect(JSON.parse(localStorage.getItem(revisedKey)!)).toEqual(revised);
    expect(await loadCachedWeatherData(CURRENT_LOCATION, { localOnly: true }))
      .toEqual({ data: current, from: 'local' });
    expect(await loadCachedWeatherData(revisedLocation, { localOnly: true }))
      .toEqual({ data: revised, from: 'local' });
  });

  it('uses the stable API route and isolates its offline slot from legacy apps', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const apiPayload = apiWeatherData([hour(new Date(NOW + 60 * 60 * 1000).toISOString())]);
    apiPayload.sources.fetchedAt = new Date(NOW).toISOString();

    const oldAppCopy = structuredClone(apiPayload);
    delete oldAppCopy.sources.release;
    localStorage.setItem(
      `${LEGACY_CACHE_KEY}_v${CURRENT_RELEASE.payloadVersion}`,
      JSON.stringify(oldAppCopy),
    );

    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(apiPayload), {
      status: 200,
      headers: releaseHeaders(apiPayload.sources.release!),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const loaded = await loadCachedWeatherData(CURRENT_LOCATION, { preferWorker: true });

    expect(loaded).toEqual({ data: apiPayload, from: 'worker', serverAuthority: true });
    expect(String(fetchMock.mock.calls[0][0])).toContain(`/api/v${FORECAST_API_SCHEMA_VERSION}/forecast/${CURRENT_LOCATION.id}`);
    expect(JSON.parse(localStorage.getItem(API_CACHE_KEY)!))
      .toEqual(apiPayload);
    expect(JSON.parse(localStorage.getItem(`${LEGACY_CACHE_KEY}_v${CURRENT_RELEASE.payloadVersion}`)!))
      .toEqual(oldAppCopy);
  });

  it('fails closed when no explicitly supported API route exists', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"error":"Not found"}', { status: 404 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const loaded = await loadCachedWeatherData(CURRENT_LOCATION, { preferWorker: true });

    expect(loaded).toEqual({ data: null, from: null, failureKind: 'response' });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/v1/forecast/');
  });

  it('uses an audited N-1 API while a future target API is still initializing', async () => {
    const ready = new Response(JSON.stringify(apiWeatherData([
      hour(new Date(NOW + 60 * 60 * 1000).toISOString()),
    ])), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const initializing = new Response(JSON.stringify({
      schemaVersion: 1,
      status: 'initializing',
      code: 'FORECAST_INITIALIZING',
      message: 'Forecast is being initialized.',
      retryAfterSeconds: 600,
      location: {
        id: CURRENT_LOCATION.id,
        name: CURRENT_LOCATION.name,
        areaName: CURRENT_LOCATION.areaName,
      },
    }), { status: 503, headers: { 'Retry-After': '600' } });
    const fetchEndpoint = vi.fn()
      .mockResolvedValueOnce(initializing)
      .mockResolvedValueOnce(ready);

    const result = await resolveForecastApiResponse(
      ['/api/v2/forecast/horsens', '/api/v1/forecast/horsens'],
      fetchEndpoint,
      CURRENT_LOCATION,
    );

    expect(result.response).toBe(ready);
    expect(result.initialization).toBeNull();
    expect(result.usedAvailabilityFallback).toBe(true);
    expect(fetchEndpoint).toHaveBeenCalledTimes(2);
  });

  it('treats an older API reached through 404 as an authoritative Worker rollback', async () => {
    const notFound = new Response('{"error":"not found"}', { status: 404 });
    const ready = new Response(JSON.stringify(apiWeatherData([
      hour(new Date(NOW + 60 * 60 * 1000).toISOString()),
    ])), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const fetchEndpoint = vi.fn()
      .mockResolvedValueOnce(notFound)
      .mockResolvedValueOnce(ready);

    const result = await resolveForecastApiResponse(
      ['/api/v2/forecast/horsens', '/api/v1/forecast/horsens'],
      fetchEndpoint,
      CURRENT_LOCATION,
    );

    expect(result.response).toBe(ready);
    expect(result.initialization).toBeNull();
    expect(result.usedAvailabilityFallback).toBe(false);
    expect(fetchEndpoint).toHaveBeenCalledTimes(2);
  });

  it('does not hide a hard target-API failure behind an older API', async () => {
    const hardFailure = new Response(JSON.stringify({ error: 'schema failure' }), { status: 503 });
    const fetchEndpoint = vi.fn().mockResolvedValue(hardFailure);

    const result = await resolveForecastApiResponse(
      ['/api/v2/forecast/horsens', '/api/v1/forecast/horsens'],
      fetchEndpoint,
      CURRENT_LOCATION,
    );

    expect(result.response).toBe(hardFailure);
    expect(result.initialization).toBeNull();
    expect(result.usedAvailabilityFallback).toBe(false);
    expect(fetchEndpoint).toHaveBeenCalledOnce();
  });

  it('surfaces a valid first-build response when this location has no saved forecast', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      schemaVersion: 1,
      status: 'initializing',
      code: 'FORECAST_INITIALIZING',
      message: 'Forecast is being initialized.',
      retryAfterSeconds: 600,
      location: {
        id: CURRENT_LOCATION.id,
        name: CURRENT_LOCATION.name,
        areaName: CURRENT_LOCATION.areaName,
      },
    }), { status: 503, headers: { 'Retry-After': '600' } })));

    const loaded = await loadCachedWeatherData(CURRENT_LOCATION, { preferWorker: true });

    expect(loaded.data).toBeNull();
    expect(loaded.from).toBeNull();
    expect(loaded.initialization).toMatchObject({
      schemaVersion: 1,
      status: 'initializing',
      code: 'FORECAST_INITIALIZING',
      retryAfterSeconds: 600,
      location: { id: CURRENT_LOCATION.id },
    });
  });

  it('keeps a usable saved forecast instead of replacing it with a first-build screen', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const saved = weatherData([hour(new Date(NOW + 60 * 60 * 1000).toISOString())]);
    saveCachedWeatherData(saved, CURRENT_LOCATION);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      schemaVersion: 1,
      status: 'initializing',
      code: 'FORECAST_INITIALIZING',
      message: 'Forecast is being initialized.',
      retryAfterSeconds: 600,
      location: {
        id: CURRENT_LOCATION.id,
        name: CURRENT_LOCATION.name,
        areaName: CURRENT_LOCATION.areaName,
      },
    }), { status: 503, headers: { 'Retry-After': '600' } })));

    const loaded = await loadCachedWeatherData(CURRENT_LOCATION, { preferWorker: true });

    expect(loaded.data).toEqual(saved);
    expect(loaded.from).toBe('local');
    expect(loaded.failureKind).toBeUndefined();
    expect(loaded.initialization).toMatchObject({
      status: 'initializing',
      code: 'FORECAST_INITIALIZING',
      retryAfterSeconds: 600,
      location: { id: CURRENT_LOCATION.id },
    });
  });

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

  it('rejects an unexpected pending API response without disturbing the stable local copy', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const stable = apiWeatherData([hour(new Date(NOW + 60 * 60 * 1000).toISOString())]);
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
    });

    expect(loaded.from).toBe('local');
    expect(loaded.failureKind).toBe('response');
    expect(loaded.data?.sources.cacheHealth?.status).toBe('current');
    expect(JSON.parse(localStorage.getItem(API_CACHE_KEY)!).sources.cacheHealth.status).toBe('current');
  });

  it('heals pending values written by older clients to conservative stable health', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const legacyPending = weatherData([hour(new Date(NOW + 60 * 60 * 1000).toISOString())]);
    legacyPending.sources.cacheHealth = { ...legacyPending.sources.cacheHealth!, status: 'pending' };
    localStorage.setItem(LEGACY_CACHE_KEY, JSON.stringify(legacyPending));

    const loaded = await loadCachedWeatherData(CURRENT_LOCATION);
    expect(loaded.data?.sources.cacheHealth?.status).toBe('stale');
    expect(JSON.parse(localStorage.getItem(LEGACY_CACHE_KEY)!).sources.cacheHealth.status).toBe('stale');
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

    expect(loaded).toEqual({ data: null, from: null, failureKind: 'response' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('loads a structurally valid legacy local copy with no version stamp', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const legacy = weatherData([hour(new Date(NOW + 60 * 60 * 1000).toISOString())]);
    delete legacy.sources.payloadVersion;
    localStorage.setItem(LEGACY_CACHE_KEY, JSON.stringify(legacy));

    const loaded = await loadCachedWeatherData(CURRENT_LOCATION);

    expect(loaded.from).toBe('local');
    expect(loaded.data?.sources.payloadVersion).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('isolates a changed model even when its generation label was not updated', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const previous = apiWeatherData([hour(new Date(NOW + 3 * 60 * 60 * 1000).toISOString())]);
    previous.sources.release = {
      ...CURRENT_RELEASE,
      modelRevision: CURRENT_RELEASE.modelRevision - 1,
      dataGenerationId: CURRENT_RELEASE.dataGenerationId,
    };
    // The still-active old generation can legitimately rebuild after the
    // shadow generation, so its forecast timestamp is newer.
    previous.sources.fetchedAt = new Date(NOW).toISOString();
    previous.sources.cacheHealth = { status: 'current', lastAttemptAt: previous.sources.fetchedAt };
    saveCachedWeatherData(previous, CURRENT_LOCATION);

    const promoted = apiWeatherData([hour(new Date(NOW + 2 * 60 * 60 * 1000).toISOString())]);
    promoted.sources.fetchedAt = new Date(NOW - 30 * 60 * 1000).toISOString();
    promoted.sources.cacheHealth = { status: 'current', lastAttemptAt: promoted.sources.fetchedAt };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(promoted), {
      status: 200,
      headers: releaseHeaders(promoted.sources.release!),
    }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await loadCachedWeatherData(CURRENT_LOCATION, { preferWorker: true }))
      .toEqual({ data: promoted, from: 'worker', serverAuthority: true });
    expect(await loadCachedWeatherData(CURRENT_LOCATION, { localOnly: true }))
      .toEqual({ data: promoted, from: 'local' });

    const previousKey = forecastReleaseCacheKey(
      CURRENT_LOCATION,
      previous.sources.release!,
    );
    expect(localStorage.getItem(previousKey)).not.toBeNull();
    expect(localStorage.getItem(API_CACHE_KEY)).not.toBeNull();
    expect(previousKey).not.toBe(API_CACHE_KEY);

    // A deliberate control-plane rollback makes the previous generation
    // authoritative again even though its model revision is lower.
    now.mockReturnValue(NOW + 1_000);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(previous), {
      status: 200,
      headers: releaseHeaders(previous.sources.release!),
    }));
    expect(await loadCachedWeatherData(CURRENT_LOCATION, { preferWorker: true }))
      .toEqual({ data: previous, from: 'worker', serverAuthority: true });
    expect(await loadCachedWeatherData(CURRENT_LOCATION, { localOnly: true }))
      .toEqual({ data: previous, from: 'local' });
  });

  it('retains current and N-1 generations while pruning only N-2 forecast state', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const cacheStorageDelete = vi.fn();
    vi.stubGlobal('caches', { delete: cacheStorageDelete });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const legacy = weatherData([
      hour(new Date(NOW + 12 * 60 * 60 * 1000).toISOString()),
    ]);
    saveCachedWeatherData(legacy, CURRENT_LOCATION);
    const preservedEntries = new Map([
      ['ffkajak_lang', 'da'],
      ['frank_theme_mode', 'dark'],
      ['frank_location', CURRENT_LOCATION.id],
      [`ffkajak_settings_${CURRENT_LOCATION.id}`, '{"limits":true}'],
      [`ffkajak_custom_saved_${CURRENT_LOCATION.id}`, '{"limits":true}'],
      ['frank_weather_data_v2_vejle_config1_api1_model4_generation_other_payload7', '{"otherLocation":true}'],
    ]);
    for (const [key, value] of preservedEntries) localStorage.setItem(key, value);

    // A newer open shell may already own a contract this client cannot parse.
    // Its strong slot and journal entry must remain completely untouched.
    const futureRelease = {
      ...CURRENT_RELEASE,
      apiSchemaVersion: CURRENT_RELEASE.apiSchemaVersion + 1,
      modelRevision: CURRENT_RELEASE.modelRevision + 1,
      dataGenerationId: 'future-shell-generation',
      payloadVersion: CURRENT_RELEASE.payloadVersion + 1,
    };
    const futurePayload = apiWeatherData([
      hour(new Date(NOW + 12 * 60 * 60 * 1000).toISOString()),
    ]);
    futurePayload.sources.payloadVersion = futureRelease.payloadVersion;
    futurePayload.sources.release = futureRelease;
    const futureCacheKey = forecastReleaseCacheKey(CURRENT_LOCATION, futureRelease);
    const futureRaw = JSON.stringify(futurePayload);
    const futureMarkerKey = `${AUTHORITY_MARKER_PREFIX}${NOW - 1_000}_future-shell`;
    localStorage.setItem(futureCacheKey, futureRaw);
    localStorage.setItem(futureMarkerKey, JSON.stringify({
      schemaVersion: 1,
      requestStartedAtMs: NOW - 1_000,
      receivedAtMs: NOW - 1_000,
      cacheKey: futureCacheKey,
    }));

    const releases = [
      { ...CURRENT_RELEASE, modelRevision: 5, dataGenerationId: 'gc-generation-a' },
      { ...CURRENT_RELEASE, modelRevision: 6, dataGenerationId: 'gc-generation-b' },
      { ...CURRENT_RELEASE, modelRevision: 7, dataGenerationId: 'gc-generation-c' },
    ];
    const payloads = releases.map((release) => {
      const data = apiWeatherData([
        hour(new Date(NOW + 12 * 60 * 60 * 1000).toISOString()),
      ]);
      data.sources.release = release;
      return data;
    });
    const cacheKeys = releases.map((release) =>
      forecastReleaseCacheKey(CURRENT_LOCATION, release));

    for (const [index, payload] of payloads.entries()) {
      now.mockReturnValue(NOW + index * 1_000);
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), {
        status: 200,
        headers: releaseHeaders(payload.sources.release!),
      }));
      expect(await loadCachedWeatherData(CURRENT_LOCATION, { preferWorker: true }))
        .toEqual({ data: payload, from: 'worker', serverAuthority: true });
    }

    expect(localStorage.getItem(cacheKeys[0])).toBeNull();
    expect(localStorage.getItem(cacheKeys[1])).not.toBeNull();
    expect(localStorage.getItem(cacheKeys[2])).not.toBeNull();
    expect(new Set(authorityMarkerCacheKeys()))
      .toEqual(new Set([cacheKeys[1], cacheKeys[2], futureCacheKey]));
    expect(localStorage.getItem(futureCacheKey)).toBe(futureRaw);
    expect(localStorage.getItem(futureMarkerKey)).not.toBeNull();
    expect(localStorage.getItem(CACHE_KEY)).toBe(JSON.stringify(legacy));
    for (const [key, value] of preservedEntries) {
      expect(localStorage.getItem(key)).toBe(value);
    }
    expect(cacheStorageDelete).not.toHaveBeenCalled();

    // A deliberate rollback to the already-pruned generation is valid. Its
    // fresh server-authority observation restores that slot, makes C the new
    // N-1, and removes B as N-2 without consulting model-number ordering.
    now.mockReturnValue(NOW + 3_000);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payloads[0]), {
      status: 200,
      headers: releaseHeaders(payloads[0].sources.release!),
    }));
    expect(await loadCachedWeatherData(CURRENT_LOCATION, { preferWorker: true }))
      .toEqual({ data: payloads[0], from: 'worker', serverAuthority: true });
    expect(await loadCachedWeatherData(CURRENT_LOCATION, { localOnly: true }))
      .toEqual({ data: payloads[0], from: 'local' });
    expect(localStorage.getItem(cacheKeys[0])).not.toBeNull();
    expect(localStorage.getItem(cacheKeys[1])).toBeNull();
    expect(localStorage.getItem(cacheKeys[2])).not.toBeNull();
    expect(new Set(authorityMarkerCacheKeys()))
      .toEqual(new Set([cacheKeys[0], cacheKeys[2], futureCacheKey]));
    expect(localStorage.getItem(futureCacheKey)).toBe(futureRaw);
    expect(localStorage.getItem(futureMarkerKey)).not.toBeNull();
    for (const [key, value] of preservedEntries) {
      expect(localStorage.getItem(key)).toBe(value);
    }
    expect(cacheStorageDelete).not.toHaveBeenCalled();
  });

  it('keeps one N-1 journal marker through repeated current-generation refreshes', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const releases = [
      { ...CURRENT_RELEASE, modelRevision: 5, dataGenerationId: 'journal-generation-a' },
      { ...CURRENT_RELEASE, modelRevision: 6, dataGenerationId: 'journal-generation-b' },
      { ...CURRENT_RELEASE, modelRevision: 7, dataGenerationId: 'journal-generation-c' },
    ];
    const payloads = releases.map((release) => {
      const data = apiWeatherData([
        hour(new Date(NOW + 12 * 60 * 60 * 1000).toISOString()),
      ]);
      data.sources.release = release;
      return data;
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const serve = async (payload: WeatherData, requestOffsetMs: number) => {
      now.mockReturnValue(NOW + requestOffsetMs);
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), {
        status: 200,
        headers: releaseHeaders(payload.sources.release!),
      }));
      await loadCachedWeatherData(CURRENT_LOCATION, { preferWorker: true });
    };

    await serve(payloads[0], 0);
    for (let refresh = 1; refresh <= 10; refresh += 1) {
      await serve(payloads[1], refresh * 1_000);
    }
    const firstKey = forecastReleaseCacheKey(CURRENT_LOCATION, releases[0]);
    const secondKey = forecastReleaseCacheKey(CURRENT_LOCATION, releases[1]);
    expect(new Set(authorityMarkerCacheKeys())).toEqual(new Set([firstKey, secondKey]));
    expect(authorityMarkerCacheKeys()).toHaveLength(8);

    await serve(payloads[2], 11_000);
    const thirdKey = forecastReleaseCacheKey(CURRENT_LOCATION, releases[2]);
    expect(localStorage.getItem(firstKey)).toBeNull();
    expect(localStorage.getItem(secondKey)).not.toBeNull();
    expect(localStorage.getItem(thirdKey)).not.toBeNull();
    expect(new Set(authorityMarkerCacheKeys())).toEqual(new Set([secondKey, thirdKey]));
    expect(authorityMarkerCacheKeys().length).toBeLessThanOrEqual(8);
  });

  it('ignores a pre-hardening partially scoped API slot', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const stamped = apiWeatherData([
      hour(new Date(NOW + 60 * 60 * 1000).toISOString()),
    ]);
    const weakKey = `${LEGACY_CACHE_KEY}_api${FORECAST_API_SCHEMA_VERSION}_generation_${CURRENT_RELEASE.dataGenerationId}`;
    const raw = JSON.stringify(stamped);
    localStorage.setItem(weakKey, raw);

    expect(await loadCachedWeatherData(CURRENT_LOCATION, { localOnly: true }))
      .toEqual({ data: null, from: null });
    expect(localStorage.getItem(weakKey)).toBe(raw);
  });

  it('retains a release-stamped legacy slot as non-authoritative offline recovery', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const stamped = apiWeatherData([
      hour(new Date(NOW + 60 * 60 * 1000).toISOString()),
    ]);
    const legacyVersionKey = `${LEGACY_CACHE_KEY}_v${CURRENT_RELEASE.payloadVersion}`;
    localStorage.setItem(legacyVersionKey, JSON.stringify(stamped));

    expect(await loadCachedWeatherData(CURRENT_LOCATION, { localOnly: true }))
      .toEqual({ data: stamped, from: 'local' });
    expect(localStorage.getItem(API_CACHE_KEY)).toBeNull();
  });

  it('does not let a ready=false N-1 availability response demote exact offline authority', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const exact = apiWeatherData([hour(new Date(NOW + 2 * 60 * 60 * 1000).toISOString())]);
    exact.sources.fetchedAt = new Date(NOW - 60 * 60 * 1000).toISOString();
    const prior = apiWeatherData([hour(new Date(NOW + 3 * 60 * 60 * 1000).toISOString())]);
    prior.sources.release = {
      ...CURRENT_RELEASE,
      modelRevision: CURRENT_RELEASE.modelRevision - 1,
      dataGenerationId: 'api1-model6',
    };
    prior.sources.fetchedAt = new Date(NOW).toISOString();
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(exact), {
      status: 200,
      headers: releaseHeaders(exact.sources.release!),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await loadCachedWeatherData(CURRENT_LOCATION, { preferWorker: true });
    now.mockReturnValue(NOW + 1_000);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(prior), {
      status: 200,
      // Header identity describes the candidate target; the body is the
      // audited prior generation available while that target propagates.
      headers: releaseHeaders(CURRENT_RELEASE, false),
    }));
    const fallback = await loadCachedWeatherData(CURRENT_LOCATION, { preferWorker: true });

    expect(fallback).toEqual({ data: prior, from: 'worker', serverFallback: true });
    expect(await loadCachedWeatherData(CURRENT_LOCATION, { localOnly: true }))
      .toEqual({ data: exact, from: 'local' });
  });

  it('does not let an unproven cross-generation response demote exact authority', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const exact = apiWeatherData([hour(new Date(NOW + 2 * 60 * 60 * 1000).toISOString())]);
    exact.sources.fetchedAt = new Date(NOW - 60 * 60 * 1000).toISOString();
    const unprovenPrior = apiWeatherData([
      hour(new Date(NOW + 3 * 60 * 60 * 1000).toISOString()),
    ]);
    unprovenPrior.sources.release = {
      ...CURRENT_RELEASE,
      modelRevision: CURRENT_RELEASE.modelRevision - 1,
      dataGenerationId: 'api1-model6',
    };
    unprovenPrior.sources.fetchedAt = new Date(NOW).toISOString();
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(exact), {
      status: 200,
      headers: releaseHeaders(exact.sources.release!),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await loadCachedWeatherData(CURRENT_LOCATION, { preferWorker: true });
    now.mockReturnValue(NOW + 1_000);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(unprovenPrior), {
      status: 200,
      // No release/readiness headers: the response is usable, never authority.
      headers: { 'Content-Type': 'application/json' },
    }));

    expect(await loadCachedWeatherData(CURRENT_LOCATION, { preferWorker: true }))
      .toEqual({ data: unprovenPrior, from: 'worker', serverFallback: true });
    expect(await loadCachedWeatherData(CURRENT_LOCATION, { localOnly: true }))
      .toEqual({ data: exact, from: 'local' });
  });

  it('does not let an earlier-started late response reverse cross-tab generation authority', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const slowPrevious = apiWeatherData([hour(new Date(NOW + 3 * 60 * 60 * 1000).toISOString())]);
    slowPrevious.sources.release = {
      ...CURRENT_RELEASE,
      modelRevision: CURRENT_RELEASE.modelRevision - 1,
      dataGenerationId: 'api1-model6',
    };
    const current = apiWeatherData([hour(new Date(NOW + 2 * 60 * 60 * 1000).toISOString())]);
    let resolveSlow!: (response: Response) => void;
    const slowResponse = new Promise<Response>((resolve) => {
      resolveSlow = resolve;
    });
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => slowResponse)
      .mockResolvedValueOnce(new Response(JSON.stringify(current), {
        status: 200,
        headers: releaseHeaders(current.sources.release!),
      }));
    vi.stubGlobal('fetch', fetchMock);

    const earlierRequest = loadCachedWeatherData(CURRENT_LOCATION, { preferWorker: true });
    await Promise.resolve();
    now.mockReturnValue(NOW + 1_000);
    const laterRequest = loadCachedWeatherData(CURRENT_LOCATION, { preferWorker: true });
    expect(await laterRequest).toEqual({ data: current, from: 'worker', serverAuthority: true });

    resolveSlow(new Response(JSON.stringify(slowPrevious), {
      status: 200,
      headers: releaseHeaders(slowPrevious.sources.release!),
    }));
    expect(await earlierRequest).toEqual({ data: slowPrevious, from: 'worker', serverAuthority: true });

    expect(await loadCachedWeatherData(CURRENT_LOCATION, { localOnly: true }))
      .toEqual({ data: current, from: 'local' });
  });

  it('uses request-start order when cross-tab completion changes the N-1 GC boundary', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const oldest = apiWeatherData([
      hour(new Date(NOW + 4 * 60 * 60 * 1000).toISOString()),
    ]);
    oldest.sources.release = {
      ...CURRENT_RELEASE,
      modelRevision: CURRENT_RELEASE.modelRevision - 2,
      dataGenerationId: 'cross-tab-oldest',
    };
    const slowPrevious = apiWeatherData([
      hour(new Date(NOW + 3 * 60 * 60 * 1000).toISOString()),
    ]);
    slowPrevious.sources.release = {
      ...CURRENT_RELEASE,
      modelRevision: CURRENT_RELEASE.modelRevision - 1,
      dataGenerationId: 'cross-tab-previous',
    };
    const current = apiWeatherData([
      hour(new Date(NOW + 2 * 60 * 60 * 1000).toISOString()),
    ]);
    current.sources.release = {
      ...CURRENT_RELEASE,
      dataGenerationId: 'cross-tab-current',
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(oldest), {
      status: 200,
      headers: releaseHeaders(oldest.sources.release!),
    }));
    vi.stubGlobal('fetch', fetchMock);
    await loadCachedWeatherData(CURRENT_LOCATION, { preferWorker: true });

    let resolveSlow!: (response: Response) => void;
    const slowResponse = new Promise<Response>((resolve) => {
      resolveSlow = resolve;
    });
    now.mockReturnValue(NOW + 1_000);
    fetchMock.mockImplementationOnce(() => slowResponse);
    const earlierRequest = loadCachedWeatherData(CURRENT_LOCATION, { preferWorker: true });
    await Promise.resolve();

    now.mockReturnValue(NOW + 2_000);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(current), {
      status: 200,
      headers: releaseHeaders(current.sources.release!),
    }));
    expect(await loadCachedWeatherData(CURRENT_LOCATION, { preferWorker: true }))
      .toEqual({ data: current, from: 'worker', serverAuthority: true });

    resolveSlow(new Response(JSON.stringify(slowPrevious), {
      status: 200,
      headers: releaseHeaders(slowPrevious.sources.release!),
    }));
    expect(await earlierRequest)
      .toEqual({ data: slowPrevious, from: 'worker', serverAuthority: true });

    const oldestKey = forecastReleaseCacheKey(CURRENT_LOCATION, oldest.sources.release!);
    const previousKey = forecastReleaseCacheKey(CURRENT_LOCATION, slowPrevious.sources.release!);
    const currentKey = forecastReleaseCacheKey(CURRENT_LOCATION, current.sources.release!);
    expect(localStorage.getItem(oldestKey)).toBeNull();
    expect(localStorage.getItem(previousKey)).not.toBeNull();
    expect(localStorage.getItem(currentKey)).not.toBeNull();
    expect(new Set(authorityMarkerCacheKeys())).toEqual(new Set([previousKey, currentKey]));
    expect(await loadCachedWeatherData(CURRENT_LOCATION, { localOnly: true }))
      .toEqual({ data: current, from: 'local' });
  });

  it('serializes authoritative payload, marker and GC writes across browser tabs', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const lockRequest = vi.fn(async (
      _name: string,
      callback: () => string | null,
    ) => callback());
    vi.stubGlobal('navigator', { locks: { request: lockRequest } });
    const payload = apiWeatherData([
      hour(new Date(NOW + 2 * 60 * 60 * 1000).toISOString()),
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), {
      status: 200,
      headers: releaseHeaders(payload.sources.release!),
    })));

    expect(await loadCachedWeatherData(CURRENT_LOCATION, { preferWorker: true }))
      .toEqual({ data: payload, from: 'worker', serverAuthority: true });
    expect(lockRequest).toHaveBeenCalledOnce();
    expect(lockRequest.mock.calls[0][0]).toBe(
      `frank-forecast-cache:${CURRENT_LOCATION.id}:config${CURRENT_LOCATION.forecastConfigRevision}`,
    );
    expect(localStorage.getItem(API_CACHE_KEY)).not.toBeNull();
    expect(authorityMarkerCacheKeys()).toEqual([API_CACHE_KEY]);
  });

  it('never lets an older Worker build regress the durable offline cache', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const newerLocal = apiWeatherData([hour(new Date(NOW + 3 * 60 * 60 * 1000).toISOString())]);
    newerLocal.sources.fetchedAt = new Date(NOW - 30 * 60 * 1000).toISOString();
    newerLocal.sources.cacheHealth = {
      status: 'current',
      lastAttemptAt: newerLocal.sources.fetchedAt,
    };
    saveCachedWeatherData(newerLocal, CURRENT_LOCATION);

    const olderWorker = apiWeatherData([hour(new Date(NOW + 2 * 60 * 60 * 1000).toISOString())]);
    olderWorker.sources.fetchedAt = new Date(NOW - 2 * 60 * 60 * 1000).toISOString();
    olderWorker.sources.cacheHealth = {
      status: 'stale',
      lastAttemptAt: new Date(NOW).toISOString(),
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(olderWorker), {
      status: 200,
      headers: releaseHeaders(olderWorker.sources.release!),
    })));

    const loaded = await loadCachedWeatherData(CURRENT_LOCATION, { preferWorker: true });
    expect(loaded).toEqual({ data: olderWorker, from: 'worker', serverAuthority: true });
    expect(JSON.parse(localStorage.getItem(API_CACHE_KEY)!).sources.fetchedAt).toBe(newerLocal.sources.fetchedAt);

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
    localStorage.setItem(LEGACY_CACHE_KEY, JSON.stringify(legacy));

    saveCachedWeatherData(versioned, CURRENT_LOCATION);

    expect(JSON.parse(localStorage.getItem(CACHE_KEY)!).sources.payloadVersion).toBe(versioned.sources.payloadVersion);
    expect(JSON.parse(localStorage.getItem(LEGACY_CACHE_KEY)!).sources.payloadVersion).toBeUndefined();
  });

  it('keeps the legacy slot intact so an older open app survives a contract upgrade', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const oldClientCopy = weatherData([hour(new Date(NOW + 60 * 60 * 1000).toISOString())]);
    localStorage.setItem(LEGACY_CACHE_KEY, JSON.stringify(oldClientCopy));

    const currentClientCopy = structuredClone(oldClientCopy);
    currentClientCopy.sources.payloadVersion = FORECAST_PAYLOAD_VERSION;
    currentClientCopy.sources.fetchedAt = new Date(NOW).toISOString();
    saveCachedWeatherData(currentClientCopy, CURRENT_LOCATION);

    expect(JSON.parse(localStorage.getItem(LEGACY_CACHE_KEY)!)).toEqual(oldClientCopy);
    expect(JSON.parse(localStorage.getItem(`${LEGACY_CACHE_KEY}_v${FORECAST_PAYLOAD_VERSION}`)!))
      .toEqual(currentClientCopy);
  });

  it('chooses the newest usable copy across contract versions', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const older = weatherData([hour(new Date(NOW + 60 * 60 * 1000).toISOString())]);
    saveCachedWeatherData(older, CURRENT_LOCATION);

    const newer = structuredClone(older);
    newer.sources.payloadVersion = FORECAST_PAYLOAD_VERSION;
    newer.sources.fetchedAt = new Date(NOW).toISOString();
    newer.sources.cacheHealth = { status: 'current', lastAttemptAt: newer.sources.fetchedAt };
    saveCachedWeatherData(newer, CURRENT_LOCATION);

    const loaded = await loadCachedWeatherData(CURRENT_LOCATION, { localOnly: true });
    expect(loaded.data?.sources.payloadVersion).toBe(FORECAST_PAYLOAD_VERSION);
    expect(loaded.data?.sources.fetchedAt).toBe(newer.sources.fetchedAt);
  });

  it('does not let one corrupt version mask another usable offline copy', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    localStorage.setItem(`${LEGACY_CACHE_KEY}_v${FORECAST_PAYLOAD_VERSION}`, '{not-json');
    const valid = weatherData([hour(new Date(NOW + 60 * 60 * 1000).toISOString())]);
    saveCachedWeatherData(valid, CURRENT_LOCATION);

    const loaded = await loadCachedWeatherData(CURRENT_LOCATION, { localOnly: true });
    expect(loaded.data?.sources.payloadVersion).toBe(FORECAST_PAYLOAD_VERSION);
  });

  it('ignores a future-version browser slot and retains the compatible slot for offline recovery', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const compatible = weatherData([hour(new Date(NOW + 60 * 60 * 1000).toISOString())]);
    compatible.sources.payloadVersion = FORECAST_PAYLOAD_VERSION;
    compatible.sources.fetchedAt = new Date(NOW - 5 * 60 * 1000).toISOString();
    compatible.sources.cacheHealth = { status: 'current', lastAttemptAt: compatible.sources.fetchedAt };
    saveCachedWeatherData(compatible, CURRENT_LOCATION);

    const future = structuredClone(compatible);
    future.sources.payloadVersion = FORECAST_PAYLOAD_VERSION + 1;
    future.sources.fetchedAt = new Date(NOW).toISOString();
    future.sources.cacheHealth = { status: 'current', lastAttemptAt: future.sources.fetchedAt };
    const compatibleKey = `${LEGACY_CACHE_KEY}_v${FORECAST_PAYLOAD_VERSION}`;
    const futureKey = `${LEGACY_CACHE_KEY}_v${FORECAST_PAYLOAD_VERSION + 1}`;
    const compatibleRaw = localStorage.getItem(compatibleKey);
    const futureRaw = JSON.stringify(future);
    localStorage.setItem(futureKey, futureRaw);

    const loaded = await loadCachedWeatherData(CURRENT_LOCATION, { localOnly: true });

    expect(loaded).toEqual({ data: compatible, from: 'local' });
    expect(localStorage.getItem(compatibleKey)).toBe(compatibleRaw);
    expect(localStorage.getItem(futureKey)).toBe(futureRaw);
  });

  it('uses one bounded prepared-snapshot timeout with or without a local fallback', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const worker = weatherData([hour(new Date(NOW + 60 * 60 * 1000).toISOString())]);
    worker.sources.fetchedAt = new Date(NOW).toISOString();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => structuredClone(worker),
    }));

    await loadCachedWeatherData(CURRENT_LOCATION, { preferWorker: true });
    expect(timeout).toHaveBeenLastCalledWith(12_000);

    const local = structuredClone(worker);
    local.sources.fetchedAt = new Date(NOW + 60_000).toISOString();
    local.sources.cacheHealth = { status: 'current', lastAttemptAt: local.sources.fetchedAt };
    saveCachedWeatherData(local, CURRENT_LOCATION);

    await loadCachedWeatherData(CURRENT_LOCATION, { preferWorker: true });
    expect(timeout).toHaveBeenLastCalledWith(12_000);

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
    expect(loaded).toEqual({ data: lastGood, from: 'local', failureKind: 'response' });

    const stillLastGood = await loadCachedWeatherData(CURRENT_LOCATION);
    expect(stillLastGood).toEqual({ data: lastGood, from: 'local' });
  });
});
