import {
  METEOALARM_DENMARK_FEED,
  enrichWarningCoverage,
  parseMeteoalarmFeed,
} from '../src/features/forecast/parseWarnings';
import type { ForecastLocation } from '../src/config/locationTypes';
import type { SeriesPoint, WeatherWarning } from '../src/features/forecast/types';
import { FORECAST_PAYLOAD_VERSION } from '../src/features/forecast/payloadVersion';
import {
  aggregateBlockMarine,
  assembleBlockRow,
  assembleHourlyRow,
  mapMetBlocks,
  mapMetTimeseries,
  mapWaterFeatures,
  mapWaveFeatures,
  nearestPoint,
} from '../src/features/forecast/normalize';
import type { MetForecastResponse } from '../src/features/forecast/normalize';
import { buildSunSchedule } from '../src/features/forecast/sun';
import {
  DKSS_PARAMETERS,
  WAM_PARAMETERS,
  buildDmiInstancesUrl,
  buildDmiUrl as buildSharedDmiUrl,
  buildMetUrl as buildSharedMetUrl,
} from '../src/features/forecast/providerUrls';
import {
  assertBeforeDeadline,
  assertBeforeProviderDeadline,
  awaitWithinDeadline,
  deadlineError,
  delayWithinDeadline,
  executionPolicy,
  fetchWithTimeout,
  rethrowIfDeadlineReached,
} from './execution';
import type { ExecutionPolicy, ExecutionPolicyInput } from './execution';
import type {
  BusyProvider,
  EventMemo,
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
import {
  errorMessage,
  errorStatus,
  errorWithStatus,
  isRecord,
} from './validation';

const DMI_BASE = 'https://opendataapi.dmi.dk/v1/forecastedr';
const MET_BASE = 'https://api.met.no/weatherapi/locationforecast/2.0/complete';
const MET_USER_AGENT = 'FRANK-kayak-forecast/1.0 (https://github.com/Gromykko/FRANK)';
const MET_DEFAULT_TTL_MS = 30 * 60 * 1000;
const MET_RAW_KEY_PREFIX = 'met-raw';
const MET_FALLBACK_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const MARINE_FALLBACK_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const RETRY_BASE_DELAY_MS = 1_500;
const WARNING_EXECUTION_BUDGET_MS = 5_000;

// Public alias retained for cache-key/readability call sites. Browser and
// Worker now import one source of truth, so a partial hand-bump is impossible.
export const PAYLOAD_VERSION = FORECAST_PAYLOAD_VERSION;

// DMI publishes marine runs every six hours. Probing before five hours would
// only spend provider quota; the one-hour margin covers skew/early publication.
export const DMI_PROBE_QUIET_MS = 5 * 60 * 60 * 1000;

function isMetForecastResponse(value: unknown): value is MetForecastResponse {
  if (!isRecord(value)) return false;
  if (value.properties === undefined) return true;
  if (!isRecord(value.properties)) return false;
  const timeseries = value.properties.timeseries;
  return timeseries === undefined
    || (Array.isArray(timeseries) && timeseries.every((entry) => isRecord(entry)));
}

function isMetRawCache(value: unknown): value is MetRawCache {
  return isRecord(value)
    && typeof value.lastModified === 'string'
    && isMetForecastResponse(value.body);
}

function isMarineIngredientEnvelope(value: unknown): value is MarineIngredientEnvelope {
  return isRecord(value)
    && typeof value.schemaVersion === 'number'
    && typeof value.collection === 'string'
    && typeof value.id === 'string'
    && Array.isArray(value.series);
}

function featureCollectionFromJson<TFeature>(value: unknown): { features: TFeature[] } {
  if (!isRecord(value) || !Array.isArray(value.features)) {
    throw new Error('DMI response did not contain a feature collection.');
  }
  // The caller supplies the source-specific normalizer. At this boundary we
  // validate the transport envelope; the normalizer validates/filters fields.
  return { features: value.features as TFeature[] };
}

// Thin wrappers binding the shared builders to this worker's base URLs.
function buildDmiUrl(
  collection: string,
  parameters: string[],
  location: Pick<ForecastLocation, 'coordinate'>,
  instanceId?: string,
): string {
  return buildSharedDmiUrl(DMI_BASE, collection, parameters, location.coordinate, instanceId);
}

function buildInstancesUrl(collection: string): string {
  return buildDmiInstancesUrl(DMI_BASE, collection);
}

function buildMetUrl(location: Pick<ForecastLocation, 'coordinate'>): string {
  return buildSharedMetUrl(MET_BASE, location.coordinate);
}

function retryDelay(attempt: number): number {
  return RETRY_BASE_DELAY_MS * 2 ** attempt + Math.floor(Math.random() * 500);
}

// One structured line per upstream call: which source, how long, what happened.
// Without this, "is DMI slow or is our timeout wrong?" could only be answered by
// hand-timing curl from a laptop — which is how the 22-23s latency above was
// found. Visible in `npm run worker:tail` and Workers Logs.
function logUpstream(source: string, startedAt: number, outcome: string, extra = ''): void {
  const ms = Date.now() - startedAt;
  console.log(`upstream ${source} ${outcome} ${ms}ms${extra ? ' ' + extra : ''}`);
}

async function fetchJsonWithRetries(
  url: string,
  label: string,
  policy: ExecutionPolicy = executionPolicy(),
): Promise<unknown> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < policy.maxAttempts; attempt++) {
    assertBeforeProviderDeadline(policy, `${label} attempt ${attempt + 1}`);
    const startedAt = Date.now();
    try {
      const response = await fetchWithTimeout(url, {
        headers: {
          Accept: 'application/geo+json, application/json',
        },
      }, policy);

      if (response.ok) {
        const json = await response.json();
        logUpstream(label, startedAt, 'ok');
        return json;
      }

      logUpstream(label, startedAt, `http-${response.status}`);
      const providerMessage = (await response.text()).slice(0, 180);
      // Provider response bodies are useful diagnostics, but they are not a
      // stable part of FRANK's public cache-health contract. Keep the detail in
      // owner-only Worker logs and expose only our structured status below.
      if (providerMessage) {
        console.warn({
          event: 'upstream_http_error',
          source: label,
          status: response.status,
          providerMessage,
        });
      }
      lastError = errorWithStatus(`${label} failed with HTTP ${response.status}`, response.status);
      // Any 4xx (incl. 429 "Server is busy") is terminal: retrying with
      // backoff is how a single refresh became an 18-request, 30-second
      // storm, and the 10-minute cron already IS the retry schedule. Use
      // break, not throw - a throw here is caught by this same try/catch
      // and would fall through to the delay-and-retry anyway.
      if (response.status < 500) break;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      // A timeout arrives here as a TimeoutError DOMException, so name it
      // explicitly — "slow upstream" and "upstream refused" need different
      // responses from a human and used to look identical in the logs.
      logUpstream(label, startedAt, lastError.name === 'TimeoutError' ? 'timeout' : 'error',
        String(lastError.message ?? '').slice(0, 120));
    }

    if (attempt < policy.maxAttempts - 1) {
      await delayWithinDeadline(retryDelay(attempt), policy, `${label} retry`);
    }
  }

  throw lastError ?? new Error(`${label} failed`);
}

function parseDmiInstanceMs(id: unknown): number {
  if (typeof id !== 'string') return Number.NaN;
  const compact = id.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (compact) {
    return new Date(`${compact[1]}T${compact[2]}:${compact[3]}:${compact[4]}Z`).getTime();
  }
  return new Date(id).getTime();
}

// A retained marine ingredient may bridge one missed six-hour publication, but
// not an open-ended outage. At exactly two cycles (12h) it is still allowed;
// anything older, future-dated, missing, or unparseable cannot be used to build
// and freshly timestamp another forecast.
export function isMarineRunWithinFallbackAge(
  instance: MarineRunRef | null | undefined,
  nowMs = Date.now(),
): boolean {
  const runMs = parseDmiInstanceMs(instance?.id);
  if (!Number.isFinite(runMs)) return false;
  const ageMs = nowMs - runMs;
  return ageMs >= 0 && ageMs <= MARINE_FALLBACK_MAX_AGE_MS;
}

export function marineInstancesWithinFallbackAge(
  instances: Partial<MarineInstances> | null | undefined,
  nowMs = Date.now(),
): boolean {
  return isMarineRunWithinFallbackAge(instances?.water, nowMs)
    && isMarineRunWithinFallbackAge(instances?.waves, nowMs);
}

function assertMarineRunWithinFallbackAge(
  instance: MarineRunRef | null | undefined,
  label = instance?.collection ?? 'marine',
): void {
  if (!isMarineRunWithinFallbackAge(instance)) {
    throw new Error(`DMI ${label} run is older than the 12-hour marine safety limit.`);
  }
}

// Age of the OLDER of the two marine runs we hold (so if one source lags, we
// still probe). Infinity if either run id is missing/unparseable - an
// incomplete marine set must always trigger a probe.
export function marineRunAgeMs(
  marineInstances: {
    water?: MarineRunRef;
    waves?: MarineRunRef;
  } | null | undefined,
  now = Date.now(),
): number {
  const water = parseDmiInstanceMs(marineInstances?.water?.id);
  const waves = parseDmiInstanceMs(marineInstances?.waves?.id);
  if (!Number.isFinite(water) || !Number.isFinite(waves)) return Infinity;
  return now - Math.min(water, waves);
}

function latestInstanceFromResponse(data: unknown): Pick<MarineInstance, 'id'> | undefined {
  const instances = isRecord(data) && Array.isArray(data.instances) ? data.instances : [];
  let best: Pick<MarineInstance, 'id'> | undefined;
  let bestMs = -Infinity;

  for (const instance of instances) {
    const id = isRecord(instance) ? instance.id : undefined;
    const timeMs = parseDmiInstanceMs(id);
    if (typeof id === 'string' && Number.isFinite(timeMs) && timeMs > bestMs) {
      best = { id };
      bestMs = timeMs;
    }
  }

  return best;
}

// Which model run is newest is a property of DMI, not of a fjord, and every
// location currently configured probes the identical two collection lists. So a
// cron tick that loops 4 locations asked DMI the same two questions 8 times,
// ~2.1s of the tick, against the one provider that actively rate-limits us.
//
// A scheduled event supplies one event-local memo, making its four locations
// self-consistent without retaining request-scoped I/O promises in module
// globals. Separate HTTP/scheduled events can never inherit one another's
// promise, deadline, or failure.

export function fetchLatestInstanceForCollections(
  collections: string[],
  policyInput?: ExecutionPolicyInput,
  eventMemo?: EventMemo,
): Promise<MarineInstance> {
  const policy = executionPolicy(policyInput);
  assertBeforeDeadline(policy, `DMI ${collections.join(',')} instance probe`);
  const key = `instance-probe:${collections.join(',')}`;
  const memo = eventMemo?.get(key);
  if (memo) return memo as Promise<MarineInstance>;

  // The PROMISE is cached, not its result. Caching the result only would have
  // deduplicated nothing here: water and waves are probed with Promise.allSettled
  // and the locations are looped, so four callers can all miss the cache before
  // the first response lands, and all four would still hit DMI. Sharing the
  // in-flight promise is what actually collapses them into one request.
  //
  // A rejection is cached on the same terms, deliberately: a 429 means "stop
  // asking", and re-probing once per location is exactly the hammering that
  // earned it. The first caller always awaits, so the stored rejection is never
  // an unhandled one.
  const promise = probeLatestInstanceForCollections(collections, policy);
  eventMemo?.set(key, promise);
  return promise;
}

async function probeLatestInstanceForCollections(
  collections: string[],
  policy: ExecutionPolicy,
): Promise<MarineInstance> {
  let lastError: Error | undefined;

  for (const collection of collections) {
    assertBeforeProviderDeadline(policy, `DMI ${collection} collection fallback`);
    try {
      const data = await fetchJsonWithRetries(buildInstancesUrl(collection), `DMI ${collection} instances`, policy);
      const latest = latestInstanceFromResponse(data);
      if (latest) {
        return {
          collection,
          id: latest.id,
        };
      }
      lastError = new Error(`DMI ${collection} returned no usable instances`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      // Collection fallbacks are for a missing collection (404) or a usable
      // response with no instances. Timeouts/5xx are host failures: asking the
      // same host under another collection name only spends the cleanup budget
      // and used to drive the event all the way to its hard deadline.
      if (errorStatus(lastError) !== 404) throw lastError;
    }
  }

  throw lastError ?? new Error(`No DMI instances found for ${collections.join(', ')}`);
}

export async function fetchLatestMarineInstances(
  location: ForecastLocation,
  policy: ExecutionPolicy,
  eventMemo?: EventMemo,
): Promise<MarineInstances> {
  assertBeforeDeadline(policy, `marine instance probes for ${location.id}`);
  const results = await Promise.allSettled([
    fetchLatestInstanceForCollections(location.dmiCollections.water, policy, eventMemo),
    fetchLatestInstanceForCollections(location.dmiCollections.waves, policy, eventMemo),
  ]);
  assertBeforeDeadline(policy, `marine instance probe results for ${location.id}`);

  const water = results[0].status === 'fulfilled' ? results[0].value : undefined;
  const waves = results[1].status === 'fulfilled' ? results[1].value : undefined;

  if (!water || !waves) {
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => errorMessage(result.reason));
    throw new Error(`Failed to fetch DMI marine instances: ${errors.join(', ')}`);
  }

  return { water, waves };
}

export function marineInstancesEqual(
  left: Partial<MarineInstances> | null | undefined,
  right: Partial<MarineInstances> | null | undefined,
): boolean {
  return Boolean(
    left &&
      right &&
      left.water?.collection === right.water?.collection &&
      left.water?.id === right.water?.id &&
      left.waves?.collection === right.waves?.collection &&
      left.waves?.id === right.waves?.id
  );
}

async function fetchDmiGeoJson<TFeature>(
  collection: string,
  parameters: string[],
  location: Pick<ForecastLocation, 'coordinate'>,
  instanceId: string,
  policy: ExecutionPolicy,
): Promise<{ features: TFeature[] }> {
  const json = await fetchJsonWithRetries(
    buildDmiUrl(collection, parameters, location, instanceId),
    `DMI ${collection}`,
    policy
  );
  return featureCollectionFromJson<TFeature>(json);
}

function mapMetPayload(
  data: MetForecastResponse,
  lastModified: string | null | undefined,
  expiresMs: number,
): Omit<MetResult, 'fallback' | 'degraded' | 'busy'> {
  return {
    weatherSeries: mapMetTimeseries(data),
    blocks: mapMetBlocks(data),
    // Honour MET's own Expires header; fall back to a short TTL if absent.
    weatherExpires: Number.isFinite(expiresMs)
      ? new Date(expiresMs).toISOString()
      : new Date(Date.now() + MET_DEFAULT_TTL_MS).toISOString(),
    weatherLastModified: lastModified ?? undefined,
  };
}

async function fetchMetWeather(
  env: Env,
  location: ForecastLocation,
  policy: ExecutionPolicy,
): Promise<MetResult> {
  assertBeforeDeadline(policy, `MET cache read for ${location.id}`);
  const rawKey = `${MET_RAW_KEY_PREFIX}:${location.id}`;
  let stored: MetRawCache | null = null;
  try {
    const retained = await awaitWithinDeadline(
      () => env.FRANK_FORECAST_CACHE.get(rawKey, 'json'),
      policy,
      `MET retained cache read for ${location.id}`,
    );
    stored = isMetRawCache(retained) ? retained : null;
  } catch (error) {
    rethrowIfDeadlineReached(error, policy, `MET retained cache read recovery for ${location.id}`);
    stored = null;
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': MET_USER_AGENT,
  };
  // MET TOS: repeat requests must carry If-Modified-Since with exactly the
  // Last-Modified value previously received.
  if (stored?.lastModified && stored?.body) {
    headers['If-Modified-Since'] = stored.lastModified;
  }

  try {
    const metStartedAt = Date.now();
    const response = await fetchWithTimeout(buildMetUrl(location), { headers }, policy);
    logUpstream(`met:${location.id}`, metStartedAt, response.status === 304 ? 'not-modified' : `http-${response.status}`);

    if (response.status === 304 && stored?.body) {
      // Unchanged on MET's side: reuse the stored body. A 304 can still extend
      // the validity window through its own Expires header.
      const expiresHeader = response.headers.get('Expires');
      const expiresMs = expiresHeader ? Date.parse(expiresHeader) : Number.NaN;
      return { ...mapMetPayload(stored.body, stored.lastModified, expiresMs), fallback: false };
    }

    if (!response.ok) {
      const providerMessage = (await response.text()).slice(0, 180);
      console.warn({
        event: 'upstream_http_error',
        source: `met:${location.id}`,
        status: response.status,
        ...(providerMessage ? { providerMessage } : {}),
      });
      throw errorWithStatus(`MET Norway weather failed with HTTP ${response.status}`, response.status);
    }

    const data: unknown = await response.json();
    if (!isMetForecastResponse(data)) {
      throw new Error('MET Norway weather returned an invalid payload.');
    }
    const lastModified = response.headers.get('Last-Modified');
    const expiresHeader = response.headers.get('Expires');
    const expiresMs = expiresHeader ? Date.parse(expiresHeader) : Number.NaN;

    if (lastModified) {
      try {
        await awaitWithinDeadline(
          () => env.FRANK_FORECAST_CACHE.put(rawKey, JSON.stringify({ lastModified, body: data })),
          policy,
          `MET retained cache write for ${location.id}`,
        );
      } catch (error) {
        rethrowIfDeadlineReached(error, policy, `MET retained cache write recovery for ${location.id}`);
        // Storing the conditional-request state is best-effort.
      }
    }

    return { ...mapMetPayload(data, lastModified, expiresMs), fallback: false };
  } catch (error) {
    rethrowIfDeadlineReached(error, policy, `MET fallback for ${location.id}`);
    // MET unreachable but we hold its last response: build with that rather
    // than freezing the whole payload. The NaN expires maps to a short TTL,
    // so the next check retries MET soon.
    // ...but only while that response is still plausibly a forecast. Unbounded,
    // a multi-day MET outage (a 403 on the UA, an IP block, a long downtime)
    // shipped two-day-old wind and gusts as a complete, current-looking payload
    // — the marine half kept refreshing, so nothing on screen looked wrong.
    // Past the bound, let the error through so the build fails properly and the
    // client's own "stale / couldn't refresh" path takes over.
    //
    // 6 h matches CACHE_REFRESH_WARNING_AGE_MS on the client, so the moment we
    // stop serving a held body is the moment its banner would have fired. It
    // must stay well above MET's ~30-min publish cadence, or an ordinary single
    // failed fetch would start rejecting a body that is genuinely current.
    const storedBodyAgeMs = Date.now() - Date.parse(stored?.lastModified ?? '');
    if (stored?.body
      && Number.isFinite(storedBodyAgeMs)
      && storedBodyAgeMs >= 0
      && storedBodyAgeMs < MET_FALLBACK_MAX_AGE_MS) {
      // MET always returns data when reachable, so a MET fallback is always a
      // real transport failure - degraded, not merely "not published yet".
      return {
        ...mapMetPayload(stored.body, stored.lastModified, Number.NaN),
        fallback: true,
        degraded: true,
        busy: isBusyError(errorMessage(error)),
      };
    }
    throw error;
  }
}

// Last-good marine series per source, so one provider's brownout can't
// freeze the other's fresh data ("split retention, single serving": each
// ingredient falls back independently, the served payload stays one
// combined object where every hour has both weather and marine data).
// This cache contains NORMALIZED series, not raw provider responses. Its schema
// therefore changes whenever forecast normalization changes. Keeping the
// payload version in both the key and envelope prevents an old normalized run
// from being reused and then stamped as a new-version assembled forecast.
const MARINE_INGREDIENT_KEY_PREFIX = `frank-marine-ingredient:v${PAYLOAD_VERSION}`;

export async function fetchMarineSeriesWithFallback<TFeature>(
  env: Env,
  location: Pick<ForecastLocation, 'id' | 'areaName' | 'coordinate'>,
  kind: MarineKind,
  instance: MarineInstance,
  parameters: string[],
  mapFeatures: (features: TFeature[]) => SeriesPoint[],
  seedSeries?: SeriesPoint[],
  seedInstance?: MarineInstance,
  policyInput?: ExecutionPolicyInput,
): Promise<MarineSeriesResult> {
  const policy = executionPolicy(policyInput);
  assertBeforeDeadline(policy, `${kind} marine cache read for ${location.id}`);
  assertMarineRunWithinFallbackAge(instance, instance?.collection ?? kind);
  const key = `${MARINE_INGREDIENT_KEY_PREFIX}:${kind}:${location.id}`;

  let stored: MarineIngredientEnvelope | null = null;
  try {
    const retained = await awaitWithinDeadline(
      () => env.FRANK_FORECAST_CACHE.get(key, 'json'),
      policy,
      `${kind} retained cache read for ${location.id}`,
    );
    stored = isMarineIngredientEnvelope(retained) ? retained : null;
  } catch (error) {
    rethrowIfDeadlineReached(error, policy, `${kind} retained cache read recovery for ${location.id}`);
    stored = null;
  }

  // Same run we already hold data for: reuse it, no network call. DMI runs
  // change only every ~6h, so an hourly weather rebuild must not re-pull
  // identical marine data (measured: gaps between runs are exactly 6.00h).
  const currentStored = stored?.schemaVersion === PAYLOAD_VERSION
    && Array.isArray(stored.series) && stored.series.length > 0
    && isMarineRunWithinFallbackAge(stored)
    ? stored
    : null;

  if (currentStored
    && currentStored.collection === instance.collection
    && currentStored.id === instance.id) {
    return { series: currentStored.series, instance, fallback: false };
  }

  // Fall back to the run we already hold (retained ingredient, else the seed
  // from the cached payload). `extra` distinguishes WHY we fell back.
  const fallbackToHeld = (
    extra: Pick<MarineSeriesResult, 'degraded' | 'busy' | 'notReady'>,
  ): MarineSeriesResult | null => {
    // Re-evaluate against the current clock. A request can begin exactly at
    // the 12h boundary and cross it while waiting for the provider; a decision
    // made before that wait must not authorize a newly-stamped old fallback.
    if (currentStored && isMarineRunWithinFallbackAge(currentStored)) {
      return {
        series: currentStored.series,
        instance: { collection: currentStored.collection, id: currentStored.id },
        fallback: true,
        ...extra,
      };
    }
    if (Array.isArray(seedSeries) && seedSeries.length > 0
      && isMarineRunWithinFallbackAge(seedInstance)) {
      // `seedInstance`, NOT `instance`: the seed came from the cached payload,
      // i.e. the PREVIOUS run. Reporting the run we just failed to fetch wrote
      // a false provenance into cacheHealth.marineInstances, and both
      // marineInstancesEqual (which then thinks the cache is current) and
      // marineRunAgeMs (which then suppresses the catalog probe for 5h) read
      // it back as fact. Fall back to `instance` only if we have nothing.
      return { series: seedSeries, instance: seedInstance ?? instance, fallback: true, ...extra };
    }
    return null;
  };

  let data: { features: TFeature[] };
  try {
    data = await fetchDmiGeoJson(instance.collection, parameters, location, instance.id, policy);
  } catch (error) {
    rethrowIfDeadlineReached(error, policy, `${kind} retained fallback for ${location.id}`);
    // Transport error (429/5xx/network): we genuinely could not refresh this
    // source. Show the held run and flag it degraded (amber).
    const held = fallbackToHeld({ degraded: true, busy: isBusyError(errorMessage(error)) });
    if (held) return held;
    throw error;
  }

  // The provider wait may itself cross the retention boundary. Even a 200
  // response must not turn a now-over-age model run into a fresh payload.
  assertMarineRunWithinFallbackAge(instance, instance.collection);

  const series = mapFeatures(data.features);
  if (series.length > 0) {
    try {
      await awaitWithinDeadline(
        () => env.FRANK_FORECAST_CACHE.put(key, JSON.stringify({
          schemaVersion: PAYLOAD_VERSION,
          collection: instance.collection,
          id: instance.id,
          series,
        })),
        policy,
        `${kind} retained cache write for ${location.id}`,
      );
    } catch (error) {
      rethrowIfDeadlineReached(error, policy, `${kind} retained cache write recovery for ${location.id}`);
      // Retention is best-effort.
    }
    return { series, instance, fallback: false };
  }

  // 200 but no data for this instance: the run is listed in the catalog but
  // not published yet. The run we already hold is still the latest AVAILABLE
  // data, so this is NOT degradation - fall back silently and stay green.
  const held = fallbackToHeld({ notReady: true });
  if (held) return held;
  throw new Error(`DMI ${instance.collection} returned no ${kind} forecast points for ${location.areaName}.`);
}

// Reconstruct per-source marine series from a cached payload's hourly rows
// (block rows are aggregates, so only true hourly rows are usable).
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
    // Which model runs these seeds actually came from, so a seed fallback can
    // report its real provenance instead of the run it failed to fetch.
    instances: cached?.sources?.cacheHealth?.marineInstances,
  };
}

// Official DMI warnings for the location's region, via the MeteoAlarm Denmark
// feed. One country-wide fetch (edge-cached 5 min) serves every location. Never
// throws into the build - warnings are advisory and must not block a forecast.
// On a feed failure it carries forward the last build's still-unexpired
// warnings (last-good retention, like the marine sources) so a brief feed
// hiccup during a rebuild can't blank an active warning; a reachable feed that
// simply has no warnings correctly returns [] and lets expired ones clear.
function advisoryWarningPolicy(parentPolicy: ExecutionPolicy): ExecutionPolicy {
  const providerDeadlineAt = parentPolicy.deadlineAt - parentPolicy.completionReserveMs;
  const budgetMs = Math.max(0, Math.min(
    WARNING_EXECUTION_BUDGET_MS,
    providerDeadlineAt - Date.now(),
  ));
  return executionPolicy({
    deadlineAt: Date.now() + budgetMs,
    hardDeadlineAt: parentPolicy.hardDeadlineAt ?? parentPolicy.deadlineAt,
    fetchTimeoutMs: Math.min(parentPolicy.fetchTimeoutMs, WARNING_EXECUTION_BUDGET_MS),
    maxAttempts: 1,
  });
}

async function fetchWarnings(
  location: ForecastLocation,
  seedWarnings: WeatherWarning[] | undefined,
  policy: ExecutionPolicy,
  now = Date.now(),
): Promise<WeatherWarning[]> {
  if (!location.emmaId) return [];
  try {
    assertBeforeDeadline(policy, `warning feed for ${location.id}`);
    const response = await fetchWithTimeout(METEOALARM_DENMARK_FEED, {
      headers: { Accept: '*/*' },
      cf: { cacheTtl: 300, cacheEverything: true },
    }, policy);
    if (!response.ok) throw new Error(`MeteoAlarm feed failed: ${response.status}`);
    const warnings = parseMeteoalarmFeed(await response.text(), location.emmaId);
    // Kommune-coverage soft filter (public CAP detail per warning): may only
    // QUIET a warning that demonstrably excludes this town — fail-open, so
    // any detail failure leaves the warning region-level and fully shown.
    return await enrichWarningCoverage(warnings, location.kommuneAliases, async (url) => {
      const detail = await fetchWithTimeout(url, {
        headers: { Accept: '*/*' },
        cf: { cacheTtl: 300, cacheEverything: true },
      }, policy);
      if (!detail.ok) throw new Error(`CAP detail failed: ${detail.status}`);
      return detail.text();
    });
  } catch {
    // The warning policy has a deliberately short child deadline. Reaching it
    // is an advisory-feed failure, not the parent event's hard deadline: carry
    // forward still-active warnings while the required forecast finishes. Only
    // the parent's true wall clock may prevent this tiny recovery step.
    if ((policy.hardDeadlineAt ?? policy.deadlineAt) - Date.now() <= 0) {
      throw deadlineError(`warning fallback for ${location.id}`);
    }
    return (seedWarnings ?? []).filter((w) => Number.isFinite(Date.parse(w?.expires)) && Date.parse(w.expires) > now);
  }
}

export async function buildForecastCache(
  env: Env,
  location: ForecastLocation,
  marineInstances: MarineInstances,
  marineSeeds: MarineSeeds | null,
  warningSeed: WeatherWarning[] | undefined,
  policy: ExecutionPolicy,
): Promise<ForecastBuildResult> {
  assertBeforeDeadline(policy, `forecast build for ${location.id}`);
  const seedInstances = marineSeeds?.instances;
  const warningPolicy = advisoryWarningPolicy(policy);
  const results = await Promise.allSettled([
    fetchMetWeather(env, location, policy),
    fetchMarineSeriesWithFallback(env, location, 'water', marineInstances.water, DKSS_PARAMETERS, mapWaterFeatures, marineSeeds?.water, seedInstances?.water, policy),
    fetchMarineSeriesWithFallback(env, location, 'waves', marineInstances.waves, WAM_PARAMETERS, mapWaveFeatures, marineSeeds?.waves, seedInstances?.waves, policy),
    fetchWarnings(location, warningSeed, warningPolicy),
  ]);
  assertBeforeDeadline(policy, `forecast assembly for ${location.id}`);

  // Only weather + both marine sources are required to build; the warnings leg
  // (last) is advisory - a down feed yields an empty stripe, never a failure.
  const [metResult, waterResult, waveResult, warningResult] = results;
  if (metResult.status === 'rejected'
    || waterResult.status === 'rejected'
    || waveResult.status === 'rejected') {
    const errors = [metResult, waterResult, waveResult]
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => errorMessage(result.reason));
    throw new Error(`Failed to build forecast: ${errors.join(', ')}`);
  }

  const met = metResult.value;
  const water = waterResult.value;
  const wave = waveResult.value;
  const warnings = warningResult.status === 'fulfilled' ? warningResult.value : [];

  // Marine may have completed before a slower MET/warning leg. Recheck at the
  // exact assembly boundary so the final fetchedAt can never outlive the 12h
  // provenance policy merely because another Promise kept the build waiting.
  assertMarineRunWithinFallbackAge(water.instance, water.instance?.collection ?? 'water');
  assertMarineRunWithinFallbackAge(wave.instance, wave.instance?.collection ?? 'waves');

  const weatherSeries = met.weatherSeries;
  const waterSeries = water.series;
  const waveSeries = wave.series;
  // Which model runs the payload is really built from (a fallback ingredient
  // keeps its own older run id), and which sources are riding on last-good
  // data because their provider was unavailable.
  const effectiveInstances = { water: water.instance, waves: wave.instance };
  // Only a fallback caused by a real error is "degraded" (amber). A fallback
  // because a newly-listed run isn't published yet is NOT degradation - the
  // held run is still the latest available, so it stays green.
  const degradedSources = [
    ...(met.fallback && met.degraded ? ['weather'] : []),
    ...(water.fallback && water.degraded ? ['water'] : []),
    ...(wave.fallback && wave.degraded ? ['waves'] : []),
  ];
  // Whether the degradation is because a provider was busy (429) vs some
  // other error - lets the client say "... · service busy".
  const degradedBusy = [met, water, wave].some((s) => s.fallback && s.degraded && s.busy);

  if (weatherSeries.length === 0) {
    throw new Error(`MET Norway returned no weather forecast points for ${location.areaName}.`);
  }

  // Longer-range blocks continue the matrix past MET's hourly range using
  // next_6_hours, with DMI marine aggregated per block. Stop where marine ends.
  const hourlyEndMs = weatherSeries[weatherSeries.length - 1].timeMs;
  const blockData = [];
  for (const block of met.blocks) {
    if (block.timeMs <= hourlyEndMs) continue;
    const marine = aggregateBlockMarine(waveSeries, waterSeries, block.timeMs, block.timeMs + block.spanHours * 3_600_000);
    if (!marine) break;
    blockData.push({ block, marine });
  }

  // MET has no sunrise/sunset or is_day, so day/night is derived
  // astronomically from the coordinate over every hour and block we keep.
  const allTimes = [...weatherSeries.map((w) => w.time), ...blockData.map((b) => b.block.time)];
  const sun = buildSunSchedule(allTimes, location);

  // One continuous forecast: keep every weather hour for which we also have
  // marine data, then append the longer-range blocks.
  const hourly = weatherSeries
    .map((weather) => {
      const water = nearestPoint(waterSeries, weather.timeMs);
      const wave = nearestPoint(waveSeries, weather.timeMs);
      if (!water || !wave) return null;
      return assembleHourlyRow(weather, water, wave, sun.isDayByTime.get(weather.time) ?? true);
    })
    .filter((row): row is NonNullable<typeof row> => row !== null)
    .concat(blockData.map(({ block, marine }) => assembleBlockRow(block, marine, sun.isDayByTime.get(block.time) ?? true)));

  if (hourly.length === 0) {
    throw new Error(`No overlapping weather + marine hours for ${location.areaName}.`);
  }

  return {
    degradedSources,
    degradedBusy,
    marineInstances: effectiveInstances,
    forecast: {
      hourly,
      sunrise: sun.sunrise,
      sunset: sun.sunset,
      warnings,
      sources: {
        payloadVersion: PAYLOAD_VERSION,
        weather: 'MET Norway Locationforecast',
        waves: `DMI ${effectiveInstances.waves.collection}`,
        water: `DMI ${effectiveInstances.water.collection}`,
        coordinate: {
          latitude: location.coordinate.latitude,
          longitude: location.coordinate.longitude,
        },
        location: {
          id: location.id,
          name: location.name,
          areaName: location.areaName,
        },
        fetchedAt: new Date().toISOString(),
      },
    },
    weatherExpires: met.weatherExpires,
    weatherLastModified: met.weatherLastModified,
  };
}

// A "busy" upstream (429/rate-limited) is a "try later", distinct from a real
// error - the UI words it calmly and the retry logic treats it as terminal.
export function isBusyError(message: unknown): boolean {
  return /\b429\b|too many requests|server is busy|rate.?limit/i.test(String(message ?? ''));
}

// Classify a build failure so the client can word it calmly: whether the
// provider is merely busy vs a real error, and which provider it was.
export function classifyBuildFailure(message: unknown): {
  busy: boolean;
  busyProvider: BusyProvider;
} {
  const text = String(message ?? '');
  const busy = isBusyError(text);
  const hasWeather = /\bMET\b|locationforecast/i.test(text);
  const hasMarine = /\bDMI\b|dkss|wam/i.test(text);
  const busyProvider = hasWeather && hasMarine ? 'services'
    : hasMarine ? 'marine'
    : hasWeather ? 'weather'
    : 'services';
  return { busy, busyProvider };
}

// A failed marine run-catalog probe means we could not verify that the held
// water/wave run is still the newest one. The values remain usable, but they are
// now explicitly last-good ingredients and must not render as a green, fully
// checked forecast.
export function degradedSourcesAfterProbe(
  degradedSources: string[] = [],
  marineProbeFailed = false,
): string[] {
  return [...new Set([
    ...degradedSources,
    ...(marineProbeFailed ? ['water', 'waves'] : []),
  ])];
}
