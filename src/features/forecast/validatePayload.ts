import type { ForecastLocation } from '../../config/locationTypes';
import {
  isSupportedForecastApiSchemaVersion,
  isSupportedForecastPayloadVersion,
} from './releaseContract';
import type { WeatherData } from './types';
import {
  FORECAST_CLOCK_LEAD_TOLERANCE_MS,
  isPlausibleForecastTimestamp,
  isPlausibleSourceTimestamp,
} from './temporalPolicy';

type UnknownRecord = Record<string, unknown>;

export interface ForecastPayloadValidationOptions {
  // Injectable for deterministic boundary tests. Production callers use the
  // browser clock and tolerate the documented device-clock lead.
  nowMs?: number;
  // Workers have an authoritative clock and pass the strict server tolerance;
  // browsers retain the wider default for manually skewed device clocks.
  sourceClockLeadToleranceMs?: number;
}

const REQUIRED_READING_FIELDS = [
  'tempAir',
  'precipitation',
  'windSpeed',
  'windDirection',
  'windGust',
  'waveHeight',
  'waveDirection',
  'wavePeriod',
  'tempWater',
  'tideLevel',
  'currentSpeed',
  'currentDirection',
] as const;

const OPTIONAL_READING_FIELDS = [
  'windSpeedMin',
  'windSpeedMax',
  'windSpeedP90',
  'windGustMax',
  'waveHeightMin',
  'waveHeightMax',
  'tideLevelMin',
  'tideLevelMax',
  'tempWaterMin',
  'tempWaterMax',
] as const;

const NON_NEGATIVE_READING_FIELDS = new Set<string>([
  'precipitation',
  'windSpeed',
  'windGust',
  'waveHeight',
  'wavePeriod',
  'currentSpeed',
  'windSpeedMin',
  'windSpeedMax',
  'windSpeedP90',
  'windGustMax',
  'waveHeightMin',
  'waveHeightMax',
]);

const DIRECTION_READING_FIELDS = new Set<string>([
  'windDirection',
  'waveDirection',
  'currentDirection',
]);

// These are the only period products assembled by normalize.ts. Treating an
// arbitrary duration as a block would make the planner add time that the
// payload does not actually cover.
const SUPPORTED_BLOCK_SPANS = new Set([6, 12]);
const HOUR_MS = 60 * 60 * 1000;
// mapMetPayload clamps this field to at most 90 minutes after assembly. Pin the
// same trust boundary here: this stamp gates Worker rebuilds, so parse-only
// validation would let a poisoned cache suppress MET refresh until exhaustion.
const MAX_WEATHER_EXPIRY_AFTER_FETCH_MS = 90 * 60 * 1000;
const MAX_WEATHER_LAST_MODIFIED_AFTER_FETCH_MS = 5 * 60 * 1000;
// About 111 m north/south and less east/west at Danish latitudes: enough to
// absorb harmless rounding between independently deployed location manifests,
// far too small for another launch area or fjord to pass as the requested one.
const LOCATION_COORDINATE_TOLERANCE_DEGREES = 0.001;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function timestampMs(value: unknown): number | null {
  if (!isNonEmptyString(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isStrictlyIncreasingTimestampArray(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;

  let previous = Number.NEGATIVE_INFINITY;
  for (const item of value) {
    const current = timestampMs(item);
    if (current === null || current <= previous) return false;
    previous = current;
  }

  return true;
}

// null readings become NaN in reviveReadings. NaN therefore means "provider
// did not supply this measurement" and is valid data; infinities, strings and
// absent required fields are corruption rather than missing measurements.
function isReading(value: unknown): value is number {
  return typeof value === 'number' && (Number.isFinite(value) || Number.isNaN(value));
}

function isValidReading(field: string, value: unknown): value is number {
  if (!isReading(value)) return false;
  // reviveReadings maps provider null to NaN, the explicit unavailable
  // sentinel. Bounds apply only to actual measurements.
  if (Number.isNaN(value)) return true;
  if (NON_NEGATIVE_READING_FIELDS.has(field)) return value >= 0;
  if (DIRECTION_READING_FIELDS.has(field)) return value >= 0 && value < 360;
  // Tide and temperature may legitimately be negative.
  return true;
}

function hasValidHourlyRows(value: unknown, nowMs: number): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;

  let previousStart = Number.NEGATIVE_INFINITY;
  let previousEnd = Number.NEGATIVE_INFINITY;

  for (const item of value) {
    if (!isRecord(item)) return false;

    const start = timestampMs(item.time);
    if (
      start === null
      || !isPlausibleForecastTimestamp(start, nowMs)
      || start <= previousStart
      || start < previousEnd
    ) return false;

    if (!isNonEmptyString(item.symbolCode) || typeof item.isDay !== 'boolean') return false;
    if (!REQUIRED_READING_FIELDS.every((field) => isValidReading(field, item[field]))) return false;
    if (!OPTIONAL_READING_FIELDS.every((field) => item[field] === undefined || isValidReading(field, item[field]))) return false;

    if (item.isOutlook !== undefined && typeof item.isOutlook !== 'boolean') return false;
    if (item.isLowConfidence !== undefined && typeof item.isLowConfidence !== 'boolean') return false;
    if (item.weatherSource !== undefined && item.weatherSource !== 'met-locationforecast') return false;
    if (item.marineSource !== undefined && item.marineSource !== 'dmi-dkss-wam') return false;

    const span = item.blockSpanHours;
    if (span !== undefined && (!Number.isInteger(span) || !SUPPORTED_BLOCK_SPANS.has(span as number))) return false;
    // normalize.ts emits outlook rows as one indivisible contract. The planner
    // finds the hourly/outlook boundary via isLowConfidence, then uses the span
    // for duration; accepting only half of that tuple would validate a payload
    // that the planner subsequently interprets with the wrong architecture.
    if (span === undefined) {
      if (item.isLowConfidence === true || item.isOutlook === true) return false;
    } else if (item.isLowConfidence !== true || item.isOutlook !== true) {
      return false;
    }

    const spanHours = span === undefined ? 1 : (span as number);
    previousStart = start;
    previousEnd = start + spanHours * HOUR_MS;
  }

  return true;
}

function isHttpsUrl(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function hasValidWarnings(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;

  return value.every((warning) => {
    if (!isRecord(warning)) return false;
    if (!isNonEmptyString(warning.event)) return false;
    if (!['yellow', 'orange', 'red'].includes(warning.colour as string)) return false;
    if (warning.sent !== undefined && timestampMs(warning.sent) === null) return false;
    if (timestampMs(warning.effective) === null || timestampMs(warning.expires) === null) return false;
    if (warning.onset !== undefined && timestampMs(warning.onset) === null) return false;
    if (!isHttpsUrl(warning.url)) return false;
    if (warning.detailUrl !== undefined && !isHttpsUrl(warning.detailUrl)) return false;
    if (!isOptionalString(warning.severity) || !isOptionalString(warning.areaDesc) || !isOptionalString(warning.title)) return false;
    if (warning.coverage !== undefined && !['confirmed', 'excluded', 'unknown'].includes(warning.coverage as string)) return false;
    return true;
  });
}

function hasValidMarineInstance(value: unknown): boolean {
  return isRecord(value)
    && isNonEmptyString(value.collection)
    && isNonEmptyString(value.id)
    && (value.declaredEndMs === undefined
      || (typeof value.declaredEndMs === 'number'
        && Number.isFinite(value.declaredEndMs)));
}

function hasValidMarineInstances(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return (value.water === undefined || hasValidMarineInstance(value.water))
    && (value.waves === undefined || hasValidMarineInstance(value.waves));
}

function hasValidCacheHealth(
  value: unknown,
  nowMs: number,
  fetchedAtMs: number,
  sourceClockLeadToleranceMs: number,
): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  if (value.status !== 'current' && value.status !== 'stale') return false;
  const lastAttemptMs = timestampMs(value.lastAttemptAt);
  if (
    lastAttemptMs === null
    || !isPlausibleSourceTimestamp(lastAttemptMs, nowMs, sourceClockLeadToleranceMs)
  ) return false;

  if (!isOptionalString(value.message) || !isOptionalString(value.checkedBy)) return false;
  if (value.weatherExpires !== undefined) {
    const weatherExpiresMs = timestampMs(value.weatherExpires);
    if (
      weatherExpiresMs === null
      || weatherExpiresMs > fetchedAtMs + MAX_WEATHER_EXPIRY_AFTER_FETCH_MS
    ) return false;
  }
  if (value.weatherLastModified !== undefined) {
    const weatherLastModifiedMs = timestampMs(value.weatherLastModified);
    if (
      weatherLastModifiedMs === null
      || weatherLastModifiedMs > fetchedAtMs + MAX_WEATHER_LAST_MODIFIED_AFTER_FETCH_MS
    ) return false;
  }
  if (!hasValidMarineInstances(value.marineInstances)) return false;
  if (value.needsRebuild !== undefined && typeof value.needsRebuild !== 'boolean') return false;
  if (value.providerBusy !== undefined && typeof value.providerBusy !== 'boolean') return false;
  if (value.busyProvider !== undefined && !['weather', 'marine', 'services'].includes(value.busyProvider as string)) return false;
  if (value.degradedSources !== undefined && (
    !Array.isArray(value.degradedSources) ||
    !value.degradedSources.every(isNonEmptyString)
  )) return false;

  return true;
}

// Sunrise/sunset and the per-row isDay flag are one derived contract. Checking
// their shapes independently lets a corrupt cache mark midnight as daylight,
// after which Daylight Only and the launch planner both trust the forged flag.
// The schedule must cover every forecast day and agree with every row.
function hasConsistentDaylight(
  hourly: unknown,
  sunrise: string[],
  sunset: string[],
  timezone: string,
): boolean {
  if (!Array.isArray(hourly)) return false;
  if (sunrise.length === 0) return true;

  let dayKey: Intl.DateTimeFormat;
  try {
    dayKey = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch {
    return false;
  }

  const intervals = new Map<string, { riseMs: number; setMs: number }>();
  for (let index = 0; index < sunrise.length; index++) {
    const riseMs = Date.parse(sunrise[index]);
    const setMs = Date.parse(sunset[index]);
    if (!Number.isFinite(riseMs) || !Number.isFinite(setMs) || setMs <= riseMs) return false;
    const key = dayKey.format(riseMs);
    // Danish sunrise/sunset pairs describe one local calendar day. Without
    // this relation a forged next-day sunset can turn the whole intervening
    // night into `isDay: true` and still agree with the oversized interval.
    if (dayKey.format(setMs) !== key) return false;
    if (intervals.has(key)) return false;
    intervals.set(key, { riseMs, setMs });
  }

  const forecastDays = new Set<string>();
  for (const value of hourly) {
    if (!isRecord(value)) return false;
    const timeMs = timestampMs(value.time);
    if (timeMs === null) return false;
    const key = dayKey.format(timeMs);
    forecastDays.add(key);
    const interval = intervals.get(key);
    if (!interval) return false;
    const expectedIsDay = timeMs >= interval.riseMs && timeMs <= interval.setMs;
    if (value.isDay !== expectedIsDay) return false;
  }

  // Assembly builds the sun schedule before weather rows without nearby
  // marine data are filtered, so valid payloads can carry extra schedule days.
  // Every represented forecast day must be covered; harmless extras stay valid.
  return [...forecastDays].every((key) => intervals.has(key));
}

function hasValidReleaseMetadata(value: unknown, payloadVersion: unknown): boolean {
  if (!isRecord(value)) return false;

  return isSupportedForecastApiSchemaVersion(value.apiSchemaVersion)
    && Number.isInteger(value.modelRevision)
    && (value.modelRevision as number) > 0
    && isNonEmptyString(value.dataGenerationId)
    && Number.isInteger(value.assembledCacheSchema)
    && (value.assembledCacheSchema as number) > 0
    && Number.isInteger(value.marineCacheSchema)
    && (value.marineCacheSchema as number) > 0
    && isSupportedForecastPayloadVersion(value.payloadVersion)
    && value.payloadVersion === payloadVersion;
}

/**
 * Pure trust-boundary check for payloads crossing either fetch or storage.
 * Unknown extra properties are deliberately ignored so additive Worker
 * changes remain deployable independently; every property this client reads
 * is checked before the value is narrowed to WeatherData.
 */
export function isValidForecastPayload(
  value: unknown,
  requestedLocation: ForecastLocation,
  options: ForecastPayloadValidationOptions = {},
): value is WeatherData {
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs as number : Date.now();
  const sourceClockLeadToleranceMs = Number.isFinite(options.sourceClockLeadToleranceMs)
    && (options.sourceClockLeadToleranceMs as number) >= 0
    ? options.sourceClockLeadToleranceMs as number
    : FORECAST_CLOCK_LEAD_TOLERANCE_MS;
  if (!Number.isSafeInteger(requestedLocation.forecastConfigRevision)
    || requestedLocation.forecastConfigRevision < 1) return false;
  if (!isRecord(value)) return false;
  if (!hasValidHourlyRows(value.hourly, nowMs)) return false;
  if (
    !isStrictlyIncreasingTimestampArray(value.sunrise)
    || !isStrictlyIncreasingTimestampArray(value.sunset)
    || value.sunrise.length !== value.sunset.length
  ) return false;
  if (!hasConsistentDaylight(
    value.hourly,
    value.sunrise,
    value.sunset,
    requestedLocation.timezone,
  )) return false;
  if (!hasValidWarnings(value.warnings)) return false;

  const sources = value.sources;
  if (!isRecord(sources)) return false;
  if (value.sunrise.length === 0) return false;
  if (!isSupportedForecastPayloadVersion(sources.payloadVersion)) return false;
  if (!hasValidReleaseMetadata(sources.release, sources.payloadVersion)) return false;
  if (!isNonEmptyString(sources.weather) || !isNonEmptyString(sources.waves) || !isNonEmptyString(sources.water)) return false;
  const fetchedAtMs = timestampMs(sources.fetchedAt);
  if (
    fetchedAtMs === null
    || !isPlausibleSourceTimestamp(fetchedAtMs, nowMs, sourceClockLeadToleranceMs)
    || !hasValidCacheHealth(
      sources.cacheHealth,
      nowMs,
      fetchedAtMs,
      sourceClockLeadToleranceMs,
    )
  ) return false;

  const coordinate = sources.coordinate;
  if (!isRecord(coordinate)) return false;
  if (!Number.isFinite(coordinate.latitude) || !Number.isFinite(coordinate.longitude)) return false;
  if ((coordinate.latitude as number) < -90 || (coordinate.latitude as number) > 90) return false;
  if ((coordinate.longitude as number) < -180 || (coordinate.longitude as number) > 180) return false;
  if (
    Math.abs((coordinate.latitude as number) - requestedLocation.coordinate.latitude) > LOCATION_COORDINATE_TOLERANCE_DEGREES ||
    Math.abs((coordinate.longitude as number) - requestedLocation.coordinate.longitude) > LOCATION_COORDINATE_TOLERANCE_DEGREES
  ) return false;

  const location = sources.location;
  if (!isRecord(location)) return false;
  if (!isNonEmptyString(location.id) || !isNonEmptyString(location.name) || !isNonEmptyString(location.areaName)) return false;
  if (!Number.isSafeInteger(location.forecastConfigRevision)
    || location.forecastConfigRevision !== requestedLocation.forecastConfigRevision) return false;
  // ID is the routing identity. Names are display copy and may legitimately
  // differ briefly while Pages and the Worker deploy independently. The
  // forecast-config revision is data provenance and must match exactly.
  if (location.id !== requestedLocation.id) return false;

  return true;
}
