import type { WeatherData } from './types';
import { FORECAST_PAYLOAD_VERSION } from './types';
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
  providerBusy: boolean;
  busyServiceName: string;
  degradedLabel: string;
}

export interface CacheStatusInput {
  refreshing: boolean;
  cacheHealth: WeatherData['sources']['cacheHealth'];
  checkedAtLabel: string; // formatTime(cacheCheckedAt)
  // The device has no connection right now (navigator.onLine === false).
  offline?: boolean;
  savedAtLabel?: string; // formatTime(fetchedAt) — the saved forecast's time
  savedAgeLabel?: string;
  // The app has been inactive long enough that it should verify again, but no
  // completed request has failed. This must never be worded as a failure.
  needsVerification?: boolean;
  // The Worker answered with the explicit FORECAST_INITIALIZING contract while
  // the browser still has a usable saved forecast to render.
  preparing?: boolean;
}

// Turns the worker's cacheHealth into the header's label/detail/tone. Pure and
// unit-tested so the exact user-facing wording is pinned (a busy provider must
// read calmly, never as a red "Refresh failed", and never lead with an
// alarming "hours old"). Kept out of App.tsx, which can't be driven into these
// states in a test (the build embeds a static forecast cache).
// How far ahead of this browser's clock a worker timestamp may sit before we
// stop believing it. Comfortably over ordinary clock drift and request latency,
// far under any staleness window.
const CLOCK_LEAD_TOLERANCE_MS = 5 * 60 * 1000;

export function getCacheStatusView({
  refreshing,
  cacheHealth,
  checkedAtLabel,
  offline,
  savedAtLabel,
  savedAgeLabel,
  needsVerification,
  preparing,
}: CacheStatusInput, translate: Translate = interpolate): CacheStatusView {
  const status = cacheHealth?.status;
  const isStale = status === 'stale' || status === 'fallback';
  const isPending = status === 'pending';
  const providerBusy = Boolean(cacheHealth?.providerBusy);

  const degraded = cacheHealth?.degradedSources ?? [];
  const hasWater = degraded.includes('water');
  const hasWaves = degraded.includes('waves');
  const hasWeather = degraded.includes('weather');

  const busyServiceName = translate(cacheHealth?.busyProvider === 'weather'
    ? 'Weather service'
    : cacheHealth?.busyProvider === 'marine'
      ? (hasWaves && !hasWater
        ? 'Wave service'
        : hasWater && !hasWaves
          ? 'Water level service'
          : 'Waves & water service')
      : 'Forecast services');

  const degradedLabel = hasWeather && hasWaves && hasWater
    ? translate('weather, waves & water')
    : hasWeather && hasWaves
      ? translate('weather & waves')
      : hasWeather && hasWater
        ? translate('weather & water')
        : hasWaves && hasWater
          ? translate('waves & water')
          : hasWeather
            ? translate('weather')
            : hasWaves
              ? translate('waves')
              : hasWater
                ? translate('water')
                : '';
  // The named cause on the partial line ("· marine service busy" etc.).
  const causeService = translate(hasWeather && (hasWaves || hasWater)
    ? 'services'
    : hasWeather
      ? 'weather service'
      : hasWaves && hasWater
        ? 'marine service'
        : hasWaves
          ? 'wave service'
          : hasWater
            ? 'water level service'
            : 'services');
  const hasDegraded = degradedLabel !== '';
  const partiallyDegraded = !isStale && !refreshing && !isPending && hasDegraded;

  // Offline takes precedence for the LABEL: a green "Checked" would be
  // dishonest with no connection, since nothing was just checked. But offline
  // is not by itself a data problem — the saved forecast may be perfectly
  // recent — so that case reads as calm neutral.
  //
  // Degradation still has to survive the trip. This block used to hard-code
  // partiallyDegraded/degradedLabel to empty, so a forecast carrying recycled
  // wave and water data rendered amber with "waves & water from an earlier
  // update" online, and neutral "Showing your saved forecast" the moment the
  // signal dropped. Losing connectivity visually IMPROVED the data, at the
  // fjord, for exactly the two readings that feed the safety verdict.
  //
  // providerBusy stays false deliberately: whether a provider is busy is a
  // statement about right now, and offline we cannot know. What the recycled
  // sources are is a fact about the bytes in hand, and that we do know.
  if (offline) {
    const staleOrDegraded = isStale || hasDegraded;
    return {
      label: translate('Offline'),
      detail: hasDegraded
        ? (savedAtLabel
          ? translate('Showing your saved forecast from {0} · {1} from an earlier update', savedAtLabel, degradedLabel)
          : translate('Showing your saved forecast · {0} from an earlier update', degradedLabel))
        : isStale
          ? (savedAtLabel ? translate('Showing your older saved forecast from {0}', savedAtLabel) : translate('Showing your older saved forecast'))
          : (savedAtLabel ? translate('Showing your saved forecast from {0}', savedAtLabel) : translate('Showing your saved forecast')),
      tone: staleOrDegraded ? 'watch' : 'neutral',
      partiallyDegraded: hasDegraded,
      providerBusy: false,
      busyServiceName: '',
      degradedLabel,
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
        : (isStale || hasDegraded || isPending) ? 'watch' : 'fresh';

  // The forecast time rides on the "Checked" label so a timestamp is always
  // visible; other states keep it in the detail line.
  const label = refreshing
    ? translate('Refreshing…')
    : preparing
      ? translate('Preparing update…')
      : needsVerification
        ? (savedAtLabel ? translate('Saved forecast · {0}', savedAtLabel) : translate('Saved forecast'))
        : isPending
          ? translate('Checking…')
          : isStale
            ? (providerBusy ? translate('{0} busy', busyServiceName) : translate('Couldn’t refresh'))
            : translate('Checked · {0}', checkedAtLabel);

  const detail = refreshing
    ? (isStale && savedAgeLabel
      ? translate('Showing saved forecast · {0} old', savedAgeLabel)
      : '')
    : preparing
      ? (savedAgeLabel
        ? translate('Showing saved forecast · {0} old', savedAgeLabel)
        : translate('Retrying automatically'))
      : needsVerification
        ? (isStale && savedAgeLabel
          ? translate('Showing saved forecast · {0} old', savedAgeLabel)
          : translate('Needs a new check'))
        : isPending
          ? ''
          : isStale
            ? (providerBusy
              ? translate('Retrying automatically · checked {0}', checkedAtLabel)
              : translate('Showing earlier data · last try {0}', checkedAtLabel))
            : partiallyDegraded
              // One calm line: what you're looking at + why. Named cause per the
              // confirmed wording ("· marine service busy").
              ? (providerBusy
                ? translate('{0} from an earlier update · {1} busy', degradedLabel, causeService)
                : translate('{0} from an earlier update · couldn’t refresh just now', degradedLabel))
              : '';

  return { label, detail, tone, partiallyDegraded, providerBusy, busyServiceName, degradedLabel };
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
  // " Last issue: …" suffix when the worker recorded a failure message.
  failureDetail: string;
  // Stale AND old enough (6h+) to warrant the amber page-level warning.
  showRefreshWarning: boolean;
  // Payload built by older worker logic than this client expects.
  workerOutdated: boolean;
  forecastAgeLabel: string;
  // ISO time of the worker's last cache check (falls back to fetchedAt).
  checkedAt: string;
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
  const checkedAt = sources.cacheHealth?.lastAttemptAt ?? sources.fetchedAt;
  const checkedAtMs = new Date(checkedAt).getTime();
  const checkDiffersFromData =
    Number.isFinite(checkedAtMs) && Number.isFinite(fetchedAtMs) && Math.abs(checkedAtMs - fetchedAtMs) > 90_000;

  // Freshness was taken entirely from the payload's own cacheHealth. But when
  // the worker is unreachable the client quietly falls back to the browser's
  // saved copy — which still carries the last GOOD payload's `status:'current'`.
  // The header then read a green "Checked · 09:14" at 14:50. `navigator.onLine`
  // doesn't help: it stays true behind a captive portal or a dead worker.
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

  const cacheHealth = completedFailure || dataStale
    ? { ...sources.cacheHealth, status: 'stale' as const, lastAttemptAt: checkedAt }
    : sources.cacheHealth;

  const status = cacheHealth?.status;
  const isPending = status === 'pending';
  const isStale = status === 'stale' || status === 'fallback';

  const attemptSettled = !needsVerification && (
    !hasExplicitCheckState
    || checkState === 'succeeded'
    || checkState === 'failed'
  );
  // While an online check is running, the compact amber status still says the
  // saved forecast is old. Reserve the large failure-style banner for a
  // settled result. Offline is known immediately and remains immediate.
  const showRefreshWarning = dataStale && (!online || (!refreshing && attemptSettled));
  // A payload stamped with an older version was built by outdated worker
  // logic — surface it instead of silently rendering mismatched data.
  // During an explicit preparation response, the saved forecast can naturally
  // be from the prior compatible contract. The single preparation status below
  // already explains that transition; a second "out of date" alert is noise.
  const workerOutdated = !isInitializing
    && (sources.payloadVersion ?? 0) < FORECAST_PAYLOAD_VERSION;

  const view = getCacheStatusView({
    refreshing,
    cacheHealth,
    checkedAtLabel: formatTime(checkedAt),
    offline: !online,
    savedAtLabel: formatTime(sources.fetchedAt),
    savedAgeLabel: formatRelativeAge(cacheAgeMs, translate),
    needsVerification,
    preparing: isInitializing,
  }, translate);
  const { providerBusy, busyServiceName, partiallyDegraded, degradedLabel } = view;

  const fetchedAtFull = formatDateTime(sources.fetchedAt);
  const expandedDetail = !online
    ? translate("You're offline, so FRANK is showing your last saved forecast from {0}. It will refresh on its own once you're back online.", fetchedAtFull)
    : refreshing
      ? (isStale
        ? translate('FRANK is updating now; meanwhile it is showing the saved forecast from {0}, which is {1} old.', fetchedAtFull, formatRelativeAge(cacheAgeMs, translate))
        : translate('Checking for a newer forecast'))
    : isInitializing
      ? translate('FRANK reached the forecast service, which is preparing a complete update. It will retry automatically; meanwhile you are seeing the saved forecast from {0}.', fetchedAtFull)
    : needsVerification
      ? translate('The saved forecast from {0} needs a new check.', fetchedAtFull)
    : isStale
      ? (providerBusy
        ? translate('{0} is busy right now, so the forecast could not be refreshed. FRANK is retrying automatically; you are seeing the last good forecast from {1}.', busyServiceName, fetchedAtFull)
        : translate('The forecast could not be refreshed on the last try ({0}); FRANK is retrying automatically. You are seeing the last good forecast from {1}.', formatTime(checkedAt), fetchedAtFull))
      : partiallyDegraded
        ? (providerBusy
          ? translate('Forecast from {0}; {1} is from an earlier update while its service was busy. FRANK is retrying automatically.', fetchedAtFull, degradedLabel)
          : translate('Forecast from {0}; {1} is from an earlier update (could not refresh just now). FRANK is retrying automatically.', fetchedAtFull, degradedLabel))
        : isPending
          ? translate('Checking for a newer forecast')
          : checkDiffersFromData
            ? translate('Forecast from {0}; cache checked {1}', fetchedAtFull, formatTime(checkedAt))
            : translate('Forecast from {0}', fetchedAtFull);

  return {
    view,
    expandedDetail,
    // Deliberately NOT surfaced: cacheHealth.message is an untranslated slice
    // of an upstream HTTP body, so it dropped raw English provider HTML into a
    // Danish safety banner. It stays in the payload for /health and the console.
    failureDetail: '',
    showRefreshWarning,
    workerOutdated,
    forecastAgeLabel: formatRelativeAge(cacheAgeMs, translate),
    checkedAt,
  };
}
