import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_LOCATIONS_FILE = path.join(REPOSITORY_ROOT, 'src', 'config', 'locations.json');
const DEFAULT_CONTRACT_FILE = path.join(REPOSITORY_ROOT, 'src', 'features', 'forecast', 'payloadVersion.ts');

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 2_000;

class WarmupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WarmupError';
  }
}

const consoleLogger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
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

function healthPayloadMatches(payload) {
  return payload?.ok === true;
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

    if (!response.ok) return { passed: false, reason: `HTTP ${response.status}` };

    try {
      return { passed: true, payload: await response.json() };
    } catch {
      return { passed: false, reason: 'invalid JSON' };
    }
  } catch (error) {
    return {
      passed: false,
      reason: error?.name === 'AbortError' ? 'timeout' : 'request error',
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function requireStage({
  label,
  url,
  validate,
  attempts,
  timeoutMs,
  retryDelayMs,
  fetchImpl,
  logger,
}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    logger.info(`[warm] ${label}: attempt ${attempt}/${attempts}`);
    const result = await requestJson(url, timeoutMs, fetchImpl);

    if (result.passed && validate(result.payload)) {
      logger.info(`[warm] ${label}: passed`);
      return;
    }

    const reason = result.passed ? 'payload contract mismatch' : result.reason;
    if (attempt < attempts) {
      logger.warn(`[warm] ${label}: ${reason}; retrying`);
      await delay(retryDelayMs * attempt);
    }
  }

  const suffix = attempts === 1 ? 'attempt' : 'attempts';
  throw new WarmupError(`${label} failed after ${attempts} ${suffix}.`);
}

export async function warmWorker({
  baseUrl,
  locationIds,
  expectedVersion,
  attempts = DEFAULT_ATTEMPTS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  fetchImpl = fetch,
  logger = consoleLogger,
}) {
  const base = normalizeBaseUrl(baseUrl);
  const boundedAttempts = positiveInteger(attempts, 'Attempts');
  const boundedTimeoutMs = positiveInteger(timeoutMs, 'Timeout');
  const boundedRetryDelayMs = positiveInteger(retryDelayMs, 'Retry delay');
  const version = positiveInteger(expectedVersion, 'Expected payload version');

  if (!Array.isArray(locationIds) || locationIds.length === 0) {
    throw new WarmupError('At least one location is required.');
  }

  // Keep these requests sequential. `warm=1` returns an existing compatible
  // cache without background work, but blocks until a missing cache has been
  // built. That makes the final health check a real readiness gate and prevents
  // a new environment from bursting all fjords against DMI and MET at once.
  for (const locationId of locationIds) {
    if (typeof locationId !== 'string' || !/^[a-z0-9-]+$/.test(locationId)) {
      throw new WarmupError('A location id is invalid.');
    }

    const url = new URL(`forecast/${encodeURIComponent(locationId)}`, base);
    url.searchParams.set('warm', '1');
    await requireStage({
      label: `forecast ${locationId}`,
      url,
      validate: (payload) => forecastPayloadMatches(payload, locationId, version),
      attempts: boundedAttempts,
      timeoutMs: boundedTimeoutMs,
      retryDelayMs: boundedRetryDelayMs,
      fetchImpl,
      logger,
    });
  }

  await requireStage({
    label: 'health',
    url: new URL('health', base),
    validate: healthPayloadMatches,
    attempts: boundedAttempts,
    timeoutMs: boundedTimeoutMs,
    retryDelayMs: boundedRetryDelayMs,
    fetchImpl,
    logger,
  });

  logger.info(`[warm] release gate passed for ${locationIds.length} locations`);
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
  --attempts <n>          Attempts per location and health check (default: ${DEFAULT_ATTEMPTS})
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
