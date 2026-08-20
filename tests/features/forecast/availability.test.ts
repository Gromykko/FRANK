import { describe, expect, it } from 'vitest';
import { AVAILABLE_LOCATIONS } from '../../../src/config/locations';
import { parseForecastAvailability } from '../../../src/features/forecast/availability';

const allIds = AVAILABLE_LOCATIONS.map(({ id }) => id);

function health(available = allIds.slice(0, 1)) {
  return {
    service: 'frank-forecast',
    checkedAt: '2026-08-20T12:00:00.000Z',
    release: {
      allLocationsReady: available.length === allIds.length,
      ready: [...available],
      available: [...available],
      fallback: [],
      missing: allIds.filter((id) => !available.includes(id)),
    },
  };
}

describe('forecast availability trust boundary', () => {
  it('accepts a complete manifest partition and restores local display order', () => {
    const available = [...allIds].reverse().slice(0, 2);
    const parsed = parseForecastAvailability(health(available));

    expect(parsed?.availableLocationIds).toEqual(allIds.filter((id) => available.includes(id)));
    expect(parsed?.missingLocationIds).toEqual(allIds.filter((id) => !available.includes(id)));
    expect(parsed?.allLocationsReady).toBe(false);
  });

  it('accepts an honest previous-generation fallback as usable availability', () => {
    const payload = health([allIds[0]]);
    payload.release.ready = [];
    payload.release.fallback = [allIds[0]];

    expect(parseForecastAvailability(payload)).toMatchObject({
      availableLocationIds: [allIds[0]],
      readyLocationIds: [],
      fallbackLocationIds: [allIds[0]],
    });
  });

  it.each([
    ['an unknown location', () => {
      const payload = health();
      payload.release.available = ['made-up-fjord'];
      return payload;
    }],
    ['a duplicate location', () => {
      const payload = health();
      payload.release.available = [allIds[0], allIds[0]];
      return payload;
    }],
    ['an unaccounted location', () => {
      const payload = health();
      payload.release.missing = payload.release.missing.slice(1);
      return payload;
    }],
    ['a contradictory all-ready flag', () => {
      const payload = health();
      payload.release.allLocationsReady = true;
      return payload;
    }],
    ['an invalid timestamp', () => ({ ...health(), checkedAt: 'sometime' })],
  ])('rejects %s', (_name, buildPayload) => {
    expect(parseForecastAvailability(buildPayload())).toBeNull();
  });
});
