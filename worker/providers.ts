import {
  METEOALARM_DENMARK_FEED,
  enrichWarningCoverage,
  parseMeteoalarmFeed,
} from '../src/features/forecast/parseWarnings';
import type { ForecastLocation } from '../src/config/locationTypes';
import type { SeriesPoint, WeatherWarning } from '../src/features/forecast/types';
import {
  MARINE_INGREDIENT_CACHE_SCHEMA_VERSION,
} from '../src/features/forecast/releaseContract';
import {
  mapWaterFeatures,
  mapWaveFeatures,
} from '../src/features/forecast/normalize';
import {
  assertBeforeDeadline,
  assertBeforeProviderDeadline,
  awaitWithinDeadline,
  deadlineError,
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
  MarineSeeds,
  MarineSeriesResult,
  MetRawCache,
  MetResult,
} from './domain';
import {
  FORECAST_PROVIDER_PARAMETERS,
  FORECAST_SOURCE_POLICY,
  PAYLOAD_VERSION,
  assembleForecastFromSources,
  canUseMetFallback,
  currentMarineIngredient,
  degradedSourcesAfterProbe,
  deriveMarineSeedsFromPayload,
  dmiForecastUrl,
  dmiInstancesUrl,
  featureCollectionFromJson,
  heldMarineFallback,
  isMarineIngredientEnvelope,
  isMarineRunWithinFallbackAge,
  isMetForecastResponse,
  isMetRawCache,
  latestInstanceFromResponse,
  mapMetPayload,
  marineFallbackRejection,
  marineInstancesEqual,
  marineInstancesWithinFallbackAge,
  marineProbeDecision,
  metForecastUrl,
  parseDmiInstanceMs,
  retainedActiveWarnings,
  shouldTryNextDmiCollection,
} from './forecastModel';
import {
  errorStatus,
  errorWithStatus,
  isRecord,
} from './validation';
import {
  ProviderUnavailableError,
  isProviderUnavailableError,
  transientProviderError,
} from './providerAvailability';
import {
  MARINE_BUSY_DEFAULT_RETRY_SECONDS,
  fetchJsonWithRetries,
  logUpstream,
} from './providerTransport';
import { marineIngredientKey, metRawKey } from './generation';
import { putKvWithLog } from './kvWriteLogging';
const WARNING_EXECUTION_BUDGET_MS = 5_000;

// Compatibility aliases preserve the public Worker test/API surface while the
// implementation lives at the generation-owned semantic boundary.
export {
  PAYLOAD_VERSION,
  degradedSourcesAfterProbe,
  deriveMarineSeedsFromPayload,
  isMarineRunWithinFallbackAge,
  marineInstancesEqual,
  marineInstancesWithinFallbackAge,
  marineProbeDecision,
};

function assertMarineRunWithinFallbackAge(
  instance: MarineInstance | null | undefined,
  label = instance?.collection ?? 'marine',
): void {
  const rejection = marineFallbackRejection(instance);
  if (rejection === 'invalid') {
    throw new Error(`DMI ${label} run id is invalid for the 12-hour marine safety limit.`);
  }
  if (rejection === 'future') {
    throw new Error(`DMI ${label} run is future-dated and fails the 12-hour marine safety limit.`);
  }
  if (rejection === 'expired') {
    throw new ProviderUnavailableError(
      'marine',
      `DMI ${label} has not published a run within the 12-hour marine safety limit.`,
    );
  }
}

export const DMI_RUN_MANIFEST_KEY = 'frank:system:dmi-run-manifest';
export const DMI_RUN_MANIFEST_SCHEMA_VERSION = 1;
const DMI_INSTANCE_PROBE_MEMO_PREFIX = 'instance-probe:';
const DMI_RUN_MANIFEST_KV_BUDGET_MS = 1_000;

type DmiRunManifestStore = Pick<KVNamespace, 'get' | 'put'>;

interface DmiRunManifestEntry extends MarineInstance {
  discoveredAt: string;
}

type DmiRunManifestState =
  | { kind: 'missing' }
  | { kind: 'valid'; entries: Record<string, unknown> }
  | { kind: 'unusable' };

type DmiRunManifestEntryState =
  | { kind: 'missing' }
  | {
      kind: 'valid';
      entry: DmiRunManifestEntry;
      discoveredAtMs: number;
      runAtMs: number;
    }
  | { kind: 'unusable' };

interface DmiInstanceResolution {
  instance: MarineInstance;
  source: 'catalogue' | 'manifest';
  collections: readonly string[];
  known: MarineInstance | undefined;
}

interface DmiInstanceResolutionPlan {
  promise: Promise<DmiInstanceResolution>;
  catalogueContacted: boolean;
}

function dmiRunManifestKvPolicy(policy: ExecutionPolicy): ExecutionPolicy {
  // The manifest is only a hint. Bound its KV work before the existing
  // completion reserve so a slow internal service cannot consume the provider
  // opportunity or the time needed to assemble and persist the real forecast.
  return {
    ...policy,
    deadlineAt: Math.min(
      policy.deadlineAt - policy.completionReserveMs,
      Date.now() + DMI_RUN_MANIFEST_KV_BUDGET_MS,
    ),
    completionReserveMs: 0,
  };
}

// Collection order is part of DMI fallback policy, so this identity must never
// sort. The same joined list owns both the event-local probe memo and the
// persisted cross-invocation manifest entry.
export function dmiCollectionListKey(collections: readonly string[]): string {
  return collections.join(',');
}

function instanceProbeMemoKey(collections: readonly string[]): string {
  return `${DMI_INSTANCE_PROBE_MEMO_PREFIX}${dmiCollectionListKey(collections)}`;
}

function validatedDmiRunManifestEntry(
  value: unknown,
  collections: readonly string[],
  nowMs: number,
): Extract<DmiRunManifestEntryState, { kind: 'valid' }> | null {
  if (!isRecord(value)
    || typeof value.collection !== 'string'
    || !collections.includes(value.collection)
    || typeof value.id !== 'string'
    || typeof value.discoveredAt !== 'string') {
    return null;
  }

  const runAtMs = parseDmiInstanceMs(value.id);
  const discoveredAtMs = Date.parse(value.discoveredAt);
  if (!Number.isFinite(runAtMs)
    || runAtMs > nowMs
    || !Number.isFinite(discoveredAtMs)
    || discoveredAtMs > nowMs
    || new Date(discoveredAtMs).toISOString() !== value.discoveredAt) {
    return null;
  }

  return {
    kind: 'valid',
    entry: {
      collection: value.collection,
      id: value.id,
      discoveredAt: value.discoveredAt,
    },
    discoveredAtMs,
    runAtMs,
  };
}

function dmiRunManifestEntryState(
  manifest: DmiRunManifestState,
  collections: readonly string[],
  nowMs: number,
): DmiRunManifestEntryState {
  if (manifest.kind === 'unusable') return { kind: 'unusable' };
  if (manifest.kind === 'missing') return { kind: 'missing' };
  const value = manifest.entries[dmiCollectionListKey(collections)];
  if (value === undefined) return { kind: 'missing' };
  return validatedDmiRunManifestEntry(value, collections, nowMs)
    ?? { kind: 'unusable' };
}

async function readDmiRunManifest(
  store: DmiRunManifestStore,
  policy: ExecutionPolicy,
): Promise<DmiRunManifestState> {
  try {
    const manifestPolicy = dmiRunManifestKvPolicy(policy);
    const value = await awaitWithinDeadline(
      () => store.get<unknown>(DMI_RUN_MANIFEST_KEY, 'json'),
      manifestPolicy,
      'DMI run manifest read',
    );
    if (value === null) return { kind: 'missing' };
    if (!isRecord(value)
      || value.schemaVersion !== DMI_RUN_MANIFEST_SCHEMA_VERSION
      || !isRecord(value.entries)) {
      return { kind: 'unusable' };
    }
    return { kind: 'valid', entries: value.entries };
  } catch {
    // This object is only an optimization. Any storage/parse/contract failure
    // degrades to the pre-manifest catalogue probe, never to assumed currency.
    return { kind: 'unusable' };
  }
}

function manifestInstanceForCollections(
  manifest: DmiRunManifestState,
  collections: readonly string[],
  known: MarineInstance | undefined,
  nowMs: number,
): MarineInstance | null {
  const stored = dmiRunManifestEntryState(manifest, collections, nowMs);
  if (stored.kind !== 'valid'
    || !isMarineRunWithinFallbackAge(stored.entry, nowMs)
    || nowMs - stored.discoveredAtMs > FORECAST_SOURCE_POLICY.dmiRunCycleMs) {
    return null;
  }

  const knownRunAtMs = known ? parseDmiInstanceMs(known.id) : Number.NaN;
  if (known && !Number.isFinite(knownRunAtMs)) return null;
  if (Number.isFinite(knownRunAtMs) && stored.runAtMs < knownRunAtMs) return null;
  return {
    collection: stored.entry.collection,
    id: stored.entry.id,
  };
}

function resolveLatestInstanceForCollections(
  collections: string[],
  known: MarineInstance | undefined,
  manifest: DmiRunManifestState,
  policy: ExecutionPolicy,
  eventMemo?: EventMemo,
): DmiInstanceResolutionPlan {
  const adopted = manifestInstanceForCollections(
    manifest,
    collections,
    known,
    Date.now(),
  );
  if (adopted) {
    return {
      promise: Promise.resolve({
        instance: adopted,
        source: 'manifest',
        collections,
        known,
      }),
      catalogueContacted: false,
    };
  }
  return {
    promise: fetchLatestInstanceForCollections(collections, policy, eventMemo)
      .then((instance) => ({
        instance,
        source: 'catalogue' as const,
        collections,
        known,
      })),
    catalogueContacted: true,
  };
}

async function persistDmiRunManifest(
  store: DmiRunManifestStore,
  manifest: DmiRunManifestState,
  resolutions: readonly PromiseSettledResult<DmiInstanceResolution>[],
  policy: ExecutionPolicy,
): Promise<void> {
  if (manifest.kind === 'unusable') return;

  const nowMs = Date.now();
  const updates = new Map<string, MarineInstance>();
  for (const result of resolutions) {
    if (result.status !== 'fulfilled' || result.value.source !== 'catalogue') continue;
    const { collections, instance, known } = result.value;
    if (!isMarineRunWithinFallbackAge(instance, nowMs)) continue;
    const discoveredRunAtMs = parseDmiInstanceMs(instance.id);
    if (!Number.isFinite(discoveredRunAtMs)) continue;

    const stored = dmiRunManifestEntryState(manifest, collections, nowMs);
    if (stored.kind === 'unusable') continue;
    const knownRunAtMs = known
      && collections.includes(known.collection)
      && isMarineRunWithinFallbackAge(known, nowMs)
      ? parseDmiInstanceMs(known.id)
      : Number.NaN;
    const advancesKnownRun = !Number.isFinite(knownRunAtMs)
      || discoveredRunAtMs > knownRunAtMs;
    if (advancesKnownRun
      && (stored.kind === 'missing'
        || (stored.kind === 'valid' && discoveredRunAtMs > stored.runAtMs))) {
      updates.set(dmiCollectionListKey(collections), instance);
    }
  }
  if (updates.size === 0) return;

  const discoveredAt = new Date(nowMs).toISOString();
  const entries: Record<string, unknown> = manifest.kind === 'valid'
    ? { ...manifest.entries }
    : {};
  for (const [key, instance] of updates) {
    entries[key] = {
      collection: instance.collection,
      id: instance.id,
      discoveredAt,
    } satisfies DmiRunManifestEntry;
  }

  try {
    const manifestPolicy = dmiRunManifestKvPolicy(policy);
    await awaitWithinDeadline(
      () => putKvWithLog(
        store,
        DMI_RUN_MANIFEST_KEY,
        JSON.stringify({
          schemaVersion: DMI_RUN_MANIFEST_SCHEMA_VERSION,
          entries,
        }),
        'dmi-run-manifest',
      ),
      manifestPolicy,
      'DMI run manifest write',
    );
  } catch (error) {
    // The catalogue result remains authoritative for this invocation. Losing
    // this best-effort hint may cost a later redundant probe, never correctness.
    console.error(JSON.stringify({
      event: 'dmi_run_manifest_write_failed',
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

// The event memo still coalesces duplicate callers inside one invocation and
// shares a provider refusal with the parallel sibling leg. Scheduled refreshes
// now own one rotated city, though, so cross-tick catalogue evidence belongs in
// the validated KV manifest above rather than in request-scoped promises or
// module globals.

export function fetchLatestInstanceForCollections(
  collections: string[],
  policyInput?: ExecutionPolicyInput,
  eventMemo?: EventMemo,
): Promise<MarineInstance> {
  const policy = executionPolicy(policyInput);
  assertBeforeDeadline(policy, `DMI ${collections.join(',')} instance probe`);
  const key = instanceProbeMemoKey(collections);
  const memo = eventMemo?.get(key);
  if (memo) return memo as Promise<MarineInstance>;

  // The PROMISE is cached, not its result. Only an in-flight promise can
  // coalesce duplicate same-list callers that start concurrently inside one
  // invocation; caching after resolution is too late to prevent both requests.
  //
  // A PROVIDER rejection is cached on the same terms, deliberately: a 429 means
  // "stop asking", and repeating it inside the same invocation is exactly the
  // hammering that earned it. The first caller always awaits, so the stored
  // rejection is never an unhandled one.
  //
  // A rejection that is about US is not shared. The promise carries the FIRST
  // caller's ExecutionPolicy, so if that caller simply ran out of its provider
  // window the rejection is a deadline error, not a statement about DMI. A
  // later caller with its own budget deserves its own attempt.
  const promise = probeLatestInstanceForCollections(collections, policy, eventMemo);
  eventMemo?.set(key, promise);
  promise.catch((error: unknown) => {
    if (!isProviderUnavailableError(error) && eventMemo?.get(key) === promise) {
      eventMemo.delete(key);
    }
  });
  return promise;
}

async function probeLatestInstanceForCollections(
  collections: string[],
  policy: ExecutionPolicy,
  eventMemo?: EventMemo,
): Promise<MarineInstance> {
  let lastError: Error | undefined;

  for (const collection of collections) {
    assertBeforeProviderDeadline(policy, `DMI ${collection} collection fallback`);
    try {
      const data = await fetchJsonWithRetries(
        dmiInstancesUrl(collection),
        `DMI ${collection} instances`,
        policy,
        'marine',
        eventMemo,
      );
      const latest = latestInstanceFromResponse(data);
      if (latest) {
        return {
          collection,
          id: latest.id,
        };
      }
      lastError = new ProviderUnavailableError(
        'marine',
        `DMI ${collection} has not published a usable instance yet.`,
      );
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      // Collection fallbacks are for a missing collection (404) or a usable
      // response with no instances. Timeouts/5xx are host failures: asking the
      // same host under another collection name only spends the cleanup budget
      // and used to drive the event all the way to its hard deadline.
      if (!shouldTryNextDmiCollection(errorStatus(lastError))) throw lastError;
    }
  }

  throw lastError ?? new Error(`No DMI instances found for ${collections.join(', ')}`);
}

export interface MarineInstanceProbe {
  instances: MarineInstances;
  // Kinds whose own probe failed and whose run id was carried over from the
  // last known one. The data behind them is real, but nothing verified this
  // tick that it is still the newest, so it must be reported as degraded.
  substituted: MarineKind[];
  // True only when this invocation completed at least one catalogue request.
  // A manifest-only verification is healthy evidence, but not a new provider
  // contact and must not advance the per-city heartbeat stamp.
  catalogueContacted: boolean;
}

export async function fetchLatestMarineInstances(
  location: ForecastLocation,
  policyInput?: ExecutionPolicyInput,
  eventMemo?: EventMemo,
  fallbackInstances?: MarineInstances,
  runManifestStore?: DmiRunManifestStore,
): Promise<MarineInstanceProbe> {
  const policy = executionPolicy(policyInput);
  assertBeforeDeadline(policy, `marine instance probes for ${location.id}`);
  const manifest: DmiRunManifestState = runManifestStore
    ? await readDmiRunManifest(runManifestStore, policy)
    : { kind: 'unusable' };
  const waterResolution = resolveLatestInstanceForCollections(
    location.dmiCollections.water,
    fallbackInstances?.water,
    manifest,
    policy,
    eventMemo,
  );
  const waveResolution = resolveLatestInstanceForCollections(
    location.dmiCollections.waves,
    fallbackInstances?.waves,
    manifest,
    policy,
    eventMemo,
  );
  const results = await Promise.allSettled([
    waterResolution.promise,
    waveResolution.promise,
  ]);
  assertBeforeDeadline(policy, `marine instance probe results for ${location.id}`);
  if (runManifestStore) {
    await persistDmiRunManifest(runManifestStore, manifest, results, policy);
  }

  let water = results[0].status === 'fulfilled' ? results[0].value.instance : undefined;
  let waves = results[1].status === 'fulfilled' ? results[1].value.instance : undefined;
  const catalogueContacted = waterResolution.catalogueContacted
    || waveResolution.catalogueContacted;

  // Substituting a still-valid id keeps one source's outage from blanking the
  // other, but it is NOT a successful probe and the caller has to know the
  // difference. Returning it silently meant a DMI catalogue outage read as a
  // fully current forecast: ids unchanged, so the tick took the
  // already-current path, restamped lastAttemptAt to now, cleared nothing, and
  // if MET's Expires lapsed it stamped fetchedAt onto hours-old tide data.
  const substituted: MarineKind[] = [];
  if (!water && fallbackInstances?.water && isMarineRunWithinFallbackAge(fallbackInstances.water)) {
    water = fallbackInstances.water;
    substituted.push('water');
  }
  if (!waves && fallbackInstances?.waves && isMarineRunWithinFallbackAge(fallbackInstances.waves)) {
    waves = fallbackInstances.waves;
    substituted.push('waves');
  }

  if (!water || !waves) {
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (errors.length > 0 && errors.every(isProviderUnavailableError)) {
      const advertisedRetries = errors
        .map((error) => error.retryAfterSeconds)
        .filter((seconds): seconds is number =>
          typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0);
      throw new ProviderUnavailableError(
        'marine',
        'DMI marine model instances are temporarily unavailable.',
        errors[0],
        errors.some((error) => error.busy),
        advertisedRetries.length > 0
          ? Math.max(...advertisedRetries)
          : MARINE_BUSY_DEFAULT_RETRY_SECONDS,
      );
    }
    throw new Error(`Failed to fetch DMI marine instances: ${errors.join(', ')}`);
  }

  return { instances: { water, waves }, substituted, catalogueContacted };
}

async function fetchDmiGeoJson<TFeature>(
  collection: string,
  parameters: string[],
  location: Pick<ForecastLocation, 'coordinate'>,
  instanceId: string,
  policy: ExecutionPolicy,
  eventMemo?: EventMemo,
): Promise<{ features: TFeature[] }> {
  const json = await fetchJsonWithRetries(
    dmiForecastUrl(collection, parameters, location, instanceId),
    `DMI ${collection}`,
    policy,
    'marine',
    eventMemo,
  );
  return featureCollectionFromJson<TFeature>(json);
}

async function fetchMetWeather(
  env: Env,
  location: ForecastLocation,
  policy: ExecutionPolicy,
  eventMemo?: EventMemo,
): Promise<MetResult> {
  assertBeforeDeadline(policy, `MET cache read for ${location.id}`);
  const rawKey = metRawKey(location);
  let stored: MetRawCache | null = null;
  try {
    const retained = await awaitWithinDeadline(
      () => env.FRANK_FORECAST_CACHE.get(rawKey, 'json'),
      policy,
      `MET retained cache read for ${location.id}`,
    );
    stored = isMetRawCache(retained, location) ? retained : null;
  } catch (error) {
    rethrowIfDeadlineReached(error, policy, `MET retained cache read recovery for ${location.id}`);
    stored = null;
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': FORECAST_SOURCE_POLICY.metUserAgent,
  };
  // MET TOS: repeat requests must carry If-Modified-Since with exactly the
  // Last-Modified value previously received.
  if (stored?.lastModified && stored?.body) {
    headers['If-Modified-Since'] = stored.lastModified;
  }

  try {
    const metStartedAt = Date.now();
    let response: Response;
    try {
      response = await fetchWithTimeout(metForecastUrl(location), { headers }, policy, eventMemo);
    } catch (error) {
      throw transientProviderError(
        error,
        'weather',
        `MET Norway weather is temporarily unavailable for ${location.id}.`,
      ) ?? error;
    }
    logUpstream(`met:${location.id}`, metStartedAt, response.status === 304 ? 'not-modified' : `http-${response.status}`);

    if (response.status === 304 && stored?.body) {
      // Unchanged on MET's side: reuse the stored body. A 304 can still extend
      // the validity window through its own Expires header.
      const expiresHeader = response.headers.get('Expires');
      const expiresMs = expiresHeader ? Date.parse(expiresHeader) : Number.NaN;
      return { ...mapMetPayload(stored.body, stored.lastModified, expiresMs), fallback: false };
    }

    if (!response.ok) {
      const statusError = errorWithStatus(
        `MET Norway weather failed with HTTP ${response.status}`,
        response.status,
      );
      const classifiedError = transientProviderError(
        statusError,
        'weather',
        `MET Norway weather is temporarily unavailable for ${location.id}.`,
      ) ?? statusError;
      let providerMessage = '';
      try {
        providerMessage = (await response.text()).slice(0, 180);
      } catch {
        // Keep classification bound to the reached HTTP status.
      }
      console.warn({
        event: 'upstream_http_error',
        source: `met:${location.id}`,
        status: response.status,
        ...(providerMessage ? { providerMessage } : {}),
      });
      throw classifiedError;
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
          () => putKvWithLog(
            env.FRANK_FORECAST_CACHE,
            rawKey,
            JSON.stringify({
              locationId: location.id,
              forecastConfigRevision: location.forecastConfigRevision,
              lastModified,
              body: data,
            }),
            'raw-met',
            location.id,
          ),
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
    if (!isProviderUnavailableError(error)) throw error;
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
    if (canUseMetFallback(stored)) {
      // MET always returns data when reachable, so a MET fallback is always a
      // real transport failure - degraded, not merely "not published yet".
      return {
        ...mapMetPayload(stored.body, stored.lastModified, Number.NaN),
        fallback: true,
        degraded: true,
        busy: error.busy,
      };
    }
    throw error;
  }
}

export async function readRetainedMarineInstances(
  env: Env,
  location: Pick<ForecastLocation, 'id' | 'forecastConfigRevision'>,
  policy: ExecutionPolicy,
): Promise<MarineInstances | undefined> {
  const waterKey = marineIngredientKey(location, 'water');
  const wavesKey = marineIngredientKey(location, 'waves');

  let waterStored: MarineIngredientEnvelope | null = null;
  let wavesStored: MarineIngredientEnvelope | null = null;

  try {
    const [waterRaw, wavesRaw] = await Promise.all([
      awaitWithinDeadline(
        () => env.FRANK_FORECAST_CACHE.get(waterKey, 'json'),
        policy,
        `water retained instance check for ${location.id}`,
      ),
      awaitWithinDeadline(
        () => env.FRANK_FORECAST_CACHE.get(wavesKey, 'json'),
        policy,
        `waves retained instance check for ${location.id}`,
      ),
    ]);
    waterStored = isMarineIngredientEnvelope(waterRaw, location) ? waterRaw : null;
    wavesStored = isMarineIngredientEnvelope(wavesRaw, location) ? wavesRaw : null;
  } catch (error) {
    rethrowIfDeadlineReached(error, policy, `retained instances read recovery for ${location.id}`);
    return undefined;
  }

  const currentWater = currentMarineIngredient(waterStored);
  const currentWaves = currentMarineIngredient(wavesStored);

  if (
    currentWater?.collection
    && currentWater?.id
    && currentWaves?.collection
    && currentWaves?.id
  ) {
    const candidate: MarineInstances = {
      water: { collection: currentWater.collection, id: currentWater.id },
      waves: { collection: currentWaves.collection, id: currentWaves.id },
    };
    return marineInstancesWithinFallbackAge(candidate) ? candidate : undefined;
  }
  return undefined;
}

// Last-good marine series per source, so one provider's brownout can't
// freeze the other's fresh data ("split retention, single serving": each
// ingredient falls back independently, the served payload stays one
// combined object where every hour has both weather and marine data).
// This cache contains NORMALIZED series, not raw provider responses. Its own
// cache schema and location-config identity are present in both key and
// envelope; the compiled release axes are additionally present in the key.
// None of these identities is coupled to the browser payload version.
export async function fetchMarineSeriesWithFallback<TFeature>(
  env: Env,
  location: Pick<
    ForecastLocation,
    'id' | 'forecastConfigRevision' | 'areaName' | 'coordinate'
  >,
  kind: MarineKind,
  instance: MarineInstance,
  parameters: string[],
  mapFeatures: (features: TFeature[]) => SeriesPoint[],
  seedSeries?: SeriesPoint[],
  seedInstance?: MarineInstance,
  policyInput?: ExecutionPolicyInput,
  eventMemo?: EventMemo,
): Promise<MarineSeriesResult> {
  const policy = executionPolicy(policyInput);
  assertBeforeDeadline(policy, `${kind} marine cache read for ${location.id}`);
  assertMarineRunWithinFallbackAge(instance, instance?.collection ?? kind);
  const key = marineIngredientKey(location, kind);

  let stored: MarineIngredientEnvelope | null = null;
  try {
    const retained = await awaitWithinDeadline(
      () => env.FRANK_FORECAST_CACHE.get(key, 'json'),
      policy,
      `${kind} retained cache read for ${location.id}`,
    );
    stored = isMarineIngredientEnvelope(retained, location) ? retained : null;
  } catch (error) {
    rethrowIfDeadlineReached(error, policy, `${kind} retained cache read recovery for ${location.id}`);
    stored = null;
  }

  // Same run we already hold data for: reuse it, no network call. DMI runs
  // change only every ~6h, so an hourly weather rebuild must not re-pull
  // identical marine data (measured: gaps between runs are exactly 6.00h).
  const currentStored = currentMarineIngredient(stored);

  if (currentStored
    && currentStored.collection === instance.collection
    && currentStored.id === instance.id) {
    return { series: currentStored.series, instance, fallback: false };
  }

  // Fall back to the run we already hold (retained ingredient, else the seed
  // from the cached payload). `extra` distinguishes WHY we fell back.
  const fallbackToHeld = (
    extra: Pick<MarineSeriesResult, 'degraded' | 'busy' | 'notReady'>,
  ): MarineSeriesResult | null => heldMarineFallback(
    currentStored,
    seedSeries,
    seedInstance,
    instance,
    extra,
  );

  let data: { features: TFeature[] };
  try {
    data = await fetchDmiGeoJson(
      instance.collection,
      parameters,
      location,
      instance.id,
      policy,
      eventMemo,
    );
  } catch (error) {
    rethrowIfDeadlineReached(error, policy, `${kind} retained fallback for ${location.id}`);
    if (!isProviderUnavailableError(error)) throw error;
    // Transport error (429/5xx/network): we genuinely could not refresh this
    // source. Show the held run and flag it degraded (amber).
    const held = fallbackToHeld({
      degraded: true,
      busy: error.busy,
    });
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
        () => putKvWithLog(
          env.FRANK_FORECAST_CACHE,
          key,
          JSON.stringify({
            schemaVersion: MARINE_INGREDIENT_CACHE_SCHEMA_VERSION,
            locationId: location.id,
            forecastConfigRevision: location.forecastConfigRevision,
            collection: instance.collection,
            id: instance.id,
            series,
          }),
          'raw-marine',
          location.id,
        ),
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
  throw new ProviderUnavailableError(
    'marine',
    `DMI ${instance.collection} has not published ${kind} forecast points for ${location.areaName} yet.`,
  );
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

// One HTTP body, shared by every location in this tick, with failures NOT
// cached so a single unlucky leg cannot poison the others. Distinct from the
// instance-probe memo above, which deliberately retains a refusal so a 429 is
// not re-earned per city; a warning feed is advisory and fails open, so
// retrying it is cheap and hiding a warning is not.
export async function memoizedText(
  key: string,
  eventMemo: EventMemo | undefined,
  fetchText: () => Promise<string>,
): Promise<string> {
  const cached = eventMemo?.get(key);
  if (cached) return cached as Promise<string>;
  const promise = fetchText();
  eventMemo?.set(key, promise);
  promise.catch(() => eventMemo?.delete(key));
  return promise;
}

// A non-OK body still owns one of the Worker's six concurrent outgoing
// connections until it is consumed or cancelled. Cancellation itself is
// asynchronous and can reject (for example when the stream is already
// disturbed), so wait for it but preserve the HTTP error as the useful result.
export async function warningResponseText(
  response: Response,
  label: string,
): Promise<string> {
  if (response.ok) return response.text();
  try {
    await response.body?.cancel();
  } catch {
    // Best-effort connection release; the reached HTTP status owns failure.
  }
  throw new Error(`${label} failed: ${response.status}`);
}

async function fetchWarnings(
  location: ForecastLocation,
  seedWarnings: WeatherWarning[] | undefined,
  policy: ExecutionPolicy,
  eventMemo?: EventMemo,
  now = Date.now(),
): Promise<WeatherWarning[]> {
  if (!location.emmaId) return [];
  try {
    assertBeforeDeadline(policy, `warning feed for ${location.id}`);
    // The feed is country-wide and its URL carries no location, yet it was
    // fetched once per city, and DK004 covers three of the four. With the CAP
    // details behind it that was up to 28 of the ~45 usable subrequests spent
    // re-fetching identical bytes - and spent hardest exactly when warnings are
    // active, which is when the app matters most. emmaId and kommuneAliases are
    // both applied after the fetch, so one body serves everyone.
    const body = await memoizedText('warning-feed', eventMemo, async () => {
      const response = await fetchWithTimeout(METEOALARM_DENMARK_FEED, {
        headers: { Accept: '*/*' },
        cf: { cacheTtl: 300, cacheEverything: true },
      }, policy, eventMemo);
      return warningResponseText(response, 'MeteoAlarm feed');
    });
    const warnings = parseMeteoalarmFeed(body, location.emmaId);
    // Kommune-coverage soft filter (public CAP detail per warning): may only
    // QUIET a warning that demonstrably excludes this town — fail-open, so
    // any detail failure leaves the warning region-level and fully shown.
    return await enrichWarningCoverage(warnings, location.kommuneAliases, async (url) =>
      memoizedText(`cap-detail:${url}`, eventMemo, async () => {
        const detail = await fetchWithTimeout(url, {
          headers: { Accept: '*/*' },
          cf: { cacheTtl: 300, cacheEverything: true },
        }, policy, eventMemo);
        return warningResponseText(detail, 'CAP detail');
      }));
  } catch {
    // The warning policy has a deliberately short child deadline. Reaching it
    // is an advisory-feed failure, not the parent event's hard deadline: carry
    // forward still-active warnings while the required forecast finishes. Only
    // the parent's true wall clock may prevent this tiny recovery step.
    if ((policy.hardDeadlineAt ?? policy.deadlineAt) - Date.now() <= 0) {
      throw deadlineError(`warning fallback for ${location.id}`);
    }
    return retainedActiveWarnings(seedWarnings, now);
  }
}

export async function buildForecastCache(
  env: Env,
  location: ForecastLocation,
  marineInstances: MarineInstances,
  marineSeeds: MarineSeeds | null,
  warningSeed: WeatherWarning[] | undefined,
  policy: ExecutionPolicy,
  eventMemo?: EventMemo,
): Promise<ForecastBuildResult> {
  assertBeforeDeadline(policy, `forecast build for ${location.id}`);
  const seedInstances = marineSeeds?.instances;
  const warningPolicy = advisoryWarningPolicy(policy);
  const results = await Promise.allSettled([
    fetchMetWeather(env, location, policy, eventMemo),
    fetchMarineSeriesWithFallback(env, location, 'water', marineInstances.water, FORECAST_PROVIDER_PARAMETERS.water, mapWaterFeatures, marineSeeds?.water, seedInstances?.water, policy, eventMemo),
    fetchMarineSeriesWithFallback(env, location, 'waves', marineInstances.waves, FORECAST_PROVIDER_PARAMETERS.waves, mapWaveFeatures, marineSeeds?.waves, seedInstances?.waves, policy, eventMemo),
    fetchWarnings(location, warningSeed, warningPolicy, eventMemo),
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
      .map((result) => result.reason);
    if (errors.length > 0 && errors.every(isProviderUnavailableError)) {
      const providers = new Set(errors.map((error) => error.provider));
      const provider: BusyProvider = providers.size === 1
        ? errors[0].provider
        : 'services';
      const advertisedRetries = errors
        .map((error) => error.retryAfterSeconds)
        .filter((seconds): seconds is number =>
          typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0);
      throw new ProviderUnavailableError(
        provider,
        'Required forecast providers are temporarily unavailable.',
        errors[0],
        errors.some((error) => error.busy),
        advertisedRetries.length > 0 ? Math.max(...advertisedRetries) : undefined,
      );
    }
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

  if (met.weatherSeries.length === 0) {
    throw new ProviderUnavailableError(
      'weather',
      `MET Norway has not published weather forecast points for ${location.areaName} yet.`,
    );
  }

  return assembleForecastFromSources(location, { met, water, wave, warnings });
}
