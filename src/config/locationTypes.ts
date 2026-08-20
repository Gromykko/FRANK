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
  // East Jutland). Absent means no warning stripe for this location.
  emmaId?: string;
  // Names identifying this location in a warning's kommune coverage list.
  // This drives only a fail-open soft filter; it can quiet a warning that
  // demonstrably excludes the town, never add a local claim.
  kommuneAliases?: string[];
  // Dormant curated local heads-ups retained for a possible future surface.
  // Exact changing rules belong at the linked authority rather than here.
  localRules?: {
    id: string;
    title: string;
    body: string;
    link?: { label: string; url: string };
  }[];
  // True until a local paddler has calibrated the sector geometry and caps.
  provisional?: boolean;
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
