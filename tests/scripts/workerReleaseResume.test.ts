// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  candidateTagForSourceSha,
  githubOutputForWorkerRelease,
  inspectWorkerRelease,
  parseCliArgs,
  resolveWorkerReleasePlan,
} from '../../scripts/resolve-worker-release.mjs';

const SOURCE_SHA = '18A2BB7D979E8222A1B872FF620664565167AEC6';
const NORMALIZED_SHA = SOURCE_SHA.toLowerCase();
const CANDIDATE_TAG = `frank-sha-${NORMALIZED_SHA}`;
const PRODUCTION_ID = 'b667d0b0-cb02-482d-b418-bfb56826ee0f';
const CANDIDATE_ID = 'cba7bd5e-93f4-4df7-8b61-8f00d5b6f3a1';
const OTHER_ID = 'd379481d-184a-45a1-99b8-63c8de625fc9';

function cleanDeployment(versionId = PRODUCTION_ID) {
  return { versions: [{ version_id: versionId, percentage: 100 }] };
}

function stagedDeployment(candidateId = CANDIDATE_ID) {
  return {
    versions: [
      { version_id: PRODUCTION_ID, percentage: 100 },
      { version_id: candidateId, percentage: 0 },
    ],
  };
}

function taggedVersion(id = CANDIDATE_ID, tag = CANDIDATE_TAG) {
  return { id, annotations: { 'workers/tag': tag } };
}

function productionVersion(tag = `frank-sha-${'1'.repeat(40)}`) {
  return taggedVersion(PRODUCTION_ID, tag);
}

function deployedVersionView(versionId: string) {
  if (versionId === PRODUCTION_ID) return productionVersion();
  if (versionId === CANDIDATE_ID) return taggedVersion();
  if (versionId === OTHER_ID) return taggedVersion(OTHER_ID, `frank-sha-${'3'.repeat(40)}`);
  return taggedVersion(versionId, 'manual-pre-baseline');
}

function resolvePlan(options: Parameters<typeof resolveWorkerReleasePlan>[0]) {
  const deployment = options?.deploymentStatus as {
    versions?: Array<{ version_id?: string, percentage?: number }>
  } | undefined;
  const productionId = deployment?.versions?.find(({ percentage }) => percentage === 100)?.version_id;
  const stagedId = deployment?.versions?.find(({ percentage }) => percentage === 0)?.version_id;
  return resolveWorkerReleasePlan({
    ...options,
    productionVersionView: options?.productionVersionView
      ?? (productionId ? deployedVersionView(productionId) : undefined),
    stagedCandidateVersionView: options?.stagedCandidateVersionView
      ?? (stagedId ? deployedVersionView(stagedId) : undefined),
  });
}

describe('deterministic Worker candidate identity', () => {
  it('derives one stable, lower-case version tag from the exact source SHA', () => {
    expect(candidateTagForSourceSha(SOURCE_SHA)).toBe(CANDIDATE_TAG);
  });

  it.each([
    '',
    '18a2bb7',
    `${NORMALIZED_SHA}0`,
    'not-a-git-sha-not-a-git-sha-not-a-git-sha',
  ])('rejects an abbreviated or malformed source identity', (sourceSha) => {
    expect(() => candidateTagForSourceSha(sourceSha)).toThrow('exact 40-character');
  });
});

describe('resumable Worker release plan', () => {
  it('asks for one upload when no version exists for this source SHA', () => {
    expect(resolvePlan({
      sourceSha: SOURCE_SHA,
      deploymentStatus: cleanDeployment(),
      versionsList: [
        productionVersion(),
        taggedVersion(OTHER_ID, `frank-sha-${'2'.repeat(40)}`),
      ],
    })).toEqual({
      action: 'upload',
      sourceSha: NORMALIZED_SHA,
      candidateTag: CANDIDATE_TAG,
      deploymentMode: 'clean',
      productionVersionId: PRODUCTION_ID,
      productionSourceSha: '1'.repeat(40),
      candidateVersionId: '',
      stagedCandidateVersionId: '',
      stagedCandidateSourceSha: '',
    });
  });

  it('reuses an uploaded immutable candidate instead of requesting another upload', () => {
    expect(resolvePlan({
      sourceSha: SOURCE_SHA,
      deploymentStatus: cleanDeployment(),
      versionsList: [productionVersion(), taggedVersion()],
    })).toMatchObject({
      action: 'stage',
      productionVersionId: PRODUCTION_ID,
      candidateVersionId: CANDIDATE_ID,
    });
  });

  it('leaves the production source empty only for the explicit pre-baseline tag shape', () => {
    expect(resolvePlan({
      sourceSha: SOURCE_SHA,
      deploymentStatus: cleanDeployment(),
      versionsList: [productionVersion('manual-pre-baseline')],
      productionVersionView: productionVersion('manual-pre-baseline'),
    })).toMatchObject({
      action: 'upload',
      productionVersionId: PRODUCTION_ID,
      productionSourceSha: '',
    });
  });

  it('does not depend on the capped list for the captured production identity', () => {
    expect(resolvePlan({
      sourceSha: SOURCE_SHA,
      deploymentStatus: cleanDeployment(),
      versionsList: [taggedVersion()],
    })).toMatchObject({
      action: 'stage',
      productionSourceSha: '1'.repeat(40),
      productionVersionId: PRODUCTION_ID,
    });
  });

  it('resumes warming only when the expected candidate is already at zero traffic', () => {
    expect(resolvePlan({
      sourceSha: SOURCE_SHA,
      deploymentStatus: stagedDeployment(),
      versionsList: [productionVersion(), taggedVersion()],
    })).toMatchObject({
      action: 'warm',
      deploymentMode: 'staged',
      productionVersionId: PRODUCTION_ID,
      candidateVersionId: CANDIDATE_ID,
    });
  });

  it('returns a typed replacement plan for an older deterministic zero-traffic candidate', () => {
    const olderSha = '3'.repeat(40);
    expect(resolvePlan({
      sourceSha: SOURCE_SHA,
      deploymentStatus: stagedDeployment(OTHER_ID),
      versionsList: [
        productionVersion(),
        taggedVersion(OTHER_ID, `frank-sha-${olderSha}`),
      ],
    })).toMatchObject({
      action: 'replace-staged',
      productionVersionId: PRODUCTION_ID,
      candidateVersionId: '',
      stagedCandidateVersionId: OTHER_ID,
      stagedCandidateSourceSha: olderSha,
    });
  });

  it('reuses the desired upload after safely replacing an older staged candidate', () => {
    const olderSha = '3'.repeat(40);
    expect(resolvePlan({
      sourceSha: SOURCE_SHA,
      deploymentStatus: stagedDeployment(OTHER_ID),
      versionsList: [
        productionVersion(),
        taggedVersion(),
        taggedVersion(OTHER_ID, `frank-sha-${olderSha}`),
      ],
    })).toMatchObject({
      action: 'replace-staged',
      candidateVersionId: CANDIDATE_ID,
      stagedCandidateVersionId: OTHER_ID,
      stagedCandidateSourceSha: olderSha,
    });
  });

  it('is complete when the exact tagged version already serves all traffic', () => {
    expect(resolvePlan({
      sourceSha: SOURCE_SHA,
      deploymentStatus: cleanDeployment(CANDIDATE_ID),
      versionsList: [taggedVersion()],
    })).toMatchObject({
      action: 'complete',
      productionVersionId: CANDIDATE_ID,
      productionSourceSha: NORMALIZED_SHA,
      candidateVersionId: CANDIDATE_ID,
    });
  });

  it.each([
    {
      name: 'an untagged zero-traffic version',
      deploymentStatus: stagedDeployment(),
      versionsList: [productionVersion()],
      stagedCandidateVersionView: taggedVersion(CANDIDATE_ID, 'manual-candidate'),
    },
    {
      name: 'an ambiguous deterministic tag',
      deploymentStatus: cleanDeployment(),
      versionsList: [productionVersion(), taggedVersion(), taggedVersion(OTHER_ID)],
    },
  ])('fails closed for $name', ({ deploymentStatus, versionsList, stagedCandidateVersionView }) => {
    expect(() => resolvePlan({
      sourceSha: SOURCE_SHA,
      deploymentStatus,
      versionsList,
      stagedCandidateVersionView,
    })).toThrow();
  });

  it.each([
    null,
    {},
    { versions: [] },
    { versions: [{ version_id: PRODUCTION_ID, percentage: 99 }] },
    { versions: [
      { version_id: PRODUCTION_ID, percentage: 99 },
      { version_id: CANDIDATE_ID, percentage: 1 },
    ] },
    { versions: [
      { version_id: PRODUCTION_ID, percentage: 100 },
      { version_id: CANDIDATE_ID, percentage: 0 },
      { version_id: OTHER_ID, percentage: 0 },
    ] },
    { versions: [
      { version_id: PRODUCTION_ID, percentage: 100 },
      { version_id: PRODUCTION_ID, percentage: 0 },
    ] },
  ])('rejects every deployment outside the exact single-100 or 100/0 forms', (deploymentStatus) => {
    expect(() => resolvePlan({
      sourceSha: SOURCE_SHA,
      deploymentStatus,
      versionsList: [],
    })).toThrow();
  });
});

describe('read-only Wrangler inspection', () => {
  it('uses exact version views and sandwiches every identity read', async () => {
    const execFileImpl = vi.fn()
      .mockResolvedValueOnce({ stdout: JSON.stringify(cleanDeployment()) })
      .mockResolvedValueOnce({ stdout: JSON.stringify([taggedVersion()]) })
      .mockResolvedValueOnce({ stdout: JSON.stringify(productionVersion()) })
      .mockResolvedValueOnce({ stdout: JSON.stringify(cleanDeployment()) });

    await expect(inspectWorkerRelease({ sourceSha: SOURCE_SHA, execFileImpl }))
      .resolves.toMatchObject({ action: 'stage', candidateVersionId: CANDIDATE_ID });
    expect(execFileImpl).toHaveBeenCalledTimes(4);
    expect(execFileImpl.mock.calls.map((call) => call[1].slice(1))).toEqual([
      ['deployments', 'status', '--json'],
      ['versions', 'list', '--json'],
      ['versions', 'view', PRODUCTION_ID, '--json'],
      ['deployments', 'status', '--json'],
    ]);
    for (const [executable, args, options] of execFileImpl.mock.calls) {
      expect(executable).toBe(process.execPath);
      expect(Array.isArray(args)).toBe(true);
      expect(options).toMatchObject({ windowsHide: true, encoding: 'utf8' });
    }
  });

  it('fails closed if production traffic changes during inspection', async () => {
    const execFileImpl = vi.fn()
      .mockResolvedValueOnce({ stdout: JSON.stringify(cleanDeployment()) })
      .mockResolvedValueOnce({ stdout: JSON.stringify([taggedVersion()]) })
      .mockResolvedValueOnce({ stdout: JSON.stringify(productionVersion()) })
      .mockResolvedValueOnce({ stdout: JSON.stringify(stagedDeployment()) });

    await expect(inspectWorkerRelease({ sourceSha: SOURCE_SHA, execFileImpl }))
      .rejects.toThrow('changed during release inspection');
  });

  it('resolves active and staged identities from exact views even when both are absent from list', async () => {
    const execFileImpl = vi.fn()
      .mockResolvedValueOnce({ stdout: JSON.stringify(stagedDeployment()) })
      .mockResolvedValueOnce({ stdout: '[]' })
      .mockResolvedValueOnce({ stdout: JSON.stringify(productionVersion()) })
      .mockResolvedValueOnce({ stdout: JSON.stringify(taggedVersion()) })
      .mockResolvedValueOnce({ stdout: JSON.stringify(stagedDeployment()) });

    await expect(inspectWorkerRelease({ sourceSha: SOURCE_SHA, execFileImpl }))
      .resolves.toMatchObject({
        action: 'warm',
        productionSourceSha: '1'.repeat(40),
        stagedCandidateSourceSha: NORMALIZED_SHA,
        candidateVersionId: CANDIDATE_ID,
      });
    expect(execFileImpl.mock.calls.map((call) => call[1])).toEqual([
      expect.arrayContaining(['deployments', 'status', '--json']),
      expect.arrayContaining(['versions', 'list', '--json']),
      expect.arrayContaining(['versions', 'view', PRODUCTION_ID, '--json']),
      expect.arrayContaining(['versions', 'view', CANDIDATE_ID, '--json']),
      expect.arrayContaining(['deployments', 'status', '--json']),
    ]);
  });

  it.each([
    {
      name: 'malformed production view',
      deployment: cleanDeployment(),
      views: [{ id: PRODUCTION_ID, annotations: null }],
    },
    {
      name: 'mismatched production view',
      deployment: cleanDeployment(),
      views: [taggedVersion(OTHER_ID, `frank-sha-${'1'.repeat(40)}`)],
    },
    {
      name: 'malformed staged view',
      deployment: stagedDeployment(),
      views: [productionVersion(), { id: CANDIDATE_ID, annotations: null }],
    },
    {
      name: 'mismatched staged view',
      deployment: stagedDeployment(),
      views: [productionVersion(), taggedVersion(OTHER_ID)],
    },
  ])('fails closed for a $name', async ({ deployment, views }) => {
    const execFileImpl = vi.fn()
      .mockResolvedValueOnce({ stdout: JSON.stringify(deployment) })
      .mockResolvedValueOnce({ stdout: '[]' });
    for (const view of views) {
      execFileImpl.mockResolvedValueOnce({ stdout: JSON.stringify(view) });
    }

    await expect(inspectWorkerRelease({ sourceSha: SOURCE_SHA, execFileImpl })).rejects.toThrow();
  });

  it.each([
    { stdout: 'not json' },
    { stdout: 42 },
    {},
  ])('rejects malformed Wrangler JSON adapter output', async (result) => {
    const execFileImpl = vi.fn().mockResolvedValue(result);
    await expect(inspectWorkerRelease({ sourceSha: SOURCE_SHA, execFileImpl })).rejects.toThrow();
  });
});

describe('release-resume CLI contract', () => {
  it('emits concise, line-safe GitHub outputs', () => {
    const plan = resolvePlan({
      sourceSha: SOURCE_SHA,
      deploymentStatus: stagedDeployment(),
      versionsList: [productionVersion(), taggedVersion()],
    });
    expect(githubOutputForWorkerRelease(plan)).toBe([
      'action=warm',
      `source_sha=${NORMALIZED_SHA}`,
      `candidate_tag=${CANDIDATE_TAG}`,
      'deployment_mode=staged',
      `production_version_id=${PRODUCTION_ID}`,
      `production_source_sha=${'1'.repeat(40)}`,
      `candidate_version_id=${CANDIDATE_ID}`,
      `staged_candidate_version_id=${CANDIDATE_ID}`,
      `staged_candidate_source_sha=${NORMALIZED_SHA}`,
      '',
    ].join('\n'));
  });

  it('accepts only the explicit source SHA and optional GitHub output path', () => {
    expect(parseCliArgs([
      '--source-sha', SOURCE_SHA,
      '--github-output', 'release-output.txt',
    ])).toEqual({
      sourceSha: NORMALIZED_SHA,
      githubOutput: 'release-output.txt',
    });
  });

  it.each([
    [],
    ['--source-sha'],
    ['--source-sha', SOURCE_SHA, '--github-output', ''],
    ['--source-sha', SOURCE_SHA, '--source-sha', SOURCE_SHA],
    ['--tag', CANDIDATE_TAG],
    ['unexpected'],
  ])('rejects ambiguous CLI arguments', (argv) => {
    expect(() => parseCliArgs(argv)).toThrow();
  });
});
