// @vitest-environment node
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatWarmAutomationOutput,
  formatWarmGateSummary,
  loadReleaseContract,
  parseReleasePolicy,
  runCli,
  warmWorker,
} from '../../scripts/warm-worker.mjs';

const SCRIPT_PATH = fileURLToPath(new URL('../../scripts/warm-worker.mjs', import.meta.url));
const openServers: Server[] = [];
const silentLogger = { info: () => {}, warn: () => {} };
const EXPECTED_WORKER_VERSION_ID = 'cba7bd5e-93f4-4df7-8b61-8f00d5b6f3a1';
const WARM_TOKEN = 'test-only-frank-warm-token-with-256-bits-of-entropy';
const PREVIOUS_WORKER_VERSION_ID = 'b667d0b0-cb02-482d-b418-bfb56826ee0f';
type ReleaseMetadata = Awaited<ReturnType<typeof loadReleaseContract>>['release'];

function warmRelease(options: Parameters<typeof warmWorker>[0]) {
  return warmWorker({
    expectedApiSchemaVersion: options.expectedRelease?.apiSchemaVersion ?? 1,
    expectedWorkerVersionId: EXPECTED_WORKER_VERSION_ID,
    rotationNowMs: 0,
    ...options,
  });
}

async function listen(handler: Parameters<typeof createServer>[0]) {
  const server = createServer(handler);
  openServers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Mock server has no TCP address');
  return `http://127.0.0.1:${address.port}/`;
}

function json(
  response: Parameters<NonNullable<Parameters<typeof createServer>[0]>>[1],
  status: number,
  body: unknown,
  workerVersionId: string | null = EXPECTED_WORKER_VERSION_ID,
  extraHeaders: Record<string, string> = {},
) {
  response.writeHead(status, {
    'Content-Type': 'application/json',
    ...(workerVersionId ? { 'X-FRANK-Worker-Version': workerVersionId } : {}),
    ...extraHeaders,
  });
  response.end(JSON.stringify(body));
}

function exactReleaseHeaders(
  release: Awaited<ReturnType<typeof loadReleaseContract>>['release'],
  ready?: boolean,
) {
  return {
    'X-FRANK-API-Schema': String(release.apiSchemaVersion),
    'X-FRANK-Model-Revision': String(release.modelRevision),
    'X-FRANK-Data-Generation': release.dataGenerationId,
    'X-FRANK-Assembled-Cache-Schema': String(release.assembledCacheSchema),
    'X-FRANK-Marine-Cache-Schema': String(release.marineCacheSchema),
    'X-FRANK-Payload-Version': String(release.payloadVersion),
    ...(ready === undefined ? {} : { 'X-FRANK-Generation-Ready': String(ready) }),
  };
}

function forecast(
  locationId: string,
  version = 7,
  coordinate = { latitude: 55, longitude: 9 },
  release?: ReleaseMetadata,
) {
  const now = Date.now();
  return {
    hourly: [{
      time: new Date(now + 60 * 60_000).toISOString(),
      symbolCode: 'partlycloudy_day',
      isDay: true,
      tempAir: 18,
      precipitation: 0,
      weatherCode: 2,
      windSpeed: 3,
      windDirection: 90,
      windGust: 5,
      waveHeight: 0.2,
      waveDirection: 80,
      wavePeriod: 3,
      tempWater: 17,
      tideLevel: 0.1,
      currentSpeed: 0.2,
      currentDirection: 100,
    }],
    sunrise: [new Date(now - 6 * 60 * 60_000).toISOString()],
    sunset: [new Date(now + 6 * 60 * 60_000).toISOString()],
    sources: {
      payloadVersion: version,
      weather: 'MET Norway Locationforecast',
      waves: 'DMI WAM',
      water: 'DMI DKSS',
      fetchedAt: new Date(now - 5 * 60_000).toISOString(),
      coordinate,
      location: { id: locationId, name: locationId, areaName: `${locationId} area` },
      cacheHealth: {
        status: 'current',
        lastAttemptAt: new Date(now - 5 * 60_000).toISOString(),
      },
      ...(release ? { release } : {}),
    },
  };
}

function initializing(locationId: string, retryAfterSeconds = 600) {
  const names: Record<string, [string, string]> = {
    horsens: ['Horsens', 'Horsens Fjord'],
    vejle: ['Vejle', 'Vejle Fjord'],
    kolding: ['Kolding', 'Kolding Fjord'],
    aarhus: ['Aarhus', 'Aarhus Bugt'],
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

function releaseHealth(
  locationIds: string[],
  release: Awaited<ReturnType<typeof loadReleaseContract>>['release'],
  {
    missing = [],
    fallback = [],
    staleData = [],
    notChecking = [],
  }: {
    missing?: string[];
    fallback?: string[];
    staleData?: string[];
    notChecking?: string[];
  } = {},
) {
  const payload = health(locationIds, { missing, staleData, notChecking });
  const ready = locationIds.filter((id) => !missing.includes(id) && !fallback.includes(id));
  const available = locationIds.filter((id) => !missing.includes(id));
  return {
    ...payload,
    release: {
      target: release,
      allLocationsReady: ready.length === locationIds.length,
      ready,
      available,
      fallback: [...fallback],
      missing: [...missing],
    },
    locations: payload.locations.map((entry) => ({
      ...entry,
      exactGenerationReady: ready.includes(entry.id),
      availabilitySource: missing.includes(entry.id)
        ? 'none'
        : fallback.includes(entry.id)
          ? 'generation:api0-model6'
          : 'generation',
    })),
  };
}

function exactHealth(
  locationIds: string[],
  release: Awaited<ReturnType<typeof loadReleaseContract>>['release'],
) {
  return releaseHealth(locationIds, release);
}

function breakingApiContract(supportedVersions = '[1, 2]') {
  return `
    export const SUPPORTED_FORECAST_API_SCHEMA_VERSIONS = ${supportedVersions} as const;
    export const CURRENT_RELEASE = Object.freeze({
      apiSchemaVersion: 2,
      modelRevision: 8,
      assembledCacheSchema: 2,
      marineCacheSchema: 2,
      dataGenerationId: 'api2-model8',
      payloadVersion: 8,
    });
    const PREVIOUS_V1 = Object.freeze({
      apiSchemaVersion: 1,
      modelRevision: 7,
      assembledCacheSchema: 1,
      marineCacheSchema: 1,
      dataGenerationId: 'api1-model7',
      payloadVersion: 7,
    });
    const OLDER_V1 = Object.freeze({
      ...PREVIOUS_V1,
      modelRevision: 6,
      dataGenerationId: 'api1-model6',
    });
    const PREVIOUS_V2 = Object.freeze({
      ...CURRENT_RELEASE,
      modelRevision: 7,
      dataGenerationId: 'api2-model7',
    });
    export const AUDITED_PREVIOUS_FORECAST_GENERATIONS = Object.freeze([
      PREVIOUS_V1,
      OLDER_V1,
      PREVIOUS_V2,
    ]);
    export const LEGACY_FORECAST_PAYLOAD_VERSION = 8;
  `;
}

function sameApiPreviousGenerationContract() {
  return `
    export const SUPPORTED_FORECAST_API_SCHEMA_VERSIONS = [1] as const;
    export const CURRENT_RELEASE = Object.freeze({
      apiSchemaVersion: 1,
      modelRevision: 8,
      assembledCacheSchema: 2,
      marineCacheSchema: 2,
      dataGenerationId: 'api1-model8',
      payloadVersion: 8,
    });
    const PREVIOUS_MODEL = Object.freeze({
      apiSchemaVersion: 1,
      modelRevision: 7,
      assembledCacheSchema: 1,
      marineCacheSchema: 1,
      dataGenerationId: 'api1-model7',
      payloadVersion: 7,
    });
    export const AUDITED_PREVIOUS_FORECAST_GENERATIONS = Object.freeze([
      PREVIOUS_MODEL,
    ]);
    export const LEGACY_FORECAST_PAYLOAD_VERSION = 8;
  `;
}

afterEach(async () => {
  const servers = openServers.splice(0);
  for (const server of servers) server.closeAllConnections?.();
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('Worker deployment warm-up', () => {
  it('formats a strict machine-readable promotion decision', () => {
    expect(formatWarmAutomationOutput({
      readyForPromotion: false,
      waitingLocationIds: ['horsens', 'vejle'],
      retryAfterSeconds: 600,
    })).toBe([
      'ready_for_promotion=false',
      'waiting_location_ids=horsens,vejle',
      'retry_after_seconds=600',
      '',
    ].join('\n'));
    expect(formatWarmAutomationOutput({
      readyForPromotion: true,
      waitingLocationIds: [],
      retryAfterSeconds: 0,
    })).toContain('ready_for_promotion=true');
    expect(() => formatWarmAutomationOutput({
      readyForPromotion: true,
      waitingLocationIds: ['horsens'],
      retryAfterSeconds: 600,
    })).toThrow('automation result is invalid');
  });

  it('requires the waiting opt-in and GitHub output contract together', async () => {
    await expect(runCli([
      '--require-target-ready-all',
      '--allow-waiting',
    ], {})).rejects.toThrow('must be used together');
    await expect(runCli([
      '--require-target-ready-all',
      '--github-output', 'unused.txt',
    ], {})).rejects.toThrow('must be used together');
    await expect(runCli([
      '--allow-waiting',
      '--github-output', 'unused.txt',
    ], {})).rejects.toThrow('requires --require-target-ready-all');
  });

  it('requires an operational token for provider-building CLI checks', async () => {
    await expect(runCli([
      '--base-url', 'https://frank.invalid',
      '--expected-worker-version-id', EXPECTED_WORKER_VERSION_ID,
      '--attempts', '1',
    ], {})).rejects.toThrow('FRANK_WARM_TOKEN must be configured');
  });

  it('formats an explicit city-by-city readiness summary', () => {
    const summary = formatWarmGateSummary({
      title: 'Candidate readiness',
      status: 'failed',
      locations: [
        { id: 'horsens', areaName: 'Horsens Fjord' },
        { id: 'vejle', areaName: 'Vejle Fjord' },
      ],
      targetReadyLocationIds: ['horsens'],
      activeLocationId: 'vejle',
      errorMessage: 'forecast vejle failed',
    });

    expect(summary).toContain('Exact ready: 1/2');
    expect(summary).toContain('Missing exact readiness: vejle');
    expect(summary).toContain('Horsens Fjord (`horsens`): exact target ready');
    expect(summary).toContain('Vejle Fjord (`vejle`): failed during check');

    const waiting = formatWarmGateSummary({
      status: 'waiting',
      locations: [{ id: 'horsens', areaName: 'Horsens Fjord' }],
      initializingLocationIds: ['horsens'],
    });
    expect(waiting).toContain('Gate: waiting');
    expect(waiting).toContain('Horsens Fjord (`horsens`): initializing');
  });

  it('blocks a breaking API until continuous old-representation materialization exists', () => {
    expect(() => parseReleasePolicy(breakingApiContract())).toThrow(
      'Breaking API v2 is blocked',
    );
  });

  it('cannot bypass the breaking-API lock by omitting the previous descriptor', () => {
    expect(() => parseReleasePolicy(`
      export const SUPPORTED_FORECAST_API_SCHEMA_VERSIONS = [2] as const;
      export const CURRENT_RELEASE = Object.freeze({
        apiSchemaVersion: 2,
        modelRevision: 8,
        assembledCacheSchema: 2,
        marineCacheSchema: 2,
        dataGenerationId: 'api2-model8',
        payloadVersion: 8,
      });
      export const AUDITED_PREVIOUS_FORECAST_GENERATIONS = Object.freeze([]);
      export const LEGACY_FORECAST_PAYLOAD_VERSION = 8;
    `)).toThrow('Breaking API v2 is blocked');
  });

  it('allows audited previous generations that retain the current API schema', () => {
    const policy = parseReleasePolicy(sameApiPreviousGenerationContract());
    expect(policy.release).toMatchObject({
      apiSchemaVersion: 1,
      dataGenerationId: 'api1-model8',
    });
    expect(policy.supportedApiSchemaVersions).toEqual([1]);
    expect(policy.auditedPreviousReleases).toHaveLength(1);
    expect(policy.auditedPriorApiReleases).toEqual([]);
  });

  it('accepts a fallback only when its complete audited release descriptor matches', async () => {
    const manifest = await loadReleaseContract();
    const location = manifest.locations[0];
    const policy = parseReleasePolicy(sameApiPreviousGenerationContract());
    const current = policy.release;
    const previous = policy.auditedPreviousReleases[0];
    const baseUrl = await listen((request, response) => {
      if (request.url?.startsWith(`/api/v1/forecast/${location.id}`)) {
        expect(request.headers.authorization).toBe(`Bearer ${WARM_TOKEN}`);
        return json(
          response,
          200,
          forecast(location.id, previous.payloadVersion, location.coordinate, previous),
          EXPECTED_WORKER_VERSION_ID,
          {
            ...exactReleaseHeaders(current, false),
            'X-FRANK-Payload-Version': String(previous.payloadVersion),
          },
        );
      }
      if (request.url === '/health') {
        return json(
          response,
          200,
          releaseHealth([location.id], current, { fallback: [location.id] }),
          EXPECTED_WORKER_VERSION_ID,
          exactReleaseHeaders(current),
        );
      }
      return json(response, 404, { error: 'not found' });
    });

    await expect(warmRelease({
      baseUrl,
      locationIds: [location.id],
      locationContracts: [location],
      expectedVersion: current.payloadVersion,
      expectedRelease: current,
      auditedPreviousReleases: [previous],
      warmToken: WARM_TOKEN,
      requireTargetReadyAll: true,
      allowWaiting: true,
      attempts: 1,
      timeoutMs: 500,
      retryDelayMs: 1,
      logger: silentLogger,
    })).resolves.toMatchObject({
      readyForPromotion: false,
      waitingLocationIds: [location.id],
      retryAfterSeconds: 600,
      generationNotReadyLocationIds: [location.id],
    });
  });

  it('refuses to accumulate more than one previous forecast generation', () => {
    expect(() => parseReleasePolicy(`
      export const SUPPORTED_FORECAST_API_SCHEMA_VERSIONS = [1] as const;
      export const CURRENT_RELEASE = Object.freeze({
        apiSchemaVersion: 1,
        modelRevision: 9,
        assembledCacheSchema: 1,
        marineCacheSchema: 1,
        dataGenerationId: 'api1-model9',
        payloadVersion: 9,
      });
      const V8 = Object.freeze({ ...CURRENT_RELEASE, modelRevision: 8, dataGenerationId: 'api1-model8', payloadVersion: 8 });
      const V7 = Object.freeze({ ...CURRENT_RELEASE, modelRevision: 7, dataGenerationId: 'api1-model7', payloadVersion: 7 });
      export const AUDITED_PREVIOUS_FORECAST_GENERATIONS = Object.freeze([V8, V7]);
      export const LEGACY_FORECAST_PAYLOAD_VERSION = 9;
    `)).toThrow('only the current and one previous forecast generation');
  });

  it('fails contract parsing when supported API routes drift from audited descriptors', () => {
    expect(() => parseReleasePolicy(`
      export const SUPPORTED_FORECAST_API_SCHEMA_VERSIONS = [1, 2] as const;
      export const CURRENT_RELEASE = Object.freeze({
        apiSchemaVersion: 1,
        modelRevision: 7,
        assembledCacheSchema: 1,
        marineCacheSchema: 1,
        dataGenerationId: 'api1-model7',
        payloadVersion: 7,
      });
      export const AUDITED_PREVIOUS_FORECAST_GENERATIONS = Object.freeze([]);
      export const LEGACY_FORECAST_PAYLOAD_VERSION = 7;
    `)).toThrow(
      'Supported API schema versions must exactly match',
    );
  });

  it('treats the current empty audited descriptor list as a compatibility no-op', async () => {
    const contract = await loadReleaseContract();
    expect(contract.auditedPriorApiReleases).toEqual([]);
    expect(contract.supportedApiSchemaVersions).toEqual([contract.release.apiSchemaVersion]);
  });

  it('fails closed before making requests when the expected Worker identity is invalid', async () => {
    const fetchImpl = async () => new Response();

    await expect(warmWorker({
      baseUrl: 'https://frank.test/',
      locationIds: ['horsens'],
      expectedVersion: 7,
      expectedWorkerVersionId: 'not-a-worker-version',
      fetchImpl,
      logger: silentLogger,
    })).rejects.toThrow('Expected Worker version ID must be a valid Cloudflare Worker version ID');
  });

  it.each([0, -1, 1.5])('rejects invalid expected payload version %s before I/O', async (expectedVersion) => {
    await expect(warmWorker({
      baseUrl: 'https://frank.test/',
      locationIds: ['horsens'],
      expectedVersion,
      expectedWorkerVersionId: EXPECTED_WORKER_VERSION_ID,
      fetchImpl: async () => new Response(),
      logger: silentLogger,
    })).rejects.toThrow('Expected payload version must be a positive integer');
  });

  it('warms configured locations sequentially before checking health', async () => {
    const contract = await loadReleaseContract();
    const requests: string[] = [];
    const versionOverrides: Array<string | undefined> = [];
    const baseUrl = await listen((request, response) => {
      requests.push(request.url ?? '');
      versionOverrides.push(request.headers['cloudflare-workers-version-overrides']);
      const match = request.url?.match(/^\/api\/v1\/forecast\/([a-z0-9-]+)\?warm=1$/);
      if (match) {
        const location = contract.locations.find((candidate) => candidate.id === match[1]);
        return json(
          response,
          200,
          forecast(match[1], contract.expectedVersion, location?.coordinate),
        );
      }
      if (request.url === '/health') return json(response, 200, health(contract.locationIds));
      return json(response, 404, { error: 'not found' });
    });

    await warmRelease({
      baseUrl,
      locationIds: contract.locationIds,
      locationContracts: contract.locations,
      expectedVersion: contract.expectedVersion,
      workerName: 'frank-forecast',
      attempts: 1,
      timeoutMs: 500,
      retryDelayMs: 1,
      logger: silentLogger,
    });

    expect(requests).toEqual([
      ...contract.locationIds.map((id) => `/api/v1/forecast/${id}?warm=1`),
      '/health',
    ]);
    expect(versionOverrides).toEqual(requests.map(
      () => `frank-forecast="${EXPECTED_WORKER_VERSION_ID}"`,
    ));
  });

  it('proves API, model, cache schemas, generation, payload, and health for exact-all releases', async () => {
    const contract = await loadReleaseContract();
    const requests: string[] = [];
    const baseUrl = await listen((request, response) => {
      requests.push(request.url ?? '');
      const match = request.url?.match(/^\/api\/v1\/forecast\/([a-z0-9-]+)\?warm=1$/);
      if (match) {
        const location = contract.locations.find((candidate) => candidate.id === match[1]);
        const payload = forecast(
          match[1],
          contract.expectedVersion,
          location?.coordinate,
          contract.release,
        );
        return json(
          response,
          200,
          payload,
          EXPECTED_WORKER_VERSION_ID,
          exactReleaseHeaders(contract.release, true),
        );
      }
      if (request.url === '/health') {
        return json(
          response,
          200,
          exactHealth(contract.locationIds, contract.release),
          EXPECTED_WORKER_VERSION_ID,
          exactReleaseHeaders(contract.release),
        );
      }
      return json(response, 404, { error: 'not found' });
    });

    const result = await warmRelease({
      baseUrl,
      locationIds: contract.locationIds,
      locationContracts: contract.locations,
      expectedVersion: contract.expectedVersion,
      expectedRelease: contract.release,
      requireTargetReadyAll: true,
      attempts: 1,
      timeoutMs: 500,
      retryDelayMs: 1,
      logger: silentLogger,
    });

    expect(result.targetReadyLocationIds).toEqual(contract.locationIds);
    expect(result.verifiedPriorApiSchemaVersions).toEqual([]);
    expect(requests).toEqual([
      ...contract.locationIds.map((id) => `/api/v1/forecast/${id}?warm=1`),
      '/health',
    ]);
  });

  it('proves post-promotion ordinary traffic without appending warm or triggering a build', async () => {
    const contract = await loadReleaseContract();
    const location = contract.locations[0];
    const requests: string[] = [];
    let forecastRequests = 0;
    const baseUrl = await listen((request, response) => {
      requests.push(request.url ?? '');
      if (request.url === `/api/v1/forecast/${location.id}`) {
        forecastRequests += 1;
        if (forecastRequests === 1) {
          response.setHeader('Retry-After', '600');
          return json(
            response,
            503,
            initializing(location.id),
            EXPECTED_WORKER_VERSION_ID,
            exactReleaseHeaders(contract.release, false),
          );
        }
        return json(
          response,
          200,
          forecast(
            location.id,
            contract.expectedVersion,
            location.coordinate,
            contract.release,
          ),
          EXPECTED_WORKER_VERSION_ID,
          exactReleaseHeaders(contract.release, true),
        );
      }
      if (request.url === '/health') {
        return json(
          response,
          200,
          exactHealth([location.id], contract.release),
          EXPECTED_WORKER_VERSION_ID,
          exactReleaseHeaders(contract.release),
        );
      }
      return json(response, 404, { error: 'not found' });
    });

    await warmRelease({
      baseUrl,
      locationIds: [location.id],
      locationContracts: [location],
      expectedVersion: contract.expectedVersion,
      expectedRelease: contract.release,
      requireTargetReadyAll: true,
      readOnly: true,
      attempts: 2,
      timeoutMs: 500,
      retryDelayMs: 1,
      logger: silentLogger,
    });

    expect(requests).toEqual([
      `/api/v1/forecast/${location.id}`,
      `/api/v1/forecast/${location.id}`,
      '/health',
    ]);
    expect(requests.every((url) => !url.includes('warm='))).toBe(true);
  });

  it('read-only verifies every audited prior API through the exact candidate override', async () => {
    const contract = await loadReleaseContract();
    const location = contract.locations[0];
    const priorV1: ReleaseMetadata = { ...contract.release };
    const currentV2: ReleaseMetadata = {
      ...contract.release,
      apiSchemaVersion: 2,
      modelRevision: 8,
      dataGenerationId: 'api2-model8',
      payloadVersion: 8,
    };
    const requests: Array<{ url: string; override?: string }> = [];
    const baseUrl = await listen((request, response) => {
      requests.push({
        url: request.url ?? '',
        override: request.headers['cloudflare-workers-version-overrides'],
      });
      if (request.url === `/api/v2/forecast/${location.id}?warm=1`) {
        return json(
          response,
          200,
          forecast(location.id, 8, location.coordinate, currentV2),
          EXPECTED_WORKER_VERSION_ID,
          exactReleaseHeaders(currentV2, true),
        );
      }
      if (request.url === `/api/v1/forecast/${location.id}`) {
        return json(
          response,
          200,
          forecast(location.id, 7, location.coordinate, priorV1),
          EXPECTED_WORKER_VERSION_ID,
          exactReleaseHeaders(priorV1, true),
        );
      }
      if (request.url === '/health') {
        return json(
          response,
          200,
          exactHealth([location.id], currentV2),
          EXPECTED_WORKER_VERSION_ID,
          exactReleaseHeaders(currentV2),
        );
      }
      return json(response, 404, { error: 'not found' });
    });

    const result = await warmRelease({
      baseUrl,
      locationIds: [location.id],
      locationContracts: [location],
      expectedVersion: 8,
      expectedRelease: currentV2,
      auditedPriorApiReleases: [priorV1],
      workerName: 'frank-forecast',
      requireTargetReadyAll: true,
      attempts: 1,
      timeoutMs: 500,
      retryDelayMs: 1,
      logger: silentLogger,
    });

    expect(result.verifiedPriorApiSchemaVersions).toEqual([1]);
    expect(requests.map(({ url }) => url)).toEqual([
      `/api/v2/forecast/${location.id}?warm=1`,
      `/api/v1/forecast/${location.id}`,
      '/health',
    ]);
    expect(requests.every(({ override }) => (
      override === `frank-forecast="${EXPECTED_WORKER_VERSION_ID}"`
    ))).toBe(true);
  });

  it.each(['expired horizon', 'wrong body descriptor'])(
    'names the prior API and location when it has an %s',
    async (failure) => {
      const contract = await loadReleaseContract();
      const location = contract.locations[0];
      const priorV1: ReleaseMetadata = { ...contract.release };
      const currentV2: ReleaseMetadata = {
        ...contract.release,
        apiSchemaVersion: 2,
        modelRevision: 8,
        dataGenerationId: 'api2-model8',
        payloadVersion: 8,
      };
      const priorPayload = forecast(
        location.id,
        7,
        location.coordinate,
        failure === 'wrong body descriptor' ? currentV2 : priorV1,
      );
      if (failure === 'expired horizon') {
        priorPayload.hourly[0].time = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
      }
      const baseUrl = await listen((request, response) => {
        if (request.url === `/api/v2/forecast/${location.id}?warm=1`) {
          return json(
            response,
            200,
            forecast(location.id, 8, location.coordinate, currentV2),
            EXPECTED_WORKER_VERSION_ID,
            exactReleaseHeaders(currentV2, true),
          );
        }
        if (request.url === `/api/v1/forecast/${location.id}`) {
          return json(
            response,
            200,
            priorPayload,
            EXPECTED_WORKER_VERSION_ID,
            exactReleaseHeaders(priorV1, true),
          );
        }
        return json(response, 404, { error: 'not found' });
      });

      await expect(warmRelease({
        baseUrl,
        locationIds: [location.id],
        locationContracts: [location],
        expectedVersion: 8,
        expectedRelease: currentV2,
        auditedPriorApiReleases: [priorV1],
        workerName: 'frank-forecast',
        requireTargetReadyAll: true,
        attempts: 1,
        timeoutMs: 500,
        retryDelayMs: 1,
        logger: silentLogger,
      })).rejects.toThrow(`compatibility API v1 forecast ${location.id} failed`);
    },
  );

  it('rejects a current payload when the candidate generation header says fallback', async () => {
    const contract = await loadReleaseContract();
    const location = contract.locations[0];
    const baseUrl = await listen((request, response) => {
      if (request.url?.startsWith(`/api/v1/forecast/${location.id}`)) {
        const payload = forecast(
          location.id,
          contract.expectedVersion,
          location.coordinate,
          contract.release,
        );
        return json(
          response,
          200,
          payload,
          EXPECTED_WORKER_VERSION_ID,
          exactReleaseHeaders(contract.release, false),
        );
      }
      return json(response, 404, { error: 'not found' });
    });

    await expect(warmRelease({
      baseUrl,
      locationIds: [location.id],
      locationContracts: [location],
      expectedVersion: contract.expectedVersion,
      expectedRelease: contract.release,
      requireTargetReadyAll: true,
      attempts: 1,
      timeoutMs: 500,
      retryDelayMs: 1,
      logger: silentLogger,
    })).rejects.toThrow('target release api1-model7 is not ready');
  });

  it('accepts rotating provider-busy degradation when exact data and health remain current', async () => {
    const contract = await loadReleaseContract();
    const locations = contract.locations.slice(0, 2);
    const locationIds = locations.map(({ id }) => id);
    const baseUrl = await listen((request, response) => {
      const match = request.url?.match(/^\/api\/v1\/forecast\/([a-z0-9-]+)\?warm=1$/);
      if (match) {
        const location = locations.find(({ id }) => id === match[1]);
        const payload = forecast(
          match[1],
          contract.expectedVersion,
          location?.coordinate,
          contract.release,
        );
        payload.sources.cacheHealth = {
          ...payload.sources.cacheHealth,
          status: 'degraded',
          providerBusy: true,
          degradedSources: [match[1] === locationIds[0] ? 'waves' : 'water'],
        };
        return json(
          response,
          200,
          payload,
          EXPECTED_WORKER_VERSION_ID,
          exactReleaseHeaders(contract.release, true),
        );
      }
      if (request.url === '/health') {
        const body = exactHealth(locationIds, contract.release);
        body.locations = body.locations.map((entry, index) => ({
          ...entry,
          cacheHealth: {
            ...entry.cacheHealth,
            status: 'degraded',
            providerBusy: true,
            degradedSources: [index === 0 ? 'waves' : 'water'],
          },
        }));
        return json(
          response,
          200,
          body,
          EXPECTED_WORKER_VERSION_ID,
          exactReleaseHeaders(contract.release),
        );
      }
      return json(response, 404, { error: 'not found' });
    });

    await expect(warmRelease({
      baseUrl,
      locationIds,
      locationContracts: locations,
      expectedVersion: contract.expectedVersion,
      expectedRelease: contract.release,
      requireTargetReadyAll: true,
      attempts: 1,
      timeoutMs: 500,
      retryDelayMs: 1,
      logger: silentLogger,
    })).resolves.toMatchObject({ staleDataLocationIds: [] });
  });

  it.each([6, 8])('rejects unaudited payload version %s', async (payloadVersion) => {
    const baseUrl = await listen((request, response) => {
      if (request.url?.startsWith('/api/v1/forecast/horsens')) {
        return json(response, 200, forecast('horsens', payloadVersion));
      }
      return json(response, 404, { error: 'not found' });
    });

    await expect(warmRelease({
      baseUrl,
      locationIds: ['horsens'],
      expectedVersion: 7,
      attempts: 1,
      timeoutMs: 500,
      retryDelayMs: 1,
      logger: silentLogger,
    })).rejects.toThrow('HTTP 200 contract mismatch');
  });

  it('rejects a structurally valid cache whose forecast horizon is exhausted', async () => {
    const expired = forecast('horsens');
    expired.hourly[0].time = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    const baseUrl = await listen((request, response) => {
      if (request.url?.startsWith('/api/v1/forecast/horsens')) {
        return json(response, 200, expired);
      }
      return json(response, 404, { error: 'not found' });
    });

    await expect(warmRelease({
      baseUrl,
      locationIds: ['horsens'],
      expectedVersion: 7,
      attempts: 1,
      timeoutMs: 500,
      retryDelayMs: 1,
      logger: silentLogger,
    })).rejects.toThrow('HTTP 200 contract mismatch');
  });

  it('requires a completed target generation, not a target-version pending shell', async () => {
    const pending = forecast('horsens', 7);
    pending.sources.cacheHealth = {
      status: 'pending',
      lastAttemptAt: '2026-08-20T11:55:00Z',
      needsRebuild: true,
    };
    const baseUrl = await listen((request, response) => {
      if (request.url?.startsWith('/api/v1/forecast/horsens')) {
        return json(response, 200, pending);
      }
      return json(response, 404, { error: 'not found' });
    });

    await expect(warmRelease({
      baseUrl,
      locationIds: ['horsens'],
      expectedVersion: 7,
      requireTargetReadyAll: true,
      attempts: 1,
      timeoutMs: 500,
      retryDelayMs: 1,
      logger: silentLogger,
    })).rejects.toThrow(
      'target payload v7 is not ready for every public location: horsens',
    );
  });

  it('rejects a structurally valid payload from the wrong location coordinate', async () => {
    const baseUrl = await listen((request, response) => {
      if (request.url?.startsWith('/api/v1/forecast/horsens')) {
        return json(response, 200, forecast('horsens', 7, {
          latitude: 56,
          longitude: 10,
        }));
      }
      return json(response, 404, { error: 'not found' });
    });

    await expect(warmRelease({
      baseUrl,
      locationIds: ['horsens'],
      locationContracts: [{
        id: 'horsens',
        coordinate: { latitude: 55.858, longitude: 9.905 },
      }],
      expectedVersion: 7,
      attempts: 1,
      timeoutMs: 500,
      retryDelayMs: 1,
      logger: silentLogger,
    })).rejects.toThrow('HTTP 200 contract mismatch');
  });

  it('retries a bounded transient failure without skipping ahead', async () => {
    const requests: string[] = [];
    let attempts = 0;
    const baseUrl = await listen((request, response) => {
      requests.push(request.url ?? '');
      if (request.url?.startsWith('/api/v1/forecast/horsens')) {
        attempts += 1;
        if (attempts === 1) {
          request.socket.destroy();
          return;
        }
        return json(response, 200, forecast('horsens'));
      }
      if (request.url?.startsWith('/api/v1/forecast/vejle')) return json(response, 200, forecast('vejle'));
      if (request.url === '/health') return json(response, 200, health(['horsens', 'vejle']));
      return json(response, 404, { error: 'not found' });
    });

    await warmRelease({
      baseUrl,
      locationIds: ['horsens', 'vejle'],
      expectedVersion: 7,
      attempts: 2,
      timeoutMs: 500,
      retryDelayMs: 1,
      logger: silentLogger,
    });

    expect(requests).toEqual([
      '/api/v1/forecast/horsens?warm=1',
      '/api/v1/forecast/horsens?warm=1',
      '/api/v1/forecast/vejle?warm=1',
      '/health',
    ]);
  });

  it('retries a same-schema forecast from the previous Worker during edge propagation', async () => {
    const requests: string[] = [];
    let horsensAttempts = 0;
    const baseUrl = await listen((request, response) => {
      requests.push(request.url ?? '');
      if (request.url === '/api/v1/forecast/horsens?warm=1') {
        horsensAttempts += 1;
        return json(
          response,
          200,
          forecast('horsens'),
          horsensAttempts === 1 ? PREVIOUS_WORKER_VERSION_ID : EXPECTED_WORKER_VERSION_ID,
        );
      }
      if (request.url === '/api/v1/forecast/vejle?warm=1') return json(response, 200, forecast('vejle'));
      if (request.url === '/health') return json(response, 200, health(['horsens', 'vejle']));
      return json(response, 404, { error: 'not found' });
    });

    await warmRelease({
      baseUrl,
      locationIds: ['horsens', 'vejle'],
      expectedVersion: 7,
      attempts: 2,
      timeoutMs: 500,
      retryDelayMs: 1,
      logger: silentLogger,
    });

    expect(requests).toEqual([
      '/api/v1/forecast/horsens?warm=1',
      '/api/v1/forecast/horsens?warm=1',
      '/api/v1/forecast/vejle?warm=1',
      '/health',
    ]);
  });

  it('fails when an older Worker version remains active after bounded retries', async () => {
    let attempts = 0;
    const baseUrl = await listen((request, response) => {
      if (request.url?.startsWith('/api/v1/forecast/horsens')) {
        attempts += 1;
        return json(response, 200, forecast('horsens'), PREVIOUS_WORKER_VERSION_ID);
      }
      return json(response, 404, { error: 'not found' });
    });

    await expect(warmRelease({
      baseUrl,
      locationIds: ['horsens'],
      expectedVersion: 7,
      attempts: 2,
      timeoutMs: 500,
      retryDelayMs: 1,
      logger: silentLogger,
    })).rejects.toThrow(
      `expected Worker version ${EXPECTED_WORKER_VERSION_ID} did not become active after 2 attempts`,
    );
    expect(attempts).toBe(2);
  });

  it('waits for each cold warm-up response before starting the next location or health', async () => {
    const requests: string[] = [];
    let activeBuilds = 0;
    let maxActiveBuilds = 0;
    const baseUrl = await listen((request, response) => {
      requests.push(request.url ?? '');
      const match = request.url?.match(/^\/api\/v1\/forecast\/([a-z0-9-]+)\?warm=1$/);
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

    await warmRelease({
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
      '/api/v1/forecast/horsens?warm=1',
      '/api/v1/forecast/vejle?warm=1',
      '/health',
    ]);
  });

  it('retries a missing identity even for initialization, then continues and reports amber', async () => {
    const requests: string[] = [];
    const warnings: string[] = [];
    let horsensAttempts = 0;
    const baseUrl = await listen((request, response) => {
      requests.push(request.url ?? '');
      if (request.url === '/api/v1/forecast/horsens?warm=1') {
        horsensAttempts += 1;
        response.setHeader('Retry-After', '600');
        return json(
          response,
          503,
          initializing('horsens'),
          horsensAttempts === 1 ? null : EXPECTED_WORKER_VERSION_ID,
        );
      }
      if (request.url === '/api/v1/forecast/vejle?warm=1') {
        return json(response, 200, forecast('vejle'));
      }
      if (request.url === '/health') {
        return json(response, 503, health(['horsens', 'vejle'], { missing: ['horsens'] }));
      }
      return json(response, 404, { error: 'not found' });
    });

    const result = await warmRelease({
      baseUrl,
      locationIds: ['horsens', 'vejle'],
      expectedVersion: 7,
      attempts: 3,
      timeoutMs: 500,
      retryDelayMs: 1,
      logger: { info: () => {}, warn: (message: string) => warnings.push(message) },
    });

    expect(requests).toEqual([
      '/api/v1/forecast/horsens?warm=1',
      '/api/v1/forecast/horsens?warm=1',
      '/api/v1/forecast/vejle?warm=1',
      '/health',
    ]);
    expect(result).toEqual({
      availableLocationIds: ['vejle'],
      targetReadyLocationIds: ['vejle'],
      generationNotReadyLocationIds: [],
      verifiedPriorApiSchemaVersions: [],
      initializingLocationIds: ['horsens'],
      transientLocationIds: ['horsens'],
      staleDataLocationIds: [],
    });
    expect(warnings.some((message) => message.includes('AMBER'))).toBe(true);
  });

  it('fails the release when every configured location is still initializing', async () => {
    const locationIds = ['horsens', 'vejle'];
    const baseUrl = await listen((request, response) => {
      const match = request.url?.match(/^\/api\/v1\/forecast\/([a-z0-9-]+)\?warm=1$/);
      if (match) {
        response.setHeader('Retry-After', '600');
        return json(response, 503, initializing(match[1]));
      }
      if (request.url === '/health') {
        return json(response, 503, health(locationIds, { missing: locationIds }));
      }
      return json(response, 404, { error: 'not found' });
    });

    await expect(warmRelease({
      baseUrl,
      locationIds,
      expectedVersion: 7,
      attempts: 1,
      timeoutMs: 500,
      retryDelayMs: 1,
      logger: silentLogger,
    })).rejects.toThrow(
      'release has no ready forecast locations; refusing a zero-availability production release',
    );
  });

  it('continues through all cold cities when busy and resumes through ready cities next cycle', async () => {
    const contract = await loadReleaseContract();
    const locations = contract.locations;
    const locationIds = locations.map(({ id }) => id);
    let cycle = 1;
    const requests: string[] = [];
    const baseUrl = await listen((request, response) => {
      requests.push(request.url ?? '');
      const match = request.url?.match(/^\/api\/v1\/forecast\/([a-z0-9-]+)\?warm=1$/);
      if (match) {
        const locationId = match[1];
        const location = locations.find(({ id }) => id === locationId);
        if (cycle === 2 && locationIds.slice(0, 2).includes(locationId)) {
          return json(
            response,
            200,
            forecast(locationId, contract.expectedVersion, location?.coordinate, contract.release),
            EXPECTED_WORKER_VERSION_ID,
            exactReleaseHeaders(contract.release, true),
          );
        }
        const retryAfter = cycle === 1 ? 120 : 300;
        return json(
          response,
          503,
          initializing(locationId, retryAfter),
          EXPECTED_WORKER_VERSION_ID,
          {
            ...exactReleaseHeaders(contract.release, false),
            'Retry-After': String(retryAfter),
          },
        );
      }
      if (request.url === '/health') {
        const missing = cycle === 1 ? locationIds : locationIds.slice(2);
        const body = releaseHealth(locationIds, contract.release, { missing });
        return json(
          response,
          503,
          body,
          EXPECTED_WORKER_VERSION_ID,
          exactReleaseHeaders(contract.release),
        );
      }
      return json(response, 404, { error: 'not found' });
    });

    const options = {
      baseUrl,
      locationIds,
      locationContracts: locations,
      expectedVersion: contract.expectedVersion,
      expectedRelease: contract.release,
      requireTargetReadyAll: true,
      allowWaiting: true,
      attempts: 1,
      timeoutMs: 500,
      retryDelayMs: 1,
      logger: silentLogger,
    };

    const firstResult = await warmRelease(options);

    expect(firstResult).toMatchObject({
      readyForPromotion: false,
      waitingLocationIds: locationIds,
      retryAfterSeconds: 120,
      targetReadyLocationIds: [],
      initializingLocationIds: locationIds,
    });
    expect(requests).toEqual([
      ...locationIds.map((id) => `/api/v1/forecast/${id}?warm=1`),
      '/health',
    ]);

    cycle = 2;
    requests.length = 0;
    const secondResult = await warmRelease(options);

    expect(secondResult).toMatchObject({
      readyForPromotion: false,
      waitingLocationIds: locationIds.slice(2),
      retryAfterSeconds: 300,
      targetReadyLocationIds: locationIds.slice(0, 2),
      initializingLocationIds: locationIds.slice(2),
      transientLocationIds: locationIds.slice(2),
    });
    expect(requests).toEqual([
      ...locationIds.map((id) => `/api/v1/forecast/${id}?warm=1`),
      '/health',
    ]);
  });

  it('probes all cold locations during progressive warm cycles', async () => {
    const contract = await loadReleaseContract();
    const locations = contract.locations;
    const locationIds = locations.map(({ id }) => id);
    const requestsByCycle: string[][] = [];
    let currentRequests: string[] = [];
    const baseUrl = await listen((request, response) => {
      currentRequests.push(request.url ?? '');
      const match = request.url?.match(/^\/api\/v1\/forecast\/([a-z0-9-]+)\?warm=1$/);
      if (match) {
        return json(
          response,
          503,
          initializing(match[1]),
          EXPECTED_WORKER_VERSION_ID,
          {
            ...exactReleaseHeaders(contract.release, false),
            'Retry-After': '600',
          },
        );
      }
      if (request.url === '/health') {
        return json(
          response,
          503,
          releaseHealth(locationIds, contract.release, { missing: locationIds }),
          EXPECTED_WORKER_VERSION_ID,
          exactReleaseHeaders(contract.release),
        );
      }
      return json(response, 404, { error: 'not found' });
    });

    for (let bucket = 0; bucket < locationIds.length; bucket += 1) {
      currentRequests = [];
      const result = await warmRelease({
        baseUrl,
        locationIds,
        locationContracts: locations,
        expectedVersion: contract.expectedVersion,
        expectedRelease: contract.release,
        requireTargetReadyAll: true,
        allowWaiting: true,
        rotationNowMs: bucket * 10 * 60_000,
        attempts: 1,
        timeoutMs: 500,
        retryDelayMs: 1,
        logger: silentLogger,
      });
      requestsByCycle.push(currentRequests);

      expect(result).toMatchObject({
        readyForPromotion: false,
        waitingLocationIds: locationIds,
        initializingLocationIds: locationIds,
        transientLocationIds: locationIds,
      });
    }

    expect(requestsByCycle).toHaveLength(locationIds.length);
    for (const cycleReqs of requestsByCycle) {
      expect(cycleReqs).toHaveLength(locationIds.length + 1);
      expect(cycleReqs[cycleReqs.length - 1]).toBe('/health');
    }
  });

  it('returns promotion-ready only after exact forecasts and exact health agree', async () => {
    const contract = await loadReleaseContract();
    const locations = contract.locations.slice(0, 2);
    const locationIds = locations.map(({ id }) => id);
    const baseUrl = await listen((request, response) => {
      const match = request.url?.match(/^\/api\/v1\/forecast\/([a-z0-9-]+)\?warm=1$/);
      if (match) {
        const location = locations.find(({ id }) => id === match[1]);
        return json(
          response,
          200,
          forecast(match[1], contract.expectedVersion, location?.coordinate, contract.release),
          EXPECTED_WORKER_VERSION_ID,
          exactReleaseHeaders(contract.release, true),
        );
      }
      if (request.url === '/health') {
        return json(
          response,
          200,
          exactHealth(locationIds, contract.release),
          EXPECTED_WORKER_VERSION_ID,
          exactReleaseHeaders(contract.release),
        );
      }
      return json(response, 404, { error: 'not found' });
    });

    await expect(warmRelease({
      baseUrl,
      locationIds,
      locationContracts: locations,
      expectedVersion: contract.expectedVersion,
      expectedRelease: contract.release,
      requireTargetReadyAll: true,
      allowWaiting: true,
      attempts: 1,
      timeoutMs: 500,
      retryDelayMs: 1,
      logger: silentLogger,
    })).resolves.toMatchObject({
      readyForPromotion: true,
      waitingLocationIds: [],
      retryAfterSeconds: 0,
    });
  });

  it('reports internally consistent target-health lag as waiting after propagation', async () => {
    const contract = await loadReleaseContract();
    const locations = contract.locations.slice(0, 2);
    const locationIds = locations.map(({ id }) => id);
    const laggingId = locationIds[1];
    const baseUrl = await listen((request, response) => {
      const match = request.url?.match(/^\/api\/v1\/forecast\/([a-z0-9-]+)\?warm=1$/);
      if (match) {
        const location = locations.find(({ id }) => id === match[1]);
        return json(
          response,
          200,
          forecast(match[1], contract.expectedVersion, location?.coordinate, contract.release),
          EXPECTED_WORKER_VERSION_ID,
          exactReleaseHeaders(contract.release, true),
        );
      }
      if (request.url === '/health') {
        return json(
          response,
          200,
          releaseHealth(locationIds, contract.release, { fallback: [laggingId] }),
          EXPECTED_WORKER_VERSION_ID,
          exactReleaseHeaders(contract.release),
        );
      }
      return json(response, 404, { error: 'not found' });
    });

    await expect(warmRelease({
      baseUrl,
      locationIds,
      locationContracts: locations,
      expectedVersion: contract.expectedVersion,
      expectedRelease: contract.release,
      requireTargetReadyAll: true,
      allowWaiting: true,
      attempts: 1,
      timeoutMs: 500,
      retryDelayMs: 1,
      healthPropagationTimeoutMs: 20,
      healthPropagationRetryDelayMs: 1,
      logger: silentLogger,
    })).resolves.toMatchObject({
      readyForPromotion: false,
      waitingLocationIds: [laggingId],
      retryAfterSeconds: 600,
    });
  });

  it('does not downgrade malformed initialization or unavailable storage into waiting', async () => {
    const contract = await loadReleaseContract();
    const location = contract.locations[0];
    let malformed = true;
    const baseUrl = await listen((request, response) => {
      if (request.url?.startsWith(`/api/v1/forecast/${location.id}`)) {
        const body = initializing(location.id);
        if (malformed) body.code = 'NOT_THE_INITIALIZATION_CONTRACT';
        return json(
          response,
          503,
          body,
          EXPECTED_WORKER_VERSION_ID,
          {
            ...exactReleaseHeaders(contract.release, false),
            'Retry-After': '600',
          },
        );
      }
      if (request.url === '/health') {
        const body = releaseHealth([location.id], contract.release, { missing: [location.id] });
        body.storageAvailable = false;
        return json(
          response,
          503,
          body,
          EXPECTED_WORKER_VERSION_ID,
          exactReleaseHeaders(contract.release),
        );
      }
      return json(response, 404, { error: 'not found' });
    });
    const options = {
      baseUrl,
      locationIds: [location.id],
      locationContracts: [location],
      expectedVersion: contract.expectedVersion,
      expectedRelease: contract.release,
      requireTargetReadyAll: true,
      allowWaiting: true,
      attempts: 1,
      timeoutMs: 500,
      retryDelayMs: 1,
      logger: silentLogger,
    };

    await expect(warmRelease(options)).rejects.toThrow('HTTP 503 contract mismatch');
    malformed = false;
    await expect(warmRelease(options)).rejects.toThrow('forecast storage unavailable');
  });

  it('does not downgrade Worker identity or target-health schema errors into waiting', async () => {
    const contract = await loadReleaseContract();
    const location = contract.locations[0];
    let mode: 'identity' | 'schema' = 'identity';
    const baseUrl = await listen((request, response) => {
      if (request.url?.startsWith(`/api/v1/forecast/${location.id}`)) {
        return json(
          response,
          503,
          initializing(location.id),
          mode === 'identity' ? PREVIOUS_WORKER_VERSION_ID : EXPECTED_WORKER_VERSION_ID,
          {
            ...exactReleaseHeaders(contract.release, false),
            'Retry-After': '600',
          },
        );
      }
      if (request.url === '/health') {
        const body = releaseHealth([location.id], contract.release, { missing: [location.id] });
        delete (body as { release?: unknown }).release;
        return json(
          response,
          503,
          body,
          EXPECTED_WORKER_VERSION_ID,
          exactReleaseHeaders(contract.release),
        );
      }
      return json(response, 404, { error: 'not found' });
    });
    const options = {
      baseUrl,
      locationIds: [location.id],
      locationContracts: [location],
      expectedVersion: contract.expectedVersion,
      expectedRelease: contract.release,
      requireTargetReadyAll: true,
      allowWaiting: true,
      attempts: 1,
      timeoutMs: 500,
      retryDelayMs: 1,
      logger: silentLogger,
    };

    await expect(warmRelease(options)).rejects.toThrow('did not become active');
    mode = 'schema';
    await expect(warmRelease(options)).rejects.toThrow('target release health contract is malformed');
  });

  it('waits for a just-warmed ready cache to propagate into health', async () => {
    const requests: string[] = [];
    let healthChecks = 0;
    const baseUrl = await listen((request, response) => {
      requests.push(request.url ?? '');
      const match = request.url?.match(/^\/api\/v1\/forecast\/([a-z0-9-]+)\?warm=1$/);
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

    await warmRelease({
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

  it('waits for exact target-generation readiness to propagate from missing to ready', async () => {
    const contract = await loadReleaseContract();
    const location = contract.locations[0];
    let healthChecks = 0;
    const baseUrl = await listen((request, response) => {
      if (request.url === `/api/v1/forecast/${location.id}?warm=1`) {
        return json(
          response,
          200,
          forecast(
            location.id,
            contract.expectedVersion,
            location.coordinate,
            contract.release,
          ),
          EXPECTED_WORKER_VERSION_ID,
          exactReleaseHeaders(contract.release, true),
        );
      }
      if (request.url === '/health') {
        healthChecks += 1;
        const body = healthChecks === 1
          ? releaseHealth([location.id], contract.release, { missing: [location.id] })
          : exactHealth([location.id], contract.release);
        return json(
          response,
          body.ok ? 200 : 503,
          body,
          EXPECTED_WORKER_VERSION_ID,
          exactReleaseHeaders(contract.release),
        );
      }
      return json(response, 404, { error: 'not found' });
    });

    await warmRelease({
      baseUrl,
      locationIds: [location.id],
      locationContracts: [location],
      expectedVersion: contract.expectedVersion,
      expectedRelease: contract.release,
      requireTargetReadyAll: true,
      attempts: 1,
      timeoutMs: 500,
      retryDelayMs: 1,
      healthPropagationTimeoutMs: 100,
      healthPropagationRetryDelayMs: 1,
      logger: silentLogger,
    });

    expect(healthChecks).toBe(2);
  });

  it('waits when health still exposes an audited fallback after the exact warm succeeded', async () => {
    const contract = await loadReleaseContract();
    const location = contract.locations[0];
    let healthChecks = 0;
    const baseUrl = await listen((request, response) => {
      if (request.url === `/api/v1/forecast/${location.id}?warm=1`) {
        return json(
          response,
          200,
          forecast(
            location.id,
            contract.expectedVersion,
            location.coordinate,
            contract.release,
          ),
          EXPECTED_WORKER_VERSION_ID,
          exactReleaseHeaders(contract.release, true),
        );
      }
      if (request.url === '/health') {
        healthChecks += 1;
        const body = healthChecks === 1
          ? releaseHealth([location.id], contract.release, { fallback: [location.id] })
          : exactHealth([location.id], contract.release);
        return json(
          response,
          200,
          body,
          EXPECTED_WORKER_VERSION_ID,
          exactReleaseHeaders(contract.release),
        );
      }
      return json(response, 404, { error: 'not found' });
    });

    await warmRelease({
      baseUrl,
      locationIds: [location.id],
      locationContracts: [location],
      expectedVersion: contract.expectedVersion,
      expectedRelease: contract.release,
      requireTargetReadyAll: true,
      attempts: 1,
      timeoutMs: 500,
      retryDelayMs: 1,
      healthPropagationTimeoutMs: 100,
      healthPropagationRetryDelayMs: 1,
      logger: silentLogger,
    });

    expect(healthChecks).toBe(2);
  });

  it('fails only after the bounded window when exact target health stays missing', async () => {
    const contract = await loadReleaseContract();
    const location = contract.locations[0];
    let healthChecks = 0;
    const baseUrl = await listen((request, response) => {
      if (request.url === `/api/v1/forecast/${location.id}?warm=1`) {
        return json(
          response,
          200,
          forecast(
            location.id,
            contract.expectedVersion,
            location.coordinate,
            contract.release,
          ),
          EXPECTED_WORKER_VERSION_ID,
          exactReleaseHeaders(contract.release, true),
        );
      }
      if (request.url === '/health') {
        healthChecks += 1;
        const body = releaseHealth(
          [location.id],
          contract.release,
          { missing: [location.id] },
        );
        return json(
          response,
          503,
          body,
          EXPECTED_WORKER_VERSION_ID,
          exactReleaseHeaders(contract.release),
        );
      }
      return json(response, 404, { error: 'not found' });
    });

    await expect(warmRelease({
      baseUrl,
      locationIds: [location.id],
      locationContracts: [location],
      expectedVersion: contract.expectedVersion,
      expectedRelease: contract.release,
      requireTargetReadyAll: true,
      attempts: 1,
      timeoutMs: 500,
      retryDelayMs: 1,
      // Leave enough wall-clock room for a second local HTTP round trip even
      // when Vitest is running every file concurrently on a loaded CI runner.
      // The production window is independently bounded by warmRelease defaults.
      healthPropagationTimeoutMs: 500,
      healthPropagationRetryDelayMs: 10,
      logger: silentLogger,
    })).rejects.toThrow('cache propagation window: exact target generation not visible yet');
    expect(healthChecks).toBeGreaterThan(1);
  });

  it('waits for the expected Worker identity to reach the health route', async () => {
    let healthChecks = 0;
    const baseUrl = await listen((request, response) => {
      if (request.url?.startsWith('/api/v1/forecast/horsens')) {
        return json(response, 200, forecast('horsens'));
      }
      if (request.url === '/health') {
        healthChecks += 1;
        return json(
          response,
          200,
          health(['horsens']),
          healthChecks === 1 ? PREVIOUS_WORKER_VERSION_ID : EXPECTED_WORKER_VERSION_ID,
        );
      }
      return json(response, 404, { error: 'not found' });
    });

    await warmRelease({
      baseUrl,
      locationIds: ['horsens'],
      expectedVersion: 7,
      attempts: 1,
      timeoutMs: 500,
      retryDelayMs: 1,
      healthPropagationTimeoutMs: 100,
      healthPropagationRetryDelayMs: 1,
      logger: silentLogger,
    });

    expect(healthChecks).toBe(2);
  });

  it('accepts operationally red stale health without pretending it is green', async () => {
    const warnings: string[] = [];
    const baseUrl = await listen((request, response) => {
      const match = request.url?.match(/^\/api\/v1\/forecast\/([a-z0-9-]+)\?warm=1$/);
      if (match) return json(response, 200, forecast(match[1]));
      if (request.url === '/health') {
        return json(response, 503, health(['horsens', 'vejle'], { staleData: ['vejle'] }));
      }
      return json(response, 404, { error: 'not found' });
    });

    const result = await warmRelease({
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

  it('rejects stale data under the exact-all production policy', async () => {
    const contract = await loadReleaseContract();
    const location = contract.locations[0];
    const baseUrl = await listen((request, response) => {
      if (request.url?.startsWith(`/api/v1/forecast/${location.id}`)) {
        return json(
          response,
          200,
          forecast(
            location.id,
            contract.expectedVersion,
            location.coordinate,
            contract.release,
          ),
          EXPECTED_WORKER_VERSION_ID,
          exactReleaseHeaders(contract.release, true),
        );
      }
      if (request.url === '/health') {
        return json(
          response,
          503,
          releaseHealth([location.id], contract.release, { staleData: [location.id] }),
          EXPECTED_WORKER_VERSION_ID,
          exactReleaseHeaders(contract.release),
        );
      }
      return json(response, 404, { error: 'not found' });
    });

    await expect(warmRelease({
      baseUrl,
      locationIds: [location.id],
      locationContracts: [location],
      expectedVersion: contract.expectedVersion,
      expectedRelease: contract.release,
      requireTargetReadyAll: true,
      attempts: 1,
      timeoutMs: 500,
      retryDelayMs: 1,
      logger: silentLogger,
    })).rejects.toThrow(`target release still has stale forecast data: ${location.id}`);
  });

  it('fails when a ready location is no longer checking upstream', async () => {
    const contract = await loadReleaseContract();
    const location = contract.locations[0];
    let healthChecks = 0;
    const baseUrl = await listen((request, response) => {
      if (request.url?.startsWith(`/api/v1/forecast/${location.id}`)) {
        return json(
          response,
          200,
          forecast(
            location.id,
            contract.expectedVersion,
            location.coordinate,
            contract.release,
          ),
          EXPECTED_WORKER_VERSION_ID,
          exactReleaseHeaders(contract.release, true),
        );
      }
      if (request.url === '/health') {
        healthChecks += 1;
        return json(
          response,
          503,
          releaseHealth([location.id], contract.release, { notChecking: [location.id] }),
          EXPECTED_WORKER_VERSION_ID,
          exactReleaseHeaders(contract.release),
        );
      }
      return json(response, 404, { error: 'not found' });
    });

    await expect(warmRelease({
      baseUrl,
      locationIds: [location.id],
      locationContracts: [location],
      expectedVersion: contract.expectedVersion,
      expectedRelease: contract.release,
      requireTargetReadyAll: true,
      attempts: 3,
      timeoutMs: 500,
      retryDelayMs: 1,
      logger: silentLogger,
    })).rejects.toThrow(`ready location is not checking upstream: ${location.id}`);
    expect(healthChecks).toBe(1);
  });

  it('reports ready locations not checking upstream as waiting when allowWaiting is true', async () => {
    const contract = await loadReleaseContract();
    const location = contract.locations[0];
    const baseUrl = await listen((request, response) => {
      if (request.url?.startsWith(`/api/v1/forecast/${location.id}`)) {
        return json(
          response,
          200,
          forecast(
            location.id,
            contract.expectedVersion,
            location.coordinate,
            contract.release,
          ),
          EXPECTED_WORKER_VERSION_ID,
          exactReleaseHeaders(contract.release, true),
        );
      }
      if (request.url === '/health') {
        return json(
          response,
          503,
          releaseHealth([location.id], contract.release, { notChecking: [location.id] }),
          EXPECTED_WORKER_VERSION_ID,
          exactReleaseHeaders(contract.release),
        );
      }
      return json(response, 404, { error: 'not found' });
    });

    await expect(warmRelease({
      baseUrl,
      locationIds: [location.id],
      locationContracts: [location],
      expectedVersion: contract.expectedVersion,
      expectedRelease: contract.release,
      requireTargetReadyAll: true,
      allowWaiting: true,
      attempts: 1,
      timeoutMs: 500,
      retryDelayMs: 1,
      healthPropagationTimeoutMs: 20,
      healthPropagationRetryDelayMs: 1,
      logger: silentLogger,
    })).resolves.toMatchObject({
      readyForPromotion: false,
      waitingLocationIds: [location.id],
      retryAfterSeconds: 600,
    });
  });

  it('fails immediately when health reports storage unavailable', async () => {
    let healthChecks = 0;
    const baseUrl = await listen((request, response) => {
      if (request.url?.startsWith('/api/v1/forecast/horsens')) {
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

    await expect(warmRelease({
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
      if (request.url?.startsWith('/api/v1/forecast/horsens')) {
        return json(response, 200, forecast('horsens'));
      }
      if (request.url === '/health') {
        return json(response, 503, health(['horsens'], { missing: ['horsens'] }));
      }
      return json(response, 404, { error: 'not found' });
    });

    await expect(warmRelease({
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

    await expect(warmRelease({
      baseUrl,
      locationIds: ['horsens'],
      expectedVersion: 7,
      attempts: 1,
      timeoutMs: 30,
      retryDelayMs: 1,
      logger: silentLogger,
    })).rejects.toThrow('forecast horsens failed after 1 attempt');
  });

  it('writes a waiting decision to GitHub output and exits successfully', async () => {
    const contract = await loadReleaseContract();
    const baseUrl = await listen((request, response) => {
      const match = request.url?.match(/^\/api\/v1\/forecast\/([a-z0-9-]+)\?warm=1$/);
      if (match) {
        return json(
          response,
          503,
          initializing(match[1]),
          EXPECTED_WORKER_VERSION_ID,
          {
            ...exactReleaseHeaders(contract.release, false),
            'Retry-After': '600',
          },
        );
      }
      if (request.url === '/health') {
        const body = releaseHealth(
          contract.locationIds,
          contract.release,
          { missing: contract.locationIds },
        );
        return json(
          response,
          503,
          body,
          EXPECTED_WORKER_VERSION_ID,
          exactReleaseHeaders(contract.release),
        );
      }
      return json(response, 404, { error: 'not found' });
    });

    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'frank-warm-output-'));
    const githubOutput = path.join(temporaryDirectory, 'github-output.txt');
    const child = spawn(process.execPath, [
      SCRIPT_PATH,
      '--base-url', baseUrl,
      '--expected-worker-version-id', EXPECTED_WORKER_VERSION_ID,
      '--require-target-ready-all',
      '--allow-waiting',
      '--github-output', githubOutput,
      '--attempts', '1',
      '--timeout-ms', '500',
      '--retry-delay-ms', '1',
    ], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      env: { ...process.env, FRANK_WARM_TOKEN: WARM_TOKEN },
    });
    child.stdout.resume();
    child.stderr.resume();

    const [exitCode] = await once(child, 'exit');
    expect(exitCode).toBe(0);
    expect(await readFile(githubOutput, 'utf8')).toBe([
      'ready_for_promotion=false',
      `waiting_location_ids=${contract.locationIds.join(',')}`,
      'retry_after_seconds=600',
      '',
    ].join('\n'));
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it('exits nonzero on a contract mismatch without printing the response body', async () => {
    const baseUrl = await listen((_request, response) => {
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'X-FRANK-Worker-Version': EXPECTED_WORKER_VERSION_ID,
      });
      response.end('{"hourly":[{}],"sources":{"payloadVersion":999,"location":{"id":"wrong"}},"private":"do-not-log"}');
    });

    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'frank-warm-summary-'));
    const summaryFile = path.join(temporaryDirectory, 'summary.md');
    const child = spawn(process.execPath, [
      SCRIPT_PATH,
      '--base-url', baseUrl,
      '--expected-worker-version-id', EXPECTED_WORKER_VERSION_ID,
      '--summary-file', summaryFile,
      '--summary-title', 'Candidate shadow readiness',
      '--attempts', '1',
      '--timeout-ms', '500',
      '--retry-delay-ms', '1',
    ], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      env: { ...process.env, FRANK_WARM_TOKEN: WARM_TOKEN },
    });

    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.resume();

    const [exitCode] = await once(child, 'exit');
    expect(exitCode).toBe(1);
    expect(stderr).toContain('[warm] failed: forecast horsens failed: HTTP 200 contract mismatch.');
    expect(stderr).not.toContain('do-not-log');
    const summary = await readFile(summaryFile, 'utf8');
    expect(summary).toContain('Gate: failed');
    expect(summary).toContain('Exact ready: 0/4');
    expect(summary).toContain('Horsens Fjord (`horsens`): failed during check');
    expect(summary).toContain('Vejle Fjord (`vejle`): not reached');
    expect(summary).toContain('Kolding Fjord (`kolding`): not reached');
    expect(summary).toContain('Aarhus Bugt (`aarhus`): not reached');
    expect(summary).not.toContain('do-not-log');
    await rm(temporaryDirectory, { recursive: true, force: true });
  });
});
