import locationData from '../src/config/locations.json';
import type { ForecastLocation } from '../src/config/locationTypes';
import {
  CURRENT_RELEASE,
  supportedForecastApiPaths,
} from '../src/features/forecast/releaseContract';
import type { ReleaseMetadata } from '../src/features/forecast/releaseContract';
import { reviveReadings } from '../src/features/forecast/normalize';
import { isValidForecastPayload } from '../src/features/forecast/validatePayload';
import {
  hasValidWarmAuthorization,
  headResponse,
  jsonResponse,
  matchRoute,
  methodNotAllowedResponse,
  optionsResponse,
  withWorkerVersion,
} from './http';
import {
  buildHealthPayload,
  healthResponse,
  statusResponse,
} from './health';
import {
  CRON_TICK_BUDGET_MS,
  DEFAULT_FETCH_TIMEOUT_MS as FETCH_TIMEOUT_MS,
  assertBeforeDeadline,
  awaitWithinDeadline,
  cronExecutionPolicy,
  executionPolicy,
  isExecutionDeadlineError,
  remainingExecutionMs,
  rethrowIfDeadlineReached,
  rotateTickOrder,
} from './execution';
import type { ExecutionPolicy, ExecutionPolicyInput } from './execution';
import type {
  BusyProvider,
  CronHeartbeat,
  EventMemo,
  ForecastData,
  ForecastInitializationMarker,
  ForecastInitializingPayload,
  HealthLocationEntry,
  HealthPayload,
  MarineInstances,
  RefreshOptions,
  WorkerCacheHealth,
} from './domain';
import {
  recoveredDeferredMarineCheck,
  withCacheHealth,
  withDeferredMarineCheck,
} from './cacheHealth';
import {
  isProviderUnavailableError,
} from './providerAvailability';
import {
  buildForecastCache,
  degradedSourcesAfterProbe,
  deriveMarineSeedsFromPayload,
  fetchLatestInstanceForCollections,
  fetchLatestMarineInstances,
  fetchMarineSeriesWithFallback,
  isMarineRunWithinFallbackAge,
  marineProbeDecision,
  marineInstancesEqual,
  marineInstancesWithinFallbackAge,
  readMarineBusyCircuit,
  readRetainedMarineInstances,
} from './providers';
import { isRecord } from './validation';
import {
  RELEASE_IDENTITY,
  INITIALIZATION_STATE_SCHEMA_VERSION,
  assembledForecastKey,
  initializationStateKey,
  isForecastForRelease,
  versionedForecastRoute,
  withReleaseHeaders,
} from './generation';

// Preserve the small public test/API surface while provider implementation is
// owned by its cohesive module.
export {
  degradedSourcesAfterProbe,
  deriveMarineSeedsFromPayload,
  fetchLatestInstanceForCollections,
  fetchLatestMarineInstances,
  fetchMarineSeriesWithFallback,
  isMarineRunWithinFallbackAge,
  marineProbeDecision,
  readMarineBusyCircuit,
};
export { cronExecutionPolicy };
// Re-exported so tests/worker/math.test.ts keeps importing them from the worker.
export {
  asNumber,
  normalizeDegrees,
  currentSpeedFromComponents,
  currentDirectionFromComponents,
} from '../src/features/forecast/normalize';

// JSON is the deployment-owned location catalogue. This single boundary
// check gives the Worker the same structural contract used by the client.
const FORECAST_LOCATIONS = locationData as ForecastLocation[];

// One timeout served two callers with opposite needs. Measured 2026-08-08:
// DMI's position queries were answering in 22-23s while this sat at 25s, so a
// merely SLOW provider was 2s from being reported as a broken one.
//
//   CRON has ten minutes and nobody waiting -> be patient.
//   A release-candidate warm request has a bounded deployment gate waiting for
//   it -> stop early enough to return a structured result.
//
// Deliberately NOT paired with running the four locations in parallel: DMI is
// the provider that rate-limits us (429 "Server is busy"), and eight concurrent
// requests would turn a slowdown into a refusal. Sequential-and-patient beats
// parallel-and-throttled against a struggling upstream.
// Reads needed to answer an HTTP request must fail before the browser's own
// 12-second Worker timeout. KV is normally an edge-local, millisecond operation;
// waiting longer than this during a storage incident only turns a truthful 503
// into an apparently frozen app/status monitor.
const RESPONSE_KV_READ_BUDGET_MS = 2_000;
// A candidate warm request must finish before the caller's 25-second HTTP
// budget. The one-second margin covers persistence and structured logging.
const CANDIDATE_BUILD_EXECUTION_BUDGET_MS = 24_000;
// Provider work stops before the event wall so cache-health assembly and the
// final KV write still have a deterministic chance to finish.
const CANDIDATE_COMPLETION_RESERVE_MS = 4_000;

const INITIALIZATION_PAYLOAD_SCHEMA_VERSION = 1;
const INITIALIZATION_RETRY_SECONDS = 10 * 60;
// KV requires expirationTtl >= 60 seconds. A little extra lifetime lets a
// caller calculate the remaining retry delay even if it arrives near the
// boundary; the marker itself stops gating at retryAfterSeconds.
const INITIALIZATION_MARKER_TTL_SECONDS = INITIALIZATION_RETRY_SECONDS + 60;

const CRON_CHECK_MIN_INTERVAL_MS = 2 * 60 * 1000;
const CHECKED_STAMP_MIN_WRITE_INTERVAL_MS = 25 * 60 * 1000;

// Proof that the cron is still firing, and which cities each tick actually got
// to. Stamping "we checked" into every city's forecast payload would be one KV
// write per city per tick; against a 1,000-write day that is what forced the
// coarse CHECKED_STAMP_MIN_WRITE_INTERVAL_MS throttle, and with it a "checked"
// time that could be 25 minutes behind the truth. One shared object costs one
// write per tick no matter how many cities exist, which is what makes an
// honest five-minute claim affordable - and what keeps adding a fifth city
// free instead of costing another ~57 writes a day.
const CRON_HEARTBEAT_SCHEMA_VERSION = 1;
// Enough for a read and a write of one small object; short enough that a KV
// brownout cannot hold the invocation open past the runtime's patience.
const HEARTBEAT_WRITE_BUDGET_MS = 3_000;
export const CRON_HEARTBEAT_KEY = 'frank:system:cron-heartbeat';

function isCronHeartbeat(value: unknown): value is CronHeartbeat {
  return isRecord(value)
    && value.schemaVersion === CRON_HEARTBEAT_SCHEMA_VERSION
    && typeof value.lastTickAt === 'string'
    && Number.isFinite(Date.parse(value.lastTickAt))
    && isRecord(value.locations);
}

async function fetchCronHeartbeat(
  env: Env,
  policyInput?: ExecutionPolicyInput,
): Promise<CronHeartbeat | null> {
  try {
    const raw = await awaitWithinDeadline(
      () => env.FRANK_FORECAST_CACHE.get(CRON_HEARTBEAT_KEY, 'json'),
      executionPolicy(policyInput),
      'cron heartbeat read',
    );
    return isCronHeartbeat(raw) ? raw : null;
  } catch {
    // Liveness is a nice-to-have on the read path. Failing to prove the cron
    // ran must never turn a servable forecast into an error.
    return null;
  }
}

// The public forecast route reads this on every request, which would double the
// app's KV read volume against a 100,000/day tier. One isolate-local copy, held
// for a fraction of the cron period, removes nearly all of it: the value only
// changes once per tick, so a request served seconds behind the newest heartbeat
// reads the same number it would have paid for. It holds a timestamp and a
// plain object, never a request or an in-flight promise.
const HEARTBEAT_MEMO_TTL_MS = 30_000;
let heartbeatMemo: { at: number; value: CronHeartbeat | null } | null = null;

async function readCronHeartbeat(
  env: Env,
  policyInput?: ExecutionPolicyInput,
  nowMs = Date.now(),
): Promise<CronHeartbeat | null> {
  if (heartbeatMemo && nowMs - heartbeatMemo.at < HEARTBEAT_MEMO_TTL_MS) {
    return heartbeatMemo.value;
  }
  const value = await fetchCronHeartbeat(env, policyInput);
  heartbeatMemo = { at: nowMs, value };
  return value;
}

async function writeCronHeartbeat(
  env: Env,
  attemptedAt: Record<string, string>,
  policyInput?: ExecutionPolicyInput,
): Promise<void> {
  try {
    // Deliberately unmemoised. This merge is the only thing preserving the
    // stamps of cities this tick did not reach, so it has to read what is
    // actually stored, not what this isolate happened to serve a moment ago.
    const previous = await fetchCronHeartbeat(env, policyInput);
    const known = new Set(FORECAST_LOCATIONS.map((location) => location.id));
    const locations = Object.fromEntries(
      Object.entries({ ...previous?.locations, ...attemptedAt })
        .filter(([id]) => known.has(id)),
    );
    const heartbeat: CronHeartbeat = {
      schemaVersion: CRON_HEARTBEAT_SCHEMA_VERSION,
      lastTickAt: new Date().toISOString(),
      locations,
    };
    await awaitWithinDeadline(
      () => env.FRANK_FORECAST_CACHE.put(CRON_HEARTBEAT_KEY, JSON.stringify(heartbeat)),
      executionPolicy(policyInput),
      'cron heartbeat write',
    );
    heartbeatMemo = { at: Date.now(), value: heartbeat };
  } catch (error) {
    console.error('Cron heartbeat write failed:', error);
  }
}

// A city's own payload is only rewritten when something about it changed, so
// its "we checked" stamp lags by design. The heartbeat carries the same fact
// more cheaply and more often, so serve whichever of the two is later.
//
// Both are RECORDED times. Never substitute Date.now() here: on a Worker whose
// cron has stopped firing that reads as "checked just now" forever, which is
// the one failure this whole mechanism exists to make visible.
export function withCronAttempt<T extends ForecastData>(
  data: T,
  locationId: string,
  heartbeat: CronHeartbeat | null,
  nowMs = Date.now(),
): T {
  const cacheHealth = data.sources.cacheHealth;
  const attemptedAt = heartbeat?.locations?.[locationId];
  const attemptedMs = Date.parse(attemptedAt ?? '');
  if (!cacheHealth || !attemptedAt || !Number.isFinite(attemptedMs)) return data;
  // A stamp from the future is a clock fault, not freshness. Left alone it
  // yields a negative age, and formatRelativeAge renders that as an empty
  // string - blanking the very label this mechanism exists to fill.
  if (attemptedMs > nowMs) return data;
  if (Date.parse(cacheHealth.lastAttemptAt) >= attemptedMs) return data;
  return {
    ...data,
    sources: {
      ...data.sources,
      cacheHealth: { ...cacheHealth, lastAttemptAt: attemptedAt },
    },
  };
}

type ForecastCacheLocation = Pick<
  ForecastLocation,
  'id' | 'forecastConfigRevision'
>;

function cacheKey(location: ForecastCacheLocation): string {
  return assembledForecastKey(location);
}

function initializationKey(location: ForecastCacheLocation): string {
  return initializationStateKey(location);
}

// Strict lookup — the caller 404s unknown ids; a silent first-location
// fallback would mask a typo'd id as the wrong fjord's forecast.
function findLocation(id: string): ForecastLocation | undefined {
  return FORECAST_LOCATIONS.find((location) => location.id === id);
}

function responseKvReadPolicy(): ExecutionPolicy {
  return executionPolicy({
    deadlineAt: Date.now() + RESPONSE_KV_READ_BUDGET_MS,
    maxAttempts: 1,
  });
}

// Public wrapper retains the original optional-list API while the generic
// rotation and deadline policy live with the other execution primitives.
export function tickOrder(scheduledTime: number | undefined): ForecastLocation[];
export function tickOrder<T>(scheduledTime: number | undefined, list: T[]): T[];
export function tickOrder(
  scheduledTime: number | undefined,
  list: ForecastLocation[] = FORECAST_LOCATIONS,
): ForecastLocation[] {
  return rotateTickOrder(scheduledTime, list);
}

function hasUsableForecastStructure(value: unknown): value is ForecastData {
  if (!isRecord(value) || !isRecord(value.sources)) return false;
  return Boolean(
      Array.isArray(value.hourly) &&
      value.hourly.length > 0 &&
      Array.isArray(value.sunrise) &&
      Array.isArray(value.sunset) &&
      typeof value.sources.fetchedAt === 'string' &&
      typeof value.sources.payloadVersion === 'number'
  );
}

function isUsableCurrentForecastCache(
  value: unknown,
  location: ForecastLocation,
): value is ForecastData {
  // A future API schema with an incompatible payload must register its own
  // validator and response type here; the release descriptor selects bytes, but
  // cannot make two structurally different contracts safe by itself.
  return hasUsableForecastStructure(value)
    && isValidForecastPayload(value, location)
    && isForecastForRelease(value, CURRENT_RELEASE)
    && hasCurrentForecastWindow(value);
}

function parseForecastCache(
  raw: string,
  validator: (value: unknown) => value is ForecastData,
): ForecastData | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    // KV stores JSON, where NaN becomes null. Restore the deliberate missing-
    // reading sentinel before applying the same validation boundary as the
    // browser; otherwise a sound production payload containing one unavailable
    // measurement would be mistaken for a corrupt rollback cache.
    if (hasUsableForecastStructure(parsed)) reviveReadings(parsed);
    return validator(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function hasCurrentForecastWindow(data: Pick<ForecastData, 'hourly'>): boolean {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  return data.hourly.some((hour) => new Date(hour.time).getTime() >= oneHourAgo);
}

async function readCachedForecast(
  env: Env,
  location: ForecastLocation,
  policyInput?: ExecutionPolicyInput,
): Promise<ForecastData | null> {
  const policy = executionPolicy(policyInput);
  const raw = await awaitWithinDeadline(
    () => env.FRANK_FORECAST_CACHE.get(cacheKey(location)),
    policy,
    `current forecast cache read for ${location.id}`,
  );
  return raw
    ? parseForecastCache(
        raw,
        (value): value is ForecastData => isUsableCurrentForecastCache(value, location),
      )
    : null;
}

async function writeCachedForecast(
  env: Env,
  location: ForecastCacheLocation,
  data: ForecastData,
  policyInput?: ExecutionPolicyInput,
): Promise<void> {
  const policy = executionPolicy(policyInput);
  await awaitWithinDeadline(
    () => env.FRANK_FORECAST_CACHE.put(cacheKey(location), JSON.stringify(data)),
    policy,
    `forecast cache write for ${location.id}`,
  );
}

function isInitializationMarker(
  value: unknown,
  location: ForecastCacheLocation,
): value is ForecastInitializationMarker {
  if (!isRecord(value) || typeof value.lastAttemptAt !== 'string') return false;
  const lastAttemptMs = Date.parse(value.lastAttemptAt);
  return Number.isFinite(lastAttemptMs)
    && lastAttemptMs <= Date.now()
    && value.schemaVersion === INITIALIZATION_STATE_SCHEMA_VERSION
    && value.status === 'initializing'
    && value.locationId === location.id
    && value.forecastConfigRevision === location.forecastConfigRevision
    && value.retryAfterSeconds === INITIALIZATION_RETRY_SECONDS
    && (value.provider === 'weather'
      || value.provider === 'marine'
      || value.provider === 'services')
    && typeof value.busy === 'boolean';
}

async function readInitializationMarker(
  env: Env,
  location: ForecastCacheLocation,
  policyInput?: ExecutionPolicyInput,
): Promise<ForecastInitializationMarker | null> {
  const policy = executionPolicy(policyInput);
  const raw = await awaitWithinDeadline(
    () => env.FRANK_FORECAST_CACHE.get(initializationKey(location)),
    policy,
    `forecast initialization marker read for ${location.id}`,
  );
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Forecast initialization marker is invalid for ${location.id}.`, {
      cause: error,
    });
  }
  if (!isInitializationMarker(parsed, location)) {
    throw new Error(`Forecast initialization marker contract is invalid for ${location.id}.`);
  }
  return parsed;
}

async function writeInitializationMarker(
  env: Env,
  location: ForecastCacheLocation,
  providerState: { provider: BusyProvider; busy: boolean },
  policyInput?: ExecutionPolicyInput,
): Promise<ForecastInitializationMarker> {
  const policy = executionPolicy(policyInput);
  const marker: ForecastInitializationMarker = {
    schemaVersion: INITIALIZATION_STATE_SCHEMA_VERSION,
    status: 'initializing',
    locationId: location.id,
    forecastConfigRevision: location.forecastConfigRevision,
    lastAttemptAt: new Date().toISOString(),
    retryAfterSeconds: INITIALIZATION_RETRY_SECONDS,
    provider: providerState.provider,
    busy: providerState.busy,
  };
  await awaitWithinDeadline(
    () => env.FRANK_FORECAST_CACHE.put(
      initializationKey(location),
      JSON.stringify(marker),
      { expirationTtl: INITIALIZATION_MARKER_TTL_SECONDS },
    ),
    policy,
    `forecast initialization marker write for ${location.id}`,
  );
  return marker;
}

// A scalar retry clock complements the persisted marker for same-isolate
// reads while KV propagates. It stores no request object or in-flight I/O.
const lastInitializationFailureAt = new Map<string, number>();

function initializationRetrySeconds(
  location: ForecastCacheLocation,
  marker?: ForecastInitializationMarker | null,
  nowMs = Date.now(),
): number {
  const persistedMs = Date.parse(marker?.lastAttemptAt ?? '');
  const memoryMs = lastInitializationFailureAt.get(initializationKey(location)) ?? Number.NaN;
  const usable = (value: number): number => Number.isFinite(value) && value <= nowMs
    ? value
    : Number.NEGATIVE_INFINITY;
  const latestAttemptMs = Math.max(
    usable(persistedMs),
    usable(memoryMs),
  );
  if (!Number.isFinite(latestAttemptMs)) return 0;
  const remainingMs = INITIALIZATION_RETRY_SECONDS * 1000 - Math.max(0, nowMs - latestAttemptMs);
  return remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0;
}

function forecastInitializingResponse(
  location: ForecastLocation,
  retryAfterSeconds = INITIALIZATION_RETRY_SECONDS,
  release: Readonly<ReleaseMetadata> = CURRENT_RELEASE,
): Response {
  const boundedRetrySeconds = Math.max(1, Math.min(
    INITIALIZATION_RETRY_SECONDS,
    Math.ceil(retryAfterSeconds),
  ));
  const payload: ForecastInitializingPayload = {
    schemaVersion: INITIALIZATION_PAYLOAD_SCHEMA_VERSION,
    status: 'initializing',
    code: 'FORECAST_INITIALIZING',
    message: 'Forecast for this location is being prepared. Please try again shortly.',
    retryAfterSeconds: boundedRetrySeconds,
    location: {
      id: location.id,
      name: location.name,
      areaName: location.areaName,
    },
  };
  return withReleaseHeaders(
    jsonResponse(payload, 503, { 'Retry-After': String(boundedRetrySeconds) }),
    { ready: false, payloadVersion: release.payloadVersion, release },
  );
}

// Whether a failed check is worth a KV write. Exported only so the decision has
// a test: it is a pure comparison of the old cacheHealth against the new one.
//
// The first failure and any CHANGE in it write immediately, because that is the
// information /status and the client need. An identical repeat writes at most
// once per CHECKED_STAMP_MIN_WRITE_INTERVAL_MS, because re-stamping the same
// verdict every 20 seconds tells nobody anything. Unthrottled, this was 3
// writes/min/location on the path a hammering user reaches (see the caller), so
// a provider outage plus a refresh-tapping crowd emptied the day's allowance in
// about 90 minutes. Leading with !Number.isFinite mirrors the cacheAlreadyCurrent
// Everything the stored health says EXCEPT when we last looked. The heartbeat
// carries the timestamp now, and persisting a whole forecast just to move it
// costs the write budget this change exists to free. Keys are sorted and
// arrays compared in place, because `degradedSources` is assembled per-provider
// and its order is not meaningful - an order-sensitive compare would spend a
// write on a reshuffle that says nothing.
function stableJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${[...value].map(stableJson).sort().join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function healthChanged(
  previous: Partial<WorkerCacheHealth> | null | undefined,
  next: Partial<WorkerCacheHealth> | null | undefined,
): boolean {
  const withoutStamp = (health: Partial<WorkerCacheHealth> | null | undefined): unknown => {
    if (!health) return null;
    const { lastAttemptAt: _lastAttemptAt, ...rest } = health;
    return rest;
  };
  return stableJson(withoutStamp(previous)) !== stableJson(withoutStamp(next));
}

// guard: a payload with no stamp yet would otherwise compare NaN and never get one.
export function shouldPersistFailureState(
  prev: Partial<WorkerCacheHealth> | null | undefined,
  next: Partial<WorkerCacheHealth> | null | undefined,
  nowMs = Date.now(),
): boolean {
  const sameDegraded = (prev?.degradedSources ?? []).slice().sort().join(',') ===
    (next?.degradedSources ?? []).slice().sort().join(',');
  const sameFailure =
    prev?.status === next?.status &&
    prev?.message === next?.message &&
    prev?.busyProvider === next?.busyProvider &&
    sameDegraded &&
    Boolean(prev?.needsRebuild) === Boolean(next?.needsRebuild) &&
    Boolean(prev?.providerBusy) === Boolean(next?.providerBusy) &&
    marineInstancesEqual(prev?.marineInstances, next?.marineInstances);
  if (!sameFailure) return true;

  const prevStampMs = Date.parse(prev?.lastAttemptAt ?? '');
  return !Number.isFinite(prevStampMs) || nowMs - prevStampMs >= CHECKED_STAMP_MIN_WRITE_INTERVAL_MS;
}

// When this isolate last actually ran a check, per location. The persisted
// stamp is deliberately coarse (see CHECKED_STAMP_MIN_WRITE_INTERVAL_MS), and
// gating only on it meant every ungated request in the throttle window passed
// the 60s/10min gates and re-probed upstream — the flood protection loosened by
// exactly the amount the write throttle saved. An in-memory clock costs no KV
// write; a stale entry after an isolate recycles just falls back to the stamp.
const lastCheckAt = new Map<string, number>();

export function shouldCheckInBackground(
  location: ForecastCacheLocation,
  data: { sources?: { cacheHealth?: Pick<WorkerCacheHealth, 'lastAttemptAt'> } } | null | undefined,
  minIntervalMs: number,
  memoryMsOverride?: number,
): boolean {
  const nowMs = Date.now();
  const stampMs = new Date(data?.sources?.cacheHealth?.lastAttemptAt ?? 0).getTime();
  const memoryMs = memoryMsOverride ?? lastCheckAt.get(cacheKey(location)) ?? 0;
  // Whichever check was more recent decides — a fresh in-memory check must not
  // be overridden by an older persisted stamp, and vice versa.
  // A clock correction or corrupt future stamp must not suppress checks until
  // wall time catches up. Only timestamps at or before this request are facts.
  const usable = (value: number): number => Number.isFinite(value) && value <= nowMs ? value : 0;
  const lastMs = Math.max(usable(stampMs), usable(memoryMs));
  return lastMs === 0 || nowMs - lastMs > minIntervalMs;
}

async function _refreshForecastCache(
  env: Env,
  location: ForecastLocation,
  options: RefreshOptions = {},
): Promise<ForecastData> {
  const policy = executionPolicy(options.executionPolicy);
  assertBeforeDeadline(policy, `refresh start for ${location.id}`);
  // A candidate warm operation may already have read this payload before
  // deciding to build. Reusing that event-local value removes a redundant KV
  // operation and guarantees the build enters its bounded try/catch promptly.
  // `null` is meaningful: the route already completed its bounded KV read and
  // proved the key absent. Nullish coalescing treated that result as "not
  // supplied" and performed the same read again on every cold request.
  const cachedWasRead = Object.prototype.hasOwnProperty.call(options, 'cached');
  const cached = cachedWasRead
    ? options.cached
    : await readCachedForecast(env, location, policy);
  const cachedNeedsRecovery = (() => {
    const health = cached?.sources?.cacheHealth;
    return health?.status === 'stale' || health?.status === 'fallback' || health?.needsRebuild;
  })();

  const minIntervalMs = options.minIntervalMs ?? CRON_CHECK_MIN_INTERVAL_MS;

  if (cached && !shouldCheckInBackground(location, cached, minIntervalMs)) {
    if (options.force && !cachedNeedsRecovery) {
      // No provider was contacted here, so lastAttemptAt keeps its old value.
      return withCacheHealth(cached, 'current', {
        preserveAttemptAt: true,
        checkedBy: options.reason ?? 'recent-check',
        message: 'Recently checked; using the latest shared forecast cache.',
      });
    }
    return cached;
  }

  // Past the gate: we are genuinely about to contact upstream, so this is the
  // moment to record the check. Setting it in the refreshForecastCache wrapper
  // instead — BEFORE the gate above reads it — made the gate see "checked 0 ms
  // ago" on every single call and short-circuit forever: the 10-minute cron
  // became a no-op and nothing rebuilt for as long as the isolate lived.
  lastCheckAt.set(cacheKey(location), Date.now());

  let latestMarine: MarineInstances | undefined;

  try {
    const cachedHealth = cached?.sources?.cacheHealth;

    // Weather freshness comes from MET's own Expires header stored on the run we
    // built against; only marine ids need a probe here. If the probe itself is
    // down, keep the previously assembled forecast and mark its marine inputs
    // degraded rather than re-dating unverified water/wave data.
    let marineProbeFailed = false;
    let marineProbeBusy = false;
    const knownMarine = cachedHealth?.marineInstances
      ?? await readRetainedMarineInstances(env, location, policy);
    // DMI's official completion windows determine when a newer marine run can
    // actually exist. A short post-due backoff stops a late publication from
    // being queried on every cron tick. Forced/recovery work and provenance
    // outside the 12-hour safety policy always bypass the schedule.
    const knownMarineWithinPolicy = marineInstancesWithinFallbackAge(knownMarine);
    const probeDecision = marineProbeDecision(
      knownMarine,
      cachedHealth?.lastAttemptAt,
    );
    const canSkipProbe = Boolean(knownMarine?.water?.id && knownMarine?.waves?.id)
      && !options.force
      && !options.forceRebuild
      && !cachedNeedsRecovery
      && knownMarineWithinPolicy
      && !probeDecision.shouldProbe;

    if (canSkipProbe) {
      latestMarine = knownMarine;
    } else {
      // A DMI 429 is provider-wide, not specific to the fjord that happened to
      // receive it. Once a due location opens the event-local circuit, another
      // due location must not make more DMI calls in the same cron batch. Keep
      // its last completed snapshot and say that this check was deferred. A
      // schedule-valid location never reaches this branch and stays green.
      const marineBusyCircuit = await readMarineBusyCircuit(options.eventMemo);
      if (marineBusyCircuit && cached) {
        const deferredCache = withDeferredMarineCheck(cached, {
          marineInstances: knownMarine,
          checkedBy: options.reason ?? 'check',
          degradedSources: degradedSourcesAfterProbe(
            cachedHealth?.degradedSources,
            true,
          ),
        });
        if (shouldPersistFailureState(cachedHealth, deferredCache.sources.cacheHealth)) {
          try {
            await writeCachedForecast(env, location, deferredCache, policy);
          } catch (writeError) {
            console.error(`Could not persist deferred marine check for ${location.id}:`, writeError);
          }
        }
        return deferredCache;
      }
      try {
        latestMarine = await fetchLatestMarineInstances(location, policy, options.eventMemo, knownMarine);
      } catch (probeError) {
        rethrowIfDeadlineReached(probeError, policy, `marine probe failure handling for ${location.id}`);
        if (!knownMarine?.water?.id || !knownMarine?.waves?.id) throw probeError;
        console.error(JSON.stringify({
          event: 'marine_instance_probe_failed',
          locationId: location.id,
          error: probeError instanceof Error
            ? { name: probeError.name, message: probeError.message }
            : { message: String(probeError) },
        }));
        latestMarine = knownMarine;
        marineProbeFailed = true;
        // Only the nominal provider boundary may call an outage "busy". A
        // schema, code, deadline, or storage error containing those words must
        // stay on the generic failure path rather than receive calm 429 copy.
        marineProbeBusy = isProviderUnavailableError(probeError) && probeError.busy;
      }
    }

    const builtWeatherExpires = cachedHealth?.weatherExpires;
    const weatherExpiredMs = builtWeatherExpires ? Date.parse(builtWeatherExpires) : Number.NaN;
    const weatherStale = !Number.isFinite(weatherExpiredMs) || Date.now() >= weatherExpiredMs;

    const marineUnchanged = marineInstancesEqual(cachedHealth?.marineInstances, latestMarine);
    const latestMarineWithinPolicy = marineInstancesWithinFallbackAge(latestMarine);

    if (marineProbeFailed && cached) {
      // We could not verify whether DMI has published a newer run. Do not use
      // unexpired MET as permission to call the combined forecast current, and
      // do not rebuild/re-date it from unverified marine ingredients. Keep the
      // last assembled fetchedAt so its age remains honest and /health can trip.
      const heldCache = withCacheHealth(cached, 'stale', {
        marineInstances: latestMarine,
        needsRebuild: cachedHealth?.needsRebuild || !latestMarineWithinPolicy,
        checkedBy: options.reason ?? 'failed-check',
        degradedSources: degradedSourcesAfterProbe(cachedHealth?.degradedSources, true),
        ...(marineProbeBusy ? { providerBusy: true, busyProvider: 'marine' } : {}),
        message: marineProbeBusy
          ? 'Marine service busy; keeping the last completed forecast.'
          : 'Marine service unavailable; keeping the last completed forecast.',
      });
      if (shouldPersistFailureState(cachedHealth, heldCache.sources.cacheHealth)) {
        try {
          await writeCachedForecast(env, location, heldCache, policy);
        } catch (writeError) {
          console.error(`Could not persist marine probe failure for ${location.id}:`, writeError);
        }
      }
      return heldCache;
    }

    const cacheAlreadyCurrent =
      cached &&
      !options.forceRebuild &&
      !cachedHealth?.needsRebuild &&
      hasCurrentForecastWindow(cached) &&
      marineUnchanged &&
      latestMarineWithinPolicy &&
      !marineProbeFailed &&
      !weatherStale;

    if (!latestMarine) {
      throw new Error(`DMI marine instances were unavailable for ${location.id}.`);
    }

    if (cacheAlreadyCurrent) {
      // MET data is still within its Expires window and marine ids are
      // unchanged: keep the forecast, just record that we checked.
      const recoveredDeferred = recoveredDeferredMarineCheck(cachedHealth);
      const checkedCache = withCacheHealth(cached, 'current', {
        marineInstances: latestMarine,
        // During the 20-minute post-due retry window no provider was checked.
        // Preserve the attempt that established the backoff, or restamping
        // every ten-minute cron would slide that window forward indefinitely.
        preserveAttemptAt: probeDecision.reason === 'retry-backoff',
        checkedBy: options.reason ?? 'check',
        // Ordinary fallback metadata still describes unchanged payload bytes.
        // A circuit deferral is different: this successful catalogue check is
        // the work that was skipped, and the held run is confirmed current, so
        // its temporary amber marker must not stick indefinitely.
        degradedSources: recoveredDeferred
          ? undefined
          : cachedHealth?.degradedSources,
        providerBusy: recoveredDeferred
          ? undefined
          : cachedHealth?.providerBusy,
        busyProvider: recoveredDeferred
          ? undefined
          : cachedHealth?.busyProvider,
        message: recoveredDeferred ? undefined : cachedHealth?.message,
      });
      // The heartbeat now carries "we checked" for every city in one object,
      // so re-writing this whole forecast just to advance a timestamp is pure
      // cost: it was ~57 writes/city/day against an allowance of 1,000, and the
      // heartbeat's own 288/day only pays for itself once this stops. What
      // still earns a write is a CHANGE in what the health says - a recovered
      // deferral clearing amber flags, a new message, a different status.
      if (probeDecision.reason !== 'retry-backoff' || recoveredDeferred) {
        if (recoveredDeferred || healthChanged(cachedHealth, checkedCache.sources.cacheHealth)) {
          await writeCachedForecast(env, location, checkedCache, policy);
        }
      }
      return checkedCache;
    }

    const built = await buildForecastCache(
      env,
      location,
      latestMarine,
      deriveMarineSeedsFromPayload(cached),
      cached?.warnings,
      policy,
      options.eventMemo,
    );
    // The build can succeed on last-good ingredients while a provider is
    // down; the payload is then still the freshest combination obtainable,
    // so it ships as 'current' with the degradation named in the message.
    const degradedSources = degradedSourcesAfterProbe(built.degradedSources, marineProbeFailed);
    const fallbackNotes: string[] = [
      ...degradedSources,
      ...(marineProbeFailed ? ['marine run schedule'] : []),
    ];
    const fresh = withCacheHealth(built.forecast, 'current', {
      marineInstances: built.marineInstances ?? latestMarine,
      weatherExpires: built.weatherExpires,
      weatherLastModified: built.weatherLastModified,
      checkedBy: options.reason ?? 'refresh',
      // Names the sources riding on last-good data (weather/water/waves) so
      // the client can show a calm "from an earlier update" note, and whether
      // it was because their provider was busy.
      ...(degradedSources.length ? { degradedSources } : {}),
      ...((built.degradedBusy || marineProbeFailed) ? { providerBusy: true } : {}),
      ...(marineProbeFailed
        ? { busyProvider: 'marine' as const }
        : built.degradedBusyProvider
          ? { busyProvider: built.degradedBusyProvider }
          : {}),
      ...(fallbackNotes.length
        ? { message: `Provider partly unavailable; using last good data for: ${fallbackNotes.join(', ')}.` }
        : {}),
    });
    // Persisting is best-effort HERE and nowhere else. If this throws (an
    // exhausted KV write budget is the realistic cause) the catch below would
    // re-enter with a perfectly good freshly-built payload and turn it into a
    // 'stale' verdict, then try to write THAT too and propagate. So the caller
    // gets the real forecast either way; only the persistence is lost.
    try {
      await writeCachedForecast(env, location, fresh, policy);
    } catch (writeError) {
      console.error(`Could not persist rebuilt forecast for ${location.id}:`, writeError);
    }
    return fresh;
  } catch (error) {
    // At the hard wall-clock boundary, do no more assembly and start no KV
    // write. Returning the last assembled payload preserves its original
    // fetchedAt; a prolonged outage therefore ages naturally into /health's
    // data-staleness failure instead of being freshly re-stamped.
    if ((isExecutionDeadlineError(error) && error.deadlineKind !== 'provider')
      || remainingExecutionMs(policy) <= 0) {
      if (cached) return cached;
      throw error;
    }
    if (cached) {
      console.error(JSON.stringify({
        event: 'forecast_refresh_failed',
        locationId: location.id,
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { message: String(error) },
      }));
      const previousMarine = cached.sources?.cacheHealth?.marineInstances;
      const newMarineNeedsRebuild = Boolean(latestMarine && !marineInstancesEqual(previousMarine, latestMarine));
      const providerFailure = isProviderUnavailableError(error) ? error : null;
      const busy = providerFailure?.busy ?? false;
      const busyProvider = providerFailure?.provider;
      const failedCache = withCacheHealth(cached, 'stale', {
        marineInstances: latestMarine ?? previousMarine,
        needsRebuild: options.forceRebuild || newMarineNeedsRebuild,
        checkedBy: options.reason ?? 'failed-check',
        ...(busy && busyProvider ? { providerBusy: true, busyProvider } : {}),
        message: 'Forecast refresh failed; keeping the last completed forecast.',
      });

      // Persist only a changed failure verdict or a deliberately coarsened
      // repeat. This protects the KV write budget during a prolonged provider
      // outage while leaving the in-response health truthful.
      if (shouldPersistFailureState(cached.sources?.cacheHealth, failedCache.sources?.cacheHealth)) {
        try {
          await writeCachedForecast(env, location, failedCache, policy);
        } catch (writeError) {
          console.error(`Could not persist failure state for ${location.id}:`, writeError);
        }
      }
      // Returned regardless of whether it was persisted: the response always
      // carries this attempt's real state.
      return failedCache;
    }

    if (isProviderUnavailableError(error)) {
      // Persist only an explicitly classified transient outcome. Writing an
      // "attempt started" marker before provider validation would let a code
      // or schema failure masquerade as initialization to later callers.
      const marker = await writeInitializationMarker(env, location, {
        provider: error.provider,
        busy: error.busy,
      }, policy);
      lastInitializationFailureAt.set(
        initializationKey(location),
        Date.parse(marker.lastAttemptAt),
      );
      console.warn(JSON.stringify({
        event: 'forecast_initializing',
        locationId: location.id,
        provider: error.provider,
        providerBusy: error.busy,
        retryAfterSeconds: marker.retryAfterSeconds,
      }));
    }

    throw error;
  }
}

async function refreshForecastCache(
  env: Env,
  location: ForecastLocation,
  options: RefreshOptions = {},
): Promise<ForecastData> {
  const key = `refresh:${cacheKey(location)}`;
  const memo = options.eventMemo;
  if (memo?.has(key)) return memo.get(key) as Promise<ForecastData>;

  const promise = _refreshForecastCache(env, location, options);
  memo?.set(key, promise);
  try {
    return await promise;
  } finally {
    memo?.delete(key);
  }
}

function candidateExecutionPolicy(): ExecutionPolicy {
  return executionPolicy({
    deadlineAt: Date.now() + CANDIDATE_BUILD_EXECUTION_BUDGET_MS,
    fetchTimeoutMs: FETCH_TIMEOUT_MS,
    // A candidate build gets one bounded attempt. The release orchestrator or
    // next cron tick is the retry schedule; in-place retries would consume the
    // persistence reserve without making a busy provider ready sooner.
    maxAttempts: 1,
    completionReserveMs: CANDIDATE_COMPLETION_RESERVE_MS,
  });
}

async function activeInitializationRetrySeconds(
  env: Env,
  location: ForecastLocation,
): Promise<number> {
  const memoryRetry = initializationRetrySeconds(location);
  if (memoryRetry > 0) return memoryRetry;
  const marker = await readInitializationMarker(env, location, responseKvReadPolicy());
  return initializationRetrySeconds(location, marker);
}

function keepCandidateBuildAlive(
  ctx: ExecutionContext,
  refresh: Promise<ForecastData>,
  location: ForecastLocation,
  reason: string,
): void {
  ctx.waitUntil(refresh.then(
    () => undefined,
    (error) => {
      // A recognized transient is already logged as forecast_initializing
      // after its retry marker is durably stored. Everything else needs an
      // owner-visible structured failure without leaking into the response.
      if (!isProviderUnavailableError(error)) {
        console.error(JSON.stringify({
          event: 'candidate_build_failed',
          locationId: location.id,
          reason,
          error: error instanceof Error
            ? { name: error.name, message: error.message }
            : { message: String(error) },
        }));
      }
    },
  ));
}

function preparedForecastResponse(
  data: ForecastData,
  ready: boolean,
  extraHeaders: Record<string, string> = {},
  release: Readonly<ReleaseMetadata> = CURRENT_RELEASE,
): Response {
  return withReleaseHeaders(jsonResponse(data, 200, extraHeaders), {
    ready,
    payloadVersion: data.sources.payloadVersion,
    release,
  });
}

async function candidateWarmResponse(
  ctx: ExecutionContext,
  location: ForecastLocation,
  refresh: Promise<ForecastData>,
  reason: string,
): Promise<Response> {
  keepCandidateBuildAlive(ctx, refresh, location, reason);
  try {
    const data = await refresh;
    return preparedForecastResponse(data, true);
  } catch (error) {
    if (isProviderUnavailableError(error)) {
      const retryAfterSeconds = initializationRetrySeconds(location);
      return forecastInitializingResponse(location, retryAfterSeconds);
    }
    throw error;
  }
}

async function handleForecastRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  locationId: string,
  eventMemo: EventMemo,
  versionedApiRoute: boolean,
): Promise<Response> {
  const location = findLocation(locationId);
  if (!location) {
    return jsonResponse({ error: `Unknown forecast location: ${locationId}` }, 404);
  }

  const url = new URL(request.url);
  const deploymentWarm = versionedApiRoute && isWarmQueryRequested(url);
  const forceRebuildRequested = url.searchParams.get('rebuild') === '1' || url.searchParams.get('rebuild') === 'true';

  if (forceRebuildRequested) {
    return jsonResponse({ error: 'Manual rebuild is not available from the public forecast endpoint.' }, 403);
  }

  const readPolicy = responseKvReadPolicy();
  // Concurrent, so proving the cron is alive costs no extra latency.
  const [cachedRaw, heartbeat] = await Promise.all([
    readCachedForecast(env, location, readPolicy),
    readCronHeartbeat(env, readPolicy),
  ]);
  const cached = cachedRaw && withCronAttempt(cachedRaw, location.id, heartbeat);

  if (deploymentWarm) {
    if (cached) return preparedForecastResponse(cached, true);

    // Authenticated `warm=1` is the deployment candidate path. It is the only
    // HTTP path allowed to build an empty generation, and it still honors the
    // generation-scoped provider cooldown (no rebuild bypass).
    const retryAfterSeconds = await activeInitializationRetrySeconds(env, location);
    if (retryAfterSeconds > 0) {
      return forecastInitializingResponse(location, retryAfterSeconds);
    }

    const refresh = refreshForecastCache(env, location, {
      force: true,
      forceRebuild: true,
      reason: 'deployment-warm',
      minIntervalMs: 0,
      executionPolicy: candidateExecutionPolicy(),
      eventMemo,
      cached: null,
    });
    return candidateWarmResponse(
      ctx,
      location,
      refresh,
      'deployment-warm',
    );
  }

  if (cached) {
    // Browser traffic only reads the last fully prepared snapshot. Cron owns
    // provider refreshes, so 100 simultaneous first visitors stay 100 KV reads
    // instead of becoming 100 upstream initialization attempts.
    return preparedForecastResponse(cached, true);
  }

  const retryAfterSeconds = await activeInitializationRetrySeconds(env, location);
  return forecastInitializingResponse(
    location,
    retryAfterSeconds > 0 ? retryAfterSeconds : INITIALIZATION_RETRY_SECONDS,
  );
}

async function loadHealthPayload(env: Env): Promise<HealthPayload> {
  const policy = responseKvReadPolicy();
  let entries: HealthLocationEntry[];
  let storageUnavailable = false;
  // Started, not awaited: /status refreshes itself every 30 seconds and external
  // monitors poll /health hard, so this must overlap the per-location reads the
  // way the forecast route already does rather than adding a round-trip in front
  // of them.
  const heartbeatRead = readCronHeartbeat(env, policy);
  try {
    entries = await Promise.all(
      FORECAST_LOCATIONS.map(async (location) => {
        const [currentRaw, heartbeat] = await Promise.all([
          readCachedForecast(env, location, policy),
          heartbeatRead,
        ]);
        const current = currentRaw && withCronAttempt(currentRaw, location.id, heartbeat);
        const marker = current
          ? null
          : await readInitializationMarker(env, location, policy);
        const markerAttemptMs = Date.parse(marker?.lastAttemptAt ?? '');
        const initialization = marker
          && Number.isFinite(markerAttemptMs)
          && markerAttemptMs + marker.retryAfterSeconds * 1000 > Date.now()
          ? marker
          : null;
        const warningCount = Array.isArray(current?.warnings) ? current.warnings.length : undefined;
        const activeWarning = current?.warnings?.[0];
        const warningsSummary = activeWarning
          ? `${activeWarning.event}${activeWarning.severity ? ` (${activeWarning.severity})` : ''}`
          : undefined;

        return {
          id: location.id,
          areaName: location.areaName,
          hasCache: Boolean(current),
          exactGenerationReady: Boolean(current),
          availabilitySource: current ? 'generation' : 'none',
          fetchedAt: current?.sources.fetchedAt,
          cacheHealth: current?.sources.cacheHealth,
          warningCount,
          warningsSummary,
          ...(initialization ? { initialization } : {}),
        };
      }),
    );
  } catch (error) {
    console.error(JSON.stringify({
      event: 'forecast_storage_read_failed',
      error: error instanceof Error
        ? { name: error.name, message: error.message }
        : { message: String(error) },
    }));
    storageUnavailable = true;
    entries = FORECAST_LOCATIONS.map((location) => ({
      id: location.id,
      areaName: location.areaName,
      hasCache: false,
      exactGenerationReady: false,
      availabilitySource: 'none',
    }));
  }
  return buildHealthPayload(entries, storageUnavailable, Date.now(), await heartbeatRead);
}

async function handleHealthRequest(env: Env): Promise<Response> {
  return healthResponse(await loadHealthPayload(env));
}

async function handleStatusRequest(env: Env): Promise<Response> {
  return statusResponse(await loadHealthPayload(env));
}

function isWarmQueryRequested(url: URL): boolean {
  const value = url.searchParams.get('warm');
  return value === '1' || value === 'true';
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const finalize = (response: Response): Response => withReleaseHeaders(
      withWorkerVersion(
        request.method === 'HEAD' ? headResponse(response) : response,
        env.CF_VERSION_METADATA.id,
      ),
      { release: CURRENT_RELEASE },
    );

    try {
      // Request-scoped only: never retain I/O promises in module state across
      // Cloudflare events.
      const eventMemo: EventMemo = new Map();
      const url = new URL(request.url);
      const apiRoute = versionedForecastRoute(url.pathname);
      const route = apiRoute
        ? { kind: 'forecast' as const, locationId: apiRoute.locationId }
        : matchRoute(url.pathname);

      if (!route) {
        const response = jsonResponse({ error: 'Not found' }, 404);
        return finalize(response);
      }

      // Candidate preparation is an operational capability, not a public API.
      // Authenticate before method handling and before forecast/init KV reads,
      // so every invalid warm probe is indistinguishable from an unknown route
      // and can never reach a provider-building branch.
      if (route.kind === 'forecast'
        && isWarmQueryRequested(url)
        && !await hasValidWarmAuthorization(request, env.FRANK_WARM_TOKEN)) {
        return finalize(jsonResponse({ error: 'Not found' }, 404));
      }

      if (request.method === 'OPTIONS') {
        return finalize(optionsResponse());
      }

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return finalize(methodNotAllowedResponse());
      }

      let response: Response;

      if (route.kind === 'root') {
        response = jsonResponse({
          ok: true,
          service: 'frank-forecast',
          release: RELEASE_IDENTITY,
          endpoints: [
            ...FORECAST_LOCATIONS.flatMap((location) =>
              supportedForecastApiPaths(location.id)),
            '/health',
            '/status',
          ],
        });
      } else if (route.kind === 'health') {
        response = await handleHealthRequest(env);
      } else if (route.kind === 'status') {
        response = await handleStatusRequest(env);
      } else {
        // Temporary bootstrap alias: the unversioned route serves the exact
        // current contract without re-stamping it. New clients use /api/vN;
        // removing this alias later changes no storage or release semantics.
        response = await handleForecastRequest(
          request,
          env,
          ctx,
          route.locationId,
          eventMemo,
          Boolean(apiRoute),
        );
      }

      return finalize(response);
    } catch (error) {
      // Reachable only because the handlers above are AWAITED. Returning their
      // promises un-awaited let a rejection escape this try entirely, so a
      // failure surfaced as an opaque 5xx with no CORS headers and no log line.
      console.error('Worker request failed:', error);
      const response = jsonResponse({
        error: 'Forecast service failed',
        message: 'An internal error occurred while fetching or processing forecast data.',
      }, 503);
      return finalize(response);
    }
  },

  async scheduled(event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    // Nobody is waiting on a cron tick, so it can afford to wait out a slow
    // provider rather than call it broken (see CRON_FETCH_TIMEOUT_MS).
    const tickStartedAt = Date.now();
    const tickDeadlineAt = tickStartedAt + CRON_TICK_BUDGET_MS;
    const eventMemo: EventMemo = new Map();
    const attemptedAt: Record<string, string> = {};
    try {
      // Isolate failures per location: a rebuild throw (no cached payload + a
      // provider outage) must not starve the remaining locations of their cron
      // refresh for the whole tick.
      const orderedLocations = tickOrder(event?.scheduledTime);
      for (const [index, location] of orderedLocations.entries()) {
        // ...and neither must a location that merely takes a very long time.
        // The per-location try/catch below isolates THROWS, not the shared
        // wall clock, so one hanging upstream could consume the tick and leave
        // the last locations silently unrefreshed every time.
        const locationsRemaining = orderedLocations.length - index;
        const policy = cronExecutionPolicy(Date.now(), tickDeadlineAt, locationsRemaining);
        if (!policy) {
          console.error(`Cron tick deadline reached; skipping ${location.id} until the next tick`);
          break;
        }
        try {
          const refreshed = await refreshForecastCache(env, location, {
            reason: 'cron',
            minIntervalMs: CRON_CHECK_MIN_INTERVAL_MS,
            executionPolicy: policy,
            eventMemo,
          });
          // Copy the stamp the refresh itself decided on rather than clocking
          // the loop. Reaching a city is not the same as contacting a provider:
          // a recent-check short-circuit and the marine retry-backoff window
          // both deliberately preserve the older attempt time, and clocking the
          // loop here would overwrite exactly the pauses they encode. This
          // keeps the heartbeat a cheaper carrier of the payload's own fact
          // instead of a second, looser fact that quietly outranks it.
          const attempt = refreshed.sources.cacheHealth?.lastAttemptAt;
          if (attempt) attemptedAt[location.id] = attempt;
        } catch (error) {
          console.error(`Cron refresh failed for ${location.id}:`, error);
        }
      }
    } finally {
      // Bounded, and deliberately outside the tick budget the loop just spent:
      // this is the record that the tick happened at all, so it must still get
      // a bounded chance to land when the loop ran long. Unbounded, a KV stall
      // here would let the runtime kill the invocation and lose the heartbeat
      // exactly when the system is under stress and liveness matters most.
      await writeCronHeartbeat(env, attemptedAt, {
        deadlineAt: Date.now() + HEARTBEAT_WRITE_BUDGET_MS,
        maxAttempts: 1,
      });
      console.log(`cron tick done in ${Date.now() - tickStartedAt}ms`);
    }
  },
} satisfies ExportedHandler<Env>;

export default worker;
