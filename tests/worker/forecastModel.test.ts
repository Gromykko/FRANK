import { describe, expect, it } from 'vitest';
import locationData from '../../src/config/locations.json';
import type { ForecastLocation } from '../../src/config/locationTypes';
import {
  FORECAST_SOURCE_POLICY,
  assembleForecastFromSources,
  canUseMetFallback,
  degradedSourcesAfterProbe,
  heldMarineFallback,
  isMarineRunWithinFallbackAge,
  isTransientProviderFailure,
  marineProbeDecision,
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
        notReady: true,
      },
      warnings: [],
    }, NOW);

    expect(result).toMatchObject({
      degradedSources: ['weather'],
      degradedBusy: true,
      degradedBusyProvider: 'weather',
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
      { degraded: true, busy: true },
      NOW,
    )).toMatchObject({
      instance: { collection: 'dkss_idw', id: '2026-08-20T060000Z' },
      fallback: true,
      degraded: true,
      busy: true,
    });

    const seedRun = { collection: 'wam_nsb', id: '2026-08-20T060000Z' };
    expect(heldMarineFallback(
      null,
      [{ time: HOUR, timeMs: HOUR_MS, waveHeight: 0.3 }],
      seedRun,
      { collection: 'wam_nsb', id: RUN },
      { notReady: true },
      NOW,
    )).toMatchObject({
      instance: seedRun,
      fallback: true,
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

  it('uses the official publication window and retains only active warnings', () => {
    const decision = marineProbeDecision({
      water: { collection: 'dkss_idw', id: RUN },
      waves: { collection: 'wam_nsb', id: RUN },
    }, undefined, Date.parse('2026-08-20T20:00:00Z'));
    expect(decision).toEqual({
      shouldProbe: false,
      nextProbeAtMs: Date.parse('2026-08-20T21:30:00Z'),
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

  it('marks a failed marine catalogue probe without rewriting existing source order', () => {
    expect(degradedSourcesAfterProbe(['weather', 'water'], true))
      .toEqual(['weather', 'water', 'waves']);
  });
});
