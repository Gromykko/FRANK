import type { HourlyData } from '../forecast/types';
import { getWeatherDescription } from '../forecast/weatherCodes';
import { CURRENT_LOCATION } from '../../config/locations';
import type { ForecastLocation, WindSector } from '../../config/locations';

export type SafetyRating = 'safe' | 'caution' | 'danger';

// Below this sustained wind speed, wind-against-water-level chop is negligible,
// so the tide-conflict rule stays quiet. A gentle breeze opposing the tide
// doesn't build the short steep waves the rule warns about.
const CHOP_WIND_GATE_MS = 4.0;

// A sector may wrap through north (min > max, e.g. 315°–45°): membership is
// then "at or past min OR at or before max".
const inSector = (deg: number, min: number, max: number) =>
  min <= max ? deg >= min && deg <= max : deg >= min || deg <= max;

// MET Norway decides the weather condition (its own symbol_code). FRANK
// only maps that symbol to a severity — no custom weather derivation, no raw
// lightning probability. Thunder and heavy precipitation are Danger; fog, snow,
// sleet, and moderate rain are Caution; light rain and dry skies are safe.
function severityFromMetSymbol(symbol: string | undefined): SafetyRating {
  if (!symbol) return 'safe';
  const base = symbol.replace(/_(day|night|polartwilight)$/, '');
  if (base.includes('thunder')) return 'danger';
  if (base.includes('fog')) return 'caution';
  // Frozen precipitation implies cold, wintry water — always at least Caution.
  // Snow SHOWERS are Danger like the WMO 85/86 fallback and the manual say
  // (squally, low-visibility bursts), matching heavy snow.
  if (base.includes('snow')) {
    return base.includes('heavy') || base.includes('showers') ? 'danger' : 'caution';
  }
  if (base.includes('sleet')) {
    return base.includes('heavy') ? 'danger' : 'caution';
  }
  if (base.includes('rain')) {
    if (base.includes('heavy')) return 'danger';
    // Showers are gusty/squally even when light — at least Caution (WMO 80).
    if (base.includes('showers')) return 'caution';
    if (base.includes('light')) return 'safe';
    return 'caution';
  }
  return 'safe'; // clearsky, fair, partlycloudy, cloudy
}

// Fallback for any legacy cache entry that predates symbol_code: map the WMO
// weather_code (WMO 4677) to the same severity bands.
const WEATHER_CODE_SEVERITY: Record<number, SafetyRating> = {
  0: 'safe', 1: 'safe', 2: 'safe', 3: 'safe',   // clear -> overcast
  45: 'caution', 48: 'caution',                 // fog
  51: 'safe', 53: 'caution', 55: 'caution',     // drizzle
  56: 'caution', 57: 'caution',                 // freezing drizzle
  61: 'caution', 63: 'caution', 65: 'danger',   // rain
  66: 'caution', 67: 'danger',                  // freezing rain
  71: 'caution', 73: 'danger', 75: 'danger',    // snow
  77: 'caution',                                // snow grains
  80: 'caution', 81: 'caution', 82: 'danger',   // rain showers
  85: 'danger', 86: 'danger',                   // snow showers
  95: 'danger', 96: 'danger', 99: 'danger',     // thunderstorm
};

// Each reason carries the severity that produced it, so the UI can colour its
// bullet by that reason's own level rather than the hour's overall rating.
export interface SafetyReason {
  text: string;
  severity: SafetyRating;
}

export interface SafetyAnalysis {
  rating: SafetyRating;
  reasons: SafetyReason[];
}

import type { SafetySettings } from './presets';
import { floorCaution } from './presets';
import { interpolate } from '../../i18n/interpolate';
import type { Translate } from '../../i18n/interpolate';

// Resolve a location's curated wind sectors against the user's per-sector cap
// overrides (and any legacy angle override), applying the caution ≥ safe + 0.5
// floor. Angles come from config; only the caps are user-tunable.
export function resolveSectors(location: ForecastLocation, settings: SafetySettings): WindSector[] {
  return location.windSectors.map((sector) => {
    const cap = settings.sectorLimits?.[sector.id];
    const angle = settings.sectorAngles?.[sector.id];
    const safeLimit = cap?.safe ?? sector.safeLimit;
    const cautionLimit = floorCaution(safeLimit, cap?.caution ?? sector.cautionLimit);
    return {
      ...sector,
      min: angle?.min ?? sector.min,
      max: angle?.max ?? sector.max,
      safeLimit,
      cautionLimit,
    };
  });
}

export function getWindSpeedLabel(speed: number): string {
  if (speed <= 0.2) return 'Calm';
  if (speed <= 1.5) return 'Light Air';
  if (speed <= 3.3) return 'Light Breeze';
  if (speed <= 5.4) return 'Gentle Breeze';
  if (speed <= 7.9) return 'Moderate Breeze';
  if (speed <= 10.7) return 'Fresh Breeze';
  if (speed <= 13.8) return 'Strong Breeze';
  if (speed <= 17.1) return 'Near Gale';
  if (speed <= 20.7) return 'Gale';
  if (speed <= 24.4) return 'Strong Gale';
  return 'Storm';
}

export function getWaveHeightLabel(height: number): string {
  if (height <= 0.1) return 'Flat / Calm';
  if (height <= 0.5) return 'Smooth / Small Ripples';
  if (height <= 1.25) return 'Slight / Choppy';
  if (height <= 2.5) return 'Moderate / Rough';
  return 'Very Rough / High';
}

// Rules only ratchet the rating up, never down: every enabled rule runs, any
// can push safe -> caution -> danger, and none can walk back a level another
// rule already set. Every triggered reason is kept.
export function analyzeSafetyConditions(
  data: HourlyData,
  settings: SafetySettings,
  nextHourTide?: number,
  // Reason texts route through this so the UI can pass the i18n t(); the
  // default is a plain English formatter with the same {0}-placeholder
  // semantics (findLaunchWindows and the tests use ratings/English as-is).
  translate: Translate = interpolate
): SafetyAnalysis {
  const reasons: SafetyReason[] = [];
  let rating: SafetyRating = 'safe';

  const addReason = (severity: SafetyRating, text: string) => {
    reasons.push({ severity, text });
  };

  // These thresholds are inclusive (value ≥ limit triggers), so a reading that
  // sits exactly on the limit should read "at your limit", not "exceeds". Base
  // the choice on the DISPLAYED (rounded) value so it matches the panel — a raw
  // 0.2012 shown as "0.20" reads "at your 0.20 limit", never "0.20 exceeds 0.2".
  const limitReason = (
    value: number, limit: number, decimals: number,
    atKey: string, overKey: string, ...args: (string | number)[]
  ) => translate(value.toFixed(decimals) === limit.toFixed(decimals) ? atKey : overKey, ...args);

  const enableWindSpeed = settings.enableWindSpeed ?? true;
  if (enableWindSpeed) {
    const windLabel = translate(getWindSpeedLabel(data.windSpeed));
    if (data.windSpeed >= settings.maxWindSpeedCaution) {
      rating = 'danger';
      addReason('danger', limitReason(data.windSpeed, settings.maxWindSpeedCaution, 1,
        'Wind speed: {0} m/s ({1}). At your danger limit of {2} m/s.',
        'Wind speed: {0} m/s ({1}). Exceeds your danger limit of {2} m/s.',
        data.windSpeed.toFixed(1), windLabel, settings.maxWindSpeedCaution));
    } else if (data.windSpeed >= settings.maxWindSpeedSafe) {
      rating = 'caution';
      addReason('caution', limitReason(data.windSpeed, settings.maxWindSpeedSafe, 1,
        'Wind speed: {0} m/s ({1}). At your safe limit of {2} m/s.',
        'Wind speed: {0} m/s ({1}). Exceeds your safe limit of {2} m/s.',
        data.windSpeed.toFixed(1), windLabel, settings.maxWindSpeedSafe));
    }
  }

  // Gusts are a sub-limit of Max Wind (the UI disables the gust toggle when
  // wind is off), so turning Max Wind off also silences the gust check. The
  // gust danger ceiling is safe limit + the user's gust margin — the built-in
  // presets place that exactly on the caution limit, but a custom margin
  // moves the ceiling with it, as the settings panel and manual describe.
  const enableWindGust = enableWindSpeed && (settings.enableWindGust ?? true);
  if (enableWindGust) {
    const gustLabel = translate(getWindSpeedLabel(data.windGust));
    const gustDangerLimit = settings.maxWindSpeedSafe + (settings.gustMargin ?? 2.5);
    if (data.windGust >= gustDangerLimit) {
      rating = 'danger';
      addReason('danger', limitReason(data.windGust, gustDangerLimit, 1,
        'Wind gusts: {0} m/s ({1}). At your gust ceiling of {2} m/s.',
        'Wind gusts: {0} m/s ({1}). Above your gust ceiling of {2} m/s.',
        data.windGust.toFixed(1), gustLabel, gustDangerLimit));
    } else if (data.windGust >= settings.maxWindSpeedSafe) {
      if (rating !== 'danger') rating = 'caution';
      addReason('caution', limitReason(data.windGust, settings.maxWindSpeedSafe, 1,
        'Wind gusts: {0} m/s ({1}). At your safe limit of {2} m/s.',
        'Wind gusts: {0} m/s ({1}). Exceeds your safe limit of {2} m/s.',
        data.windGust.toFixed(1), gustLabel, settings.maxWindSpeedSafe));
    }
  }

  // Local wind sectors: one pass over the fjord's curated sectors. Each sector
  // the wind falls within applies its own safe/danger caps; onshore/offshore
  // membership feeds the wind-against-water-level rule below (cross-shore
  // sectors set neither flag, so they opt out of it).
  const enableCustom = settings.enableCustomWindDirs ?? false;
  const sectors = enableCustom ? resolveSectors(CURRENT_LOCATION, settings) : [];
  let windIsOnshore = false;
  let windIsOffshore = false;
  const windDir = Math.round(data.windDirection);
  for (const sector of sectors) {
    if (!inSector(data.windDirection, sector.min, sector.max)) continue;
    if (sector.exposure === 'onshore') windIsOnshore = true;
    else if (sector.exposure === 'offshore') windIsOffshore = true;
    // In user copy the upper boundary is always the DANGER cap — calling it a
    // "caution cap" on a red reason read as caution, not Rough.
    if (data.windSpeed >= sector.cautionLimit) {
      rating = 'danger';
      addReason('danger', limitReason(data.windSpeed, sector.cautionLimit, 1,
        '{0} wind ({1}°) is at your {2} m/s danger cap for this direction.',
        '{0} wind ({1}°) is over your {2} m/s danger cap for this direction.',
        translate(sector.label), windDir, sector.cautionLimit));
    } else if (data.windSpeed >= sector.safeLimit) {
      if (rating !== 'danger') rating = 'caution';
      addReason('caution', limitReason(data.windSpeed, sector.safeLimit, 1,
        '{0} wind ({1}°) is at your {2} m/s safe cap for this direction.',
        '{0} wind ({1}°) is over your {2} m/s safe cap for this direction.',
        translate(sector.label), windDir, sector.safeLimit));
    }
  }

  if (enableCustom && nextHourTide !== undefined) {
    const isWaterRising = nextHourTide > data.tideLevel;
    // Offshore wind opposes rising water; onshore wind opposes falling water.
    if ((isWaterRising && windIsOffshore) || (!isWaterRising && windIsOnshore)) {
      if (data.windSpeed > CHOP_WIND_GATE_MS) {
        if (rating !== 'danger') rating = 'caution';
        addReason('caution', translate('Wind-against-water-level conflict: wind opposes {0} water level. Expect steeper chop.', translate(isWaterRising ? 'rising' : 'falling')));
      }
    }
  }

  const enableWaterTemp = settings.enableWaterTemp ?? true;
  if (enableWaterTemp) {
    if (data.tempWater < settings.minWaterTempCaution) {
      rating = 'danger';
      addReason('danger', translate("Water temperature: {0}°C — colder than your danger limit of {1}°C. You'd really want a drysuit or heavy thermals for this.", data.tempWater.toFixed(1), settings.minWaterTempCaution));
    } else if (data.tempWater < settings.minWaterTempSafe) {
      if (rating !== 'danger') rating = 'caution';
      addReason('caution', translate('Water temperature: {0}°C — under your safe limit of {1}°C. Worth layering up.', data.tempWater.toFixed(1), settings.minWaterTempSafe));
    }
  }

  const enableWaveHeight = settings.enableWaveHeight ?? true;
  const enableWaveCaution = settings.enableWaveCaution ?? true;
  if (enableWaveHeight) {
    const waveLabel = translate(getWaveHeightLabel(data.waveHeight));
    // The danger ceiling always applies when wave height is enabled; the
    // "wave caution margin" toggle only controls the intermediate caution band.
    if (data.waveHeight >= settings.maxWaveHeightCaution) {
      rating = 'danger';
      addReason('danger', limitReason(data.waveHeight, settings.maxWaveHeightCaution, 2,
        'Wave height: {0} m ({1}). At your danger limit of {2} m.',
        'Wave height: {0} m ({1}). Exceeds your danger limit of {2} m.',
        data.waveHeight.toFixed(2), waveLabel, settings.maxWaveHeightCaution));
    } else if (enableWaveCaution && data.waveHeight >= settings.maxWaveHeightSafe) {
      if (rating !== 'danger') rating = 'caution';
      addReason('caution', limitReason(data.waveHeight, settings.maxWaveHeightSafe, 2,
        'Wave height: {0} m ({1}). At your safe limit of {2} m.',
        'Wave height: {0} m ({1}). Exceeds your safe limit of {2} m.',
        data.waveHeight.toFixed(2), waveLabel, settings.maxWaveHeightSafe));
    }
  }

  // Weather condition severity. MET Norway's symbol_code decides the condition
  // (rain, snow, fog, thunderstorm); we only map it to a severity and surface
  // the human-readable description (via the symbol's mapped WMO code). No custom
  // derivation, no lightning probability, no configurable rain limit. The
  // weather_code path is a fallback for any pre-symbol_code cache entry.
  const weatherSeverity = data.symbolCode
    ? severityFromMetSymbol(data.symbolCode)
    : WEATHER_CODE_SEVERITY[data.weatherCode] ?? 'safe';
  const weatherDesc = translate(getWeatherDescription(data.weatherCode));
  if (weatherSeverity === 'danger') {
    rating = 'danger';
    addReason('danger', translate('{0} — rough out there, probably one to skip.', weatherDesc));
  } else if (weatherSeverity === 'caution') {
    if (rating !== 'danger') rating = 'caution';
    addReason('caution', translate('{0} — worth keeping an eye on.', weatherDesc));
  }

  // Longer-range outlook blocks span several hours across the day/night
  // boundary, so they are never marked as nighttime (matching the meteogram,
  // which doesn't dim them either).
  if ((settings.daylightOnly ?? true) && !data.isDay && !data.blockSpanHours) {
    if (rating !== 'danger') rating = 'caution';
    addReason('caution', translate('Nighttime: outside sunrise-to-sunset paddling hours.'));
  }

  if (reasons.length === 0) {
    // Describe the conditions in the standard terms (Beaufort wind, sea state,
    // MET weather label) instead of repeating the numbers shown above. The
    // bands match getWaveHeightLabel, phrased for prose.
    const seaState = translate(data.waveHeight <= 0.1 ? 'calm water'
      : data.waveHeight <= 0.5 ? 'small ripples'
      : data.waveHeight <= 1.25 ? 'choppy water'
      : data.waveHeight <= 2.5 ? 'rough water'
      : 'very rough water');
    addReason('safe', translate("Everything's within your limits — {0}, {1}, {2}.", translate(getWindSpeedLabel(data.windSpeed)).toLowerCase(), seaState, weatherDesc.toLowerCase()));
  }

  return { rating, reasons };
}
