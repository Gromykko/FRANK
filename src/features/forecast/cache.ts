import { CURRENT_LOCATION } from '../../config/locations';
import type { ForecastLocation } from '../../config/locations';
import type { WeatherData } from './types';
import { reviveReadings } from './normalize';

const DEFAULT_FORECAST_WORKER_BASE = 'https://frank-forecast.alswatchs.workers.dev';
const WEATHER_CACHE_KEY_PREFIX = 'frank_weather_data_v2';
const WEATHER_CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const WORKER_FETCH_TIMEOUT_MS = 12 * 1000;

const FORECAST_WORKER_BASE = (import.meta.env.VITE_FORECAST_WORKER_BASE ?? DEFAULT_FORECAST_WORKER_BASE).replace(/\/$/, '');

function getWeatherCacheKey(location: ForecastLocation): string {
  return `${WEATHER_CACHE_KEY_PREFIX}_${location.id}`;
}

// Deliberately does NOT check payloadVersion. The Worker is deployed by hand,
// separately from the client, so the client is routinely the newer of the two
// for a while after a release. Hard-rejecting an older stamp here turns that
// window into a dead "can't reach the forecast" screen for every user — worse
// than showing the last good forecast alongside the "worker out of date"
// banner that deriveCacheStatus raises for exactly this case.
function isWeatherData(value: unknown): value is WeatherData {
  const candidate = value as WeatherData | null;

  return Boolean(
    candidate &&
      Array.isArray(candidate.hourly) &&
      candidate.hourly.length > 0 &&
      Array.isArray(candidate.sunrise) &&
      Array.isArray(candidate.sunset) &&
      candidate.sources?.fetchedAt
  );
}

function hasCurrentForecastWindow(data: WeatherData): boolean {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  return data.hourly.some((hour) => new Date(hour.time).getTime() >= oneHourAgo);
}

function isCacheFreshEnough(data: WeatherData, maxAgeMs = WEATHER_CACHE_MAX_AGE_MS): boolean {
  const fetchedAt = new Date(data.sources.fetchedAt).getTime();
  return Number.isFinite(fetchedAt) && Date.now() - fetchedAt <= maxAgeMs && hasCurrentForecastWindow(data);
}

export function saveCachedWeatherData(data: WeatherData, location: ForecastLocation) {
  try {
    localStorage.setItem(getWeatherCacheKey(location), JSON.stringify(data));
  } catch {
    // Forecast caching is a speed optimization; ignore storage failures.
  }
}

function readLocalCachedWeatherData(location: ForecastLocation): WeatherData | null {
  try {
    const raw = localStorage.getItem(getWeatherCacheKey(location));
    if (!raw) return null;

    const parsed = reviveReadings(JSON.parse(raw));
    if (isWeatherData(parsed) && isCacheFreshEnough(parsed)) {
      return parsed;
    }
  } catch {
    return null;
  }

  return null;
}

async function readWorkerCachedWeatherData(location: ForecastLocation, forceRefresh = false): Promise<WeatherData | null> {
  if (!FORECAST_WORKER_BASE) return null;

  try {
    const query = new URLSearchParams({
      cacheBust: String(Date.now()),
    });

    if (forceRefresh) {
      query.set('refresh', '1');
    }

    const response = await fetch(`${FORECAST_WORKER_BASE}/forecast/${location.id}?${query.toString()}`, {
      cache: 'no-store',
      // Kayakers open this on fjord-edge mobile signal, where a socket can
      // stay open indefinitely without ever answering. Without a deadline the
      // preferWorker path never falls through to the saved forecast and the
      // app just spins — the one moment a cached answer matters most.
      signal: AbortSignal.timeout(WORKER_FETCH_TIMEOUT_MS),
    });

    if (!response.ok) return null;

    const parsed = reviveReadings(await response.json());
    // USABILITY, not freshness: does this payload still cover the hours the app
    // needs to render? How OLD it is belongs to the status layer, which reports
    // it honestly (deriveCacheStatus demotes the tone by wall clock, and the
    // page banner fires past 6 h).
    //
    // Gating this on the local copy's 6-hour age cap instead was a real outage:
    // when the worker's cron stalled, an 11-hour-old but perfectly renderable
    // forecast — hourly rows running days ahead — was refused here, so
    // loadCachedWeatherData returned null and users got the dead "Kan ikke nå
    // prognosen" screen instead of the forecast plus "Viser ældre data". Same
    // mistake the payloadVersion check already documents: degrading with a
    // warning beats failing shut.
    if (isWeatherData(parsed) && hasCurrentForecastWindow(parsed)) {
      saveCachedWeatherData(parsed, location);
      return parsed;
    }
  } catch {
    return null;
  }

  return null;
}

export interface LoadCacheOptions {
  preferWorker?: boolean;
  forceWorkerRefresh?: boolean;
}

export async function loadCachedWeatherData(
  location = CURRENT_LOCATION,
  options: LoadCacheOptions = {}
): Promise<WeatherData | null> {
  if (options.preferWorker) {
    const workerData = await readWorkerCachedWeatherData(location, options.forceWorkerRefresh);
    if (workerData) return workerData;

    return readLocalCachedWeatherData(location);
  }

  const local = readLocalCachedWeatherData(location);
  if (local) return local;

  return readWorkerCachedWeatherData(location, options.forceWorkerRefresh);
}
