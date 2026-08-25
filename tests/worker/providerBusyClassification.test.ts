import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchLatestMarineInstancesMock = vi.hoisted(() => vi.fn());

vi.mock('../../worker/providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../worker/providers')>();
  return {
    ...actual,
    fetchLatestMarineInstances: fetchLatestMarineInstancesMock,
  };
});

import worker, { tickOrder } from '../../worker/index';
import type { ForecastLocation } from '../../src/config/locationTypes';
import type { ForecastData } from '../../worker/domain';
import {
  assembledForecastKey,
  marineIngredientKey,
  metRawKey,
} from '../../worker/generation';
import { ProviderUnavailableError } from '../../worker/providerAvailability';
import { completeMarineEnvelope } from './marineTestData';

const NOW = Date.parse('2031-08-23T11:59:00.000Z');
const FORECAST_HOUR = '2031-08-23T13:00:00.000Z';
const RETAINED_RUN = '2031-08-23T000000Z';
const CURRENT_LOGGING_RUN = '2031-08-23T060000Z';
const originalFetch = globalThis.fetch;

function retainedMarineIngredient(
  location: ForecastLocation,
  kind: 'water' | 'waves',
  runId = RETAINED_RUN,
) {
  return completeMarineEnvelope(location, kind, runId);
}

function metBody() {
  return {
    properties: {
      timeseries: [{
        time: FORECAST_HOUR,
        data: {
          instant: {
            details: {
              air_temperature: 15,
              wind_speed: 2,
              wind_speed_of_gust: 3,
              wind_from_direction: 180,
            },
          },
          next_1_hours: {
            summary: { symbol_code: 'clearsky_day' },
            details: { precipitation_amount: 0 },
          },
        },
      }],
    },
  };
}

function metResponse(): Response {
  return Response.json(metBody(), {
    headers: {
      Expires: new Date(NOW + 60 * 60_000).toUTCString(),
      'Last-Modified': new Date(NOW).toUTCString(),
    },
  });
}

function upstreamAttemptEvents(
  calls: readonly (readonly unknown[])[],
): Record<string, unknown>[] {
  return calls.flatMap(([message]) => {
    if (typeof message !== 'string' || !message.startsWith('{')) return [];
    try {
      const value: unknown = JSON.parse(message);
      return typeof value === 'object'
        && value !== null
        && Reflect.get(value, 'event') === 'upstream_attempt'
        ? [value as Record<string, unknown>]
        : [];
    } catch {
      return [];
    }
  });
}

function loggingRuntime(location: ForecastLocation) {
  const lastModified = new Date(NOW - 60 * 60_000).toUTCString();
  const store = new Map<string, string>([
    [
      marineIngredientKey(location, 'water'),
      JSON.stringify(retainedMarineIngredient(location, 'water', CURRENT_LOGGING_RUN)),
    ],
    [
      marineIngredientKey(location, 'waves'),
      JSON.stringify(retainedMarineIngredient(location, 'waves', CURRENT_LOGGING_RUN)),
    ],
    [
      metRawKey(location),
      JSON.stringify({
        locationId: location.id,
        forecastConfigRevision: location.forecastConfigRevision,
        lastModified,
        body: metBody(),
      }),
    ],
  ]);
  const env = {
    FRANK_FORECAST_CACHE: {
      async get(key: string, type?: string) {
        const raw = store.get(key);
        if (raw === undefined) return null;
        return type === 'json' ? JSON.parse(raw) : raw;
      },
      async put(key: string, value: string) {
        store.set(key, value);
      },
    },
  };
  return { env, store };
}

function resolvedMarineProbe(location: ForecastLocation) {
  return {
    instances: {
      water: { collection: location.dmiCollections.water[0], id: CURRENT_LOGGING_RUN },
      waves: { collection: location.dmiCollections.waves[0], id: CURRENT_LOGGING_RUN },
    },
    substituted: [],
    catalogueContacted: true,
    manifestResolved: [],
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  fetchLatestMarineInstancesMock.mockReset();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('built fallback provider-busy classification', () => {
  it('keeps a non-429 marine probe failure degraded without calling it busy', async () => {
    const scheduledTime = NOW;
    const location = tickOrder(scheduledTime)[0];
    const store = new Map<string, string>([
      [
        marineIngredientKey(location, 'water'),
        JSON.stringify(retainedMarineIngredient(location, 'water')),
      ],
      [
        marineIngredientKey(location, 'waves'),
        JSON.stringify(retainedMarineIngredient(location, 'waves')),
      ],
    ]);
    const env = {
      FRANK_FORECAST_CACHE: {
        async get(key: string, type?: string) {
          const raw = store.get(key);
          if (raw === undefined) return null;
          return type === 'json' ? JSON.parse(raw) : raw;
        },
        async put(key: string, value: string) {
          store.set(key, value);
        },
      },
    };
    fetchLatestMarineInstancesMock.mockRejectedValue(
      new ProviderUnavailableError(
        'marine',
        'DMI marine catalogue failed with HTTP 500.',
        undefined,
        false,
      ),
    );
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('api.met.no/')) return metResponse();
      if (url.includes('feeds.meteoalarm.org/')) {
        return new Response('<feed></feed>', { status: 200 });
      }
      throw new Error(`Unexpected provider URL: ${url}`);
    }) as typeof fetch;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await worker.scheduled(
      { scheduledTime } as ScheduledController,
      env as Env,
      {} as ExecutionContext,
    );

    expect(fetchLatestMarineInstancesMock).toHaveBeenCalledOnce();
    const stored = store.get(assembledForecastKey(location));
    expect(stored).toBeDefined();
    const forecast = JSON.parse(stored!) as ForecastData;
    expect(forecast.sources.cacheHealth).toMatchObject({
      status: 'current',
      degradedSources: ['water', 'waves'],
      message: expect.stringContaining('marine run schedule'),
    });
    expect(forecast.sources.cacheHealth).not.toHaveProperty('providerBusy');
    expect(forecast.sources.cacheHealth).not.toHaveProperty('busyProvider');
  });

  it('classifies a catalogue 429 at the time its response crosses the grace boundary', async () => {
    const scheduledTime = Date.parse('2031-08-23T09:49:59.999Z');
    const graceBoundary = Date.parse('2031-08-23T09:50:00.000Z');
    const location = tickOrder(scheduledTime)[0];
    const store = new Map<string, string>([
      [
        marineIngredientKey(location, 'water'),
        JSON.stringify(retainedMarineIngredient(location, 'water', RETAINED_RUN)),
      ],
      [
        marineIngredientKey(location, 'waves'),
        JSON.stringify(retainedMarineIngredient(location, 'waves', CURRENT_LOGGING_RUN)),
      ],
    ]);
    const env = {
      FRANK_FORECAST_CACHE: {
        async get(key: string, type?: string) {
          const raw = store.get(key);
          if (raw === undefined) return null;
          return type === 'json' ? JSON.parse(raw) : raw;
        },
        async put(key: string, value: string) {
          store.set(key, value);
        },
      },
    };
    fetchLatestMarineInstancesMock.mockImplementation(async () => {
      vi.setSystemTime(graceBoundary);
      throw new ProviderUnavailableError(
        'marine',
        'DMI marine catalogue returned a verified 429.',
        undefined,
        true,
      );
    });
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('api.met.no/')) {
        return Response.json(metBody(), {
          headers: {
            Expires: new Date(graceBoundary + 60 * 60_000).toUTCString(),
            'Last-Modified': new Date(graceBoundary).toUTCString(),
          },
        });
      }
      if (url.includes('feeds.meteoalarm.org/')) {
        return new Response('<feed></feed>', { status: 200 });
      }
      throw new Error(`Unexpected provider URL: ${url}`);
    }) as typeof fetch;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.setSystemTime(scheduledTime);
    await worker.scheduled(
      { scheduledTime } as ScheduledController,
      env as Env,
      {} as ExecutionContext,
    );

    const stored = store.get(assembledForecastKey(location));
    expect(stored).toBeDefined();
    const forecast = JSON.parse(stored!) as ForecastData;
    expect(forecast.sources.cacheHealth).toMatchObject({
      status: 'current',
      degradedSources: ['water'],
      providerBusy: true,
      busyProvider: 'marine',
    });
  });
});

describe('provider attempt logging', () => {
  it('records a MET timeout without logging its error message', async () => {
    const scheduledTime = NOW;
    const location = tickOrder(scheduledTime)[0];
    const { env, store } = loggingRuntime(location);
    const sentinel = 'MET_TIMEOUT_SECRET_SENTINEL';
    const timeout = Object.assign(new Error(sentinel), { name: 'TimeoutError' });
    fetchLatestMarineInstancesMock.mockResolvedValue(resolvedMarineProbe(location));
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('api.met.no/')) throw timeout;
      if (url.includes('feeds.meteoalarm.org/')) {
        return new Response('<feed></feed>', { status: 200 });
      }
      throw new Error(`Unexpected provider URL: ${url}`);
    }) as typeof fetch;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await worker.scheduled(
      { scheduledTime } as ScheduledController,
      env as Env,
      {} as ExecutionContext,
    );

    expect(upstreamAttemptEvents(log.mock.calls)
      .filter(({ source }) => source === `met:${location.id}`)).toEqual([
      expect.objectContaining({
        provider: 'weather',
        source: `met:${location.id}`,
        attempt: 1,
        requestStarted: true,
        outcome: 'timeout',
        httpStatus: null,
      }),
    ]);
    const stored = store.get(assembledForecastKey(location));
    expect(stored).toBeDefined();
    const forecast = JSON.parse(stored!) as ForecastData;
    expect(forecast.sources.cacheHealth?.degradedSources).toEqual(['weather']);
    const emitted = JSON.stringify([log.mock.calls, warn.mock.calls, error.mock.calls]);
    expect(emitted).not.toContain(sentinel);
    expect(emitted).not.toContain('providerMessage');
  });

  it('drains a MET HTTP error body without emitting a second body log', async () => {
    const scheduledTime = NOW;
    const location = tickOrder(scheduledTime)[0];
    const { env, store } = loggingRuntime(location);
    const sentinel = 'MET_RESPONSE_BODY_SECRET_SENTINEL';
    const response = new Response(sentinel, { status: 503 });
    const bodyRead = vi.spyOn(response, 'text');
    fetchLatestMarineInstancesMock.mockResolvedValue(resolvedMarineProbe(location));
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('api.met.no/')) return response;
      if (url.includes('feeds.meteoalarm.org/')) {
        return new Response('<feed></feed>', { status: 200 });
      }
      throw new Error(`Unexpected provider URL: ${url}`);
    }) as typeof fetch;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await worker.scheduled(
      { scheduledTime } as ScheduledController,
      env as Env,
      {} as ExecutionContext,
    );

    expect(bodyRead).toHaveBeenCalledOnce();
    expect(upstreamAttemptEvents(log.mock.calls)
      .filter(({ source }) => source === `met:${location.id}`)).toEqual([
      expect.objectContaining({
        provider: 'weather',
        source: `met:${location.id}`,
        attempt: 1,
        outcome: 'http-503',
        httpStatus: 503,
      }),
    ]);
    const stored = store.get(assembledForecastKey(location));
    expect(stored).toBeDefined();
    const forecast = JSON.parse(stored!) as ForecastData;
    expect(forecast.sources.cacheHealth?.degradedSources).toEqual(['weather']);
    const emitted = JSON.stringify([log.mock.calls, warn.mock.calls, error.mock.calls]);
    expect(emitted).not.toContain(sentinel);
    expect(emitted).not.toContain('providerMessage');
    expect(emitted).not.toContain('upstream_http_error');
  });
});
