import { CURRENT_LOCATION } from '../../config/locations';
import type { ForecastLocation } from '../../config/locations';
import type { WeatherData } from './types';

const DEFAULT_FORECAST_WORKER_BASE = 'https://frank-forecast.alswatchs.workers.dev';
const WEATHER_CACHE_KEY_PREFIX = 'frank_weather_data_v2';
const WEATHER_CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

const FORECAST_WORKER_BASE = (import.meta.env.VITE_FORECAST_WORKER_BASE ?? DEFAULT_FORECAST_WORKER_BASE).replace(/\/$/, '');

function getWeatherCacheKey(location: ForecastLocation): string {
  return `${WEATHER_CACHE_KEY_PREFIX}_${location.id}`;
}

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

    const parsed = JSON.parse(raw);
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
    });

    if (!response.ok) return null;

    const parsed = await response.json();
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
