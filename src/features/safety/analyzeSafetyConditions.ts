import type { HourlyData } from '../forecast/types';
import { getWeatherDescription } from '../forecast/weatherCodes';
import { CURRENT_LOCATION } from '../../config/locations';
import type { ForecastLocation, WindSector } from '../../config/locations';
import { assessBlockDaylight } from './blockDaylight';
import type { SunTimes } from './blockDaylight';

export type SafetyRating = 'safe' | 'caution' | 'danger';

// The one place a rating becomes a word for the user. Shared so the header and
// the timeline's screen-reader labels can't drift apart — they used to, and a
// screen-reader user arrowing the timeline heard "DANGER" while the status bar
// said "Rough": two vocabularies for one verdict.
export const RATING_WORD: Record<SafetyRating, string> = {
  safe: 'Good to go',
  caution: 'Take care',
  danger: 'Rough',
};

// Below this sustained wind speed, wind-against-water-level chop is negligible,
// so the tide-conflict rule stays quiet. A gentle breeze opposing the tide
// doesn't build the short steep waves the rule warns about.
const CHOP_WIND_GATE_MS = 4.0;

// DMI water level is stored in metres but shown to users in whole centimetres.
// Changes of half a displayed centimetre or less are therefore treated as
// steady: they are below the UI's precision and can be model/rounding noise,
// not evidence that wind is opposing a real rising or falling movement.
const WATER_LEVEL_TREND_TOLERANCE_M = 0.005;

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
    // Sleet showers are as squally and low-visibility as snow showers, and
    // colder-wet — rated the same rather than one band softer.
    return base.includes('heavy') || base.includes('showers') ? 'danger' : 'caution';
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
// weather_code (WMO 4677) to the same severity bands. These MUST agree with
// severityFromMetSymbol above via metSymbolToWmoCode — where they disagreed,
// identical weather rated differently depending on how old the payload was.
const WEATHER_CODE_SEVERITY: Record<number, SafetyRating> = {
  0: 'safe', 1: 'safe', 2: 'safe', 3: 'safe',   // clear -> overcast
  45: 'caution', 48: 'caution',                 // fog
  51: 'safe', 53: 'caution', 55: 'caution',     // drizzle
  56: 'caution', 57: 'caution',                 // freezing drizzle
  61: 'safe', 63: 'caution', 65: 'danger',      // rain ('lightrain' is safe)
  // 66 hosts both plain/light sleet (caution live) AND sleet showers (danger
  // live) — metSymbolToWmoCode folds all four into it, so exact agreement is
  // impossible. Take the stricter band: a legacy row must never under-warn.
  66: 'danger', 67: 'danger',                   // freezing rain / sleet
  71: 'caution', 73: 'caution', 75: 'danger',   // snow ('snow' is caution)
  77: 'caution',                                // snow grains
  80: 'caution', 81: 'caution', 82: 'danger',   // rain showers
  85: 'danger', 86: 'danger',                   // snow showers
  95: 'danger', 96: 'danger', 99: 'danger',     // thunderstorm
};

// Verdict-producing reasons carry the severity they produced, so the UI can
// colour them independently from the hour's overall rating. An information
// reason discloses which rule path was used without changing that verdict.
export interface SafetyReason {
  text: string;
  severity: SafetyRating | 'info';
}

export interface SafetyAnalysis {
  rating: SafetyRating;
  reasons: SafetyReason[];
}

export interface SafetyAnalysisContext {
  location?: ForecastLocation;
  blockDaylight?: {
    /**
     * Whole-period UI ratings must disclose any night contained by a block.
     * The launch-window planner deliberately defers that rule so it can first
     * assess weather/marine conditions and then offer only the daylight slice.
     */
    mode?: 'whole-period' | 'defer-to-window';
    sun?: SunTimes;
  };
}

import type { SafetySettings } from './presets';
import { floorCaution } from './presets';
import { READING_DECIMALS, roundToDecimals } from '../../utils/number';
import { interpolate } from '../../i18n/interpolate';
import type { Translate } from '../../i18n/interpolate';

// Resolve a location's curated wind sectors against the user's per-sector cap
// overrides, applying the caution ≥ safe + 0.5 floor. Angles come from config;
// only the caps are user-tunable.
export function resolveSectors(location: ForecastLocation, settings: SafetySettings): WindSector[] {
  return location.windSectors.map((sector) => {
    const cap = settings.sectorLimits?.[sector.id];
    const safeLimit = cap?.safe ?? sector.safeLimit;
    const cautionLimit = floorCaution(safeLimit, cap?.caution ?? sector.cautionLimit);
    return {
      ...sector,
      safeLimit,
      cautionLimit,
    };
  });
}

// A value FRANK can actually assess. Every threshold below is a `>=`/`<`
// comparison, and those are ALL false against NaN — so an hour with a missing
// reading would pass every rule untouched and be reported "safe". Unknown is
// not safe, and this is the one verdict the app must never invent.
const isReading = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

// Speeds and heights are magnitudes: a finite negative number is not a calm
// reading, it is a malformed/sentinel value. Keep signed temperatures and tide
// levels on isReading because sub-zero values are physically meaningful there.
const isNonnegativeReading = (value: unknown): value is number =>
  isReading(value) && value >= 0;

const isBearing = (value: unknown): value is number =>
  isReading(value) && value >= 0 && value < 360;

export function getWindSpeedLabel(speed: number): string {
  if (!isNonnegativeReading(speed)) return 'Unknown';
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
  if (!isNonnegativeReading(height)) return 'Unknown';
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
  translate: Translate = interpolate,
  context?: SafetyAnalysisContext,
): SafetyAnalysis {
  const reasons: SafetyReason[] = [];
  let rating: SafetyRating = 'safe';

  // Readings an enabled rule needed but couldn't use. Collected rather than
  // returned early, so a rule that CAN run (a gale) still gets to speak.
  const missing: string[] = [];

  const addReason = (severity: SafetyRating, text: string) => {
    reasons.push({ severity, text });
    if (severity === 'danger') rating = 'danger';
    else if (severity === 'caution' && rating !== 'danger') rating = 'caution';
  };

  // These thresholds are inclusive (value ≥ limit triggers), so a reading that
  // sits exactly on the limit should read "at your limit", not "exceeds". Base
  // the choice on the DISPLAYED (rounded) value so it matches the panel — a raw
  // 0.2012 shown as "0.20" reads "at your 0.20 limit", never "0.20 exceeds 0.2".
  // Both numbers are printed at the same precision as the comparison that chose
  // the wording, so a derived limit like 0.1 + 0.2 reads "0.30", never
  // "0.30000000000000004", and 8 reads "8.0" next to a value of "8.0".
  const limitReason = (
    value: number, limit: number, decimals: number,
    atKey: string, overKey: string, ...args: (string | number)[]
  ) => translate(value.toFixed(decimals) === limit.toFixed(decimals) ? atKey : overKey, ...args);

  const enableWindSpeed = settings.enableWindSpeed ?? true;
  const enableCustom = settings.enableCustomWindDirs ?? false;

  // MET's p90 is an instant uncertainty estimate at the block start and stays
  // informational only. Safety evaluates the central sustained-wind reading.
  // Judged at the precision it is DISPLAYED at, so the app can never assert a
  // verdict the numbers on screen contradict. See READING_DECIMALS.
  const windSpeedForSafety = roundToDecimals(data.windSpeed, READING_DECIMALS.windSpeed);
  const gustForSafety = roundToDecimals(data.windGust, READING_DECIMALS.windGust);
  const waveForSafety = roundToDecimals(data.waveHeight, READING_DECIMALS.waveHeight);
  const waterTempForSafety = roundToDecimals(data.tempWater, READING_DECIMALS.tempWater);
  const hasWindSpeed = isNonnegativeReading(windSpeedForSafety);

  // Wind speed feeds both the general limit and the per-sector caps, so it is
  // required as soon as either is on.
  if ((enableWindSpeed || enableCustom) && !hasWindSpeed) missing.push('wind speed');

  if (enableWindSpeed && hasWindSpeed) {
    const windLabel = translate(getWindSpeedLabel(windSpeedForSafety));
    if (windSpeedForSafety >= settings.maxWindSpeedCaution) {
      rating = 'danger';
      addReason('danger', limitReason(windSpeedForSafety, settings.maxWindSpeedCaution, 1,
        'Wind speed: {0} m/s ({1}). At your danger limit of {2} m/s.',
        'Wind speed: {0} m/s ({1}). Exceeds your danger limit of {2} m/s.',
        windSpeedForSafety.toFixed(1), windLabel, settings.maxWindSpeedCaution.toFixed(1)));
    } else if (windSpeedForSafety >= settings.maxWindSpeedSafe) {
      rating = 'caution';
      addReason('caution', limitReason(windSpeedForSafety, settings.maxWindSpeedSafe, 1,
        'Wind speed: {0} m/s ({1}). At your safe limit of {2} m/s.',
        'Wind speed: {0} m/s ({1}). Exceeds your safe limit of {2} m/s.',
        windSpeedForSafety.toFixed(1), windLabel, settings.maxWindSpeedSafe.toFixed(1)));
    }
  }

  // Gusts are a sub-limit of Max Wind (the UI disables the gust toggle when
  // wind is off), so turning Max Wind off also silences the gust check. The
  // gust danger ceiling is safe limit + the user's gust margin — the built-in
  // presets place that exactly on the caution limit, but a custom margin
  // moves the ceiling with it, as the settings panel and manual describe.
  const enableWindGust = enableWindSpeed && (settings.enableWindGust ?? true);
  // MET issues no gust forecast for the longer-range blocks, so an absent gust
  // there is a known limit of the source, not a hole in this hour's data.
  const hasWindGust = isNonnegativeReading(gustForSafety);
  if (enableWindGust && !hasWindGust && (!data.blockSpanHours || isReading(gustForSafety))) missing.push('wind gusts');
  if (enableWindGust && hasWindGust) {
    const gustLabel = translate(getWindSpeedLabel(gustForSafety));
    const gustDangerLimit = settings.maxWindSpeedSafe + (settings.gustMargin ?? 2.5);
    if (gustForSafety >= gustDangerLimit) {
      addReason('danger', limitReason(gustForSafety, gustDangerLimit, 1,
        'Wind gusts: {0} m/s ({1}). At your gust ceiling of {2} m/s.',
        'Wind gusts: {0} m/s ({1}). Above your gust ceiling of {2} m/s.',
        gustForSafety.toFixed(1), gustLabel, gustDangerLimit.toFixed(1)));
    } else if (gustForSafety >= settings.maxWindSpeedSafe) {
      addReason('caution', limitReason(gustForSafety, settings.maxWindSpeedSafe, 1,
        'Wind gusts: {0} m/s ({1}). At your safe limit of {2} m/s.',
        'Wind gusts: {0} m/s ({1}). Exceeds your safe limit of {2} m/s.',
        gustForSafety.toFixed(1), gustLabel, settings.maxWindSpeedSafe.toFixed(1)));
    }
  }

  // Local wind sectors: one pass over the fjord's curated sectors. Each sector
  // the wind falls within applies its own safe/danger caps; onshore/offshore
  // membership feeds the wind-against-water-level rule below. A valid bearing
  // that matches none of the curated sectors is the cross-shore state.
  const hasWindDir = isBearing(data.windDirection);
  if (enableCustom && !hasWindDir) missing.push('wind direction');
  const hasSectorAssessment = enableCustom && hasWindSpeed && hasWindDir;
  const sectors = hasSectorAssessment
    ? resolveSectors(context?.location ?? CURRENT_LOCATION, settings)
    : [];
  let windIsOnshore = false;
  let windIsOffshore = false;
  let windSectorMatched = false;
  // 359.6° rounds to 360, which is not a bearing — wrap it back to 0.
  // Rounded and wrapped once, then used for BOTH the sector test and the text.
  // Testing the raw bearing meant 44.6 deg printed as "45 deg NE" - the manual's
  // Easterly zone, with its tighter cap - while the rule read 44.6, missed the
  // sector, and applied the looser general cap instead. Rounding pulls a
  // borderline bearing INTO the sector, and a sector cap is never looser than
  // the flat one, so this can only ever tighten a verdict.
  const windDir = ((Math.round(data.windDirection) % 360) + 360) % 360;
  for (const sector of sectors) {
    if (!inSector(windDir, sector.min, sector.max)) continue;
    windSectorMatched = true;
    if (sector.exposure === 'onshore') windIsOnshore = true;
    else if (sector.exposure === 'offshore') windIsOffshore = true;
    // In user copy the upper boundary is always the DANGER cap — calling it a
    // "caution cap" on a red reason read as caution, not Rough.
    if (windSpeedForSafety >= sector.cautionLimit) {
      addReason('danger', limitReason(windSpeedForSafety, sector.cautionLimit, 1,
        '{0} wind ({1}°) is at your {2} m/s danger cap for this direction.',
        '{0} wind ({1}°) is over your {2} m/s danger cap for this direction.',
        translate(sector.label), windDir, sector.cautionLimit.toFixed(1)));
    } else if (windSpeedForSafety >= sector.safeLimit) {
      if (rating !== 'danger') rating = 'caution';
      addReason('caution', limitReason(windSpeedForSafety, sector.safeLimit, 1,
        '{0} wind ({1}°) is at your {2} m/s safe cap for this direction.',
        '{0} wind ({1}°) is over your {2} m/s safe cap for this direction.',
        translate(sector.label), windDir, sector.safeLimit.toFixed(1)));
    }
  }

  const windIsCrossShore = hasSectorAssessment && !windSectorMatched;

  // Needs both water levels to tell rising from falling. Without them the rule
  // simply doesn't run — it's a refinement on top of the wind rules, not a
  // hazard of its own, so an absent tide series isn't reported as missing data.
  if (enableCustom && isReading(nextHourTide) && isReading(data.tideLevel) && hasWindSpeed) {
    const waterLevelDelta = nextHourTide - data.tideLevel;
    const waterTrend = waterLevelDelta > WATER_LEVEL_TREND_TOLERANCE_M
      ? 'rising'
      : waterLevelDelta < -WATER_LEVEL_TREND_TOLERANCE_M
        ? 'falling'
        : 'steady';
    // Offshore wind opposes rising water; onshore wind opposes falling water.
    if ((waterTrend === 'rising' && windIsOffshore) || (waterTrend === 'falling' && windIsOnshore)) {
      if (windSpeedForSafety > CHOP_WIND_GATE_MS) {
        if (rating !== 'danger') rating = 'caution';
        addReason('caution', translate('Wind-against-water-level conflict: wind opposes {0} water level. Expect steeper chop.', translate(waterTrend)));
      }
    }
  }

  const enableWaterTemp = settings.enableWaterTemp ?? true;
  if (enableWaterTemp && !isReading(waterTempForSafety)) missing.push('water temperature');
  if (enableWaterTemp && isReading(waterTempForSafety)) {
    if (waterTempForSafety < settings.minWaterTempCaution) {
      rating = 'danger';
      addReason('danger', translate("Water temperature: {0}°C — colder than your danger limit of {1}°C. You'd really want a drysuit or heavy thermals for this.", waterTempForSafety.toFixed(1), settings.minWaterTempCaution.toFixed(1)));
    } else if (waterTempForSafety < settings.minWaterTempSafe) {
      if (rating !== 'danger') rating = 'caution';
      addReason('caution', translate('Water temperature: {0}°C — under your safe limit of {1}°C. Worth layering up.', waterTempForSafety.toFixed(1), settings.minWaterTempSafe.toFixed(1)));
    }
  }

  const enableWaveHeight = settings.enableWaveHeight ?? true;
  const enableWaveCaution = settings.enableWaveCaution ?? true;
  const hasWaveHeight = isNonnegativeReading(waveForSafety);
  if (enableWaveHeight && !hasWaveHeight) missing.push('wave height');
  if (enableWaveHeight && hasWaveHeight) {
    const waveLabel = translate(getWaveHeightLabel(waveForSafety));
    // The danger ceiling always applies when wave height is enabled; the
    // "wave caution margin" toggle only controls the intermediate caution band.
    if (waveForSafety >= settings.maxWaveHeightCaution) {
      rating = 'danger';
      addReason('danger', limitReason(waveForSafety, settings.maxWaveHeightCaution, 2,
        'Wave height: {0} m ({1}). At your danger limit of {2} m.',
        'Wave height: {0} m ({1}). Exceeds your danger limit of {2} m.',
        waveForSafety.toFixed(2), waveLabel, settings.maxWaveHeightCaution.toFixed(2)));
    } else if (enableWaveCaution && waveForSafety >= settings.maxWaveHeightSafe) {
      if (rating !== 'danger') rating = 'caution';
      addReason('caution', limitReason(waveForSafety, settings.maxWaveHeightSafe, 2,
        'Wave height: {0} m ({1}). At your safe limit of {2} m.',
        'Wave height: {0} m ({1}). Exceeds your safe limit of {2} m.',
        waveForSafety.toFixed(2), waveLabel, settings.maxWaveHeightSafe.toFixed(2)));
    }
  }

  // Weather condition severity. MET Norway's symbol_code decides the condition
  // (rain, snow, fog, thunderstorm); we only map it to a severity and surface
  // the human-readable description (via the symbol's mapped WMO code). No custom
  // derivation, no lightning probability, no configurable rain limit. The
  // weather_code path is a fallback for any pre-symbol_code cache entry.
  // Unknown weather is not safe weather — on either path.
  //
  // The old guard (`!data.symbolCode && !isReading(data.weatherCode)`) was
  // unreachable in production: normalize.ts drops any MET entry without a
  // symbol_code, so every live row HAS one and the first half was never true.
  // An unrecognised symbol therefore fell through severityFromMetSymbol's
  // closing `return 'safe'` straight into a genuine all-clear that read
  // "Everything's within your limits — …, unknown weather."
  //
  // On the live path `weatherCode` is metSymbolToWmoCode(symbolCode), i.e. NaN
  // exactly when the symbol was unrecognised. On the legacy pre-symbol_code
  // path the code is real but may not be in our table, which defaults to
  // 'safe' — so check for presence there instead.
  const weatherKnown = data.symbolCode
    ? isReading(data.weatherCode)
    : data.weatherCode in WEATHER_CODE_SEVERITY;
  if (!weatherKnown) missing.push('weather');
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

  if (settings.daylightOnly ?? true) {
    if (data.blockSpanHours) {
      const mode = context?.blockDaylight?.mode ?? 'whole-period';
      if (mode !== 'defer-to-window') {
        const startMs = Date.parse(data.time);
        const daylight = assessBlockDaylight(
          startMs,
          startMs + data.blockSpanHours * 3_600_000,
          context?.blockDaylight?.sun,
        );
        if (daylight.status !== 'full') {
          if (rating !== 'danger') rating = 'caution';
          if (daylight.status === 'partial') {
            addReason('caution', translate(
              'Daylight: part of this outlook period is outside sunrise-to-sunset paddling hours.',
            ));
          } else if (daylight.status === 'none') {
            addReason('caution', translate(
              'Daylight: this outlook period has no complete hour within sunrise-to-sunset paddling hours.',
            ));
          } else {
            addReason('caution', translate(
              'Daylight: sunrise or sunset is unavailable for this outlook period, so FRANK cannot clear the whole period.',
            ));
          }
        }
      }
    } else if (!data.isDay) {
      if (rating !== 'danger') rating = 'caution';
      addReason('caution', translate('Nighttime: outside sunrise-to-sunset paddling hours.'));
    }
  }

  // An hour FRANK could not fully assess is never cleared. This runs before the
  // all-clear below, so "everything's within your limits" can only be said when
  // every enabled rule actually had a reading to judge.
  if (missing.length > 0) {
    if (rating !== 'danger') rating = 'caution';
    addReason('caution', translate(
      'No reading for {0} this hour, so FRANK cannot clear it. Unknown is not the same as safe — check another source before you launch.',
      missing.map((field) => translate(field)).join(', ')));
  }

  if (reasons.length === 0) {
    // Describe the conditions in the standard terms (Beaufort wind, sea state,
    // MET weather label) instead of repeating the numbers shown above. The
    // bands match getWaveHeightLabel, phrased for prose.
    const seaState = translate(!isNonnegativeReading(waveForSafety) ? 'sea state unknown'
      : waveForSafety <= 0.1 ? 'calm water'
      : waveForSafety <= 0.5 ? 'small ripples'
      : waveForSafety <= 1.25 ? 'choppy water'
      : waveForSafety <= 2.5 ? 'rough water'
      : 'very rough water');

    // Silence from a rule that is switched off is not evidence of safety, and
    // this sentence cannot tell the two apart on its own: with Max Wind
    // disabled it printed "Everything's within your limits — gale, small
    // ripples, clear sky", asserting in a green badge that a gale was inside
    // limits the user had turned off. hasActiveSafetyChecks does not catch it
    // either, because that only fires when EVERY personal limit is off.
    //
    // Keep describing the conditions - that part is useful and true - but stop
    // claiming they were measured against anything, and name what was not.
    const unchecked = [
      settings.enableWindSpeed ? '' : translate('wind'),
      settings.enableWaveHeight ? '' : translate('waves'),
      settings.enableWaterTemp ? '' : translate('water temperature'),
    ].filter(Boolean);

    addReason('safe', unchecked.length > 0
      ? translate(
          data.blockSpanHours
            ? 'Nothing you are still checking flagged the outlook — {0}, {1}, {2}. Not checked: {3}.'
            : 'Nothing you are still checking flagged this — {0}, {1}, {2}. Not checked: {3}.',
          translate(getWindSpeedLabel(data.windSpeed)).toLowerCase(),
          seaState,
          weatherDesc.toLowerCase(),
          unchecked.join(', '),
        )
      : translate(
          data.blockSpanHours
            ? 'The outlook is within your limits — {0}, {1}, {2}.'
            : "Everything's within your limits — {0}, {1}, {2}.",
          translate(getWindSpeedLabel(data.windSpeed)).toLowerCase(),
          seaState,
          weatherDesc.toLowerCase(),
        ));
  }

  // This is a disclosure about absent local rules, not evidence for or against
  // launching. Append it after the normal verdict reasons (including the safe
  // all-clear) so identifying cross-shore never changes or replaces a verdict.
  if (windIsCrossShore) {
    reasons.push({
      severity: 'info',
      text: enableWindSpeed
        ? translate(
            'Cross-shore wind ({0}°): no curated direction-specific cap matches this bearing. The general wind limit is used, and the wind-against-water-level interaction is not evaluated. Missing those local rules does not mean safer conditions.',
            windDir,
          )
        : translate(
            'Cross-shore wind ({0}°): no curated direction-specific cap matches this bearing, and the wind-against-water-level interaction is not evaluated. The general wind limit is switched off, so no wind-speed limit is being applied. Missing those local rules does not mean safer conditions.',
            windDir,
          ),
    });
  }

  return { rating, reasons };
}
