import { AVAILABLE_LOCATIONS } from '../../config/locations';
import { FORECAST_WORKER_BASE } from './workerBase';

export interface ForecastAvailability {
  checkedAt: string;
  allLocationsReady: boolean;
  availableLocationIds: string[];
  readyLocationIds: string[];
  fallbackLocationIds: string[];
  missingLocationIds: string[];
}

const KNOWN_LOCATION_IDS = new Set(AVAILABLE_LOCATIONS.map(({ id }) => id));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseLocationIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every((id) => typeof id === 'string' && KNOWN_LOCATION_IDS.has(id))) return null;
  const unique = new Set(value);
  return unique.size === value.length ? [...unique] : null;
}

function isSubset(candidate: Set<string>, parent: Set<string>): boolean {
  return [...candidate].every((id) => parent.has(id));
}

// /health is public operational data, but it is still an external trust
// boundary. Only a complete, internally consistent partition of FRANK's local
// location manifest may influence which recovery choices are shown.
export function parseForecastAvailability(value: unknown): ForecastAvailability | null {
  if (!isRecord(value) || value.service !== 'frank-forecast') return null;
  if (typeof value.checkedAt !== 'string' || !Number.isFinite(Date.parse(value.checkedAt))) return null;
  if (!isRecord(value.release) || typeof value.release.allLocationsReady !== 'boolean') return null;

  const available = parseLocationIds(value.release.available);
  const ready = parseLocationIds(value.release.ready);
  const fallback = parseLocationIds(value.release.fallback);
  const missing = parseLocationIds(value.release.missing);
  if (!available || !ready || !fallback || !missing) return null;

  const availableSet = new Set(available);
  const readySet = new Set(ready);
  const fallbackSet = new Set(fallback);
  const missingSet = new Set(missing);
  const everyConfiguredLocationIsAccountedFor = AVAILABLE_LOCATIONS.every(({ id }) => (
    availableSet.has(id) !== missingSet.has(id)
  ));
  const readinessPartitionsAvailability = available.every((id) => (
    readySet.has(id) !== fallbackSet.has(id)
  ));

  if (
    available.length + missing.length !== AVAILABLE_LOCATIONS.length
    || !everyConfiguredLocationIsAccountedFor
    || !isSubset(readySet, availableSet)
    || !isSubset(fallbackSet, availableSet)
    || !readinessPartitionsAvailability
    || value.release.allLocationsReady !== (ready.length === AVAILABLE_LOCATIONS.length)
  ) return null;

  const inManifestOrder = (ids: Set<string>) => AVAILABLE_LOCATIONS
    .filter(({ id }) => ids.has(id))
    .map(({ id }) => id);

  return {
    checkedAt: value.checkedAt,
    allLocationsReady: value.release.allLocationsReady,
    availableLocationIds: inManifestOrder(availableSet),
    readyLocationIds: inManifestOrder(readySet),
    fallbackLocationIds: inManifestOrder(fallbackSet),
    missingLocationIds: inManifestOrder(missingSet),
  };
}

export async function fetchForecastAvailability(signal: AbortSignal): Promise<ForecastAvailability | null> {
  try {
    const response = await fetch(`${FORECAST_WORKER_BASE}/health`, {
      cache: 'no-store',
      signal,
    });
    // A healthy all-ready Worker returns 200. Partial recovery deliberately
    // returns 503, but carries the same typed readiness body.
    if (response.status !== 200 && response.status !== 503) return null;
    return parseForecastAvailability(await response.json());
  } catch {
    return null;
  }
}
