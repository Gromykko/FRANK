import locationData from '../src/config/locations.json';
import type { ForecastLocation } from '../src/config/locationTypes';
import {
  headResponse,
  jsonResponse,
  matchRoute,
  methodNotAllowedResponse,
  optionsResponse,
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
  CacheHealthOptions,
  CacheHealthStatus,
  EventMemo,
  ForecastData,
  HealthLocationEntry,
  HealthPayload,
  MarineInstances,
  RefreshOptions,
  WorkerCacheHealth,
} from './domain';
import {
  DMI_PROBE_QUIET_MS,
  PAYLOAD_VERSION,
  buildForecastCache,
  classifyBuildFailure,
  degradedSourcesAfterProbe,
  deriveMarineSeedsFromPayload,
  fetchLatestInstanceForCollections,
  fetchLatestMarineInstances,
  fetchMarineSeriesWithFallback,
  isBusyError,
  isMarineRunWithinFallbackAge,
  marineInstancesEqual,
  marineInstancesWithinFallbackAge,
  marineRunAgeMs,
} from './providers';
import { errorMessage, isRecord } from './validation';

// Preserve the small public test/API surface while provider implementation is
// owned by its cohesive module.
export {
  classifyBuildFailure,
  degradedSourcesAfterProbe,
  deriveMarineSeedsFromPayload,
  fetchLatestInstanceForCollections,
  fetchMarineSeriesWithFallback,
  isBusyError,
  isMarineRunWithinFallbackAge,
  marineRunAgeMs,
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
//   A USER request already answers instantly from cache and rebuilds in
//   waitUntil, so a long wait there buys nothing -> be impatient.
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
// waitUntil work started by a browser request must be finished before 25s. The
// one-second margin covers promise cleanup/logging after the final abort.
const USER_BACKGROUND_EXECUTION_BUDGET_MS = 24_000;
// Provider work stops before the event wall so cache-health assembly and the
// final KV write still have a deterministic chance to finish.
const USER_COMPLETION_RESERVE_MS = 4_000;

const MANUAL_CHECK_MIN_INTERVAL_MS = 60 * 1000;
// When the cache is stale, a manual refresh is the user explicitly asking for
// a retry — allow it much sooner than the normal manual gate. 20s still keeps
// spam-taps from hammering the providers.
const STALE_MANUAL_RETRY_MS = 20 * 1000;
// How long after a recorded failure the fast 20s retry above stays available.
// Past this the normal gate applies, so a long outage cannot be turned into a
// sustained 3-checks-per-minute lever by anyone tapping refresh.
const STALE_MANUAL_RETRY_GRACE_MS = 3 * 60 * 1000;
const USER_BACKGROUND_CHECK_MIN_INTERVAL_MS = 10 * 60 * 1000;
const CRON_CHECK_MIN_INTERVAL_MS = 4 * 60 * 1000;
// Re-stamping "we checked, nothing changed" costs a KV WRITE, and the free tier
// allows 1000 a day. The cron (every 10 min x 4 locations = 576 runs) was
// spending well over half the daily budget on that stamp alone, and running out
// of writes stops the forecast updating with no user-visible error. The stamp
// only feeds the "Checked HH:MM" line, so it can be coarsened — but NOT freely.
//
// This stamp is also what the CLIENT uses to decide whether it reached the
// worker at all (CHECK_ASSUMED_UNREACHED_MS in cacheStatusView.ts). Throttling
// it to an hour meant a perfectly healthy forecast served a 40-minute-old stamp
// and the header said "Couldn't refresh · showing older data". The relation has
// to hold, with room for a skipped cron tick:
//
//   this interval + 2 x cron period  <  CHECK_ASSUMED_UNREACHED_MS
//   15 min        + 20 min           <  45 min
//
// Writes only land on cron ticks, so the real ceiling on stamp age is this
// interval rounded up to the next tick. Budget is still comfortable: a rebuild
// resets it, so this is ~2 writes per 40-minute quiet cycle, ~288/day across
// four locations against an allowance of 1000.
const CHECKED_STAMP_MIN_WRITE_INTERVAL_MS = 15 * 60 * 1000;
// ...but `?refresh=1` is unauthenticated, so letting EVERY manual check bypass
// the throttle hands anyone a 1-write-per-minute-per-location lever over the
// same budget (4 locations x 1440 = 5760 writes/day against an allowance of
// 1000). Manual gets its own, shorter throttle instead of a free pass: the
// response already carries this check's real timestamp either way, so the
// button still feels live — only the PERSISTED stamp is coarsened.
const MANUAL_STAMP_MIN_WRITE_INTERVAL_MS = 10 * 60 * 1000;

function cacheKey(location: Pick<ForecastLocation, 'id'>): string {
  return `forecast:${location.id}:weather-data:v1`;
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

function isUsableForecastCache(value: unknown): value is ForecastData {
  if (!isRecord(value) || !isRecord(value.sources)) return false;
  return Boolean(
      Array.isArray(value.hourly) &&
      value.hourly.length > 0 &&
      Array.isArray(value.sunrise) &&
      Array.isArray(value.sunset) &&
      typeof value.sources.fetchedAt === 'string' &&
      // Payloads built by older worker logic are refused outright, forcing a
      // rebuild on the next request/cron instead of being re-blessed as
      // "current" forever.
      value.sources.payloadVersion === PAYLOAD_VERSION
  );
}

function hasCurrentForecastWindow(data: ForecastData): boolean {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  return data.hourly.some((hour) => new Date(hour.time).getTime() >= oneHourAgo);
}

function buildCacheHealth(
  status: CacheHealthStatus,
  data: ForecastData | null | undefined,
  options: CacheHealthOptions = {},
): WorkerCacheHealth {
  const now = new Date();
  const previousHealth = data?.sources?.cacheHealth;
  const marineInstances = options.marineInstances ?? previousHealth?.marineInstances;
  const weatherExpires = options.weatherExpires ?? previousHealth?.weatherExpires;
  const weatherLastModified = options.weatherLastModified ?? previousHealth?.weatherLastModified;
  // Cache health is returned by the public forecast and /health endpoints.
  // Persist only deliberately-authored public copy; raw provider errors belong
  // in logs and can contain unstable or internal response details.
  const message = options.message;

  return {
    status,
    // A gated "recently checked" stamp must NOT advance lastAttemptAt: the
    // cron and background gates compare against it, and sustained page loads
    // inside the manual gate would otherwise starve real provider checks
    // forever.
    lastAttemptAt: options.preserveAttemptAt && previousHealth?.lastAttemptAt
      ? previousHealth.lastAttemptAt
      : now.toISOString(),
    ...(marineInstances ? { marineInstances } : {}),
    ...(weatherExpires ? { weatherExpires } : {}),
    ...(weatherLastModified ? { weatherLastModified } : {}),
    ...(message ? { message } : {}),
    ...(options.needsRebuild ? { needsRebuild: true } : {}),
    ...(options.checkedBy ? { checkedBy: options.checkedBy } : {}),
    ...(options.providerBusy ? { providerBusy: true } : {}),
    ...(options.busyProvider ? { busyProvider: options.busyProvider } : {}),
    ...(options.degradedSources?.length ? { degradedSources: options.degradedSources } : {}),
  };
}

function withCacheHealth(
  data: ForecastData,
  status: CacheHealthStatus,
  options: CacheHealthOptions = {},
): ForecastData {
  return {
    ...data,
    sources: {
      ...data.sources,
      cacheHealth: buildCacheHealth(status, data, options),
    },
  };
}

async function readCachedForecast(
  env: Env,
  location: Pick<ForecastLocation, 'id'>,
  policyInput?: ExecutionPolicyInput,
): Promise<ForecastData | null> {
  const policy = executionPolicy(policyInput);
  const raw = await awaitWithinDeadline(
    () => env.FRANK_FORECAST_CACHE.get(cacheKey(location)),
    policy,
    `forecast cache read for ${location.id}`,
  );
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    return isUsableForecastCache(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function writeCachedForecast(
  env: Env,
  location: Pick<ForecastLocation, 'id'>,
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
// guard: a payload with no stamp yet would otherwise compare NaN and never get one.
export function shouldPersistFailureState(
  prev: Partial<WorkerCacheHealth> | null | undefined,
  next: Partial<WorkerCacheHealth> | null | undefined,
  nowMs = Date.now(),
): boolean {
  const sameFailure =
    prev?.status === next?.status &&
    prev?.message === next?.message &&
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
  location: Pick<ForecastLocation, 'id'>,
  data: { sources?: { cacheHealth?: Pick<WorkerCacheHealth, 'lastAttemptAt'> } } | null | undefined,
  minIntervalMs: number,
  memoryMsOverride?: number,
): boolean {
  const stampMs = new Date(data?.sources?.cacheHealth?.lastAttemptAt ?? 0).getTime();
  const memoryMs = memoryMsOverride ?? lastCheckAt.get(cacheKey(location)) ?? 0;
  // Whichever check was more recent decides — a fresh in-memory check must not
  // be overridden by an older persisted stamp, and vice versa.
  const lastMs = Math.max(Number.isFinite(stampMs) ? stampMs : 0, memoryMs);
  return lastMs === 0 || Date.now() - lastMs > minIntervalMs;
}

async function _refreshForecastCache(
  env: Env,
  location: ForecastLocation,
  options: RefreshOptions = {},
): Promise<ForecastData> {
  const policy = executionPolicy(options.executionPolicy);
  assertBeforeDeadline(policy, `refresh start for ${location.id}`);
  // Browser-triggered background work already read this payload to answer the
  // request. Reusing that event-local value removes a redundant KV operation
  // and guarantees the waitUntil task enters its bounded try/catch immediately.
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

  // A forced (user-initiated) refresh of a stale cache retries after 20s
  // instead of the normal gate — a gated no-op here is what used to make the
  // refresh button feel dead right after a failure.
  //
  // But only while the failure is still NEW. Left open for the whole outage it
  // becomes an unauthenticated 20-second lever on the upstream providers and
  // (before the throttle below) on the KV write budget. Past the grace window
  // a forced tap falls back to the normal 60s gate: the button still answers
  // instantly from cache either way.
  const failedRecently = (() => {
    const stampMs = Date.parse(cached?.sources?.cacheHealth?.lastAttemptAt ?? '');
    if (!Number.isFinite(stampMs)) return false;
    return Date.now() - stampMs < STALE_MANUAL_RETRY_GRACE_MS;
  })();
  const baseIntervalMs = options.minIntervalMs ?? CRON_CHECK_MIN_INTERVAL_MS;
  const minIntervalMs = options.force && cachedNeedsRecovery && failedRecently
    ? Math.min(baseIntervalMs, STALE_MANUAL_RETRY_MS)
    : baseIntervalMs;

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
    const knownMarine = cachedHealth?.marineInstances;
    // Schedule-aware gate: DMI publishes a new marine run only every 6h
    // (measured: run times 00/06/12/18Z, gaps exactly 6.00h), so a newer run
    // cannot exist until 6h after the one we hold. Skip the catalog probe
    // while our run is younger than that floor minus a 1h safety margin;
    // once past it, probe every tick until a new run appears. A forced or
    // rebuild-flagged refresh always probes.
    const knownMarineWithinPolicy = marineInstancesWithinFallbackAge(knownMarine);
    const canSkipProbe = Boolean(knownMarine?.water?.id && knownMarine?.waves?.id)
      && !options.forceRebuild
      && !cachedHealth?.needsRebuild
      && knownMarineWithinPolicy
      && marineRunAgeMs(knownMarine) < DMI_PROBE_QUIET_MS;

    if (canSkipProbe) {
      latestMarine = knownMarine;
    } else {
      try {
        latestMarine = await fetchLatestMarineInstances(location, policy, options.eventMemo);
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
        marineProbeBusy = classifyBuildFailure(errorMessage(probeError)).busy;
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
      const checkedCache = withCacheHealth(cached, 'current', {
        marineInstances: latestMarine,
        checkedBy: options.reason ?? 'check',
        // No provider was contacted and the hourly rows are unchanged, so any
        // degradation the last real build recorded still describes this
        // payload — a no-op check must not silently re-bless fallback data.
        degradedSources: cachedHealth?.degradedSources,
        providerBusy: cachedHealth?.providerBusy,
        busyProvider: cachedHealth?.busyProvider,
        message: cachedHealth?.message,
      });
      // The response always carries this check's timestamp; only PERSISTING it
      // is throttled. Nothing about the forecast itself has changed, so a
      // skipped write costs the stored stamp some precision and nothing else.
      const storedStampMs = Date.parse(cachedHealth?.lastAttemptAt ?? '');
      const stampAgeMs = Date.now() - storedStampMs;
      const minIntervalMs = options.reason === 'manual'
        ? MANUAL_STAMP_MIN_WRITE_INTERVAL_MS
        : CHECKED_STAMP_MIN_WRITE_INTERVAL_MS;
      if (!Number.isFinite(storedStampMs) || stampAgeMs >= minIntervalMs) {
        await writeCachedForecast(env, location, checkedCache, policy);
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
      ...(marineProbeFailed ? { busyProvider: 'marine' } : {}),
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
      const { busy, busyProvider } = classifyBuildFailure(errorMessage(error));
      const failedCache = withCacheHealth(cached, 'stale', {
        marineInstances: latestMarine ?? previousMarine,
        needsRebuild: options.forceRebuild || newMarineNeedsRebuild,
        checkedBy: options.reason ?? 'failed-check',
        ...(busy ? { providerBusy: true, busyProvider } : {}),
        message: 'Forecast refresh failed; keeping the last completed forecast.',
      });

      // This was the one KV write with no throttle at all, and it sits on the
      // path a hammering user actually reaches: once the cache is 'stale',
      // cachedNeedsRecovery drops the forced-refresh gate to
      // STALE_MANUAL_RETRY_MS (20s), `?refresh=1` is unauthenticated, and the
      // refresh button deliberately has no client-side throttle. See
      // shouldPersistFailureState for what survives that.
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

function userExecutionPolicy(): ExecutionPolicy {
  return executionPolicy({
    deadlineAt: Date.now() + USER_BACKGROUND_EXECUTION_BUDGET_MS,
    fetchTimeoutMs: FETCH_TIMEOUT_MS,
    // A browser refresh gets one bounded attempt. The next page visit/manual
    // tap is the retry schedule; spending the event on in-place retries leaves
    // no time to persist the truthful stale/degraded outcome.
    maxAttempts: 1,
    completionReserveMs: USER_COMPLETION_RESERVE_MS,
  });
}

async function handleForecastRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  locationId: string,
  eventMemo: EventMemo,
): Promise<Response> {
  const location = findLocation(locationId);
  if (!location) {
    return jsonResponse({ error: `Unknown forecast location: ${locationId}` }, 404);
  }

  const url = new URL(request.url);
  const force = url.searchParams.get('refresh') === '1' || url.searchParams.get('refresh') === 'true';
  const forceRebuildRequested = url.searchParams.get('rebuild') === '1' || url.searchParams.get('rebuild') === 'true';

  if (forceRebuildRequested) {
    return jsonResponse({ error: 'Manual rebuild is not available from the public forecast endpoint.' }, 403);
  }

  if (force) {
    // A user request cannot make upstream models publish sooner, so there is
    // nothing worth waiting for: answer instantly from cache and run the
    // forced rebuild in the background (measured worst case of the old
    // synchronous wait: 30s of DMI retry backoff ending in the same stale
    // payload). The response is explicitly pending and keeps the timestamp of
    // the last COMPLETED check. Re-dating lastAttemptAt here used to make the
    // header claim "Checked just now" before any provider had answered.
    const cached = await readCachedForecast(env, location, responseKvReadPolicy());
    if (cached) {
      ctx.waitUntil(refreshForecastCache(env, location, {
        force: true,
        reason: 'manual',
        minIntervalMs: MANUAL_CHECK_MIN_INTERVAL_MS,
        executionPolicy: userExecutionPolicy(),
        eventMemo,
        cached,
      }));
      const cachedHealth = cached.sources?.cacheHealth;
      return jsonResponse({
        ...cached,
        sources: {
          ...cached.sources,
          cacheHealth: {
            ...cachedHealth,
            status: 'pending',
            checkedBy: 'manual',
          },
        },
      });
    }
    const data = await refreshForecastCache(env, location, {
      force: true,
      reason: 'manual',
      minIntervalMs: MANUAL_CHECK_MIN_INTERVAL_MS,
      executionPolicy: userExecutionPolicy(),
      eventMemo,
      cached,
    });
    return jsonResponse(data);
  }

  const cached = await readCachedForecast(env, location, responseKvReadPolicy());
  if (cached) {
    if (shouldCheckInBackground(location, cached, USER_BACKGROUND_CHECK_MIN_INTERVAL_MS)) {
      ctx.waitUntil(refreshForecastCache(env, location, {
        reason: 'user-background',
        minIntervalMs: USER_BACKGROUND_CHECK_MIN_INTERVAL_MS,
        executionPolicy: userExecutionPolicy(),
        eventMemo,
        cached,
      }));
    }
    return jsonResponse(cached);
  }

  const data = await refreshForecastCache(env, location, {
    force: true,
    reason: 'cold-start',
    minIntervalMs: 0,
    executionPolicy: userExecutionPolicy(),
    eventMemo,
    cached,
  });
  return jsonResponse(data);
}

async function loadHealthPayload(env: Env): Promise<HealthPayload> {
  const policy = responseKvReadPolicy();
  let entries: HealthLocationEntry[];
  let storageUnavailable = false;
  try {
    entries = await Promise.all(
      FORECAST_LOCATIONS.map(async (location) => {
        const data = await readCachedForecast(env, location, policy);
        return {
          id: location.id,
          areaName: location.areaName,
          hasCache: Boolean(data),
          fetchedAt: data?.sources.fetchedAt,
          cacheHealth: data?.sources.cacheHealth,
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
    }));
  }
  return buildHealthPayload(entries, storageUnavailable);
}

async function handleHealthRequest(env: Env): Promise<Response> {
  return healthResponse(await loadHealthPayload(env));
}

async function handleStatusRequest(env: Env): Promise<Response> {
  return statusResponse(await loadHealthPayload(env));
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      // Request-scoped only: never retain I/O promises in module state across
      // Cloudflare events.
      const eventMemo: EventMemo = new Map();
      const url = new URL(request.url);
      const route = matchRoute(url.pathname);

      if (!route) {
        const response = jsonResponse({ error: 'Not found' }, 404);
        return request.method === 'HEAD' ? headResponse(response) : response;
      }

      if (request.method === 'OPTIONS') {
        return optionsResponse();
      }

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return methodNotAllowedResponse();
      }

      let response: Response;

      if (route.kind === 'root') {
        response = jsonResponse({
          ok: true,
          service: 'frank-forecast',
          endpoints: [...FORECAST_LOCATIONS.map((l) => `/forecast/${l.id}`), '/health', '/status'],
        });
      } else if (route.kind === 'health') {
        response = await handleHealthRequest(env);
      } else if (route.kind === 'status') {
        response = await handleStatusRequest(env);
      } else {
        response = await handleForecastRequest(request, env, ctx, route.locationId, eventMemo);
      }

      return request.method === 'HEAD' ? headResponse(response) : response;
    } catch (error) {
      // Reachable only because the handlers above are AWAITED. Returning their
      // promises un-awaited let a rejection escape this try entirely, so a
      // failure surfaced as an opaque 5xx with no CORS headers and no log line.
      console.error('Worker request failed:', error);
      const response = jsonResponse({
        error: 'Forecast service failed',
        message: 'An internal error occurred while fetching or processing forecast data.',
      }, 503);
      return request.method === 'HEAD' ? headResponse(response) : response;
    }
  },

  async scheduled(event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    // Nobody is waiting on a cron tick, so it can afford to wait out a slow
    // provider rather than call it broken (see CRON_FETCH_TIMEOUT_MS).
    const tickStartedAt = Date.now();
    const tickDeadlineAt = tickStartedAt + CRON_TICK_BUDGET_MS;
    const eventMemo: EventMemo = new Map();
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
          await refreshForecastCache(env, location, {
            reason: 'cron',
            minIntervalMs: CRON_CHECK_MIN_INTERVAL_MS,
            executionPolicy: policy,
            eventMemo,
          });
        } catch (error) {
          console.error(`Cron refresh failed for ${location.id}:`, error);
        }
      }
    } finally {
      console.log(`cron tick done in ${Date.now() - tickStartedAt}ms`);
    }
  },
} satisfies ExportedHandler<Env>;

export default worker;
