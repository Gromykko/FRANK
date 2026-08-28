import type { ForecastReleaseMetadata } from './releaseContract';

export interface HourlyData {
  time: string;
  tempAir: number;
  precipitation: number;
  // MET Norway's own condition symbol (e.g. "clearsky_day"). This single
  // native field drives the condition label, icon and weather severity.
  symbolCode: string;
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
  // carry the block's display value — wind is MET's central instant estimate,
  // marine values are aggregated across the block — and the *Min/*Max fields
  // below carry ranges where the source genuinely provides the underlying
  // hourly samples. MET's optional wind percentile is kept separate because
  // it describes forecast uncertainty at the block start, not a period max.
  blockSpanHours?: number;
  isLowConfidence?: boolean;
  windSpeedMin?: number;
  windSpeedMax?: number;
  /** MET complete-product p90 wind at the block start; never a block maximum. */
  windSpeedP90?: number;
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
  // CAP time of issue. Optional so a browser can still read a payload cached
  // before model 46; the UI falls back to effective for that older shape.
  sent?: string;
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

export {
  ASSEMBLED_FORECAST_CACHE_SCHEMA_VERSION,
  CURRENT_FORECAST_RELEASE,
  CURRENT_RELEASE,
  FORECAST_API_SCHEMA_VERSION,
  FORECAST_DATA_GENERATION_ID,
  FORECAST_MODEL_REVISION,
  FORECAST_PAYLOAD_VERSION,
  MARINE_INGREDIENT_CACHE_SCHEMA_VERSION,
  SUPPORTED_FORECAST_API_SCHEMA_VERSIONS,
  SUPPORTED_FORECAST_PAYLOAD_VERSIONS,
} from './releaseContract';
export type { ForecastReleaseMetadata, ReleaseMetadata } from './releaseContract';

export interface WeatherData {
  hourly: HourlyData[];
  sunrise: string[];
  sunset: string[];
  // Active/upcoming official warnings for the location's region (may be empty
  // or absent — the warning feed is advisory and never blocks a forecast).
  warnings?: WeatherWarning[];
  sources: {
    payloadVersion: number;
    // Exact release identity for the stable /api/vN contract.
    release: ForecastReleaseMetadata;
    weather: string;
    waves: string;
    water: string;
    coordinate: {
      latitude: number;
      longitude: number;
    };
    location: {
      id: string;
      forecastConfigRevision: number;
      name: string;
      areaName: string;
    };
    // When the Worker last successfully BUILT this payload. Precise.
    fetchedAt: string;
    cacheHealth?: {
      status: 'current' | 'stale';
      // When the Worker last successfully reached upstream — a COARSE,
      // operator-facing contact time. Keep it on /health and /status; main-page
      // forecast freshness must use fetchedAt.
      //
      // The assembled forecast is not rewritten for timestamp-only changes.
      // Responses instead overlay the shared, six-tick heartbeat when this city
      // has a recorded success and no newer unsuccessful outcome. A skip or
      // failure deliberately keeps the city's older successful stamp visible.
      //
      // Three separate bugs came from treating it as precise: a healthy forecast
      // reported as "Couldn't refresh", a false "Could not reach the forecast
      // service" banner on an ordinary cold boot, and a /status column that
      // looked like a missed cron tick. For "did WE reach the Worker?" use
      // getWorkerContactMs() from cache.ts, which is exact and ours. For "is the
      // Worker alive?" the Worker's own /health owns that, with a threshold set
      // well above the heartbeat throttle.
      lastAttemptAt: string;
      message?: string;
      // MET Norway cache headers from the run the cache was built against.
      weatherExpires?: string;
      weatherLastModified?: string;
      // DMI run provenance for the marine values in this assembled payload.
      // Older cached payloads may omit it; either source may also be absent.
      marineInstances?: {
        water?: { collection: string; id: string; declaredEndMs?: number };
        waves?: { collection: string; id: string; declaredEndMs?: number };
      };
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
