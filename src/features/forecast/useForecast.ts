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
function hourIndexForNow(hourly: WeatherData['hourly'], nowMs: number): number {
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
  const [error, setError] = useState<string | null>(null);
  const [selectedHourIndex, setSelectedHourIndex] = useState<number>(0);
  // 60s heartbeat: re-renders the consumer each minute so relative-age labels
  // ("Checked · 14:32", "2 hours old") stay current, and so `nowIndex` below
  // re-derives as the clock moves.
  const [minuteTick, setMinuteTick] = useState(0);

  const daylightOnlyRef = useRef(daylightOnly);
  const lastRefreshAttemptRef = useRef(0);
  // Silent post-refresh cache pickups (the worker rebuilds in the background)
  const pickupTimersRef = useRef<number[]>([]);
  useEffect(() => () => {
    pickupTimersRef.current.forEach((id) => window.clearTimeout(id));
  }, []);
  const hasWeatherDataRef = useRef(false);
  // Build time of the newest payload applied, so an out-of-order response
  // can't overwrite a fresher one (see applyWeatherData).
  const latestFetchedAtRef = useRef(-Infinity);
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
    // Refreshes overlap (the 10-min interval, focus/visibility, and the two
    // post-refresh pickups all race), and KV is last-write-wins across edge
    // nodes — so a later response can legitimately carry an OLDER build than
    // one already on screen. Without this the header's timestamp walks
    // backwards and a rebuilt forecast is replaced by the one it superseded.
    const incomingMs = Date.parse(data.sources.fetchedAt);
    if (Number.isFinite(incomingMs) && incomingMs < latestFetchedAtRef.current) return;
    if (Number.isFinite(incomingMs)) latestFetchedAtRef.current = incomingMs;

    setWeatherData(data);

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

    if (showBlockingLoader) {
      setLoading(true);
    } else {
      setRefreshing(true);
    }
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
        setError('Could not reach the forecast service — showing the last saved forecast.');
      }

      if (forceRemoteRefresh && !CAN_FETCH_FRESH_FORECAST) {

        // The worker answers a forced refresh from cache instantly and
        // rebuilds in the background. Pick the rebuilt forecast up with two
        // silent cache reads: +8s covers the common case, +30s the slowest
        // upstream; each is a plain ~0.5s GET that triggers nothing new.
        pickupTimersRef.current.forEach((id) => window.clearTimeout(id));
        pickupTimersRef.current = [8_000, 30_000].map((delayMs) =>
          window.setTimeout(async () => {
            try {
              const fresh = (await loadCachedWeatherData(CURRENT_LOCATION, { preferWorker: true })).data;
              if (fresh && fresh.sources.fetchedAt !== data.sources.fetchedAt) {
                applyWeatherData(fresh, daylightOnlyRef.current);
              }
            } catch {
              // The 10-minute auto-refresh remains the retry path.
            }
          }, delayMs));
      }
    } catch {
      if (showBlockingLoader || !hasWeatherDataRef.current) {
        setError((currentError) => currentError ?? 'Could not refresh forecast data. Showing the latest cached forecast if available.');
      }
    } finally {
      if (!showBlockingLoader && force) {
        const elapsed = Date.now() - startedAt;
        if (elapsed < MIN_MANUAL_SPINNER_MS) {
          await new Promise((resolve) => window.setTimeout(resolve, MIN_MANUAL_SPINNER_MS - elapsed));
        }
      }
      setLoading(false);
      setRefreshing(false);
    }
  }, [applyWeatherData]);

  useEffect(() => {
    let cancelled = false;

    async function bootForecast() {
      const cached = (await loadCachedWeatherData()).data;
      if (cancelled) return;

      const forceRemoteRefresh = true;

      if (cached) {
        applyWeatherData(cached, daylightOnlyRef.current);
        setLoading(false);
        await refreshForecast(false, true, forceRemoteRefresh);
      } else {
        await refreshForecast(true, true, forceRemoteRefresh);
      }
    }

    // A throw in here (a corrupt cached payload, an empty hourly array) would
    // otherwise be an unhandled rejection that leaves `loading` true forever —
    // an endless spinner with no way out. Surface the retryable error screen.
    bootForecast().catch(() => {
      if (cancelled) return;
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
    error,
    selectedHourIndex,
    setSelectedHourIndex,
    nowIndex,
    refreshForecast,
  };
}
