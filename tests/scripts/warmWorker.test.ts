// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_WARM_TOTAL_TIMEOUT_MS,
  WARM_LOCATION_IDS,
  warmWorkerLocations,
} from '../../scripts/warm-worker.mjs';

const BASE_URL = 'https://frank-forecast.example.workers.dev';
const TOKEN = 'test-deployment-warm-token';

function readyResponse() {
  return new Response('{}', { status: 200 });
}

function initializingResponse(retryAfter = '2', code = 'FORECAST_INITIALIZING') {
  return new Response(JSON.stringify({ code }), {
    status: 503,
    headers: retryAfter === null ? undefined : { 'Retry-After': retryAfter },
  });
}

function locationIdFrom(url: string) {
  return new URL(url).pathname.split('/').at(-1)!;
}

function silentLogger() {
  return { info: vi.fn() };
}

describe('deployment Worker warm-up', () => {
  it('warms all four exact forecast URLs serially with bearer auth and no secret logging', async () => {
    let inFlight = 0;
    let maximumInFlight = 0;
    const fetchImpl = vi.fn(async () => {
      inFlight += 1;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return readyResponse();
    });
    const logger = silentLogger();

    await warmWorkerLocations({ baseUrl: `${BASE_URL}/`, token: TOKEN, fetchImpl, logger });

    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual(
      WARM_LOCATION_IDS.map((locationId) =>
        `${BASE_URL}/api/v1/forecast/${locationId}?warm=1`),
    );
    expect(maximumInFlight).toBe(1);
    for (const [, init] of fetchImpl.mock.calls) {
      const request = init as RequestInit;
      expect(new Headers(request.headers).get('Authorization')).toBe(`Bearer ${TOKEN}`);
      expect(request.redirect).toBe('error');
    }
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain(TOKEN);
    expect(logger.info).toHaveBeenLastCalledWith(
      '[worker-warm] All four forecast locations are ready.',
    );
  });

  it('honours Retry-After while warming the other cities before the retry', async () => {
    let nowMs = 1_000;
    let horsensAttempts = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      const locationId = locationIdFrom(url);
      if (locationId === 'horsens' && horsensAttempts++ === 0) {
        return initializingResponse('2');
      }
      return readyResponse();
    });
    const sleepImpl = vi.fn(async (delayMs: number) => {
      nowMs += delayMs;
    });

    await warmWorkerLocations({
      baseUrl: BASE_URL,
      token: TOKEN,
      fetchImpl,
      now: () => nowMs,
      sleepImpl,
      logger: silentLogger(),
      totalTimeoutMs: 5_000,
    });

    expect(fetchImpl.mock.calls.map(([url]) => locationIdFrom(String(url)))).toEqual([
      'horsens',
      'vejle',
      'kolding',
      'aarhus',
      'horsens',
    ]);
    expect(sleepImpl).toHaveBeenCalledOnce();
    expect(sleepImpl).toHaveBeenCalledWith(2_000);
  });

  it('allows two full initialization cooldowns before the candidate gate closes', async () => {
    let nowMs = 1_000;
    let aarhusAttempts = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      const locationId = locationIdFrom(url);
      if (locationId === 'aarhus' && aarhusAttempts++ < 2) {
        return initializingResponse('600');
      }
      return readyResponse();
    });
    const sleepImpl = vi.fn(async (delayMs: number) => {
      nowMs += delayMs;
    });

    await warmWorkerLocations({
      baseUrl: BASE_URL,
      token: TOKEN,
      fetchImpl,
      now: () => nowMs,
      sleepImpl,
      logger: silentLogger(),
    });

    expect(DEFAULT_WARM_TOTAL_TIMEOUT_MS).toBe(25 * 60_000);
    expect(fetchImpl.mock.calls.map(([url]) => locationIdFrom(String(url)))).toEqual([
      'horsens',
      'vejle',
      'kolding',
      'aarhus',
      'aarhus',
      'aarhus',
    ]);
    expect(sleepImpl.mock.calls).toEqual([[600_000], [600_000]]);
  });

  it('fails the release when exactly one city cannot retry within the global deadline', async () => {
    let nowMs = 1_000;
    const fetchImpl = vi.fn(async (url: string) =>
      locationIdFrom(url) === 'horsens' ? initializingResponse('2') : readyResponse());
    const sleepImpl = vi.fn(async (delayMs: number) => {
      nowMs += delayMs;
    });

    await expect(warmWorkerLocations({
      baseUrl: BASE_URL,
      token: TOKEN,
      fetchImpl,
      now: () => nowMs,
      sleepImpl,
      logger: silentLogger(),
      totalTimeoutMs: 2_500,
    })).rejects.toThrow('locations not ready: horsens');

    expect(fetchImpl.mock.calls.map(([url]) => locationIdFrom(String(url)))).toEqual([
      'horsens',
      'vejle',
      'kolding',
      'aarhus',
      'horsens',
    ]);
    expect(sleepImpl).toHaveBeenCalledWith(2_000);
  });

  it.each([
    ['404', () => new Response('{}', { status: 404 }), 'verify the FRANK_WARM_TOKEN'],
    ['generic 503', () => initializingResponse('2', 'OTHER_ERROR'), 'did not contain FORECAST_INITIALIZING'],
    ['503 without Retry-After', () => initializingResponse(null), 'no valid Retry-After'],
    ['unexpected status', () => new Response('{}', { status: 500 }), 'unexpected HTTP 500'],
  ])('fails closed without retrying a %s response', async (_case, response, message) => {
    const fetchImpl = vi.fn(async () => response());

    await expect(warmWorkerLocations({
      baseUrl: BASE_URL,
      token: TOKEN,
      fetchImpl,
      logger: silentLogger(),
    })).rejects.toThrow(message);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('rejects missing repository settings before fetch and never exposes the token in errors', async () => {
    const fetchImpl = vi.fn(async () => readyResponse());
    await expect(warmWorkerLocations({
      baseUrl: '',
      token: TOKEN,
      fetchImpl,
    })).rejects.toThrow('FRANK_WORKER_BASE_URL is missing');
    await expect(warmWorkerLocations({
      baseUrl: BASE_URL,
      token: '',
      fetchImpl,
    })).rejects.toThrow('FRANK_WARM_TOKEN is missing');
    expect(fetchImpl).not.toHaveBeenCalled();

    const leakingFetch = vi.fn(async () => {
      throw new Error(`Authorization: Bearer ${TOKEN}`);
    });
    let failure = '';
    try {
      await warmWorkerLocations({
        baseUrl: BASE_URL,
        token: TOKEN,
        fetchImpl: leakingFetch,
        logger: silentLogger(),
      });
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    expect(failure).toContain('horsens: request failed');
    expect(failure).not.toContain(TOKEN);
    expect(failure).not.toContain('Authorization');
  });

  it('orders candidate upload, warm, promotion, and Pages as fail-closed workflow gates', async () => {
    const workflow = await readFile('.github/workflows/deploy.yml', 'utf8');
    const validateJob = workflow.indexOf('  validate:');
    const uploadJob = workflow.indexOf('  upload_candidate:');
    const previewSettingsStepStart = workflow.indexOf(
      '- name: Enable Worker version preview URLs (manual bootstrap)',
    );
    const previewSettingsCommand = workflow.indexOf('npx wrangler triggers deploy');
    const uploadCommand = workflow.indexOf('npx wrangler versions upload');
    const warmJob = workflow.indexOf('  warm_candidate:');
    const warmCommand = workflow.indexOf('node scripts/warm-worker.mjs');
    const promoteJob = workflow.indexOf('  promote_worker:');
    const promoteCommand = workflow.indexOf('npx wrangler versions deploy');
    const cleanupStep = workflow.indexOf('- name: Clean stale KV generations (best effort)');
    const cleanupCommand = workflow.indexOf('npm run worker:gc-kv');
    const pagesJob = workflow.indexOf('  deploy_pages:');
    const uploadJobBody = workflow.slice(uploadJob, warmJob);
    const previewSettingsStep = workflow.slice(previewSettingsStepStart, uploadCommand);
    const warmJobBody = workflow.slice(warmJob, promoteJob);
    const promoteJobBody = workflow.slice(promoteJob, pagesJob);
    const promotionGateBody = workflow.slice(promoteJob, cleanupStep);
    const cleanupStepBody = workflow.slice(cleanupStep, cleanupCommand);
    const pagesJobBody = workflow.slice(pagesJob);

    expect(validateJob).toBeGreaterThan(-1);
    expect(validateJob).toBeLessThan(uploadJob);
    expect(uploadJob).toBeLessThan(previewSettingsStepStart);
    expect(previewSettingsStepStart).toBeLessThan(previewSettingsCommand);
    expect(previewSettingsCommand).toBeLessThan(uploadCommand);
    expect(uploadCommand).toBeLessThan(warmJob);
    expect(warmJob).toBeLessThan(warmCommand);
    expect(warmCommand).toBeLessThan(promoteJob);
    expect(promoteJob).toBeLessThan(promoteCommand);
    expect(promoteCommand).toBeLessThan(cleanupStep);
    expect(cleanupStep).toBeLessThan(cleanupCommand);
    expect(cleanupCommand).toBeLessThan(pagesJob);

    expect(uploadJobBody).toContain('needs: validate');
    expect(uploadJobBody).toContain('version_id: ${{ steps.candidate.outputs.version_id }}');
    expect(uploadJobBody).toContain('preview_url: ${{ steps.candidate.outputs.preview_url }}');
    expect(uploadJobBody).toContain('npx wrangler deployments status --json');
    expect(uploadJobBody).toContain('npx wrangler triggers deploy');
    expect(previewSettingsStep).toContain("if: github.event_name == 'workflow_dispatch'");
    expect(uploadJobBody).toContain('WRANGLER_OUTPUT_FILE_PATH: ${{ runner.temp }}/frank-version-upload.ndjson');
    expect(uploadJobBody).toContain("record?.type === 'version-upload'");
    expect(uploadJobBody).toContain('sessionRecords.length !== 1');
    expect(uploadJobBody).toContain('sessionRecords[0]?.version !== 1');
    expect(uploadJobBody).toContain('candidateRecords.length !== 1');
    expect(uploadJobBody).toContain('candidateRecords[0]?.version !== 1');
    expect(uploadJobBody).not.toContain('uploadRecords.length !== 2');
    expect(uploadJobBody).toContain('candidateRecords[0].version_id');
    expect(uploadJobBody).toContain('candidateRecords[0].preview_url');
    expect(uploadJobBody).toContain(
      'FRANK_WORKER_BASE_URL: ${{ vars.FRANK_WORKER_BASE_URL }}',
    );
    expect(uploadJobBody).toContain('process.env.FRANK_WORKER_BASE_URL');
    expect(uploadJobBody).toContain("productionUrl.protocol !== 'https:'");
    expect(uploadJobBody).toContain(
      "'https://' + candidateVersionId.slice(0, 8) + '-' + productionUrl.hostname",
    );
    expect(uploadJobBody).toContain('parsedPreviewUrl.origin !== expectedPreviewOrigin');
    expect(uploadJobBody).toContain("parsedPreviewUrl.pathname !== '/'");
    expect(workflow).not.toContain('alswatchs.workers.dev');
    expect(uploadJobBody).toContain('appendFileSync(process.env.GITHUB_OUTPUT');
    expect(uploadJobBody).toContain("'version_id=' + candidateVersionId");
    expect(uploadJobBody).toContain("'preview_url=' + candidatePreviewUrl");
    expect(uploadJobBody).toContain('GITHUB_STEP_SUMMARY');
    expect(uploadJobBody).toContain("'Candidate version ID: ' + candidateVersionId");
    expect(uploadJobBody).toContain("'    wrangler versions deploy ' + previousVersionId + '@100%'");
    expect(uploadJobBody).not.toContain('continue-on-error');

    expect(warmJobBody).toContain('needs: upload_candidate');
    const warmJobTimeout = warmJobBody.match(/timeout-minutes:\s*(\d+)/);
    expect(Number(warmJobTimeout?.[1]) * 60_000).toBeGreaterThan(
      DEFAULT_WARM_TOTAL_TIMEOUT_MS,
    );
    expect(warmJobBody).toContain('FRANK_WARM_TOKEN: ${{ secrets.FRANK_WARM_TOKEN }}');
    expect(warmJobBody).toContain(
      'FRANK_WORKER_BASE_URL: ${{ needs.upload_candidate.outputs.preview_url }}',
    );
    expect(warmJobBody).not.toContain('continue-on-error');

    expect(promoteJobBody).toContain('needs: [upload_candidate, warm_candidate]');
    expect(promoteJobBody).toContain(
      'CANDIDATE_VERSION_ID: ${{ needs.upload_candidate.outputs.version_id }}',
    );
    expect(promoteJobBody).toContain(
      'npx wrangler versions deploy "${CANDIDATE_VERSION_ID}@100%" --yes',
    );
    expect(promotionGateBody).not.toContain('continue-on-error');
    expect(promoteJobBody.match(/npm run worker:gc-kv/g)).toHaveLength(1);
    expect(cleanupStepBody).toContain('continue-on-error: true');

    expect(pagesJobBody).toContain(
      'needs: [validate, upload_candidate, warm_candidate, promote_worker]',
    );
  });

  it('does not use direct wrangler deploy', async () => {
    const workflow = await readFile('.github/workflows/deploy.yml', 'utf8');
    expect(workflow).not.toMatch(/\bwrangler\s+deploy(?:\s|$)/);
  });

  it('enables Wrangler version preview URLs for candidate warming', async () => {
    const wranglerConfig = JSON.parse(
      await readFile('wrangler.jsonc', 'utf8'),
    ) as { preview_urls?: unknown };
    expect(wranglerConfig.preview_urls).toBe(true);
  });
});
