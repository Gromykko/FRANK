import { afterEach, describe, expect, it, vi } from 'vitest';
import { CURRENT_LOCATION } from '../../../src/config/locations';
import { deriveCacheStatus } from '../../../src/features/forecast/cacheStatusView';
import { loadCachedWeatherData, saveCachedWeatherData } from '../../../src/features/forecast/cache';
import type { HourlyData, WeatherData } from '../../../src/features/forecast/types';

const NOW = Date.parse('2026-08-12T12:00:00Z');

function hour(time: string, blockSpanHours?: number): HourlyData {
  return {
    time,
    tempAir: 17,
    precipitation: 0,
    symbolCode: 'clearsky_day',
    weatherCode: 0,
    windSpeed: 3,
    windDirection: 90,
    windGust: 4,
    waveHeight: 0.2,
    waveDirection: 90,
    wavePeriod: 3,
    tempWater: 16,
    tideLevel: 0,
    currentSpeed: 0,
    currentDirection: 0,
    isDay: true,
    blockSpanHours,
  };
}

function weatherData(hourly: HourlyData[]): WeatherData {
  const fetchedAt = new Date(NOW - 7 * 60 * 60 * 1000).toISOString();
  return {
    hourly,
    sunrise: [],
    sunset: [],
    sources: {
      payloadVersion: 6,
      weather: 'MET Norway Locationforecast',
      waves: 'DMI WAM',
      water: 'DMI DKSS',
      coordinate: CURRENT_LOCATION.coordinate,
      fetchedAt,
      cacheHealth: { status: 'current', lastAttemptAt: fetchedAt },
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('browser forecast cache recovery', () => {
  it('loads a forecast built over six hours ago when it still has future hours', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const cached = weatherData([hour(new Date(NOW + 60 * 60 * 1000).toISOString())]);
    saveCachedWeatherData(cached, CURRENT_LOCATION);

    const loaded = await loadCachedWeatherData(CURRENT_LOCATION);

    expect(loaded.from).toBe('local');
    expect(loaded.data?.sources.fetchedAt).toBe(cached.sources.fetchedAt);
    expect(fetchMock).not.toHaveBeenCalled();

    // Loading and freshness are intentionally separate: the useful saved
    // forecast renders, while the existing six-hour warning remains active.
    const status = deriveCacheStatus({
      sources: loaded.data!.sources,
      refreshing: false,
      online: false,
      nowMs: NOW,
      workerContactedAtMs: null,
    });
    expect(status.showRefreshWarning).toBe(true);
    expect(status.forecastAgeLabel).toBe('7 h');
  });

  it('recognises a longer-range block that still spans the current time', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const blockStart = new Date(NOW - 5 * 60 * 60 * 1000).toISOString();
    saveCachedWeatherData(weatherData([hour(blockStart, 6)]), CURRENT_LOCATION);

    const loaded = await loadCachedWeatherData(CURRENT_LOCATION);

    expect(loaded.from).toBe('local');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects saved data whose forecast window has fully elapsed', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const fetchMock = vi.fn().mockResolvedValue({ ok: false });
    vi.stubGlobal('fetch', fetchMock);
    const elapsedHour = new Date(NOW - 2 * 60 * 60 * 1000).toISOString();
    saveCachedWeatherData(weatherData([hour(elapsedHour)]), CURRENT_LOCATION);

    const loaded = await loadCachedWeatherData(CURRENT_LOCATION);

    expect(loaded).toEqual({ data: null, from: null });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
