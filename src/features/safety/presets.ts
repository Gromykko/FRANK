import { CURRENT_LOCATION } from '../../config/locations';
import type { SectorExposure } from '../../config/locationTypes';
import { roundToDecimals } from '../../utils/number';

// Per-sector wind-speed caps, keyed by sector id. Angles/labels live in the
// (curated) location config; only these caps are user-tunable.
export type SectorCap = { takeCareAt: number; dangerAt: number };

// The minimum gap a Danger cap must sit above its Take care cap, so the
// assessment never runs an inverted band. One rule, one place — every site that
// enforces it (presets, healing, the editor, and the engine) uses this.
export const MIN_DANGER_GAP = 0.5;

// FRANK checks forecast gusts against a separate band because the profile wind
// limits describe mean wind. A 230-hour forecast sample across the four areas
// had a median gust-to-mean ratio of 1.66 (p75 1.81, p90 2.04). That sample is
// calibration context, not observed wind, a safety validation, or a published
// club limit. The 1.6 factor is a FRANK product rule and is labelled that way.
export const GUST_FACTOR = 1.6;
export function floorDanger(takeCareAt: number, dangerAt: number): number {
  return Math.max(dangerAt, takeCareAt + MIN_DANGER_GAP);
}

export interface SafetySettings {
  windTakeCareAt: number;
  waterTempTakeCareBelow: number;
  waterTempDangerBelow: number;
  waveTakeCareAt: number;
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
  windDangerGap: number;
  waveDangerGap: number;
  enableWindSpeed: boolean;
  enableWindGust: boolean;
  enableWaveHeight: boolean;
  enableWaveTakeCare: boolean;
  enableWaterTemp: boolean;
}

export function getWindDangerAt(
  settings: Pick<SafetySettings, 'windTakeCareAt' | 'windDangerGap'>,
): number {
  return roundToDecimals(
    floorDanger(settings.windTakeCareAt, settings.windTakeCareAt + settings.windDangerGap),
    1,
  );
}

export function getWaveDangerAt(
  settings: Pick<SafetySettings, 'waveTakeCareAt' | 'waveDangerGap'>,
): number {
  return roundToDecimals(
    Math.max(settings.waveTakeCareAt, settings.waveTakeCareAt + settings.waveDangerGap),
    2,
  );
}

const locationSectors = CURRENT_LOCATION.windSectors;

export const SETTINGS_STORAGE_KEY = `frank_settings_${CURRENT_LOCATION.id}`;
export const CUSTOM_SETTINGS_STORAGE_KEY = `frank_custom_saved_${CURRENT_LOCATION.id}`;

// These optional rules start from each area's configured caps. A preset shifts
// both caps for an exposure by the same amount, so opting in preserves the
// configured ordering. Beginner tightens them, Advanced loosens them, and a floor
// prevents an unusably low cap. null means use the configured values unchanged.
const SECTOR_TAKE_CARE_FLOOR = 2.5;
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
      out[sector.id] = { takeCareAt: sector.takeCareAt, dangerAt: sector.dangerAt };
      continue;
    }
    const delta = deltas[sector.exposure];
    const takeCareAt = Math.max(sector.takeCareAt + delta, SECTOR_TAKE_CARE_FLOOR);
    const dangerAt = floorDanger(takeCareAt, sector.dangerAt + delta);
    out[sector.id] = { takeCareAt, dangerAt };
  }
  return out;
}

const BASE_SETTINGS: SafetySettings = {
  // Intermediate is IPP3-like: DKF Touring describes its central working condition
  // as around 6 m/s and an assessment envelope reaching 8 m/s. These are
  // FRANK's general wind bands, not a claim that DKF defines green/amber/red.
  // https://www.kano-kajak.dk/uddannelse-og-kurser/ipp-roeruddannelse/touring-tur/
  windTakeCareAt: 6.0,
  waterTempTakeCareBelow: 15.0,
  waterTempDangerBelow: 10.0,
  waveTakeCareAt: 0.3,
  // DKF Touring describes waves qualitatively but publishes no numeric height
  // table. The Rough boundary uses the current DKF sea-kayak IPP3 figure
  // (1 m); FRANK sets the conservative Take care boundary at 0.30 m.
  // These broad FRANK area estimates are optional. Current club rules do not
  // publish these compass sectors, so every judged profile leaves them off.
  enableCustomWindDirs: false,
  sectorLimits: buildSectorLimits('default'),
  tripMode: 'default',
  daylightOnly: true,
  minDuration: 2,
  windDangerGap: 2.0,
  waveDangerGap: 0.7,
  enableWindSpeed: true,
  enableWindGust: true,
  enableWaveHeight: true,
  enableWaveTakeCare: true,
  enableWaterTemp: true,
};

export const DEFAULT_SETTINGS: SafetySettings = BASE_SETTINGS;

const PRESET_SETTINGS: Record<SafetySettings['tripMode'], SafetySettings> = {
  beginner: {
    ...BASE_SETTINGS,
    tripMode: 'beginner',
    // DKF Touring IPP2 does not publish numeric wind conditions. The 5 m/s
    // ceiling comes from DKF's current sea-kayak IPP2 norm; 4 m/s is FRANK's
    // deliberately conservative Take-care boundary.
    windTakeCareAt: 4.0,
    windDangerGap: 1.0,
    waveTakeCareAt: 0.2,
    waveDangerGap: 0.3,
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
    // DKF Touring IPP4 publishes an 8-10 m/s assessment environment.
    // https://drive.google.com/file/d/1iagdhW-B3ZXvHUmEBSfxVESyne5qevb2/view?usp=sharing
    windTakeCareAt: 8.0,
    windDangerGap: 2.0,
    waveTakeCareAt: 0.5,
    waveDangerGap: 1.5,
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
    enableWaveTakeCare: false,
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
