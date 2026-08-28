import { CURRENT_LOCATION } from '../../config/locations';
import type { SectorExposure } from '../../config/locationTypes';
import { roundToDecimals } from '../../utils/number';

// Per-sector wind-speed maximums, keyed by sector id. Angles/labels live in the
// (curated) location config; only these maximums are user-tunable.
export type SectorCap = { maximumAt: number };

// FRANK checks forecast gusts against one maximum derived from the selected
// mean-wind maximum. A 230-hour forecast sample across the four areas
// had a median gust-to-mean ratio of 1.66 (p75 1.81, p90 2.04). That sample is
// calibration context, not observed wind, a safety validation, or a published
// club limit. The 1.6 factor is a FRANK product rule and is labelled that way.
export const GUST_FACTOR = 1.6;

// FRANK starts warning at 80% of a selected maximum, rounded to the same
// precision as the displayed forecast so the visible number and verdict agree.
// This makes shrinking headroom visible without asking people to maintain a
// second threshold. It is a FRANK heuristic, not a percentage published by
// DKF, IPP, DMI, WMO, or a kayak club.
export const NEAR_LIMIT_RATIO = 0.8;

export function getNearLimitThreshold(maximum: number, decimals: number): number {
  return roundToDecimals(maximum * NEAR_LIMIT_RATIO, decimals);
}

export interface SafetySettings {
  windLimit: number;
  waterTempTakeCareBelow: number;
  waterTempDangerBelow: number;
  waveLimit: number;
  enableCustomWindDirs: boolean;
  // Per-sector cap overrides, keyed by WindSector.id. Missing sectors fall back
  // to the location's configured caps.
  sectorLimits: Record<string, SectorCap>;
  // 'weather' is not a caution level - it is the absence of one. Every check
  // is off, so hasActiveSafetyChecks() returns false and the app presents raw
  // weather with no verdict. It exists so wanting that takes one choice
  // instead of switching six rules off by hand and remembering which.
  tripMode: 'default' | 'beginner' | 'pro' | 'custom' | 'weather';
  daylightOnly: boolean;
  minDuration: number;
  enableWindSpeed: boolean;
  enableWindGust: boolean;
  enableWaveHeight: boolean;
  enableWaterTemp: boolean;
}

const locationSectors = CURRENT_LOCATION.windSectors;

export const SETTINGS_STORAGE_KEY = `frank_settings_${CURRENT_LOCATION.id}`;
export const CUSTOM_SETTINGS_STORAGE_KEY = `frank_custom_saved_${CURRENT_LOCATION.id}`;

// These optional rules start from each area's configured maximum. A preset
// shifts it for an exposure by the same amount the former upper cap used.
// null means use the configured value unchanged.
const PRESET_SECTOR_DELTAS: Record<SafetySettings['tripMode'], Record<SectorExposure, number> | null> = {
  beginner: { onshore: -0.5, offshore: -1.0 },
  pro: { onshore: 1.0, offshore: 1.0 },
  default: null,
  custom: null,
  // Weather-only disables enableCustomWindDirs, so sector caps are never
  // consulted. Identity keeps the configured values intact for the mode the
  // user switches back to.
  weather: null,
};

function buildSectorLimits(mode: SafetySettings['tripMode']): Record<string, SectorCap> {
  const deltas = PRESET_SECTOR_DELTAS[mode];
  const out: Record<string, SectorCap> = {};
  for (const sector of locationSectors) {
    if (!deltas) {
      out[sector.id] = { maximumAt: sector.maximumAt };
      continue;
    }
    const delta = deltas[sector.exposure];
    out[sector.id] = { maximumAt: Math.max(0, sector.maximumAt + delta) };
  }
  return out;
}

const BASE_SETTINGS: SafetySettings = {
  // Intermediate is IPP3-like: DKF Touring describes an assessment envelope
  // reaching 8 m/s. FRANK treats that as an inclusive maximum, not as a
  // published DKF verdict threshold.
  // https://www.kano-kajak.dk/uddannelse-og-kurser/ipp-roeruddannelse/touring-tur/
  windLimit: 8.0,
  waterTempTakeCareBelow: 15.0,
  waterTempDangerBelow: 10.0,
  waveLimit: 1.0,
  // DKF Touring describes waves qualitatively but publishes no numeric height
  // table. This maximum uses the current DKF sea-kayak IPP3 figure (1 m).
  // These broad FRANK area estimates are optional. Current club rules do not
  // publish these compass sectors, so every judged profile leaves them off.
  enableCustomWindDirs: false,
  sectorLimits: buildSectorLimits('default'),
  tripMode: 'default',
  daylightOnly: true,
  minDuration: 2,
  enableWindSpeed: true,
  enableWindGust: true,
  enableWaveHeight: true,
  enableWaterTemp: true,
};

export const DEFAULT_SETTINGS: SafetySettings = BASE_SETTINGS;

const PRESET_SETTINGS: Record<SafetySettings['tripMode'], SafetySettings> = {
  beginner: {
    ...BASE_SETTINGS,
    tripMode: 'beginner',
    // DKF Touring IPP2 does not publish numeric wind conditions. This 5 m/s
    // maximum comes from DKF's current sea-kayak IPP2 norm.
    windLimit: 5.0,
    waveLimit: 0.5,
    minDuration: 2,
    sectorLimits: buildSectorLimits('beginner'),
  },
  default: {
    ...BASE_SETTINGS,
    tripMode: 'default',
  },
  pro: {
    ...BASE_SETTINGS,
    tripMode: 'pro',
    // DKF Touring IPP4 publishes an assessment environment up to 10 m/s.
    // https://drive.google.com/file/d/1iagdhW-B3ZXvHUmEBSfxVESyne5qevb2/view?usp=sharing
    windLimit: 10.0,
    waveLimit: 2.0,
    minDuration: 1,
    sectorLimits: buildSectorLimits('pro'),
  },
  custom: {
    ...BASE_SETTINGS,
    tripMode: 'custom',
  },
  // daylightOnly counts in hasActiveSafetyChecks, so it has to go too - leave
  // it on and the badge keeps showing a verdict and the mode silently does
  // nothing. The thresholds themselves are left at their defaults so switching
  // back to a judged mode restores sane numbers.
  weather: {
    ...BASE_SETTINGS,
    tripMode: 'weather',
    enableWindSpeed: false,
    enableWindGust: false,
    enableWaveHeight: false,
    enableWaterTemp: false,
    enableCustomWindDirs: false,
    daylightOnly: false,
  },
};

export function getPresetSettings(mode: SafetySettings['tripMode']): SafetySettings {
  const preset = PRESET_SETTINGS[mode];
  // Deep-copy the per-sector caps so a caller mutating one can't reach back
  // into the shared preset object.
  const sectorLimits: Record<string, SectorCap> = {};
  for (const [id, cap] of Object.entries(preset.sectorLimits)) {
    sectorLimits[id] = { ...cap };
  }
  return { ...preset, sectorLimits };
}
