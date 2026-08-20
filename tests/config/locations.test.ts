import { afterEach, describe, expect, it, vi } from 'vitest';
import { AVAILABLE_LOCATIONS, CURRENT_LOCATION, setLocation } from '../../src/config/locations';
import locations from '../../src/config/locations.json';
import type { ForecastLocation } from '../../src/config/locationTypes';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('forecast location identity', () => {
  it('gives every location a positive integer config revision and permits revision 1', () => {
    const configuredLocations = locations as ForecastLocation[];

    expect(configuredLocations).not.toHaveLength(0);
    expect(configuredLocations.some(({ forecastConfigRevision }) =>
      forecastConfigRevision === 1)).toBe(true);
    expect(configuredLocations.every(({ forecastConfigRevision }) =>
      Number.isSafeInteger(forecastConfigRevision) && forecastConfigRevision >= 1)).toBe(true);
  });
});

describe('setLocation', () => {
  it('accepts the current location without writing or reloading', () => {
    const write = vi.spyOn(Storage.prototype, 'setItem');
    expect(setLocation(CURRENT_LOCATION.id)).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });

  it('rejects an unknown location rather than persisting arbitrary input', () => {
    const write = vi.spyOn(Storage.prototype, 'setItem');
    expect(setLocation('not-a-forecast-location')).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it('returns failure when storage is blocked, keeping the current page alive', () => {
    const anotherLocation = AVAILABLE_LOCATIONS.find(({ id }) => id !== CURRENT_LOCATION.id);
    expect(anotherLocation).toBeDefined();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage blocked', 'SecurityError');
    });

    // Returning before location.reload is the recovery contract: the picker
    // stays mounted on the still-valid current forecast instead of reloading
    // back into the unchanged city.
    expect(setLocation(anotherLocation!.id)).toBe(false);
  });
});
