import locations from './locations.json';
import { readStorage } from '../utils/storage';

export interface ForecastLocation {
  id: string;
  name: string;
  areaName: string;
  subtitle: string;
  timezone: string;
  coordinate: {
    latitude: number;
    longitude: number;
  };
  dmiCollections: {
    water: string[];
    waves: string[];
  };
  // MeteoAlarm EMMA region code for official DMI warnings (e.g. "DK004" =
  // Østjylland). Absent means no warning stripe for this location.
  emmaId?: string;
  // Names that identify this location in a warning's covered-kommune list
  // ("Gældende for: Hedensted, Horsens, …"), matched case-insensitively.
  // Include umbrella names (Vejle/Kolding are part of "Trekant området").
  // Drives the coverage SOFT FILTER only — it can quiet a warning that
  // demonstrably excludes the town, never add local claims. Absent = no
  // filtering, warnings stay region-level.
  kommuneAliases?: string[];
  // Local, area-specific heads-ups a paddler should know (crossings, protected
  // areas, seasonal/daylight restrictions). Informational — shown in the Local
  // Rules panel, never part of the safety verdict. Deliberately does NOT
  // reproduce exact dates/distances (those change and we don't maintain them):
  // each item names that a constraint exists and links out to the authority or
  // club that actually keeps the current rule. `link` is omitted for timeless
  // facts (a shipping lane, sunrise-to-sunset) that don't go stale.
  localRules?: { id: string; title: string; body: string; link?: { label: string; url: string } }[];
  // True until a local paddler has calibrated the wind sectors and caps; the
  // switcher flags it and the app shows a "verify locally" notice.
  provisional?: boolean;
  // The fjord's wind sectors as a list (was a fixed onshore/offshore pair), so
  // any geometry works: a single linear fjord, a headland open on two sides, a
  // branching fjord with three exposures. Angles/labels/exposure are curated
  // geometry; users only override the per-sector speed caps.
  windSectors: WindSector[];
}

// Which way a sector faces relative to the launch: onshore wind pushes waves
// toward shore, offshore blows you away from it, cross-shore runs along it. The
// wind-against-water-level rule reads this (cross-shore sectors opt out).
export type SectorExposure = 'onshore' | 'offshore' | 'crossshore';

export interface WindSector {
  // Stable key that per-user cap overrides are stored against.
  id: string;
  label: string;
  description: string;
  exposure: SectorExposure;
  min: number;
  max: number;
  safeLimit: number;
  cautionLimit: number;
}

const FORECAST_LOCATIONS = locations as ForecastLocation[];
const DEFAULT_LOCATION_ID = 'horsens';
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
export const AVAILABLE_LOCATIONS = FORECAST_LOCATIONS.map(({ id, name, areaName, provisional }) => ({ id, name, areaName, provisional: provisional ?? false }));

// The active location is a module-load constant threaded through settings keys,
// cache keys, and preset defaults, so switching cleanly means persisting the
// choice and reloading (each city already keeps its own id-suffixed
// settings/cache, so nothing is lost).
export function setLocation(id: string): void {
  if (id === CURRENT_LOCATION.id) return;
  try {
    localStorage.setItem(LOCATION_STORAGE_KEY, id);
  } catch {
    // If storage is blocked the switch just won't persist; nothing else breaks.
  }
  window.location.reload();
}
