import type { WeatherData } from './types';
import { isPlausibleSourceTimestamp } from './temporalPolicy';

export interface ForecastOrderingOptions {
  // A completed, validated Worker response is authoritative about which data
  // generation production currently serves. This is intentionally narrower
  // than "always accept the network": within one generation, an older edge/KV
  // snapshot must still lose to newer bytes already on screen.
  incomingIsServerAuthority?: boolean;
  // A ready=false response is not proof of the Worker's target release. It may
  // fill an empty screen when structurally compatible, but it must not move an
  // already displayed exact generation backwards.
  incomingIsServerFallback?: boolean;
  nowMs?: number;
}

function forecastRepresentation(data: WeatherData): string {
  const release = data.sources.release;
  return [
    `api:${release.apiSchemaVersion}`,
    `model:${release.modelRevision}`,
    `generation:${release.dataGenerationId}`,
    `payload:${release.payloadVersion}`,
    `location-config:${data.sources.location.forecastConfigRevision}`,
  ].join(':');
}

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
export function shouldApplyForecastUpdate(
  current: WeatherData | null,
  incoming: WeatherData,
  options: ForecastOrderingOptions = {},
): boolean {
  if (!current) return true;

  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs as number : Date.now();
  const currentFetchedMs = Date.parse(current.sources.fetchedAt);
  const incomingFetchedMs = Date.parse(incoming.sources.fetchedAt);
  const currentTimestampPlausible = isPlausibleSourceTimestamp(currentFetchedMs, nowMs);
  const incomingTimestampPlausible = isPlausibleSourceTimestamp(incomingFetchedMs, nowMs);

  // A corrupt saved copy dated far in the future otherwise outranks every real
  // same-generation Worker response forever. Authority may replace it, while an
  // implausible incoming copy never displaces a plausible forecast.
  if (!currentTimestampPlausible && incomingTimestampPlausible) return true;
  if (currentTimestampPlausible && !incomingTimestampPlausible) return false;
  if (!currentTimestampPlausible && !incomingTimestampPlausible) return false;

  // A rollback is a valid generation change too. Do not infer authority from a
  // larger model number or newer fetchedAt: the Worker version currently at
  // 100% traffic is the source of truth. The browser cache records that choice
  // separately so the same generation also wins on the next offline boot.
  if (
    options.incomingIsServerAuthority
    && forecastRepresentation(current) !== forecastRepresentation(incoming)
  ) {
    return true;
  }
  if (
    options.incomingIsServerFallback
    && forecastRepresentation(current) !== forecastRepresentation(incoming)
  ) {
    return false;
  }

  if (incomingFetchedMs > currentFetchedMs) return true;
  if (incomingFetchedMs < currentFetchedMs) return false;

  const currentHealth = current.sources.cacheHealth;
  const incomingHealth = incoming.sources.cacheHealth;
  if (!incomingHealth && currentHealth) return false;
  if (cacheHealthSignature(current) === cacheHealthSignature(incoming)) return false;

  const currentAttemptMs = Date.parse(currentHealth?.lastAttemptAt ?? current.sources.fetchedAt);
  const incomingAttemptMs = Date.parse(incomingHealth?.lastAttemptAt ?? incoming.sources.fetchedAt);
  // Strictly later, not "later or equal". The worker stamps this from one
  // shared cron heartbeat, so two edge replicas of the same build now carry
  // byte-identical attempt times while differing in degradedSources - and
  // `>=` made each of them replace the other on every poll. The visible
  // symptom is a header flipping between green and amber, but the real cost
  // is that the durable offline copy flips too, so a paddler can go offline
  // holding the healthy-LOOKING variant of a build whose marine data is
  // recycled. On a tie we cannot tell which is newer, so we keep what we
  // have; a genuine update advances the stamp on the next tick anyway.
  return incomingAttemptMs > currentAttemptMs;
}
