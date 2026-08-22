import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CURRENT_LOCATION } from '../../config/locations';
import type { WeatherData } from './types';
import { loadCachedWeatherData } from './cache';
import { shouldApplyForecastUpdate } from './forecastOrdering';
import type { ForecastInitialization } from './initialization';

export { shouldApplyForecastUpdate } from './forecastOrdering';

const AUTO_REFRESH_MS = 10 * 60 * 1000;
const AUTO_REFRESH_THROTTLE_MS = 60 * 1000;
export const INITIALIZATION_RETRY_MIN_MS = AUTO_REFRESH_THROTTLE_MS;
export const INITIALIZATION_RETRY_MAX_MS = 10 * 60 * 1000;
const INITIALIZATION_MANUAL_RETRY_THROTTLE_MS = 5 * 1000;
// A manual refresh that resolves instantly (worker gate, fast cache hit)
// still shows the spinner briefly — a button that does nothing visible
// reads as broken.
const MIN_MANUAL_SPINNER_MS = 600;
export type ForecastCheckState = 'not-started' | 'checking' | 'initializing' | 'succeeded' | 'failed';

export interface ForecastInitializationState extends ForecastInitialization {
  nextRetryAtMs: number;
}

export function boundedInitializationRetryMs(retryAfterSeconds: number): number {
  return Math.min(
    INITIALIZATION_RETRY_MAX_MS,
    Math.max(INITIALIZATION_RETRY_MIN_MS, retryAfterSeconds * 1_000),
  );
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
// While offline and hidden, nothing else will wake the initialization retry:
// every listener is behind a visibility gate. Slow enough to cost nothing in a
// pocket, fast enough that a returning signal is noticed without the user.
const OFFLINE_RETRY_POLL_MS = 60_000;

export function useForecast(daylightOnly: boolean) {
  const [weatherData, setWeatherData] = useState<WeatherData | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [checkState, setCheckState] = useState<ForecastCheckState>('not-started');
  const [error, setError] = useState<string | null>(null);
  const [initialization, setInitialization] = useState<ForecastInitializationState | null>(null);
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
  const initializationRef = useRef<ForecastInitializationState | null>(null);
  const initializationRetryTimerRef = useRef<number | null>(null);
  const lastInitializationManualRetryRef = useRef(0);
  useEffect(() => () => {
    if (initializationRetryTimerRef.current !== null) {
      window.clearTimeout(initializationRetryTimerRef.current);
    }
  }, []);
  const hasWeatherDataRef = useRef(false);
  // Exact payload last applied. Besides build ordering, this lets same-build
  // Prepared-snapshot refreshes can advance stable cache health without
  // resetting the user's selection.
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

  const applyWeatherData = useCallback((
    data: WeatherData,
    preferDaylight: boolean,
    incomingIsServerAuthority = false,
    incomingIsServerFallback = false,
  ) => {
    // Refreshes overlap (the 10-min interval, focus/visibility and manual
    // actions can race), and distributed cache reads may return an older build
    // nodes — so a later response can legitimately carry an OLDER build than
    // one already on screen. Without this the header's timestamp walks
    // backwards and a rebuilt forecast is replaced by the one it superseded.
    const previousData = latestWeatherDataRef.current;
    if (!shouldApplyForecastUpdate(previousData, data, {
      incomingIsServerAuthority,
      incomingIsServerFallback,
    })) return;
    latestWeatherDataRef.current = data;
    hasWeatherDataRef.current = true;

    setWeatherData(data);

    // A health-only refresh represents the same immutable forecast build. It
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

  const rememberInitialization = useCallback((details: ForecastInitialization) => {
    const next: ForecastInitializationState = {
      ...details,
      nextRetryAtMs: Date.now() + boundedInitializationRetryMs(details.retryAfterSeconds),
    };
    initializationRef.current = next;
    setInitialization(next);
  }, []);

  const rescheduleInitialization = useCallback(() => {
    const current = initializationRef.current;
    if (!current) return;
    rememberInitialization(current);
  }, [rememberInitialization]);

  const clearInitialization = useCallback(() => {
    initializationRef.current = null;
    setInitialization(null);
    if (initializationRetryTimerRef.current !== null) {
      window.clearTimeout(initializationRetryTimerRef.current);
      initializationRetryTimerRef.current = null;
    }
  }, []);

  // Derived from the clock, not stored at apply-time. As state it only moved
  // when new data arrived, so with the worker unreachable "now" froze at the
  // hour the app was opened: the timeline's now-marker sat hours in the past
  // and findLaunchWindows kept offering windows that had already closed. The
  // 60s heartbeat is the input, so this now advances on its own.
  const nowMs = useMemo(() => {
    // minuteTick is an intentional invalidation signal for the wall clock.
    void minuteTick;
    return Date.now();
  }, [minuteTick]);
  const nowIndex = useMemo(() => {
    const hourly = weatherData?.hourly;
    if (!hourly || hourly.length === 0) return 0;
    return hourIndexForNow(hourly, nowMs);
  }, [weatherData, nowMs]);

  // Everything downstream assumes the selection is at or ahead of "now"
  // (WeatherCharts derives a non-negative offset from it). Now that nowIndex
  // advances between refreshes, carry the selection forward with it.
  useEffect(() => {
    setSelectedHourIndex((idx) => (idx < nowIndex ? nowIndex : idx));
  }, [nowIndex]);

  const refreshForecast = useCallback(async (
    showBlockingLoader: boolean,
    force = false,
    forceRemoteRefresh = false,
  ) => {
    const startedAt = Date.now();
    const currentInitialization = initializationRef.current;
    if (!force && currentInitialization && startedAt < currentInitialization.nextRetryAtMs) {
      return;
    }
    if (force && currentInitialization) {
      if (startedAt - lastInitializationManualRetryRef.current < INITIALIZATION_MANUAL_RETRY_THROTTLE_MS) {
        return;
      }
      lastInitializationManualRetryRef.current = startedAt;
    }
    if (!showBlockingLoader && !force && startedAt - lastRefreshAttemptRef.current < AUTO_REFRESH_THROTTLE_MS) {
      return;
    }

    if (initializationRetryTimerRef.current !== null) {
      window.clearTimeout(initializationRetryTimerRef.current);
      initializationRetryTimerRef.current = null;
    }

    // Normal dashboard refresh taps remain client-ungated: the Worker answers
    // from cache and owns the upstream gate. First-build taps are the exception
    // above: a short 5s client guard prevents an eager user from hammering an
    // endpoint that has explicitly asked them to wait.
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
      const loaded = await loadCachedWeatherData(CURRENT_LOCATION, { preferWorker: true });
      const data = loaded.data;

      if (!data) {
        if (loaded.initialization) {
          if (checkSequence !== checkSequenceRef.current) return;
          rememberInitialization(loaded.initialization);
          settledState = 'initializing';
          return;
        }

        if (
          initializationRef.current
          && loaded.failureKind === 'network'
          && checkSequence === checkSequenceRef.current
        ) {
          // The Worker never answered: retain the already-confirmed first-build
          // explanation and schedule one more bounded check. A real HTTP
          // response with the wrong contract is handled as a hard failure
          // below; it must not be disguised as ordinary initialization.
          rescheduleInitialization();
          settledState = 'initializing';
          settledError = 'The latest preparation check did not finish. FRANK will keep trying automatically.';
          return;
        }

        if (initializationRef.current && checkSequence === checkSequenceRef.current) {
          clearInitialization();
        }
        throw new Error('No forecast data is available yet.');
      }

      if (checkSequence !== checkSequenceRef.current) return;

      if (loaded.initialization) {
        // A valid initialization response is successful contact with the
        // Worker, even when we keep rendering a saved forecast underneath it.
        // Retain the retry contract and one calm lifecycle state instead of
        // turning `from: local` into a false settled refresh failure.
        rememberInitialization(loaded.initialization);
        applyWeatherData(
          data,
          daylightOnlyRef.current,
          loaded.serverAuthority === true,
          loaded.serverFallback === true,
        );
        settledState = 'initializing';
        return;
      }

      clearInitialization();
      applyWeatherData(
        data,
        daylightOnlyRef.current,
        loaded.serverAuthority === true,
        loaded.serverFallback === true,
      );
      settledState = loaded.from === 'worker'
        ? 'succeeded'
        : 'failed';

      // A remote refresh that quietly fell back to the browser's saved copy
      // (worker unreachable) still "succeeds" above, so say so.
      //
      // This asks the fetch layer, which KNOWS. It used to compare the worker's
      // own operational `lastAttemptAt` stamp against a 12-minute bound. Even
      // with the newer anomaly-aware heartbeat overlay, that is not evidence of
      // this browser's request, so an ordinary cold boot could show "Could not
      // reach the forecast service" seconds after reaching it perfectly well.
      // Never re-derive a fact the fetch layer already knows exactly.
      if (forceRemoteRefresh && loaded.from === 'local') {
        settledError = loaded.failureKind === 'network'
          ? 'Could not reach the forecast service — showing the last saved forecast.'
          : 'Could not refresh forecast data. Showing the latest cached forecast if available.';
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
  }, [applyWeatherData, clearInitialization, rememberInitialization, rescheduleInitialization]);

  useEffect(() => {
    if (!initialization) return;

    const delayMs = Math.max(0, initialization.nextRetryAtMs - Date.now());
    initializationRetryTimerRef.current = window.setTimeout(() => {
      initializationRetryTimerRef.current = null;
      // Going offline is an event, not a provider failure. Leave the due time
      // in the past so the online/focus listener below can retry immediately
      // when connectivity returns instead of making the user wait another full
      // provider interval.
      //
      // But do not simply stop. Handing recovery to the listeners assumed one
      // of them would fire, and all three run through refreshWhenVisible, which
      // returns unless the tab is visible. Cold start on a location the worker
      // is still preparing, phone pocketed so the tab is hidden, timer fires
      // during a signal dropout: connectivity returns seconds later, the online
      // event is discarded by the visibility gate, and no timer exists any more.
      // The app then sits on the preparing screen until the user happens to
      // foreground it. Keep a slow poll alive so it recovers on its own.
      if (navigator.onLine === false) {
        initializationRetryTimerRef.current = window.setTimeout(() => {
          initializationRetryTimerRef.current = null;
          if (navigator.onLine === false) return;
          void refreshForecast(false);
        }, OFFLINE_RETRY_POLL_MS);
        return;
      }
      void refreshForecast(false);
    }, delayMs);

    return () => {
      if (initializationRetryTimerRef.current !== null) {
        window.clearTimeout(initializationRetryTimerRef.current);
        initializationRetryTimerRef.current = null;
      }
    };
  }, [initialization, refreshForecast]);

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
        // normal endpoint reads the latest completed snapshot. Provider work
        // belongs only to cron and the zero-traffic release warm-up;
        // This is a user-visible prepared-snapshot re-read, never a build trigger.
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
    window.addEventListener('online', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);

    return () => {
      window.removeEventListener('focus', refreshWhenVisible);
      window.removeEventListener('online', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [refreshForecast]);

  return {
    weatherData,
    loading,
    refreshing,
    checkState,
    error,
    initialization,
    selectedHourIndex,
    setSelectedHourIndex,
    nowMs,
    nowIndex,
    refreshForecast,
  };
}
