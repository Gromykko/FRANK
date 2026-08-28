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
  const marineGrid = options.marineGrid === null
    ? undefined
    : options.marineGrid ?? previousHealth?.marineGrid;
  const weatherExpires = options.weatherExpires ?? previousHealth?.weatherExpires;
  const weatherLastModified = options.weatherLastModified ?? previousHealth?.weatherLastModified;

  return {
    status,
    lastAttemptAt: options.preserveAttemptAt && previousHealth?.lastAttemptAt
      ? previousHealth.lastAttemptAt
      : now.toISOString(),
    ...(marineInstances ? { marineInstances } : {}),
    ...(marineGrid ? { marineGrid } : {}),
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

// Grid provenance is operator-only diagnostics. It is retained in the
// generation cache so /status can explain a DMI re-grid, but it must never
// become part of the public forecast or machine-health contracts.
export function withoutMarineGridDiagnostic(
  health: WorkerCacheHealth | undefined,
): WorkerCacheHealth | undefined {
  if (!health || !Object.prototype.hasOwnProperty.call(health, 'marineGrid')) return health;
  const publicHealth = { ...health };
  delete publicHealth.marineGrid;
  return publicHealth;
}
