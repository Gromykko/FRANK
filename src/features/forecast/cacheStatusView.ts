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
}

// Turns the worker's cacheHealth into the header's label/detail/tone. Pure and
// unit-tested so the exact user-facing wording is pinned (a busy provider must
// read calmly, never as a red "Refresh failed", and never lead with an
// alarming "hours old"). Kept out of App.tsx, which can't be driven into these
// states in a test (the build embeds a static forecast cache).
export function getCacheStatusView({ refreshing, cacheHealth, checkedAtLabel, offline, savedAtLabel }: CacheStatusInput, translate: Translate = interpolate): CacheStatusView {
  const status = cacheHealth?.status;
  const isStale = status === 'stale' || status === 'fallback';
  // Offline takes precedence: a green "Checked" would be dishonest with no
  // connection (nothing was just checked). But offline isn't a data problem —
  // the saved forecast may be perfectly recent — so that case reads as calm
  // neutral. If the cache underneath is already stale/fallback, keep its amber
  // warning: losing the connection must not visually improve old data.
  if (offline) {
    return {
      label: translate('Offline'),
      detail: isStale
        ? (savedAtLabel ? translate('Showing your older saved forecast from {0}', savedAtLabel) : translate('Showing your older saved forecast'))
        : (savedAtLabel ? translate('Showing your saved forecast from {0}', savedAtLabel) : translate('Showing your saved forecast')),
      tone: isStale ? 'watch' : 'neutral',
      partiallyDegraded: false,
      providerBusy: false,
      busyServiceName: '',
      degradedLabel: '',
    };
  }

  const isPending = status === 'pending';
  const providerBusy = Boolean(cacheHealth?.providerBusy);

  const busyServiceName = translate(cacheHealth?.busyProvider === 'weather'
    ? 'Weather service'
    : cacheHealth?.busyProvider === 'marine'
      ? 'Waves & water service'
      : 'Forecast services');

  const degraded = cacheHealth?.degradedSources ?? [];
  const marineDegraded = degraded.includes('water') || degraded.includes('waves');
  const weatherDegraded = degraded.includes('weather');
  const degradedLabel = weatherDegraded && marineDegraded
    ? translate('weather, waves & water')
    : weatherDegraded ? translate('weather')
      : marineDegraded ? translate('waves & water')
        : '';
  // The named cause on the partial line ("· marine service busy" etc.).
  const causeService = translate(weatherDegraded && marineDegraded
    ? 'services'
    : weatherDegraded ? 'weather service'
      : 'marine service');
  const hasDegraded = degradedLabel !== '';
  const partiallyDegraded = !isStale && !refreshing && !isPending && hasDegraded;

  // A refresh in flight is neutral - not a problem, not a settled result;
  // the answer follows in a moment. Otherwise amber for any degraded/stale
  // data, green when all current.
  const tone: CacheStatusView['tone'] = refreshing
    ? 'neutral'
    : (isStale || hasDegraded || isPending) ? 'watch' : 'fresh';

  // The forecast time rides on the "Checked" label so a timestamp is always
  // visible; other states keep it in the detail line.
  const label = refreshing
    ? translate('Refreshing…')
    : isPending
      ? translate('Checking…')
      : isStale
        ? (providerBusy ? translate('{0} busy', busyServiceName) : translate('Couldn’t refresh'))
        : translate('Checked · {0}', checkedAtLabel);

  const detail = refreshing
    ? ''
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

function formatRelativeAge(ms: number, translate: Translate): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const minutes = Math.round(ms / 60000);
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
}, translate: Translate = interpolate): DerivedCacheStatus {
  const { sources, refreshing, online, nowMs, workerContactedAtMs } = args;

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
  const notActuallyChecked = workerContactedAtMs === undefined
    ? false
    : workerContactedAtMs === null
      ? true
      : nowMs - workerContactedAtMs > WORKER_CONTACT_STALE_MS;
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
  const cacheAgeMs = Number.isFinite(fetchedAtMs) ? nowMs - fetchedAtMs : Infinity;
  const dataStale = cacheAgeMs > CACHE_REFRESH_WARNING_AGE_MS;

  const cacheHealth = notActuallyChecked || dataStale
    ? { ...sources.cacheHealth, status: 'stale' as const, lastAttemptAt: checkedAt }
    : sources.cacheHealth;

  const status = cacheHealth?.status;
  const isPending = status === 'pending';
  const isStale = status === 'stale' || status === 'fallback';

  const showRefreshWarning = dataStale;
  // A payload stamped with an older version was built by outdated worker
  // logic — surface it instead of silently rendering mismatched data.
  const workerOutdated = (sources.payloadVersion ?? 0) < FORECAST_PAYLOAD_VERSION;

  const view = getCacheStatusView({
    refreshing,
    cacheHealth,
    checkedAtLabel: formatTime(checkedAt),
    offline: !online,
    savedAtLabel: formatTime(sources.fetchedAt),
  }, translate);
  const { providerBusy, busyServiceName, partiallyDegraded, degradedLabel } = view;

  const fetchedAtFull = formatDateTime(sources.fetchedAt);
  const expandedDetail = !online
    ? translate("You're offline, so FRANK is showing your last saved forecast from {0}. It will refresh on its own once you're back online.", fetchedAtFull)
    : isStale
      ? (providerBusy
        ? translate('{0} is busy right now, so the forecast could not be refreshed. FRANK is retrying automatically; you are seeing the last good forecast from {1}.', busyServiceName, fetchedAtFull)
        : translate('The forecast could not be refreshed on the last try ({0}); FRANK is retrying automatically. You are seeing the last good forecast from {1}.', formatTime(checkedAt), fetchedAtFull))
      : partiallyDegraded
        ? (providerBusy
          ? translate('Forecast from {0}; {1} is from an earlier update while its service was busy. FRANK is retrying automatically.', fetchedAtFull, degradedLabel)
          : translate('Forecast from {0}; {1} is from an earlier update (could not refresh just now). FRANK is retrying automatically.', fetchedAtFull, degradedLabel))
        : refreshing || isPending
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
