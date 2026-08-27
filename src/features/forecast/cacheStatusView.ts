import type { WeatherData } from './types';
import { formatDateTime, formatTime } from '../../utils/date';
import { interpolate } from '../../i18n/interpolate';
import type { Translate } from '../../i18n/interpolate';

export interface CacheStatusView {
  label: string;
  detail: string;
  // Never red: if the status line renders at all, we have a forecast to show,
  // so worst case is amber. "No forecast at all" is the app's error screen.
  // 'neutral' is the in-flight refresh (not a problem, not a settled state).
  tone: 'fresh' | 'watch' | 'neutral';
  // A partial (last-good) build that is otherwise current.
  partiallyDegraded: boolean;
  // Presentation-only status detail for a partial last-good build. It is never
  // an input to the safety verdict.
  degradedSourceDisclosure: string;
}

export interface CacheStatusInput {
  refreshing: boolean;
  cacheHealth: WeatherData['sources']['cacheHealth'];
  forecastAtLabel: string; // formatTime(fetchedAt)
  // The device has no connection right now (navigator.onLine === false).
  offline?: boolean;
  forecastAgeLabel?: string;
  // The app has been inactive long enough that it should verify again, but no
  // completed request has failed. This must never be worded as a failure.
  needsVerification?: boolean;
  // The Worker answered with the explicit FORECAST_INITIALIZING contract while
  // the browser still has a usable saved forecast to render.
  preparing?: boolean;
  // A completed refresh actually failed. Age alone can make a forecast stale,
  // but it is not evidence that a request failed.
  refreshFailed?: boolean;
}

// Turns the worker's cacheHealth into the header's label/detail/tone. Pure and
// unit-tested so the exact user-facing wording is pinned. A partial update names
// the delayed forecast source, not the provider's operational failure mode;
// provider diagnostics belong on /status. Kept out of App.tsx, which can't be
// driven into these states in a test (the build embeds a static forecast cache).
// How far ahead of this browser's clock a worker timestamp may sit before we
// stop believing it. Comfortably over ordinary clock drift and request latency,
// far under any staleness window.
const CLOCK_LEAD_TOLERANCE_MS = 5 * 60 * 1000;

function delayedForecastUpdate(
  degraded: readonly string[],
  translate: Translate,
): string {
  const hasWater = degraded.includes('water');
  const hasWaves = degraded.includes('waves');
  const hasWeather = degraded.includes('weather');
  const delayedSources = [
    hasWeather ? translate('wind') : '',
    hasWater && hasWaves
      ? translate('marine data')
      : hasWater
        ? translate('water level')
        : '',
    hasWaves && !hasWater ? translate('waves') : '',
  ].filter(Boolean);

  return delayedSources.length > 0
    ? translate('Delayed update: {0}', delayedSources.join(' + '))
    : '';
}

export function getCacheStatusView({
  refreshing,
  cacheHealth,
  forecastAtLabel,
  offline,
  forecastAgeLabel,
  needsVerification,
  preparing,
  refreshFailed,
}: CacheStatusInput, translate: Translate = interpolate): CacheStatusView {
  const status = cacheHealth?.status;
  const isStale = status === 'stale';
  const failedRefresh = refreshFailed ?? isStale;
  const degraded = cacheHealth?.degradedSources ?? [];

  const degradedUpdateDetail = delayedForecastUpdate(degraded, translate);
  const hasDegraded = degradedUpdateDetail !== '';
  const partiallyDegraded = !isStale && !refreshing && hasDegraded;
  const degradedSourceDisclosure = status === 'current' && hasDegraded
    ? degradedUpdateDetail
    : '';
  const savedForecastDetail = forecastAgeLabel
    ? translate('Saved forecast · {0} old', forecastAgeLabel)
    : translate('Saved forecast');

  // Offline takes precedence for the LABEL. But offline is not by itself a
  // data problem — the saved forecast may be perfectly recent — so that case
  // reads as calm neutral.
  //
  // Degradation still has to survive the trip. This block used to hard-code
  // partial-degradation state to empty, so a forecast carrying recycled
  // wave and water data rendered amber with "waves & water from an earlier
  // update" online, and a neutral saved-forecast status the moment the
  // signal dropped. Losing connectivity visually IMPROVED the data, at the
  // fjord, for exactly the two readings that feed the safety verdict.
  //
  // The delayed source is a fact about the bytes in hand. Provider cause is an
  // operator diagnostic and is deliberately never projected into this view.
  if (offline) {
    const staleOrDegraded = isStale || hasDegraded;
    return {
      label: translate('Offline'),
      detail: hasDegraded
        ? translate('{0} · {1}', savedForecastDetail, degradedUpdateDetail)
        : savedForecastDetail,
      tone: staleOrDegraded ? 'watch' : 'neutral',
      partiallyDegraded: hasDegraded,
      degradedSourceDisclosure,
    };
  }


  // Checking is not a failure, but genuinely old data does not become less old
  // because a request started. Keep that compact line amber and explicit while
  // withholding the large settled-failure banner.
  const tone: CacheStatusView['tone'] = refreshing
    ? (isStale ? 'watch' : 'neutral')
    : preparing
      ? (isStale ? 'watch' : 'neutral')
      : needsVerification
        ? (isStale ? 'watch' : 'neutral')
        : (isStale || hasDegraded) ? 'watch' : 'fresh';

  // The settled header names the forecast's own build time. Operational check
  // time belongs on /status; transient states keep forecast age in the detail.
  const updateInProgress = refreshing || preparing;
  const label = updateInProgress
    ? translate('Update in progress…')
    : needsVerification || (isStale && !failedRefresh)
      ? savedForecastDetail
      : isStale
        ? translate('Couldn’t refresh')
        : translate('Forecast from {0}', forecastAtLabel);

  const detail = updateInProgress
    ? (isStale || preparing ? savedForecastDetail : '')
    : needsVerification || (isStale && !failedRefresh)
      ? ''
      : isStale
        ? savedForecastDetail
        : partiallyDegraded
          // One calm, source-specific line. It deliberately names neither
          // the provider nor an inferred operational cause.
          ? degradedSourceDisclosure
          : '';

  return {
    label,
    detail,
    tone,
    partiallyDegraded,
    degradedSourceDisclosure,
  };
}

// Warn once the stale data is old enough to genuinely mislead a paddler.
const CACHE_REFRESH_WARNING_AGE_MS = 6 * 60 * 60 * 1000;

// How long since the browser last reached the worker before its status line stops
// claiming freshness. Measured against OUR OWN record of contact, not against the
// worker's `lastAttemptAt` stamp.
//
// The stamp version of this needed a comment explaining that it had to stay above
// the worker's KV write throttle plus a skipped cron tick, and it got that
// arithmetic wrong twice. Our own contact time carries no such coupling: it is
// exact, it is ours, and changing the worker's write policy cannot break it.
// 20 minutes is simply two auto-refresh intervals.
const WORKER_CONTACT_STALE_MS = 20 * 60 * 1000;

export type CacheCheckState = 'not-started' | 'checking' | 'initializing' | 'succeeded' | 'failed';

function formatRelativeAge(ms: number, translate: Translate): string {
  if (!Number.isFinite(ms)) return '';
  const safeMs = Math.max(0, ms);
  const minutes = Math.round(safeMs / 60000);
  if (minutes < 60) return translate('{0} min', minutes);
  const hours = Math.round(minutes / 60);
  if (hours < 48) return translate('{0} h', hours);
  return translate('{0} d', Math.round(hours / 24));
}

export interface DerivedCacheStatus {
  view: CacheStatusView;
  // The long-form sentence behind the status line (aria + expanded detail).
  expandedDetail: string;
  // Stale AND old enough (6h+) to warrant the amber page-level warning.
  showRefreshWarning: boolean;
  // Payload built by older worker logic than this client expects.
  forecastAgeLabel: string;
  // True only when a request or the Worker payload confirms a failed refresh.
  // A forecast can be old without this being true.
  refreshFailureConfirmed: boolean;
}

// Everything the header + warning banners need, derived in one pure place from
// the payload's sources block. App.tsx stays composition-only; this stays
// testable (the app build embeds a static forecast cache, so these states
// can't be exercised from the UI).
export function deriveCacheStatus(args: {
  sources: WeatherData['sources'];
  refreshing: boolean;
  online: boolean;
  nowMs: number;
  // When this browser last got an answer from the worker, or null if it never
  // has this session. Supplied by the fetch layer rather than read out of the
  // payload — see WORKER_CONTACT_STALE_MS.
  workerContactedAtMs?: number | null;
  // React-owned lifecycle of the latest request. Unlike contact age, this can
  // distinguish "the app was asleep" from "a request completed and failed".
  checkState?: CacheCheckState;
}, translate: Translate = interpolate): DerivedCacheStatus {
  const { sources, refreshing, online, nowMs, workerContactedAtMs, checkState } = args;
  const isInitializing = checkState === 'initializing';

  const fetchedAtMs = new Date(sources.fetchedAt).getTime();

  // Freshness was taken entirely from the payload's own cacheHealth. But when
  // the worker is unreachable the client quietly falls back to the browser's
  // saved copy — which still carries the last GOOD payload's `status:'current'`.
  // The header then presented the saved forecast as fresh at 14:50.
  // `navigator.onLine` doesn't help: it stays true behind a captive portal or
  // a dead worker.
  //
  // The honest test is whether WE have heard from the worker lately. Before, this
  // asked the payload's own throttled stamp instead, which coupled the client's
  // honesty to the worker's KV write budget and got the arithmetic wrong twice.
  // `undefined` means the caller doesn't track contact (tests, older callers), in
  // which case don't override anything.
  // undefined: no attempt has finished yet, so there is nothing to judge.
  // null: an attempt finished and the worker was not reached.
  const hasExplicitCheckState = checkState !== undefined;
  const completedFailure = hasExplicitCheckState
    ? checkState === 'failed'
    : workerContactedAtMs === null;
  const contactNeedsVerification = typeof workerContactedAtMs === 'number'
    && nowMs - workerContactedAtMs > WORKER_CONTACT_STALE_MS;
  const needsVerification = !completedFailure
    && (checkState === 'not-started' || contactNeedsVerification);
  // Old data is old, whatever the payload claims about itself. `fetchedAt` is
  // precise (it only moves on a real rebuild), so unlike the check stamp it can
  // be trusted arithmetically.
  //
  // This is a second, independent detector, and it exists because the contact
  // test above cannot see this failure: if the Worker exhausts its KV write
  // budget it stays perfectly reachable and keeps serving a payload still
  // stamped `status:'current'`, so contact is fresh and nothing looks wrong. The
  // forecast underneath simply stops advancing. MET reissues about every 30
  // minutes, so six hours without a rebuild is never normal.
  // A timestamp at or ahead of this browser's clock is not evidence of
  // freshness. Unfloored, `nowMs - fetchedAtMs` goes non-positive and dataStale
  // is false FOREVER: a phone whose clock is hours slow (manual setting, flat
  // RTC, wrong-year boot) renders a nine-hour-old forecast as green with no age
  // banner, and formatRelativeAge clamps the negative to a confident "0 min".
  // It is also the cheapest hostile-localStorage path on a shared github.io
  // origin - write a structurally valid payload dated year 3000 and it can
  // never be judged stale. The worker already refuses future stamps for exactly
  // this reason; the client had no equivalent.
  //
  // A little skew is ordinary, so tolerate a small lead and treat anything
  // beyond it as unusable rather than as fresh.
  const clockLeadMs = Number.isFinite(fetchedAtMs) ? fetchedAtMs - nowMs : Number.NaN;
  const cacheAgeMs = !Number.isFinite(clockLeadMs) || clockLeadMs > CLOCK_LEAD_TOLERANCE_MS
    ? Infinity
    : Math.max(0, -clockLeadMs);
  const dataStale = cacheAgeMs > CACHE_REFRESH_WARNING_AGE_MS;

  // Data being old and a refresh having FAILED are different facts, and the
  // heartbeat can now disprove the second one. Cron firing every five minutes
  // while the build pipeline stopped advancing fetchedAt eight hours ago used
  // to render "Couldn't refresh · last try 03:35" - naming a check that
  // happened minutes ago, and succeeded, as the one that failed. Worse, the
  // payload's providerBusy from an unrelated 429 hours earlier was carried
  // through, so it could read "Weather service busy": a present-tense claim
  // about a provider, asserted from stale bookkeeping, pointing an operator at
  // the wrong subsystem.
  //
  // Age alone still forces the amber and the banner - that part was right. It
  // just stops borrowing a cause it cannot support.
  const sourceStatus = sources.cacheHealth?.status;
  const sourceRefreshFailed = sourceStatus === 'stale';
  const refreshFailureConfirmed = completedFailure || sourceRefreshFailed;
  const staleFromAgeOnly = dataStale && !refreshFailureConfirmed;
  const cacheHealth = completedFailure || dataStale
    ? {
        ...sources.cacheHealth,
        status: 'stale' as const,
        lastAttemptAt: sources.cacheHealth?.lastAttemptAt ?? sources.fetchedAt,
        ...(staleFromAgeOnly
          ? { providerBusy: false, busyProvider: undefined, message: undefined }
          : {}),
      }
    : sources.cacheHealth;

  const status = cacheHealth?.status;
  const isStale = status === 'stale';

  const attemptSettled = !needsVerification && (
    !hasExplicitCheckState
    || checkState === 'succeeded'
    || checkState === 'failed'
  );
  // While an online check is running, the compact amber status still says the
  // saved forecast is old. Reserve the large failure-style banner for a
  // settled result. Offline is known immediately and remains immediate.
  const showRefreshWarning = dataStale && (!online || (!refreshing && attemptSettled));
  const view = getCacheStatusView({
    refreshing,
    cacheHealth,
    forecastAtLabel: Number.isFinite(fetchedAtMs) && clockLeadMs <= CLOCK_LEAD_TOLERANCE_MS
      ? formatTime(sources.fetchedAt)
      : '',
    offline: !online,
    forecastAgeLabel: formatRelativeAge(cacheAgeMs, translate),
    needsVerification,
    preparing: isInitializing,
    refreshFailed: refreshFailureConfirmed,
  }, translate);
  const { partiallyDegraded } = view;

  const fetchedAtFull = Number.isFinite(fetchedAtMs) && clockLeadMs <= CLOCK_LEAD_TOLERANCE_MS
    ? formatDateTime(sources.fetchedAt)
    : '';
  const showingSavedForecast = fetchedAtFull
    ? translate('Showing saved forecast from {0}.', fetchedAtFull)
    : translate('Showing saved forecast.');
  const showingForecast = fetchedAtFull
    ? translate('Showing forecast from {0}.', fetchedAtFull)
    : showingSavedForecast;
  const savedForecast = fetchedAtFull
    ? translate('Saved forecast from {0}.', fetchedAtFull)
    : translate('Saved forecast.');
  const delayedSourceDetail = delayedForecastUpdate(cacheHealth?.degradedSources ?? [], translate);
  const appendDegradedSource = (sentence: string, disclosure = view.degradedSourceDisclosure) => disclosure
    ? `${sentence} ${disclosure}.`
    : sentence;
  const expandedDetail = !online
    ? appendDegradedSource(translate('Offline · {0}', showingSavedForecast), delayedSourceDetail)
    : refreshing || isInitializing
      ? translate('Update in progress · {0}', isStale || isInitializing
        ? showingSavedForecast
        : showingForecast)
    : needsVerification || (isStale && !refreshFailureConfirmed)
      ? savedForecast
    : isStale && refreshFailureConfirmed
      ? translate('Couldn’t refresh · {0}', showingSavedForecast)
      : partiallyDegraded
        ? appendDegradedSource(translate('Forecast from {0}.', fetchedAtFull))
        : translate('Forecast from {0}.', fetchedAtFull);

  return {
    view,
    expandedDetail,
    showRefreshWarning,
    forecastAgeLabel: formatRelativeAge(cacheAgeMs, translate),
    refreshFailureConfirmed,
  };
}
