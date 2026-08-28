import type { HourlyData } from '../forecast/types';
import { getMetWeatherDescription, getMetWeatherSeverity } from '../forecast/weatherSymbols';
import { CURRENT_LOCATION } from '../../config/locations';
import type { ForecastLocation, WindSector } from '../../config/locations';
import { assessBlockDaylight } from './blockDaylight';
import type { SunTimes } from './blockDaylight';

export type SafetyRating = 'safe' | 'caution' | 'danger';

const SAFETY_RATING_RANK: Record<SafetyRating, number> = {
  safe: 0,
  caution: 1,
  danger: 2,
};

// A verdict is always one of the three above. A DISPLAY can additionally show
// no verdict at all: with every check switched off FRANK reports the weather
// and judges nothing, and painting that state amber would be a judgement.
export type DisplayStatus = SafetyRating | 'none';

// The one place a rating becomes a word for the user. Shared so the header and
// the timeline's screen-reader labels can't drift apart — they used to, and a
// screen-reader user arrowing the timeline once heard a different label from
// the status bar for the same verdict.
export const RATING_WORD: Record<DisplayStatus, string> = {
  safe: 'Within limits',
  caution: 'Check before launch',
  danger: 'Not recommended',
  // Not a verdict word. Screen readers announce this where the other three
  // would be, so it has to say that no judgement was made rather than imply a
  // mild one.
  none: 'Weather only',
};

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
  // Structured marker used by the planner to keep a pure proximity warning
  // separate from other caution states such as fog, night, or missing data.
  kind?: 'near-limit';
}

type VerdictReason = SafetyReason & { severity: SafetyRating };

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
import { GUST_FACTOR, getNearLimitThreshold } from './presets';
import { READING_DECIMALS, roundToDecimals } from '../../utils/number';
import { interpolate } from '../../i18n/interpolate';
import type { Translate } from '../../i18n/interpolate';

// Resolve a location's wind sectors against the user's per-sector maximum
// overrides. Bearings come from config; only the maximums are user-tunable.
export function resolveSectors(location: ForecastLocation, settings: SafetySettings): WindSector[] {
  return location.windSectors.map((sector) => {
    const cap = settings.sectorLimits?.[sector.id];
    return {
      ...sector,
      maximumAt: cap?.maximumAt ?? sector.maximumAt,
    };
  });
}

// A value FRANK can actually assess. Every threshold below is a numeric
// comparison, and those are ALL false against NaN. Without this guard, an hour
// with a missing reading would pass every rule and look within limits.
const isReading = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

// Speeds and heights are magnitudes: a finite negative number is not a calm
// reading, it is a malformed/sentinel value. Keep signed temperatures on
// isReading because sub-zero values are physically meaningful there.
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
  // the numeric DMI significant-wave-height reading. WMO assigns an exact
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

  const addReason = (
    severity: SafetyRating,
    text: string,
    kind?: SafetyReason['kind'],
  ): VerdictReason => {
    const reason: VerdictReason = { severity, text, ...(kind ? { kind } : {}) };
    reasons.push(reason);
    if (severity === 'danger') rating = 'danger';
    else if (severity === 'caution' && rating !== 'danger') rating = 'caution';
    return reason;
  };

  const enableWindSpeed = settings.enableWindSpeed ?? true;
  // Direction-specific caps refine the main wind check; they are not a second
  // independent wind system. Switching wind off must therefore silence the
  // sector caps as well as the general and gust limits.
  const enableCustom = enableWindSpeed && (settings.enableCustomWindDirs ?? false);

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

  if (enableWindSpeed && !hasWindSpeed) missing.push('wind speed');

  type SustainedWindCandidate = {
    reason: VerdictReason;
    threshold: number;
    sectorSpecific: boolean;
  };
  let generalWindCandidate: SustainedWindCandidate | null = null;
  // The selected value is the maximum. The automatic caution point is 80%,
  // rounded to displayed precision, and exposes shrinking headroom without
  // inventing another user setting. Equality is caution; only a displayed
  // rounded excess is danger.
  if (enableWindSpeed && hasWindSpeed) {
    const windMaximum = roundToDecimals(settings.windLimit, READING_DECIMALS.windSpeed);
    const windCautionAt = getNearLimitThreshold(windMaximum, READING_DECIMALS.windSpeed);
    if (windSpeedForSafety > windMaximum) {
      generalWindCandidate = {
        reason: addReason('danger', translate(
          'Wind speed: {0} m/s ({1}). Above your maximum of {2} m/s.',
          windSpeedForSafety.toFixed(1), windLabelForSafety, windMaximum.toFixed(1),
        )),
        threshold: windMaximum,
        sectorSpecific: false,
      };
    } else if (windSpeedForSafety >= windCautionAt) {
      const headroom = roundToDecimals(windMaximum - windSpeedForSafety, READING_DECIMALS.windSpeed);
      const text = headroom === 0
        ? translate(
          'Wind speed: {0} m/s ({1}). At your maximum of {2} m/s.',
          windSpeedForSafety.toFixed(1), windLabelForSafety, windMaximum.toFixed(1),
        )
        : translate(
          'Wind speed: {0} m/s ({1}). {2} m/s below your maximum of {3} m/s.',
          windSpeedForSafety.toFixed(1), windLabelForSafety, headroom.toFixed(1), windMaximum.toFixed(1),
        );
      generalWindCandidate = {
        reason: addReason('caution', text, 'near-limit'),
        threshold: windMaximum,
        sectorSpecific: false,
      };
    }
  }

  // Gusts are a sub-limit of the wind rule, so turning wind off also silences
  // them. Dividing the forecast gust by GUST_FACTOR and comparing that effective
  // wind with the mean-wind maximum is equivalent to the single derived maximum
  // below. It needs no second user setting; the same automatic caution point
  // applies so gust proximity cannot stay hidden while mean wind is green.
  const enableWindGust = enableWindSpeed && (settings.enableWindGust ?? true);
  // MET issues no gust forecast for the longer-range blocks, so an absent gust
  // there is a known limit of the source, not a hole in this hour's data.
  const hasWindGust = isNonnegativeReading(gustForSafety);
  const gustUnavailableForOutlook = Boolean(
    enableWindGust
    && data.blockSpanHours
    && !hasWindGust
    && !isReading(gustForSafety),
  );
  if (enableWindGust && !hasWindGust && !gustUnavailableForOutlook) missing.push('wind gusts');
  let gustWindReason: VerdictReason | null = null;
  if (enableWindGust && hasWindGust) {
    // Beaufort describes sustained/mean wind, not a short gust. Keep the gust
    // numeric instead of assigning it a misleading Beaufort force name.
    const gustMaximum = roundToDecimals(settings.windLimit * GUST_FACTOR, READING_DECIMALS.windGust);
    const gustCautionAt = getNearLimitThreshold(gustMaximum, READING_DECIMALS.windGust);
    if (gustForSafety > gustMaximum) {
      gustWindReason = addReason('danger', translate(
        'Wind gusts: {0} m/s. Above the {1} m/s maximum derived from your wind limit.',
        gustForSafety.toFixed(1), gustMaximum.toFixed(1),
      ));
    } else if (gustForSafety >= gustCautionAt) {
      const headroom = roundToDecimals(gustMaximum - gustForSafety, READING_DECIMALS.windGust);
      const text = headroom === 0
        ? translate(
          'Wind gusts: {0} m/s. At the {1} m/s maximum derived from your wind limit.',
          gustForSafety.toFixed(1), gustMaximum.toFixed(1),
        )
        : translate(
          'Wind gusts: {0} m/s. {1} m/s below the {2} m/s maximum derived from your wind limit.',
          gustForSafety.toFixed(1), headroom.toFixed(1), gustMaximum.toFixed(1),
        );
      gustWindReason = addReason('caution', text, 'near-limit');
    }
  }

  // Local wind sectors: one pass over the fjord's curated sectors. Each sector
  // the wind falls within applies its own optional maximum.
  const hasWindDir = isBearing(data.windDirection);
  if (enableCustom && !hasWindDir) missing.push('wind direction');
  const hasSectorAssessment = enableCustom && hasWindSpeed && hasWindDir;
  const sectors = hasSectorAssessment
    ? resolveSectors(context?.location ?? CURRENT_LOCATION, settings)
    : [];
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
    const sectorMaximum = roundToDecimals(sector.maximumAt, READING_DECIMALS.windSpeed);
    const sectorCautionAt = getNearLimitThreshold(sectorMaximum, READING_DECIMALS.windSpeed);
    if (windSpeedForSafety > sectorMaximum) {
      sectorWindCandidates.push({
        reason: addReason('danger', translate(
          'Wind speed: {0} m/s ({1}). {2} wind ({3}°) is above your {4} m/s maximum for this direction.',
          windSpeedForSafety.toFixed(1), windLabelForSafety, translate(sector.label), windDir,
          sectorMaximum.toFixed(1))),
        threshold: sectorMaximum,
        sectorSpecific: true,
      });
    } else if (windSpeedForSafety >= sectorCautionAt) {
      const headroom = roundToDecimals(sectorMaximum - windSpeedForSafety, READING_DECIMALS.windSpeed);
      const text = headroom === 0
        ? translate(
          'Wind speed: {0} m/s ({1}). {2} wind ({3}°) is at your {4} m/s maximum for this direction.',
          windSpeedForSafety.toFixed(1), windLabelForSafety, translate(sector.label), windDir,
          sectorMaximum.toFixed(1),
        )
        : translate(
          'Wind speed: {0} m/s ({1}). {2} wind ({3}°) is {4} m/s below your {5} m/s maximum for this direction.',
          windSpeedForSafety.toFixed(1), windLabelForSafety, translate(sector.label), windDir,
          headroom.toFixed(1), sectorMaximum.toFixed(1),
        );
      sectorWindCandidates.push({
        reason: addReason('caution', text, 'near-limit'),
        threshold: sectorMaximum,
        sectorSpecific: true,
      });
    }
  }

  // General and sector caps judge the SAME sustained-wind reading. Listing
  // both says the same thing twice. Keep the higher-severity explanation; at
  // equal severity, keep the lower (controlling) threshold; only an exact
  // threshold tie prefers the sector because it names why this bearing has a
  // local cap. Beginner and
  // Custom sectors can be looser than the general band, so blindly suppressing
  // the general reason would hide the rule that actually set the verdict.
  const sustainedWindCandidates = [
    ...(generalWindCandidate ? [generalWindCandidate] : []),
    ...sectorWindCandidates,
  ];
  const preferredSustainedWindCandidate = sustainedWindCandidates.length > 0
    ? sustainedWindCandidates.reduce((best, candidate) => {
      if (candidate.reason.severity !== best.reason.severity) {
        return SAFETY_RATING_RANK[candidate.reason.severity]
          > SAFETY_RATING_RANK[best.reason.severity]
          ? candidate
          : best;
      }
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

  // The gust check earns its own line only when it says something the
  // sustained-wind line does not. A gust-only warning still identifies a
  // squally hour, and gust danger still stays beside a weaker wind caution.
  // At equal or lower severity, the gust line merely repeats the surviving
  // general/sector wind explanation.
  if (gustWindReason && preferredSustainedWindCandidate) {
    const windSeverity = preferredSustainedWindCandidate.reason.severity;
    const gustSeverity = gustWindReason.severity;
    if (SAFETY_RATING_RANK[gustSeverity] <= SAFETY_RATING_RANK[windSeverity]) {
      const index = reasons.indexOf(gustWindReason);
      if (index !== -1) reasons.splice(index, 1);
      gustWindReason = null;
    }
  }

  const enableWaterTemp = settings.enableWaterTemp ?? true;
  if (enableWaterTemp && !isReading(waterTempForSafety)) missing.push('water temperature');
  if (enableWaterTemp && isReading(waterTempForSafety)) {
    if (waterTempForSafety <= settings.waterTempDangerBelow) {
      addReason('danger', translate(
        'Water temperature: {0}°C. This is at or below your {1}°C lower limit.',
        waterTempForSafety.toFixed(1), settings.waterTempDangerBelow.toFixed(1),
      ));
    } else if (waterTempForSafety < settings.waterTempTakeCareBelow) {
      addReason('caution', translate(
        'Water temperature: {0}°C. This is below your {1}°C check boundary.',
        waterTempForSafety.toFixed(1), settings.waterTempTakeCareBelow.toFixed(1),
      ));
    }
  }

  const enableWaveHeight = settings.enableWaveHeight ?? true;
  const hasWaveHeight = isNonnegativeReading(waveForSafety);
  if (enableWaveHeight && !hasWaveHeight) missing.push('wave height');
  if (enableWaveHeight && hasWaveHeight) {
    const waveLabel = translate(getWaveHeightLabel(waveForSafety));
    const waveMaximum = roundToDecimals(settings.waveLimit, READING_DECIMALS.waveHeight);
    const waveCautionAt = getNearLimitThreshold(waveMaximum, READING_DECIMALS.waveHeight);
    if (waveForSafety > waveMaximum) {
      addReason('danger', translate(
        'Wave height: {0} m ({1}). Above your maximum of {2} m.',
        waveForSafety.toFixed(2), waveLabel, waveMaximum.toFixed(2),
      ));
    } else if (waveForSafety >= waveCautionAt) {
      const headroom = roundToDecimals(waveMaximum - waveForSafety, READING_DECIMALS.waveHeight);
      const text = headroom === 0
        ? translate(
          'Wave height: {0} m ({1}). At your maximum of {2} m.',
          waveForSafety.toFixed(2), waveLabel, waveMaximum.toFixed(2),
        )
        : translate(
          'Wave height: {0} m ({1}). {2} m below your maximum of {3} m.',
          waveForSafety.toFixed(2), waveLabel, headroom.toFixed(2), waveMaximum.toFixed(2),
        );
      addReason('caution', text, 'near-limit');
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
    addReason('danger', translate('{0}. These conditions are not recommended.', weatherDesc));
  } else if (nativeWeatherSeverity === 'caution') {
    addReason('caution', translate('{0}. Check visibility and conditions before launch.', weatherDesc));
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
      addReason('caution', translate('Nighttime: outside sunrise-to-sunset paddling hours.'));
    }
  }

  // An hour FRANK could not fully assess is never cleared. This runs before the
  // all-clear below, so "everything's within your limits" can only be said when
  // every enabled rule actually had a reading to judge.
  if (missing.length > 0) {
    addReason('caution', translate(
      data.blockSpanHours
        ? 'No reading for {0} in this outlook period, so FRANK cannot assess it. Missing data does not count as within limits. Check another source before you launch.'
        : 'No reading for {0} this hour, so FRANK cannot assess it. Missing data does not count as within limits. Check another source before you launch.',
      missing.map((field) => translate(field)).join(', ')));
  }

  if (reasons.length === 0) {
    // Describe the conditions in the same standard terms used everywhere else
    // instead of maintaining a second, contradictory sea-state vocabulary.
    const seaState = translate(getWaveHeightLabel(waveForSafety)).toLowerCase();

    // Silence from a rule that is switched off is not evidence of safety, and
    // this sentence cannot tell the two apart on its own: with the wind rule
    // disabled it printed "Everything's within your limits: gale, small
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

    const windDescription = translate(getWindSpeedLabel(data.windSpeed)).toLowerCase();
    const weatherDescription = weatherDesc.toLowerCase();
    if (unchecked.length > 0) {
      addReason('safe', translate(
        gustUnavailableForOutlook
          ? 'No available outlook reading triggered a check: {0}, {1}, {2}. Gusts are not forecast for this longer-range period. Not checked: {3}.'
          : data.blockSpanHours
            ? 'No enabled outlook check was triggered: {0}, {1}, {2}. Not checked: {3}.'
            : 'No enabled check was triggered: {0}, {1}, {2}. Not checked: {3}.',
        windDescription,
        seaState,
        weatherDescription,
        unchecked.join(', '),
      ));
    } else {
      addReason('safe', translate(
        gustUnavailableForOutlook
          ? 'No available outlook reading triggered a check: {0}, {1}, {2}. Gusts are not forecast for this longer-range period.'
          : data.blockSpanHours
            ? 'No outlook check was triggered: {0}, {1}, {2}.'
            : 'No check was triggered: {0}, {1}, {2}.',
        windDescription,
        seaState,
        weatherDescription,
      ));
    }
  }

  return { rating, reasons };
}

export function isNearLimitOnlyAnalysis(analysis: SafetyAnalysis): boolean {
  return analysis.rating === 'caution'
    && analysis.reasons.length > 0
    && analysis.reasons.every((reason) => reason.severity === 'caution' && reason.kind === 'near-limit');
}
