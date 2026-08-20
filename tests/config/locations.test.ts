import { afterEach, describe, expect, it, vi } from 'vitest';
import { AVAILABLE_LOCATIONS, CURRENT_LOCATION, setLocation } from '../../src/config/locations';

afterEach(() => {
  vi.restoreAllMocks();
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
