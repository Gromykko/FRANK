// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  COORDINATED_RELEASE_KEY,
  coordinatedReleaseGithubOutput,
  normalizeCoordinatedRelease,
  readRemoteCoordinatedRelease,
  recordRemoteCoordinatedRelease,
  runCli,
} from '../../scripts/coordinated-release.mjs';

const SOURCE_SHA = 'a'.repeat(40);
const PREVIOUS_SHA = 'b'.repeat(40);
const WORKER_ID = 'cba7bd5e-93f4-4df7-8b61-8f00d5b6f3a1';
const PAGES_CONTENT_ID = 'd'.repeat(64);
const RELEASE = Object.freeze({
  apiSchemaVersion: 1,
  modelRevision: 7,
  dataGenerationId: 'api1-model7',
  assembledCacheSchema: 1,
  marineCacheSchema: 1,
  payloadVersion: 7,
});

function journal(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    sourceSha: SOURCE_SHA,
    workerVersionId: WORKER_ID,
    pagesContentId: PAGES_CONTENT_ID,
    pagesArtifactBuildId: 'pages-build-a',
    release: { ...RELEASE },
    recordedAt: '2026-08-20T20:00:00.000Z',
    ...overrides,
  };
}

function listResult(exists: boolean) {
  return { stdout: JSON.stringify(exists ? [{ name: COORDINATED_RELEASE_KEY }] : []) };
}

describe('coordinated production release journal', () => {
  it('normalizes the exact Worker, Pages, source, and forecast identities', () => {
    expect(normalizeCoordinatedRelease(journal())).toMatchObject({
      sourceSha: SOURCE_SHA,
      workerVersionId: WORKER_ID,
      pagesContentId: PAGES_CONTENT_ID,
      pagesArtifactBuildId: 'pages-build-a',
      release: RELEASE,
    });
    expect(() => normalizeCoordinatedRelease(journal({ sourceSha: 'short' })))
      .toThrow('40-character');
    expect(() => normalizeCoordinatedRelease(journal({ pagesArtifactBuildId: 'bad build id' })))
      .toThrow('Pages build ID');
    expect(() => normalizeCoordinatedRelease(journal({ pagesContentId: 'short' })))
      .toThrow('Pages content ID');
  });

  it('reads absence and an exact remote journal through pinned Wrangler arguments', async () => {
    const absentExec = vi.fn().mockResolvedValue(listResult(false));
    await expect(readRemoteCoordinatedRelease({ execFileImpl: absentExec }))
      .resolves.toBeNull();

    const presentExec = vi.fn()
      .mockResolvedValueOnce(listResult(true))
      .mockResolvedValueOnce({ stdout: JSON.stringify(journal()) });
    await expect(readRemoteCoordinatedRelease({ execFileImpl: presentExec }))
      .resolves.toMatchObject({ sourceSha: SOURCE_SHA });
    expect(presentExec).toHaveBeenCalledTimes(2);
    for (const [executable, args, options] of presentExec.mock.calls) {
      expect(executable).toBe(process.execPath);
      expect(Array.isArray(args)).toBe(true);
      expect(options).toMatchObject({ windowsHide: true, encoding: 'utf8' });
    }
    expect(presentExec.mock.calls[0][1]).toContain('list');
    expect(presentExec.mock.calls[1][1]).toContain('get');
  });

  it('fails closed for an ambiguous namespace or malformed value', async () => {
    const ambiguous = vi.fn().mockResolvedValue({
      stdout: JSON.stringify([
        { name: COORDINATED_RELEASE_KEY },
        { name: `${COORDINATED_RELEASE_KEY}:shadow` },
      ]),
    });
    await expect(readRemoteCoordinatedRelease({ execFileImpl: ambiguous }))
      .rejects.toThrow('ambiguous');

    const malformed = vi.fn()
      .mockResolvedValueOnce(listResult(true))
      .mockResolvedValueOnce({ stdout: '{}' });
    await expect(readRemoteCoordinatedRelease({ execFileImpl: malformed }))
      .rejects.toThrow('malformed');
  });

  it('records the first release only when the journal is absent', async () => {
    const execFileImpl = vi.fn()
      .mockResolvedValueOnce(listResult(false))
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce(listResult(true))
      .mockResolvedValueOnce({ stdout: JSON.stringify(journal()) });
    await expect(recordRemoteCoordinatedRelease({
      sourceSha: SOURCE_SHA,
      workerVersionId: WORKER_ID,
      pagesContentId: PAGES_CONTENT_ID,
      pagesArtifactBuildId: 'pages-build-a',
      release: RELEASE,
      expectedPreviousSourceSha: 'none',
      now: () => new Date('2026-08-20T20:00:00.000Z'),
      execFileImpl,
    })).resolves.toMatchObject({ sourceSha: SOURCE_SHA });
    expect(execFileImpl).toHaveBeenCalledTimes(4);
    const putArgs = execFileImpl.mock.calls[1][1] as string[];
    expect(putArgs).toContain('put');
    const value = JSON.parse(putArgs[putArgs.indexOf(COORDINATED_RELEASE_KEY) + 1]);
    expect(value).toEqual(journal());
  });

  it('fails closed when the written release identity cannot be read back', async () => {
    const conflicting = journal({ sourceSha: PREVIOUS_SHA });
    const execFileImpl = vi.fn()
      .mockResolvedValueOnce(listResult(false))
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce(listResult(true))
      .mockResolvedValueOnce({ stdout: JSON.stringify(conflicting) })
      .mockResolvedValueOnce(listResult(true))
      .mockResolvedValueOnce({ stdout: JSON.stringify(conflicting) });
    const sleepImpl = vi.fn(async () => undefined);

    await expect(recordRemoteCoordinatedRelease({
      sourceSha: SOURCE_SHA,
      workerVersionId: WORKER_ID,
      pagesContentId: PAGES_CONTENT_ID,
      pagesArtifactBuildId: 'pages-build-a',
      release: RELEASE,
      expectedPreviousSourceSha: 'none',
      now: () => new Date('2026-08-20T20:00:00.000Z'),
      verificationAttempts: 2,
      verificationDelayMs: 1,
      sleepImpl,
      execFileImpl,
    })).rejects.toThrow('did not verify after write');
    expect(sleepImpl).toHaveBeenCalledOnce();
  });

  it('is idempotent for the same release and rejects stale or destructive writes', async () => {
    const sameExec = vi.fn()
      .mockResolvedValueOnce(listResult(true))
      .mockResolvedValueOnce({ stdout: JSON.stringify(journal()) });
    await recordRemoteCoordinatedRelease({
      sourceSha: SOURCE_SHA,
      workerVersionId: WORKER_ID,
      pagesContentId: PAGES_CONTENT_ID,
      pagesArtifactBuildId: 'pages-build-a',
      release: RELEASE,
      expectedPreviousSourceSha: PREVIOUS_SHA,
      execFileImpl: sameExec,
    });
    expect(sameExec).toHaveBeenCalledTimes(2);

    const occupiedExec = vi.fn()
      .mockResolvedValueOnce(listResult(true))
      .mockResolvedValueOnce({ stdout: JSON.stringify(journal({ sourceSha: PREVIOUS_SHA })) });
    await expect(recordRemoteCoordinatedRelease({
      sourceSha: SOURCE_SHA,
      workerVersionId: WORKER_ID,
      pagesContentId: PAGES_CONTENT_ID,
      pagesArtifactBuildId: 'pages-build-a',
      release: RELEASE,
      expectedPreviousSourceSha: 'none',
      execFileImpl: occupiedExec,
    })).rejects.toThrow('first-write overwrite');

    const staleExec = vi.fn()
      .mockResolvedValueOnce(listResult(true))
      .mockResolvedValueOnce({ stdout: JSON.stringify(journal({ sourceSha: PREVIOUS_SHA })) });
    await expect(recordRemoteCoordinatedRelease({
      sourceSha: SOURCE_SHA,
      workerVersionId: WORKER_ID,
      pagesContentId: PAGES_CONTENT_ID,
      pagesArtifactBuildId: 'pages-build-a',
      release: RELEASE,
      expectedPreviousSourceSha: 'c'.repeat(40),
      execFileImpl: staleExec,
    })).rejects.toThrow('stale journal write');
  });

  it('emits line-safe GitHub state and supports an idempotent read CLI', async () => {
    expect(coordinatedReleaseGithubOutput(null)).toContain('established=false');
    expect(coordinatedReleaseGithubOutput(journal())).toContain(`source_sha=${SOURCE_SHA}`);

    const appendFileImpl = vi.fn(async () => undefined);
    const execFileImpl = vi.fn().mockResolvedValue(listResult(false));
    const stdout = { write: vi.fn() };
    await expect(runCli([
      'read', '--github-output', 'release-output.txt',
    ], { appendFileImpl, execFileImpl, stdout })).resolves.toBeNull();
    expect(appendFileImpl).toHaveBeenCalledWith(
      'release-output.txt',
      expect.stringContaining('established=false'),
      'utf8',
    );
    expect(stdout.write).toHaveBeenCalledWith('null\n');
  });

  it('records through the exact CLI contract and emits the verified identity', async () => {
    const execFileImpl = vi.fn()
      .mockResolvedValueOnce(listResult(false))
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce(listResult(true))
      .mockResolvedValueOnce({ stdout: JSON.stringify(journal()) });
    const appendFileImpl = vi.fn(async () => undefined);
    const stdout = { write: vi.fn() };

    await expect(runCli([
      'record',
      '--source-sha', SOURCE_SHA,
      '--worker-version-id', WORKER_ID,
      '--pages-content-id', PAGES_CONTENT_ID,
      '--pages-artifact-build-id', 'pages-build-a',
      '--expected-previous-source-sha', 'none',
      '--github-output', 'release-output.txt',
    ], {
      appendFileImpl,
      contract: { release: RELEASE },
      execFileImpl,
      now: () => new Date('2026-08-20T20:00:00.000Z'),
      stdout,
    })).resolves.toMatchObject({ sourceSha: SOURCE_SHA });

    expect(appendFileImpl).toHaveBeenCalledWith(
      'release-output.txt',
      expect.stringContaining(`worker_version_id=${WORKER_ID}`),
      'utf8',
    );
    expect(stdout.write).toHaveBeenCalledWith(
      `${JSON.stringify(journal())}\n`,
    );
  });
});
