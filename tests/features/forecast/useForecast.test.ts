import { describe, expect, it } from 'vitest';
import {
  POST_REFRESH_PICKUP_DELAYS_MS,
  shouldApplyForecastUpdate,
} from '../../../src/features/forecast/useForecast';
import type { WeatherData } from '../../../src/features/forecast/types';

const FETCHED_AT = '2026-08-20T10:00:00.000Z';

function payload(
  status: NonNullable<WeatherData['sources']['cacheHealth']>['status'],
  lastAttemptAt = '2026-08-20T10:01:00.000Z',
  fetchedAt = FETCHED_AT,
): WeatherData {
  return {
    hourly: [],
    sunrise: [],
    sunset: [],
    sources: {
      weather: 'MET',
      waves: 'DMI',
      water: 'DMI',
      coordinate: { latitude: 55, longitude: 9 },
      fetchedAt,
      cacheHealth: { status, lastAttemptAt },
    },
  };
}

describe('forecast refresh ordering', () => {
  it('lets completed health clear pending without requiring a new fetchedAt', () => {
    const pending = payload('pending');
    const completed = payload('current');
    expect(shouldApplyForecastUpdate(pending, completed)).toBe(true);
  });

  it('applies later stable health for the same forecast build', () => {
    const current = payload('current', '2026-08-20T10:01:00.000Z');
    const failed = payload('stale', '2026-08-20T10:02:00.000Z');
    failed.sources.cacheHealth!.providerBusy = true;
    failed.sources.cacheHealth!.busyProvider = 'marine';
    expect(shouldApplyForecastUpdate(current, failed)).toBe(true);
  });

  it('does not regress stable health to a late pending or older check', () => {
    const current = payload('current', '2026-08-20T10:02:00.000Z');
    expect(shouldApplyForecastUpdate(current, payload('pending', '2026-08-20T10:02:00.000Z'))).toBe(false);
    expect(shouldApplyForecastUpdate(current, payload('stale', '2026-08-20T10:01:00.000Z'))).toBe(false);
    expect(shouldApplyForecastUpdate(current, structuredClone(current))).toBe(false);
  });

  it('preserves build-level out-of-order protection', () => {
    const current = payload('current', '2026-08-20T10:02:00.000Z');
    const older = payload('stale', '2026-08-20T10:03:00.000Z', '2026-08-20T09:00:00.000Z');
    const newer = payload('current', '2026-08-20T10:03:00.000Z', '2026-08-20T11:00:00.000Z');
    expect(shouldApplyForecastUpdate(current, older)).toBe(false);
    expect(shouldApplyForecastUpdate(current, newer)).toBe(true);
  });

  it('starts pickups near 2s and ends with one bounded final pickup', () => {
    expect(POST_REFRESH_PICKUP_DELAYS_MS[0]).toBe(2_000);
    expect(POST_REFRESH_PICKUP_DELAYS_MS).toEqual([2_000, 8_000, 30_000]);
    expect(POST_REFRESH_PICKUP_DELAYS_MS.at(-1)).toBeLessThanOrEqual(30_000);
  });
});
