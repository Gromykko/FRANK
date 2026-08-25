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
  LEGACY_FORECAST_PAYLOAD_VERSION,
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
  // DMI's usual complete-model delays are DKSS +3h20, wam_nsb +2h45,
  // and wam_dw +3h00:
  // https://www.dmi.dk/friedata/dokumentation/data/forecast-data-availability
  // Recent STAC properties.created observations showed DKSS becoming available
  // later than its published figure, while wam_nsb straddled its figure. The
  // measured gates below use +3h35 and +2h50; unmeasured wam_dw stays at its
  // published +3h00. The separate 10-minute cushion remains unchanged. DMI also
  // identifies properties.created as the factual availability clock; observing
  // it directly is intentionally left for a separate change.
  dmiDkssCompleteDelayMs: (3 * 60 + 35) * 60 * 1000,
  dmiWamNsbCompleteDelayMs: (2 * 60 + 50) * 60 * 1000,
  dmiOtherWamCompleteDelayMs: 3 * 60 * 60 * 1000,
  dmiPublicationCushionMs: 10 * 60 * 1000,
  dmiDueProbeBackoffMs: 20 * 60 * 1000,
  // A failed contact is evidence about the call, not about DMI's schedule, so
  // it must not arm the publication backoff. One rotation is the natural
  // cadence; repeated identical failures are kept out of KV by
  // shouldPersistFailureState.
  dmiFailedProbeRetryMs: 4 * 60 * 1000,
});

export const FORECAST_PROVIDER_PARAMETERS = Object.freeze({
  water: DKSS_PARAMETERS,
  waves: WAM_PARAMETERS,
});

export const PAYLOAD_VERSION = LEGACY_FORECAST_PAYLOAD_VERSION;

export interface MarineProbeDecision {
  shouldProbe: boolean;
  nextProbeAtMs: number;
  reason: 'invalid' | 'expired' | 'publication-window' | 'retry-backoff' | 'due';
}

interface BuildSourceResults {
  met: MetResult;
  water: MarineSeriesResult;
  wave: MarineSeriesResult;
  warnings: WeatherWarning[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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

export function isMarineIngredientEnvelope(
  value: unknown,
  location: Pick<ForecastLocation, 'id' | 'forecastConfigRevision'>,
): value is MarineIngredientEnvelope {
  return isRecord(value)
    && typeof value.schemaVersion === 'number'
    && value.locationId === location.id
    && value.forecastConfigRevision === location.forecastConfigRevision
    && typeof value.collection === 'string'
    && typeof value.id === 'string'
    && Array.isArray(value.series);
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
  instanceId?: string,
): string {
  return buildDmiUrl(
    FORECAST_SOURCE_POLICY.dmiBaseUrl,
    collection,
    parameters,
    location.coordinate,
    instanceId,
  );
}

export function dmiInstancesUrl(collection: string): string {
  return buildDmiInstancesUrl(FORECAST_SOURCE_POLICY.dmiBaseUrl, collection);
}

export function metForecastUrl(location: Pick<ForecastLocation, 'coordinate'>): string {
  return buildMetUrl(FORECAST_SOURCE_POLICY.metBaseUrl, location.coordinate);
}

export function parseDmiInstanceMs(id: unknown): number {
  if (typeof id !== 'string') return Number.NaN;
  const compact = id.match(/^(\d{4})-?(\d{2})-?(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (compact) {
    return new Date(`${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:${compact[6]}Z`).getTime();
  }
  return new Date(id).getTime();
}

export function isMarineRunWithinFallbackAge(
  instance: MarineRunRef | null | undefined,
  nowMs = Date.now(),
): boolean {
  const runMs = parseDmiInstanceMs(instance?.id);
  if (!Number.isFinite(runMs)) return false;
  const ageMs = nowMs - runMs;
  return ageMs >= 0 && ageMs <= FORECAST_SOURCE_POLICY.marineFallbackMaxAgeMs;
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
  const runMs = parseDmiInstanceMs(instance?.id);
  if (!Number.isFinite(runMs)) return 'invalid';
  const ageMs = nowMs - runMs;
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

export function marineSourcesDueForProbe(
  marineInstances: Partial<MarineInstances> | null | undefined,
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
    return nowMs >= runMs
      + FORECAST_SOURCE_POLICY.dmiRunCycleMs
      + completeDelayMs
      + FORECAST_SOURCE_POLICY.dmiPublicationCushionMs;
  });
}

export function degradedMarineSourcesAfterProbe(
  marineInstances: Partial<MarineInstances> | null | undefined,
  marineProbeFailed: boolean,
  substituted: readonly MarineKind[] = [],
  nowMs = Date.now(),
): MarineKind[] {
  const unavailable = new Set<MarineKind>(
    marineProbeFailed ? ['water', 'waves'] : substituted,
  );
  // A combined probe may ask both catalogues because ONE source is due. A
  // failed carry-over for the other source is not degradation while that
  // source remains inside its own collection's publication schedule.
  return marineSourcesDueForProbe(marineInstances, nowMs)
    .filter((kind) => unavailable.has(kind));
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
  const waterDelayMs = dmiCompleteDelayMs(marineInstances?.water?.collection);
  const wavesDelayMs = dmiCompleteDelayMs(marineInstances?.waves?.collection);

  if (![waterRunMs, wavesRunMs, waterDelayMs, wavesDelayMs].every(Number.isFinite)
    || waterRunMs > nowMs
    || wavesRunMs > nowMs) {
    return { shouldProbe: true, nextProbeAtMs: nowMs, reason: 'invalid' };
  }

  if (nowMs - waterRunMs > FORECAST_SOURCE_POLICY.marineFallbackMaxAgeMs
    || nowMs - wavesRunMs > FORECAST_SOURCE_POLICY.marineFallbackMaxAgeMs) {
    return { shouldProbe: true, nextProbeAtMs: nowMs, reason: 'expired' };
  }

  let expectedAtMs: number;
  if (waterRunMs === wavesRunMs) {
    expectedAtMs = waterRunMs
      + FORECAST_SOURCE_POLICY.dmiRunCycleMs
      + Math.max(waterDelayMs, wavesDelayMs)
      + FORECAST_SOURCE_POLICY.dmiPublicationCushionMs;
  } else if (waterRunMs < wavesRunMs) {
    expectedAtMs = waterRunMs
      + FORECAST_SOURCE_POLICY.dmiRunCycleMs
      + waterDelayMs
      + FORECAST_SOURCE_POLICY.dmiPublicationCushionMs;
  } else {
    expectedAtMs = wavesRunMs
      + FORECAST_SOURCE_POLICY.dmiRunCycleMs
      + wavesDelayMs
      + FORECAST_SOURCE_POLICY.dmiPublicationCushionMs;
  }

  if (nowMs < expectedAtMs) {
    return { shouldProbe: false, nextProbeAtMs: expectedAtMs, reason: 'publication-window' };
  }

  const lastAttemptMs = Date.parse(lastAttemptAt ?? '');
  if (Number.isFinite(lastAttemptMs)
    && lastAttemptMs >= expectedAtMs
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
): Pick<MarineInstance, 'id'> | undefined {
  if (!isRecord(data) || !Array.isArray(data.instances)) {
    throw new Error('DMI instance response did not contain an instances array.');
  }
  if (data.instances.length === 0) return undefined;
  let best: Pick<MarineInstance, 'id'> | undefined;
  let bestMs = -Infinity;
  for (const instance of data.instances) {
    const id = isRecord(instance) ? instance.id : undefined;
    const timeMs = parseDmiInstanceMs(id);
    if (typeof id === 'string' && Number.isFinite(timeMs) && timeMs > bestMs) {
      best = { id };
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
    // every selected tick see stale weather, rebuild, and write: 360 writes per
    // city/day, 1,440 across four cities, against a 1,000/day allowance from a
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
    ? stored
    : null;
}

export function heldMarineFallback(
  currentStored: MarineIngredientEnvelope | null,
  seedSeries: SeriesPoint[] | undefined,
  seedInstance: MarineInstance | undefined,
  requestedInstance: MarineInstance,
  extra: Pick<MarineSeriesResult, 'providerContacted' | 'degraded' | 'busy' | 'notReady'>,
  nowMs = Date.now(),
): MarineSeriesResult | null {
  if (currentStored && isMarineRunWithinFallbackAge(currentStored, nowMs)) {
    return {
      series: currentStored.series,
      instance: { collection: currentStored.collection, id: currentStored.id },
      fallback: true,
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
      seedFallback: true,
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
  };
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
  // A failed refresh CALL is not the same thing as stale DATA. When a 429 sends
  // us back to the run we already hold, and that run is still the newest one its
  // own publication schedule says exists, nothing was lost: the retained
  // ingredient is byte-identical to what the call would have returned. Reporting
  // it as "from an earlier update" told every user their water level was old for
  // the length of a DMI busy spell, while the figures on screen were exactly
  // right - and did it only for water, because waves needed no request at all.
  //
  // A seed fallback stays degraded whatever the schedule says: that series is
  // rebuilt from the cached payload's hourly rows and really has lost its tail.
  // Weather has no run cycle of its own, so its rule is untouched.
  const marineBehind = new Set(marineSourcesDueForProbe(effectiveInstances, nowMs));
  const marineDegraded = (
    source: MarineSeriesResult,
    kind: MarineKind,
  ): boolean => Boolean(
    source.fallback
    && source.degraded
    && (source.seedFallback || marineBehind.has(kind)),
  );
  const weatherDegraded = Boolean(met.fallback && met.degraded);
  const waterDegraded = marineDegraded(water, 'water');
  const wavesDegraded = marineDegraded(wave, 'waves');

  const degradedSources = [
    ...(weatherDegraded ? ['weather'] : []),
    ...(waterDegraded ? ['water'] : []),
    ...(wavesDegraded ? ['waves'] : []),
  ];
  // Busy is a statement about the same fallback, so it travels with it. Leaving
  // providerBusy set while degradedSources is empty would restore the banner
  // this removes, by a different route.
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
