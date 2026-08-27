import type { HourlyData } from '../forecast/types';
import { getMetWeatherDescription, getMetWeatherSeverity } from '../forecast/weatherSymbols';
import { CURRENT_LOCATION } from '../../config/locations';
import type { ForecastLocation, WindSector } from '../../config/locations';
import { assessBlockDaylight } from './blockDaylight';
import type { SunTimes } from './blockDaylight';

export type SafetyRating = 'safe' | 'caution' | 'danger';

// A verdict is always one of the three above. A DISPLAY can additionally show
// no verdict at all: with every check switched off FRANK reports the weather
// and judges nothing, and painting that state amber would be a judgement.
export type DisplayStatus = SafetyRating | 'none';

// The one place a rating becomes a word for the user. Shared so the header and
// the timeline's screen-reader labels can't drift apart — they used to, and a
// screen-reader user arrowing the timeline heard "DANGER" while the status bar
// said "Rough": two vocabularies for one verdict.
export const RATING_WORD: Record<DisplayStatus, string> = {
  safe: 'Good to go',
  caution: 'Take care',
  danger: 'Rough',
  // Not a verdict word. Screen readers announce this where the other three
  // would be, so it has to say that no judgement was made rather than imply a
  // mild one.
  none: 'No verdict',
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

// Verdict-producing reasons carry the severity they produced, so the UI can
// colour them independently from the hour's overall rating.
export interface SafetyReason {
  text: string;
  // 'none' is a statement of fact carrying no verdict - used only where the
  // app has stopped judging.
  severity: DisplayStatus;
}

type VerdictReason = SafetyReason & { severity: SafetyRating };

export interface SafetyAnalysis {
  rating: SafetyRating;
  reasons: SafetyReason[];
  // The bare hazard description, without the advice clause that normally
  // follows it. Weather-only mode reports what the sky is doing but must not
  // say what to do about it, and "Heavy rain" is a fact while "probably one to
  // skip" is a verdict. Only set when a weather hazard actually fired.
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
  // DMI's Beaufort table, including the distinct force 10-12 names:
  // https://www.dmi.dk/vejr-og-atmosfare/temaforside-vind/beaufortskalaen/
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
  if (speed <= 28.4) return 'Storm';
  if (speed <= 32.6) return 'Violent Storm';
  return 'Hurricane';
}

export function getWaveHeightLabel(height: number): string {
  if (!isNonnegativeReading(height)) return 'Unknown';
  // WMO's recommended sea-wave terms, used only as supplemental context for
  // the numeric DMI significant-wave-height reading. Adding "sea" keeps these
  // translation keys distinct from FRANK's Rough verdict. WMO assigns an exact
  // boundary to the lower category, which is why these comparisons are <=.
  // https://community.wmo.int/site/knowledge-hub/programmes-and-initiatives/marine-services/frequently-asked-questions
  if (height <= 0.1) return 'Calm sea';
  if (height <= 0.5) return 'Smooth sea';
  if (height <= 1.25) return 'Slight sea';
  if (height <= 2.5) return 'Moderate sea';
  if (height <= 4) return 'Rough sea';
  if (height <= 6) return 'Very rough sea';
  if (height <= 9) return 'High sea';
  if (height <= 14) return 'Very high sea';
  return 'Phenomenal sea';
}

// Rules only ratchet the rating up, never down: every enabled rule runs, any
// can push safe -> caution -> danger, and none can walk back a level another
// rule already set. Distinct hazards are kept; when the same sustained-wind
// reading trips both the general and direction-specific bands, only the more
// useful of those two explanations is shown.
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

  const addReason = (severity: SafetyRating, text: string): VerdictReason => {
    const reason: VerdictReason = { severity, text };
    reasons.push(reason);
    if (severity === 'danger') rating = 'danger';
    else if (severity === 'caution' && rating !== 'danger') rating = 'caution';
    return reason;
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
  const windLabelForSafety = hasWindSpeed
    ? translate(getWindSpeedLabel(windSpeedForSafety))
    : '';

  // Wind speed feeds both the general limit and the per-sector caps, so it is
  // required as soon as either is on.
  if ((enableWindSpeed || enableCustom) && !hasWindSpeed) missing.push('wind speed');

  type SustainedWindCandidate = {
    reason: VerdictReason;
    threshold: number;
    sectorSpecific: boolean;
  };
  let generalWindCandidate: SustainedWindCandidate | null = null;
  if (enableWindSpeed && hasWindSpeed) {
    if (windSpeedForSafety >= settings.maxWindSpeedCaution) {
      rating = 'danger';
      generalWindCandidate = {
        reason: addReason('danger', limitReason(windSpeedForSafety, settings.maxWindSpeedCaution, 1,
          'Wind speed: {0} m/s ({1}). At your danger limit of {2} m/s.',
          'Wind speed: {0} m/s ({1}). Exceeds your danger limit of {2} m/s.',
          windSpeedForSafety.toFixed(1), windLabelForSafety, settings.maxWindSpeedCaution.toFixed(1))),
        threshold: settings.maxWindSpeedCaution,
        sectorSpecific: false,
      };
    } else if (windSpeedForSafety >= settings.maxWindSpeedSafe) {
      rating = 'caution';
      generalWindCandidate = {
        reason: addReason('caution', limitReason(windSpeedForSafety, settings.maxWindSpeedSafe, 1,
          'Wind speed: {0} m/s ({1}). At your Take care threshold of {2} m/s.',
          'Wind speed: {0} m/s ({1}). Above your Take care threshold of {2} m/s.',
          windSpeedForSafety.toFixed(1), windLabelForSafety, settings.maxWindSpeedSafe.toFixed(1))),
        threshold: settings.maxWindSpeedSafe,
        sectorSpecific: false,
      };
    }
  }

  // Gusts are a sub-limit of the wind rule (the UI disables the gust toggle
  // when wind is off), so turning wind off also silences the gust check. The
  // gust danger ceiling is the Take care threshold + the user's margin — built-in
  // presets place that exactly on the caution limit, but a custom margin
  // moves the ceiling with it, as the settings panel and manual describe.
  const enableWindGust = enableWindSpeed && (settings.enableWindGust ?? true);
  // MET issues no gust forecast for the longer-range blocks, so an absent gust
  // there is a known limit of the source, not a hole in this hour's data.
  const hasWindGust = isNonnegativeReading(gustForSafety);
  if (enableWindGust && !hasWindGust && (!data.blockSpanHours || isReading(gustForSafety))) missing.push('wind gusts');
  let gustWindReason: VerdictReason | null = null;
  if (enableWindGust && hasWindGust) {
    // Beaufort describes sustained/mean wind, not a short gust. Keep the gust
    // numeric instead of assigning it a misleading Beaufort force name.
    const gustDangerLimit = settings.maxWindSpeedSafe + (settings.gustMargin ?? 2.0);
    if (gustForSafety >= gustDangerLimit) {
      gustWindReason = addReason('danger', limitReason(gustForSafety, gustDangerLimit, 1,
        'Wind gusts: {0} m/s. At your wind danger threshold of {1} m/s.',
        'Wind gusts: {0} m/s. Above your wind danger threshold of {1} m/s.',
        gustForSafety.toFixed(1), gustDangerLimit.toFixed(1)));
    } else if (gustForSafety >= settings.maxWindSpeedSafe) {
      gustWindReason = addReason('caution', limitReason(gustForSafety, settings.maxWindSpeedSafe, 1,
        'Wind gusts: {0} m/s. At your Take care threshold of {1} m/s.',
        'Wind gusts: {0} m/s. Above your Take care threshold of {1} m/s.',
        gustForSafety.toFixed(1), settings.maxWindSpeedSafe.toFixed(1)));
    }
  }

  // Local wind sectors: one pass over the fjord's curated sectors. Each sector
  // the wind falls within applies its own safe/danger caps; onshore/offshore
  // membership feeds the wind-against-water-level rule below.
  const hasWindDir = isBearing(data.windDirection);
  if (enableCustom && !hasWindDir) missing.push('wind direction');
  const hasSectorAssessment = enableCustom && hasWindSpeed && hasWindDir;
  const sectors = hasSectorAssessment
    ? resolveSectors(context?.location ?? CURRENT_LOCATION, settings)
    : [];
  let windIsOnshore = false;
  let windIsOffshore = false;
  const sectorWindCandidates: SustainedWindCandidate[] = [];
  // 359.6° rounds to 360, which is not a bearing — wrap it back to 0.
  // Rounded and wrapped once, then used for BOTH the sector test and the text.
  // Testing the raw bearing meant 44.6 deg printed as "45 deg NE" - the manual's
  // Easterly zone, with its tighter cap - while the rule read 44.6, missed the
  // sector, and applied the general cap instead. Rounding makes the rule and
  // displayed whole-degree bearing agree; the controlling-reason selection
  // below still handles profiles whose sector cap is looser than the general one.
  const windDir = ((Math.round(data.windDirection) % 360) + 360) % 360;
  for (const sector of sectors) {
    if (!inSector(windDir, sector.min, sector.max)) continue;
    if (sector.exposure === 'onshore') windIsOnshore = true;
    else if (sector.exposure === 'offshore') windIsOffshore = true;
    // In user copy the upper boundary is always the DANGER cap — calling it a
    // "caution cap" on a red reason read as caution, not Rough.
    if (windSpeedForSafety >= sector.cautionLimit) {
      sectorWindCandidates.push({
        reason: addReason('danger', limitReason(windSpeedForSafety, sector.cautionLimit, 1,
          'Wind speed: {0} m/s ({1}). {2} wind ({3}°) is at your {4} m/s danger threshold for this direction.',
          'Wind speed: {0} m/s ({1}). {2} wind ({3}°) is over your {4} m/s danger threshold for this direction.',
          windSpeedForSafety.toFixed(1), windLabelForSafety, translate(sector.label), windDir,
          sector.cautionLimit.toFixed(1))),
        threshold: sector.cautionLimit,
        sectorSpecific: true,
      });
    } else if (windSpeedForSafety >= sector.safeLimit) {
      if (rating !== 'danger') rating = 'caution';
      sectorWindCandidates.push({
        reason: addReason('caution', limitReason(windSpeedForSafety, sector.safeLimit, 1,
          'Wind speed: {0} m/s ({1}). {2} wind ({3}°) is at your {4} m/s Take care threshold for this direction.',
          'Wind speed: {0} m/s ({1}). {2} wind ({3}°) is over your {4} m/s Take care threshold for this direction.',
          windSpeedForSafety.toFixed(1), windLabelForSafety, translate(sector.label), windDir,
          sector.safeLimit.toFixed(1))),
        threshold: sector.safeLimit,
        sectorSpecific: true,
      });
    }
  }

  // General and sector caps judge the SAME sustained-wind reading. Listing
  // both says the same thing twice, and can bury the separate tide-conflict
  // signal below it. Keep the higher-severity explanation; at equal severity,
  // keep the lower (controlling) threshold; only an exact threshold tie prefers
  // the sector because it names why this bearing has a local cap. Beginner and
  // Custom sectors can be looser than the general band, so blindly suppressing
  // the general reason would hide the rule that actually set the verdict.
  const sustainedWindCandidates = [
    ...(generalWindCandidate ? [generalWindCandidate] : []),
    ...sectorWindCandidates,
  ];
  const severityRank: Record<SafetyRating, number> = { safe: 0, caution: 1, danger: 2 };
  const preferredSustainedWindCandidate = sustainedWindCandidates.length > 0
    ? sustainedWindCandidates.reduce((best, candidate) => {
      const candidateRank = severityRank[candidate.reason.severity];
      const bestRank = severityRank[best.reason.severity];
      if (candidateRank !== bestRank) return candidateRank > bestRank ? candidate : best;
      if (candidate.threshold !== best.threshold) {
        return candidate.threshold < best.threshold ? candidate : best;
      }
      return candidate.sectorSpecific && !best.sectorSpecific ? candidate : best;
    })
    : null;
  if (preferredSustainedWindCandidate) {
    for (const candidate of sustainedWindCandidates) {
      if (candidate === preferredSustainedWindCandidate) continue;
      const index = reasons.indexOf(candidate.reason);
      if (index !== -1) reasons.splice(index, 1);
    }

    // The general check runs before gusts, while sectors are resolved after
    // them. If a sector is the controlling sustained-wind explanation, put it
    // back in that natural order: sustained wind, gust, then distinct hazards.
    if (gustWindReason) {
      const sustainedIndex = reasons.indexOf(preferredSustainedWindCandidate.reason);
      const gustIndex = reasons.indexOf(gustWindReason);
      if (sustainedIndex > gustIndex && gustIndex !== -1) {
        reasons.splice(sustainedIndex, 1);
        reasons.splice(gustIndex, 0, preferredSustainedWindCandidate.reason);
      }
    }
  }

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
        'Wave height: {0} m ({1}). At your Take care threshold of {2} m.',
        'Wave height: {0} m ({1}). Above your Take care threshold of {2} m.',
        waveForSafety.toFixed(2), waveLabel, settings.maxWaveHeightSafe.toFixed(2)));
    }
  }

  // MET's native symbol_code decides the condition and its official English
  // wording. FRANK assigns the paddling severity in the same exhaustive table;
  // it does not translate the symbol through a numeric weather vocabulary.
  // A future/unrecognised symbol is missing evidence, never safe weather.
  const nativeWeatherSeverity = getMetWeatherSeverity(data.symbolCode);
  const weatherDesc = translate(getMetWeatherDescription(data.symbolCode));
  if (!nativeWeatherSeverity) {
    missing.push('weather');
  } else if (nativeWeatherSeverity === 'danger') {
    rating = 'danger';
    addReason('danger', translate('{0} — rough out there, probably one to skip.', weatherDesc));
  } else if (nativeWeatherSeverity === 'caution') {
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
    // Describe the conditions in the same standard terms used everywhere else
    // instead of maintaining a second, contradictory sea-state vocabulary.
    const seaState = translate(getWaveHeightLabel(waveForSafety)).toLowerCase();

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

  return { rating, reasons };
}
