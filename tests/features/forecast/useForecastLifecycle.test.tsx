import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CURRENT_LOCATION } from '../../../src/config/locations';
import { FORECAST_PAYLOAD_VERSION } from '../../../src/features/forecast/types';
import type { WeatherData } from '../../../src/features/forecast/types';
import { saveCachedWeatherData } from '../../../src/features/forecast/cache';

vi.mock('../../../src/features/forecast/fetchForecast', () => ({
  CAN_FETCH_FRESH_FORECAST: false,
  fetchWeatherData: vi.fn(),
}));

import { useForecast } from '../../../src/features/forecast/useForecast';

let host: HTMLDivElement;
let root: Root;
let latest: ReturnType<typeof useForecast> | undefined;

function forecast(): WeatherData {
  const now = Date.now();
  const fetchedAt = new Date(now - 60_000).toISOString();
  return {
    hourly: [{
      time: new Date(now + 60 * 60_000).toISOString(),
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
    }],
    sunrise: [],
    sunset: [],
    sources: {
      payloadVersion: FORECAST_PAYLOAD_VERSION,
      weather: 'MET Norway Locationforecast',
      waves: 'DMI WAM',
      water: 'DMI DKSS',
      coordinate: CURRENT_LOCATION.coordinate,
      location: {
        id: CURRENT_LOCATION.id,
        name: CURRENT_LOCATION.name,
        areaName: CURRENT_LOCATION.areaName,
      },
      fetchedAt,
      cacheHealth: { status: 'current', lastAttemptAt: fetchedAt },
    },
  };
}

function Harness() {
  latest = useForecast(true);
  return null;
}

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
});

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  latest = undefined;
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('useForecast startup lifecycle', () => {
  it('makes exactly one normal Worker request when no local forecast exists', async () => {
    const payload = forecast();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => structuredClone(payload),
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(<Harness />);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestedUrl = String(fetchMock.mock.calls[0][0]);
    expect(requestedUrl).toContain(`/forecast/${CURRENT_LOCATION.id}?`);
    expect(requestedUrl).not.toContain('refresh=1');
    expect(latest?.loading).toBe(false);
    expect(latest?.checkState).toBe('succeeded');
    expect(latest?.weatherData?.sources.fetchedAt).toBe(payload.sources.fetchedAt);
  });

  it('also uses one normal Worker request when it first renders a local snapshot', async () => {
    const local = forecast();
    local.sources.fetchedAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    local.sources.cacheHealth = { status: 'current', lastAttemptAt: local.sources.fetchedAt };
    saveCachedWeatherData(local, CURRENT_LOCATION);

    const worker = forecast();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => structuredClone(worker),
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(<Harness />);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('refresh=1');
    expect(latest?.checkState).toBe('succeeded');
    expect(latest?.weatherData?.sources.fetchedAt).toBe(worker.sources.fetchedAt);
  });
});
