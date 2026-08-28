import type { ForecastLocation } from '../src/config/locationTypes';
import {
  aggregateBlockMarine,
  assembleBlockRow,
  assembleHourlyRow,
  mapMetBlocks,
  mapMetTimeseries,
  nearestPoint,
} from '../src/features/forecast/normalize';
import type { MetForecastResponse } from '../src/features/forecast/normalize';
import {
  DKSS_PARAMETERS,
  WAM_PARAMETERS,
  buildDmiInstancesUrl,
  buildDmiUrl,
  buildMetUrl,
} from '../src/features/forecast/providerUrls';
import {
  CURRENT_RELEASE,
  FORECAST_PAYLOAD_VERSION,
  MARINE_INGREDIENT_CACHE_SCHEMA_VERSION,
} from '../src/features/forecast/releaseContract';
import { buildSunSchedule } from '../src/features/forecast/sun';
import {
  FORECAST_SERVER_CLOCK_LEAD_TOLERANCE_MS,
  isPlausibleSourceTimestamp,
} from '../src/features/forecast/temporalPolicy';
import type { SeriesPoint, WeatherWarning } from '../src/features/forecast/types';
import type {
  BusyProvider,
  ForecastBuildResult,
  MarineGridCoordinate,
  MarineGridExpectedByCollection,
  MarineGridProvenance,
  MarineGridProvenanceByKind,
  MarineIngredientEnvelope,
  MarineInstance,
  MarineInstances,
  MarineKind,
  MarineRunRef,
  MarineSeedPayload,
  MarineSeeds,
  MarineSeriesResult,
  MetRawCache,
  MetResult,
} from './domain';

// This module is the generation-owned semantic boundary. It deliberately has
// no network, KV, clock scheduling, retry, or route orchestration. Every value,
// source-selection, normalization, provenance, and fallback decision that can
// change prepared forecast bytes is made here or in one of its fingerprinted
// imports. Operational resilience code calls these decisions but cannot define
// a second, unversioned policy beside them.
export const FORECAST_SOURCE_POLICY = Object.freeze({
  dmiBaseUrl: 'https://opendataapi.dmi.dk/v1/forecastedr',
  metBaseUrl: 'https://api.met.no/weatherapi/locationforecast/2.0/complete',
  metUserAgent: 'FRANK-kayak-forecast/1.0 (https://github.com/Gromykko/FRANK)',
  metDefaultTtlMs: 30 * 60 * 1000,
  // Ceiling on a trusted Expires. Comfortably inside the 3-hour data-age alarm,
  // so a header that would otherwise freeze the weather still forces a refresh
  // before /health would have to report the freeze.
  metMaxTtlMs: 90 * 60 * 1000,
  metFallbackMaxAgeMs: 6 * 60 * 60 * 1000,
  marineFallbackMaxAgeMs: 12 * 60 * 60 * 1000,
  dmiRunCycleMs: 6 * 60 * 60 * 1000,
  // DMI's published complete-model delays: DKSS +3h20, wam_nsb +2h45,
  // wam_dw +3h00.
  // https://www.dmi.dk/friedata/dokumentation/data/forecast-data-availability
  //
  // These were previously padded to +3h35 and +2h50 with a further 10-minute
  // cushion, because ONE probe was all a cycle got: miss it and the next look
  // was twenty minutes away, so the gate had to be placed late enough to
  // succeed first time. That padding cost real freshness. Direct observation on
  // 2026-08-25 timed wam_nsb publishing at +2h39 to +2h44 - inside its
  // published figure - while our gate did not open until +3h00.
  //
  // Arriving early is now free, so the gate sits on the published figure with
  // no cushion and a miss simply comes back next rotation. Guessing the exact
  // publication minute stops mattering, which is the honest answer to a
  // provider whose timing genuinely varies. DMI identifies properties.created
  // as the factual availability clock; reading it directly would remove the
  // guess entirely and is still left for a separate change.
  dmiDkssCompleteDelayMs: (3 * 60 + 20) * 60 * 1000,
  dmiWamNsbCompleteDelayMs: (2 * 60 + 45) * 60 * 1000,
  dmiOtherWamCompleteDelayMs: 3 * 60 * 60 * 1000,
  // DMI documents DKSS as a five-day hourly forecast and WAM as a 5.5-day
  // hourly forecast. Pinned EDR requests use these independent contracts, not
  // the catalogue interval that grows while a run is being published.
  // https://www.dmi.dk/friedata/dokumentation/data/forecast-data-storm-surge-model-dkss
  // https://www.dmi.dk/friedata/dokumentation/data/forecast-data-wave-model-wam
  dmiDkssForecastHorizonHours: 120,
  dmiWamForecastHorizonHours: 132,
  // A LEAD, not a cushion - the sign is the point. The old 10-minute cushion
  // pushed the gate later so one probe would likely land after publication;
  // this pulls it earlier so we are already waiting when the run appears.
  // wam_nsb was observed complete at +2h39, ahead of its own published +2h45,
  // so arriving exactly on the published figure is arriving late. Being a few
  // minutes early also puts the first look in before the wave of schedulers
  // that fire on the round figure.
  dmiPublicationLeadMs: 10 * 60 * 1000,
  // One rotation, matching dmiFailedProbeRetryMs. With the gate on the
  // published figure a fruitless check means "not published yet", not "DMI is
  // late", so the twenty-minute wait that assumed the latter would now cost up
  // to twenty minutes of staleness on every cycle.
  dmiDueProbeBackoffMs: 5 * 60 * 1000,
  // A failed contact is evidence about the call, not about DMI's schedule, so
  // it must not arm the publication backoff. One rotation is the natural
  // cadence; repeated identical failures are kept out of KV by
  // shouldPersistFailureState.
  dmiFailedProbeRetryMs: 5 * 60 * 1000,
  // DMI calls its completion times "usual" rather than an SLA and explicitly
  // says the network load changes them. Across the 32 collection-runs measured
  // on 2026-08-23..25, the worst terminal STAC item arrived about 18 minutes
  // after the published time. One hour is deliberately anchored to the
  // collection's expected completion time, never to first discovery or a
  // failed retry, so repeated failures cannot slide the window forward. During
  // it, a previous independently complete same-collection run remains honest
  // across ordinary transient provider failures; contract, provenance, code,
  // and storage failures stay visible immediately. After it, an unavailable
  // candidate is disclosed as degradation.
  // https://www.dmi.dk/friedata/dokumentation/data/forecast-data-availability
  dmiPublicationGraceMs: 60 * 60 * 1000,
});

export const FORECAST_PROVIDER_PARAMETERS = Object.freeze({
  water: DKSS_PARAMETERS,
  waves: WAM_PARAMETERS,
});

export const PAYLOAD_VERSION = FORECAST_PAYLOAD_VERSION;

export interface MarineProbeDecision {
  shouldProbe: boolean;
  nextProbeAtMs: number;
  reason: 'invalid' | 'expired' | 'publication-window' | 'retry-backoff' | 'due';
}

export interface MarineRunContract {
  kind: MarineKind;
  collection: string;
  runStartMs: number;
  expectedEndMs: number;
  horizonHours: number;
  expectedPointCount: number;
}

export interface MarineCoverageAssessment extends MarineRunContract {
  status: 'complete' | 'partial' | 'invalid';
  sourceFeatureCount: number;
  seriesPointCount: number;
  seriesStartMs: number | null;
  seriesEndMs: number | null;
  missingPointCount: number;
  extraPointCount: number;
  duplicatePointCount: number;
  gridMismatchCount: number;
  timestampMismatchCount: number;
  invalidRequiredValueCount: number;
}

const SUPPORTED_DKSS_COLLECTIONS: ReadonlySet<string> = new Set([
  'dkss_idw',
  'dkss_nsbs',
]);
const SUPPORTED_WAM_COLLECTIONS: ReadonlySet<string> = new Set([
  'wam_nsb',
  'wam_dw',
]);

interface BuildSourceResults {
  met: MetResult;
  water: MarineSeriesResult;
  wave: MarineSeriesResult;
  warnings: WeatherWarning[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const MARINE_GRID_COORDINATE_TOLERANCE_DEGREES = 1e-6;

function marineGridCoordinateFromUnknown(value: unknown): MarineGridCoordinate | null {
  if (!isRecord(value)
    || typeof value.latitude !== 'number'
    || !Number.isFinite(value.latitude)
    || value.latitude < -90
    || value.latitude > 90
    || typeof value.longitude !== 'number'
    || !Number.isFinite(value.longitude)
    || value.longitude < -180
    || value.longitude > 180) return null;
  return { latitude: value.latitude, longitude: value.longitude };
}

function marineGridExpectedByCollectionFromUnknown(
  value: unknown,
): MarineGridExpectedByCollection | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  // A location currently has at most two collections per marine kind. Keep a
  // little room for future fallbacks, but do not let optional diagnostics turn
  // an otherwise valid KV record into an unbounded object-processing path.
  if (entries.length > 8) return undefined;
  const expectedByCollection = Object.create(null) as MarineGridExpectedByCollection;
  for (const [collection, candidate] of entries) {
    if (collection.trim().length === 0 || collection.length > 100) continue;
    const coordinate = marineGridCoordinateFromUnknown(candidate);
    if (coordinate) expectedByCollection[collection] = coordinate;
  }
  return Object.keys(expectedByCollection).length > 0
    ? expectedByCollection
    : undefined;
}

export function marineGridCoordinatesMatch(
  left: MarineGridCoordinate,
  right: MarineGridCoordinate,
): boolean {
  return Math.abs(left.latitude - right.latitude) <= MARINE_GRID_COORDINATE_TOLERANCE_DEGREES
    && Math.abs(left.longitude - right.longitude) <= MARINE_GRID_COORDINATE_TOLERANCE_DEGREES;
}

export function marineGridDistanceMeters(
  left: MarineGridCoordinate,
  right: MarineGridCoordinate,
): number {
  const radians = (degrees: number): number => degrees * Math.PI / 180;
  const latitudeDelta = radians(right.latitude - left.latitude);
  const longitudeDelta = radians(right.longitude - left.longitude);
  const leftLatitude = radians(left.latitude);
  const rightLatitude = radians(right.latitude);
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(leftLatitude) * Math.cos(rightLatitude)
      * Math.sin(longitudeDelta / 2) ** 2;
  return Math.round(6_371_000 * 2 * Math.atan2(
    Math.sqrt(haversine),
    Math.sqrt(Math.max(0, 1 - haversine)),
  ));
}

// Grid provenance is diagnostic metadata, not a forecast-validity condition.
// Parse it independently so a malformed optional field is ignored without
// discarding otherwise complete marine data or crashing the operator page.
export function marineGridProvenanceFromUnknown(
  value: unknown,
  expectedCollection?: string,
  expectedRequested?: MarineGridCoordinate,
): MarineGridProvenance | undefined {
  if (!isRecord(value)
    || typeof value.collection !== 'string'
    || value.collection.trim().length === 0
    || (expectedCollection !== undefined && value.collection !== expectedCollection)) {
    return undefined;
  }
  const requested = marineGridCoordinateFromUnknown(value.requested);
  const returned = marineGridCoordinateFromUnknown(value.returned);
  const expected = marineGridCoordinateFromUnknown(value.expected);
  if (!requested || !returned || !expected
    || (expectedRequested !== undefined
      && !marineGridCoordinatesMatch(requested, expectedRequested))) {
    return undefined;
  }
  return {
    collection: value.collection,
    requested,
    returned,
    expected,
    // Recompute both derived facts rather than trusting diagnostic KV fields
    // that could disagree after a partial write or manual mutation.
    distanceMeters: marineGridDistanceMeters(requested, returned),
    changed: !marineGridCoordinatesMatch(expected, returned),
  };
}

export function marineGridProvenanceByKindFromUnknown(
  value: unknown,
  location: Pick<ForecastLocation, 'coordinate'>,
  instances: Partial<MarineInstances> | null | undefined,
): MarineGridProvenanceByKind | undefined {
  if (!isRecord(value)) return undefined;
  const water = instances?.water
    ? marineGridProvenanceFromUnknown(
        value.water,
        instances.water.collection,
        location.coordinate,
      )
    : undefined;
  const waves = instances?.waves
    ? marineGridProvenanceFromUnknown(
        value.waves,
        instances.waves.collection,
        location.coordinate,
      )
    : undefined;
  return water || waves
    ? {
        ...(water ? { water } : {}),
        ...(waves ? { waves } : {}),
      }
    : undefined;
}

export function isMetForecastResponse(value: unknown): value is MetForecastResponse {
  if (!isRecord(value) || !isRecord(value.properties)) return false;
  const timeseries = value.properties.timeseries;
  return Array.isArray(timeseries) && timeseries.every((entry) => isRecord(entry));
}

export function isMetRawCache(
  value: unknown,
  location: Pick<ForecastLocation, 'id' | 'forecastConfigRevision'>,
  nowMs = Date.now(),
): value is MetRawCache {
  return isRecord(value)
    && value.locationId === location.id
    && value.forecastConfigRevision === location.forecastConfigRevision
    && typeof value.lastModified === 'string'
    // This stamp is copied verbatim into If-Modified-Since. A year-3000 KV
    // poison could otherwise elicit perpetual 304s and prevent a real MET body
    // from replacing it. Cloudflare's clock is authoritative, with only a
    // small distributed-system allowance.
    && isPlausibleSourceTimestamp(
      Date.parse(value.lastModified),
      nowMs,
      FORECAST_SERVER_CLOCK_LEAD_TOLERANCE_MS,
    )
    && isMetForecastResponse(value.body);
}

export function marineIngredientEnvelopeFromUnknown(
  value: unknown,
  location: Pick<ForecastLocation, 'id' | 'forecastConfigRevision' | 'coordinate'>,
): MarineIngredientEnvelope | null {
  if (!(isRecord(value)
    && typeof value.schemaVersion === 'number'
    && value.locationId === location.id
    && value.forecastConfigRevision === location.forecastConfigRevision
    && typeof value.collection === 'string'
    && typeof value.id === 'string'
    && (value.marineKind === 'water' || value.marineKind === 'waves')
    && typeof value.expectedStartMs === 'number'
    && Number.isFinite(value.expectedStartMs)
    && typeof value.expectedEndMs === 'number'
    && Number.isFinite(value.expectedEndMs)
    && typeof value.seriesEndMs === 'number'
    && Number.isFinite(value.seriesEndMs)
    && Array.isArray(value.series)
    && value.series.every((point) => typeof point === 'object' && point !== null))) {
    return null;
  }
  const parsedGrid = marineGridProvenanceFromUnknown(
    value.grid,
    value.collection,
    location.coordinate,
  );
  const parsedExpectedByCollection = marineGridExpectedByCollectionFromUnknown(
    value.gridExpectedByCollection,
  );
  const gridExpected = parsedExpectedByCollection?.[value.collection]
    ?? parsedGrid?.expected;
  const grid = parsedGrid && gridExpected
    ? {
        ...parsedGrid,
        expected: gridExpected,
        changed: !marineGridCoordinatesMatch(gridExpected, parsedGrid.returned),
      }
    : parsedGrid;
  const gridExpectedByCollection = {
    ...(parsedExpectedByCollection ?? {}),
    ...(grid ? { [grid.collection]: grid.expected } : {}),
  };
  return {
    schemaVersion: value.schemaVersion,
    locationId: value.locationId,
    forecastConfigRevision: value.forecastConfigRevision,
    collection: value.collection,
    id: value.id,
    marineKind: value.marineKind,
    expectedStartMs: value.expectedStartMs,
    expectedEndMs: value.expectedEndMs,
    seriesEndMs: value.seriesEndMs,
    series: value.series as SeriesPoint[],
    ...(grid ? { grid } : {}),
    ...(Object.keys(gridExpectedByCollection).length > 0
      ? { gridExpectedByCollection }
      : {}),
  };
}

export function featureCollectionFromJson<TFeature>(
  value: unknown,
): { features: TFeature[] } {
  if (!isRecord(value) || !Array.isArray(value.features)) {
    throw new Error('DMI response did not contain a feature collection.');
  }
  return { features: value.features as TFeature[] };
}

export function dmiForecastUrl(
  collection: string,
  parameters: string[],
  location: Pick<ForecastLocation, 'coordinate'>,
  instanceId: string,
): string {
  const contract = marineRunContract(collection, instanceId);
  if (contract === null) {
    throw new Error(`DMI ${collection} run id cannot define an exact forecast interval.`);
  }
  const dateRange = `${new Date(contract.runStartMs).toISOString()}/${new Date(contract.expectedEndMs).toISOString()}`;
  return buildDmiUrl(
    FORECAST_SOURCE_POLICY.dmiBaseUrl,
    collection,
    parameters,
    location.coordinate,
    instanceId,
    dateRange,
  );
}

export function dmiInstancesUrl(collection: string): string {
  return buildDmiInstancesUrl(FORECAST_SOURCE_POLICY.dmiBaseUrl, collection);
}

export function metForecastUrl(location: Pick<ForecastLocation, 'coordinate'>): string {
  return buildMetUrl(FORECAST_SOURCE_POLICY.metBaseUrl, location.coordinate);
}

function utcTimestampFromParts(parts: readonly (string | undefined)[]): number {
  const [year, month, day, hour, minute, second, fraction = ''] = parts;
  const components = [year, month, day, hour, minute, second].map(Number);
  if (components.some((component) => !Number.isInteger(component))) return Number.NaN;
  const [yearNumber, monthNumber, dayNumber, hourNumber, minuteNumber, secondNumber] = components;
  const millisecondNumber = fraction.length > 0
    ? Number(fraction.padEnd(3, '0'))
    : 0;
  if (!Number.isInteger(millisecondNumber)) return Number.NaN;

  const date = new Date(0);
  date.setUTCFullYear(yearNumber, monthNumber - 1, dayNumber);
  date.setUTCHours(hourNumber, minuteNumber, secondNumber, millisecondNumber);
  const timestampMs = date.getTime();
  return Number.isFinite(timestampMs)
    && date.getUTCFullYear() === yearNumber
    && date.getUTCMonth() === monthNumber - 1
    && date.getUTCDate() === dayNumber
    && date.getUTCHours() === hourNumber
    && date.getUTCMinutes() === minuteNumber
    && date.getUTCSeconds() === secondNumber
    && date.getUTCMilliseconds() === millisecondNumber
    ? timestampMs
    : Number.NaN;
}

export function parseDmiInstanceMs(id: unknown): number {
  if (typeof id !== 'string') return Number.NaN;
  const compact = id.match(/^(\d{4})-?(\d{2})-?(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (compact) return utcTimestampFromParts(compact.slice(1));

  const iso = id.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/);
  return iso ? utcTimestampFromParts(iso.slice(1)) : Number.NaN;
}

export function marineRunContract(
  collection: unknown,
  id: unknown,
): MarineRunContract | null {
  if (typeof collection !== 'string') return null;
  const normalized = collection.toLowerCase();
  const kind: MarineKind | null = SUPPORTED_DKSS_COLLECTIONS.has(normalized)
    ? 'water'
    : SUPPORTED_WAM_COLLECTIONS.has(normalized)
      ? 'waves'
      : null;
  if (kind === null) return null;

  const runStartMs = parseDmiInstanceMs(id);
  if (!Number.isFinite(runStartMs)) return null;
  const run = new Date(runStartMs);
  if (run.getUTCMinutes() !== 0
    || run.getUTCSeconds() !== 0
    || run.getUTCMilliseconds() !== 0
    || ![0, 6, 12, 18].includes(run.getUTCHours())) {
    return null;
  }

  const horizonHours = kind === 'water'
    ? FORECAST_SOURCE_POLICY.dmiDkssForecastHorizonHours
    : FORECAST_SOURCE_POLICY.dmiWamForecastHorizonHours;
  return {
    kind,
    collection,
    runStartMs,
    expectedEndMs: runStartMs + horizonHours * 60 * 60 * 1000,
    horizonHours,
    // EDR datetime ranges are inclusive at both ends, so a +120h DKSS run has
    // 121 points and a +132h WAM run has 133.
    expectedPointCount: horizonHours + 1,
  };
}

function seriesPointRecord(value: unknown): Partial<SeriesPoint> | null {
  return typeof value === 'object' && value !== null
    ? value as Partial<SeriesPoint>
    : null;
}

function hasRequiredMarineReadings(
  kind: MarineKind,
  point: Partial<SeriesPoint> | null,
): boolean {
  if (point === null) return false;
  return kind === 'water'
    ? Number.isFinite(point.tideLevel) && Number.isFinite(point.tempWater)
    : Number.isFinite(point.waveHeight);
}

export function assessMarineRunCoverage(
  kind: MarineKind,
  instance: Pick<MarineInstance, 'collection' | 'id'>,
  series: readonly unknown[],
  sourceFeatureCount = series.length,
): MarineCoverageAssessment | null {
  const contract = marineRunContract(instance.collection, instance.id);
  if (!contract || contract.kind !== kind) return null;

  const seen = new Map<number, number>();
  const expectedTimes = new Set<number>(
    Array.from(
      { length: contract.expectedPointCount },
      (_, index) => contract.runStartMs + index * 60 * 60 * 1000,
    ),
  );
  let gridMismatchCount = 0;
  let timestampMismatchCount = 0;
  let invalidRequiredValueCount = 0;
  let extraPointCount = 0;
  for (let index = 0; index < series.length; index += 1) {
    const point = seriesPointRecord(series[index]);
    const parsedTimeMs = parseDmiInstanceMs(point?.time);
    const timeMs = point?.timeMs;
    if (!Number.isFinite(parsedTimeMs)
      || !Number.isFinite(timeMs)
      || parsedTimeMs !== timeMs) {
      timestampMismatchCount += 1;
    }
    if (typeof timeMs === 'number' && Number.isFinite(timeMs)) {
      seen.set(timeMs, (seen.get(timeMs) ?? 0) + 1);
    }
    const expectedTimeMs = contract.runStartMs + index * 60 * 60 * 1000;
    if (typeof timeMs === 'number'
      && Number.isFinite(timeMs)
      && !expectedTimes.has(timeMs)) {
      extraPointCount += 1;
    }
    if (index >= contract.expectedPointCount || timeMs !== expectedTimeMs) {
      gridMismatchCount += 1;
    }
    if (index < contract.expectedPointCount && !hasRequiredMarineReadings(kind, point)) {
      invalidRequiredValueCount += 1;
    }
  }

  const duplicatePointCount = [...seen.values()]
    .reduce((count, occurrences) => count + Math.max(0, occurrences - 1), 0);
  const missingPointCount = [...expectedTimes]
    .reduce((count, expectedTimeMs) => count + (seen.has(expectedTimeMs) ? 0 : 1), 0);
  const firstPoint = seriesPointRecord(series[0]);
  const firstTimeMs = firstPoint?.timeMs;
  const seriesStartMs = typeof firstTimeMs === 'number' && Number.isFinite(firstTimeMs)
    ? firstTimeMs
    : null;
  const lastPoint = seriesPointRecord(series[series.length - 1]);
  const lastTimeMs = lastPoint?.timeMs;
  const seriesEndMs = typeof lastTimeMs === 'number' && Number.isFinite(lastTimeMs)
    ? lastTimeMs
    : null;
  const featureCountMismatch = !Number.isInteger(sourceFeatureCount)
    || sourceFeatureCount < 0
    || sourceFeatureCount !== series.length;
  const invalid = featureCountMismatch
    || timestampMismatchCount > 0
    || gridMismatchCount > 0
    || duplicatePointCount > 0
    || extraPointCount > 0
    || invalidRequiredValueCount > 0;
  return {
    ...contract,
    status: invalid
      ? 'invalid'
      : series.length === contract.expectedPointCount
        ? 'complete'
        : 'partial',
    sourceFeatureCount,
    seriesPointCount: series.length,
    seriesStartMs,
    seriesEndMs,
    missingPointCount,
    extraPointCount,
    duplicatePointCount,
    gridMismatchCount,
    timestampMismatchCount,
    invalidRequiredValueCount,
  };
}

export function isMarineRunWithinFallbackAge(
  instance: MarineRunRef | null | undefined,
  nowMs = Date.now(),
): boolean {
  return marineFallbackRejection(instance, nowMs) === null;
}

export function marineInstancesWithinFallbackAge(
  instances: Partial<MarineInstances> | null | undefined,
  nowMs = Date.now(),
): boolean {
  return isMarineRunWithinFallbackAge(instances?.water, nowMs)
    && isMarineRunWithinFallbackAge(instances?.waves, nowMs);
}

export function marineFallbackRejection(
  instance: MarineRunRef | null | undefined,
  nowMs = Date.now(),
): 'invalid' | 'future' | 'expired' | null {
  const contract = marineRunContract(instance?.collection, instance?.id);
  if (!contract) return 'invalid';
  const ageMs = nowMs - contract.runStartMs;
  if (ageMs < 0) return 'future';
  return ageMs > FORECAST_SOURCE_POLICY.marineFallbackMaxAgeMs ? 'expired' : null;
}

function dmiCompleteDelayMs(collection: unknown): number {
  if (typeof collection !== 'string') return Number.NaN;
  const normalized = collection.toLowerCase();
  if (normalized.startsWith('dkss_')) return FORECAST_SOURCE_POLICY.dmiDkssCompleteDelayMs;
  if (normalized === 'wam_nsb') return FORECAST_SOURCE_POLICY.dmiWamNsbCompleteDelayMs;
  if (normalized.startsWith('wam_')) return FORECAST_SOURCE_POLICY.dmiOtherWamCompleteDelayMs;
  return Number.NaN;
}

// When a NEWER run than the one held should already have been published, for
// this instance's own collection. Exported so the status page can say how far
// behind a source is using the same arithmetic the refresh path decides with -
// two copies of this formula would eventually disagree about what "late" means.
// NaN when the instance cannot be dated or its collection is unknown; callers
// treat that as due, because an undatable run is not evidence of freshness.
export function marineRunDueAtMs(
  instance: MarineRunRef | null | undefined,
): number {
  const contract = marineRunContract(instance?.collection, instance?.id);
  const completeDelayMs = dmiCompleteDelayMs(instance?.collection);
  if (!contract || !Number.isFinite(completeDelayMs)) return Number.NaN;
  return contract.runStartMs
    + FORECAST_SOURCE_POLICY.dmiRunCycleMs
    + completeDelayMs
    - FORECAST_SOURCE_POLICY.dmiPublicationLeadMs;
}

// User-visible freshness is deliberately later than the probe gate. DMI says
// the completion figures are usual times and publishes one step at a time, so
// a retained complete run is not called degraded until the next run has passed
// its own documented completion time plus the bounded publication grace.
export function marineRunDegradedAtMs(
  instance: MarineRunRef | null | undefined,
): number {
  const contract = marineRunContract(instance?.collection, instance?.id);
  const completeDelayMs = dmiCompleteDelayMs(instance?.collection);
  if (!contract || !Number.isFinite(completeDelayMs)) return Number.NaN;
  return contract.runStartMs
    + FORECAST_SOURCE_POLICY.dmiRunCycleMs
    + completeDelayMs
    + FORECAST_SOURCE_POLICY.dmiPublicationGraceMs;
}

export function marineCandidateGraceEndsAtMs(
  instance: MarineRunRef | null | undefined,
): number {
  const contract = marineRunContract(instance?.collection, instance?.id);
  const completeDelayMs = dmiCompleteDelayMs(instance?.collection);
  if (!contract || !Number.isFinite(completeDelayMs)) return Number.NaN;
  return contract.runStartMs + completeDelayMs + FORECAST_SOURCE_POLICY.dmiPublicationGraceMs;
}

export function marineCandidateIsWithinPublicationGrace(
  instance: MarineRunRef | null | undefined,
  nowMs = Date.now(),
): boolean {
  const graceEndsAtMs = marineCandidateGraceEndsAtMs(instance);
  return Number.isFinite(graceEndsAtMs) && nowMs < graceEndsAtMs;
}

export function marineSourcesDueForProbe(
  marineInstances: {
    water?: MarineRunRef;
    waves?: MarineRunRef;
  } | null | undefined,
  nowMs = Date.now(),
): MarineKind[] {
  const kinds: readonly MarineKind[] = ['water', 'waves'];
  return kinds.filter((kind) => {
    const instance = marineInstances?.[kind];
    const runMs = parseDmiInstanceMs(instance?.id);
    const completeDelayMs = dmiCompleteDelayMs(instance?.collection);
    if (!Number.isFinite(runMs)
      || !Number.isFinite(completeDelayMs)
      || runMs > nowMs
      || nowMs - runMs > FORECAST_SOURCE_POLICY.marineFallbackMaxAgeMs) {
      return true;
    }
    return nowMs >= marineRunDueAtMs(instance);
  });
}

export function marineSourcesOverdueForRefresh(
  marineInstances: {
    water?: MarineRunRef;
    waves?: MarineRunRef;
  } | null | undefined,
  nowMs = Date.now(),
): MarineKind[] {
  const kinds: readonly MarineKind[] = ['water', 'waves'];
  return kinds.filter((kind) => {
    const instance = marineInstances?.[kind];
    const runMs = parseDmiInstanceMs(instance?.id);
    const degradedAtMs = marineRunDegradedAtMs(instance);
    if (!Number.isFinite(runMs)
      || !Number.isFinite(degradedAtMs)
      || runMs > nowMs
      || nowMs - runMs > FORECAST_SOURCE_POLICY.marineFallbackMaxAgeMs) {
      return true;
    }
    return nowMs >= degradedAtMs;
  });
}

export function marineSourcesMissingExpectedAdvance(
  previous: Partial<MarineInstances> | null | undefined,
  observed: Partial<MarineInstances> | null | undefined,
  nowMs = Date.now(),
): MarineKind[] {
  const overdue = new Set(marineSourcesOverdueForRefresh(previous, nowMs));
  const observedOverdue = new Set(marineSourcesOverdueForRefresh(observed, nowMs));
  const kinds: readonly MarineKind[] = ['water', 'waves'];
  return kinds.filter((kind) => {
    if (!overdue.has(kind)) return false;
    const previousRunMs = parseDmiInstanceMs(previous?.[kind]?.id);
    const observedRunMs = parseDmiInstanceMs(observed?.[kind]?.id);
    return !Number.isFinite(previousRunMs)
      || !Number.isFinite(observedRunMs)
      || observedRunMs <= previousRunMs
      // Advancing one run is not enough when the returned run is itself past
      // its own publication grace. A badly lagged catalogue must not turn an
      // overdue 00Z city green merely by moving it to an already-overdue 06Z.
      || observedOverdue.has(kind);
  });
}

export function degradedMarineSourcesAfterProbe(
  marineInstances: Partial<MarineInstances> | null | undefined,
  marineProbeFailed: boolean,
  substituted: readonly MarineKind[] = [],
  nowMs = Date.now(),
  marineProbeBusy = false,
  substitutionCauses: Partial<Record<MarineKind, 'not-ready' | 'busy' | 'transient' | 'unavailable'>> = {},
  marineProbeTransient = false,
): MarineKind[] {
  const substitutedSet = new Set(substituted);
  const due = new Set(marineSourcesDueForProbe(marineInstances, nowMs));
  const overdue = new Set(marineSourcesOverdueForRefresh(marineInstances, nowMs));
  // A combined probe may ask both catalogues because ONE source is due. A
  // failed carry-over for the other source is not degradation while that
  // source remains inside its own collection's publication schedule. A
  // typed transient provider failures are also normalised during the bounded
  // grace: a failed call is not evidence that a proven retained run became
  // stale. Unrecognised failures remain immediately visible because they may
  // be contract, code, storage, or provenance faults rather than publication
  // noise.
  const kinds: readonly MarineKind[] = ['water', 'waves'];
  return kinds.filter((kind) => {
    if (marineProbeFailed) {
      return marineProbeBusy || marineProbeTransient
        ? overdue.has(kind)
        : due.has(kind);
    }
    if (!substitutedSet.has(kind)) return false;
    return substitutionCauses[kind] === 'unavailable'
      ? due.has(kind)
      : overdue.has(kind);
  });
}

export function marineProbeDecision(
  marineInstances: {
    water?: MarineRunRef;
    waves?: MarineRunRef;
  } | null | undefined,
  lastAttemptAt?: string,
  nowMs = Date.now(),
  previousMarineFailed = false,
): MarineProbeDecision {
  const waterRunMs = parseDmiInstanceMs(marineInstances?.water?.id);
  const wavesRunMs = parseDmiInstanceMs(marineInstances?.waves?.id);
  const waterDueAtMs = marineRunDueAtMs(marineInstances?.water);
  const wavesDueAtMs = marineRunDueAtMs(marineInstances?.waves);

  if (![waterRunMs, wavesRunMs, waterDueAtMs, wavesDueAtMs].every(Number.isFinite)
    || waterRunMs > nowMs
    || wavesRunMs > nowMs) {
    return { shouldProbe: true, nextProbeAtMs: nowMs, reason: 'invalid' };
  }

  if (nowMs - waterRunMs > FORECAST_SOURCE_POLICY.marineFallbackMaxAgeMs
    || nowMs - wavesRunMs > FORECAST_SOURCE_POLICY.marineFallbackMaxAgeMs) {
    return { shouldProbe: true, nextProbeAtMs: nowMs, reason: 'expired' };
  }

  // DMI publishes water and waves on genuinely different schedules. Open the
  // combined catalogue check when the FIRST source reaches its own gate rather
  // than delaying WAM behind DKSS. Calling the same per-source predicate here
  // also keeps their publication-schedule answer identical; the operational
  // retry backoff below may still defer a source that remains schedule-due.
  const expectedAtMs = Math.min(waterDueAtMs, wavesDueAtMs);
  const dueSources = marineSourcesDueForProbe(marineInstances, nowMs);
  if (dueSources.length === 0) {
    return { shouldProbe: false, nextProbeAtMs: expectedAtMs, reason: 'publication-window' };
  }

  // A check for the earlier source is not evidence that a later sibling was
  // checked before its gate even opened. Anchor backoff to the latest gate
  // among sources due NOW, so the first turn of newly-due DKSS cannot inherit a
  // WAM-only attempt stamp.
  const dueSourceGateAtMs = Math.max(...dueSources.map((kind) =>
    (kind === 'water' ? waterDueAtMs : wavesDueAtMs)));
  const lastAttemptMs = Date.parse(lastAttemptAt ?? '');
  if (Number.isFinite(lastAttemptMs)
    && lastAttemptMs >= dueSourceGateAtMs
    && lastAttemptMs <= nowMs) {
    const backoffMs = previousMarineFailed
      ? FORECAST_SOURCE_POLICY.dmiFailedProbeRetryMs
      : FORECAST_SOURCE_POLICY.dmiDueProbeBackoffMs;
    const retryAtMs = lastAttemptMs + backoffMs;
    if (nowMs < retryAtMs) {
      return { shouldProbe: false, nextProbeAtMs: retryAtMs, reason: 'retry-backoff' };
    }
  }

  return { shouldProbe: true, nextProbeAtMs: expectedAtMs, reason: 'due' };
}

export function latestInstanceFromResponse(
  data: unknown,
  collection: string,
): Pick<MarineInstance, 'id' | 'declaredEndMs'> | undefined {
  if (!isRecord(data) || !Array.isArray(data.instances)) {
    throw new Error('DMI instance response did not contain an instances array.');
  }
  if (data.instances.length === 0) return undefined;
  let best: Pick<MarineInstance, 'id' | 'declaredEndMs'> | undefined;
  let bestMs = -Infinity;
  for (const instance of data.instances) {
    const id = isRecord(instance) ? instance.id : undefined;
    const contract = marineRunContract(collection, id);
    const timeMs = contract?.runStartMs ?? Number.NaN;
    if (typeof id === 'string' && Number.isFinite(timeMs) && timeMs >= bestMs) {
      const extent = isRecord(instance.extent) ? instance.extent : undefined;
      const temporal = extent && isRecord(extent.temporal) ? extent.temporal : undefined;
      const intervals: unknown[] = temporal && Array.isArray(temporal.interval)
        ? temporal.interval
        : [];
      const intervalEnds: number[] = intervals.map((interval: unknown): number =>
        Array.isArray(interval) ? parseDmiInstanceMs(interval[1]) : Number.NaN);
      const declaredEndMs = intervalEnds.length > 0
        && intervalEnds.every((endMs: number) => Number.isFinite(endMs) && endMs >= timeMs)
        ? intervalEnds.reduce(
            (latest: number, endMs: number) => Math.max(latest, endMs),
            timeMs,
          )
        : Number.NaN;
      const bestDeclaredEndMs = best?.declaredEndMs ?? Number.NEGATIVE_INFINITY;
      if (timeMs === bestMs
        && (!Number.isFinite(declaredEndMs)
          || (Number.isFinite(bestDeclaredEndMs) && declaredEndMs <= bestDeclaredEndMs))) {
        continue;
      }
      best = {
        id,
        ...(Number.isFinite(declaredEndMs) && declaredEndMs >= timeMs
          ? { declaredEndMs }
          : {}),
      };
      bestMs = timeMs;
    }
  }
  if (!best) throw new Error('DMI instance response contained no valid instance ids.');
  return best;
}

export function shouldTryNextDmiCollection(status: number | undefined): boolean {
  return status === 404;
}

export function isTransientProviderFailure(input: {
  status?: number;
  errorName?: string;
  networkTypeError?: boolean;
}): boolean {
  if (input.status !== undefined) return input.status === 429 || input.status >= 500;
  if (input.networkTypeError) return true;
  return input.errorName !== undefined
    && ['AbortError', 'NetworkError', 'TimeoutError'].includes(input.errorName);
}

export function marineInstancesEqual(
  left: Partial<MarineInstances> | null | undefined,
  right: Partial<MarineInstances> | null | undefined,
): boolean {
  return Boolean(
    left
      && right
      && left.water?.collection === right.water?.collection
      && left.water?.id === right.water?.id
      && left.waves?.collection === right.waves?.collection
      && left.waves?.id === right.waves?.id
  );
}

export function mapMetPayload(
  data: MetForecastResponse,
  lastModified: string | null | undefined,
  expiresMs: number,
  nowMs = Date.now(),
): Omit<MetResult, 'fallback' | 'degraded' | 'busy'> {
  return {
    weatherSeries: mapMetTimeseries(data),
    blocks: mapMetBlocks(data),
    // An Expires we cannot act on is worse than no Expires. Number.isFinite
    // accepts a timestamp already in the PAST, and one lapsed header then makes
    // every selected tick see stale weather, rebuild, and write: 288 writes per
    // city/day, 1,440 across five cities, against a 1,000/day allowance from a
    // single upstream misconfiguration.
    // Far in the future is the opposite failure - the forecast freezes while
    // still reading as current. MET reissues roughly every half hour, so clamp
    // to a window either side of that and let an unusable header fall back.
    weatherExpires: new Date(
      Number.isFinite(expiresMs)
        ? Math.min(
            Math.max(expiresMs, nowMs + FORECAST_SOURCE_POLICY.metDefaultTtlMs),
            nowMs + FORECAST_SOURCE_POLICY.metMaxTtlMs,
          )
        : nowMs + FORECAST_SOURCE_POLICY.metDefaultTtlMs,
    ).toISOString(),
    weatherLastModified: lastModified ?? undefined,
  };
}

export function canUseMetFallback(
  stored: Pick<MetRawCache, 'lastModified' | 'body'> | null | undefined,
  nowMs = Date.now(),
): stored is Pick<MetRawCache, 'lastModified' | 'body'> {
  const ageMs = nowMs - Date.parse(stored?.lastModified ?? '');
  return Boolean(stored?.body)
    && Number.isFinite(ageMs)
    && ageMs >= 0
    && ageMs < FORECAST_SOURCE_POLICY.metFallbackMaxAgeMs;
}

export function currentMarineIngredient(
  stored: MarineIngredientEnvelope | null | undefined,
  nowMs = Date.now(),
): MarineIngredientEnvelope | null {
  return stored?.schemaVersion === MARINE_INGREDIENT_CACHE_SCHEMA_VERSION
    && Array.isArray(stored.series)
    && stored.series.length > 0
    && isMarineRunWithinFallbackAge(stored, nowMs)
    && marineIngredientHasCompleteCoverage(stored)
    ? stored
    : null;
}

export function marineIngredientHasCompleteCoverage(
  stored: MarineIngredientEnvelope | null | undefined,
): boolean {
  if (!stored) return false;
  const assessment = assessMarineRunCoverage(
    stored.marineKind,
    stored,
    stored.series,
  );
  return assessment?.status === 'complete'
    && stored.expectedStartMs === assessment.runStartMs
    && stored.expectedEndMs === assessment.expectedEndMs
    && stored.seriesEndMs === assessment.seriesEndMs;
}

export function heldMarineFallback(
  currentStored: MarineIngredientEnvelope | null,
  seedSeries: SeriesPoint[] | undefined,
  seedInstance: MarineInstance | undefined,
  requestedInstance: MarineInstance,
  extra: Pick<
    MarineSeriesResult,
    'providerContacted' | 'degraded' | 'busy' | 'notReady' | 'degradationIsImmediate'
  >,
  nowMs = Date.now(),
): MarineSeriesResult | null {
  if (currentStored && isMarineRunWithinFallbackAge(currentStored, nowMs)) {
    return {
      series: currentStored.series,
      instance: {
        collection: currentStored.collection,
        id: currentStored.id,
      },
      fallback: true,
      // Collection identity is not enough by itself. Recompute the independent
      // full-run proof here before claiming the retained bytes are equivalent
      // to the requested model area; callers may pass an arbitrary envelope.
      sameCollectionAsRequested: currentStored.collection === requestedInstance.collection
        && marineIngredientHasCompleteCoverage(currentStored),
      ...extra,
    };
  }
  if (Array.isArray(seedSeries)
    && seedSeries.length > 0
    && isMarineRunWithinFallbackAge(seedInstance, nowMs)) {
    return {
      series: seedSeries,
      instance: seedInstance ?? requestedInstance,
      fallback: true,
      // Never equivalent: deriveMarineSeedsFromPayload keeps only hourly rows.
      ...extra,
    };
  }
  return null;
}

export function deriveMarineSeedsFromPayload(
  cached: MarineSeedPayload | null | undefined,
): MarineSeeds | null {
  const hourly = cached?.hourly;
  if (!Array.isArray(hourly)) return null;
  const rows = hourly.filter((row) => row && !row.blockSpanHours && row.time);
  if (rows.length === 0) return null;
  return {
    water: rows.map((row) => ({
      time: row.time,
      timeMs: Date.parse(row.time),
      tempWater: row.tempWater,
      tideLevel: row.tideLevel,
      currentSpeed: row.currentSpeed,
      currentDirection: row.currentDirection,
    })),
    waves: rows.map((row) => ({
      time: row.time,
      timeMs: Date.parse(row.time),
      waveHeight: row.waveHeight,
      waveDirection: row.waveDirection,
      wavePeriod: row.wavePeriod,
    })),
    instances: cached?.sources?.cacheHealth?.marineInstances,
    marineGrid: cached?.sources?.cacheHealth?.marineGrid,
  };
}

// A rebuild from already-assembled hourly rows has no raw DMI features from
// which to re-derive the effective model cell. Carry the matching diagnostic
// alongside the retained ingredient only; it remains orthogonal to fallback,
// degradation, provider-contact, and forecast assembly decisions.
export function retainMarineGridDiagnostic(
  result: MarineSeriesResult,
  seedGrid: MarineGridProvenance | undefined,
): MarineSeriesResult {
  return !result.grid
    && (result.fallback || !result.providerContacted)
    && seedGrid?.collection === result.instance.collection
    ? { ...result, grid: seedGrid }
    : result;
}

export function retainedActiveWarnings(
  seedWarnings: WeatherWarning[] | undefined,
  nowMs = Date.now(),
): WeatherWarning[] {
  return (seedWarnings ?? []).filter((warning) => {
    const expiresMs = Date.parse(warning?.expires);
    return Number.isFinite(expiresMs) && expiresMs > nowMs;
  });
}

export function assembleForecastFromSources(
  location: ForecastLocation,
  { met, water, wave, warnings }: BuildSourceResults,
  nowMs = Date.now(),
): ForecastBuildResult {
  const weatherSeries = met.weatherSeries;
  const waterSeries = water.series;
  const waveSeries = wave.series;
  const effectiveInstances = { water: water.instance, waves: wave.instance };
  const marineGrid = {
    ...(water.grid ? { water: water.grid } : {}),
    ...(wave.grid ? { waves: wave.grid } : {}),
  };
  // A failed refresh CALL is not the same thing as stale DATA. During the
  // bounded publication grace, an exact complete retained run remains the
  // newest run we can honestly serve while the candidate is incomplete or a
  // call fails with a typed transient provider error. Reporting it as delayed
  // before its own schedule expires would confuse ordinary incremental
  // publication with a stale forecast.
  //
  // The suppression is gated on PROVABLE provenance, not on the absence of a
  // known-bad marker. Anything unable to show it is serving the collection that
  // was asked for stays degraded: a seed rebuild, a sibling-collection envelope,
  // and a stored series without proven full coverage alike. Whether the RUN is old is a separate
  // question, answered just above by its own publication schedule.
  // Weather has no run cycle of its own, so its rule is untouched.
  const marineBehind = new Set(marineSourcesOverdueForRefresh(effectiveInstances, nowMs));
  const marineDegraded = (
    source: MarineSeriesResult,
    kind: MarineKind,
  ): boolean => Boolean(
    source.fallback
    && source.degraded
    && (source.degradationIsImmediate
      || !source.sameCollectionAsRequested
      || marineBehind.has(kind)),
  );
  const weatherDegraded = Boolean(met.fallback && met.degraded);
  const waterDegraded = marineDegraded(water, 'water');
  const wavesDegraded = marineDegraded(wave, 'waves');

  const degradedSources = [
    ...(weatherDegraded ? ['weather'] : []),
    ...(waterDegraded ? ['water'] : []),
    ...(wavesDegraded ? ['waves'] : []),
  ];
  // Busy is an operator diagnosis about the same fallback, so it travels with
  // that fallback. Leaving providerBusy set while degradedSources is empty
  // would claim an outage cause without identifying any affected source.
  const degradedBusy = (weatherDegraded && Boolean(met.busy))
    || (waterDegraded && Boolean(water.busy))
    || (wavesDegraded && Boolean(wave.busy));
  const degradedBusyProviders = new Set<BusyProvider>([
    ...(weatherDegraded && met.busy ? ['weather' as const] : []),
    ...(waterDegraded && water.busy ? ['marine' as const] : []),
    ...(wavesDegraded && wave.busy ? ['marine' as const] : []),
  ]);
  const degradedBusyProvider: BusyProvider | undefined = degradedBusyProviders.size > 1
    ? 'services'
    : degradedBusyProviders.values().next().value;

  const hourlyEndMs = weatherSeries[weatherSeries.length - 1].timeMs;
  const blockData = [];
  for (const block of met.blocks) {
    if (block.timeMs <= hourlyEndMs) continue;
    const marine = aggregateBlockMarine(
      waveSeries,
      waterSeries,
      block.timeMs,
      block.timeMs + block.spanHours * 3_600_000,
    );
    if (!marine) break;
    blockData.push({ block, marine });
  }

  const allTimes = [
    ...weatherSeries.map((weather) => weather.time),
    ...blockData.map(({ block }) => block.time),
  ];
  const sun = buildSunSchedule(allTimes, location);
  const hourly = weatherSeries
    .map((weather) => {
      const waterPoint = nearestPoint(waterSeries, weather.timeMs);
      const wavePoint = nearestPoint(waveSeries, weather.timeMs);
      if (!waterPoint || !wavePoint) return null;
      return assembleHourlyRow(
        weather,
        waterPoint,
        wavePoint,
        sun.isDayByTime.get(weather.time) ?? true,
      );
    })
    .filter((row): row is NonNullable<typeof row> => row !== null)
    .concat(blockData.map(({ block, marine }) => assembleBlockRow(
      block,
      marine,
      sun.isDayByTime.get(block.time) ?? true,
    )));

  if (hourly.length === 0) {
    throw new Error(`No overlapping weather + marine hours for ${location.areaName}.`);
  }

  return {
    degradedSources,
    degradedBusy,
    ...(degradedBusyProvider ? { degradedBusyProvider } : {}),
    providerContacted: !met.fallback || water.providerContacted || wave.providerContacted,
    marineInstances: effectiveInstances,
    ...(Object.keys(marineGrid).length > 0 ? { marineGrid } : {}),
    forecast: {
      hourly,
      sunrise: sun.sunrise,
      sunset: sun.sunset,
      warnings,
      sources: {
        payloadVersion: PAYLOAD_VERSION,
        release: { ...CURRENT_RELEASE },
        weather: 'MET Norway Locationforecast',
        waves: `DMI ${effectiveInstances.waves.collection}`,
        water: `DMI ${effectiveInstances.water.collection}`,
        coordinate: {
          latitude: location.coordinate.latitude,
          longitude: location.coordinate.longitude,
        },
        location: {
          id: location.id,
          forecastConfigRevision: location.forecastConfigRevision,
          name: location.name,
          areaName: location.areaName,
        },
        fetchedAt: new Date(nowMs).toISOString(),
      },
    },
    weatherExpires: met.weatherExpires,
    weatherLastModified: met.weatherLastModified,
  };
}

export function degradedSourcesAfterProbe(
  degradedSources: string[] = [],
  marineProbeFailed = false,
  // Sources already classified as unavailable for their own schedule. The
  // caller filters mere sibling substitutions before they reach this generic
  // merge; a whole-probe failure keeps the legacy both-sources behavior.
  substituted: readonly string[] = [],
): string[] {
  return [...new Set([
    ...degradedSources,
    ...(marineProbeFailed ? ['water', 'waves'] : []),
    ...substituted,
  ])];
}
