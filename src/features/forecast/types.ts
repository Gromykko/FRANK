export interface HourlyData {
  time: string;
  tempAir: number;
  precipitation: number;
  // MET Norway's own condition symbol (e.g. "clearsky_day"); it decides the
  // weather severity and drives the icon/label via its mapped WMO code.
  symbolCode: string;
  weatherCode: number;
  windSpeed: number;
  windDirection: number;
  windGust: number;
  waveHeight: number;
  waveDirection: number;
  wavePeriod: number;
  tempWater: number;
  tideLevel: number;
  currentSpeed: number;
  currentDirection: number;
  isDay: boolean;
  // True for hours far enough out to read as a longer-range "Outlook". Purely a
  // subtle UI hint; set for every longer-range block.
  isOutlook?: boolean;
  // ── Longer-range period block (MET next_6_hours/next_12_hours, after the
  // hourly range). Absent on normal hourly entries. The scalar fields above
  // carry the block's decision value — wind is MET's single instant value,
  // marine values are aggregated across the block — and the *Min/*Max fields
  // below carry ranges where the source genuinely provides the underlying
  // hourly samples.
  blockSpanHours?: number;
  isLowConfidence?: boolean;
  windSpeedMin?: number;
  windSpeedMax?: number;
  windGustMax?: number;
  waveHeightMin?: number;
  waveHeightMax?: number;
  tideLevelMin?: number;
  tideLevelMax?: number;
  tempWaterMin?: number;
  tempWaterMax?: number;
  weatherSource?: 'met-locationforecast';
  marineSource?: 'dmi-dkss-wam';
}

// An official DMI weather warning ("varsel") for the location's region, sourced
// from the MeteoAlarm Denmark feed. Advisory only — it never changes the safety
// verdict; it drives the warning stripe and launch-window badges.
export interface WeatherWarning {
  // Plain hazard name, e.g. "Rain", "Wind", "Thunderstorm".
  event: string;
  // MeteoAlarm awareness colour.
  colour: 'yellow' | 'orange' | 'red';
  // CAP severity word (Moderate/Severe/Extreme), if present.
  severity?: string;
  // Human region name, e.g. "Østjylland".
  areaDesc?: string;
  // When the warning is in effect / when the hazard begins / when it lapses.
  effective: string;
  onset?: string;
  expires: string;
  // English headline from the feed.
  title?: string;
  // Where the stripe links for full details (DMI's varsler page).
  url: string;
  // Per-warning CAP detail endpoint (public MeteoAlarm API) — source for the
  // kommune-coverage soft filter.
  detailUrl?: string;
  // Soft-filter result: 'confirmed' = this location's kommune is in the
  // warning's covered list (display unchanged); 'excluded' = a coverage list
  // exists and doesn't name it (still shown, muted, "elsewhere in the
  // region"); absent/'unknown' = couldn't tell → exactly region-level.
  // The filter only ever QUIETS a warning, never adds local claims.
  coverage?: 'confirmed' | 'excluded' | 'unknown';
}

// Version of the forecast payload shape/sources this app expects. The worker
// stamps the same number (PAYLOAD_VERSION in worker/index.js — keep in sync)
// into every payload it builds; when the app receives an older stamp it warns
// that the deployed worker is out of date instead of silently rendering data
// built by previous logic.
export const FORECAST_PAYLOAD_VERSION = 4;

export interface WeatherData {
  hourly: HourlyData[];
  sunrise: string[];
  sunset: string[];
  // Active/upcoming official warnings for the location's region (may be empty
  // or absent — the warning feed is advisory and never blocks a forecast).
  warnings?: WeatherWarning[];
  sources: {
    payloadVersion?: number;
    weather: string;
    waves: string;
    water: string;
    coordinate: {
      latitude: number;
      longitude: number;
    };
    location?: {
      id: string;
      name: string;
      areaName: string;
    };
    fetchedAt: string;
    cacheHealth?: {
      status: 'current' | 'pending' | 'stale' | 'fresh' | 'fallback';
      lastAttemptAt: string;
      lastSuccessfulBuildAt?: string;
      message?: string;
      // MET Norway cache headers from the run the cache was built against.
      weatherExpires?: string;
      weatherLastModified?: string;
      checkedBy?: string;
      needsRebuild?: boolean;
      // A failed check where the provider was merely busy (429) vs a real
      // error, plus which provider - so the UI can word it calmly.
      providerBusy?: boolean;
      busyProvider?: 'weather' | 'marine' | 'services';
      // Sources served from last-good data because their provider was down
      // ('weather' | 'water' | 'waves').
      degradedSources?: string[];
    };
  };
}

export type SeriesPoint = {
  time: string;
  timeMs: number;
} & Partial<HourlyData>;
