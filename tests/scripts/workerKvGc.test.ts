// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import type { ReleaseMetadata } from '../../src/features/forecast/releaseContract';
import {
  FORECAST_KV_BINDING,
  FRANK_GENERATION_KEY_ROOT,
  MAX_BULK_DELETE_KEYS,
  deleteRemoteForecastKvKeys,
  gcWorkerKv,
  generationKeyPrefix,
  listRemoteForecastKvKeys,
  parseGenerationScopedKey,
  planWorkerKvGc,
} from '../../scripts/gc-worker-kv.mjs';

const CURRENT = Object.freeze({
  apiSchemaVersion: 1,
  modelRevision: 8,
  dataGenerationId: 'api1-model8',
  payloadVersion: 7,
  assembledCacheSchema: 2,
  marineCacheSchema: 1,
});
const PREVIOUS = Object.freeze({
  ...CURRENT,
  modelRevision: 7,
  dataGenerationId: 'api1-model7',
  assembledCacheSchema: 1,
});
const OLD = Object.freeze({
  ...PREVIOUS,
  modelRevision: 6,
  dataGenerationId: 'api1-model6:legacy',
});

function key(
  release: Readonly<ReleaseMetadata> = CURRENT,
  suffix = 'forecast:assembled:location:horsens:config:v1',
) {
  return `${generationKeyPrefix(release)}:${suffix}`;
}

function listed(...names: string[]) {
  return names.map((name) => ({ name }));
}

describe('Worker KV generation garbage collection', () => {
  it('parses only canonical FRANK generation-scoped keys', () => {
    expect(parseGenerationScopedKey(key(OLD))).toMatchObject({
      prefix: generationKeyPrefix(OLD),
      release: OLD,
    });
    expect(parseGenerationScopedKey('frank:forecast:horsens')).toBeNull();
    expect(parseGenerationScopedKey(
      key(OLD).replace('api1-model6%3Alegacy', 'api1-model6%3alegacy'),
    )).toBeNull();
    expect(parseGenerationScopedKey(`${generationKeyPrefix(OLD)}`)).toBeNull();
  });

  it('retains current plus exact N-1 and deletes only provably older generations', () => {
    const legacy = 'forecast:horsens';
    const malformed = `${FRANK_GENERATION_KEY_ROOT}not-a-release:key`;
    const plan = planWorkerKvGc({
      listedKeys: listed(key(CURRENT), key(PREVIOUS), key(OLD), legacy, malformed),
      currentRelease: CURRENT,
      auditedPreviousReleases: [PREVIOUS],
    });

    expect(plan.retainedPrefixes).toEqual([
      generationKeyPrefix(CURRENT),
      generationKeyPrefix(PREVIOUS),
    ]);
    expect(plan.deleteKeys).toEqual([key(OLD)]);
    expect(plan.ignoredKeys).toEqual([malformed, legacy].sort());
    expect(plan.stalePrefixes).toEqual([generationKeyPrefix(OLD)]);
  });

  it('retains one explicitly retired cross-API rollback and deletes older retired data', () => {
    const currentV2 = {
      ...CURRENT,
      apiSchemaVersion: 2,
      dataGenerationId: 'api2-model8',
    };
    const plan = planWorkerKvGc({
      listedKeys: listed(key(currentV2), key(PREVIOUS), key(OLD)),
      currentRelease: currentV2,
      auditedPreviousReleases: [PREVIOUS],
      retiredApiSchemaVersions: [1],
    });

    expect(plan.retainedPrefixes).toEqual([
      generationKeyPrefix(currentV2),
      generationKeyPrefix(PREVIOUS),
    ]);
    expect(plan.deleteKeys).toEqual([key(OLD)]);
  });

  it('refuses ambiguous same/newer or cross-API generations before deletion', () => {
    const sameModelOtherGeneration = {
      ...CURRENT,
      dataGenerationId: 'api1-model8-other',
    };
    const future = {
      ...CURRENT,
      modelRevision: 9,
      dataGenerationId: 'api1-model9',
    };
    const sameRevisionAsRetainedPrevious = {
      ...PREVIOUS,
      dataGenerationId: 'api1-model7-other',
    };
    const otherApi = {
      ...PREVIOUS,
      apiSchemaVersion: 2,
      dataGenerationId: 'api2-model7',
    };

    for (const release of [
      sameModelOtherGeneration,
      sameRevisionAsRetainedPrevious,
      future,
      otherApi,
    ]) {
      expect(() => planWorkerKvGc({
        listedKeys: listed(key(release)),
        currentRelease: CURRENT,
        auditedPreviousReleases: [PREVIOUS],
      })).toThrow('cannot be proven older');
    }
  });

  it('fails closed instead of guessing among multiple or unretired cross-API releases', () => {
    expect(() => planWorkerKvGc({
      listedKeys: [],
      currentRelease: CURRENT,
      auditedPreviousReleases: [PREVIOUS, OLD],
    })).toThrow('at most one audited previous generation');

    expect(() => planWorkerKvGc({
      listedKeys: [],
      currentRelease: CURRENT,
      auditedPreviousReleases: [{
        ...PREVIOUS,
        apiSchemaVersion: 2,
        dataGenerationId: 'api2-model7',
      }],
    })).toThrow('requires that API to be explicitly retired');

    expect(() => planWorkerKvGc({
      listedKeys: [],
      currentRelease: CURRENT,
      retiredApiSchemaVersions: [CURRENT.apiSchemaVersion],
    })).toThrow('Retired API schema retention policy is invalid');

    expect(() => planWorkerKvGc({
      listedKeys: [],
      currentRelease: CURRENT,
      auditedPreviousReleases: [{
        ...CURRENT,
        dataGenerationId: 'api1-model8-previous',
      }],
    })).toThrow('must have an older model revision');
  });

  it('is a dry run by default', async () => {
    const deleteKeysImpl = vi.fn();
    const result = await gcWorkerKv({
      contract: { release: CURRENT, auditedPreviousReleases: [PREVIOUS] },
      listKeysImpl: vi.fn().mockResolvedValue(listed(key(CURRENT), key(OLD))),
      deleteKeysImpl,
      logger: { info: vi.fn() },
    });

    expect(result.applied).toBe(false);
    expect(result.deleteKeys).toEqual([key(OLD)]);
    expect(deleteKeysImpl).not.toHaveBeenCalled();
  });

  it('passes explicit API retirement through the loaded cleanup contract', async () => {
    const currentV2 = {
      ...CURRENT,
      apiSchemaVersion: 2,
      dataGenerationId: 'api2-model8',
    };
    const result = await gcWorkerKv({
      contract: {
        release: currentV2,
        auditedPreviousReleases: [PREVIOUS],
        retiredApiSchemaVersions: [1],
      },
      listKeysImpl: vi.fn().mockResolvedValue(listed(key(currentV2), key(PREVIOUS), key(OLD))),
      deleteKeysImpl: vi.fn(),
      logger: { info: vi.fn() },
    });

    expect(result.retainedPrefixes).toEqual([
      generationKeyPrefix(currentV2),
      generationKeyPrefix(PREVIOUS),
    ]);
    expect(result.deleteKeys).toEqual([key(OLD)]);
  });

  it('reconfirms, deletes, and verifies the exact stale-key plan when apply is explicit', async () => {
    const listKeysImpl = vi.fn()
      .mockResolvedValueOnce(listed(key(CURRENT), key(PREVIOUS), key(OLD)))
      .mockResolvedValueOnce(listed(key(CURRENT), key(PREVIOUS), key(OLD)))
      .mockResolvedValueOnce(listed(key(CURRENT), key(PREVIOUS)));
    const deleteKeysImpl = vi.fn().mockResolvedValue(undefined);

    await expect(gcWorkerKv({
      apply: true,
      attestedActiveRelease: PREVIOUS,
      contract: { release: CURRENT, auditedPreviousReleases: [PREVIOUS] },
      listKeysImpl,
      deleteKeysImpl,
      logger: { info: vi.fn() },
    })).resolves.toMatchObject({ applied: true, deleteKeys: [key(OLD)] });
    expect(deleteKeysImpl).toHaveBeenCalledWith([key(OLD)]);
    expect(listKeysImpl).toHaveBeenCalledTimes(3);
  });

  it('aborts before mutation when the namespace changes during confirmation', async () => {
    const secondOldKey = key(OLD, 'ingredient:marine:water:location:vejle:config:v1');
    const listKeysImpl = vi.fn()
      .mockResolvedValueOnce(listed(key(CURRENT), key(OLD)))
      .mockResolvedValueOnce(listed(key(CURRENT), key(OLD), secondOldKey));
    const deleteKeysImpl = vi.fn();

    await expect(gcWorkerKv({
      apply: true,
      attestedActiveRelease: CURRENT,
      contract: { release: CURRENT, auditedPreviousReleases: [] },
      listKeysImpl,
      deleteKeysImpl,
      logger: { info: vi.fn() },
    })).rejects.toThrow('changed while the cleanup plan was being confirmed');
    expect(deleteKeysImpl).not.toHaveBeenCalled();
  });

  it('lists only the remote production binding under the generation root', async () => {
    const execFileImpl = vi.fn().mockResolvedValue({
      stdout: JSON.stringify(listed(key(CURRENT))),
      stderr: '',
    });

    await expect(listRemoteForecastKvKeys({ execFileImpl })).resolves.toEqual(
      listed(key(CURRENT)),
    );
    const args = execFileImpl.mock.calls[0][1] as string[];
    expect(args).toEqual(expect.arrayContaining([
      'kv', 'key', 'list', '--binding', FORECAST_KV_BINDING,
      '--remote', '--prefix', FRANK_GENERATION_KEY_ROOT,
    ]));
    expect(args).not.toContain('--local');
  });

  it('uses forced remote bulk deletion in Cloudflare-sized batches', async () => {
    const keys = Array.from(
      { length: MAX_BULK_DELETE_KEYS + 1 },
      (_, index) => key(OLD, `forecast:assembled:location:test-${index}:config:v1`),
    );
    const batches: string[][] = [];
    const execFileImpl = vi.fn(async (_file: string, args: string[]) => {
      const batchFile = args[4];
      batches.push(JSON.parse(await readFile(batchFile, 'utf8')));
      return { stdout: 'Success!', stderr: '' };
    });

    await deleteRemoteForecastKvKeys(keys, { execFileImpl });
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(MAX_BULK_DELETE_KEYS);
    expect(batches[1]).toHaveLength(1);
    for (const call of execFileImpl.mock.calls) {
      const args = call[1] as string[];
      expect(args).toEqual(expect.arrayContaining([
        'kv', 'bulk', 'delete', '--binding', FORECAST_KV_BINDING,
        '--remote', '--force',
      ]));
    }
  });

  it('defends the destructive adapter against legacy or duplicate keys', async () => {
    const execFileImpl = vi.fn();
    await expect(deleteRemoteForecastKvKeys(['forecast:horsens'], { execFileImpl }))
      .rejects.toThrow('only recognized FRANK generation-scoped keys');
    await expect(deleteRemoteForecastKvKeys([key(OLD), key(OLD)], { execFileImpl }))
      .rejects.toThrow('contain duplicates');
    expect(execFileImpl).not.toHaveBeenCalled();
  });

  it('fails verification when stale keys remain after a successful bulk response', async () => {
    const snapshot = listed(key(CURRENT), key(OLD));
    const listKeysImpl = vi.fn().mockResolvedValue(snapshot);
    const deleteKeysImpl = vi.fn().mockResolvedValue(undefined);
    const sleepImpl = vi.fn().mockResolvedValue(undefined);

    await expect(gcWorkerKv({
      apply: true,
      attestedActiveRelease: CURRENT,
      contract: { release: CURRENT, auditedPreviousReleases: [] },
      listKeysImpl,
      deleteKeysImpl,
      verificationAttempts: 2,
      verificationDelayMs: 5,
      sleepImpl,
      logger: { info: vi.fn() },
    })).rejects.toThrow('verification still found 1 stale key(s) after 2 attempt(s)');
    expect(deleteKeysImpl).toHaveBeenCalledOnce();
    expect(sleepImpl).toHaveBeenCalledOnce();
    expect(sleepImpl).toHaveBeenCalledWith(5);
  });

  it('waits through an eventually-consistent stale relist without deleting twice', async () => {
    const staleSnapshot = listed(key(CURRENT), key(OLD));
    const listKeysImpl = vi.fn()
      .mockResolvedValueOnce(staleSnapshot)
      .mockResolvedValueOnce(staleSnapshot)
      .mockResolvedValueOnce(staleSnapshot)
      .mockResolvedValueOnce(listed(key(CURRENT)));
    const deleteKeysImpl = vi.fn().mockResolvedValue(undefined);
    const sleepImpl = vi.fn().mockResolvedValue(undefined);

    await expect(gcWorkerKv({
      apply: true,
      attestedActiveRelease: CURRENT,
      contract: { release: CURRENT, auditedPreviousReleases: [] },
      listKeysImpl,
      deleteKeysImpl,
      verificationAttempts: 3,
      verificationDelayMs: 7,
      sleepImpl,
      logger: { info: vi.fn() },
    })).resolves.toMatchObject({ applied: true, deleteKeys: [key(OLD)] });

    expect(deleteKeysImpl).toHaveBeenCalledOnce();
    expect(sleepImpl).toHaveBeenCalledOnce();
    expect(sleepImpl).toHaveBeenCalledWith(7);
    expect(listKeysImpl).toHaveBeenCalledTimes(4);
  });

  it('rejects a missing or out-of-policy release attestation before listing or deletion', async () => {
    const listKeysImpl = vi.fn();
    const deleteKeysImpl = vi.fn();

    await expect(gcWorkerKv({
      apply: true,
      contract: { release: CURRENT, auditedPreviousReleases: [PREVIOUS] },
      listKeysImpl,
      deleteKeysImpl,
      logger: { info: vi.fn() },
    })).rejects.toThrow('requires an attested captured Worker release');

    await expect(gcWorkerKv({
      apply: true,
      attestedActiveRelease: OLD,
      contract: { release: CURRENT, auditedPreviousReleases: [PREVIOUS] },
      listKeysImpl,
      deleteKeysImpl,
      logger: { info: vi.fn() },
    })).rejects.toThrow('outside the current/N-1 retention policy');

    expect(listKeysImpl).not.toHaveBeenCalled();
    expect(deleteKeysImpl).not.toHaveBeenCalled();
  });
});
