import type {
  CacheHealthOptions,
  CacheHealthStatus,
  ForecastData,
  WorkerCacheHealth,
} from './domain';

// Cache-health is mutable operational state attached to an immutable forecast
// generation. Keeping its copy/stamps here lets retry and status UX evolve
// without pretending the normalized forecast model changed.
export function buildCacheHealth(
  status: CacheHealthStatus,
  data: ForecastData | null | undefined,
  options: CacheHealthOptions = {},
  now = new Date(),
): WorkerCacheHealth {
  const previousHealth = data?.sources?.cacheHealth;
  const marineInstances = options.marineInstances ?? previousHealth?.marineInstances;
  const weatherExpires = options.weatherExpires ?? previousHealth?.weatherExpires;
  const weatherLastModified = options.weatherLastModified ?? previousHealth?.weatherLastModified;

  return {
    status,
    lastAttemptAt: options.preserveAttemptAt && previousHealth?.lastAttemptAt
      ? previousHealth.lastAttemptAt
      : now.toISOString(),
    ...(marineInstances ? { marineInstances } : {}),
    ...(weatherExpires ? { weatherExpires } : {}),
    ...(weatherLastModified ? { weatherLastModified } : {}),
    ...(options.message ? { message: options.message } : {}),
    ...(options.needsRebuild ? { needsRebuild: true } : {}),
    ...(options.checkedBy ? { checkedBy: options.checkedBy } : {}),
    ...(options.providerBusy ? { providerBusy: true } : {}),
    ...(options.busyProvider ? { busyProvider: options.busyProvider } : {}),
    ...(options.degradedSources?.length ? { degradedSources: options.degradedSources } : {}),
  };
}

export function withCacheHealth(
  data: ForecastData,
  status: CacheHealthStatus,
  options: CacheHealthOptions = {},
): ForecastData {
  return {
    ...data,
    sources: {
      ...data.sources,
      cacheHealth: buildCacheHealth(status, data, options),
    },
  };
}

