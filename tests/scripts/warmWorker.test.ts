// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_WARM_TOTAL_TIMEOUT_MS,
  WARM_LOCATION_IDS,
  WARM_LOCATION_STAGGER_MS,
  warmWorkerLocations,
} from '../../scripts/warm-worker.mjs';

const BASE_URL = 'https://frank-forecast.example.workers.dev';
const TOKEN = 'test-deployment-warm-token';

function readyResponse() {
  return new Response('{}', { status: 200 });
}

function initializingResponse(retryAfter: string | null = '2', code = 'FORECAST_INITIALIZING') {
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
  it('warms all four exact forecast URLs serially with staggered starts, bearer auth, and no secret logging', async () => {
    let nowMs = 1_000;
    let inFlight = 0;
    let maximumInFlight = 0;
    const requestStarts: number[] = [];
    const fetchImpl = vi.fn(async (_input: string | URL, _init?: RequestInit) => {
      requestStarts.push(nowMs);
      inFlight += 1;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return readyResponse();
    });
    const sleepImpl = vi.fn(async (delayMs: number) => {
      nowMs += delayMs;
    });
    const logger = silentLogger();

    await warmWorkerLocations({
      baseUrl: `${BASE_URL}/`,
      token: TOKEN,
      fetchImpl,
      now: () => nowMs,
      sleepImpl,
      logger,
    });

    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual(
      WARM_LOCATION_IDS.map((locationId) =>
        `${BASE_URL}/api/v2/forecast/${locationId}?warm=1`),
    );
    expect(maximumInFlight).toBe(1);
    expect(requestStarts).toEqual(WARM_LOCATION_IDS.map((_, index) =>
      1_000 + index * WARM_LOCATION_STAGGER_MS));
    expect(sleepImpl.mock.calls).toEqual([
      [WARM_LOCATION_STAGGER_MS],
      [WARM_LOCATION_STAGGER_MS],
      [WARM_LOCATION_STAGGER_MS],
    ]);
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init).toBeDefined();
      const request = init!;
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
    const requestStarts: Array<{ locationId: string; at: number }> = [];
    const fetchImpl = vi.fn(async (url: string) => {
      const locationId = locationIdFrom(url);
      requestStarts.push({ locationId, at: nowMs });
      if (locationId === 'horsens' && horsensAttempts++ === 0) {
        return initializingResponse('10');
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
      totalTimeoutMs: 15_000,
    });

    expect(fetchImpl.mock.calls.map(([url]) => locationIdFrom(String(url)))).toEqual([
      'horsens',
      'vejle',
      'kolding',
      'aarhus',
      'horsens',
    ]);
    expect(requestStarts.map(({ at }) => at)).toEqual([1_000, 2_000, 3_000, 4_000, 11_000]);
    expect(requestStarts.at(-1)!.at - requestStarts[0].at).toBe(10_000);
    expect(sleepImpl.mock.calls).toEqual([
      [WARM_LOCATION_STAGGER_MS],
      [WARM_LOCATION_STAGGER_MS],
      [WARM_LOCATION_STAGGER_MS],
      [7_000],
    ]);
  });

  it('allows repeated authenticated initialization cooldowns inside the candidate gate', async () => {
    let nowMs = 1_000;
    let aarhusAttempts = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      const locationId = locationIdFrom(url);
      if (locationId === 'aarhus' && aarhusAttempts++ < 2) {
        return initializingResponse('90');
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

    expect(DEFAULT_WARM_TOTAL_TIMEOUT_MS).toBe(13 * 60_000);
    expect(fetchImpl.mock.calls.map(([url]) => locationIdFrom(String(url)))).toEqual([
      'horsens',
      'vejle',
      'kolding',
      'aarhus',
      'aarhus',
      'aarhus',
    ]);
    expect(sleepImpl.mock.calls).toEqual([
      [WARM_LOCATION_STAGGER_MS],
      [WARM_LOCATION_STAGGER_MS],
      [WARM_LOCATION_STAGGER_MS],
      [90_000],
      [90_000],
    ]);
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
      totalTimeoutMs: 5_500,
    })).rejects.toThrow('locations not ready: horsens');

    expect(fetchImpl.mock.calls.map(([url]) => locationIdFrom(String(url)))).toEqual([
      'horsens',
      'vejle',
      'kolding',
      'aarhus',
      'horsens',
    ]);
    expect(sleepImpl.mock.calls).toEqual([
      [WARM_LOCATION_STAGGER_MS],
      [WARM_LOCATION_STAGGER_MS],
      [WARM_LOCATION_STAGGER_MS],
      [WARM_LOCATION_STAGGER_MS],
    ]);
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
    const triggerSyncStep = workflow.indexOf('- name: Sync Worker triggers to wrangler.jsonc');
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
    expect(Number(warmJobTimeout?.[1])).toBe(15);
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
    // Cron schedules are Worker-level and are NOT carried by `versions
    // deploy`. This step is the only thing keeping the live schedule equal to
    // wrangler.jsonc on a normal push; without it production silently ran
    // */5 * * * * against a repo that said * * * * *. It has to stay inside
    // the promotion gate (so a sync failure fails the run) and it has to run
    // AFTER promotion, or the new cadence drives the outgoing version.
    expect(triggerSyncStep).toBeGreaterThan(promoteCommand);
    expect(triggerSyncStep).toBeLessThan(cleanupStep);
    expect(promoteJobBody.match(/npx wrangler triggers deploy/g)).toHaveLength(1);
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
