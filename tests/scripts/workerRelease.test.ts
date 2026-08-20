// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { requireActiveWorkerVersion } from '../../scripts/active-worker-version.mjs';
import {
  requireWorkerVersionByTag,
  resolveRecentWorkerVersion,
} from '../../scripts/worker-version-by-tag.mjs';
import {
  parseExpectedTraffic,
  requireExactWorkerDeployment,
  verifyCurrentWorkerDeployment,
} from '../../scripts/verify-worker-deployment.mjs';

const OLD_ID = 'b667d0b0-cb02-482d-b418-bfb56826ee0f';
const NEW_ID = 'cba7bd5e-93f4-4df7-8b61-8f00d5b6f3a1';
const WORKFLOW_PATH = fileURLToPath(new URL('../../.github/workflows/deploy-worker.yml', import.meta.url));
const VALIDATION_WORKFLOW_PATH = fileURLToPath(new URL('../../.github/workflows/deploy.yml', import.meta.url));

describe('Worker release workflow ordering', () => {
  it('releases one exact SHA in Worker-first, Pages-last order', async () => {
    const workflow = await readFile(WORKFLOW_PATH, 'utf8');
    const fullCi = workflow.indexOf('End-to-end test exact artifact');
    const pagesArtifact = workflow.indexOf('Upload exact Pages artifact');
    const capture = workflow.indexOf('Capture exact production version');
    const upload = workflow.indexOf('Upload candidate Worker version without traffic');
    const stage = workflow.indexOf('Include candidate at zero traffic');
    const stagedVerification = workflow.indexOf('Verify zero-traffic deployment');
    const overrideWarm = workflow.indexOf('Build shadow caches and verify exact candidate');
    const promote = workflow.indexOf('Promote exact-ready candidate to all traffic');
    const ordinaryTraffic = workflow.indexOf('Verify exact-ready ordinary traffic');
    const restore = workflow.indexOf('Restore captured production version after failure');
    const pagesDeploy = workflow.indexOf('Deploy the tested Pages artifact');
    const pagesSmoke = workflow.indexOf('Verify exact Pages build and every shell asset');

    expect([
      fullCi,
      pagesArtifact,
      capture,
      upload,
      stage,
      stagedVerification,
      overrideWarm,
      promote,
      ordinaryTraffic,
      restore,
      pagesDeploy,
      pagesSmoke,
    ])
      .not.toContain(-1);
    expect(fullCi).toBeLessThan(pagesArtifact);
    expect(pagesArtifact).toBeLessThan(capture);
    expect(capture).toBeLessThan(upload);
    expect(upload).toBeLessThan(stage);
    expect(stage).toBeLessThan(stagedVerification);
    expect(stagedVerification).toBeLessThan(overrideWarm);
    expect(overrideWarm).toBeLessThan(promote);
    expect(promote).toBeLessThan(ordinaryTraffic);
    expect(ordinaryTraffic).toBeLessThan(restore);
    expect(restore).toBeLessThan(pagesDeploy);
    expect(pagesDeploy).toBeLessThan(pagesSmoke);
    expect(workflow).toContain("steps.previous.outputs.version_id }}@100%'");
    expect(workflow).toContain("steps.candidate.outputs.version_id }}@0%'");
    expect(workflow).toContain('--worker-name "$FRANK_WORKER_SCRIPT"');
    expect(workflow.match(/--worker-name/g)).toHaveLength(1);
    expect(workflow.match(/--require-target-ready-all/g)).toHaveLength(2);
    expect(workflow.match(/--read-only/g)).toHaveLength(1);
    expect(workflow.indexOf('--read-only')).toBeGreaterThan(ordinaryTraffic);
    expect(workflow.indexOf('--read-only')).toBeLessThan(restore);
    expect(workflow).toContain('needs: [build, worker_release]');
    expect(workflow).toContain('ref: ${{ github.sha }}');
    expect(workflow).toContain("steps.upload.outcome == 'success'");
    expect(workflow).toContain("steps.restore.outcome != 'skipped'");
    expect(workflow).toContain('--strict');
    expect(workflow).not.toContain('--compatible-min-version 6');
    expect(workflow).not.toMatch(/npm run worker:deploy(?:\s|$)/);
  });

  it('cannot publish Pages without the automatic audited-prior-API gate', async () => {
    const [workflow, warmScript] = await Promise.all([
      readFile(WORKFLOW_PATH, 'utf8'),
      readFile(fileURLToPath(new URL('../../scripts/warm-worker.mjs', import.meta.url)), 'utf8'),
    ]);
    expect(workflow).toContain('Build shadow caches and verify exact candidate');
    expect(workflow).toContain('Candidate gate: exact current target');
    expect(workflow).toContain(
      'Compatibility gate: breaking APIs blocked without continuous adapters',
    );
    expect(workflow).toContain('Post-promotion gate: read-only ordinary traffic');
    expect(workflow).toContain('--worker-name "$FRANK_WORKER_SCRIPT"');
    expect(warmScript).toContain(
      'auditedPriorApiReleases: contract.auditedPriorApiReleases',
    );
    expect(warmScript).toContain(
      '`api/v${priorRelease.apiSchemaVersion}/forecast/${encodeURIComponent(locationId)}`',
    );
    expect(warmScript).not.toContain(
      '`api/v${priorRelease.apiSchemaVersion}/forecast/${encodeURIComponent(locationId)}?warm=1`',
    );
  });

  it('keeps push and pull-request automation read-only', async () => {
    const workflow = await readFile(VALIDATION_WORKFLOW_PATH, 'utf8');
    expect(workflow).toContain('name: Validate FRANK');
    expect(workflow).not.toContain('actions/deploy-pages');
    expect(workflow).not.toContain('actions/upload-pages-artifact');
    expect(workflow).not.toContain('pages: write');
    expect(workflow).not.toContain('id-token: write');
  });

  it('validates the fail-closed compatibility policy before either release path can mutate', async () => {
    const [releaseWorkflow, validationWorkflow] = await Promise.all([
      readFile(WORKFLOW_PATH, 'utf8'),
      readFile(VALIDATION_WORKFLOW_PATH, 'utf8'),
    ]);
    const compatibilityGate = releaseWorkflow.indexOf('npm run release:check-contract');
    const candidateUpload = releaseWorkflow.indexOf('Upload candidate Worker version without traffic');

    expect(compatibilityGate).toBeGreaterThan(-1);
    expect(compatibilityGate).toBeLessThan(candidateUpload);
    expect(validationWorkflow).toContain('npm run release:check-contract');
  });
});

describe('Worker production baseline capture', () => {
  it('captures only one exact version at 100%', () => {
    expect(requireActiveWorkerVersion({
      versions: [{ version_id: OLD_ID, percentage: 100 }],
    })).toBe(OLD_ID);
  });

  it.each([
    { versions: [] },
    { versions: [{ version_id: OLD_ID, percentage: 99 }] },
    { versions: [
      { version_id: OLD_ID, percentage: 100 },
      { version_id: NEW_ID, percentage: 0 },
    ] },
  ])('rejects a non-atomic production baseline', (deployment) => {
    expect(() => requireActiveWorkerVersion(deployment)).toThrow(
      'exact single-version Worker deployment',
    );
  });
});

describe('Worker candidate version resolution', () => {
  it('selects the single immutable version with the release tag', () => {
    expect(requireWorkerVersionByTag([
      { id: OLD_ID, annotations: { 'workers/tag': 'older' } },
      { id: NEW_ID, annotations: { 'workers/tag': 'gh-123-1' } },
    ], 'gh-123-1')).toBe(NEW_ID);
  });

  it.each([
    null,
    [],
    [{ id: 'not-a-version', annotations: { 'workers/tag': 'gh-123-1' } }],
    [
      { id: OLD_ID, annotations: { 'workers/tag': 'gh-123-1' } },
      { id: NEW_ID, annotations: { 'workers/tag': 'gh-123-1' } },
    ],
  ])('fails closed for absent, ambiguous, or invalid tagged versions', (versions) => {
    expect(() => requireWorkerVersionByTag(versions, 'gh-123-1')).toThrow();
  });

  it('retries boundedly until the uploaded version appears in versions list JSON', async () => {
    const execFileImpl = vi.fn()
      .mockResolvedValueOnce({ stdout: '[]' })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          { id: NEW_ID, annotations: { 'workers/tag': 'gh-123-1' } },
        ]),
      });

    await expect(resolveRecentWorkerVersion({
      tag: 'gh-123-1',
      attempts: 2,
      retryDelayMs: 1,
      execFileImpl,
    })).resolves.toBe(NEW_ID);
    expect(execFileImpl).toHaveBeenCalledTimes(2);
    expect(execFileImpl.mock.calls[0][1]).toEqual(expect.arrayContaining([
      'versions', 'list', '--json',
    ]));
  });
});

describe('Worker deployment traffic verification', () => {
  it('accepts the captured version at 100% beside a zero-traffic candidate', () => {
    expect(requireExactWorkerDeployment({
      versions: [
        { version_id: OLD_ID, percentage: 100 },
        { version_id: NEW_ID, percentage: 0 },
      ],
    }, [`${OLD_ID}@100`, `${NEW_ID}@0`])).toBe(true);
  });

  it('accepts an exact single-version promotion', () => {
    expect(requireExactWorkerDeployment({
      versions: [{ version_id: NEW_ID, percentage: 100 }],
    }, [`${NEW_ID}@100%`])).toBe(true);
  });

  it.each([
    [`${OLD_ID}@99`, `${NEW_ID}@0`],
    [`${OLD_ID}@100`, `${OLD_ID}@0`],
    ['not-a-version@100'],
    [`${OLD_ID}@101`],
  ])('rejects invalid traffic specifications', (...specs) => {
    expect(() => parseExpectedTraffic(specs)).toThrow();
  });

  it.each([
    { versions: [{ version_id: OLD_ID, percentage: 100 }] },
    { versions: [
      { version_id: OLD_ID, percentage: 99 },
      { version_id: NEW_ID, percentage: 1 },
    ] },
    { versions: [
      { version_id: OLD_ID, percentage: 100 },
      { version_id: NEW_ID, percentage: 0 },
      { version_id: 'd379481d-184a-45a1-99b8-63c8de625fc9', percentage: 0 },
    ] },
  ])('rejects any deployment that is not the exact staged distribution', (deployment) => {
    expect(() => requireExactWorkerDeployment(
      deployment,
      [`${OLD_ID}@100`, `${NEW_ID}@0`],
    )).toThrow();
  });

  it('polls the pinned Wrangler deployment status until percentages propagate', async () => {
    const execFileImpl = vi.fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ versions: [{ version_id: OLD_ID, percentage: 100 }] }),
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          versions: [
            { version_id: OLD_ID, percentage: 100 },
            { version_id: NEW_ID, percentage: 0 },
          ],
        }),
      });

    await expect(verifyCurrentWorkerDeployment({
      specs: [`${OLD_ID}@100`, `${NEW_ID}@0`],
      attempts: 2,
      retryDelayMs: 1,
      execFileImpl,
    })).resolves.toBe(true);
    expect(execFileImpl).toHaveBeenCalledTimes(2);
    expect(execFileImpl.mock.calls[0][1]).toEqual(expect.arrayContaining([
      'deployments', 'status', '--json',
    ]));
  });
});
