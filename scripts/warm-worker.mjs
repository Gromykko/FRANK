import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_LOCATIONS_FILE = path.join(REPOSITORY_ROOT, 'src', 'config', 'locations.json');
const DEFAULT_CONTRACT_FILE = path.join(REPOSITORY_ROOT, 'src', 'features', 'forecast', 'payloadVersion.ts');

const DEFAULT_ATTEMPTS = 3;
// Cold route ceiling: 2s forecast read + 2s initialization-marker read +
// 24s build. Seven seconds of release-runner/network margin keeps the deploy
// gate from aborting a Worker that is still within its own bounded contract.
const DEFAULT_TIMEOUT_MS = 35_000;
const DEFAULT_RETRY_DELAY_MS = 2_000;
const DEFAULT_HEALTH_PROPAGATION_TIMEOUT_MS = 90_000;
const DEFAULT_HEALTH_RETRY_DELAY_MS = 5_000;
const MAX_RESPONSE_BODY_CHARS = 64 * 1024;

class WarmupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WarmupError';
  }
}

const consoleLogger = {
  info: (message) => console.log(message),
  warn: (message) => {
    console.warn(message);
    if (process.env.GITHUB_ACTIONS === 'true' && message.includes('AMBER')) {
      const escaped = message
        .replaceAll('%', '%25')
        .replaceAll('\r', '%0D')
        .replaceAll('\n', '%0A');
      console.warn(`::warning title=FRANK forecast availability::${escaped}`);
    }
  },
};

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new WarmupError(`${label} must be a positive integer.`);
  }
  return parsed;
}

function normalizeBaseUrl(value) {
  if (!value) throw new WarmupError('A Worker base URL is required.');

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new WarmupError('The Worker base URL is invalid.');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new WarmupError('The Worker base URL must use HTTP or HTTPS.');
  }

  url.hash = '';
  url.search = '';
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

export function parseForecastVersion(source) {
  const match = source.match(/export const FORECAST_PAYLOAD_VERSION\s*=\s*(\d+)\s*;/);
  if (!match) throw new WarmupError('The forecast payload version could not be read.');
  return positiveInteger(match[1], 'Forecast payload version');
}

export async function loadReleaseContract({
  locationsFile = DEFAULT_LOCATIONS_FILE,
  contractFile = DEFAULT_CONTRACT_FILE,
} = {}) {
  let locations;
  let contractSource;
  try {
    [locations, contractSource] = await Promise.all([
      readFile(locationsFile, 'utf8').then(JSON.parse),
      readFile(contractFile, 'utf8'),
    ]);
  } catch {
    throw new WarmupError('The checked-in release contract could not be loaded.');
  }

  if (!Array.isArray(locations) || locations.length === 0) {
    throw new WarmupError('The location manifest is empty or invalid.');
  }

  const ids = locations.map((location) => location?.id);
  if (ids.some((id) => typeof id !== 'string' || !/^[a-z0-9-]+$/.test(id))) {
    throw new WarmupError('The location manifest contains an invalid id.');
  }
  if (new Set(ids).size !== ids.length) {
    throw new WarmupError('The location manifest contains duplicate ids.');
  }

  return {
    locationIds: ids,
    expectedVersion: parseForecastVersion(contractSource),
  };
}

function forecastPayloadMatches(payload, locationId, expectedVersion) {
  return Boolean(
    payload
      && Array.isArray(payload.hourly)
      && payload.hourly.length > 0
      && payload.sources?.payloadVersion === expectedVersion
      && payload.sources?.location?.id === locationId,
  );
}

function initializingPayloadMatches(payload, locationId, retryAfterHeader) {
  const retryAfterSeconds = Number(retryAfterHeader);
  return Boolean(
    payload
      && payload.schemaVersion === 1
      && payload.status === 'initializing'
      && payload.code === 'FORECAST_INITIALIZING'
      && typeof payload.message === 'string'
      && payload.message.length > 0
      && Number.isSafeInteger(payload.retryAfterSeconds)
      && payload.retryAfterSeconds > 0
      && payload.retryAfterSeconds <= 10 * 60
      && retryAfterSeconds === payload.retryAfterSeconds
      && payload.location?.id === locationId
      && typeof payload.location?.name === 'string'
      && payload.location.name.length > 0
      && typeof payload.location?.areaName === 'string'
      && payload.location.areaName.length > 0,
  );
}

async function requestJson(url, timeoutMs, fetchImpl) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  timeoutId.unref?.();

  try {
    const response = await fetchImpl(url, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal,
    });

    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BODY_CHARS) {
      return { received: true, status: response.status, reason: 'response too large' };
    }
    try {
      const body = await response.text();
      if (body.length > MAX_RESPONSE_BODY_CHARS) {
        return { received: true, status: response.status, reason: 'response too large' };
      }
      return {
        received: true,
        status: response.status,
        payload: JSON.parse(body),
        retryAfter: response.headers.get('retry-after'),
      };
    } catch {
      return { received: true, status: response.status, reason: 'invalid JSON' };
    }
  } catch (error) {
    return {
      received: false,
      reason: error?.name === 'AbortError' ? 'timeout' : 'request error',
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function requireForecastStage({
  label,
  url,
  locationId,
  expectedVersion,
  attempts,
  timeoutMs,
  retryDelayMs,
  fetchImpl,
  logger,
}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    logger.info(`[warm] ${label}: attempt ${attempt}/${attempts}`);
    const result = await requestJson(url, timeoutMs, fetchImpl);

    if (result.received
      && result.status === 200
      && forecastPayloadMatches(result.payload, locationId, expectedVersion)) {
      logger.info(`[warm] ${label}: passed`);
      return 'ready';
    }

    if (result.received
      && result.status === 503
      && initializingPayloadMatches(result.payload, locationId, result.retryAfter)) {
      logger.warn(`[warm] ${label}: initializing; continuing release gate`);
      return 'initializing';
    }

    // A response reached the production Worker but failed its public contract.
    // Retrying could turn a deterministic code/schema fault into a lucky pass.
    if (result.received) {
      throw new WarmupError(`${label} failed: ${result.reason ?? `HTTP ${result.status} contract mismatch`}.`);
    }

    if (attempt < attempts) {
      const reason = result.reason;
      logger.warn(`[warm] ${label}: ${reason}; retrying`);
      await delay(retryDelayMs * attempt);
    }
  }

  const suffix = attempts === 1 ? 'attempt' : 'attempts';
  throw new WarmupError(`${label} failed after ${attempts} ${suffix}.`);
}

function sameStringSet(left, right) {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.length === sortedRight.length
    && sortedLeft.every((value, index) => value === sortedRight[index]);
}

function assessHealth(result, locationIds, transientIds) {
  if (!result.received) return { kind: 'transport', reason: result.reason };
  const payload = result.payload;
  if (!payload
    || payload.service !== 'frank-forecast'
    || typeof payload.checkedAt !== 'string'
    || !Number.isFinite(Date.parse(payload.checkedAt))
    || !Array.isArray(payload.locations)
    || !Array.isArray(payload.missing)
    || !Array.isArray(payload.stalled)
    || typeof payload.storageAvailable !== 'boolean'
    || !Number.isFinite(payload.checkStaleAfterMin)
    || payload.checkStaleAfterMin <= 0
    || !Number.isFinite(payload.dataStaleAfterMin)
    || payload.dataStaleAfterMin <= 0) {
    return { kind: 'hard', reason: result.reason ?? 'payload contract mismatch' };
  }

  const entries = payload.locations;
  const entryIds = entries.map((entry) => entry?.id);
  if (entries.length !== locationIds.length
    || entryIds.some((id) => typeof id !== 'string')
    || new Set(entryIds).size !== entryIds.length
    || !sameStringSet(entryIds, locationIds)
    || entries.some((entry) => typeof entry.hasCache !== 'boolean')) {
    return { kind: 'hard', reason: 'location health contract mismatch' };
  }
  if (!payload.storageAvailable) {
    return { kind: 'hard', reason: 'forecast storage unavailable' };
  }
  if (payload.missing.some((id) => typeof id !== 'string')
    || payload.stalled.some((id) => typeof id !== 'string')
    || new Set(payload.missing).size !== payload.missing.length
    || new Set(payload.stalled).size !== payload.stalled.length
    || payload.stalled.some((id) => !locationIds.includes(id))) {
    return { kind: 'hard', reason: 'health state contract mismatch' };
  }

  const missing = entries.filter((entry) => !entry.hasCache).map((entry) => entry.id);
  if (!sameStringSet(payload.missing, missing)) {
    return { kind: 'hard', reason: 'missing locations do not match cache availability' };
  }
  const checkedAtMs = Date.parse(payload.checkedAt);
  const checkStaleAfterMs = payload.checkStaleAfterMin * 60_000;
  const dataStaleAfterMs = payload.dataStaleAfterMin * 60_000;
  const computedStalled = [...missing];
  const staleDataReady = [];
  const notCheckingReady = [];

  for (const entry of entries.filter((candidate) => candidate.hasCache)) {
    const fetchedAtMs = Date.parse(entry.fetchedAt ?? '');
    const lastAttemptAtMs = Date.parse(entry.cacheHealth?.lastAttemptAt ?? '');
    if (!Number.isFinite(fetchedAtMs)
      || !Number.isFinite(lastAttemptAtMs)
      || fetchedAtMs > checkedAtMs
      || lastAttemptAtMs > checkedAtMs) {
      return { kind: 'hard', reason: `invalid health clocks for ready location ${entry.id}` };
    }
    const dataStale = checkedAtMs - fetchedAtMs > dataStaleAfterMs;
    const notChecking = checkedAtMs - lastAttemptAtMs > checkStaleAfterMs;
    if (dataStale) staleDataReady.push(entry.id);
    if (notChecking) notCheckingReady.push(entry.id);
    if (dataStale || notChecking) computedStalled.push(entry.id);
  }

  if (!sameStringSet(payload.stalled, computedStalled)) {
    return { kind: 'hard', reason: 'stalled locations do not match health clocks' };
  }
  if (notCheckingReady.length > 0) {
    return {
      kind: 'hard',
      reason: `ready location is not checking upstream: ${notCheckingReady.join(', ')}`,
    };
  }

  const expectedOk = payload.stalled.length === 0;
  const expectedStatus = expectedOk ? 200 : 503;
  if (payload.ok !== expectedOk || result.status !== expectedStatus) {
    return { kind: 'hard', reason: 'health status contract mismatch' };
  }

  const unexpectedMissing = missing.filter((id) => !transientIds.includes(id));
  if (unexpectedMissing.length > 0) {
    return {
      kind: 'propagation',
      reason: `ready cache not visible yet: ${unexpectedMissing.join(', ')}`,
    };
  }

  return {
    kind: 'passed',
    missing,
    staleDataReady,
  };
}

async function requireHealthStage({
  url,
  locationIds,
  transientIds,
  attempts,
  timeoutMs,
  retryDelayMs,
  propagationTimeoutMs,
  propagationRetryDelayMs,
  fetchImpl,
  logger,
}) {
  const deadlineAt = Date.now() + propagationTimeoutMs;
  let transportAttempts = 0;
  let propagationReason;

  while (true) {
    if (propagationReason && Date.now() >= deadlineAt) {
      throw new WarmupError(`health failed after cache propagation window: ${propagationReason}.`);
    }
    logger.info('[warm] health: checking');
    const remainingMs = Math.max(1, deadlineAt - Date.now());
    const result = await requestJson(url, Math.min(timeoutMs, remainingMs), fetchImpl);
    const assessment = assessHealth(result, locationIds, transientIds);

    if (assessment.kind === 'passed') {
      logger.info('[warm] health: passed');
      if (assessment.staleDataReady.length > 0) {
        logger.warn(
          `[warm] AMBER: ready forecast data is stale but checks are current: ${assessment.staleDataReady.join(', ')}`,
        );
      }
      return assessment;
    }
    if (assessment.kind === 'hard') {
      throw new WarmupError(`health failed: ${assessment.reason}.`);
    }
    if (assessment.kind === 'transport') {
      if (propagationReason) {
        logger.warn(`[warm] health: ${assessment.reason}; waiting for KV propagation`);
        await delay(Math.min(propagationRetryDelayMs, Math.max(1, deadlineAt - Date.now())));
        continue;
      }
      transportAttempts += 1;
      if (transportAttempts >= attempts) {
        throw new WarmupError(`health failed after ${attempts} ${attempts === 1 ? 'attempt' : 'attempts'}.`);
      }
      logger.warn(`[warm] health: ${assessment.reason}; retrying`);
      await delay(retryDelayMs * transportAttempts);
      continue;
    }

    if (Date.now() >= deadlineAt) {
      throw new WarmupError(`health failed after cache propagation window: ${assessment.reason}.`);
    }
    propagationReason = assessment.reason;
    logger.warn(`[warm] health: ${assessment.reason}; waiting for KV propagation`);
    await delay(Math.min(propagationRetryDelayMs, Math.max(1, deadlineAt - Date.now())));
  }
}

export async function warmWorker({
  baseUrl,
  locationIds,
  expectedVersion,
  attempts = DEFAULT_ATTEMPTS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  healthPropagationTimeoutMs = DEFAULT_HEALTH_PROPAGATION_TIMEOUT_MS,
  healthPropagationRetryDelayMs = DEFAULT_HEALTH_RETRY_DELAY_MS,
  fetchImpl = fetch,
  logger = consoleLogger,
}) {
  const base = normalizeBaseUrl(baseUrl);
  const boundedAttempts = positiveInteger(attempts, 'Attempts');
  const boundedTimeoutMs = positiveInteger(timeoutMs, 'Timeout');
  const boundedRetryDelayMs = positiveInteger(retryDelayMs, 'Retry delay');
  const boundedPropagationTimeoutMs = positiveInteger(
    healthPropagationTimeoutMs,
    'Health propagation timeout',
  );
  const boundedPropagationRetryDelayMs = positiveInteger(
    healthPropagationRetryDelayMs,
    'Health propagation retry delay',
  );
  const version = positiveInteger(expectedVersion, 'Expected payload version');

  if (!Array.isArray(locationIds) || locationIds.length === 0) {
    throw new WarmupError('At least one location is required.');
  }

  // Keep these requests sequential. `warm=1` returns an existing compatible
  // cache without background work and tries one cold build when no cooldown is
  // active. A typed transient becomes terminal amber for that location, so a
  // struggling upstream is never hammered by the release gate.
  const transientIds = [];
  for (const locationId of locationIds) {
    if (typeof locationId !== 'string' || !/^[a-z0-9-]+$/.test(locationId)) {
      throw new WarmupError('A location id is invalid.');
    }

    const url = new URL(`forecast/${encodeURIComponent(locationId)}`, base);
    url.searchParams.set('warm', '1');
    const result = await requireForecastStage({
      label: `forecast ${locationId}`,
      url,
      locationId,
      expectedVersion: version,
      attempts: boundedAttempts,
      timeoutMs: boundedTimeoutMs,
      retryDelayMs: boundedRetryDelayMs,
      fetchImpl,
      logger,
    });
    if (result === 'initializing') transientIds.push(locationId);
  }

  const health = await requireHealthStage({
    url: new URL('health', base),
    locationIds,
    transientIds,
    attempts: boundedAttempts,
    timeoutMs: boundedTimeoutMs,
    retryDelayMs: boundedRetryDelayMs,
    propagationTimeoutMs: boundedPropagationTimeoutMs,
    propagationRetryDelayMs: boundedPropagationRetryDelayMs,
    fetchImpl,
    logger,
  });

  if (transientIds.length > 0) {
    logger.warn(
      `[warm] AMBER: transient initialization observed for ${transientIds.join(', ')}; `
      + `${health.missing.length ? `still initializing: ${health.missing.join(', ')}` : 'all recovered before final health'}`,
    );
  }
  logger.info(`[warm] release gate passed for ${locationIds.length} locations`);
  return {
    initializingLocationIds: health.missing,
    transientLocationIds: transientIds,
    staleDataLocationIds: health.staleDataReady,
  };
}

function parseArguments(argv) {
  const values = {};
  const known = new Set([
    '--base-url',
    '--expected-version',
    '--attempts',
    '--timeout-ms',
    '--retry-delay-ms',
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') return { help: true };
    if (!known.has(argument)) throw new WarmupError(`Unknown option: ${argument}`);

    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new WarmupError(`Missing value for ${argument}.`);
    }
    values[argument] = value;
    index += 1;
  }

  return {
    baseUrl: values['--base-url'],
    expectedVersion: values['--expected-version'],
    attempts: values['--attempts'],
    timeoutMs: values['--timeout-ms'],
    retryDelayMs: values['--retry-delay-ms'],
  };
}

function printHelp() {
  console.log(`Usage: npm run worker:warm -- --base-url <url> [options]

Options:
  --expected-version <n>  Override the checked-in payload version
  --attempts <n>          Transport attempts per request (default: ${DEFAULT_ATTEMPTS})
  --timeout-ms <n>        Per-request timeout (default: ${DEFAULT_TIMEOUT_MS})
  --retry-delay-ms <n>    Initial retry delay (default: ${DEFAULT_RETRY_DELAY_MS})`);
}

export async function runCli(argv = process.argv.slice(2), environment = process.env) {
  const options = parseArguments(argv);
  if (options.help) {
    printHelp();
    return;
  }

  const contract = await loadReleaseContract();
  const expectedVersion = options.expectedVersion === undefined
    ? contract.expectedVersion
    : positiveInteger(options.expectedVersion, 'Expected payload version');

  await warmWorker({
    baseUrl: options.baseUrl ?? environment.FRANK_WORKER_BASE_URL,
    locationIds: contract.locationIds,
    expectedVersion,
    ...(options.attempts === undefined ? {} : { attempts: options.attempts }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.retryDelayMs === undefined ? {} : { retryDelayMs: options.retryDelayMs }),
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  runCli().catch((error) => {
    const message = error instanceof WarmupError ? error.message : 'Unexpected warm-up failure.';
    console.error(`[warm] failed: ${message}`);
    process.exitCode = 1;
  });
}
