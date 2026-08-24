import locationData from '../src/config/locations.json';
import type { ForecastLocation } from '../src/config/locationTypes';
import {
  CURRENT_RELEASE,
  supportedForecastApiPaths,
} from '../src/features/forecast/releaseContract';
import type { ReleaseMetadata } from '../src/features/forecast/releaseContract';
import { reviveReadings } from '../src/features/forecast/normalize';
import { isValidForecastPayload } from '../src/features/forecast/validatePayload';
import { FORECAST_SERVER_CLOCK_LEAD_TOLERANCE_MS } from '../src/features/forecast/temporalPolicy';
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
  HEALTH_MAX_CHECK_AGE_MS,
  buildHealthPayload,
  healthResponse,
  statusResponse,
} from './health';
import {
  CRON_PERIOD_MS,
  CRON_TICK_BUDGET_MS,
  DEFAULT_FETCH_TIMEOUT_MS as FETCH_TIMEOUT_MS,
  assertBeforeDeadline,
  awaitWithinDeadline,
  cronExecutionPolicy,
  executionPolicy,
  isExecutionDeadlineError,
  remainingExecutionMs,
  remainingProviderMs,
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
  MarineKind,
  ProviderContactEvidence,
  RefreshOptions,
  WorkerCacheHealth,
} from './domain';
import {
  withCacheHealth,
} from './cacheHealth';
import {
  isProviderUnavailableError,
} from './providerAvailability';
import {
  buildForecastCache,
  degradedMarineSourcesAfterProbe,
  degradedSourcesAfterProbe,
  deriveMarineSeedsFromPayload,
  fetchLatestInstanceForCollections,
  fetchLatestMarineInstances,
  fetchMarineSeriesWithFallback,
  isMarineRunWithinFallbackAge,
  marineProbeDecision,
  marineSourcesDueForProbe,
  marineInstancesEqual,
  marineInstancesWithinFallbackAge,
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
import { putKvWithLog } from './kvWriteLogging';
import type { KvWriteCategory } from './kvWriteLogging';

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
//   CRON has one bounded city slot and nobody waiting -> be patient.
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
// A candidate warm request must finish before the caller's 30-second HTTP
// budget. The six-second margin covers persistence, structured logging, and
// returning the response before the caller aborts.
const CANDIDATE_BUILD_EXECUTION_BUDGET_MS = 24_000;
// Provider work stops before the event wall so cache-health assembly and the
// final KV write still have a deterministic chance to finish.
const CANDIDATE_COMPLETION_RESERVE_MS = 4_000;

const INITIALIZATION_PAYLOAD_SCHEMA_VERSION = 1;
const INITIALIZATION_RETRY_SECONDS = 10 * 60;
// Candidate warming is one authenticated, serial deploy caller rather than an
// unbounded browser crowd. Ninety seconds gives every city six complete tries
// inside the 13-minute gate even when each request consumes its full 30-second
// caller allowance, without removing the provider cooldown entirely.
const DEPLOYMENT_WARM_INITIALIZATION_RETRY_SECONDS = 90;
// KV requires expirationTtl >= 60 seconds. A little extra lifetime lets a
// caller calculate the remaining retry delay even if it arrives near the
// boundary; the marker itself stops gating at retryAfterSeconds.
const INITIALIZATION_MARKER_TTL_SECONDS = INITIALIZATION_RETRY_SECONDS + 60;

const CRON_CHECK_MIN_INTERVAL_MS = 2 * 60 * 1000;
const CHECKED_STAMP_MIN_WRITE_INTERVAL_MS = 25 * 60 * 1000;

// Proof that the cron is still firing, and which city each persisted sample
// actually got to. Stamping "we checked" into every city's forecast payload
// would be one KV write per city per tick. Against a 1,000-write day, that is
// what forced the coarse CHECKED_STAMP_MIN_WRITE_INTERVAL_MS throttle and a "checked"
// time that could be 25 minutes behind the truth. One shared object targeting a
// write about every five scheduled minutes keeps the liveness evidence
// affordable even when the scheduler itself fires every minute.
const CRON_HEARTBEAT_SCHEMA_VERSION = 2;
export const CRON_HEARTBEAT_THROTTLE_TICKS = 5;
// Enough for a read and a write of one small object; short enough that a KV
// brownout cannot hold the invocation open past the runtime's patience.
const HEARTBEAT_WRITE_BUDGET_MS = 3_000;
export const CRON_HEARTBEAT_KEY = 'frank:system:cron-heartbeat';

type CronOutcome = NonNullable<RefreshOptions['cronOutcome']>;

function logCronTickCompleted(record: {
  locationId: string | null;
  scheduledAt: string;
  durationMs: number;
  probeDecisionReason: NonNullable<CronOutcome['probeDecisionReason']> | null;
  canSkipProbe: boolean | null;
  outcome: CronOutcome['status'] | 'deadline-skipped';
  subrequestCount: number;
  providerDeadlineReached: boolean;
}): void {
  // The completion record is diagnostic only: a logging failure must not turn
  // a completed refresh or heartbeat into a failed scheduled invocation.
  try {
    console.log(JSON.stringify({
      event: 'cron_tick_completed',
      ...record,
    }));
  } catch {
    // Best-effort observability only.
  }
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b !== 0) {
    [a, b] = [b, a % b];
  }
  return a;
}

export function assertHeartbeatThrottleCoprime(
  throttleTicks: number,
  cityCount: number,
): void {
  if (!Number.isInteger(throttleTicks)
    || throttleTicks <= 0
    || !Number.isInteger(cityCount)
    || cityCount <= 0
    || greatestCommonDivisor(throttleTicks, cityCount) !== 1) {
    throw new Error(
      `Cron heartbeat throttle (${throttleTicks} ticks) must be coprime with the location count (${cityCount}).`,
    );
  }
}

assertHeartbeatThrottleCoprime(CRON_HEARTBEAT_THROTTLE_TICKS, FORECAST_LOCATIONS.length);

const KNOWN_FORECAST_LOCATION_IDS = new Set(
  FORECAST_LOCATIONS.map((location) => location.id),
);

function isHeartbeatLocationMap(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.entries(value).every(([id, stamp]) =>
    KNOWN_FORECAST_LOCATION_IDS.has(id)
    && typeof stamp === 'string'
    && Number.isFinite(Date.parse(stamp)));
}

export function isCronHeartbeat(value: unknown): value is CronHeartbeat {
  return isRecord(value)
    && value.schemaVersion === CRON_HEARTBEAT_SCHEMA_VERSION
    && typeof value.lastTickAt === 'string'
    && Number.isFinite(Date.parse(value.lastTickAt))
    && isHeartbeatLocationMap(value.locations)
    && isHeartbeatLocationMap(value.unreachable);
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
// for a fraction of the normal heartbeat write interval removes nearly all of
// it. Healthy state changes about every five minutes; anomaly and recovery
// writes can change it sooner. The memo holds a timestamp and a plain object,
// never a request or an in-flight promise.
const HEARTBEAT_MEMO_TTL_MS = 30_000;
let heartbeatMemo: { at: number; value: CronHeartbeat | null } | null = null;

async function readCronHeartbeat(
  env: Env,
  policyInput?: ExecutionPolicyInput,
  nowMs = Date.now(),
): Promise<CronHeartbeat | null> {
  if (heartbeatMemo && isHeartbeatMemoFresh(heartbeatMemo.at, nowMs)) {
    return heartbeatMemo.value;
  }
  const value = await fetchCronHeartbeat(env, policyInput);
  heartbeatMemo = { at: nowMs, value };
  return value;
}

export function isHeartbeatMemoFresh(memoAtMs: number, nowMs: number): boolean {
  const ageMs = nowMs - memoAtMs;
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs < HEARTBEAT_MEMO_TTL_MS;
}

type HeartbeatAttempt =
  | { locationId: string; status: 'healthy-no-probe' }
  | { locationId: string; status: 'contacted' | 'unreachable'; attemptedAt: string };

type HeartbeatWriteScope =
  | { kind: 'scheduled'; tickAtMs: number }
  | { kind: 'contact-only' };

async function writeHeartbeat(
  env: Env,
  scope: HeartbeatWriteScope,
  attempt: HeartbeatAttempt | null,
  policyInput?: ExecutionPolicyInput,
): Promise<void> {
  // Candidate warming may publish true positive contact evidence, but it may
  // not turn a candidate-only failure into a production "not checking" alarm.
  // The outcome is still classified unreachable by the shared refresh path;
  // only scheduled ticks are allowed to persist that negative evidence.
  if (scope.kind === 'contact-only' && attempt?.status !== 'contacted') return;

  try {
    // Deliberately unmemoised. This merge is the only thing preserving the
    // stamps of cities this operation did not reach, so it has to read what is
    // actually stored, not what this isolate happened to serve a moment ago.
    const previous = await fetchCronHeartbeat(env, policyInput);
    const previousTickMs = Date.parse(previous?.lastTickAt ?? '');
    if (scope.kind === 'scheduled' && !Number.isFinite(scope.tickAtMs)) {
      throw new Error('Cron heartbeat tick time is invalid.');
    }
    // A warm must never invent scheduler liveness. Until a real scheduled tick
    // has created the heartbeat, there is no lastTickAt value it can preserve.
    if (scope.kind === 'contact-only' && !Number.isFinite(previousTickMs)) return;
    // This read/compare prevents a late older invocation from overwriting a
    // newer value visible at this edge. Workers KV is eventually consistent,
    // so this is deliberately not described as an atomic global compare-and-set.
    if (scope.kind === 'scheduled'
      && Number.isFinite(previousTickMs)
      && scope.tickAtMs < previousTickMs) {
      return;
    }

    const previousSuccessMs = Date.parse(
      attempt ? previous?.locations[attempt.locationId] ?? '' : '',
    );
    const previousFailureMs = Date.parse(
      attempt ? previous?.unreachable[attempt.locationId] ?? '' : '',
    );
    const attemptAtMs = Date.parse(
      attempt && attempt.status !== 'healthy-no-probe' ? attempt.attemptedAt : '',
    );
    if (attempt && attempt.status !== 'healthy-no-probe' && !Number.isFinite(attemptAtMs)) {
      throw new Error(`Cron heartbeat attempt time is invalid for ${attempt.locationId}.`);
    }
    if (scope.kind === 'scheduled' && scope.tickAtMs === previousTickMs) {
      // Equal-tick failures must still be mergeable so a concurrent success
      // cannot hide them. A duplicate outcome is free to skip, and an equal
      // success never outranks an already-recorded failure.
      const outcomeAlreadyStored = attempt?.status === 'contacted'
        ? previousSuccessMs >= attemptAtMs
        : attempt?.status === 'unreachable'
          ? previousFailureMs >= attemptAtMs
          : true;
      if (!attempt
        || outcomeAlreadyStored
        || (attempt.status === 'contacted' && previousFailureMs >= scope.tickAtMs)) {
        return;
      }
    }
    const hasActiveUnreachable = Number.isFinite(previousFailureMs)
      && (!Number.isFinite(previousSuccessMs) || previousFailureMs >= previousSuccessMs);
    const newlyUnreachable = attempt?.status === 'unreachable'
      && !hasActiveUnreachable;
    const recovering = attempt?.status === 'contacted'
      && hasActiveUnreachable
      && (scope.kind === 'scheduled' || attemptAtMs > previousFailureMs);
    const firstRecordedContact = attempt?.status === 'contacted'
      && !Number.isFinite(previousSuccessMs);
    // A city contacts providers roughly every MET TTL (~30 min), but the
    // throttle below only lets the heartbeat write every fifth tick. At a
    // one-minute cron that discards about four in five contacts, and the city's
    // stamp drifts past HEALTH_MAX_CHECK_AGE_MS while it is demonstrably
    // healthy - a false "not checking" alarm (observed in production
    // 2026-08-24: forecasts rebuilding every 30 min, check age reported 62 min).
    //
    // This was latent until the cron trigger was corrected to one minute. At
    // the previous five-minute cadence elapsedTicks computed to exactly the
    // throttle every tick, so the heartbeat wrote every time and no contact was
    // ever dropped.
    //
    // Forcing at half the alarm threshold guarantees a contacted city can never
    // cross it, and bounds the extra writes to one per city per 30 minutes.
    const contactStampDrifting = attempt?.status === 'contacted'
      && Number.isFinite(previousSuccessMs)
      && attemptAtMs - previousSuccessMs >= HEALTH_MAX_CHECK_AGE_MS / 2;
    const heartbeatCategory: KvWriteCategory = newlyUnreachable || recovering
      ? 'heartbeat-anomaly'
      : 'heartbeat-cadence';
    const forceWrite = Boolean(
      newlyUnreachable || recovering || firstRecordedContact || contactStampDrifting,
    );
    // Scheduled cadence is global, while a warm has no tick of its own. Using
    // lastTickAt for a warm would suppress the exact repair this path exists
    // for whenever cron is alive but one city's contact stamp is old.
    const previousOutcomeMs = Math.max(
      Number.isFinite(previousSuccessMs) ? previousSuccessMs : Number.NEGATIVE_INFINITY,
      Number.isFinite(previousFailureMs) ? previousFailureMs : Number.NEGATIVE_INFINITY,
    );
    const cadenceAnchorMs = scope.kind === 'scheduled'
      ? previousTickMs
      : previousOutcomeMs;
    const observedAtMs = scope.kind === 'scheduled' ? scope.tickAtMs : attemptAtMs;
    const elapsedTicks = Number.isFinite(cadenceAnchorMs)
      ? Math.floor((observedAtMs - cadenceAnchorMs) / CRON_PERIOD_MS)
      : Number.POSITIVE_INFINITY;
    if (!forceWrite && elapsedTicks < CRON_HEARTBEAT_THROTTLE_TICKS) {
      // Skipped healthy samples are intentionally not accumulated in module
      // scope: isolates are neither shared nor durable.
      return;
    }

    const locations = { ...previous?.locations };
    const unreachable = { ...previous?.unreachable };
    const lastTickAt = scope.kind === 'scheduled'
      ? new Date(scope.tickAtMs).toISOString()
      : previous!.lastTickAt;
    if (attempt) {
      if (!KNOWN_FORECAST_LOCATION_IDS.has(attempt.locationId)) {
        throw new Error(`Unknown heartbeat location: ${attempt.locationId}`);
      }
      if (attempt.status === 'contacted'
        && (!Number.isFinite(previousSuccessMs) || attemptAtMs > previousSuccessMs)) {
        locations[attempt.locationId] = new Date(attemptAtMs).toISOString();
      } else if (attempt.status === 'unreachable'
        && (!Number.isFinite(previousFailureMs) || attemptAtMs > previousFailureMs)) {
        unreachable[attempt.locationId] = new Date(attemptAtMs).toISOString();
      }
    }
    const heartbeat: CronHeartbeat = {
      schemaVersion: CRON_HEARTBEAT_SCHEMA_VERSION,
      lastTickAt,
      locations,
      unreachable,
    };
    await awaitWithinDeadline(
      () => putKvWithLog(
        env.FRANK_FORECAST_CACHE,
        CRON_HEARTBEAT_KEY,
        JSON.stringify(heartbeat),
        heartbeatCategory,
      ),
      executionPolicy(policyInput),
      'cron heartbeat write',
    );
    heartbeatMemo = { at: Date.now(), value: heartbeat };
  } catch (error) {
    console.error('Cron heartbeat write failed:', error);
  }
}

// A city's own payload is only rewritten when something about it changed, so
// its "we checked" stamp lags by design. A healthy city may inherit the shared
// lastTickAt; a city with no successful record or a newer unsuccessful record
// keeps its own older stamp so app-wide liveness cannot hide local failure.
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
  const successfulAt = heartbeat?.locations?.[locationId];
  const successfulMs = Date.parse(successfulAt ?? '');
  const unsuccessfulAt = heartbeat?.unreachable?.[locationId];
  const unsuccessfulMs = Date.parse(unsuccessfulAt ?? '');
  const heartbeatTickMs = Date.parse(heartbeat?.lastTickAt ?? '');
  const hasUsableSuccess = Number.isFinite(successfulMs) && successfulMs <= nowMs;
  // Equality fails closed: same-tick/concurrent records must not allow a global
  // success claim to outrank an equally recent failure.
  const hasActiveFailure = Number.isFinite(unsuccessfulMs)
    && (unsuccessfulMs > nowMs || !hasUsableSuccess || unsuccessfulMs >= successfulMs);
  const mayUseGlobalTick = hasUsableSuccess
    && !hasActiveFailure
    && Number.isFinite(heartbeatTickMs)
    && heartbeatTickMs >= successfulMs
    && heartbeatTickMs <= nowMs;

  if (!cacheHealth || !hasUsableSuccess || !successfulAt) {
    return data;
  }

  if (hasActiveFailure) {
    // An unsuccessful tick is newer than the last successful city contact.
    // Pin the displayed check to that older success even if a failure-state
    // payload happened to stamp its own attempted-at time more recently.
    return {
      ...data,
      sources: {
        ...data.sources,
        cacheHealth: { ...cacheHealth, lastAttemptAt: successfulAt },
      },
    };
  }

  const effectiveAttemptAt = mayUseGlobalTick
    ? new Date(heartbeatTickMs).toISOString()
    : successfulAt;
  const effectiveAttemptMs = mayUseGlobalTick ? heartbeatTickMs : successfulMs;

  if (Date.parse(cacheHealth.lastAttemptAt) >= effectiveAttemptMs) {
    return data;
  }

  return {
    ...data,
    sources: {
      ...data.sources,
      cacheHealth: { ...cacheHealth, lastAttemptAt: effectiveAttemptAt },
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
    && isValidForecastPayload(value, location, {
      requireReleaseMetadata: true,
      sourceClockLeadToleranceMs: FORECAST_SERVER_CLOCK_LEAD_TOLERANCE_MS,
    })
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
  category: Extract<KvWriteCategory, 'assembled-forecast' | 'failure-state'>,
  policyInput?: ExecutionPolicyInput,
): Promise<void> {
  const policy = executionPolicy(policyInput);
  await awaitWithinDeadline(
    () => putKvWithLog(
      env.FRANK_FORECAST_CACHE,
      cacheKey(location),
      JSON.stringify(data),
      category,
      location.id,
    ),
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

  // An unreadable marker means "no marker", not "storage is broken". Throwing
  // here escaped the Promise.all in loadHealthPayload and set storageUnavailable
  // for the WHOLE payload, so one bad record reported all four cities as
  // cacheless and ok:false - a paging-grade alarm for three perfectly cached
  // fjords. On the forecast route the same throw reached the generic 503, so
  // the client lost the FORECAST_INITIALIZING contract and its retry hint.
  //
  // isInitializationMarker also rejects any lastAttemptAt in the future, which a
  // PoP whose clock is milliseconds ahead can produce, so this is reachable
  // without anything actually being wrong.
  //
  // The marker only says how long to wait before retrying. Treating a bad one
  // as absent costs at most an earlier retry; it can never surface wrong data.
  // Still logged loudly, because a genuine contract break is worth seeing.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.error(JSON.stringify({
      event: 'initialization_marker_unparseable',
      locationId: location.id,
      error: error instanceof Error ? error.message : String(error),
    }));
    return null;
  }
  if (!isInitializationMarker(parsed, location)) {
    console.error(JSON.stringify({
      event: 'initialization_marker_contract_invalid',
      locationId: location.id,
    }));
    return null;
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
    () => putKvWithLog(
      env.FRANK_FORECAST_CACHE,
      initializationKey(location),
      JSON.stringify(marker),
      'initialization-marker',
      location.id,
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
  retryCooldownSeconds: number,
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
  const remainingMs = retryCooldownSeconds * 1000 - Math.max(0, nowMs - latestAttemptMs);
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

// How alarming a health block is, so a write can be priced by DIRECTION rather
// than mere difference. Compare dimensions lexicographically: a status
// degradation must not be cancelled out by fewer secondary flags, which the
// old scalar sum allowed (`current + 3 flags` tied/beat plain `stale`).
function healthSeverity(
  health: Partial<WorkerCacheHealth> | null | undefined,
): readonly number[] {
  if (!health) return [0, 0, 0, 0];
  const status = health.status === 'stale'
    ? 4
    : health.status === 'fallback'
      ? 3
      : health.status === 'pending'
        ? 2
        : 1;
  return [
    status,
    health.needsRebuild ? 1 : 0,
    health.degradedSources?.length ?? 0,
    health.providerBusy ? 1 : 0,
  ];
}

function compareHealthSeverity(
  left: readonly number[],
  right: readonly number[],
): number {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function shouldPersistFailureState(
  prev: Partial<WorkerCacheHealth> | null | undefined,
  next: Partial<WorkerCacheHealth> | null | undefined,
  nowMs = Date.now(),
): boolean {
  // Getting WORSE is news, and it is the direction that protects the paddler,
  // so it is never throttled.
  if (compareHealthSeverity(healthSeverity(next), healthSeverity(prev)) > 0) return true;

  // Marine run ids are provenance, not severity: later ticks compare against
  // them to decide whether to re-probe DMI, so a throttled copy would make a
  // matching run look changed. DMI publishes about every six hours, so this
  // cannot flap and costs nothing to keep exact.
  if (!marineInstancesEqual(prev?.marineInstances, next?.marineInstances)) return true;

  // Everything else - recovery, a sideways change, an identical repeat - waits
  // for the throttle. Treating every transition as urgent looked right until
  // you price a provider that alternates 429/200 tick to tick, which DMI
  // documents doing under load: stale, current, stale writes on EVERY selected
  // turn, 360 a day per city and 1,440 across four cities against a 1,000/day
  // allowance. The first casualty
  // is not the status flag - it is that KV put starts throwing, the rebuild
  // write is swallowed, and the app serves a frozen forecast still labelled
  // "current".
  //
  // Throttling only the improving direction is also the safer semantics: a
  // premature all-clear is the dangerous one; a late all-clear is not.
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
  if (options.cronOutcome) {
    options.cronOutcome.status = 'unreachable';
    delete options.cronOutcome.attemptedAt;
    delete options.cronOutcome.probeDecisionReason;
    delete options.cronOutcome.canSkipProbe;
  }
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
    if (options.cronOutcome) {
      options.cronOutcome.status = 'healthy-no-probe';
      options.cronOutcome.probeDecisionReason = 'recent-check';
    }
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

  // Past the gate: begin the upstream policy decision. A publication window or
  // retry-backoff may still decline a network probe; otherwise provider work
  // starts here. Setting this in the refreshForecastCache wrapper instead —
  // BEFORE the gate above reads it — made the gate see "checked 0 ms ago" on
  // every call and short-circuit forever: each selected cron turn became a
  // no-op and nothing rebuilt for as long as the isolate lived.
  lastCheckAt.set(cacheKey(location), Date.now());

  let latestMarine: MarineInstances | undefined;
  const contactEvidence: ProviderContactEvidence = { providerContacted: false };
  const markCronContacted = (attemptedAt?: string): void => {
    if (!contactEvidence.providerContacted || !options.cronOutcome) return;
    options.cronOutcome.status = 'contacted';
    options.cronOutcome.attemptedAt = typeof attemptedAt === 'string'
      && Number.isFinite(Date.parse(attemptedAt))
      ? attemptedAt
      : new Date().toISOString();
  };

  try {
    const cachedHealth = cached?.sources?.cacheHealth;

    // Weather freshness comes from MET's own Expires header stored on the run we
    // built against; only marine ids need a probe here. If the probe itself is
    // down, keep the previously assembled forecast and mark its marine inputs
    // degraded rather than re-dating unverified water/wave data.
    let marineProbeFailed = false;
    let marineSubstituted: readonly MarineKind[] = [];
    let marineManifestResolved: readonly MarineKind[] = [];
    let marineProbeBusy = false;
    let marineCatalogueContacted = false;
    const knownMarine = cachedHealth?.marineInstances
      ?? await readRetainedMarineInstances(env, location, policy);
    // DMI's official completion windows determine when a newer marine run can
    // actually exist. A short post-due backoff stops a late publication from
    // being queried on every cron tick. Forced/recovery work and provenance
    // outside the 12-hour safety policy always bypass the schedule.
    const knownMarineWithinPolicy = marineInstancesWithinFallbackAge(knownMarine);
    const probeDecisionAt = Date.now();
    const previousMarineFailed = (cachedHealth?.degradedSources ?? [])
      .some((source) => source === 'water' || source === 'waves');
    const probeDecision = marineProbeDecision(
      knownMarine,
      cachedHealth?.lastAttemptAt,
      probeDecisionAt,
      previousMarineFailed,
    );
    const canSkipProbe = Boolean(knownMarine?.water?.id && knownMarine?.waves?.id)
      && !options.force
      && !options.forceRebuild
      && !cachedNeedsRecovery
      && knownMarineWithinPolicy
      && !probeDecision.shouldProbe;
    if (options.cronOutcome) {
      options.cronOutcome.probeDecisionReason = probeDecision.reason;
      options.cronOutcome.canSkipProbe = canSkipProbe;
    }

    if (canSkipProbe) {
      latestMarine = knownMarine;
    } else {
      // A DMI 429 is provider-wide rather than specific to the fjord that
      // received it. providerTransport opens an event-local circuit on the
      // first refusal: the two already-parallel water/wave calls may finish,
      // but retries and later marine stages fall back without calling DMI again.
      try {
        const probe = await fetchLatestMarineInstances(
          location,
          policy,
          options.eventMemo,
          knownMarine,
          probeDecision.shouldProbe ? env.FRANK_FORECAST_CACHE : undefined,
          contactEvidence,
        );
        latestMarine = probe.instances;
        marineCatalogueContacted = probe.catalogueContacted;
        marineManifestResolved = probe.manifestResolved;
        // A carried-over run id is not a verified one. Reporting it as a clean
        // probe let a DMI catalogue outage read as a fully current forecast for
        // as long as the ids stayed within their fallback age.
        marineSubstituted = probe.substituted;
        if (probe.substituted.length > 0) {
          console.warn(JSON.stringify({
            event: 'marine_instance_substituted',
            locationId: location.id,
            substituted: probe.substituted,
          }));
        }
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

    const degradedMarineProbeSources = degradedMarineSourcesAfterProbe(
      knownMarine,
      marineProbeFailed,
      marineSubstituted,
      probeDecisionAt,
    );
    const dueMarineSources = marineSourcesDueForProbe(knownMarine, probeDecisionAt);
    const marineManifestVerified = !marineCatalogueContacted
      && dueMarineSources.length > 0
      && dueMarineSources.every((kind) => marineManifestResolved.includes(kind));

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
        degradedSources: degradedSourcesAfterProbe(
          (cachedHealth?.degradedSources ?? [])
            .filter((source) => source !== 'water' && source !== 'waves'),
          false,
          degradedMarineProbeSources,
        ),
        ...(marineProbeBusy ? { providerBusy: true, busyProvider: 'marine' } : {}),
        message: marineProbeBusy
          ? 'Marine service busy; keeping the last completed forecast.'
          : 'Marine service unavailable; keeping the last completed forecast.',
      });
      if (shouldPersistFailureState(cachedHealth, heldCache.sources.cacheHealth)) {
        try {
          await writeCachedForecast(env, location, heldCache, 'failure-state', policy);
        } catch (writeError) {
          console.error(`Could not persist marine probe failure for ${location.id}:`, writeError);
        }
      }
      markCronContacted(heldCache.sources.cacheHealth?.lastAttemptAt);
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
      //
      // Marine flags are recomputed from THIS tick rather than carried forward.
      // Carrying them meant a 429 on one tick left "marine service unavailable"
      // on the payload until MET's Expires happened to force a rebuild, long
      // after DMI had recovered.
      //
      // A verified probe means these ids are the newest DMI has, which is not
      // degraded even when the run itself is hours old - DMI publishes about
      // every six hours. A substituted id is degraded only when that source's
      // own collection schedule says a newer run is due; a sibling's different
      // run id is not evidence about this source.
      // Non-marine degradation is untouched; only marine is ours to judge here.
      const nonMarineDegraded = (cachedHealth?.degradedSources ?? [])
        .filter((source) => source !== 'water' && source !== 'waves');
      const degradedNow = degradedSourcesAfterProbe(
        nonMarineDegraded,
        false,
        degradedMarineProbeSources,
      );
      const marineVerified = degradedMarineProbeSources.length === 0;

      const checkedCache = withCacheHealth(cached, 'current', {
        marineInstances: latestMarine,
        // Neither a normal publication-window skip, retry-backoff, nor a
        // manifest-only verification contacted a provider in this invocation.
        // Preserve the actual contact stamp; in the backoff case, restamping
        // would also slide that window forward indefinitely.
        preserveAttemptAt: canSkipProbe || marineManifestVerified,
        checkedBy: options.reason ?? 'check',
        degradedSources: degradedNow.length > 0 ? degradedNow : undefined,
        providerBusy: marineVerified ? undefined : cachedHealth?.providerBusy,
        busyProvider: marineVerified ? undefined : cachedHealth?.busyProvider,
        message: marineVerified ? undefined : cachedHealth?.message,
      });
      // The heartbeat now carries eligible scheduled-check freshness in one object,
      // so re-writing this whole forecast just to advance a timestamp is pure
      // cost: it was ~57 writes/city/day against an allowance of 1,000, and the
      // heartbeat's own 288/day only pays for itself once this stops. What
      // still earns a write is a CHANGE in what the health says.
      if (probeDecision.reason !== 'retry-backoff'
        && healthChanged(cachedHealth, checkedCache.sources.cacheHealth)
        && shouldPersistFailureState(cachedHealth, checkedCache.sources.cacheHealth)) {
        // Best-effort, like the rebuild write below. This is the one path that
        // has already CONFIRMED the forecast is current, so letting a failed
        // write escape would fall into the catch below and rebuild the response
        // as 'stale' with "Forecast refresh failed" - turning a verified-healthy
        // forecast into an outage banner because a KV put was rejected. An
        // exhausted write budget is the realistic cause, and that is exactly
        // when the last thing we should do is start reporting false failures.
        try {
          await writeCachedForecast(env, location, checkedCache, 'failure-state', policy);
        } catch (writeError) {
          console.error(`Could not persist checked forecast for ${location.id}:`, writeError);
        }
      }
      if (options.cronOutcome) {
        markCronContacted(checkedCache.sources.cacheHealth?.lastAttemptAt);
        if (!contactEvidence.providerContacted
          && marineVerified && degradedNow.length === 0 && (
          marineManifestVerified
          || (canSkipProbe && probeDecision.reason === 'publication-window')
        )) {
          // DMI's documented publication window proves there is nothing to ask
          // for yet. A manifest-only result likewise carries another tick's
          // verified global run. Both are healthy without a provider contact,
          // so neither may mutate per-city success or failure history.
          options.cronOutcome.status = 'healthy-no-probe';
        }
        // Retry-backoff and a check with no successful provider result retain
        // the default unreachable outcome. Its first transition persists
        // immediately; unchanged repeats use the shared five-tick throttle.
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
      contactEvidence,
    );
    // The build can succeed on last-good ingredients while a provider is
    // down; the payload is then still the freshest combination obtainable,
    // so it ships as 'current' with the degradation named in the message.
    const degradedSources = degradedSourcesAfterProbe(
      built.degradedSources,
      false,
      degradedMarineProbeSources,
    );
    contactEvidence.providerContacted ||= built.providerContacted;
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
      // the client can show a calm "from an earlier update" note. Busy copy is
      // reserved for a provider boundary that verified an HTTP 429.
      ...(degradedSources.length ? { degradedSources } : {}),
      ...((built.degradedBusy || marineProbeBusy) ? { providerBusy: true } : {}),
      ...(marineProbeBusy
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
      await writeCachedForecast(env, location, fresh, 'assembled-forecast', policy);
    } catch (writeError) {
      console.error(`Could not persist rebuilt forecast for ${location.id}:`, writeError);
    }
    markCronContacted(fresh.sources.cacheHealth?.lastAttemptAt);
    return fresh;
  } catch (error) {
    // A later required leg, assembly check, or persistence operation must not
    // erase a successful provider response already observed in this event.
    markCronContacted();
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
          await writeCachedForecast(env, location, failedCache, 'failure-state', policy);
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
  retryCooldownSeconds: number,
): Promise<number> {
  const memoryRetry = initializationRetrySeconds(location, retryCooldownSeconds);
  if (memoryRetry > 0) return memoryRetry;
  const marker = await readInitializationMarker(env, location, responseKvReadPolicy());
  return initializationRetrySeconds(location, retryCooldownSeconds, marker);
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
  retryCooldownSeconds: number,
): Promise<Response> {
  keepCandidateBuildAlive(ctx, refresh, location, reason);
  try {
    const data = await refresh;
    return preparedForecastResponse(data, true);
  } catch (error) {
    if (isProviderUnavailableError(error)) {
      const retryAfterSeconds = initializationRetrySeconds(location, retryCooldownSeconds);
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
    const retryAfterSeconds = await activeInitializationRetrySeconds(
      env,
      location,
      DEPLOYMENT_WARM_INITIALIZATION_RETRY_SECONDS,
    );
    if (retryAfterSeconds > 0) {
      return forecastInitializingResponse(location, retryAfterSeconds);
    }

    const warmOutcome: NonNullable<RefreshOptions['cronOutcome']> = {
      status: 'unreachable',
    };
    const refresh = refreshForecastCache(env, location, {
      force: true,
      forceRebuild: true,
      reason: 'deployment-warm',
      minIntervalMs: 0,
      executionPolicy: candidateExecutionPolicy(),
      eventMemo,
      cached: null,
      cronOutcome: warmOutcome,
    }).finally(() => {
      const attemptedAt = warmOutcome.attemptedAt;
      const heartbeatAttempt: HeartbeatAttempt | null = warmOutcome.status === 'contacted'
        && typeof attemptedAt === 'string'
        && Number.isFinite(Date.parse(attemptedAt))
        ? { locationId: location.id, status: 'contacted', attemptedAt }
        : null;
      if (!heartbeatAttempt) return;
      ctx.waitUntil(writeHeartbeat(env, { kind: 'contact-only' }, heartbeatAttempt, {
        deadlineAt: Date.now() + HEARTBEAT_WRITE_BUDGET_MS,
        maxAttempts: 1,
      }));
    });
    return candidateWarmResponse(
      ctx,
      location,
      refresh,
      'deployment-warm',
      DEPLOYMENT_WARM_INITIALIZATION_RETRY_SECONDS,
    );
  }

  if (cached) {
    // Browser traffic only reads the last fully prepared snapshot. Cron owns
    // provider refreshes, so 100 simultaneous first visitors stay 100 KV reads
    // instead of becoming 100 upstream initialization attempts.
    return preparedForecastResponse(cached, true);
  }

  const retryAfterSeconds = await activeInitializationRetrySeconds(
    env,
    location,
    INITIALIZATION_RETRY_SECONDS,
  );
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
    const heartbeatTickAt = Number.isFinite(event?.scheduledTime)
      ? event.scheduledTime
      : tickStartedAt;
    const eventMemo: EventMemo = new Map();
    let heartbeatAttempt: HeartbeatAttempt | null = null;
    let scheduledLocationId: string | null = null;
    let scheduledPolicy: ExecutionPolicy | null = null;
    let scheduledOutcome: CronOutcome | null = null;
    let providerDeadlineReached = false;
    try {
      // Workers Free allows only 10 ms active CPU per scheduled invocation;
      // network/KV waits are wall time, but still must not overlap later ticks.
      // Refresh one rotated city per one-minute tick instead of parsing and
      // assembling all four in one event. Every city is selected once per four
      // minutes, inside MET's 30-minute minimum TTL and the 60-minute health
      // threshold.
      // Authenticated deployment warming remains a separate per-location path.
      const scheduledLocations = tickOrder(event?.scheduledTime).slice(0, 1);
      for (const location of scheduledLocations) {
        scheduledLocationId = location.id;
        // Default to unsuccessful before any operation that can throw or run
        // out of budget. Only explicit healthy completion flips this outcome.
        heartbeatAttempt = {
          locationId: location.id,
          status: 'unreachable',
          attemptedAt: new Date(Date.now()).toISOString(),
        };
        const policy = cronExecutionPolicy(Date.now(), tickDeadlineAt, 1);
        scheduledPolicy = policy;
        if (!policy) {
          console.error(`Cron tick deadline reached; skipping ${location.id} until the next tick`);
          break;
        }
        const cronOutcome: NonNullable<RefreshOptions['cronOutcome']> = {
          status: 'unreachable',
        };
        scheduledOutcome = cronOutcome;
        try {
          const refreshed = await refreshForecastCache(env, location, {
            reason: 'cron',
            minIntervalMs: CRON_CHECK_MIN_INTERVAL_MS,
            executionPolicy: policy,
            eventMemo,
            cronOutcome,
          });
          const attemptedAt = cronOutcome.attemptedAt
            ?? refreshed.sources.cacheHealth?.lastAttemptAt;
          heartbeatAttempt = cronOutcome.status === 'contacted'
            && typeof attemptedAt === 'string'
            && Number.isFinite(Date.parse(attemptedAt))
            ? { locationId: location.id, status: 'contacted', attemptedAt }
            : cronOutcome.status === 'healthy-no-probe'
              ? { locationId: location.id, status: 'healthy-no-probe' }
              : {
                  locationId: location.id,
                  status: 'unreachable',
                  attemptedAt: new Date(Date.now()).toISOString(),
                };
        } catch (error) {
          const attemptedAt = cronOutcome.attemptedAt;
          heartbeatAttempt = cronOutcome.status === 'contacted'
            && typeof attemptedAt === 'string'
            && Number.isFinite(Date.parse(attemptedAt))
            ? { locationId: location.id, status: 'contacted', attemptedAt }
            : {
                locationId: location.id,
                status: 'unreachable',
                attemptedAt: new Date(Date.now()).toISOString(),
              };
          console.error(`Cron refresh failed for ${location.id}:`, error);
        }
      }
    } finally {
      // Snapshot at the provider boundary. Heartbeat I/O has its own budget and
      // must not make a healthy provider phase look deadline-bound in the log.
      providerDeadlineReached = scheduledPolicy !== null
        && remainingProviderMs(scheduledPolicy) <= 0;
      // Bounded outside the refresh budget so a due heartbeat still gets a
      // chance to land when provider work runs long. Healthy ticks and repeated
      // failures usually return after the read; failure transitions and
      // recoveries deliberately bypass the five-tick throttle.
      await writeHeartbeat(env, {
        kind: 'scheduled',
        tickAtMs: heartbeatTickAt,
      }, heartbeatAttempt, {
        deadlineAt: Date.now() + HEARTBEAT_WRITE_BUDGET_MS,
        maxAttempts: 1,
      });
      logCronTickCompleted({
        locationId: scheduledLocationId,
        scheduledAt: new Date(heartbeatTickAt).toISOString(),
        durationMs: Date.now() - tickStartedAt,
        probeDecisionReason: scheduledOutcome?.probeDecisionReason ?? null,
        canSkipProbe: scheduledOutcome?.canSkipProbe ?? null,
        outcome: scheduledOutcome?.status ?? 'deadline-skipped',
        subrequestCount: eventMemo.externalSubrequestsStarted ?? 0,
        providerDeadlineReached,
      });
    }
  },
} satisfies ExportedHandler<Env>;

export default worker;
