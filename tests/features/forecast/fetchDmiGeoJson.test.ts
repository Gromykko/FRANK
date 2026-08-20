import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchDmiGeoJson } from '../../../src/features/forecast/fetchForecast';
import { CURRENT_LOCATION } from '../../../src/config/locations';

// The dev-only DMI fetcher retries transient failures (429/5xx) but must give
// up immediately on a terminal 4xx. The bug this pins down: throwing the
// terminal error INSIDE the try meant its own catch swallowed it and the loop
// retried anyway, spending a second request on a hopeless 400/404.
function mockFetch(status: number) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: false,
    status,
    text: async () => 'nope',
    json: async () => ({}),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fetchDmiGeoJson', () => {
  it('gives up after ONE request on a terminal 4xx', async () => {
    const fetchMock = mockFetch(404);

    await expect(fetchDmiGeoJson('dkss_idw', ['water-temperature'], CURRENT_LOCATION)).rejects.toThrow(/404/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a 429 (DMI uses it for transient "server is busy")', async () => {
    const fetchMock = mockFetch(429);

    await expect(fetchDmiGeoJson('dkss_idw', ['water-temperature'], CURRENT_LOCATION)).rejects.toThrow(/429/);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  it('retries a 5xx', async () => {
    const fetchMock = mockFetch(503);

    await expect(fetchDmiGeoJson('dkss_idw', ['water-temperature'], CURRENT_LOCATION)).rejects.toThrow(/503/);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  it('returns the payload on success', async () => {
    const payload = { type: 'FeatureCollection', features: [] };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => payload,
    }));

    await expect(fetchDmiGeoJson('dkss_idw', ['water-temperature'], CURRENT_LOCATION)).resolves.toEqual(payload);
  });

  it('uses a native timeout signal that remains attached while the body is consumed', async () => {
    const payload = { type: 'FeatureCollection', features: [] };
    const timeoutSignal = new AbortController().signal;
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutSignal);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => payload,
    });
    vi.stubGlobal('fetch', fetchMock);

    await fetchDmiGeoJson('dkss_idw', ['water-temperature'], CURRENT_LOCATION);

    expect(timeout).toHaveBeenCalledWith(25_000);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ signal: timeoutSignal });
  });
});
