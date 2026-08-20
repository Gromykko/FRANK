import locations from './locations.json';
import { readStorage } from '../utils/storage';
import type { ForecastLocation } from './locationTypes';

// Keep the public type surface stable for existing frontend imports while the
// Worker can consume the pure definitions without pulling browser-only code.
export type { ForecastLocation, SectorExposure, WindSector } from './locationTypes';

const FORECAST_LOCATIONS = locations as ForecastLocation[];
// Also the only city the app supported before it became multi-location, so it
// is the one location the unsuffixed legacy storage keys can have belonged to.
export const DEFAULT_LOCATION_ID = 'horsens';
const LOCATION_STORAGE_KEY = 'frank_location';

function getForecastLocation(id = DEFAULT_LOCATION_ID): ForecastLocation {
  return FORECAST_LOCATIONS.find((location) => location.id === id) ?? FORECAST_LOCATIONS[0];
}

function readStoredLocationId(): string | undefined {
  return readStorage(LOCATION_STORAGE_KEY) ?? undefined;
}

// The user's chosen location wins; a per-city build (VITE_FORECAST_LOCATION_ID)
// is the fallback default, then Horsens.
export const CURRENT_LOCATION = getForecastLocation(
  readStoredLocationId() ?? import.meta.env.VITE_FORECAST_LOCATION_ID,
);

// The short list the location switcher offers.
export const AVAILABLE_LOCATIONS = FORECAST_LOCATIONS.map(({ id, name, areaName }) => ({ id, name, areaName }));

// The active location is a module-load constant threaded through settings keys,
// cache keys, and preset defaults, so switching cleanly means persisting the
// choice and reloading (each city already keeps its own id-suffixed
// settings/cache, so nothing is lost). Returns false when the choice cannot be
// persisted; callers must then leave the current page and picker intact.
export function setLocation(id: string): boolean {
  if (id === CURRENT_LOCATION.id) return true;
  if (!FORECAST_LOCATIONS.some((location) => location.id === id)) return false;
  try {
    localStorage.setItem(LOCATION_STORAGE_KEY, id);
  } catch {
    // Reloading here would resolve CURRENT_LOCATION from the unchanged value
    // and make the picker appear broken. Stay on the working current forecast.
    return false;
  }
  window.location.reload();
  return true;
}
