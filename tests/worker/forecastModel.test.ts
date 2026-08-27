import { describe, expect, it } from 'vitest';
import locationData from '../../src/config/locations.json';
import type { ForecastLocation } from '../../src/config/locationTypes';
import type { MarineSeriesResult } from '../../worker/domain';
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
  latestInstanceFromResponse,
  marineInstancesEqual,
  marineProbeDecision,
  marineSourcesDueForProbe,
  marineSourcesMissingExpectedAdvance,
  marineSourcesOverdueForRefresh,
  parseDmiInstanceMs,
  retainedActiveWarnings,
} from '../../worker/forecastModel';
import { completeMarineEnvelope } from './marineTestData';

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
    const storedWater = completeMarineEnvelope(
      LOCATION,
      'water',
      '2026-08-20T060000Z',
    );
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
      id: '2026-08-20T000000Z',
    };
    const fallbackBoundary = Date.parse('2026-08-20T12:00:00.000Z');
    expect(isMarineRunWithinFallbackAge(exactlyTwelveHoursOld, fallbackBoundary)).toBe(true);
    expect(isMarineRunWithinFallbackAge(exactlyTwelveHoursOld, fallbackBoundary + 1)).toBe(false);

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

  // Gates are tuned against observation, so derive rather than restate them.
  const dueAt = (completeDelayMs: number, runMs: number) => runMs
    + FORECAST_SOURCE_POLICY.dmiRunCycleMs
    + completeDelayMs
    - FORECAST_SOURCE_POLICY.dmiPublicationLeadMs;

  it('uses the published DMI publication gate and retains only active warnings', () => {
    const decision = marineProbeDecision({
      water: { collection: 'dkss_idw', id: RUN },
      waves: { collection: 'wam_nsb', id: RUN },
    }, undefined, Date.parse('2026-08-20T20:00:00Z'));
    // WAM publishes first, so the combined check opens on WAM's own gate rather
    // than withholding it until the slower DKSS collection is expected.
    expect(decision).toEqual({
      shouldProbe: false,
      nextProbeAtMs: dueAt(FORECAST_SOURCE_POLICY.dmiWamNsbCompleteDelayMs, Date.parse(HOUR)),
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

    const wavesDueAt = dueAt(FORECAST_SOURCE_POLICY.dmiWamNsbCompleteDelayMs, Date.parse('2026-08-20T12:00:00.000Z'));
    const waterDueAt = dueAt(FORECAST_SOURCE_POLICY.dmiDkssCompleteDelayMs, Date.parse('2026-08-20T12:00:00.000Z'));

    expect(marineSourcesDueForProbe(wavesLag, wavesDueAt - 1)).toEqual([]);
    expect(marineSourcesDueForProbe(waterLag, waterDueAt - 1)).toEqual([]);
    expect(marineSourcesDueForProbe(wavesLag, wavesDueAt)).toEqual(['waves']);
    expect(marineSourcesDueForProbe(waterLag, waterDueAt)).toEqual(['water']);

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
    )).toEqual([]);
    expect(degradedMarineSourcesAfterProbe(
      waterLag,
      false,
      ['water'],
      Date.parse('2026-08-20T22:20:00.000Z'),
    )).toEqual(['water']);
    expect(degradedMarineSourcesAfterProbe(
      waterLag,
      false,
      ['water'],
      Date.parse('2026-08-20T21:20:00.000Z'),
      false,
      { water: 'unavailable' },
    )).toEqual(['water']);
    expect(degradedMarineSourcesAfterProbe(
      waterLag,
      false,
      ['water'],
      Date.parse('2026-08-20T22:19:59.999Z'),
      false,
      { water: 'busy' },
    )).toEqual([]);
    expect(degradedMarineSourcesAfterProbe(
      waterLag,
      false,
      ['water'],
      Date.parse('2026-08-20T22:20:00.000Z'),
      false,
      { water: 'busy' },
    )).toEqual(['water']);
    expect(degradedMarineSourcesAfterProbe(
      waterLag,
      false,
      ['water'],
      Date.parse('2026-08-20T22:19:59.999Z'),
      false,
      { water: 'not-ready' },
    )).toEqual([]);
    expect(degradedMarineSourcesAfterProbe(
      waterLag,
      true,
      [],
      Date.parse('2026-08-20T22:19:59.999Z'),
      false,
      {},
      true,
    )).toEqual([]);
    expect(degradedMarineSourcesAfterProbe(
      waterLag,
      true,
      [],
      Date.parse('2026-08-20T22:20:00.000Z'),
      false,
      {},
      true,
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

  it('separates the early probe gate from the fixed one-hour user-visible grace', () => {
    const held = {
      water: { collection: 'dkss_idw', id: '2026-08-20T120000Z' },
      waves: { collection: 'wam_nsb', id: '2026-08-20T120000Z' },
    };
    expect(FORECAST_SOURCE_POLICY.dmiPublicationGraceMs).toBe(60 * 60 * 1000);
    expect(marineSourcesDueForProbe(held, Date.parse('2026-08-20T20:35:00Z')))
      .toEqual(['waves']);
    expect(marineSourcesOverdueForRefresh(held, Date.parse('2026-08-20T21:44:59.999Z')))
      .toEqual([]);
    expect(marineSourcesOverdueForRefresh(held, Date.parse('2026-08-20T21:45:00Z')))
      .toEqual(['waves']);
    expect(marineSourcesOverdueForRefresh(held, Date.parse('2026-08-20T22:20:00Z')))
      .toEqual(['water', 'waves']);
  });

  it('keeps a source degraded when it advances only to another overdue run', () => {
    const previous = {
      water: { collection: 'dkss_idw', id: '2026-08-20T000000Z' },
      waves: { collection: 'wam_nsb', id: '2026-08-20T120000Z' },
    };
    const oneRunAhead = {
      ...previous,
      water: { collection: 'dkss_idw', id: '2026-08-20T060000Z' },
    };
    const caughtUp = {
      ...previous,
      water: { collection: 'dkss_idw', id: '2026-08-20T120000Z' },
    };
    const afterTwelveRunGrace = Date.parse('2026-08-20T16:20:00.000Z');

    expect(marineSourcesMissingExpectedAdvance(
      previous,
      oneRunAhead,
      afterTwelveRunGrace,
    )).toEqual(['water']);
    expect(marineSourcesMissingExpectedAdvance(
      previous,
      caughtUp,
      afterTwelveRunGrace,
    )).toEqual([]);
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

// A 429 on the water position leg sends us back to the independently complete
// run we already hold. During the bounded publication grace, retaining that
// known-good run is expected operation rather than proof of stale data; the
// unavailable candidate may differ and is never assumed byte-identical.
describe('a failed refresh call is not stale data', () => {
  const HOUR_2 = '2026-08-20T12:00:00.000Z';
  const CURRENT_RUN = '2026-08-20T120000Z';
  // 00:00 + 6h cycle + 3h20 DKSS + 60m publication grace = 10:20, so by 12:30
  // a newer run is genuinely overdue and this one IS behind.
  const BEHIND_RUN = '2026-08-20T000000Z';

  const assembleWithWater = (water: Omit<MarineSeriesResult, 'series'>) =>
    assembleForecastFromSources(LOCATION, {
      met: {
        weatherSeries: [{
          time: HOUR_2,
          timeMs: Date.parse(HOUR_2),
          tempAir: 17,
          precipitation: 0,
          symbolCode: 'clearsky_day',
          windSpeed: 4,
          windDirection: 90,
          windGust: 6,
        }],
        blocks: [],
        weatherExpires: '2026-08-20T13:00:00.000Z',
        weatherLastModified: 'Thu, 20 Aug 2026 12:00:00 GMT',
        fallback: false,
      },
      water: {
        series: [{
          time: HOUR_2,
          timeMs: Date.parse(HOUR_2),
          tempWater: 15,
          tideLevel: 0.1,
          currentSpeed: 0.3,
          currentDirection: 240,
        }],
        ...water,
      },
      wave: {
        series: [{
          time: HOUR_2,
          timeMs: Date.parse(HOUR_2),
          waveHeight: 0.4,
          waveDirection: 110,
          wavePeriod: 3.8,
        }],
        instance: { collection: 'wam_nsb', id: CURRENT_RUN },
        fallback: false,
        providerContacted: true,
      },
      warnings: [],
    }, NOW);

  it('does not degrade complete same-collection retention before its grace expires', () => {
    const result = assembleWithWater({
      instance: { collection: 'dkss_idw', id: CURRENT_RUN },
      fallback: true,
      sameCollectionAsRequested: true,
      providerContacted: false,
      degraded: true,
      busy: true,
    });
    expect(result.degradedSources).toEqual([]);
    // Busy must travel with it, or the same banner returns by another route.
    expect(result.degradedBusy).toBe(false);
    expect(result.degradedBusyProvider).toBeUndefined();
  });

  it('degrades a fallback without complete same-collection retention proof', () => {
    const result = assembleWithWater({
      instance: { collection: 'dkss_idw', id: CURRENT_RUN },
      fallback: true,
      // No sameCollectionAsRequested: a seed rebuild, a sibling collection, or an
      // empty stored series all arrive looking exactly like this.
      providerContacted: false,
      degraded: true,
      busy: true,
    });
    expect(result.degradedSources).toEqual(['water']);
    expect(result.degradedBusyProvider).toBe('marine');
  });

  it('still degrades a run a newer one was already due to replace', () => {
    const result = assembleWithWater({
      instance: { collection: 'dkss_idw', id: BEHIND_RUN },
      fallback: true,
      sameCollectionAsRequested: true,
      providerContacted: false,
      degraded: true,
      busy: true,
    });
    expect(result.degradedSources).toEqual(['water']);
  });
});

// The flag above is only worth anything if the real constructor sets it
// honestly. The raw ingredient key is per kind+location (marineIngredientKey),
// so the retained envelope can hold a different collection or run than the one
// requested, and dkss_idw/dkss_nsbs are different model areas whose values are
// not interchangeable at a matching timestamp.
describe('heldMarineFallback proves equivalence rather than assuming it', () => {
  const RUN_ID = '2026-08-20T120000Z';
  const REQUESTED = { collection: 'dkss_idw', id: RUN_ID };
  const point = { time: '2026-08-20T12:00:00.000Z', timeMs: Date.parse('2026-08-20T12:00:00.000Z'), tempWater: 15 };
  const envelope = (
    id = RUN_ID,
    collection = 'dkss_idw',
    over: Record<string, unknown> = {},
  ) => ({
    ...completeMarineEnvelope(LOCATION, 'water', id, collection),
    ...over,
  });
  const held = (stored: unknown) => heldMarineFallback(
    stored as never, [point], REQUESTED, REQUESTED,
    { providerContacted: false, degraded: true, busy: true }, NOW,
  );

  // The reachable case. An exact collection+run match never gets here at all -
  // fetchMarineSeries returns it early as fallback:false - so this helper only
  // ever sees a substitution of some kind, and the one that is harmless is an
  // OLDER RUN of the right collection. Whether that run is stale is judged
  // separately, by its own publication schedule.
  it('claims the collection for an older run of the same collection', () => {
    expect(held(envelope('2026-08-20T060000Z'))?.sameCollectionAsRequested).toBe(true);
  });

  it('refuses it for the sibling collection at the same timestamp', () => {
    // dkss_idw and dkss_nsbs are different model areas; a matching run
    // timestamp does not make their values interchangeable.
    expect(held(envelope(RUN_ID, 'dkss_nsbs'))?.sameCollectionAsRequested).toBe(false);
  });

  it('refuses it for an empty stored series', () => {
    expect(held(envelope(RUN_ID, 'dkss_idw', { series: [] }))?.sameCollectionAsRequested)
      .toBe(false);
  });

  it('refuses a retained series with a forged end stamp and a middle gap', () => {
    const corrupt = envelope();
    corrupt.series.splice(40, 1);
    corrupt.series.push({ ...corrupt.series.at(-1)! });
    expect(held(corrupt)?.sameCollectionAsRequested).toBe(false);
  });

  it('never claims it on the seed tier', () => {
    const result = held(null);
    expect(result?.fallback).toBe(true);
    expect(result?.sameCollectionAsRequested).toBeUndefined();
  });
});

describe('DMI catalogue time parsing', () => {
  it('rejects calendar-normalised run identifiers and accepts genuine dates', () => {
    for (const id of [
      '2026-02-30T120000Z',
      '2026-13-01T000000Z',
      '2026-01-32T000000Z',
      '2026-04-31T000000Z',
      '2026-02-29T060000Z',
      '2026-01-01T240000Z',
      '2026-01-01T126000Z',
      '2026-02-30T12:00:00Z',
    ]) {
      expect(parseDmiInstanceMs(id), id).toBeNaN();
    }

    expect(parseDmiInstanceMs('2028-02-29T060000Z'))
      .toBe(Date.parse('2028-02-29T06:00:00Z'));
    expect(parseDmiInstanceMs('2028-02-29T06:00:00.123Z'))
      .toBe(Date.parse('2028-02-29T06:00:00.123Z'));

    expect(latestInstanceFromResponse({
      instances: [
        { id: '2026-02-28T120000Z' },
        { id: '2026-02-30T120000Z' },
        { id: '2026-02-28T150000Z' },
      ],
    }, 'dkss_idw')).toEqual({ id: '2026-02-28T120000Z' });
  });

  it('carries a valid declared temporal end and leaves invalid metadata unknown', () => {
    const parsed = latestInstanceFromResponse({
      instances: [{
        id: '2026-08-20T120000Z',
        extent: { temporal: { interval: [[
          '2026-08-20T12:00:00Z',
          '2026-08-25T12:00:00Z',
        ]] } },
      }],
    }, 'dkss_idw');
    expect(parsed).toEqual({
      id: '2026-08-20T120000Z',
      declaredEndMs: Date.parse('2026-08-25T12:00:00Z'),
    });

    expect(latestInstanceFromResponse({
      instances: [{
        id: '2026-08-20T120000Z',
        extent: { temporal: { interval: [[
          '2026-08-20T12:00:00Z',
          '2026-02-30T12:00:00Z',
        ]] } },
      }],
    }, 'dkss_idw')).toEqual({ id: '2026-08-20T120000Z' });
  });

  it('uses the furthest valid end across intervals and duplicate records', () => {
    const data = {
      instances: [
        {
          id: RUN,
          extent: { temporal: { interval: [
            ['2026-08-20T12:00:00Z', '2026-08-22T12:00:00Z'],
            ['2026-08-22T13:00:00Z', '2026-08-24T12:00:00Z'],
          ] } },
        },
        {
          id: RUN,
          extent: { temporal: { interval: [[
            '2026-08-20T12:00:00Z',
            '2026-08-25T12:00:00Z',
          ]] } },
        },
      ],
    };
    expect(latestInstanceFromResponse(data, 'dkss_idw')).toEqual({
      id: RUN,
      declaredEndMs: Date.parse('2026-08-25T12:00:00Z'),
    });

    expect(latestInstanceFromResponse({
      instances: [{
        id: RUN,
        extent: { temporal: { interval: [
          ['2026-08-20T12:00:00Z', '2026-08-25T12:00:00Z'],
          ['2026-08-25T13:00:00Z', 'not-a-date'],
        ] } },
      }],
    }, 'dkss_idw')).toEqual({ id: RUN });
  });

  it('treats catalogue extent as diagnostic rather than run identity', () => {
    const withoutExtent = {
      water: { collection: 'dkss_idw', id: RUN },
      waves: { collection: 'wam_nsb', id: RUN },
    };
    const withExtent = {
      ...withoutExtent,
      water: {
        ...withoutExtent.water,
        declaredEndMs: Date.parse('2026-08-25T12:00:00Z'),
      },
    };
    expect(marineInstancesEqual(withoutExtent, withExtent)).toBe(true);
  });
});
