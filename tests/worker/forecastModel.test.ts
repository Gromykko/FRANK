import { describe, expect, it } from 'vitest';
import locationData from '../../src/config/locations.json';
import type { ForecastLocation } from '../../src/config/locationTypes';
import {
  FORECAST_SOURCE_POLICY,
  assembleForecastFromSources,
  canUseMetFallback,
  degradedMarineSourcesAfterProbe,
  mapMetPayload,
  degradedSourcesAfterProbe,
  heldMarineFallback,
  isMetRawCache,
  isMarineRunWithinFallbackAge,
  isTransientProviderFailure,
  marineProbeDecision,
  marineSourcesDueForProbe,
  retainedActiveWarnings,
} from '../../worker/forecastModel';
import { MARINE_INGREDIENT_CACHE_SCHEMA_VERSION } from '../../src/features/forecast/releaseContract';

const LOCATION = locationData[0] as ForecastLocation;
const NOW = Date.parse('2026-08-20T12:30:00Z');
const RUN = '2026-08-20T120000Z';
const HOUR = '2026-08-20T12:00:00.000Z';
const HOUR_MS = Date.parse(HOUR);

describe('generation-owned forecast model', () => {
  it('assembles exact values, provider labels, run provenance, and degradation', () => {
    const result = assembleForecastFromSources(LOCATION, {
      met: {
        weatherSeries: [{
          time: HOUR,
          timeMs: HOUR_MS,
          tempAir: 17.5,
          precipitation: 0.2,
          symbolCode: 'partlycloudy_day',
          weatherCode: 2,
          windSpeed: 4.2,
          windDirection: 91,
          windGust: 6.4,
        }],
        blocks: [],
        weatherExpires: '2026-08-20T13:00:00.000Z',
        weatherLastModified: 'Thu, 20 Aug 2026 12:00:00 GMT',
        fallback: true,
        degraded: true,
        busy: true,
      },
      water: {
        series: [{
          time: HOUR,
          timeMs: HOUR_MS,
          tempWater: 15.4,
          tideLevel: 0.18,
          currentSpeed: 0.32,
          currentDirection: 245,
        }],
        instance: { collection: 'dkss_idw', id: RUN },
        fallback: false,
        providerContacted: true,
      },
      wave: {
        series: [{
          time: HOUR,
          timeMs: HOUR_MS,
          waveHeight: 0.42,
          waveDirection: 110,
          wavePeriod: 3.8,
        }],
        instance: { collection: 'wam_nsb', id: RUN },
        fallback: true,
        providerContacted: true,
        notReady: true,
      },
      warnings: [],
    }, NOW);

    expect(result).toMatchObject({
      degradedSources: ['weather'],
      degradedBusy: true,
      degradedBusyProvider: 'weather',
      providerContacted: true,
      marineInstances: {
        water: { collection: 'dkss_idw', id: RUN },
        waves: { collection: 'wam_nsb', id: RUN },
      },
      forecast: {
        hourly: [{
          time: HOUR,
          tempAir: 17.5,
          precipitation: 0.2,
          symbolCode: 'partlycloudy_day',
          weatherCode: 2,
          windSpeed: 4.2,
          windDirection: 91,
          windGust: 6.4,
          waveHeight: 0.42,
          waveDirection: 110,
          wavePeriod: 3.8,
          tempWater: 15.4,
          tideLevel: 0.18,
          currentSpeed: 0.32,
          currentDirection: 245,
          weatherSource: 'met-locationforecast',
          marineSource: 'dmi-dkss-wam',
        }],
        sources: {
          weather: 'MET Norway Locationforecast',
          waves: 'DMI wam_nsb',
          water: 'DMI dkss_idw',
          coordinate: LOCATION.coordinate,
          fetchedAt: '2026-08-20T12:30:00.000Z',
        },
      },
    });
    // A newly listed-but-unpublished WAM run uses held data without claiming a
    // provider outage. Only the genuinely failed MET source is degraded.
    expect(result.degradedSources).not.toContain('waves');
  });

  it('keeps held marine sources independent and preserves their actual run ids', () => {
    const storedWater = {
      schemaVersion: MARINE_INGREDIENT_CACHE_SCHEMA_VERSION,
      locationId: LOCATION.id,
      forecastConfigRevision: LOCATION.forecastConfigRevision,
      collection: 'dkss_idw',
      id: '2026-08-20T060000Z',
      series: [{ time: HOUR, timeMs: HOUR_MS, tideLevel: 0.1 }],
    };
    const requested = { collection: 'dkss_idw', id: RUN };
    expect(heldMarineFallback(
      storedWater,
      undefined,
      undefined,
      requested,
      { providerContacted: false, degraded: true, busy: true },
      NOW,
    )).toMatchObject({
      instance: { collection: 'dkss_idw', id: '2026-08-20T060000Z' },
      fallback: true,
      providerContacted: false,
      degraded: true,
      busy: true,
    });

    const seedRun = { collection: 'wam_nsb', id: '2026-08-20T060000Z' };
    expect(heldMarineFallback(
      null,
      [{ time: HOUR, timeMs: HOUR_MS, waveHeight: 0.3 }],
      seedRun,
      { collection: 'wam_nsb', id: RUN },
      { providerContacted: true, notReady: true },
      NOW,
    )).toMatchObject({
      instance: seedRun,
      fallback: true,
      providerContacted: true,
      notReady: true,
    });
  });

  it('enforces model-owned age, source-selection, and transient-fallback boundaries', () => {
    const exactlyTwelveHoursOld = {
      collection: 'dkss_idw',
      id: '2026-08-20T003000Z',
    };
    expect(isMarineRunWithinFallbackAge(exactlyTwelveHoursOld, NOW)).toBe(true);
    expect(isMarineRunWithinFallbackAge(exactlyTwelveHoursOld, NOW + 1)).toBe(false);

    expect(canUseMetFallback({
      lastModified: 'Thu, 20 Aug 2026 06:30:00 GMT',
      body: { properties: { timeseries: [] } },
    }, NOW - 1)).toBe(true);
    expect(canUseMetFallback({
      lastModified: 'Thu, 20 Aug 2026 06:30:00 GMT',
      body: { properties: { timeseries: [] } },
    }, NOW)).toBe(false);

    expect(isTransientProviderFailure({ status: 429 })).toBe(true);
    expect(isTransientProviderFailure({ status: 503 })).toBe(true);
    expect(isTransientProviderFailure({ status: 404 })).toBe(false);
    expect(isTransientProviderFailure({ networkTypeError: true })).toBe(true);
    expect(isTransientProviderFailure({ errorName: 'SyntaxError' })).toBe(false);
  });

  it('rejects a future raw MET Last-Modified before it can drive perpetual 304s', () => {
    const retained = (lastModified: string) => ({
      locationId: LOCATION.id,
      forecastConfigRevision: LOCATION.forecastConfigRevision,
      lastModified,
      body: { properties: { timeseries: [] } },
    });

    expect(isMetRawCache(retained('Thu, 20 Aug 2026 12:35:00 GMT'), LOCATION, NOW)).toBe(true);
    expect(isMetRawCache(retained('Thu, 20 Aug 2026 12:35:01 GMT'), LOCATION, NOW)).toBe(false);
    expect(isMetRawCache(retained('Fri, 01 Jan 3000 00:00:00 GMT'), LOCATION, NOW)).toBe(false);
  });

  it('uses the measured DMI publication gate and retains only active warnings', () => {
    const decision = marineProbeDecision({
      water: { collection: 'dkss_idw', id: RUN },
      waves: { collection: 'wam_nsb', id: RUN },
    }, undefined, Date.parse('2026-08-20T20:00:00Z'));
    expect(decision).toEqual({
      shouldProbe: false,
      nextProbeAtMs: Date.parse('2026-08-20T21:45:00Z'),
      reason: 'publication-window',
    });
    expect(FORECAST_SOURCE_POLICY.marineFallbackMaxAgeMs).toBe(12 * 60 * 60 * 1000);

    const warning = (expires: string) => ({
      event: 'Wind',
      colour: 'yellow' as const,
      effective: '2026-08-20T10:00:00Z',
      expires,
      url: 'https://example.invalid/warning',
    });
    expect(retainedActiveWarnings([
      warning('2026-08-20T12:29:59Z'),
      warning('2026-08-20T12:30:01Z'),
    ], NOW)).toEqual([warning('2026-08-20T12:30:01Z')]);
  });

  it('classifies staggered water and wave runs against their own schedules', () => {
    const wavesLag = {
      water: { collection: 'dkss_idw', id: '2026-08-20T180000Z' },
      waves: { collection: 'wam_nsb', id: '2026-08-20T120000Z' },
    };
    const waterLag = {
      water: { collection: 'dkss_idw', id: '2026-08-20T120000Z' },
      waves: { collection: 'wam_nsb', id: '2026-08-20T180000Z' },
    };

    expect(marineSourcesDueForProbe(
      wavesLag,
      Date.parse('2026-08-20T20:59:59.999Z'),
    )).toEqual([]);
    expect(marineSourcesDueForProbe(
      waterLag,
      Date.parse('2026-08-20T21:44:59.999Z'),
    )).toEqual([]);
    expect(marineSourcesDueForProbe(
      wavesLag,
      Date.parse('2026-08-20T21:00:00.000Z'),
    )).toEqual(['waves']);
    expect(marineSourcesDueForProbe(
      waterLag,
      Date.parse('2026-08-20T21:45:00.000Z'),
    )).toEqual(['water']);

    // Water caused the combined probe. A failed carry-over for the ahead WAM
    // run is not a wave degradation until WAM's own next publication is due.
    expect(degradedMarineSourcesAfterProbe(
      waterLag,
      false,
      ['waves'],
      Date.parse('2026-08-20T21:45:00.000Z'),
    )).toEqual([]);
    expect(degradedMarineSourcesAfterProbe(
      waterLag,
      false,
      ['water'],
      Date.parse('2026-08-20T21:45:00.000Z'),
    )).toEqual(['water']);
    expect(degradedMarineSourcesAfterProbe(
      waterLag,
      true,
      [],
      Date.parse('2026-08-20T21:45:00.000Z'),
    )).toEqual(['water']);
    expect(marineSourcesDueForProbe({
      water: { collection: 'dkss_idw', id: 'invalid' },
      waves: { collection: 'wam_nsb', id: '2026-08-21T000001Z' },
    }, Date.parse('2026-08-21T00:00:00Z'))).toEqual(['water', 'waves']);
  });

  it('marks a failed marine catalogue probe without rewriting existing source order', () => {
    expect(degradedSourcesAfterProbe(['weather', 'water'], true))
      .toEqual(['weather', 'water', 'waves']);
  });
});

// Expires drives `weatherStale`, which decides whether a tick rebuilds and
// writes. A header we cannot act on therefore sets the app's whole KV write
// rate, and Number.isFinite happily accepts a timestamp in the past.
describe('mapMetPayload expiry clamping', () => {
  const NOW = Date.parse('2026-08-22T12:00:00.000Z');
  const body = { properties: { timeseries: [] } } as unknown as Parameters<typeof mapMetPayload>[0];
  const expiryMs = (expires: number) =>
    Date.parse(mapMetPayload(body, null, expires, NOW).weatherExpires) - NOW;

  it('refuses an Expires that has already lapsed', () => {
    // One misconfigured upstream would otherwise mean rebuild + write on every
    // selected tick: 360 writes/city/day and 1,440/day across four cities,
    // against a 1,000/day allowance.
    expect(expiryMs(NOW - 60_000)).toBe(FORECAST_SOURCE_POLICY.metDefaultTtlMs);
    expect(expiryMs(Date.parse('0'))).toBe(FORECAST_SOURCE_POLICY.metDefaultTtlMs);
  });

  it('refuses an Expires far enough ahead to freeze the forecast', () => {
    expect(expiryMs(NOW + 365 * 24 * 60 * 60_000)).toBe(FORECAST_SOURCE_POLICY.metMaxTtlMs);
    // Inside the 3-hour data-age alarm, so a frozen forecast still refreshes
    // before /health would have to report the freeze.
    expect(FORECAST_SOURCE_POLICY.metMaxTtlMs).toBeLessThan(3 * 60 * 60_000);
  });

  it('honours a plausible Expires unchanged', () => {
    expect(expiryMs(NOW + 45 * 60_000)).toBe(45 * 60_000);
  });

  it('falls back to the default when the header is missing or unparseable', () => {
    expect(expiryMs(Number.NaN)).toBe(FORECAST_SOURCE_POLICY.metDefaultTtlMs);
  });
});
