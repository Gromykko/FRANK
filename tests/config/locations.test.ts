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

  it('pins the five reviewed forecast points and their cache identities', () => {
    const configuredLocations = locations as ForecastLocation[];

    expect(configuredLocations.map((location) => ({
      id: location.id,
      forecastConfigRevision: location.forecastConfigRevision,
      coordinate: location.coordinate,
    }))).toEqual([
      {
        id: 'horsens',
        forecastConfigRevision: 2,
        coordinate: { latitude: 55.858, longitude: 9.905 },
      },
      {
        id: 'vejle',
        forecastConfigRevision: 2,
        coordinate: { latitude: 55.705, longitude: 9.68 },
      },
      {
        id: 'kolding',
        forecastConfigRevision: 2,
        coordinate: { latitude: 55.512, longitude: 9.659 },
      },
      {
        id: 'aarhus',
        forecastConfigRevision: 2,
        coordinate: { latitude: 56.129, longitude: 10.257 },
      },
      {
        id: 'aarhus-north',
        forecastConfigRevision: 1,
        coordinate: { latitude: 56.1899, longitude: 10.2543 },
      },
    ]);
  });

  it('uses the finer WAM-DW wave grid without a same-service fallback', () => {
    const configuredLocations = locations as ForecastLocation[];

    expect(configuredLocations.every((location) =>
      location.dmiCollections.waves.length === 1
      && location.dmiCollections.waves[0] === 'wam_dw')).toBe(true);
  });

  it('uses DKSS-NSBS alone where the Aarhus North IDW grid is masked', () => {
    const north = (locations as ForecastLocation[])
      .find((location) => location.id === 'aarhus-north');

    expect(north?.dmiCollections.water).toEqual(['dkss_nsbs']);
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
