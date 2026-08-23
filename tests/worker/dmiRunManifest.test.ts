import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { ForecastLocation } from '../../src/config/locationTypes';
import type { MarineInstances } from '../../worker/domain';
import { FORECAST_SOURCE_POLICY } from '../../worker/forecastModel';
import {
  DMI_RUN_MANIFEST_KEY,
  DMI_RUN_MANIFEST_SCHEMA_VERSION,
  dmiCollectionListKey,
  fetchLatestMarineInstances,
} from '../../worker/providers';

const NOW = Date.parse('2026-08-20T16:00:00.000Z');
const OLD_RUN = '2026-08-20T060000Z';
const NEW_RUN = '2026-08-20T120000Z';
const NEW_RUN_ISO = '2026-08-20T12:00:00.000Z';
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
  water: { collection: 'dkss_idw', id: OLD_RUN },
  waves: { collection: 'wam_nsb', id: OLD_RUN },
};

interface TrackedPut {
  key: string;
  value: string;
}

function manifestEntry(
  collection: string,
  id: string,
  discoveredAt = new Date(NOW).toISOString(),
): { collection: string; id: string; discoveredAt: string } {
  return { collection, id, discoveredAt };
}

function manifestJson(
  entries: Record<string, unknown>,
  schemaVersion = DMI_RUN_MANIFEST_SCHEMA_VERSION,
): string {
  return JSON.stringify({ schemaVersion, entries });
}

function bothEntries(
  id: string,
  discoveredAt = new Date(NOW).toISOString(),
): Record<string, unknown> {
  return {
    [dmiCollectionListKey(WATER)]: manifestEntry('dkss_idw', id, discoveredAt),
    [dmiCollectionListKey(WAVES)]: manifestEntry('wam_nsb', id, discoveredAt),
  };
}

function trackedManifestStore(
  initial?: string,
  options: { getError?: Error; putError?: Error } = {},
) {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(DMI_RUN_MANIFEST_KEY, initial);
  const gets: string[] = [];
  const puts: TrackedPut[] = [];
  const namespace = {
    async get(key: string, type?: string) {
      gets.push(key);
      if (options.getError) throw options.getError;
      const raw = values.get(key);
      if (raw === undefined) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    async put(key: string, value: string) {
      puts.push({ key, value });
      if (options.putError) throw options.putError;
      values.set(key, value);
    },
  } as Pick<KVNamespace, 'get' | 'put'>;
  return { namespace, values, gets, puts };
}

function stubCatalogue(
  runs: Record<string, string> = {
    dkss_idw: NEW_RUN,
    dkss_nsbs: NEW_RUN,
    wam_nsb: NEW_RUN,
    wam_dw: NEW_RUN,
  },
): string[] {
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    calls.push(url);
    const collection = url.match(/\/collections\/([^/]+)\/instances$/)?.[1];
    if (!collection || !runs[collection]) {
      throw new Error(`Unexpected DMI catalogue URL: ${url}`);
    }
    return Response.json({ instances: [{ id: runs[collection] }] });
  });
  return calls;
}

async function resolveMarine(
  store: ReturnType<typeof trackedManifestStore>,
  fallback: MarineInstances = OLD_INSTANCES,
  location: ForecastLocation = LOCATION,
) {
  return fetchLatestMarineInstances(
    location,
    undefined,
    new Map(),
    fallback,
    store.namespace,
  );
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

describe('shared DMI run manifest', () => {
  it('adopts forward entries at the exact freshness boundary with zero catalogue requests', async () => {
    const discoveredAt = new Date(NOW - FORECAST_SOURCE_POLICY.dmiRunCycleMs).toISOString();
    const store = trackedManifestStore(manifestJson({
      [dmiCollectionListKey(WATER)]: manifestEntry('dkss_idw', NEW_RUN_ISO, discoveredAt),
      [dmiCollectionListKey(WAVES)]: manifestEntry('wam_nsb', NEW_RUN, discoveredAt),
    }));
    const calls = stubCatalogue();
    const known: MarineInstances = {
      water: { collection: 'dkss_idw', id: NEW_RUN },
      waves: OLD_INSTANCES.waves,
    };

    const result = await resolveMarine(store, known);

    expect(result).toEqual({
      instances: {
        water: { collection: 'dkss_idw', id: NEW_RUN_ISO },
        waves: { collection: 'wam_nsb', id: NEW_RUN },
      },
      substituted: [],
      catalogueContacted: false,
      manifestResolved: ['water', 'waves'],
    });
    expect(store.gets).toEqual([DMI_RUN_MANIFEST_KEY]);
    expect(store.puts).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('merges two newer catalogue discoveries into one logged manifest write', async () => {
    const staleAt = new Date(
      NOW - FORECAST_SOURCE_POLICY.dmiRunCycleMs - 1,
    ).toISOString();
    const store = trackedManifestStore(manifestJson(bothEntries(OLD_RUN, staleAt)));
    const calls = stubCatalogue();
    const log = vi.mocked(console.log);

    const result = await resolveMarine(store);

    expect(result.instances).toEqual({
      water: { collection: 'dkss_idw', id: NEW_RUN },
      waves: { collection: 'wam_nsb', id: NEW_RUN },
    });
    expect(result.substituted).toEqual([]);
    expect(result.catalogueContacted).toBe(true);
    expect(calls.filter((url) => url.endsWith('/instances'))).toHaveLength(2);
    expect(store.puts).toHaveLength(1);
    expect(store.puts[0].key).toBe(DMI_RUN_MANIFEST_KEY);
    expect(JSON.parse(store.puts[0].value)).toEqual({
      schemaVersion: DMI_RUN_MANIFEST_SCHEMA_VERSION,
      entries: bothEntries(NEW_RUN),
    });
    expect(log).toHaveBeenCalledWith(
      '{"event":"kv_write","category":"dmi-run-manifest"}',
    );
  });

  it('does not rewrite discoveredAt when a real probe finds the stored run unchanged', async () => {
    const staleAt = new Date(
      NOW - FORECAST_SOURCE_POLICY.dmiRunCycleMs - 1,
    ).toISOString();
    const store = trackedManifestStore(manifestJson(bothEntries(NEW_RUN, staleAt)));
    const calls = stubCatalogue();

    const result = await resolveMarine(store);

    expect(result.instances).toEqual({
      water: { collection: 'dkss_idw', id: NEW_RUN },
      waves: { collection: 'wam_nsb', id: NEW_RUN },
    });
    expect(result.catalogueContacted).toBe(true);
    expect(calls.filter((url) => url.endsWith('/instances'))).toHaveLength(2);
    expect(store.puts).toHaveLength(0);
  });

  it('does not seed a missing manifest with the unchanged run a city already knows', async () => {
    const store = trackedManifestStore();
    const calls = stubCatalogue({
      dkss_idw: OLD_RUN,
      dkss_nsbs: OLD_RUN,
      wam_nsb: OLD_RUN,
      wam_dw: OLD_RUN,
    });

    const result = await resolveMarine(store);

    expect(result.instances).toEqual(OLD_INSTANCES);
    expect(result.catalogueContacted).toBe(true);
    expect(calls.filter((url) => url.endsWith('/instances'))).toHaveLength(2);
    expect(store.puts).toHaveLength(0);
  });

  it('does not publish a catalogue run that fails to advance the city-known run', async () => {
    const store = trackedManifestStore(manifestJson(bothEntries(OLD_RUN)));
    const calls = stubCatalogue();
    const known: MarineInstances = {
      water: { collection: 'dkss_idw', id: NEW_RUN },
      waves: { collection: 'wam_nsb', id: NEW_RUN },
    };

    const result = await resolveMarine(store, known);

    expect(result.instances).toEqual(known);
    expect(result.catalogueContacted).toBe(true);
    expect(calls.filter((url) => url.endsWith('/instances'))).toHaveLength(2);
    expect(store.puts).toHaveLength(0);
  });

  it('replaces a comparable expired entry when DMI recovers with a newer run', async () => {
    const expiredRun = '2026-08-20T000000Z';
    const store = trackedManifestStore(manifestJson(bothEntries(expiredRun)));
    const calls = stubCatalogue();
    const expiredKnown: MarineInstances = {
      water: { collection: 'dkss_idw', id: expiredRun },
      waves: { collection: 'wam_nsb', id: expiredRun },
    };

    const result = await resolveMarine(store, expiredKnown);

    expect(result.instances).toEqual({
      water: { collection: 'dkss_idw', id: NEW_RUN },
      waves: { collection: 'wam_nsb', id: NEW_RUN },
    });
    expect(calls.filter((url) => url.endsWith('/instances'))).toHaveLength(2);
    expect(store.puts).toHaveLength(1);
    expect(JSON.parse(store.puts[0].value)).toEqual({
      schemaVersion: DMI_RUN_MANIFEST_SCHEMA_VERSION,
      entries: bothEntries(NEW_RUN),
    });
  });

  it.each([
    { name: 'missing', initial: undefined },
    { name: 'corrupt JSON', initial: '{' },
    {
      name: 'unknown schema',
      initial: manifestJson(bothEntries(OLD_RUN), DMI_RUN_MANIFEST_SCHEMA_VERSION + 1),
    },
    {
      name: 'stale entry',
      initial: manifestJson(bothEntries(
        OLD_RUN,
        new Date(NOW - FORECAST_SOURCE_POLICY.dmiRunCycleMs - 1).toISOString(),
      )),
    },
    {
      name: 'collection outside its keyed list',
      initial: manifestJson({
        [dmiCollectionListKey(WATER)]: manifestEntry('wam_nsb', OLD_RUN),
        [dmiCollectionListKey(WAVES)]: manifestEntry('dkss_idw', OLD_RUN),
      }),
    },
    {
      name: 'future discovery timestamp',
      initial: manifestJson(bothEntries(
        OLD_RUN,
        new Date(NOW + 1).toISOString(),
      )),
    },
    {
      name: 'out-of-policy run',
      initial: manifestJson(bothEntries('2026-08-20T000000Z')),
    },
    {
      name: 'read failure',
      initial: manifestJson(bothEntries(OLD_RUN)),
      getError: new Error('KV unavailable'),
    },
  ])('falls back to probing for a $name manifest and returns clean current runs', async ({
    initial,
    getError,
  }) => {
    const store = trackedManifestStore(initial, { getError });
    const calls = stubCatalogue();

    const result = await resolveMarine(store);

    expect(result).toMatchObject({
      instances: {
        water: { collection: 'dkss_idw', id: NEW_RUN },
        waves: { collection: 'wam_nsb', id: NEW_RUN },
      },
      substituted: [],
      catalogueContacted: true,
    });
    expect(calls.filter((url) => url.endsWith('/instances'))).toHaveLength(2);
  });

  it('never adopts a fresh manifest run behind the city\'s own known run', async () => {
    const store = trackedManifestStore(manifestJson(bothEntries(OLD_RUN)));
    const calls = stubCatalogue();
    const known: MarineInstances = {
      water: { collection: 'dkss_idw', id: NEW_RUN },
      waves: { collection: 'wam_nsb', id: NEW_RUN },
    };

    const result = await resolveMarine(store, known);

    expect(result.instances).toEqual(known);
    expect(result.catalogueContacted).toBe(true);
    expect(calls.filter((url) => url.endsWith('/instances'))).toHaveLength(2);
  });

  it('keeps differently ordered collection lists isolated and preserves both entries', async () => {
    const reversedWater = [...WATER].reverse();
    const store = trackedManifestStore(manifestJson(bothEntries(NEW_RUN)));
    const calls = stubCatalogue({
      dkss_idw: NEW_RUN,
      dkss_nsbs: '2026-08-20T150000Z',
      wam_nsb: NEW_RUN,
      wam_dw: NEW_RUN,
    });
    const location: ForecastLocation = {
      ...LOCATION,
      dmiCollections: { water: reversedWater, waves: WAVES },
    };

    const result = await resolveMarine(store, OLD_INSTANCES, location);

    expect(result.instances).toEqual({
      water: { collection: 'dkss_nsbs', id: '2026-08-20T150000Z' },
      waves: { collection: 'wam_nsb', id: NEW_RUN },
    });
    expect(calls.filter((url) => url.endsWith('/instances'))).toHaveLength(1);
    expect(calls[0]).toContain('/collections/dkss_nsbs/instances');
    expect(store.puts).toHaveLength(1);
    const written = JSON.parse(store.puts[0].value) as {
      entries: Record<string, unknown>;
    };
    expect(written.entries[dmiCollectionListKey(WATER)]).toEqual(
      manifestEntry('dkss_idw', NEW_RUN),
    );
    expect(written.entries[dmiCollectionListKey(reversedWater)]).toEqual(
      manifestEntry('dkss_nsbs', '2026-08-20T150000Z'),
    );
  });

  it('keeps the catalogue result usable when the manifest write fails', async () => {
    const store = trackedManifestStore(undefined, {
      putError: new Error('KV write rejected'),
    });
    const calls = stubCatalogue();
    const log = vi.mocked(console.log);

    const result = await resolveMarine(store);

    expect(result.instances).toEqual({
      water: { collection: 'dkss_idw', id: NEW_RUN },
      waves: { collection: 'wam_nsb', id: NEW_RUN },
    });
    expect(calls.filter((url) => url.endsWith('/instances'))).toHaveLength(2);
    expect(store.puts).toHaveLength(1);
    expect(log).not.toHaveBeenCalledWith(
      '{"event":"kv_write","category":"dmi-run-manifest"}',
    );
  });
});
