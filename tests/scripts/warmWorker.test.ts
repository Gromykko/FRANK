// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
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

  it('orders deploy, warm, and Pages as three fail-closed workflow gates', async () => {
    const workflow = await readFile('.github/workflows/deploy.yml', 'utf8');
    const deployCommand = workflow.indexOf('npx wrangler deploy');
    const warmJob = workflow.indexOf('  warm_worker:');
    const warmCommand = workflow.indexOf('node scripts/warm-worker.mjs');
    const pagesJob = workflow.indexOf('  deploy_pages:');
    const warmJobBody = workflow.slice(warmJob, pagesJob);
    const pagesJobBody = workflow.slice(pagesJob);

    expect(deployCommand).toBeGreaterThan(-1);
    expect(deployCommand).toBeLessThan(warmJob);
    expect(warmJob).toBeLessThan(warmCommand);
    expect(warmCommand).toBeLessThan(pagesJob);
    expect(warmJobBody).toContain('needs: deploy_worker');
    expect(warmJobBody).toContain('FRANK_WARM_TOKEN: ${{ secrets.FRANK_WARM_TOKEN }}');
    expect(warmJobBody).toContain('FRANK_WORKER_BASE_URL: ${{ vars.FRANK_WORKER_BASE_URL }}');
    expect(warmJobBody).not.toContain('continue-on-error');
    expect(pagesJobBody).toContain('needs: [validate, deploy_worker, warm_worker]');
  });
});
