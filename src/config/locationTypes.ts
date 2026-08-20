export interface ForecastLocation {
  id: string;
  // Cache/provenance identity for forecast-bearing configuration. Start a new
  // location at 1 and increment this before changing coordinates, provider
  // collections, timezone, or warning coverage inputs for an existing id.
  forecastConfigRevision: number;
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
  // East Jutland). Absent means no warning stripe for this location.
  emmaId?: string;
  // Names identifying this location in a warning's kommune coverage list.
  // This drives only a fail-open soft filter; it can quiet a warning that
  // demonstrably excludes the town, never add a local claim.
  kommuneAliases?: string[];
  // Area-specific wind geometry and thresholds. A location may have any
  // number of onshore, offshore, or cross-shore sectors.
  windSectors: WindSector[];
}

// Which way a sector faces relative to launch: onshore pushes waves toward
// shore, offshore blows away from it, and cross-shore runs along it.
export type SectorExposure = 'onshore' | 'offshore' | 'crossshore';

export interface WindSector {
  // Stable key used by per-user cap overrides.
  id: string;
  label: string;
  description: string;
  exposure: SectorExposure;
  min: number;
  max: number;
  safeLimit: number;
  cautionLimit: number;
}
