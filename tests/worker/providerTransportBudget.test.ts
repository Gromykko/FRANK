import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import locationData from '../../src/config/locations.json';
import {
  CRON_CONCURRENT_EXTERNAL_SUBREQUEST_RESERVE,
  CRON_EXTERNAL_SUBREQUEST_PATHS,
  CRON_MARINE_CATALOGUE_MAX_ATTEMPTS,
  CRON_MARINE_POSITION_MAX_ATTEMPTS,
  CRON_MAX_CATALOGUE_EXTERNAL_SUBREQUESTS,
  CRON_PROVIDER_MAX_ATTEMPTS,
  CRON_SUBREQUEST_CALL_GRAPH,
  CRON_TICK_BUDGET_MS,
  EVENT_EXTERNAL_SUBREQUEST_BUDGET,
  cronExecutionPolicy,
  executionPolicy,
  ExternalSubrequestBudgetError,
  reallocateMarinePositionAttempts,
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

  it('lets a marine catalogue stage use its raised provider-specific ceiling', async () => {
    const fetchMock = vi.fn(async () =>
      new Response('temporary provider failure', { status: 503 }));
    globalThis.fetch = fetchMock as typeof fetch;
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(fetchJsonWithRetries(
      'https://opendataapi.dmi.dk/v2/forecastedr/collections/dkss_idw/instances',
      'marine catalogue',
      { ...fullCronPolicy(), retryDelayMs: 0 },
      'marine',
      new Map(),
    )).rejects.toThrow(/temporarily unavailable/i);

    expect(CRON_MARINE_CATALOGUE_MAX_ATTEMPTS).toBeGreaterThan(
      CRON_PROVIDER_MAX_ATTEMPTS,
    );
    expect(fetchMock).toHaveBeenCalledTimes(CRON_MARINE_CATALOGUE_MAX_ATTEMPTS);
  });

  it('keeps a non-marine retry-loop stage at the ordinary ceiling', async () => {
    const fetchMock = vi.fn(async () =>
      new Response('temporary provider failure', { status: 503 }));
    globalThis.fetch = fetchMock as typeof fetch;
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(fetchJsonWithRetries(
      'https://api.met.no/example-retry-loop',
      'non-marine stage',
      { ...fullCronPolicy(), retryDelayMs: 0 },
      'weather',
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
    const eventMemo: EventMemo = new Map();
    eventMemo.externalSubrequestsStarted = CRON_MAX_CATALOGUE_EXTERNAL_SUBREQUESTS;
    const reducedPolicy = reallocateMarinePositionAttempts(fullCronPolicy(), eventMemo);

    await expect(fetchJsonWithRetries(
      marinePositionUrl('wam_nsb'),
      'DMI wam_nsb',
      { ...reducedPolicy, retryBusyDelayMs: 0 },
      'marine',
      eventMemo,
    )).rejects.toThrow(/temporarily unavailable/i);

    expect(reducedPolicy.marinePositionMaxAttempts).toBeLessThan(
      CRON_MARINE_POSITION_MAX_ATTEMPTS,
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('models manifest, successful-catalogue and exhausted-catalogue paths separately', async () => {
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

    const computedReserve = CRON_SUBREQUEST_CALL_GRAPH.metForecasts
      + CRON_SUBREQUEST_CALL_GRAPH.warningFeeds
      + CRON_SUBREQUEST_CALL_GRAPH.warningDetails;
    expect(computedReserve).toBe(CRON_CONCURRENT_EXTERNAL_SUBREQUEST_RESERVE);

    const computedCatalogueMaximum =
      CRON_SUBREQUEST_CALL_GRAPH.marineKinds
        * CRON_SUBREQUEST_CALL_GRAPH.instanceCollectionsPerKind
        * CRON_MARINE_CATALOGUE_MAX_ATTEMPTS;
    expect(computedCatalogueMaximum).toBe(CRON_MAX_CATALOGUE_EXTERNAL_SUBREQUESTS);

    const positionCap = (consumed: number) => Math.max(1, Math.min(
      CRON_MARINE_POSITION_MAX_ATTEMPTS,
      Math.floor(
        (EVENT_EXTERNAL_SUBREQUEST_BUDGET - consumed - computedReserve)
          / CRON_SUBREQUEST_CALL_GRAPH.concurrentPositionLegs,
      ),
    ));
    const modelPath = (catalogueSubrequests: number, positionsRun: boolean) => {
      const marinePositionAttemptsPerLeg = positionsRun
        ? positionCap(catalogueSubrequests)
        : 0;
      return {
        catalogueSubrequests,
        marinePositionAttemptsPerLeg,
        concurrentReserve: computedReserve,
        total: catalogueSubrequests
          + CRON_SUBREQUEST_CALL_GRAPH.concurrentPositionLegs
            * marinePositionAttemptsPerLeg
          + computedReserve,
      };
    };

    expect(CRON_EXTERNAL_SUBREQUEST_PATHS).toEqual({
      manifestHit: modelPath(0, true),
      catalogueSucceeds: modelPath(computedCatalogueMaximum, true),
      catalogueExhausts: modelPath(computedCatalogueMaximum, true),
    });
    for (const path of Object.values(CRON_EXTERNAL_SUBREQUEST_PATHS)) {
      expect(path.total).toBeLessThanOrEqual(EVENT_EXTERNAL_SUBREQUEST_BUDGET);
    }
  });

  it('gives a manifest hit with zero catalogue spend the position ceiling', () => {
    const eventMemo: EventMemo = new Map();
    const adjusted = reallocateMarinePositionAttempts(fullCronPolicy(), eventMemo);

    expect(eventMemo.externalSubrequestsStarted ?? 0).toBe(0);
    expect(adjusted.marinePositionMaxAttempts).toBe(
      CRON_MARINE_POSITION_MAX_ATTEMPTS,
    );
  });

  it('keeps a quick catalogue success at one attempt below the position ceiling', () => {
    const eventMemo: EventMemo = new Map();
    eventMemo.externalSubrequestsStarted = CRON_SUBREQUEST_CALL_GRAPH.marineKinds;

    const adjusted = reallocateMarinePositionAttempts(fullCronPolicy(), eventMemo);

    expect(adjusted.marinePositionMaxAttempts).toBeGreaterThanOrEqual(
      CRON_MARINE_POSITION_MAX_ATTEMPTS - 1,
    );
    expect(
      eventMemo.externalSubrequestsStarted
      + CRON_SUBREQUEST_CALL_GRAPH.concurrentPositionLegs
        * adjusted.marinePositionMaxAttempts
      + CRON_CONCURRENT_EXTERNAL_SUBREQUEST_RESERVE,
    ).toBeLessThanOrEqual(EVENT_EXTERNAL_SUBREQUEST_BUDGET);
  });

  it('reduces an expensive catalogue path without taking either position leg below one', () => {
    const eventMemo: EventMemo = new Map();
    eventMemo.externalSubrequestsStarted = CRON_MAX_CATALOGUE_EXTERNAL_SUBREQUESTS;

    const adjusted = reallocateMarinePositionAttempts(fullCronPolicy(), eventMemo);

    expect(adjusted.marinePositionMaxAttempts).toBeGreaterThanOrEqual(1);
    expect(adjusted.marinePositionMaxAttempts).toBeLessThan(
      CRON_MARINE_POSITION_MAX_ATTEMPTS,
    );
    expect(
      eventMemo.externalSubrequestsStarted
      + CRON_SUBREQUEST_CALL_GRAPH.concurrentPositionLegs
        * adjusted.marinePositionMaxAttempts
      + CRON_CONCURRENT_EXTERNAL_SUBREQUEST_RESERVE,
    ).toBeLessThanOrEqual(EVENT_EXTERNAL_SUBREQUEST_BUDGET);
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
