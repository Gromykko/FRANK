import { CURRENT_LOCATION } from '../../config/locations';
import type { ForecastLocation } from '../../config/locations';
import type { WeatherData } from './types';
import { reviveReadings } from './normalize';
import { isValidForecastPayload } from './validatePayload';
import { shouldApplyForecastUpdate } from './forecastOrdering';

const DEFAULT_FORECAST_WORKER_BASE = 'https://frank-forecast.alswatchs.workers.dev';
const WEATHER_CACHE_KEY_PREFIX = 'frank_weather_data_v2';
const CACHED_WORKER_FETCH_TIMEOUT_MS = 12 * 1000;
// A route may spend up to 2s on its response KV read before starting a
// synchronous build under the Worker's separate 24s budget. Keep another 4s
// for both network legs and serialization rather than racing that 26s ceiling.
const COLD_WORKER_FETCH_TIMEOUT_MS = 30 * 1000;

const FORECAST_WORKER_BASE = (import.meta.env.VITE_FORECAST_WORKER_BASE ?? DEFAULT_FORECAST_WORKER_BASE).replace(/\/$/, '');

function getWeatherCacheKey(location: ForecastLocation): string {
  return `${WEATHER_CACHE_KEY_PREFIX}_${location.id}`;
}

function hasCurrentForecastWindow(data: WeatherData): boolean {
  const nowMs = Date.now();
  return data.hourly.some((hour) => {
    const startMs = new Date(hour.time).getTime();
    if (!Number.isFinite(startMs)) return false;
    const configuredSpanHours = hour.blockSpanHours ?? 1;
    const spanHours = Number.isFinite(configuredSpanHours) && configuredSpanHours > 0
      ? configuredSpanHours
      : 1;
    return startMs + spanHours * 60 * 60 * 1000 > nowMs;
  });
}

export function saveCachedWeatherData(data: WeatherData, location: ForecastLocation) {
  // New writes must always carry an explicit compatible version and matching
  // location. The relaxed unversioned policy is only for already-saved legacy
  // data in readLocalCachedWeatherData below.
  if (!isValidForecastPayload(data, location)) return;

  // `pending` exists only on the immediate response to ?refresh=1 while the
  // Worker rebuilds in waitUntil. It is not durable forecast health. Persisting
  // it overwrites the last completed status and can leave "Checking…" stuck
  // across reloads when the completed check keeps the same fetchedAt.
  if (data.sources.cacheHealth?.status === 'pending') return;

  try {
    const existingRaw = localStorage.getItem(getWeatherCacheKey(location));
    if (existingRaw) {
      try {
        const existing = reviveReadings(JSON.parse(existingRaw));
        if (
          isValidForecastPayload(existing, location, { allowLegacyMissingVersion: true })
          && !shouldApplyForecastUpdate(existing, data)
        ) {
          return;
        }
      } catch {
        // A corrupt local value has no ordering claim. Replace it with the
        // validated incoming payload so one bad write cannot disable offline
        // recovery forever.
      }
    }
    localStorage.setItem(getWeatherCacheKey(location), JSON.stringify(data));
  } catch {
    // Caching also provides the offline fallback, but storage can be blocked;
    // the live forecast remains usable for the current session.
  }
}

function readLocalCachedWeatherData(location: ForecastLocation): WeatherData | null {
  try {
    const raw = localStorage.getItem(getWeatherCacheKey(location));
    if (!raw) return null;

    const parsed = reviveReadings(JSON.parse(raw));
    // Accept any structurally usable saved forecast that still covers now or
    // the future. Its build age is presentation state, not a load gate:
    // deriveCacheStatus marks data older than six hours as stale and App shows
    // the caution banner. Rejecting it here instead strands an offline paddler
    // on the no-forecast screen despite having actionable hours on the device.
    if (isValidForecastPayload(parsed, location, { allowLegacyMissingVersion: true }) && hasCurrentForecastWindow(parsed)) {
      if (parsed.sources.cacheHealth?.status === 'pending') {
        // Heal copies written by older clients before pending became
        // response-only. The overwritten completed status cannot be recovered,
        // so stale is the conservative stable state: usable data, amber honesty,
        // and never a permanent in-flight claim.
        const healed: WeatherData = {
          ...parsed,
          sources: {
            ...parsed.sources,
            cacheHealth: { ...parsed.sources.cacheHealth, status: 'stale' },
          },
        };
        saveCachedWeatherData(healed, location);
        return healed;
      }
      return parsed;
    }
  } catch {
    return null;
  }

  return null;
}

interface WorkerCacheRead {
  data: WeatherData | null;
  backgroundCheckScheduled: boolean;
}

async function readWorkerCachedWeatherData(
  location: ForecastLocation,
  forceRefresh = false,
  timeoutMs = CACHED_WORKER_FETCH_TIMEOUT_MS,
): Promise<WorkerCacheRead> {
  if (!FORECAST_WORKER_BASE) return { data: null, backgroundCheckScheduled: false };

  try {
    const query = new URLSearchParams({
      cacheBust: String(Date.now()),
    });

    if (forceRefresh) {
      query.set('refresh', '1');
    }

    const response = await fetch(`${FORECAST_WORKER_BASE}/forecast/${location.id}?${query.toString()}`, {
      cache: 'no-store',
      // Kayakers open this on fjord-edge mobile signal, where a socket can
      // stay open indefinitely without ever answering. Without a deadline the
      // preferWorker path never falls through to the saved forecast and the
      // app just spins — the one moment a cached answer matters most.
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) return { data: null, backgroundCheckScheduled: false };
    const backgroundCheckScheduled = response.headers?.get('X-FRANK-Background-Check') === 'scheduled';

    const parsed = reviveReadings(await response.json());
    // USABILITY, not freshness: does this payload still cover the hours the app
    // needs to render? How OLD it is belongs to the status layer, which reports
    // it honestly (deriveCacheStatus demotes the tone by wall clock, and the
    // page banner fires past 6 h).
    //
    // Gating this on the local copy's 6-hour age cap instead was a real outage:
    // when the worker's cron stalled, an 11-hour-old but perfectly renderable
    // forecast — hourly rows running days ahead — was refused here, so
    // loadCachedWeatherData returned null and users got the dead "Kan ikke nå
    // prognosen" screen instead of the forecast plus "Viser ældre data". Same
    // Older compatible stamps stay accepted so Worker and Pages can deploy
    // independently. A NEWER stamp is different: this client cannot know its
    // contract, so it must not render or overwrite the compatible last-good
    // local copy.
    if (isValidForecastPayload(parsed, location) && hasCurrentForecastWindow(parsed)) {
      if (parsed.sources.cacheHealth?.status === 'pending') {
        // A forced refresh returns the existing Worker cache with a transient
        // pending overlay. Keep the browser's completed snapshot on screen
        // during the 600ms button spinner; silent pickups below will apply the
        // completed health even when the forecast build itself does not change.
        // But never throw away a NEWER Worker forecast merely because its
        // health overlay is pending: that extended a cold-start stale flash
        // until the first pickup. Pending remains memory-only either way.
        const local = readLocalCachedWeatherData(location);
        if (!local) return { data: parsed, backgroundCheckScheduled };
        const localFetchedMs = Date.parse(local.sources.fetchedAt);
        const workerFetchedMs = Date.parse(parsed.sources.fetchedAt);
        return {
          data: workerFetchedMs > localFetchedMs ? parsed : local,
          backgroundCheckScheduled,
        };
      }
      saveCachedWeatherData(parsed, location);
      return { data: parsed, backgroundCheckScheduled };
    }
  } catch {
    return { data: null, backgroundCheckScheduled: false };
  } finally {
    // In the `finally`, not before the fetch. Setting it up front collapsed the
    // documented "in flight" state (undefined) into "attempted and not reached"
    // (null) for the whole duration of the request, so on every boot
    // deriveCacheStatus briefly concluded the worker was unreachable and the
    // status aria-label announced a refresh failure that had not happened.
    workerAttempted = true;
  }

  return { data: null, backgroundCheckScheduled: false };
}

export interface LoadCacheOptions {
  localOnly?: boolean;
  preferWorker?: boolean;
  forceWorkerRefresh?: boolean;
  allowColdWorkerBuild?: boolean;
}

// Where the payload came from, and therefore whether the worker was reachable.
//
// This is reported rather than inferred on purpose. Callers used to answer "did
// we reach the worker?" by reading the worker's OWN `lastAttemptAt` stamp out of
// the payload and comparing it to the clock — but that stamp is deliberately
// coarse (the worker persists it at most every 15 minutes to save KV writes, so
// it drifts to ~20), and the check tripped at 12. The result was an amber
// "Could not reach the forecast service" banner shown immediately after a
// perfectly successful fetch. The fetch layer knows the answer exactly; nothing
// downstream should be deducing it from someone else's throttled bookkeeping.
export type CacheSource = 'worker' | 'local' | null;

export interface LoadCacheResult {
  data: WeatherData | null;
  from: CacheSource;
  backgroundCheckScheduled?: boolean;
}

// Contact record for this browser session. Three states, and the difference
// between the last two matters:
//
//   undefined -> no attempt has finished yet (boot, in flight). Judge nothing.
//   null      -> an attempt finished and the worker was NOT reached.
//   number    -> the worker was last reached at this time.
//
// Collapsing the middle case into "unknown" would put the original bug straight
// back: boot with a dead worker but a live connection, fall back to the saved
// copy, and its stale `status:'current'` would render as a green "Checked".
let workerAttempted = false;
let lastWorkerContactMs: number | null = null;
export function getWorkerContactMs(): number | null | undefined {
  return workerAttempted ? lastWorkerContactMs : undefined;
}

export async function loadCachedWeatherData(
  location = CURRENT_LOCATION,
  options: LoadCacheOptions = {}
): Promise<LoadCacheResult> {
  if (options.localOnly) {
    const local = readLocalCachedWeatherData(location);
    return { data: local, from: local ? 'local' : null };
  }

  if (options.preferWorker) {
    // A saved forecast gives the user an immediate fallback, so retain the
    // shorter fjord-edge network deadline. With no local copy, allow the
    // Worker's one bounded cold build to complete instead of timing out in the
    // middle and leaving a first-time user on an avoidable error screen.
    const local = readLocalCachedWeatherData(location);
    const workerResult = await readWorkerCachedWeatherData(
      location,
      options.forceWorkerRefresh,
      local && !options.allowColdWorkerBuild
        ? CACHED_WORKER_FETCH_TIMEOUT_MS
        : COLD_WORKER_FETCH_TIMEOUT_MS,
    );
    if (workerResult.data) {
      lastWorkerContactMs = Date.now();
      return {
        data: workerResult.data,
        from: 'worker',
        ...(workerResult.backgroundCheckScheduled ? { backgroundCheckScheduled: true } : {}),
      };
    }

    return { data: local, from: local ? 'local' : null };
  }

  const local = readLocalCachedWeatherData(location);
  if (local) return { data: local, from: 'local' };

  const workerResult = await readWorkerCachedWeatherData(
    location,
    options.forceWorkerRefresh,
    COLD_WORKER_FETCH_TIMEOUT_MS,
  );
  if (workerResult.data) lastWorkerContactMs = Date.now();
  return {
    data: workerResult.data,
    from: workerResult.data ? 'worker' : null,
    ...(workerResult.backgroundCheckScheduled ? { backgroundCheckScheduled: true } : {}),
  };
}
