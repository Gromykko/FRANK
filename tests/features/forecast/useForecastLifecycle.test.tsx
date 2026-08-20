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

import {
  COLD_MISS_PICKUP_DELAY_MS,
  useForecast,
} from '../../../src/features/forecast/useForecast';

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

function initializingResponse(retryAfterSeconds = 600) {
  return new Response(JSON.stringify({
    schemaVersion: 1,
    status: 'initializing',
    code: 'FORECAST_INITIALIZING',
    message: 'Forecast is being initialized.',
    retryAfterSeconds,
    location: {
      id: CURRENT_LOCATION.id,
      name: CURRENT_LOCATION.name,
      areaName: CURRENT_LOCATION.areaName,
    },
  }), {
    status: 503,
    headers: { 'Retry-After': String(retryAfterSeconds) },
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
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
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('useForecast startup lifecycle', () => {
  it('boots into a dedicated initialization state for a valid first-build response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(initializingResponse());
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(<Harness />);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(latest?.loading).toBe(false);
    expect(latest?.weatherData).toBeNull();
    expect(latest?.error).toBeNull();
    expect(latest?.checkState).toBe('initializing');
    expect(latest?.initialization).toMatchObject({
      schemaVersion: 1,
      status: 'initializing',
      location: { id: CURRENT_LOCATION.id },
      retryAfterSeconds: 600,
    });
  });

  it('recovers automatically when the first complete location forecast becomes ready', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-08-20T10:15:00.000Z');
    const ready = forecast();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(initializingResponse())
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => structuredClone(ready),
      });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(<Harness />);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(latest?.checkState).toBe('initializing');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(599_999);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(latest?.initialization).toBeNull();
    expect(latest?.weatherData?.sources.fetchedAt).toBe(ready.sources.fetchedAt);
    expect(latest?.checkState).toBe('succeeded');
  });

  it('does not let focus bypass Retry-After and retries promptly once an overdue offline location comes online', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-08-20T10:15:00.000Z');
    let online = true;
    vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online);
    const ready = forecast();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(initializingResponse())
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => structuredClone(ready),
      });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(<Harness />);
      await vi.advanceTimersByTimeAsync(0);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    online = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(540_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    online = true;
    await act(async () => {
      window.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(latest?.initialization).toBeNull();
    expect(latest?.checkState).toBe('succeeded');
  });

  it('allows a manual initialization check without sending duplicate rapid requests', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-08-20T10:15:00.000Z');
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(initializingResponse()));
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(<Harness />);
      await vi.advanceTimersByTimeAsync(0);
    });

    await act(async () => {
      const first = latest!.refreshForecast(false, true);
      const duplicate = latest!.refreshForecast(false, true);
      await vi.advanceTimersByTimeAsync(600);
      await Promise.all([first, duplicate]);
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(latest?.checkState).toBe('initializing');
  });

  it('keeps a newer ready result when an older initialization response arrives late', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-08-20T10:15:00.000Z');
    const first = deferred<Response>();
    const ready = forecast();
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => structuredClone(ready),
      });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(<Harness />);
      await vi.advanceTimersByTimeAsync(0);
    });

    await act(async () => {
      const newer = latest!.refreshForecast(false, true);
      await vi.advanceTimersByTimeAsync(600);
      await newer;
    });
    expect(latest?.weatherData?.sources.fetchedAt).toBe(ready.sources.fetchedAt);

    await act(async () => {
      first.resolve(initializingResponse());
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(latest?.initialization).toBeNull();
    expect(latest?.weatherData?.sources.fetchedAt).toBe(ready.sources.fetchedAt);
    expect(latest?.checkState).toBe('succeeded');
  });

  it('does not let an older ready response erase a newer initialization state', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-08-20T10:15:00.000Z');
    const first = deferred<Response>();
    const ready = forecast();
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(initializingResponse());
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(<Harness />);
      await vi.advanceTimersByTimeAsync(0);
    });

    await act(async () => {
      const newer = latest!.refreshForecast(false, true);
      await vi.advanceTimersByTimeAsync(600);
      await newer;
    });
    expect(latest?.checkState).toBe('initializing');

    await act(async () => {
      first.resolve(new Response(JSON.stringify(ready), { status: 200 }));
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(latest?.weatherData).toBeNull();
    expect(latest?.initialization?.location.id).toBe(CURRENT_LOCATION.id);
    expect(latest?.checkState).toBe('initializing');
  });

  it('keeps initialization only for a classified network miss', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-08-20T10:15:00.000Z');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(initializingResponse())
      .mockRejectedValueOnce(new TypeError('network unavailable'));
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(<Harness />);
      await vi.advanceTimersByTimeAsync(0);
    });

    await act(async () => {
      const retry = latest!.refreshForecast(false, true);
      await vi.advanceTimersByTimeAsync(600);
      await retry;
    });

    expect(latest?.initialization?.location.id).toBe(CURRENT_LOCATION.id);
    expect(latest?.checkState).toBe('initializing');
    expect(latest?.error).toContain('keep trying automatically');
  });

  it('surfaces a malformed later 503 as a hard failure instead of calm initialization', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-08-20T10:15:00.000Z');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(initializingResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: 'initializing',
        code: 'FORECAST_INITIALIZING',
        retryAfterSeconds: 600,
        location: { id: CURRENT_LOCATION.id },
      }), { status: 503, headers: { 'Retry-After': '600' } }));
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(<Harness />);
      await vi.advanceTimersByTimeAsync(0);
    });

    await act(async () => {
      const retry = latest!.refreshForecast(false, true);
      await vi.advanceTimersByTimeAsync(600);
      await retry;
    });

    expect(latest?.initialization).toBeNull();
    expect(latest?.checkState).toBe('failed');
    expect(latest?.error).toContain('Could not refresh forecast data');
  });

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

  it('picks up a completed background check announced by the normal startup response', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-08-20T10:15:00.000Z');
    const initial = forecast();
    const completed = forecast();
    completed.sources.fetchedAt = new Date(Date.now() + 60_000).toISOString();
    completed.sources.cacheHealth = {
      status: 'current',
      lastAttemptAt: completed.sources.fetchedAt,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: (name: string) => name === 'X-FRANK-Background-Check' ? 'scheduled' : null },
        json: async () => structuredClone(initial),
      })
      .mockResolvedValue({
        ok: true,
        headers: { get: () => null },
        json: async () => structuredClone(completed),
      });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(<Harness />);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(latest?.weatherData?.sources.fetchedAt).toBe(completed.sources.fetchedAt);
    expect(latest?.checkState).toBe('succeeded');
  });

  it('clears a failed manual state when a later Worker pickup succeeds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-08-20T10:15:00.000Z');
    const local = forecast();
    saveCachedWeatherData(local, CURRENT_LOCATION);
    const recovered = forecast();
    recovered.sources.fetchedAt = new Date(Date.now() + 60_000).toISOString();
    recovered.sources.cacheHealth = {
      status: 'current',
      lastAttemptAt: recovered.sources.fetchedAt,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => null },
        json: async () => structuredClone(local),
      })
      .mockResolvedValueOnce({ ok: false, headers: { get: () => null } })
      .mockResolvedValue({
        ok: true,
        headers: { get: () => null },
        json: async () => structuredClone(recovered),
      });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(<Harness />);
      await vi.advanceTimersByTimeAsync(0);
    });

    await act(async () => {
      const refresh = latest!.refreshForecast(false, true, true);
      await vi.advanceTimersByTimeAsync(600);
      await refresh;
    });
    expect(latest?.checkState).toBe('failed');
    expect(latest?.error).toContain('Could not reach');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(latest?.weatherData?.sources.fetchedAt).toBe(recovered.sources.fetchedAt);
    expect(latest?.checkState).toBe('succeeded');
    expect(latest?.error).toBeNull();
  });

  it('recovers once after a local-backed startup misses a Worker cold build', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-08-20T10:15:00.000Z');
    const local = forecast();
    saveCachedWeatherData(local, CURRENT_LOCATION);
    const recovered = forecast();
    recovered.sources.fetchedAt = new Date(Date.now() + 60_000).toISOString();
    recovered.sources.cacheHealth = {
      status: 'current',
      lastAttemptAt: recovered.sources.fetchedAt,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, headers: { get: () => null } })
      .mockResolvedValue({
        ok: true,
        headers: { get: () => null },
        json: async () => structuredClone(recovered),
      });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(<Harness />);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(latest?.checkState).toBe('failed');
    expect(latest?.weatherData?.sources.fetchedAt).toBe(local.sources.fetchedAt);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(COLD_MISS_PICKUP_DELAY_MS - 1);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(latest?.weatherData?.sources.fetchedAt).toBe(recovered.sources.fetchedAt);
    expect(latest?.checkState).toBe('succeeded');
    expect(latest?.error).toBeNull();
  });
});
