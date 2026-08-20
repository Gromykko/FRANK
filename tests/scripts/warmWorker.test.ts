// @vitest-environment node
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadReleaseContract, warmWorker } from '../../scripts/warm-worker.mjs';

const SCRIPT_PATH = fileURLToPath(new URL('../../scripts/warm-worker.mjs', import.meta.url));
const openServers: Server[] = [];
const silentLogger = { info: () => {}, warn: () => {} };

async function listen(handler: Parameters<typeof createServer>[0]) {
  const server = createServer(handler);
  openServers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Mock server has no TCP address');
  return `http://127.0.0.1:${address.port}/`;
}

function json(response: Parameters<NonNullable<Parameters<typeof createServer>[0]>>[1], status: number, body: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

function forecast(locationId: string, version = 7) {
  return {
    hourly: [{ time: '2026-08-20T12:00:00Z' }],
    sources: {
      payloadVersion: version,
      location: { id: locationId },
    },
  };
}

function initializing(locationId: string, retryAfterSeconds = 600) {
  const names: Record<string, [string, string]> = {
    horsens: ['Horsens', 'Horsens Fjord'],
    vejle: ['Vejle', 'Vejle Fjord'],
  };
  const [name, areaName] = names[locationId] ?? [locationId, locationId];
  return {
    schemaVersion: 1,
    status: 'initializing',
    code: 'FORECAST_INITIALIZING',
    message: 'Forecast for this location is being prepared. Please try again shortly.',
    retryAfterSeconds,
    location: { id: locationId, name, areaName },
  };
}

function health(
  locationIds: string[],
  {
    missing = [],
    staleData = [],
    notChecking = [],
    storageAvailable = true,
  }: {
    missing?: string[];
    staleData?: string[];
    notChecking?: string[];
    storageAvailable?: boolean;
  } = {},
) {
  const checkedAtMs = Date.now();
  const checkedAt = new Date(checkedAtMs).toISOString();
  const stalled = [...new Set([...missing, ...staleData, ...notChecking])];
  const ok = storageAvailable && stalled.length === 0;
  return {
    ok,
    service: 'frank-forecast',
    checkedAt,
    checkStaleAfterMin: 60,
    dataStaleAfterMin: 180,
    missing,
    stalled,
    storageAvailable,
    locations: locationIds.map((id) => missing.includes(id)
      ? { id, areaName: id, hasCache: false }
      : {
          id,
          areaName: id,
          hasCache: true,
          fetchedAt: new Date(
            checkedAtMs - (staleData.includes(id) ? 4 * 60 * 60_000 : 60_000),
          ).toISOString(),
          cacheHealth: {
            lastAttemptAt: new Date(
              checkedAtMs - (notChecking.includes(id) ? 2 * 60 * 60_000 : 60_000),
            ).toISOString(),
          },
        }),
  };
}

afterEach(async () => {
  const servers = openServers.splice(0);
  for (const server of servers) server.closeAllConnections?.();
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('Worker deployment warm-up', () => {
  it('warms configured locations sequentially before checking health', async () => {
    const contract = await loadReleaseContract();
    const requests: string[] = [];
    const baseUrl = await listen((request, response) => {
      requests.push(request.url ?? '');
      const match = request.url?.match(/^\/forecast\/([a-z0-9-]+)\?warm=1$/);
      if (match) return json(response, 200, forecast(match[1], contract.expectedVersion));
      if (request.url === '/health') return json(response, 200, health(contract.locationIds));
      return json(response, 404, { error: 'not found' });
    });

    await warmWorker({
      baseUrl,
      locationIds: contract.locationIds,
      expectedVersion: contract.expectedVersion,
      attempts: 1,
      timeoutMs: 500,
      retryDelayMs: 1,
      logger: silentLogger,
    });

    expect(requests).toEqual([
      ...contract.locationIds.map((id) => `/forecast/${id}?warm=1`),
      '/health',
    ]);
  });

  it('retries a bounded transient failure without skipping ahead', async () => {
    const requests: string[] = [];
    let attempts = 0;
    const baseUrl = await listen((request, response) => {
      requests.push(request.url ?? '');
      if (request.url?.startsWith('/forecast/horsens')) {
        attempts += 1;
        if (attempts === 1) {
          request.socket.destroy();
          return;
        }
        return json(response, 200, forecast('horsens'));
      }
      if (request.url?.startsWith('/forecast/vejle')) return json(response, 200, forecast('vejle'));
      if (request.url === '/health') return json(response, 200, health(['horsens', 'vejle']));
      return json(response, 404, { error: 'not found' });
    });

    await warmWorker({
      baseUrl,
      locationIds: ['horsens', 'vejle'],
      expectedVersion: 7,
      attempts: 2,
      timeoutMs: 500,
      retryDelayMs: 1,
      logger: silentLogger,
    });

    expect(requests).toEqual([
      '/forecast/horsens?warm=1',
      '/forecast/horsens?warm=1',
      '/forecast/vejle?warm=1',
      '/health',
    ]);
  });

  it('waits for each cold warm-up response before starting the next location or health', async () => {
    const requests: string[] = [];
    let activeBuilds = 0;
    let maxActiveBuilds = 0;
    const baseUrl = await listen((request, response) => {
      requests.push(request.url ?? '');
      const match = request.url?.match(/^\/forecast\/([a-z0-9-]+)\?warm=1$/);
      if (match) {
        activeBuilds += 1;
        maxActiveBuilds = Math.max(maxActiveBuilds, activeBuilds);
        setTimeout(() => {
          activeBuilds -= 1;
          json(response, 200, forecast(match[1]));
        }, 10);
        return;
      }
      if (request.url === '/health') {
        return json(
          response,
          activeBuilds === 0 ? 200 : 503,
          health(['horsens', 'vejle']),
        );
      }
      return json(response, 404, { error: 'not found' });
    });

    await warmWorker({
      baseUrl,
      locationIds: ['horsens', 'vejle'],
      expectedVersion: 7,
      attempts: 1,
      timeoutMs: 500,
      retryDelayMs: 1,
      logger: silentLogger,
    });

    expect(maxActiveBuilds).toBe(1);
    expect(requests).toEqual([
      '/forecast/horsens?warm=1',
      '/forecast/vejle?warm=1',
      '/health',
    ]);
  });

  it('accepts a versioned initializing response once, continues sequentially, and reports amber', async () => {
    const requests: string[] = [];
    const warnings: string[] = [];
    const baseUrl = await listen((request, response) => {
      requests.push(request.url ?? '');
      if (request.url === '/forecast/horsens?warm=1') {
        response.setHeader('Retry-After', '600');
        return json(response, 503, initializing('horsens'));
      }
      if (request.url === '/forecast/vejle?warm=1') {
        return json(response, 200, forecast('vejle'));
      }
      if (request.url === '/health') {
        return json(response, 503, health(['horsens', 'vejle'], { missing: ['horsens'] }));
      }
      return json(response, 404, { error: 'not found' });
    });

    const result = await warmWorker({
      baseUrl,
      locationIds: ['horsens', 'vejle'],
      expectedVersion: 7,
      attempts: 3,
      timeoutMs: 500,
      retryDelayMs: 1,
      logger: { info: () => {}, warn: (message: string) => warnings.push(message) },
    });

    expect(requests).toEqual([
      '/forecast/horsens?warm=1',
      '/forecast/vejle?warm=1',
      '/health',
    ]);
    expect(result).toEqual({
      initializingLocationIds: ['horsens'],
      transientLocationIds: ['horsens'],
      staleDataLocationIds: [],
    });
    expect(warnings.some((message) => message.includes('AMBER'))).toBe(true);
  });

  it('waits for a just-warmed ready cache to propagate into health', async () => {
    const requests: string[] = [];
    let healthChecks = 0;
    const baseUrl = await listen((request, response) => {
      requests.push(request.url ?? '');
      const match = request.url?.match(/^\/forecast\/([a-z0-9-]+)\?warm=1$/);
      if (match) return json(response, 200, forecast(match[1]));
      if (request.url === '/health') {
        healthChecks += 1;
        const body = healthChecks === 1
          ? health(['horsens', 'vejle'], { missing: ['horsens'] })
          : health(['horsens', 'vejle']);
        return json(response, body.ok ? 200 : 503, body);
      }
      return json(response, 404, { error: 'not found' });
    });

    await warmWorker({
      baseUrl,
      locationIds: ['horsens', 'vejle'],
      expectedVersion: 7,
      attempts: 1,
      timeoutMs: 500,
      retryDelayMs: 1,
      healthPropagationTimeoutMs: 100,
      healthPropagationRetryDelayMs: 1,
      logger: silentLogger,
    });

    expect(healthChecks).toBe(2);
    expect(requests.slice(-2)).toEqual(['/health', '/health']);
  });

  it('accepts operationally red stale health without pretending it is green', async () => {
    const warnings: string[] = [];
    const baseUrl = await listen((request, response) => {
      const match = request.url?.match(/^\/forecast\/([a-z0-9-]+)\?warm=1$/);
      if (match) return json(response, 200, forecast(match[1]));
      if (request.url === '/health') {
        return json(response, 503, health(['horsens', 'vejle'], { staleData: ['vejle'] }));
      }
      return json(response, 404, { error: 'not found' });
    });

    const result = await warmWorker({
      baseUrl,
      locationIds: ['horsens', 'vejle'],
      expectedVersion: 7,
      attempts: 1,
      timeoutMs: 500,
      retryDelayMs: 1,
      logger: { info: () => {}, warn: (message: string) => warnings.push(message) },
    });

    expect(result.staleDataLocationIds).toEqual(['vejle']);
    expect(warnings.some((message) => message.includes('data is stale but checks are current: vejle'))).toBe(true);
  });

  it('fails when a ready location is no longer checking upstream', async () => {
    let healthChecks = 0;
    const baseUrl = await listen((request, response) => {
      if (request.url?.startsWith('/forecast/horsens')) {
        return json(response, 200, forecast('horsens'));
      }
      if (request.url === '/health') {
        healthChecks += 1;
        return json(response, 503, health(['horsens'], { notChecking: ['horsens'] }));
      }
      return json(response, 404, { error: 'not found' });
    });

    await expect(warmWorker({
      baseUrl,
      locationIds: ['horsens'],
      expectedVersion: 7,
      attempts: 3,
      timeoutMs: 500,
      retryDelayMs: 1,
      logger: silentLogger,
    })).rejects.toThrow('ready location is not checking upstream: horsens');
    expect(healthChecks).toBe(1);
  });

  it('fails immediately when health reports storage unavailable', async () => {
    let healthChecks = 0;
    const baseUrl = await listen((request, response) => {
      if (request.url?.startsWith('/forecast/horsens')) {
        return json(response, 200, forecast('horsens'));
      }
      if (request.url === '/health') {
        healthChecks += 1;
        return json(response, 503, health(['horsens'], {
          missing: ['horsens'],
          storageAvailable: false,
        }));
      }
      return json(response, 404, { error: 'not found' });
    });

    await expect(warmWorker({
      baseUrl,
      locationIds: ['horsens'],
      expectedVersion: 7,
      attempts: 3,
      timeoutMs: 500,
      retryDelayMs: 1,
      logger: silentLogger,
    })).rejects.toThrow('forecast storage unavailable');
    expect(healthChecks).toBe(1);
  });

  it('fails when a ready cache remains missing after the propagation window', async () => {
    const baseUrl = await listen((request, response) => {
      if (request.url?.startsWith('/forecast/horsens')) {
        return json(response, 200, forecast('horsens'));
      }
      if (request.url === '/health') {
        return json(response, 503, health(['horsens'], { missing: ['horsens'] }));
      }
      return json(response, 404, { error: 'not found' });
    });

    await expect(warmWorker({
      baseUrl,
      locationIds: ['horsens'],
      expectedVersion: 7,
      attempts: 1,
      timeoutMs: 500,
      retryDelayMs: 1,
      healthPropagationTimeoutMs: 100,
      healthPropagationRetryDelayMs: 10,
      logger: silentLogger,
    })).rejects.toThrow('cache propagation window');
  });

  it('times out a stalled request and fails the gate', async () => {
    const baseUrl = await listen(() => {
      // Deliberately leave the response open until AbortSignal closes it.
    });

    await expect(warmWorker({
      baseUrl,
      locationIds: ['horsens'],
      expectedVersion: 7,
      attempts: 1,
      timeoutMs: 30,
      retryDelayMs: 1,
      logger: silentLogger,
    })).rejects.toThrow('forecast horsens failed after 1 attempt');
  });

  it('exits nonzero on a contract mismatch without printing the response body', async () => {
    const baseUrl = await listen((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{"hourly":[{}],"sources":{"payloadVersion":999,"location":{"id":"wrong"}},"private":"do-not-log"}');
    });

    const child = spawn(process.execPath, [
      SCRIPT_PATH,
      '--base-url', baseUrl,
      '--attempts', '1',
      '--timeout-ms', '500',
      '--retry-delay-ms', '1',
    ], { cwd: fileURLToPath(new URL('../..', import.meta.url)) });

    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.resume();

    const [exitCode] = await once(child, 'exit');
    expect(exitCode).toBe(1);
    expect(stderr).toContain('[warm] failed: forecast horsens failed: HTTP 200 contract mismatch.');
    expect(stderr).not.toContain('do-not-log');
  });
});
