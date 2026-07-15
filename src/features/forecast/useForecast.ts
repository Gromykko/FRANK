import { useCallback, useEffect, useRef, useState } from 'react';
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

// Owns the forecast lifecycle: boot from cache, background refreshes,
// clock ticks, and the selected/now hour indices. Layout stays in App.
export function useForecast(daylightOnly: boolean) {
  const [weatherData, setWeatherData] = useState<WeatherData | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedHourIndex, setSelectedHourIndex] = useState<number>(0);
  const [nowIndex, setNowIndex] = useState<number>(0);
  // 60s heartbeat: re-renders the consumer each minute so relative-age labels
  // ("Checked · 14:32", "2 hours old") stay current. The tick value itself is
  // unused — components read Date.now() fresh on each render.
  const [, setMinuteTick] = useState(0);

  const daylightOnlyRef = useRef(daylightOnly);
  const lastRefreshAttemptRef = useRef(0);
  // Silent post-refresh cache pickups (the worker rebuilds in the background)
  const pickupTimersRef = useRef<number[]>([]);
  useEffect(() => () => {
    pickupTimersRef.current.forEach((id) => window.clearTimeout(id));
  }, []);
  const hasWeatherDataRef = useRef(false);
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
    setWeatherData(data);

    const now = new Date();
    let closestIndex = 0;
    let minDiff = Infinity;

    for (let i = 0; i < data.hourly.length; i++) {
      const diff = Math.abs(new Date(data.hourly[i].time).getTime() - now.getTime());
      if (diff < minDiff) {
        minDiff = diff;
        closestIndex = i;
      }
    }

    let initialSelected = closestIndex;
    if (preferDaylight && !data.hourly[closestIndex].isDay) {
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
    setNowIndex(closestIndex);
  }, []);

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
      const data = CAN_FETCH_FRESH_FORECAST
        ? await fetchWeatherData()
        : await loadCachedWeatherData(CURRENT_LOCATION, { preferWorker: true, forceWorkerRefresh: forceRemoteRefresh });

      if (!data) {
        throw new Error('No forecast data is available yet.');
      }

      applyWeatherData(data, daylightOnlyRef.current);

      // A remote refresh that quietly fell back to the browser's saved copy
      // (worker unreachable) still "succeeds" above. If the payload's own
      // last-check stamp is far older than the worker's cadence allows, the
      // service wasn't actually reached — say so instead of showing a fresh-
      // looking "Checked" line.
      if (forceRemoteRefresh && !CAN_FETCH_FRESH_FORECAST) {
        const attemptAt = new Date(data.sources.cacheHealth?.lastAttemptAt ?? data.sources.fetchedAt).getTime();
        if (Number.isFinite(attemptAt) && Date.now() - attemptAt > 12 * 60 * 1000) {
          setError('Could not reach the forecast service — showing the last saved forecast.');
        }

        // The worker answers a forced refresh from cache instantly and
        // rebuilds in the background. Pick the rebuilt forecast up with two
        // silent cache reads: +8s covers the common case, +30s the slowest
        // upstream; each is a plain ~0.5s GET that triggers nothing new.
        pickupTimersRef.current.forEach((id) => window.clearTimeout(id));
        pickupTimersRef.current = [8_000, 30_000].map((delayMs) =>
          window.setTimeout(async () => {
            try {
              const fresh = await loadCachedWeatherData(CURRENT_LOCATION, { preferWorker: true });
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
      const cached = await loadCachedWeatherData();
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

    bootForecast();

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
