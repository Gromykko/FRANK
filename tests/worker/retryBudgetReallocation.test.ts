import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { ForecastLocation } from '../../src/config/locationTypes';
import type { EventMemo, MarineInstances } from '../../worker/domain';
import {
  CRON_CONCURRENT_EXTERNAL_SUBREQUEST_RESERVE,
  CRON_EXTERNAL_SUBREQUEST_PATHS,
  CRON_MARINE_CATALOGUE_MAX_ATTEMPTS,
  CRON_MAX_CATALOGUE_EXTERNAL_SUBREQUESTS,
  CRON_SUBREQUEST_CALL_GRAPH,
  CRON_TICK_BUDGET_MS,
  EVENT_EXTERNAL_SUBREQUEST_BUDGET,
  cronExecutionPolicy,
  reallocateMarinePositionAttempts,
} from '../../worker/execution';
import {
  DMI_RUN_MANIFEST_SCHEMA_VERSION,
  buildForecastCache,
  dmiCollectionListKey,
  fetchLatestMarineInstances,
} from '../../worker/providers';

const NOW = Date.parse('2026-08-23T13:00:00.000Z');
const OLD_RUN = '2026-08-23T060000Z';
const NEW_RUN = '2026-08-23T120000Z';
const WATER = ['dkss_idw', 'dkss_nsbs'];
const WAVES = ['wam_nsb', 'wam_dw'];

const LOCATION: ForecastLocation = {
  id: 'horsens',
  forecastConfigRevision: 1,
  name: 'Horsens',
  areaName: 'Horsens Fjord',
  coordinate: { longitude: 9.85, latitude: 55.86 },
  dmiCollections: { water: WATER, waves: WAVES },
  emmaId: 'DK004',
  kommuneAliases: ['Horsens'],
};

const OLD_INSTANCES: MarineInstances = {
  water: { collection: WATER[0], id: OLD_RUN },
  waves: { collection: WAVES[0], id: OLD_RUN },
};

function fullCronPolicy() {
  const policy = cronExecutionPolicy(NOW, NOW + CRON_TICK_BUDGET_MS, 1);
  if (!policy) throw new Error('Expected one full cron policy.');
  return { ...policy, retryDelayMs: 0, retryBusyDelayMs: 0 };
}

function runManifest(entries: Record<string, unknown> | null) {
  return {
    get: vi.fn(async () => entries === null
      ? null
      : { schemaVersion: DMI_RUN_MANIFEST_SCHEMA_VERSION, entries }),
    put: vi.fn(async () => {}),
  } as Pick<KVNamespace, 'get' | 'put'>;
}

function currentManifestEntries(): Record<string, unknown> {
  const discoveredAt = new Date(NOW).toISOString();
  return {
    [dmiCollectionListKey(WATER)]: {
      collection: WATER[0],
      id: NEW_RUN,
      discoveredAt,
    },
    [dmiCollectionListKey(WAVES)]: {
      collection: WAVES[0],
      id: NEW_RUN,
      discoveredAt,
    },
  };
}

function plannedBuildTotal(consumed: number, attemptsPerPositionLeg: number): number {
  return consumed
    + CRON_SUBREQUEST_CALL_GRAPH.concurrentPositionLegs * attemptsPerPositionLeg
    + CRON_CONCURRENT_EXTERNAL_SUBREQUEST_RESERVE;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('live retry-budget reallocation', () => {
  it('uses the position ceiling after a manifest hit makes zero catalogue requests', async () => {
    const provider = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('A current manifest must bypass the catalogue.'),
    );
    const eventMemo: EventMemo = new Map();

    const result = await fetchLatestMarineInstances(
      LOCATION,
      fullCronPolicy(),
      eventMemo,
      OLD_INSTANCES,
      runManifest(currentManifestEntries()),
    );
    const adjusted = reallocateMarinePositionAttempts(fullCronPolicy(), eventMemo);

    expect(result.catalogueContacted).toBe(false);
    expect(provider).not.toHaveBeenCalled();
    expect(eventMemo.externalSubrequestsStarted ?? 0).toBe(0);
    // The subrequest plan still allows 18 per leg; the policy now grants fewer
    // because a 50s tick cannot complete that many ~6s attempts. Position keeps
    // whichever ceiling is real, undiminished by catalogue spend.
    expect(adjusted.marinePositionMaxAttempts).toBe(
      fullCronPolicy().marinePositionMaxAttempts,
    );
  });

  it('keeps the position cap near its ceiling after a quick catalogue success', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json({ instances: [{ id: NEW_RUN }] }));
    const eventMemo: EventMemo = new Map();

    const result = await fetchLatestMarineInstances(
      LOCATION,
      fullCronPolicy(),
      eventMemo,
      OLD_INSTANCES,
      runManifest(null),
    );
    const consumed = eventMemo.externalSubrequestsStarted ?? 0;
    const adjusted = reallocateMarinePositionAttempts(fullCronPolicy(), eventMemo);

    expect(result.catalogueContacted).toBe(true);
    expect(consumed).toBe(CRON_SUBREQUEST_CALL_GRAPH.marineKinds);
    expect(adjusted.marinePositionMaxAttempts).toBe(
      fullCronPolicy().marinePositionMaxAttempts,
    );
    expect(plannedBuildTotal(consumed, adjusted.marinePositionMaxAttempts))
      .toBeLessThanOrEqual(EVENT_EXTERNAL_SUBREQUEST_BUDGET);
  });

  it('reduces position attempts after every catalogue collection was expensive', async () => {
    const attempts = new Map<string, number>();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      const collection = url.match(/\/collections\/([^/]+)\/instances$/)?.[1];
      if (!collection) throw new Error(`Unexpected provider URL: ${url}`);
      const attempt = (attempts.get(collection) ?? 0) + 1;
      attempts.set(collection, attempt);
      if (attempt < CRON_MARINE_CATALOGUE_MAX_ATTEMPTS) {
        return new Response('temporary provider failure', { status: 503 });
      }
      const isFallbackCollection = collection === WATER[1] || collection === WAVES[1];
      return Response.json({ instances: isFallbackCollection ? [{ id: NEW_RUN }] : [] });
    });
    const eventMemo: EventMemo = new Map();

    await expect(fetchLatestMarineInstances(
      LOCATION,
      fullCronPolicy(),
      eventMemo,
      OLD_INSTANCES,
      runManifest(null),
    )).resolves.toMatchObject({ catalogueContacted: true, substituted: [] });
    const consumed = eventMemo.externalSubrequestsStarted ?? 0;
    const adjusted = reallocateMarinePositionAttempts(fullCronPolicy(), eventMemo);

    expect(consumed).toBe(CRON_MAX_CATALOGUE_EXTERNAL_SUBREQUESTS);
    expect(adjusted.marinePositionMaxAttempts).toBeGreaterThanOrEqual(1);
    expect(adjusted.marinePositionMaxAttempts).toBeLessThan(
      CRON_EXTERNAL_SUBREQUEST_PATHS.manifestHit.marinePositionAttemptsPerLeg,
    );
    expect(plannedBuildTotal(consumed, adjusted.marinePositionMaxAttempts))
      .toBeLessThanOrEqual(EVENT_EXTERNAL_SUBREQUEST_BUDGET);
  });

  it('starts no position request when catalogue exhaustion leaves no run to build', async () => {
    const calls: string[] = [];
    const attempts = new Map<string, number>();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      calls.push(url);
      const collection = url.match(/\/collections\/([^/]+)\/instances$/)?.[1];
      if (!collection) throw new Error(`Unexpected provider URL: ${url}`);
      const attempt = (attempts.get(collection) ?? 0) + 1;
      attempts.set(collection, attempt);
      const isFirstCollection = collection === WATER[0] || collection === WAVES[0];
      if (isFirstCollection && attempt === CRON_MARINE_CATALOGUE_MAX_ATTEMPTS) {
        return Response.json({ instances: [] });
      }
      return new Response('temporary provider failure', { status: 503 });
    });
    const eventMemo: EventMemo = new Map();

    await expect(fetchLatestMarineInstances(
      LOCATION,
      fullCronPolicy(),
      eventMemo,
      undefined,
      runManifest(null),
    )).rejects.toThrow(/temporarily unavailable/i);

    expect(eventMemo.externalSubrequestsStarted).toBe(
      CRON_MAX_CATALOGUE_EXTERNAL_SUBREQUESTS,
    );
    expect(calls.some((url) => /\/position(?:\?|$)/.test(url))).toBe(false);
    expect(
      (eventMemo.externalSubrequestsStarted ?? 0)
      + CRON_CONCURRENT_EXTERNAL_SUBREQUEST_RESERVE,
    ).toBeLessThanOrEqual(EVENT_EXTERNAL_SUBREQUEST_BUDGET);
  });

  it('keeps an exhausted-catalogue fallback build within budget when raw marine is missing', async () => {
    const eventMemo: EventMemo = new Map();
    const attempts = new Map<string, number>();
    const positionCalls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      const collection = url.match(/\/collections\/([^/]+)\/instances$/)?.[1];
      if (collection) {
        const attempt = (attempts.get(collection) ?? 0) + 1;
        attempts.set(collection, attempt);
        const isFirstCollection = collection === WATER[0] || collection === WAVES[0];
        if (isFirstCollection && attempt === CRON_MARINE_CATALOGUE_MAX_ATTEMPTS) {
          return Response.json({ instances: [] });
        }
        return new Response('temporary provider failure', { status: 503 });
      }
      if (/\/position(?:\?|$)/.test(url)) positionCalls.push(url);
      return new Response('temporary provider failure', { status: 503 });
    });
    const resolution = await fetchLatestMarineInstances(
      LOCATION,
      fullCronPolicy(),
      eventMemo,
      OLD_INSTANCES,
      runManifest(null),
    );
    const consumedByCatalogue = eventMemo.externalSubrequestsStarted ?? 0;
    const adjusted = reallocateMarinePositionAttempts(fullCronPolicy(), eventMemo);
    const env = {
      FRANK_FORECAST_CACHE: {
        get: vi.fn(async () => null),
        put: vi.fn(async () => {}),
      },
    } as unknown as Env;

    await expect(buildForecastCache(
      env,
      LOCATION,
      resolution.instances,
      null,
      undefined,
      fullCronPolicy(),
      eventMemo,
    )).rejects.toThrow();

    expect(resolution.substituted).toEqual(['water', 'waves']);
    expect(consumedByCatalogue).toBe(CRON_MAX_CATALOGUE_EXTERNAL_SUBREQUESTS);
    expect(positionCalls).toHaveLength(
      CRON_SUBREQUEST_CALL_GRAPH.concurrentPositionLegs
      * adjusted.marinePositionMaxAttempts,
    );
    expect(eventMemo.externalSubrequestsStarted)
      .toBeLessThanOrEqual(EVENT_EXTERNAL_SUBREQUEST_BUDGET);
  });
});
