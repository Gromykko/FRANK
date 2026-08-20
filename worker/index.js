import locations from '../src/config/locations.json';
import { METEOALARM_DENMARK_FEED, enrichWarningCoverage, parseMeteoalarmFeed } from '../src/features/forecast/parseWarnings';
// Shared forecast-core: the Worker imports the SAME normalization/sun functions
// the client uses, so the two can never drift on the numbers the safety verdict
// runs on. (Previously each maintained its own copy.)
import {
  mapWaveFeatures,
  mapWaterFeatures,
  mapMetTimeseries,
  mapMetBlocks,
  aggregateBlockMarine,
  assembleBlockRow,
  assembleHourlyRow,
  nearestPoint,
} from '../src/features/forecast/normalize';
import { buildSunSchedule } from '../src/features/forecast/sun';
// Shared provider-request vocabulary (parameter lists + URL builders) — one
// copy for worker and dev client so the params can't drift from normalize.ts.
import {
  WAM_PARAMETERS,
  DKSS_PARAMETERS,
  buildDmiUrl as buildSharedDmiUrl,
  buildDmiInstancesUrl,
  buildMetUrl as buildSharedMetUrl,
} from '../src/features/forecast/providerUrls';
// Re-exported so tests/worker/math.test.ts keeps importing them from the worker.
export {
  asNumber,
  normalizeDegrees,
  currentSpeedFromComponents,
  currentDirectionFromComponents,
} from '../src/features/forecast/normalize';

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
const FETCH_TIMEOUT_MS = 15_000;
const CRON_FETCH_TIMEOUT_MS = 50_000;
// waitUntil work started by a browser request must be finished before 25s. The
// one-second margin covers promise cleanup/logging after the final abort.
const USER_BACKGROUND_EXECUTION_BUDGET_MS = 24_000;
// Provider work stops before the event wall so cache-health assembly and the
// final KV write still have a deterministic chance to finish.
const USER_COMPLETION_RESERVE_MS = 4_000;

// Four sequential locations share a five-minute tick. A hard 70s ceiling per
// location spends at most 280s and preserves 20s for loop/Worker overhead.
const CRON_TICK_BUDGET_MS = 5 * 60 * 1000;
const CRON_LOCATION_BUDGET_MS = 70 * 1000;
const CRON_COMPLETION_RESERVE_MS = 10_000;
// Warnings are advisory. A stuck CAP feed must never consume the required
// weather/marine budget or invalidate an otherwise complete forecast.
const WARNING_EXECUTION_BUDGET_MS = 5_000;

// /health judges TWO different clocks, because "the worker is dead" and "the
// data is old" are different failures with different normal ranges. The first
// version of this measured only `fetchedAt` and was simply wrong:
//
//   lastAttemptAt = when the Worker last CHECKED upstream.   -> liveness
//   fetchedAt     = when it last successfully REBUILT.       -> data age
//
// A Worker that checks every 10 minutes and finds nothing new is perfectly
// healthy, and `fetchedAt` legitimately does not move: `cacheAlreadyCurrent`
// deliberately skips the rebuild while MET's Expires window holds and DMI's run
// ids are unchanged. MET's Expires is consistently ~30 min, so a 40-minute bound
// on `fetchedAt` left one cron tick of headroom and would have false-alarmed on
// an ordinary quiet half hour.
//
// Liveness is the signal that actually caught nothing on 2026-08-08 (the cron
// stalled and lastAttemptAt froze for 11 hours). The persisted stamp is written
// at most every 15 min on a 10-min grid, so ~30 min is normal; 60 min is four
// missed ticks past that and still pages within the hour of a real stall.
const HEALTH_MAX_CHECK_AGE_MS = 60 * 60 * 1000;

// Data age is the backstop for "checking fine, but every rebuild fails" — a
// state the status field alone under-reports, since one transient failure should
// not page anyone. Far above any plausible MET cadence, so only a genuine
// multi-hour build failure trips it.
const HEALTH_MAX_DATA_AGE_MS = 3 * 60 * 60 * 1000;
const MAX_FETCH_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1_500;
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
// DMI marine runs are 6h apart (measured 2026-07-11: dkss_idw & wam_nsb run
// times 00/06/12/18Z, every gap exactly 6.00h; also DMI's documented synoptic
// cycle). A newer run therefore cannot exist until 6h after the one we hold,
// so probing the catalog before then is provably pointless. We gate at 5h =
// that 6h floor minus a 1h margin (guards clock skew / an early run), then
// probe every tick until a new run appears. Bump this only if DMI changes its
// run cadence.
const DMI_PROBE_QUIET_MS = 5 * 60 * 60 * 1000;
const DMI_BASE = 'https://opendataapi.dmi.dk/v1/forecastedr';
// The atmospheric weather picture comes from MET Norway Locationforecast. MET
// already computes the weather symbol, so FRANK never derives its own.
const MET_BASE = 'https://api.met.no/weatherapi/locationforecast/2.0/complete';
// MET requires an identifying User-Agent with a way to contact the operator, or
// it returns 403. See https://api.met.no/doc/TermsOfService.
const MET_USER_AGENT = 'FRANK-kayak-forecast/1.0 (https://github.com/Gromykko/FRANK)';
// Fallback validity when MET omits an Expires header (it normally sends one).
const MET_DEFAULT_TTL_MS = 30 * 60 * 1000;
// KV key prefix for the raw MET response, kept so refreshes can send
// If-Modified-Since (required by MET's TOS) and reuse the stored body on a
// 304 Not Modified instead of downloading the same forecast again.
const MET_RAW_KEY_PREFIX = 'met-raw';

// Version stamp written into every cached payload. Bump it whenever the
// payload shape or its data sources change: readCachedForecast refuses older
// payloads and forces a rebuild, so a redeployed worker can never keep
// serving forecasts built by previous logic. The app checks the same number
// and warns when the deployed worker lags behind it — keep this in sync with
// FORECAST_PAYLOAD_VERSION in src/features/forecast/types.ts.
const PAYLOAD_VERSION = 7;

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

// How stale MET's last-good response may be and still be served (see the
// fallback in fetchMetWeather).
const MET_FALLBACK_MAX_AGE_MS = 6 * 60 * 60 * 1000;
// Marine models normally publish every six hours. After two missed cycles, an
// old normalized run is no longer allowed to create a newly-stamped forecast.
const MARINE_FALLBACK_MAX_AGE_MS = 12 * 60 * 60 * 1000;

// Marine data still comes straight from DMI.
function cacheKey(location) {
  return `forecast:${location.id}:weather-data:v1`;
}

// Strict lookup — the caller 404s unknown ids; a silent first-location
// fallback would mask a typo'd id as the wrong fjord's forecast.
function findLocation(id) {
  return locations.find((location) => location.id === id);
}

// Thin wrappers binding the shared builders to this worker's base URLs.
function buildDmiUrl(collection, parameters, location, instanceId) {
  return buildSharedDmiUrl(DMI_BASE, collection, parameters, location.coordinate, instanceId);
}

function buildInstancesUrl(collection) {
  return buildDmiInstancesUrl(DMI_BASE, collection);
}

function buildMetUrl(location) {
  return buildSharedMetUrl(MET_BASE, location.coordinate);
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

const ALLOW_READ_METHODS = 'GET, HEAD, OPTIONS';

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(`${JSON.stringify(body)}\n`, {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...corsHeaders(),
      ...extraHeaders,
    },
  });
}

function headResponse(response) {
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function retryDelay(attempt) {
  return RETRY_BASE_DELAY_MS * 2 ** attempt + Math.floor(Math.random() * 500);
}

function deadlineError(stage, deadlineKind = 'hard') {
  const error = new Error(`Execution deadline reached before ${stage}`);
  error.name = 'ExecutionDeadlineError';
  error.deadlineKind = deadlineKind;
  return error;
}

function executionPolicy(policy = {}) {
  return {
    deadlineAt: policy.deadlineAt ?? Number.POSITIVE_INFINITY,
    hardDeadlineAt: policy.hardDeadlineAt ?? policy.deadlineAt ?? Number.POSITIVE_INFINITY,
    fetchTimeoutMs: policy.fetchTimeoutMs ?? FETCH_TIMEOUT_MS,
    maxAttempts: policy.maxAttempts ?? MAX_FETCH_ATTEMPTS,
    completionReserveMs: Math.max(0, policy.completionReserveMs ?? 0),
  };
}

function remainingExecutionMs(policy) {
  return policy.deadlineAt - Date.now();
}

function assertBeforeDeadline(policy, stage) {
  if (remainingExecutionMs(policy) <= 0) throw deadlineError(stage);
}

function remainingProviderMs(policy) {
  return remainingExecutionMs(policy) - policy.completionReserveMs;
}

function assertBeforeProviderDeadline(policy, stage) {
  if (remainingProviderMs(policy) <= 0) {
    throw deadlineError(`${stage} (completion reserve reached)`, 'provider');
  }
}

function rethrowIfDeadlineReached(error, policy, stage) {
  if (error?.name === 'ExecutionDeadlineError' && error?.deadlineKind !== 'provider') throw error;
  assertBeforeDeadline(policy, stage);
}

async function delayWithinDeadline(ms, policy, stage) {
  assertBeforeProviderDeadline(policy, stage);
  const remainingMs = remainingProviderMs(policy);
  const delayMs = Number.isFinite(remainingMs) ? Math.min(ms, remainingMs) : ms;
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  assertBeforeProviderDeadline(policy, stage);
}

async function awaitWithinDeadline(start, policy, stage) {
  assertBeforeDeadline(policy, stage);
  const promise = start();
  const remainingMs = remainingExecutionMs(policy);
  if (!Number.isFinite(remainingMs)) return promise;

  let timeoutId;
  const deadline = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(deadlineError(stage)), Math.max(1, remainingMs));
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timeoutId);
  }
}

// AbortSignal.timeout stays armed for the whole exchange, body included. A
// manual controller cleared in a `finally` would disarm the moment headers
// arrive, leaving every `.json()`/`.text()` below able to hang indefinitely on
// an upstream that answers 200 and then stalls the stream — which in the cron's
// sequential loop starves every location after it.
function fetchWithTimeout(url, init = {}, policy = executionPolicy()) {
  assertBeforeProviderDeadline(policy, `fetch ${url}`);
  const remainingMs = remainingProviderMs(policy);
  const timeoutMs = Math.max(1, Math.floor(Math.min(policy.fetchTimeoutMs, remainingMs)));
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

// One structured line per upstream call: which source, how long, what happened.
// Without this, "is DMI slow or is our timeout wrong?" could only be answered by
// hand-timing curl from a laptop — which is how the 22-23s latency above was
// found. Visible in `npm run worker:tail` and Workers Logs.
function logUpstream(source, startedAt, outcome, extra = '') {
  const ms = Date.now() - startedAt;
  console.log(`upstream ${source} ${outcome} ${ms}ms${extra ? ' ' + extra : ''}`);
}

async function fetchJsonWithRetries(url, label, policy = executionPolicy()) {
  let lastError;

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
      lastError = new Error(`${label} failed with HTTP ${response.status}`);
      lastError.status = response.status;
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

function parseDmiInstanceMs(id) {
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
export function isMarineRunWithinFallbackAge(instance, nowMs = Date.now()) {
  const runMs = parseDmiInstanceMs(instance?.id);
  if (!Number.isFinite(runMs)) return false;
  const ageMs = nowMs - runMs;
  return ageMs >= 0 && ageMs <= MARINE_FALLBACK_MAX_AGE_MS;
}

function marineInstancesWithinFallbackAge(instances, nowMs = Date.now()) {
  return isMarineRunWithinFallbackAge(instances?.water, nowMs)
    && isMarineRunWithinFallbackAge(instances?.waves, nowMs);
}

function assertMarineRunWithinFallbackAge(instance, label = instance?.collection ?? 'marine') {
  if (!isMarineRunWithinFallbackAge(instance)) {
    throw new Error(`DMI ${label} run is older than the 12-hour marine safety limit.`);
  }
}

// Age of the OLDER of the two marine runs we hold (so if one source lags, we
// still probe). Infinity if either run id is missing/unparseable - an
// incomplete marine set must always trigger a probe.
export function marineRunAgeMs(marineInstances, now = Date.now()) {
  const water = parseDmiInstanceMs(marineInstances?.water?.id);
  const waves = parseDmiInstanceMs(marineInstances?.waves?.id);
  if (!Number.isFinite(water) || !Number.isFinite(waves)) return Infinity;
  return now - Math.min(water, waves);
}

function latestInstanceFromResponse(data) {
  const instances = Array.isArray(data?.instances) ? data.instances : [];
  let best;
  let bestMs = -Infinity;

  for (const instance of instances) {
    const id = instance?.id;
    const timeMs = parseDmiInstanceMs(id);
    if (id && Number.isFinite(timeMs) && timeMs > bestMs) {
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

// Which fjord the cron visits first, rotated by tick.
//
// The tick has a 5-minute budget and the locations are refreshed one after
// another, so a slow upstream can spend the budget before the loop reaches the
// end. Each location now gets one bounded upstream attempt plus a completion
// reserve; the 10-minute cron itself is the retry schedule. With a fixed order,
// earlier versions still starved the SAME fjords whenever a provider stayed
// slow, so their data aged until /health alarmed an hour later.
//
// Rotating by the scheduled minute turns a permanent starvation into an
// occasional missed tick, spread evenly. Derived from the tick's own clock so it
// needs no stored state and no KV write, and stays stable if the isolate
// recycles mid-tick. An unparseable scheduledTime falls back to the plain order.
export function tickOrder(scheduledTime, list = locations) {
  const tickIndex = Math.floor(Number(scheduledTime) / (10 * 60 * 1000));
  if (!Number.isFinite(tickIndex) || list.length === 0) return list;
  const offset = ((tickIndex % list.length) + list.length) % list.length;
  return [...list.slice(offset), ...list.slice(0, offset)];
}

// Pure budget calculation kept separate from the scheduled loop so its
// fairness guarantee is regression-tested. `null` means the tick has no usable
// time left. Each early location receives at most its fair share, so it cannot
// consume time reserved for locations later in the rotated order.
export function cronExecutionPolicy(nowMs, tickDeadlineAt, locationsRemaining) {
  const remainingMs = tickDeadlineAt - nowMs;
  if (remainingMs <= 0 || locationsRemaining <= 0) return null;
  const locationBudgetMs = Math.min(
    CRON_LOCATION_BUDGET_MS,
    Math.floor(remainingMs / locationsRemaining),
  );
  if (locationBudgetMs <= 0) return null;
  return executionPolicy({
    deadlineAt: Math.min(tickDeadlineAt, nowMs + locationBudgetMs),
    fetchTimeoutMs: Math.min(CRON_FETCH_TIMEOUT_MS, locationBudgetMs),
    maxAttempts: 1,
    completionReserveMs: Math.min(
      CRON_COMPLETION_RESERVE_MS,
      Math.floor(locationBudgetMs / 4),
    ),
  });
}

export function fetchLatestInstanceForCollections(collections, policyInput, eventMemo) {
  const policy = executionPolicy(policyInput);
  assertBeforeDeadline(policy, `DMI ${collections.join(',')} instance probe`);
  const key = `instance-probe:${collections.join(',')}`;
  const memo = eventMemo?.get(key);
  if (memo) return memo;

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

async function probeLatestInstanceForCollections(collections, policy) {
  let lastError;

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
      if (lastError.status !== 404) throw lastError;
    }
  }

  throw lastError ?? new Error(`No DMI instances found for ${collections.join(', ')}`);
}

async function fetchLatestMarineInstances(location, policy, eventMemo) {
  assertBeforeDeadline(policy, `marine instance probes for ${location.id}`);
  const results = await Promise.allSettled([
    fetchLatestInstanceForCollections(location.dmiCollections.water, policy, eventMemo),
    fetchLatestInstanceForCollections(location.dmiCollections.waves, policy, eventMemo),
  ]);
  assertBeforeDeadline(policy, `marine instance probe results for ${location.id}`);

  const water = results[0].status === 'fulfilled' ? results[0].value : undefined;
  const waves = results[1].status === 'fulfilled' ? results[1].value : undefined;

  if (!water || !waves) {
    const errors = results.filter(r => r.status === 'rejected').map(r => r.reason.message);
    throw new Error(`Failed to fetch DMI marine instances: ${errors.join(', ')}`);
  }

  return { water, waves };
}

function marineInstancesEqual(left, right) {
  return Boolean(
    left &&
      right &&
      left.water?.collection === right.water?.collection &&
      left.water?.id === right.water?.id &&
      left.waves?.collection === right.waves?.collection &&
      left.waves?.id === right.waves?.id
  );
}

async function fetchDmiGeoJson(collection, parameters, location, instanceId, policy) {
  return fetchJsonWithRetries(
    buildDmiUrl(collection, parameters, location, instanceId),
    `DMI ${collection}`,
    policy
  );
}

function mapMetPayload(data, lastModified, expiresMs) {
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

async function fetchMetWeather(env, location, policy) {
  assertBeforeDeadline(policy, `MET cache read for ${location.id}`);
  const rawKey = `${MET_RAW_KEY_PREFIX}:${location.id}`;
  let stored = null;
  try {
    stored = await awaitWithinDeadline(
      () => env.FRANK_FORECAST_CACHE.get(rawKey, 'json'),
      policy,
      `MET retained cache read for ${location.id}`,
    );
  } catch (error) {
    rethrowIfDeadlineReached(error, policy, `MET retained cache read recovery for ${location.id}`);
    stored = null;
  }

  const headers = {
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
      const error = new Error(`MET Norway weather failed with HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }

    const data = await response.json();
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
      return { ...mapMetPayload(stored.body, stored.lastModified, Number.NaN), fallback: true, degraded: true, busy: isBusyError(error?.message) };
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

export async function fetchMarineSeriesWithFallback(env, location, kind, instance, parameters, mapFeatures, seedSeries, seedInstance, policyInput) {
  const policy = executionPolicy(policyInput);
  assertBeforeDeadline(policy, `${kind} marine cache read for ${location.id}`);
  assertMarineRunWithinFallbackAge(instance, instance?.collection ?? kind);
  const key = `${MARINE_INGREDIENT_KEY_PREFIX}:${kind}:${location.id}`;

  let stored = null;
  try {
    stored = await awaitWithinDeadline(
      () => env.FRANK_FORECAST_CACHE.get(key, 'json'),
      policy,
      `${kind} retained cache read for ${location.id}`,
    );
  } catch (error) {
    rethrowIfDeadlineReached(error, policy, `${kind} retained cache read recovery for ${location.id}`);
    stored = null;
  }

  // Same run we already hold data for: reuse it, no network call. DMI runs
  // change only every ~6h, so an hourly weather rebuild must not re-pull
  // identical marine data (measured: gaps between runs are exactly 6.00h).
  const hasCurrentStoredSeries = stored?.schemaVersion === PAYLOAD_VERSION
    && Array.isArray(stored.series) && stored.series.length > 0
    && isMarineRunWithinFallbackAge(stored);

  if (hasCurrentStoredSeries
    && stored.collection === instance.collection
    && stored.id === instance.id) {
    return { series: stored.series, instance, fallback: false };
  }

  // Fall back to the run we already hold (retained ingredient, else the seed
  // from the cached payload). `extra` distinguishes WHY we fell back.
  const fallbackToHeld = (extra) => {
    // Re-evaluate against the current clock. A request can begin exactly at
    // the 12h boundary and cross it while waiting for the provider; a decision
    // made before that wait must not authorize a newly-stamped old fallback.
    if (hasCurrentStoredSeries && isMarineRunWithinFallbackAge(stored)) {
      return { series: stored.series, instance: { collection: stored.collection, id: stored.id }, fallback: true, ...extra };
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

  let data;
  try {
    data = await fetchDmiGeoJson(instance.collection, parameters, location, instance.id, policy);
  } catch (error) {
    rethrowIfDeadlineReached(error, policy, `${kind} retained fallback for ${location.id}`);
    // Transport error (429/5xx/network): we genuinely could not refresh this
    // source. Show the held run and flag it degraded (amber).
    const held = fallbackToHeld({ degraded: true, busy: isBusyError(error?.message) });
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
export function deriveMarineSeedsFromPayload(cached) {
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
function advisoryWarningPolicy(parentPolicy) {
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

async function fetchWarnings(location, seedWarnings, policy, now = Date.now()) {
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

async function buildForecastCache(env, location, marineInstances, marineSeeds, warningSeed, policy) {
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
  if (results.slice(0, 3).some(r => r.status === 'rejected')) {
    const errors = results.slice(0, 3).filter(r => r.status === 'rejected').map(r => r.reason.message);
    throw new Error(`Failed to build forecast: ${errors.join(', ')}`);
  }

  const [met, water, wave] = results.slice(0, 3).map(r => r.value);
  const warnings = results[3].status === 'fulfilled' ? results[3].value : [];

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
    .filter(Boolean)
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

function isUsableForecastCache(value) {
  return Boolean(
    value &&
      Array.isArray(value.hourly) &&
      value.hourly.length > 0 &&
      Array.isArray(value.sunrise) &&
      Array.isArray(value.sunset) &&
      value.sources?.fetchedAt &&
      // Payloads built by older worker logic are refused outright, forcing a
      // rebuild on the next request/cron instead of being re-blessed as
      // "current" forever.
      value.sources?.payloadVersion === PAYLOAD_VERSION
  );
}

function hasCurrentForecastWindow(data) {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  return data.hourly.some((hour) => new Date(hour.time).getTime() >= oneHourAgo);
}

function buildCacheHealth(status, data, options = {}) {
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

// A "busy" upstream (429/rate-limited) is a "try later", distinct from a real
// error - the UI words it calmly and the retry logic treats it as terminal.
export function isBusyError(message) {
  return /\b429\b|too many requests|server is busy|rate.?limit/i.test(String(message ?? ''));
}

// Classify a build failure so the client can word it calmly: whether the
// provider is merely busy vs a real error, and which provider it was.
export function classifyBuildFailure(message) {
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
export function degradedSourcesAfterProbe(degradedSources = [], marineProbeFailed = false) {
  return [...new Set([
    ...degradedSources,
    ...(marineProbeFailed ? ['water', 'waves'] : []),
  ])];
}

function withCacheHealth(data, status, options = {}) {
  return {
    ...data,
    sources: {
      ...data.sources,
      cacheHealth: buildCacheHealth(status, data, options),
    },
  };
}

async function readCachedForecast(env, location, policyInput) {
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

async function writeCachedForecast(env, location, data, policyInput) {
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
export function shouldPersistFailureState(prev, next, nowMs = Date.now()) {
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
const lastCheckAt = new Map();

export function shouldCheckInBackground(location, data, minIntervalMs, memoryMsOverride) {
  const stampMs = new Date(data?.sources?.cacheHealth?.lastAttemptAt ?? 0).getTime();
  const memoryMs = memoryMsOverride ?? lastCheckAt.get(cacheKey(location)) ?? 0;
  // Whichever check was more recent decides — a fresh in-memory check must not
  // be overridden by an older persisted stamp, and vice versa.
  const lastMs = Math.max(Number.isFinite(stampMs) ? stampMs : 0, memoryMs);
  return lastMs === 0 || Date.now() - lastMs > minIntervalMs;
}

async function _refreshForecastCache(env, location, options = {}) {
  const policy = executionPolicy(options.executionPolicy);
  assertBeforeDeadline(policy, `refresh start for ${location.id}`);
  // Browser-triggered background work already read this payload to answer the
  // request. Reusing that event-local value removes a redundant KV operation
  // and guarantees the waitUntil task enters its bounded try/catch immediately.
  const cached = options.cached ?? await readCachedForecast(env, location, policy);
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

  let latestMarine;

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
        marineProbeBusy = classifyBuildFailure(probeError?.message).busy;
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
    const fallbackNotes = [
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
    if ((error?.name === 'ExecutionDeadlineError' && error?.deadlineKind !== 'provider')
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
      const { busy, busyProvider } = classifyBuildFailure(error?.message);
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

async function refreshForecastCache(env, location, options = {}) {
  const key = `refresh:${cacheKey(location)}`;
  const memo = options.eventMemo;
  if (memo?.has(key)) return memo.get(key);

  const promise = _refreshForecastCache(env, location, options);
  memo?.set(key, promise);
  try {
    return await promise;
  } finally {
    memo?.delete(key);
  }
}

function userExecutionPolicy() {
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

async function handleForecastRequest(request, env, ctx, locationId, eventMemo) {
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
    const cached = await readCachedForecast(env, location);
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
    });
    return jsonResponse(data);
  }

  const cached = await readCachedForecast(env, location);
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
  });
  return jsonResponse(data);
}

async function handleHealthRequest(env) {
  const { ages, ...body } = await healthPayload(env);
  void ages; // internal only; the wire shape stays as documented
  return jsonResponse(body, body.ok ? 200 : 503);
}

// The single source of truth behind BOTH /health (the machine alarm) and
// /status (the human panel). Splitting it means the page can never disagree
// with the thing that pages you.
async function healthPayload(env) {
  const entries = await Promise.all(
    locations.map(async (location) => {
      const data = await readCachedForecast(env, location);
      return {
        id: location.id,
        areaName: location.areaName,
        hasCache: Boolean(data),
        fetchedAt: data?.sources?.fetchedAt,
        cacheHealth: data?.sources?.cacheHealth,
      };
    })
  );

  // A dead man's switch, for an external uptime monitor to poll.
  //
  // On 2026-08-08 the cron silently stopped rebuilding and the forecast sat
  // frozen for ELEVEN HOURS. Every endpoint answered 200, this endpoint said
  // ok:true, and nothing was logged — the stall was eventually noticed in the
  // UI. The tell was never an error; it was a timestamp that had stopped
  // moving. So this endpoint now judges itself on that timestamp and returns
  // 503 when it goes stale, which is a signal a monitor can actually alarm on.
  //
  // Deliberately external rather than self-reported: a cron that has stopped
  // firing cannot notice that it stopped. The watcher has to live outside.
  const now = Date.now();
  const age = (iso) => {
    const ms = Date.parse(iso ?? '');
    return Number.isFinite(ms) ? now - ms : Number.POSITIVE_INFINITY;
  };
  const ages = entries.map((entry) => ({
    id: entry.id,
    // Data age: when this location's forecast was last BUILT.
    ageMs: age(entry.fetchedAt),
    // Liveness: when the Worker last CHECKED upstream for this location.
    checkAgeMs: age(entry.cacheHealth?.lastAttemptAt ?? entry.fetchedAt),
  }));

  const notChecking = ages.filter((a) => a.checkAgeMs > HEALTH_MAX_CHECK_AGE_MS).map((a) => a.id);
  const notRebuilding = ages.filter((a) => a.ageMs > HEALTH_MAX_DATA_AGE_MS).map((a) => a.id);
  const stalled = [...new Set([...notChecking, ...notRebuilding])];
  const worst = (key) => ages.reduce((acc, a) => Math.max(acc, a[key]), 0);
  const oldestAgeMs = worst('ageMs');
  const oldestCheckAgeMs = worst('checkAgeMs');
  const ok = stalled.length === 0;
  const asMin = (ms) => (Number.isFinite(ms) ? Math.round(ms / 60000) : null);

  return {
    ok,
    service: 'frank-forecast',
    checkedAt: new Date().toISOString(),
    // Flat, machine-readable fields first so a monitor can key on them without
    // walking the per-location detail below.
    oldestCheckAgeMin: asMin(oldestCheckAgeMs),
    checkStaleAfterMin: Math.round(HEALTH_MAX_CHECK_AGE_MS / 60000),
    oldestAgeMin: asMin(oldestAgeMs),
    dataStaleAfterMin: Math.round(HEALTH_MAX_DATA_AGE_MS / 60000),
    // Which clock tripped, so the alert email says what to look at.
    reason: ok ? null : [
      ...(notChecking.length ? [`not checking: ${notChecking.join(', ')}`] : []),
      ...(notRebuilding.length ? [`not rebuilding: ${notRebuilding.join(', ')}`] : []),
    ].join(' | '),
    stalled,
    locations: entries,
    ages,
  };
}


// ── /status: the human panel ─────────────────────────────────────────────────
//
// /health is the ALARM: one job, machine-readable, 503 when stale, and its shape
// must never change because a monitor depends on it. This is the diagnostic view
// you open AFTER the alarm fires, to answer "what exactly is wrong". Same
// healthPayload() behind both, so the page can never disagree with the pager.
//
// Always answers 200, even when everything is stale — a page that returns 503
// is a page some browsers and proxies will refuse to render, and this one exists
// precisely for the broken case. Point the monitor at /health, never at this.
//
// Self-contained: no scripts (so no CSP exception), no fonts, no external CSS.
// Refreshes itself with a meta tag so it can be left open on a second screen.
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function formatAge(ageMs) {
  if (!Number.isFinite(ageMs)) return 'no data';
  const min = Math.round(ageMs / 60000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return `${h}h ${String(min % 60).padStart(2, '0')}m`;
}

async function handleStatusRequest(env) {
  const health = await healthPayload(env);
  const byId = new Map(health.ages.map((a) => [a.id, a]));

  // Two columns for two clocks, each judged against its own budget — a single
  // "age" column conflated "the Worker is dead" with "MET has published nothing
  // new lately", which are a crisis and a quiet Tuesday respectively.
  const level = (ms, budget) => (ms > budget ? 'bad' : ms > budget * 0.75 ? 'warn' : 'good');

  const rows = health.locations.map((loc) => {
    const a = byId.get(loc.id) ?? { ageMs: Number.POSITIVE_INFINITY, checkAgeMs: Number.POSITIVE_INFINITY };
    const h = loc.cacheHealth ?? {};
    const degraded = (h.degradedSources ?? []).join(', ');
    const runs = h.marineInstances
      ? `${escapeHtml(h.marineInstances.water?.id ?? '—')}<br><span class="dim">${escapeHtml(h.marineInstances.waves?.id ?? '—')}</span>`
      : '—';
    return `<tr>
      <td><strong>${escapeHtml(loc.areaName)}</strong><br><span class="dim">${escapeHtml(loc.id)}</span></td>
      <td class="${level(a.checkAgeMs, HEALTH_MAX_CHECK_AGE_MS)}"><strong>${escapeHtml(formatAge(a.checkAgeMs))}</strong><br><span class="dim">${escapeHtml(h.checkedBy ?? '—')}</span></td>
      <td class="${level(a.ageMs, HEALTH_MAX_DATA_AGE_MS)}"><strong>${escapeHtml(formatAge(a.ageMs))}</strong></td>
      <td>${escapeHtml(h.status ?? (loc.hasCache ? 'unknown' : 'NO CACHE'))}${h.providerBusy ? '<br><span class="warn">provider busy</span>' : ''}</td>
      <td>${degraded ? `<span class="warn">${escapeHtml(degraded)}</span>` : '<span class="dim">none</span>'}</td>
      <td class="dim mono">${runs}</td>
    </tr>`;
  }).join('');

  const banner = health.ok
    ? '<div class="banner good">WORKER LIVE · ALL LOCATIONS CURRENT</div>'
    : `<div class="banner bad">ATTENTION — ${escapeHtml(health.reason ?? health.stalled.join(', '))}</div>`;

  return htmlResponse(`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>FRANK worker status</title>
<style>
  :root { color-scheme: dark }
  /* Centered column: without the auto margins a wide monitor pins everything
     to the left edge with three quarters of the screen empty. */
  body { margin:0 auto; padding:20px; max-width:940px; background:#0c1117; color:#e8ecf1;
         font:14px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace }
  h1 { font-size:13px; letter-spacing:.18em; text-transform:uppercase; color:#7a8ba0; margin:0 0 16px }
  .banner { padding:14px 16px; border-radius:8px; font-size:18px; letter-spacing:.06em;
            margin-bottom:18px; border:1px solid }
  .banner.good { background:#0f2a1f; border-color:#34d399; color:#34d399 }
  .banner.bad  { background:#2a1010; border-color:#f87171; color:#f87171 }
  table { border-collapse:collapse; width:100%; max-width:900px }
  th { text-align:left; font-size:10px; letter-spacing:.12em; text-transform:uppercase;
       color:#7a8ba0; border-bottom:1px solid rgba(255,255,255,.18); padding:6px 10px 6px 0; font-weight:600 }
  td { padding:10px 10px 10px 0; border-bottom:1px solid rgba(255,255,255,.06); vertical-align:top }
  .good { color:#34d399 } .warn { color:#fbbf24 } .bad { color:#f87171 }
  .dim { color:#7a8ba0 } .mono { font-size:12px }
  .hdr-sub { font-weight:400; text-transform:none; letter-spacing:0; opacity:.7 }
  footer p { margin:0 0 12px }
  code { color:#e8ecf1; background:rgba(255,255,255,.07); padding:1px 4px; border-radius:3px }
  footer { margin-top:20px; color:#7a8ba0; font-size:12px; max-width:900px }
  a { color:#4b9eff }
</style></head><body>
<h1>FRANK · forecast worker</h1>
${banner}
<table>
  <tr><th>Location</th><th>Last check<br><span class="hdr-sub">own cycle per location</span></th><th>Data age<br><span class="hdr-sub">last rebuild</span></th><th>Status</th><th>Degraded</th><th>Water / wave run</th></tr>
  ${rows}
</table>
<footer>
  <p>Last check counts from the most recent time the worker asked MET and DMI whether
  anything had changed. The schedule runs every 10 minutes, but the timestamp is only
  written to storage once it is 15 minutes old, because each write comes out of a daily
  quota. A figure of 15 or 20 minutes therefore does not mean a check was missed.</p>

  <p>Each location also runs that cycle independently, so the four rows are normally out
  of step with each other. One city reading 2 minutes while another reads 11 is the
  expected picture, not a fault: a location's stamp is also rewritten whenever that
  location rebuilds, which follows its own MET validity window, and again whenever a
  visitor's request prompts a check for it. The rows only line up right after a deploy,
  when all four are built at once. The alarm sits at
  ${escapeHtml(health.checkStaleAfterMin)} minutes, well clear of the whole cycle.
  Worst right now: ${escapeHtml(health.oldestCheckAgeMin ?? '?')} minutes.</p>

  <p>Data age counts from the last successful rebuild, and a figure that sits still is
  normal here. MET declares each forecast valid for about 30 minutes through its
  Expires header, so between reissues there is nothing new to build and the worker
  skips the work on purpose. It alarms only past
  ${escapeHtml(health.dataStaleAfterMin / 60)} hours, which would mean the checks are
  succeeding while every rebuild fails. Worst right now:
  ${escapeHtml(health.oldestAgeMin ?? '?')} minutes.</p>

  <p>The word under Last check names what triggered it. <code>cron</code> is the
  10-minute schedule. <code>user-background</code> is a visitor opening the app, which
  prompts a check after the response has already gone out. <code>manual</code> is the
  refresh button. <code>cold-start</code> means no cached forecast existed and one had
  to be built on the spot.</p>

  <p>This page reloads every 30 seconds and is meant for reading. The machine-readable
  alarm lives at <a href="/health">/health</a>, which returns 503 and a
  <code>reason</code> when either clock trips.</p>
</footer>
</body></html>
`);
}

export default {
  async fetch(request, env, ctx) {
    try {
      // Request-scoped only: never retain I/O promises in module state across
      // Cloudflare events.
      const eventMemo = new Map();
      const url = new URL(request.url);
      const normalizedPath = url.pathname.replace(/\/+$/, '') || '/';
      const forecastMatch = normalizedPath.match(/^\/forecast\/([a-z0-9-]+)$/);
      const knownRoute = normalizedPath === '/'
        || normalizedPath === '/health'
        || normalizedPath === '/status'
        || Boolean(forecastMatch);

      if (!knownRoute) {
        const response = jsonResponse({ error: 'Not found' }, 404);
        return request.method === 'HEAD' ? headResponse(response) : response;
      }

      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            ...corsHeaders(),
            Allow: ALLOW_READ_METHODS,
          },
        });
      }

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return jsonResponse(
          { error: 'Method not allowed' },
          405,
          { Allow: ALLOW_READ_METHODS },
        );
      }

      let response;

      if (normalizedPath === '/') {
        response = jsonResponse({
          ok: true,
          service: 'frank-forecast',
          endpoints: [...locations.map((l) => `/forecast/${l.id}`), '/health', '/status'],
        });
      } else if (normalizedPath === '/health') {
        response = await handleHealthRequest(env);
      } else if (normalizedPath === '/status') {
        response = await handleStatusRequest(env);
      } else {
        response = await handleForecastRequest(request, env, ctx, forecastMatch[1], eventMemo);
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

  async scheduled(event, env, _ctx) {
    // Nobody is waiting on a cron tick, so it can afford to wait out a slow
    // provider rather than call it broken (see CRON_FETCH_TIMEOUT_MS).
    const tickStartedAt = Date.now();
    const tickDeadlineAt = tickStartedAt + CRON_TICK_BUDGET_MS;
    const eventMemo = new Map();
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
};
