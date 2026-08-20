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

describe('Impact-aware production workflow', () => {
  it('starts only manually or from opted-in successful main validation and resume ticks', async () => {
    const workflow = await readFile(WORKFLOW_PATH, 'utf8');

    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('workflow_run:');
    expect(workflow).toContain('workflows: [Validate FRANK]');
    expect(workflow).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(workflow).toContain("github.event.workflow_run.event == 'push'");
    expect(workflow).toContain("github.event.workflow_run.head_branch == 'main'");
    expect(workflow).toContain("cron: '*/10 * * * *'");
    expect(workflow).toContain("vars.FRANK_AUTO_RELEASE_ENABLED == 'true'");
    expect(workflow).toContain('group: frank-production');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).toContain('Retry only immutable shadow readiness before rebuilding');
    expect(workflow).toContain('Full CI and the Pages artifact were not rebuilt on this waiting tick.');
  });

  it('repairs a promoted split source before releasing a newer main SHA', async () => {
    const workflow = await readFile(WORKFLOW_PATH, 'utf8');

    expect(workflow).toContain('Select desired source or repair-forward source');
    expect(workflow).toContain('effective_source_sha="$ACTIVE_WORKER_SOURCE"');
    expect(workflow).toContain('ACTIVE_WORKER_VERSION" != "$JOURNAL_WORKER_VERSION');
    expect(workflow).toContain('"$JOURNAL_ESTABLISHED" != true && "$ACTION" == complete');
    expect(workflow).toContain('"$JOURNAL_SOURCE_SHA" != "$REQUESTED_SOURCE_SHA"');
    expect(workflow).toContain('recovery_mode=true');
    expect(workflow).toContain('ref: ${{ needs.release_source.outputs.source_sha }}');
  });

  it('classifies every explicit delivery impact from an immutable coordinated base', async () => {
    const workflow = await readFile(WORKFLOW_PATH, 'utf8');

    for (const impact of [
      'none',
      'pages-only',
      'worker-nonsemantic',
      'location-change',
      'forecast-semantic',
      'breaking-api',
    ]) expect(workflow).toContain(impact);
    expect(workflow).toContain('scripts/release-impact-snapshot.mjs');
    expect(workflow).toContain('scripts/release-impact.mjs');
    expect(workflow).toContain('npm run release:coordinated -- read');
    expect(workflow).toContain('--trusted-base coordinated-impact.json');
    expect(workflow).toContain('Verify coordinated or recoverable split state');
    expect(workflow).toContain('ACTIVE_WORKER_VERSION');
    expect(workflow).toContain('JOURNAL_WORKER_VERSION');
  });

  it('never stages a Worker for pages-only and never records waiting as production', async () => {
    const workflow = await readFile(WORKFLOW_PATH, 'utf8');
    const stage = workflow.indexOf('Include candidate at zero traffic');
    const promoteJob = workflow.indexOf('  promote_worker:');
    const pagesJob = workflow.indexOf('  pages_release:');

    expect(stage).toBeGreaterThan(-1);
    expect(workflow.slice(stage, stage + 500)).toContain("steps.candidate.outputs.version_id != ''");
    expect(workflow).toContain("steps.decision.outputs.worker_change == 'true'");
    expect(workflow.slice(pagesJob, workflow.indexOf('  finalize_release:')))
      .toContain("needs.shadow.outputs.impact == 'pages-only'");
    expect(workflow).toContain('--allow-waiting');
    expect(workflow).toContain('--github-output "$GITHUB_OUTPUT"');
    expect(workflow).toContain('ready_for_promotion: ${{ steps.state.outputs.ready_for_promotion }}');
    expect(workflow.slice(promoteJob, pagesJob))
      .toContain("needs.shadow.outputs.ready_for_promotion == 'true'");
    expect(workflow).toContain('The candidate remains at zero traffic. A later scheduled run may resume it.');
    expect(workflow.match(/deployment: false/g)).toHaveLength(3);
    expect(workflow).toContain('FRANK_WARM_TOKEN: ${{ secrets.FRANK_WARM_TOKEN }}');
    expect(workflow.slice(
      workflow.indexOf('Inspect reusable or already-promoted caches read-only'),
      workflow.indexOf('Collect typed candidate readiness'),
    )).not.toContain('FRANK_WARM_TOKEN');
  });

  it('removes or replaces stale zero-traffic candidates without wedging the next SHA', async () => {
    const workflow = await readFile(WORKFLOW_PATH, 'utf8');
    const cleanup = workflow.indexOf('Remove irrelevant or superseded zero-traffic candidate');
    const upload = workflow.indexOf('Upload candidate Worker version without traffic');
    const stage = workflow.indexOf('Include candidate at zero traffic');

    expect(workflow).toContain("steps.resolve.outputs.action == 'replace-staged'");
    expect(cleanup).toBeGreaterThan(-1);
    expect(cleanup).toBeLessThan(upload);
    expect(upload).toBeLessThan(stage);
    expect(workflow).toContain('steps.resolve.outputs.candidate_version_id == \'\'');
    expect(workflow).toContain('Discard superseded prepared candidate');
    expect(workflow).toContain("steps.fresh_after_gate.outputs.current == 'false'");
  });

  it('preserves conservative first baseline and records coordination only after publication', async () => {
    const workflow = await readFile(WORKFLOW_PATH, 'utf8');
    const bootstrap = workflow.indexOf('Preserve the one-time conservative bootstrap');
    const promote = workflow.indexOf('Promote exact-ready candidate to all traffic');
    const pagesVerify = workflow.indexOf('Verify exact Pages build and every shell asset');
    const journal = workflow.indexOf('Record coordinated Worker and Pages identity');
    const baseline = workflow.indexOf('Record coordinated Worker baseline');
    const cleanup = workflow.indexOf('Garbage-collect superseded forecast generations');

    expect([bootstrap, promote, pagesVerify, journal, baseline, cleanup]).not.toContain(-1);
    expect(bootstrap).toBeLessThan(promote);
    expect(workflow).toContain('impact=forecast-semantic');
    expect(pagesVerify).toBeLessThan(journal);
    expect(baseline).toBeLessThan(journal);
    expect(journal).toBeLessThan(cleanup);
    expect(workflow).toContain('--expected-previous-source-sha "$expected_previous"');
    expect(workflow.slice(cleanup, workflow.indexOf('Summarize coordinated release')))
      .toContain('continue-on-error: true');
  });

  it('guards the SHA before both shadow mutation and promotion', async () => {
    const workflow = await readFile(WORKFLOW_PATH, 'utf8');
    const shadowGuard = workflow.indexOf('Recheck effective source before any shadow mutation');
    const upload = workflow.indexOf('Upload candidate Worker version without traffic');
    const postWarmGuard = workflow.indexOf('Recheck main after shadow preparation');
    const promotionGuard = workflow.indexOf('Fail closed if main moved before promotion');
    const promote = workflow.indexOf('Promote exact-ready candidate to all traffic');

    expect(shadowGuard).toBeGreaterThan(-1);
    expect(shadowGuard).toBeLessThan(upload);
    expect(postWarmGuard).toBeGreaterThan(upload);
    expect(postWarmGuard).toBeLessThan(promotionGuard);
    expect(promotionGuard).toBeGreaterThan(upload);
    expect(promotionGuard).toBeLessThan(promote);
    expect(workflow).toContain('production_source_sha');
    expect(workflow).toContain('candidate_tag');
    expect(workflow).toContain('--strict');
  });

  it('revalidates both live products before recording both Pages identities', async () => {
    const workflow = await readFile(WORKFLOW_PATH, 'utf8');
    const pagesVerify = workflow.indexOf('Verify exact Pages build and every shell asset');
    const workerVerify = workflow.indexOf('Reverify exact live Worker deployment');
    const changedWorkerVerify = workflow.indexOf('Reverify changed Worker readiness without provider calls');
    const unchangedWorkerVerify = workflow.indexOf('Reattest unchanged Worker API identity without forecast freshness');
    const finalPagesVerify = workflow.indexOf('Reverify exact live Pages artifact');
    const baseline = workflow.indexOf('Record coordinated Worker baseline');
    const journal = workflow.indexOf('Record coordinated Worker and Pages identity');

    expect(pagesVerify).toBeGreaterThan(-1);
    expect(workerVerify).toBeGreaterThan(pagesVerify);
    expect(workerVerify).toBeLessThan(changedWorkerVerify);
    expect(changedWorkerVerify).toBeLessThan(unchangedWorkerVerify);
    expect(unchangedWorkerVerify).toBeLessThan(finalPagesVerify);
    expect(finalPagesVerify).toBeLessThan(baseline);
    expect(baseline).toBeLessThan(journal);
    expect(workflow.slice(workerVerify, changedWorkerVerify)).toContain('worker:verify-deployment');
    expect(workflow.slice(changedWorkerVerify, unchangedWorkerVerify)).toContain('--read-only');
    expect(workflow.slice(unchangedWorkerVerify, finalPagesVerify)).toContain('worker:attest-active-release');
    expect(workflow.slice(unchangedWorkerVerify, finalPagesVerify)).toContain('--github-output "$GITHUB_OUTPUT"');
    expect(workflow.slice(unchangedWorkerVerify, finalPagesVerify)).not.toContain('--require-target-ready-all');
    expect(workflow.slice(finalPagesVerify, baseline)).toContain('verify-pages-release.mjs');
    expect(workflow.slice(workflow.indexOf('  finalize_release:'), workerVerify)).toContain('pages: read');
    expect(workflow).toContain('--pages-content-id "$CANDIDATE_PAGES_CONTENT_ID"');
    expect(workflow).toContain('--pages-artifact-build-id "$LIVE_PAGES_ARTIFACT_BUILD_ID"');
    expect(workflow).toContain("needs.shadow.outputs.journal_established == 'true'");
    expect(workflow).toContain('Check live Pages against the coordinated journal');
    expect(workflow).toContain('LIVE_PAGES_MATCHES_JOURNAL');
    expect(workflow).toContain('if [[ "$LIVE_PAGES_MATCHES_JOURNAL" != true ]]; then pages_changed=true; fi');
  });

  it('keeps audited compatibility checks and exact rollback around mutations', async () => {
    const [workflow, warmScript] = await Promise.all([
      readFile(WORKFLOW_PATH, 'utf8'),
      readFile(fileURLToPath(new URL('../../scripts/warm-worker.mjs', import.meta.url)), 'utf8'),
    ]);
    const compatibilityGate = workflow.indexOf('npm run release:check-contract');
    const candidateUpload = workflow.indexOf('Upload candidate Worker version without traffic');

    expect(compatibilityGate).toBeGreaterThan(-1);
    expect(compatibilityGate).toBeLessThan(candidateUpload);
    expect(workflow).toContain('Restore captured production after a hard shadow failure');
    expect(workflow).toContain('Restore captured production version after promotion failure');
    expect(workflow).toContain('--attested-active-release');
    expect(workflow).not.toContain('--compatible-min-version');
    expect(workflow).not.toMatch(/npm run worker:deploy(?:\s|$)/);
    expect(warmScript).toContain(
      'auditedPriorApiReleases: contract.auditedPriorApiReleases',
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

  it('validates the fail-closed compatibility policy in read-only CI too', async () => {
    const validationWorkflow = await readFile(VALIDATION_WORKFLOW_PATH, 'utf8');
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
