import type { WeatherData } from './types';

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

// One ordering contract protects both React state and the durable offline copy.
// A new build always wins; an old build never does. For the same build, only
// completed cache-health progress is relevant. Keeping this outside the hook
// prevents an edge/KV race from being rejected on screen but still saved over
// a newer local forecast.
export function shouldApplyForecastUpdate(current: WeatherData | null, incoming: WeatherData): boolean {
  if (!current) return true;

  const currentFetchedMs = Date.parse(current.sources.fetchedAt);
  const incomingFetchedMs = Date.parse(incoming.sources.fetchedAt);
  if (incomingFetchedMs > currentFetchedMs) return true;
  if (incomingFetchedMs < currentFetchedMs) return false;

  // A legacy unversioned copy and a versioned Worker response can represent
  // the same build timestamp. Prefer the more explicit compatible contract so
  // the durable cache naturally migrates forward; never downgrade it again.
  const currentVersion = current.sources.payloadVersion ?? 0;
  const incomingVersion = incoming.sources.payloadVersion ?? 0;
  if (incomingVersion > currentVersion) return true;
  if (incomingVersion < currentVersion) return false;

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
