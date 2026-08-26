import { CURRENT_LOCATION } from '../../config/locations';

// Per-sector wind-speed caps, keyed by sector id. Angles/labels live in the
// (curated) location config; only these caps are user-tunable.
export type SectorCap = { safe: number; caution: number };

// The minimum gap a caution/danger cap must sit above its safe cap, so the
// assessment never runs an inverted band. One rule, one place — every site that
// enforces it (presets, healing, the editor, and the engine) uses this.
export const MIN_CAUTION_GAP = 0.5;
export function floorCaution(safe: number, caution: number): number {
  return Math.max(caution, safe + MIN_CAUTION_GAP);
}

export interface SafetySettings {
  maxWindSpeedSafe: number;
  maxWindSpeedCaution: number;
  minWaterTempSafe: number;
  minWaterTempCaution: number;
  maxWaveHeightSafe: number;
  maxWaveHeightCaution: number;
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
  tidePreference: 'any' | 'high' | 'low' | 'incoming';
  gustMargin: number;
  waveCautionMargin: number;
  enableWindSpeed: boolean;
  enableWindGust: boolean;
  enableWaveHeight: boolean;
  enableWaveCaution: boolean;
  enableWaterTemp: boolean;
}

const locationSectors = CURRENT_LOCATION.windSectors;

export const SETTINGS_STORAGE_KEY = `ffkajak_settings_${CURRENT_LOCATION.id}`;
export const CUSTOM_SETTINGS_STORAGE_KEY = `ffkajak_custom_saved_${CURRENT_LOCATION.id}`;

// A preset shifts each sector's OWN configured caps by a per-exposure delta,
// rather than clamping to an absolute ceiling. This preserves whatever ordering
// a fjord defines — e.g. Vejle deliberately caps offshore LOWER than onshore for
// fralandsvind drift risk, which an absolute per-exposure ceiling would silently
// invert. Beginner tightens, Pro loosens; a floor stops a tightened cap from
// dropping to an unusable value. Cross-shore uses the (stricter) onshore delta.
// null = identity (use the sector's configured caps as-is: default/custom).
const SECTOR_SAFE_FLOOR = 2.5;
const PRESET_SECTOR_DELTAS: Record<SafetySettings['tripMode'], Record<'onshore' | 'offshore', number> | null> = {
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
      out[sector.id] = { safe: sector.safeLimit, caution: sector.cautionLimit };
      continue;
    }
    const delta = deltas[sector.exposure === 'offshore' ? 'offshore' : 'onshore'];
    const safe = Math.max(sector.safeLimit + delta, SECTOR_SAFE_FLOOR);
    const caution = floorCaution(safe, sector.cautionLimit + delta);
    out[sector.id] = { safe, caution };
  }
  return out;
}

const BASE_SETTINGS: SafetySettings = {
  // Normal is IPP3-like: DKF Touring describes its central working condition
  // as around 6 m/s and an assessment envelope reaching 8 m/s. These are
  // FRANK's general wind bands, not a claim that DKF defines green/amber/red.
  // https://www.kano-kajak.dk/uddannelse-og-kurser/ipp-roeruddannelse/touring-tur/
  maxWindSpeedSafe: 6.0,
  maxWindSpeedCaution: 8.0,
  minWaterTempSafe: 15.0,
  minWaterTempCaution: 10.0,
  maxWaveHeightSafe: 0.3,
  // DKF Touring describes waves qualitatively but publishes no numeric height
  // table. The red ceiling therefore uses the current DKF sea-kayak IPP3
  // figure (1 m); the existing conservative 0.30 m amber entry stays FRANK's.
  maxWaveHeightCaution: 1.0,
  enableCustomWindDirs: true,
  sectorLimits: buildSectorLimits('default'),
  tripMode: 'default',
  daylightOnly: true,
  minDuration: 2,
  tidePreference: 'any',
  gustMargin: 2.0,
  waveCautionMargin: 0.7,
  enableWindSpeed: true,
  enableWindGust: true,
  enableWaveHeight: true,
  enableWaveCaution: true,
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
    maxWindSpeedSafe: 4.0,
    maxWindSpeedCaution: 5.0,
    gustMargin: 1.0,
    maxWaveHeightSafe: 0.2,
    maxWaveHeightCaution: 0.5,
    waveCautionMargin: 0.3,
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
    maxWindSpeedSafe: 8.0,
    maxWindSpeedCaution: 10.0,
    gustMargin: 2.0,
    maxWaveHeightSafe: 0.5,
    maxWaveHeightCaution: 2.0,
    waveCautionMargin: 1.5,
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
    enableWaveCaution: false,
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
