import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CURRENT_LOCATION } from '../../config/locations';
import type { WeatherData } from './types';
import { CAN_FETCH_FRESH_FORECAST, fetchWeatherData } from './fetchForecast';
import { loadCachedWeatherData } from './cache';

const AUTO_REFRESH_MS = 10 * 60 * 1000;
const AUTO_REFRESH_THROTTLE_MS = 60 * 1000;
// A manual refresh that resolves instantly (worker gate, fast cache hit)
// still shows the spinner briefly — a button that does nothing visible
// reads as broken.
const MIN_MANUAL_SPINNER_MS = 600;
// The Worker performs a manual rebuild in the background. Poll once near the
// common fast path, once after ordinary upstream latency, and once after the
// Worker's bounded 24s execution budget. No unbounded polling loop.
export const POST_REFRESH_PICKUP_DELAYS_MS = [2_000, 8_000, 30_000] as const;

export type ForecastCheckState = 'not-started' | 'checking' | 'succeeded' | 'failed';

const cacheHealthSignature = (data: WeatherData): string => {
  const health = data.sources.cacheHealth;
  if (!health) return '';
  return JSON.stringify({
    status: health.status,
    lastAttemptAt: health.lastAttemptAt,
    message: health.message ?? null,
    weatherExpires: health.weatherExpires ?? null,
    weatherLastModified: health.weatherLastModified ?? null,
    checkedBy: health.checkedBy ?? null,
    needsRebuild: health.needsRebuild ?? null,
    providerBusy: health.providerBusy ?? null,
    busyProvider: health.busyProvider ?? null,
    degradedSources: [...(health.degradedSources ?? [])].sort(),
  });
};

// Pure ordering contract for refresh/pickup races. A new build always wins; an
// old build never does. For the same build, only completed cache-health progress
// is relevant. This is what lets a no-rebuild/failure/gated check clear pending
// without allowing a late pending response to replace stable UI state.
export function shouldApplyForecastUpdate(current: WeatherData | null, incoming: WeatherData): boolean {
  if (!current) return true;

  const currentFetchedMs = Date.parse(current.sources.fetchedAt);
  const incomingFetchedMs = Date.parse(incoming.sources.fetchedAt);
  if (incomingFetchedMs > currentFetchedMs) return true;
  if (incomingFetchedMs < currentFetchedMs) return false;

  const currentHealth = current.sources.cacheHealth;
  const incomingHealth = incoming.sources.cacheHealth;
  if (incomingHealth?.status === 'pending' && currentHealth?.status !== 'pending') return false;
  if (!incomingHealth && currentHealth) return false;
  if (cacheHealthSignature(current) === cacheHealthSignature(incoming)) return false;
  if (currentHealth?.status === 'pending' && incomingHealth?.status !== 'pending') return true;

  const currentAttemptMs = Date.parse(currentHealth?.lastAttemptAt ?? current.sources.fetchedAt);
  const incomingAttemptMs = Date.parse(incomingHealth?.lastAttemptAt ?? incoming.sources.fetchedAt);
  return incomingAttemptMs >= currentAttemptMs;
}

// Which row is happening RIGHT NOW: the one whose span CONTAINS the clock, not
// the one whose start is nearest it. Nearest-start rounds up from :30 onward, so
// for half of every hour "now" pointed at the NEXT row — the snapshot described
// an hour that had not started, and the selection-clamp below then dragged the
// user's own choice there. Falls back to nearest when nothing contains the
// clock (the payload starts in the future, or has run out behind us).
//
// Containment, not `last row <= now`: the series legitimately has gaps (an hour
// with no marine sample within 90 minutes is dropped), and `last row <= now`
// would then answer with a PAST row, restarting the timeline behind itself.
export function hourIndexForNow(hourly: WeatherData['hourly'], nowMs: number): number {
  let nearest = 0;
  let minDiff = Infinity;
  let containing = -1;
  for (let i = 0; i < hourly.length; i++) {
    const startMs = new Date(hourly[i].time).getTime();
    if (!Number.isFinite(startMs)) continue;
    const spanMs = (hourly[i].blockSpanHours ?? 1) * 3_600_000;
    if (nowMs >= startMs && nowMs < startMs + spanMs) containing = i;
    const diff = Math.abs(startMs - nowMs);
    if (diff < minDiff) {
      minDiff = diff;
      nearest = i;
    }
  }
  return containing === -1 ? nearest : containing;
}

// Owns the forecast lifecycle: boot from cache, background refreshes,
// clock ticks, and the selected/now hour indices. Layout stays in App.
export function useForecast(daylightOnly: boolean) {
  const [weatherData, setWeatherData] = useState<WeatherData | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [checkState, setCheckState] = useState<ForecastCheckState>('not-started');
  const [error, setError] = useState<string | null>(null);
  const [selectedHourIndex, setSelectedHourIndex] = useState<number>(0);
  // 60s heartbeat: re-renders the consumer each minute so relative-age labels
  // ("Checked · 14:32", "2 hours old") stay current, and so `nowIndex` below
  // re-derives as the clock moves.
  const [minuteTick, setMinuteTick] = useState(0);

  const daylightOnlyRef = useRef(daylightOnly);
  const lastRefreshAttemptRef = useRef(0);
  // Only the newest overlapping request may settle the visible lifecycle.
  // Otherwise a slow older failure can overwrite a newer successful check.
  const checkSequenceRef = useRef(0);
  // Silent post-refresh cache pickups (the worker rebuilds in the background)
  const pickupTimersRef = useRef<number[]>([]);
  useEffect(() => () => {
    pickupTimersRef.current.forEach((id) => window.clearTimeout(id));
  }, []);
  const hasWeatherDataRef = useRef(false);
  // Exact payload last applied. Besides build ordering, this lets same-build
  // pickups advance stable cache health without resetting the user's selection.
  const latestWeatherDataRef = useRef<WeatherData | null>(null);
  // The timestamp of the hour the user is currently viewing, so background
  // refreshes can restore their selection instead of snapping back to "now".
  const selectedTimeRef = useRef<string | null>(null);

  useEffect(() => {
    daylightOnlyRef.current = daylightOnly;
  }, [daylightOnly]);

  useEffect(() => {
    hasWeatherDataRef.current = Boolean(weatherData);
  }, [weatherData]);

  useEffect(() => {
    if (weatherData) {
      selectedTimeRef.current = weatherData.hourly[selectedHourIndex]?.time ?? null;
    }
  }, [selectedHourIndex, weatherData]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setMinuteTick((t) => t + 1);
    }, 60 * 1000);

    return () => window.clearInterval(intervalId);
  }, []);

  const applyWeatherData = useCallback((data: WeatherData, preferDaylight: boolean) => {
    // Refreshes overlap (the 10-min interval, focus/visibility, and the bounded
    // post-refresh pickups all race), and KV is last-write-wins across edge
    // nodes — so a later response can legitimately carry an OLDER build than
    // one already on screen. Without this the header's timestamp walks
    // backwards and a rebuilt forecast is replaced by the one it superseded.
    const previousData = latestWeatherDataRef.current;
    if (!shouldApplyForecastUpdate(previousData, data)) return;
    latestWeatherDataRef.current = data;
    hasWeatherDataRef.current = true;

    setWeatherData(data);

    // A health-only pickup represents the same immutable forecast build. It
    // must update the status line without re-running now/daylight selection or
    // moving the hour the user chose.
    if (previousData?.sources.fetchedAt === data.sources.fetchedAt) return;

    // Same rule as the derived nowIndex below, so the hour selected on load is
    // the hour the header calls "now".
    const closestIndex = hourIndexForNow(data.hourly, Date.now());

    let initialSelected = closestIndex;
    // An empty payload leaves closestIndex pointing at nothing; the render path
    // has its own guard, but reading .isDay here would throw first.
    if (preferDaylight && data.hourly[closestIndex] && !data.hourly[closestIndex].isDay) {
      const firstDaylight = data.hourly.findIndex((h, idx) => idx >= closestIndex && h.isDay);
      if (firstDaylight !== -1) {
        initialSelected = firstDaylight;
      }
    }

    // On a background refresh, keep the hour the user was looking at if it
    // still exists in the new payload AND has not slipped into the past -
    // the timeline renders from "now", so a selection behind it would show
    // no highlight while the snapshot still described the stale hour.
    const previouslySelectedTime = selectedTimeRef.current;
    if (previouslySelectedTime) {
      const preservedIndex = data.hourly.findIndex((h) => h.time === previouslySelectedTime);
      if (preservedIndex >= closestIndex) {
        initialSelected = preservedIndex;
      }
    }

    setSelectedHourIndex(initialSelected);
    selectedTimeRef.current = data.hourly[initialSelected]?.time ?? null;
  }, []);

  // Derived from the clock, not stored at apply-time. As state it only moved
  // when new data arrived, so with the worker unreachable "now" froze at the
  // hour the app was opened: the timeline's now-marker sat hours in the past
  // and findLaunchWindows kept offering windows that had already closed. The
  // 60s heartbeat is the input, so this now advances on its own.
  const nowIndex = useMemo(() => {
    const hourly = weatherData?.hourly;
    if (!hourly || hourly.length === 0) return 0;
    return hourIndexForNow(hourly, Date.now());
    // minuteTick is not read in the body — it IS the input: the 60s heartbeat
    // is what makes "now" advance. Without it this memo would never recompute
    // between refreshes, which is the bug it exists to fix.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [weatherData, minuteTick]);

  // Everything downstream assumes the selection is at or ahead of "now"
  // (WeatherCharts derives a non-negative offset from it). Now that nowIndex
  // advances between refreshes, carry the selection forward with it.
  useEffect(() => {
    setSelectedHourIndex((idx) => (idx < nowIndex ? nowIndex : idx));
  }, [nowIndex]);

  const refreshForecast = useCallback(async (showBlockingLoader: boolean, force = false, forceRemoteRefresh = false) => {
    const startedAt = Date.now();
    if (!showBlockingLoader && !force && startedAt - lastRefreshAttemptRef.current < AUTO_REFRESH_THROTTLE_MS) {
      return;
    }

    // No client-side gate on forced taps: the worker answers instantly from
    // cache, stamps the attempt, and applies its own 20s/60s upstream gates.
    // A second throttle here only made "Last try" ignore the user's click.
    lastRefreshAttemptRef.current = startedAt;
    const checkSequence = ++checkSequenceRef.current;
    let settledState: Exclude<ForecastCheckState, 'not-started' | 'checking'> = 'failed';
    let settledError: string | null = null;

    if (showBlockingLoader) {
      setLoading(true);
    } else {
      setRefreshing(true);
    }
    setCheckState('checking');
    setError(null);

    try {
      const loaded = CAN_FETCH_FRESH_FORECAST
        ? { data: await fetchWeatherData(), from: 'worker' as const }
        : await loadCachedWeatherData(CURRENT_LOCATION, { preferWorker: true, forceWorkerRefresh: forceRemoteRefresh });
      const data = loaded.data;

      if (!data) {
        throw new Error('No forecast data is available yet.');
      }

      applyWeatherData(data, daylightOnlyRef.current);
      settledState = CAN_FETCH_FRESH_FORECAST || loaded.from === 'worker'
        ? 'succeeded'
        : 'failed';

      // A remote refresh that quietly fell back to the browser's saved copy
      // (worker unreachable) still "succeeds" above, so say so.
      //
      // This asks the fetch layer, which KNOWS. It used to compare the worker's
      // own `lastAttemptAt` stamp against a 12-minute bound — but that stamp is
      // persisted at most every 15 minutes to save KV writes and drifts to ~20,
      // so an ordinary cold boot could show "Could not reach the forecast
      // service" seconds after reaching it perfectly well. Never re-derive a
      // fact from someone else's throttled bookkeeping when the caller has it.
      if (forceRemoteRefresh && !CAN_FETCH_FRESH_FORECAST && loaded.from === 'local') {
        settledError = 'Could not reach the forecast service — showing the last saved forecast.';
      }

      if (forceRemoteRefresh && !CAN_FETCH_FRESH_FORECAST) {

        // The worker answers a forced refresh from cache instantly and rebuilds
        // in the background. Pending is response-only, so the completed status
        // is picked up silently starting around 2s, with one final bounded read
        // after the Worker's 24s execution budget.
        pickupTimersRef.current.forEach((id) => window.clearTimeout(id));
        pickupTimersRef.current = POST_REFRESH_PICKUP_DELAYS_MS.map((delayMs) =>
          window.setTimeout(async () => {
            try {
              const fresh = (await loadCachedWeatherData(CURRENT_LOCATION, { preferWorker: true })).data;
              if (fresh) applyWeatherData(fresh, daylightOnlyRef.current);
            } catch {
              // The 10-minute auto-refresh remains the retry path.
            }
          }, delayMs));
      }
    } catch {
      if (showBlockingLoader || !hasWeatherDataRef.current) {
        settledError = 'Could not refresh forecast data. Showing the latest cached forecast if available.';
      }
    } finally {
      if (!showBlockingLoader && force) {
        const elapsed = Date.now() - startedAt;
        if (elapsed < MIN_MANUAL_SPINNER_MS) {
          await new Promise((resolve) => window.setTimeout(resolve, MIN_MANUAL_SPINNER_MS - elapsed));
        }
      }
      if (checkSequence === checkSequenceRef.current) {
        setCheckState(settledState);
        setError(settledError);
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [applyWeatherData]);

  useEffect(() => {
    let cancelled = false;

    async function bootForecast() {
      setCheckState('checking');
      const cached = (await loadCachedWeatherData(CURRENT_LOCATION, { localOnly: true })).data;
      if (cancelled) return;

      if (cached) {
        applyWeatherData(cached, daylightOnlyRef.current);
        setLoading(false);
        // Startup asks once for the Worker's durable, completed snapshot. The
        // normal endpoint already schedules a due background check;
        // `?refresh=1` is reserved for an explicit user tap and its transient
        // pending state.
        await refreshForecast(false, false, false);
      } else {
        // localOnly above performs no I/O, so this is the one normal Worker
        // request on a true cold start.
        await refreshForecast(true, false, false);
      }
    }

    // A throw in here (a corrupt cached payload, an empty hourly array) would
    // otherwise be an unhandled rejection that leaves `loading` true forever —
    // an endless spinner with no way out. Surface the retryable error screen.
    bootForecast().catch(() => {
      if (cancelled) return;
      setCheckState('failed');
      setError('Could not refresh forecast data. Showing the latest cached forecast if available.');
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [applyWeatherData, refreshForecast]);

  // Steady 10-min cadence: keyed on WHETHER data exists, not the data itself —
  // depending on weatherData would tear the timer down on every refresh/pickup
  // and drift the schedule to "10 min after the last data change".
  const hasWeatherData = Boolean(weatherData);
  useEffect(() => {
    if (!hasWeatherData) return;

    const intervalId = window.setInterval(() => {
      void refreshForecast(false);
    }, AUTO_REFRESH_MS);

    return () => window.clearInterval(intervalId);
  }, [refreshForecast, hasWeatherData]);

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') {
        void refreshForecast(false);
      }
    };

    window.addEventListener('focus', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);

    return () => {
      window.removeEventListener('focus', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [refreshForecast]);

  return {
    weatherData,
    loading,
    refreshing,
    checkState,
    error,
    selectedHourIndex,
    setSelectedHourIndex,
    nowIndex,
    refreshForecast,
  };
}
