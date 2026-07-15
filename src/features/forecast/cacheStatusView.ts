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
  // Offline takes precedence: a green "Checked" would be dishonest with no
  // connection (nothing was just checked). But offline isn't a data problem —
  // the saved forecast may be perfectly recent — so it reads as a calm neutral
  // state ("showing your saved forecast"), not amber, not red.
  if (offline) {
    return {
      label: translate('Offline'),
      detail: savedAtLabel ? translate('Showing your saved forecast from {0}', savedAtLabel) : translate('Showing your saved forecast'),
      tone: 'neutral',
      partiallyDegraded: false,
      providerBusy: false,
      busyServiceName: '',
      degradedLabel: '',
    };
  }

  const status = cacheHealth?.status;
  const isPending = status === 'pending';
  const isStale = status === 'stale' || status === 'fallback';
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
}, translate: Translate = interpolate): DerivedCacheStatus {
  const { sources, refreshing, online, nowMs } = args;
  const cacheHealth = sources.cacheHealth;
  const status = cacheHealth?.status;
  const isPending = status === 'pending';
  const isStale = status === 'stale' || status === 'fallback';

  const fetchedAtMs = new Date(sources.fetchedAt).getTime();
  const checkedAt = cacheHealth?.lastAttemptAt ?? sources.fetchedAt;
  const checkedAtMs = new Date(checkedAt).getTime();
  const checkDiffersFromData =
    Number.isFinite(checkedAtMs) && Number.isFinite(fetchedAtMs) && Math.abs(checkedAtMs - fetchedAtMs) > 90_000;

  const cacheAgeMs = Number.isFinite(fetchedAtMs) ? nowMs - fetchedAtMs : Infinity;
  const showRefreshWarning = isStale && cacheAgeMs > CACHE_REFRESH_WARNING_AGE_MS;
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
    failureDetail: cacheHealth?.message ? translate(' Last issue: {0}', cacheHealth.message) : '',
    showRefreshWarning,
    workerOutdated,
    forecastAgeLabel: formatRelativeAge(cacheAgeMs, translate),
    checkedAt,
  };
}
