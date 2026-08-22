import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import locationData from '../../src/config/locations.json';
import {
  CRON_MARINE_POSITION_MAX_ATTEMPTS,
  CRON_PROVIDER_MAX_ATTEMPTS,
  CRON_SUBREQUEST_CALL_GRAPH,
  CRON_TICK_BUDGET_MS,
  CRON_WORST_CASE_EXTERNAL_SUBREQUESTS,
  EVENT_EXTERNAL_SUBREQUEST_BUDGET,
  cronExecutionPolicy,
  executionPolicy,
  ExternalSubrequestBudgetError,
} from '../../worker/execution';
import { dmiForecastUrl } from '../../worker/forecastModel';
import { fetchJsonWithRetries } from '../../worker/providerTransport';
import type { EventMemo } from '../../worker/domain';

const originalFetch = globalThis.fetch;
const POSITION_LOCATION = {
  coordinate: { latitude: 55.858, longitude: 9.905 },
};

function marinePositionUrl(collection: string): string {
  return dmiForecastUrl(
    collection,
    ['water-temperature'],
    POSITION_LOCATION,
    '2026-08-23T120000Z',
  );
}

function fullCronPolicy() {
  const now = Date.now();
  const policy = cronExecutionPolicy(now, now + CRON_TICK_BUDGET_MS, 1);
  if (!policy) throw new Error('Expected a cron policy for one full tick.');
  return policy;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('event external-subrequest budget', () => {
  it('accepts a marine position response after seven headerless 429s', async () => {
    let attempt = 0;
    const fetchMock = vi.fn(async () => {
      attempt += 1;
      if (attempt <= 7) {
        return new Response('Server is busy', { status: 429 });
      }
      return Response.json({ features: [] });
    });
    globalThis.fetch = fetchMock as typeof fetch;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(fetchJsonWithRetries(
      marinePositionUrl('dkss_idw'),
      'DMI dkss_idw',
      { ...fullCronPolicy(), retryBusyDelayMs: 0 },
      'marine',
      new Map(),
    )).resolves.toEqual({ features: [] });

    expect(fetchMock).toHaveBeenCalledTimes(8);
  });

  it('lets a marine position leg exhaust its larger cap after repeated headerless 429s', async () => {
    const fetchMock = vi.fn(async () =>
      new Response('Server is busy', { status: 429 }));
    globalThis.fetch = fetchMock as typeof fetch;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(fetchJsonWithRetries(
      marinePositionUrl('dkss_idw'),
      'DMI dkss_idw',
      { ...fullCronPolicy(), retryBusyDelayMs: 0 },
      'marine',
      new Map(),
    )).rejects.toThrow(/temporarily unavailable/i);

    expect(CRON_MARINE_POSITION_MAX_ATTEMPTS).toBeGreaterThan(CRON_PROVIDER_MAX_ATTEMPTS);
    expect(fetchMock).toHaveBeenCalledTimes(CRON_MARINE_POSITION_MAX_ATTEMPTS);
  });

  it.each([
    {
      stage: 'marine catalogue',
      url: 'https://opendataapi.dmi.dk/v2/forecastedr/collections/dkss_idw/instances',
      provider: 'marine' as const,
    },
    {
      stage: 'non-marine weather',
      url: 'https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=55.8580&lon=9.9050',
      provider: 'weather' as const,
    },
  ])('keeps the ordinary retry cap for the $stage stage', async ({ url, provider }) => {
    const fetchMock = vi.fn(async () =>
      new Response('temporary provider failure', { status: 503 }));
    globalThis.fetch = fetchMock as typeof fetch;
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(fetchJsonWithRetries(
      url,
      `${provider} stage`,
      { ...fullCronPolicy(), retryDelayMs: 0 },
      provider,
      new Map(),
    )).rejects.toThrow(/temporarily unavailable/i);

    expect(fetchMock).toHaveBeenCalledTimes(CRON_PROVIDER_MAX_ATTEMPTS);
  });

  it('ends a marine position retry immediately for an explicit long Retry-After', async () => {
    const fetchMock = vi.fn(async () =>
      new Response('Server is busy', {
        status: 429,
        headers: { 'Retry-After': '1200' },
      }));
    globalThis.fetch = fetchMock as typeof fetch;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(fetchJsonWithRetries(
      marinePositionUrl('wam_nsb'),
      'DMI wam_nsb',
      { ...fullCronPolicy(), retryBusyDelayMs: 0 },
      'marine',
      new Map(),
    )).rejects.toThrow(/temporarily unavailable/i);

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('keeps the audited one-city call-graph budget within the event ceiling', async () => {
    for (const location of locationData) {
      expect(Object.keys(location.dmiCollections)).toHaveLength(
        CRON_SUBREQUEST_CALL_GRAPH.marineKinds,
      );
      for (const collections of Object.values(location.dmiCollections)) {
        expect(collections.length).toBeLessThanOrEqual(
          CRON_SUBREQUEST_CALL_GRAPH.instanceCollectionsPerKind,
        );
      }
    }

    const warningSource = await readFile('src/features/forecast/parseWarnings.ts', 'utf8');
    const configuredWarningDetails = Number(
      warningSource.match(/const MAX_DETAIL_FETCHES = (\d+);/)?.[1],
    );
    expect(configuredWarningDetails).toBe(CRON_SUBREQUEST_CALL_GRAPH.warningDetails);

    const computedWorstCase =
      CRON_SUBREQUEST_CALL_GRAPH.marineKinds
        * CRON_SUBREQUEST_CALL_GRAPH.instanceCollectionsPerKind
        * CRON_PROVIDER_MAX_ATTEMPTS
      + CRON_SUBREQUEST_CALL_GRAPH.marineKinds
        * CRON_MARINE_POSITION_MAX_ATTEMPTS
      + CRON_SUBREQUEST_CALL_GRAPH.metForecasts
      + CRON_SUBREQUEST_CALL_GRAPH.warningFeeds
      + CRON_SUBREQUEST_CALL_GRAPH.warningDetails;

    expect(computedWorstCase).toBe(CRON_WORST_CASE_EXTERNAL_SUBREQUESTS);
    expect(computedWorstCase).toBeLessThanOrEqual(EVENT_EXTERNAL_SUBREQUEST_BUDGET);
  });

  it('treats malformed JSON from a reached 2xx as terminal', async () => {
    const fetchMock = vi.fn(async () =>
      new Response('{"incomplete":', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    globalThis.fetch = fetchMock as typeof fetch;
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const eventMemo: EventMemo = new Map();
    await expect(fetchJsonWithRetries(
      'https://api.met.no/malformed',
      'malformed MET stage',
      executionPolicy({ maxAttempts: 3, retryDelayMs: 0 }),
      'weather',
      eventMemo,
    )).rejects.toBeInstanceOf(SyntaxError);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(eventMemo.externalSubrequestsStarted).toBe(1);
  });

  it('is shared by retry loops and stops fetches before the Free-plan ceiling', async () => {
    const fetchMock = vi.fn(async () =>
      new Response('temporary provider failure', { status: 503 }));
    globalThis.fetch = fetchMock as typeof fetch;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const eventMemo: EventMemo = new Map();
    const thirtyAttempts = executionPolicy({
      maxAttempts: 30,
      retryDelayMs: 0,
    });

    await expect(fetchJsonWithRetries(
      'https://opendataapi.dmi.dk/first',
      'first DMI stage',
      thirtyAttempts,
      'marine',
      eventMemo,
    )).rejects.toThrow(/temporarily unavailable/i);
    expect(fetchMock).toHaveBeenCalledTimes(30);

    await expect(fetchJsonWithRetries(
      'https://opendataapi.dmi.dk/second',
      'second DMI stage',
      thirtyAttempts,
      'marine',
      eventMemo,
    )).rejects.toBeInstanceOf(ExternalSubrequestBudgetError);
    expect(fetchMock).toHaveBeenCalledTimes(EVENT_EXTERNAL_SUBREQUEST_BUDGET);

    // An already-exhausted event fails synchronously at the boundary; it never
    // starts a 46th fetch while later locations unwind to their held caches.
    await expect(fetchJsonWithRetries(
      'https://opendataapi.dmi.dk/third',
      'third DMI stage',
      thirtyAttempts,
      'marine',
      eventMemo,
    )).rejects.toBeInstanceOf(ExternalSubrequestBudgetError);
    expect(fetchMock).toHaveBeenCalledTimes(EVENT_EXTERNAL_SUBREQUEST_BUDGET);
  });
});
