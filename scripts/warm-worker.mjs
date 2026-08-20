import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_LOCATIONS_FILE = path.join(REPOSITORY_ROOT, 'src', 'config', 'locations.json');
const DEFAULT_CONTRACT_FILE = path.join(REPOSITORY_ROOT, 'src', 'features', 'forecast', 'releaseContract.ts');

const DEFAULT_ATTEMPTS = 3;
// Cold route ceiling: 2s forecast read + 2s initialization-marker read +
// 24s build. Seven seconds of release-runner/network margin keeps the deploy
// gate from aborting a Worker that is still within its own bounded contract.
const DEFAULT_TIMEOUT_MS = 35_000;
const DEFAULT_RETRY_DELAY_MS = 2_000;
const DEFAULT_HEALTH_PROPAGATION_TIMEOUT_MS = 90_000;
const DEFAULT_HEALTH_RETRY_DELAY_MS = 5_000;
const MAX_RESPONSE_BODY_CHARS = 64 * 1024;
const WORKER_VERSION_HEADER = 'x-frank-worker-version';
const RELEASE_HEADERS = Object.freeze({
  apiSchemaVersion: 'x-frank-api-schema',
  modelRevision: 'x-frank-model-revision',
  dataGenerationId: 'x-frank-data-generation',
  assembledCacheSchema: 'x-frank-assembled-cache-schema',
  marineCacheSchema: 'x-frank-marine-cache-schema',
  payloadVersion: 'x-frank-payload-version',
  generationReady: 'x-frank-generation-ready',
});
const WORKER_VERSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSION_OVERRIDE_HEADER = 'Cloudflare-Workers-Version-Overrides';
const LOCATION_COORDINATE_TOLERANCE_DEGREES = 0.001;
const REQUIRED_READING_FIELDS = [
  'tempAir',
  'precipitation',
  'weatherCode',
  'windSpeed',
  'windDirection',
  'windGust',
  'waveHeight',
  'waveDirection',
  'wavePeriod',
  'tempWater',
  'tideLevel',
  'currentSpeed',
  'currentDirection',
];
const OPTIONAL_READING_FIELDS = [
  'windSpeedMin',
  'windSpeedMax',
  'windGustMax',
  'waveHeightMin',
  'waveHeightMax',
  'tideLevelMin',
  'tideLevelMax',
  'tempWaterMin',
  'tempWaterMax',
];
const NON_NEGATIVE_READING_FIELDS = new Set([
  'precipitation',
  'windSpeed',
  'windGust',
  'waveHeight',
  'wavePeriod',
  'currentSpeed',
  'windSpeedMin',
  'windSpeedMax',
  'windGustMax',
  'waveHeightMin',
  'waveHeightMax',
]);
const DIRECTION_READING_FIELDS = new Set([
  'windDirection',
  'waveDirection',
  'currentDirection',
]);
const SUPPORTED_BLOCK_SPANS = new Set([6, 12]);

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

function workerVersionId(value, label) {
  if (typeof value !== 'string' || !WORKER_VERSION_ID.test(value)) {
    throw new WarmupError(`${label} must be a valid Cloudflare Worker version ID.`);
  }
  return value.toLowerCase();
}

function workerName(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^[a-z0-9-]+$/.test(value)) {
    throw new WarmupError('Worker name must contain only lowercase letters, numbers, and hyphens.');
  }
  return value;
}

export function compatibleForecastVersionFloor(currentVersion) {
  // The pre-launch baseline has no historical payload bridge. Future N-1
  // support is expressed by full release descriptors in releaseContract.ts,
  // never by assuming that a numeric predecessor is compatible.
  return positiveInteger(currentVersion, 'Expected payload version');
}

function requireCompatibleVersionFloor(currentVersion, requestedFloor) {
  const auditedFloor = compatibleForecastVersionFloor(currentVersion);
  const floor = requestedFloor === undefined
    ? auditedFloor
    : positiveInteger(requestedFloor, 'Compatible minimum payload version');
  if (floor < auditedFloor || floor > currentVersion) {
    throw new WarmupError(
      `Compatible minimum payload version for v${currentVersion} must be between audited v${auditedFloor} and v${currentVersion}.`,
    );
  }
  return floor;
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

function contractConstantInitializers(source) {
  const sourceFile = ts.createSourceFile(
    'releaseContract.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const initializers = new Map();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) {
        initializers.set(declaration.name.text, declaration.initializer);
      }
    }
  }
  return initializers;
}

function evaluateContractConstant(initializers, name, stack = new Set()) {
  const initializer = initializers.get(name);
  if (!initializer) throw new WarmupError(`The release contract is missing ${name}.`);
  if (stack.has(name)) throw new WarmupError(`The release contract contains a cycle at ${name}.`);
  const nextStack = new Set(stack).add(name);

  const evaluate = (node) => {
    if (ts.isParenthesizedExpression(node)
      || ts.isAsExpression(node)
      || ts.isSatisfiesExpression(node)
      || ts.isNonNullExpression(node)) return evaluate(node.expression);
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isPrefixUnaryExpression(node)
      && node.operator === ts.SyntaxKind.MinusToken
      && ts.isNumericLiteral(node.operand)) return -Number(node.operand.text);
    if (ts.isIdentifier(node)) {
      return evaluateContractConstant(initializers, node.text, nextStack);
    }
    if (ts.isArrayLiteralExpression(node)) return node.elements.map(evaluate);
    if (ts.isObjectLiteralExpression(node)) {
      const result = {};
      for (const property of node.properties) {
        if (ts.isSpreadAssignment(property)) {
          const spread = evaluate(property.expression);
          if (!spread || typeof spread !== 'object' || Array.isArray(spread)) {
            throw new WarmupError(`The release contract has an invalid object spread in ${name}.`);
          }
          Object.assign(result, spread);
          continue;
        }
        if (ts.isShorthandPropertyAssignment(property)) {
          result[property.name.text] = evaluateContractConstant(
            initializers,
            property.name.text,
            nextStack,
          );
          continue;
        }
        if (!ts.isPropertyAssignment(property)) {
          throw new WarmupError(`The release contract has an unsupported property in ${name}.`);
        }
        const propertyName = ts.isIdentifier(property.name)
          || ts.isStringLiteralLike(property.name)
          || ts.isNumericLiteral(property.name)
          ? property.name.text
          : null;
        if (propertyName === null) {
          throw new WarmupError(`The release contract has a computed property in ${name}.`);
        }
        result[propertyName] = evaluate(property.initializer);
      }
      return result;
    }
    if (ts.isCallExpression(node)
      && node.arguments.length === 1
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === 'Object'
      && node.expression.name.text === 'freeze') return evaluate(node.arguments[0]);
    throw new WarmupError(`The release contract has an unsupported expression in ${name}.`);
  };

  return evaluate(initializer);
}

function positiveUniqueApiVersions(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.every((version) => Number.isSafeInteger(version) && version > 0)
    && new Set(value).size === value.length;
}

export function parseReleasePolicy(source) {
  if (typeof source !== 'string') throw new WarmupError('The release contract source is invalid.');
  const initializers = contractConstantInitializers(source);
  const release = evaluateContractConstant(initializers, 'CURRENT_RELEASE');
  const supportedApiSchemaVersions = evaluateContractConstant(
    initializers,
    'SUPPORTED_FORECAST_API_SCHEMA_VERSIONS',
  );
  const auditedPreviousReleases = evaluateContractConstant(
    initializers,
    'AUDITED_PREVIOUS_FORECAST_GENERATIONS',
  );
  if (!validReleaseMetadata(release)) {
    throw new WarmupError('The current release descriptor is invalid.');
  }
  if (!positiveUniqueApiVersions(supportedApiSchemaVersions)) {
    throw new WarmupError('The supported API schema list is invalid.');
  }
  if (!Array.isArray(auditedPreviousReleases)
    || !auditedPreviousReleases.every(validReleaseMetadata)) {
    throw new WarmupError('An audited previous release descriptor is invalid.');
  }

  // The Worker resolves the first full descriptor for each prior API schema.
  // Same-API model generations are rollback/fallback material, not a separate
  // client representation, so the compatibility gate deliberately skips them.
  const seenPriorApis = new Set();
  const auditedPriorApiReleases = [];
  for (const previous of auditedPreviousReleases) {
    if (previous.apiSchemaVersion === release.apiSchemaVersion
      || seenPriorApis.has(previous.apiSchemaVersion)) continue;
    seenPriorApis.add(previous.apiSchemaVersion);
    auditedPriorApiReleases.push(previous);
  }

  const descriptorApiVersions = new Set([
    release.apiSchemaVersion,
    ...auditedPriorApiReleases.map((previous) => previous.apiSchemaVersion),
  ]);
  if (!sameStringSet(
    supportedApiSchemaVersions.map(String),
    [...descriptorApiVersions].map(String),
  )) {
    throw new WarmupError(
      'Supported API schema versions must exactly match the current and audited prior release descriptors.',
    );
  }
  if (auditedPriorApiReleases.length > 0) {
    const schemas = auditedPriorApiReleases
      .map((previous) => `v${previous.apiSchemaVersion}`)
      .join(', ');
    throw new WarmupError(
      `Breaking API release is blocked for prior schema ${schemas}. `
      + 'Implement an explicit continuous representation-adapter registry and dual materialization; '
      + 'a deployment-time snapshot check cannot keep old clients fresh.',
    );
  }

  return {
    release,
    supportedApiSchemaVersions: [...supportedApiSchemaVersions],
    auditedPreviousReleases: [...auditedPreviousReleases],
    auditedPriorApiReleases,
  };
}

export function parseReleaseContract(source) {
  return parseReleasePolicy(source).release;
}

// Backward-compatible test/helper export. The checked-in source of truth is
// releaseContract.ts; payloadVersion.ts is now only an alias for old clients.
export function parseForecastVersion(source) {
  if (typeof source !== 'string') throw new WarmupError('The release contract source is invalid.');
  return positiveInteger(
    evaluateContractConstant(
      contractConstantInitializers(source),
      'LEGACY_FORECAST_PAYLOAD_VERSION',
    ),
    'LEGACY_FORECAST_PAYLOAD_VERSION',
  );
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

  if (locations.some((location) => !Number.isFinite(location?.coordinate?.latitude)
    || !Number.isFinite(location?.coordinate?.longitude))) {
    throw new WarmupError('The location manifest contains an invalid coordinate.');
  }

  const policy = parseReleasePolicy(contractSource);
  const { release } = policy;
  const expectedVersion = release.payloadVersion;

  return {
    locationIds: ids,
    locations: locations.map((location) => ({
      id: location.id,
      coordinate: {
        latitude: location.coordinate.latitude,
        longitude: location.coordinate.longitude,
      },
    })),
    expectedVersion,
    release,
    supportedApiSchemaVersions: policy.supportedApiSchemaVersions,
    auditedPreviousReleases: policy.auditedPreviousReleases,
    auditedPriorApiReleases: policy.auditedPriorApiReleases,
    compatibleMinVersion: compatibleForecastVersionFloor(expectedVersion),
  };
}

function timestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function increasingTimestamps(values) {
  if (!Array.isArray(values)) return false;
  let previous = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const current = typeof value === 'string' ? Date.parse(value) : Number.NaN;
    if (!Number.isFinite(current) || current <= previous) return false;
    previous = current;
  }
  return true;
}

function forecastReading(field, value) {
  // JSON encodes the application's NaN "provider did not supply a value"
  // sentinel as null. Both null and a finite number are valid wire readings.
  if (value === null) return true;
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (NON_NEGATIVE_READING_FIELDS.has(field)) return value >= 0;
  if (DIRECTION_READING_FIELDS.has(field)) return value >= 0 && value < 360;
  if (field === 'weatherCode') return Number.isInteger(value) && value >= 0 && value <= 99;
  return true;
}

function forecastHourMatches(hour, previousEnd) {
  if (!hour || typeof hour !== 'object') return null;
  const start = Date.parse(hour.time);
  if (!Number.isFinite(start) || start < previousEnd
    || typeof hour.symbolCode !== 'string'
    || hour.symbolCode.length === 0
    || typeof hour.isDay !== 'boolean'
    || !REQUIRED_READING_FIELDS.every((field) => forecastReading(field, hour[field]))
    || !OPTIONAL_READING_FIELDS.every(
      (field) => hour[field] === undefined || forecastReading(field, hour[field]),
    )) return null;

  const span = hour.blockSpanHours;
  if (span !== undefined && (!Number.isInteger(span) || !SUPPORTED_BLOCK_SPANS.has(span))) {
    return null;
  }
  if (span === undefined) {
    if (hour.isLowConfidence === true || hour.isOutlook === true) return null;
  } else if (hour.isLowConfidence !== true || hour.isOutlook !== true) {
    return null;
  }
  return start + (span ?? 1) * 60 * 60_000;
}

function warningsMatch(warnings) {
  if (warnings === undefined) return true;
  if (!Array.isArray(warnings)) return false;
  return warnings.every((warning) => warning
    && typeof warning === 'object'
    && typeof warning.event === 'string'
    && warning.event.length > 0
    && ['yellow', 'orange', 'red'].includes(warning.colour)
    && timestamp(warning.effective)
    && timestamp(warning.expires)
    && (warning.onset === undefined || timestamp(warning.onset))
    && typeof warning.url === 'string'
    && warning.url.startsWith('https://'));
}

function forecastPayloadMatches(
  payload,
  locationId,
  expectedVersion,
  expectedApiSchemaVersion,
  compatibleMinVersion,
  expectedLocation,
) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.hourly)
    || payload.hourly.length === 0 || !increasingTimestamps(payload.sunrise)
    || !increasingTimestamps(payload.sunset)) return false;

  let previousEnd = Number.NEGATIVE_INFINITY;
  for (const hour of payload.hourly) {
    const nextEnd = forecastHourMatches(hour, previousEnd);
    if (nextEnd === null) return false;
    previousEnd = nextEnd;
  }
  // A cache can be freshly stamped yet contain an exhausted or truncated
  // horizon. Such a payload is structurally valid but cannot render a current
  // forecast, so it must never authorize production promotion.
  if (previousEnd <= Date.now()) return false;

  const sources = payload.sources;
  const payloadVersion = sources?.payloadVersion;
  if (!Number.isSafeInteger(payloadVersion)
    || payloadVersion < compatibleMinVersion
    || payloadVersion > expectedVersion
    || sources?.location?.id !== locationId
    || typeof sources.location.name !== 'string'
    || sources.location.name.length === 0
    || typeof sources.location.areaName !== 'string'
    || sources.location.areaName.length === 0
    || !timestamp(sources.fetchedAt)
    || typeof sources.weather !== 'string'
    || sources.weather.length === 0
    || typeof sources.waves !== 'string'
    || sources.waves.length === 0
    || typeof sources.water !== 'string'
    || sources.water.length === 0
    || !Number.isFinite(sources.coordinate?.latitude)
    || !Number.isFinite(sources.coordinate?.longitude)
    || !warningsMatch(payload.warnings)) return false;

  if (sources.cacheHealth !== undefined
    && (!sources.cacheHealth
      || typeof sources.cacheHealth !== 'object'
      || !timestamp(sources.cacheHealth.lastAttemptAt))) return false;

  return !expectedLocation || (
    Math.abs(sources.coordinate.latitude - expectedLocation.coordinate.latitude)
      <= LOCATION_COORDINATE_TOLERANCE_DEGREES
    && Math.abs(sources.coordinate.longitude - expectedLocation.coordinate.longitude)
      <= LOCATION_COORDINATE_TOLERANCE_DEGREES
  );
}

function releaseMetadataMatches(value, expected) {
  if (!expected) return true;
  return Boolean(value
    && typeof value === 'object'
    && value.apiSchemaVersion === expected.apiSchemaVersion
    && value.modelRevision === expected.modelRevision
    && value.assembledCacheSchema === expected.assembledCacheSchema
    && value.marineCacheSchema === expected.marineCacheSchema
    && value.dataGenerationId === expected.dataGenerationId
    && value.payloadVersion === expected.payloadVersion);
}

function validReleaseMetadata(value) {
  return Boolean(value
    && typeof value === 'object'
    && ['apiSchemaVersion', 'modelRevision', 'assembledCacheSchema', 'marineCacheSchema', 'payloadVersion']
      .every((field) => Number.isSafeInteger(value[field]) && value[field] > 0)
    && typeof value.dataGenerationId === 'string'
    && /^[A-Za-z0-9._:-]+$/.test(value.dataGenerationId));
}

function responseReleaseHeaders(headers) {
  const number = (name) => {
    const value = headers.get(name);
    return value !== null && /^\d+$/.test(value) ? Number(value) : null;
  };
  const ready = headers.get(RELEASE_HEADERS.generationReady);
  return {
    apiSchemaVersion: number(RELEASE_HEADERS.apiSchemaVersion),
    modelRevision: number(RELEASE_HEADERS.modelRevision),
    assembledCacheSchema: number(RELEASE_HEADERS.assembledCacheSchema),
    marineCacheSchema: number(RELEASE_HEADERS.marineCacheSchema),
    dataGenerationId: headers.get(RELEASE_HEADERS.dataGenerationId),
    payloadVersion: number(RELEASE_HEADERS.payloadVersion),
    generationReady: ready === 'true' ? true : ready === 'false' ? false : null,
  };
}

function exactReleaseResponseMatches(payload, responseRelease, expectedRelease) {
  if (!expectedRelease) return true;
  const { generationReady, ...headerRelease } = responseRelease ?? {};
  return generationReady === true
    && releaseMetadataMatches(headerRelease, expectedRelease)
    && releaseMetadataMatches(payload?.sources?.release, expectedRelease);
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

async function requestJson(url, timeoutMs, fetchImpl, versionOverride) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  timeoutId.unref?.();

  try {
    const response = await fetchImpl(url, {
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        ...(versionOverride ? { [VERSION_OVERRIDE_HEADER]: versionOverride } : {}),
      },
      redirect: 'error',
      signal: controller.signal,
    });
    const workerVersionId = response.headers.get(WORKER_VERSION_HEADER)?.toLowerCase() ?? null;
    const release = responseReleaseHeaders(response.headers);

    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BODY_CHARS) {
      return { received: true, status: response.status, workerVersionId, release, reason: 'response too large' };
    }
    try {
      const body = await response.text();
      if (body.length > MAX_RESPONSE_BODY_CHARS) {
        return { received: true, status: response.status, workerVersionId, release, reason: 'response too large' };
      }
      return {
        received: true,
        status: response.status,
        workerVersionId,
        release,
        payload: JSON.parse(body),
        retryAfter: response.headers.get('retry-after'),
      };
    } catch {
      return { received: true, status: response.status, workerVersionId, release, reason: 'invalid JSON' };
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
  compatibleMinVersion,
  expectedLocation,
  expectedWorkerVersionId,
  expectedApiSchemaVersion,
  expectedRelease,
  versionOverride,
  requireTargetVersion,
  retryInitializing,
  attempts,
  timeoutMs,
  retryDelayMs,
  fetchImpl,
  logger,
}) {
  const targetLabel = expectedRelease
    ? `target release ${expectedRelease.dataGenerationId}`
    : `target payload v${expectedVersion}`;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    logger.info(`[warm] ${label}: attempt ${attempt}/${attempts}`);
    const result = await requestJson(url, timeoutMs, fetchImpl, versionOverride);

    // A versions deployment can reach the control plane before every edge sees
    // it, and an invalid override silently falls back to traffic percentages.
    // Payload shape cannot identify a same-schema release, so check the
    // runtime's immutable Cloudflare version ID before trusting any body.
    if (result.received && result.workerVersionId !== expectedWorkerVersionId) {
      if (attempt < attempts) {
        const received = result.workerVersionId ?? 'no version identity';
        logger.warn(`[warm] ${label}: expected Worker ${expectedWorkerVersionId}, received ${received}; retrying`);
        await delay(retryDelayMs * attempt);
        continue;
      }
      throw new WarmupError(
        `${label} failed: expected Worker version ${expectedWorkerVersionId} did not become active after ${attempts} attempts.`,
      );
    }

    if (result.received
      && result.status === 200
      && forecastPayloadMatches(
        result.payload,
        locationId,
        expectedVersion,
        expectedApiSchemaVersion,
        compatibleMinVersion,
        expectedLocation,
      )) {
      const payloadVersion = result.payload.sources.payloadVersion;
      const generationNeedsRebuild = result.payload.sources.cacheHealth?.needsRebuild === true
        || result.payload.sources.cacheHealth?.status === 'pending'
        || !exactReleaseResponseMatches(result.payload, result.release, expectedRelease);
      if (payloadVersion === expectedVersion && !generationNeedsRebuild) {
        logger.info(`[warm] ${label}: ${targetLabel} ready`);
        return 'target-ready';
      }

      if (payloadVersion === expectedVersion) {
        if (requireTargetVersion && attempt < attempts) {
          logger.warn(`[warm] ${label}: ${targetLabel} still needs a completed rebuild; retrying`);
          await delay(retryDelayMs * attempt);
          continue;
        }
        logger.warn(`[warm] ${label}: ${targetLabel} still needs a completed rebuild`);
        return 'generation-not-ready';
      }

      // A validated N-1 response is useful evidence that the candidate can
      // preserve availability. It is deliberately a DIFFERENT result from
      // target readiness: promoting a model/schema release while every route
      // is merely showing its legacy bridge recreated the v7 cold-cache
      // incident in slower motion.
      if (requireTargetVersion && attempt < attempts) {
        logger.warn(
          `[warm] ${label}: compatible payload v${payloadVersion} is available, `
          + `but target v${expectedVersion} is not ready; retrying`,
        );
        await delay(retryDelayMs * attempt);
        continue;
      }
      logger.warn(
        `[warm] ${label}: compatible payload v${payloadVersion} is available; `
        + `target v${expectedVersion} is not ready`,
      );
      return 'compatible-fallback';
    }

    if (result.received
      && result.status === 503
      && initializingPayloadMatches(result.payload, locationId, result.retryAfter)) {
      if (retryInitializing && attempt < attempts) {
        logger.warn(`[warm] ${label}: exact cache not visible to ordinary traffic yet; retrying`);
        await delay(retryDelayMs * attempt);
        continue;
      }
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

async function requirePriorApiForecastStage({
  url,
  locationId,
  expectedLocation,
  release,
  expectedWorkerVersionId,
  versionOverride,
  attempts,
  timeoutMs,
  retryDelayMs,
  fetchImpl,
  logger,
}) {
  const label = `compatibility API v${release.apiSchemaVersion} forecast ${locationId}`;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    logger.info(`[warm] ${label}: read-only attempt ${attempt}/${attempts}`);
    const result = await requestJson(url, timeoutMs, fetchImpl, versionOverride);

    if (result.received && result.workerVersionId !== expectedWorkerVersionId) {
      if (attempt < attempts) {
        logger.warn(
          `[warm] ${label}: expected Worker ${expectedWorkerVersionId}, `
          + `received ${result.workerVersionId ?? 'no version identity'}; retrying`,
        );
        await delay(retryDelayMs * attempt);
        continue;
      }
      throw new WarmupError(
        `${label} failed: expected Worker version ${expectedWorkerVersionId} `
        + `did not become active after ${attempts} attempts.`,
      );
    }

    if (result.received
      && result.status === 200
      && forecastPayloadMatches(
        result.payload,
        locationId,
        release.payloadVersion,
        release.payloadVersion,
        expectedLocation,
      )
      && exactReleaseResponseMatches(result.payload, result.release, release)) {
      logger.info(`[warm] ${label}: exact audited representation ready`);
      return;
    }

    // A prior API route is a read-only compatibility promise. A 404, typed
    // initialization, different descriptor, exhausted horizon, or malformed
    // body is deterministic release incompatibility—not provider readiness.
    if (result.received) {
      throw new WarmupError(
        `${label} failed: ${result.reason ?? `HTTP ${result.status} contract mismatch`}.`,
      );
    }
    if (attempt < attempts) {
      logger.warn(`[warm] ${label}: ${result.reason}; retrying`);
      await delay(retryDelayMs * attempt);
    }
  }
  throw new WarmupError(
    `${label} failed after ${attempts} ${attempts === 1 ? 'attempt' : 'attempts'}.`,
  );
}

function normalizeAuditedPriorApiReleases(value, currentRelease) {
  if (!Array.isArray(value)) {
    throw new WarmupError('Audited prior API release descriptors must be an array.');
  }
  if (value.length > 0 && !currentRelease) {
    throw new WarmupError('Current release metadata is required to verify prior APIs.');
  }
  const seen = new Set();
  const releases = [];
  for (const release of value) {
    if (!validReleaseMetadata(release)) {
      throw new WarmupError('An audited prior API release descriptor is invalid.');
    }
    if (release.apiSchemaVersion === currentRelease?.apiSchemaVersion
      || seen.has(release.apiSchemaVersion)) continue;
    seen.add(release.apiSchemaVersion);
    releases.push(release);
  }
  return releases;
}

function sameStringSet(left, right) {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.length === sortedRight.length
    && sortedLeft.every((value, index) => value === sortedRight[index]);
}

function assessHealth(
  result,
  locationIds,
  transientIds,
  expectedWorkerVersionId,
  expectedRelease,
  requireTargetReadyAll,
) {
  if (!result.received) return { kind: 'transport', reason: result.reason };
  if (result.workerVersionId !== expectedWorkerVersionId) {
    return {
      kind: 'identity',
      reason: `expected Worker ${expectedWorkerVersionId}, received ${result.workerVersionId ?? 'no version identity'}`,
    };
  }
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

  if (expectedRelease && !releaseMetadataMatches(result.release, expectedRelease)) {
    return { kind: 'hard', reason: 'health response release headers do not match the candidate contract' };
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

  let exactReadinessReason = null;
  if (requireTargetReadyAll && expectedRelease) {
    const release = payload.release;
    const releaseLists = release && typeof release === 'object'
      ? [release.ready, release.available, release.fallback, release.missing]
      : [];
    const releaseListsValid = releaseLists.length === 4
      && releaseLists.every((list) => Array.isArray(list)
        && list.every((id) => typeof id === 'string' && locationIds.includes(id))
        && new Set(list).size === list.length);
    if (!releaseListsValid
      || typeof release.allLocationsReady !== 'boolean'
      || !releaseMetadataMatches(release.target, expectedRelease)) {
      return { kind: 'hard', reason: 'target release health contract is malformed' };
    }

    const availabilityStateValid = entries.every((entry) => {
      if (typeof entry.exactGenerationReady !== 'boolean'
        || typeof entry.availabilitySource !== 'string') return false;
      if (entry.exactGenerationReady) {
        return entry.hasCache && entry.availabilitySource === 'generation';
      }
      if (!entry.hasCache) return entry.availabilitySource === 'none';
      return /^generation:[A-Za-z0-9._:-]+$/.test(entry.availabilitySource);
    });
    if (!availabilityStateValid) {
      return { kind: 'hard', reason: 'target release location readiness is malformed' };
    }

    const exactReady = entries
      .filter((entry) => entry.exactGenerationReady)
      .map((entry) => entry.id);
    const available = entries.filter((entry) => entry.hasCache).map((entry) => entry.id);
    const fallback = entries
      .filter((entry) => entry.hasCache && !entry.exactGenerationReady)
      .map((entry) => entry.id);
    const allLocationsReady = exactReady.length === locationIds.length;
    if (!sameStringSet(release.ready, exactReady)
      || !sameStringSet(release.available, available)
      || !sameStringSet(release.fallback, fallback)
      || !sameStringSet(release.missing, missing)
      || release.allLocationsReady !== allLocationsReady) {
      return { kind: 'hard', reason: 'target release readiness lists contradict location health' };
    }
    if (!allLocationsReady) {
      const notReady = locationIds.filter((id) => !exactReady.includes(id));
      exactReadinessReason = `exact target generation not visible yet: ${notReady.join(', ')}`;
    }
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

  if (exactReadinessReason) {
    return { kind: 'propagation', reason: exactReadinessReason };
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
  expectedWorkerVersionId,
  expectedRelease,
  requireTargetReadyAll,
  versionOverride,
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
  let propagationKind = 'cache';

  while (true) {
    if (propagationReason && Date.now() >= deadlineAt) {
      throw new WarmupError(`health failed after ${propagationKind} propagation window: ${propagationReason}.`);
    }
    logger.info('[warm] health: checking');
    const remainingMs = Math.max(1, deadlineAt - Date.now());
    const result = await requestJson(
      url,
      Math.min(timeoutMs, remainingMs),
      fetchImpl,
      versionOverride,
    );
    const assessment = assessHealth(
      result,
      locationIds,
      transientIds,
      expectedWorkerVersionId,
      expectedRelease,
      requireTargetReadyAll,
    );

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
    if (assessment.kind === 'identity') {
      if (Date.now() >= deadlineAt) {
        throw new WarmupError(`health failed after Worker version propagation window: ${assessment.reason}.`);
      }
      propagationReason = assessment.reason;
      propagationKind = 'Worker version';
      logger.warn(`[warm] health: ${assessment.reason}; waiting for Worker version propagation`);
      await delay(Math.min(propagationRetryDelayMs, Math.max(1, deadlineAt - Date.now())));
      continue;
    }
    if (assessment.kind === 'transport') {
      if (propagationReason) {
        logger.warn(`[warm] health: ${assessment.reason}; waiting for ${propagationKind} propagation`);
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
    propagationKind = 'cache';
    logger.warn(`[warm] health: ${assessment.reason}; waiting for KV propagation`);
    await delay(Math.min(propagationRetryDelayMs, Math.max(1, deadlineAt - Date.now())));
  }
}

export async function warmWorker({
  baseUrl,
  locationIds,
  expectedVersion,
  compatibleMinVersion,
  locationContracts = [],
  expectedWorkerVersionId,
  expectedApiSchemaVersion,
  expectedRelease,
  auditedPriorApiReleases = [],
  workerName: targetWorkerName,
  requireTargetReadyAll = false,
  readOnly = false,
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
  const minimumCompatibleVersion = requireCompatibleVersionFloor(
    version,
    compatibleMinVersion,
  );
  const expectedWorkerId = workerVersionId(expectedWorkerVersionId, 'Expected Worker version ID');
  const apiSchemaVersion = expectedRelease?.apiSchemaVersion
    ?? positiveInteger(expectedApiSchemaVersion, 'Expected API schema version');
  if (expectedRelease && expectedApiSchemaVersion !== undefined
    && positiveInteger(expectedApiSchemaVersion, 'Expected API schema version') !== apiSchemaVersion) {
    throw new WarmupError('Expected API schema version contradicts the release descriptor.');
  }
  const targetWorker = workerName(targetWorkerName);
  const versionOverride = targetWorker ? `${targetWorker}="${expectedWorkerId}"` : null;
  if (typeof requireTargetReadyAll !== 'boolean') {
    throw new WarmupError('Target-readiness policy must be a boolean.');
  }
  if (typeof readOnly !== 'boolean') {
    throw new WarmupError('Read-only forecast policy must be a boolean.');
  }
  if (expectedRelease !== undefined && !validReleaseMetadata(expectedRelease)) {
    throw new WarmupError('Expected release metadata is invalid.');
  }
  const priorApiReleases = normalizeAuditedPriorApiReleases(
    auditedPriorApiReleases,
    expectedRelease,
  );

  if (!Array.isArray(locationIds) || locationIds.length === 0) {
    throw new WarmupError('At least one location is required.');
  }
  if (!Array.isArray(locationContracts)) {
    throw new WarmupError('Location release contracts must be an array.');
  }
  const locationContractById = new Map(locationContracts.map((location) => [location?.id, location]));

  // Keep these requests sequential. The pre-promotion candidate uses `warm=1`
  // to build an empty target generation; the post-promotion smoke deliberately
  // omits it and only proves ordinary cached reads. A typed transient becomes
  // terminal amber for a warming request, so a struggling upstream is never
  // hammered by the release gate.
  const transientIds = [];
  const availableIds = [];
  const targetReadyIds = [];
  const compatibleFallbackIds = [];
  const generationNotReadyIds = [];
  for (const locationId of locationIds) {
    if (typeof locationId !== 'string' || !/^[a-z0-9-]+$/.test(locationId)) {
      throw new WarmupError('A location id is invalid.');
    }

    const forecastPath = `api/v${apiSchemaVersion}/forecast/${encodeURIComponent(locationId)}`;
    const url = new URL(forecastPath, base);
    if (!readOnly) url.searchParams.set('warm', '1');
    const result = await requireForecastStage({
      label: `forecast ${locationId}`,
      url,
      locationId,
      expectedVersion: version,
      compatibleMinVersion: minimumCompatibleVersion,
      expectedLocation: locationContractById.get(locationId),
      expectedWorkerVersionId: expectedWorkerId,
      expectedApiSchemaVersion: apiSchemaVersion,
      expectedRelease,
      versionOverride,
      requireTargetVersion: requireTargetReadyAll,
      retryInitializing: readOnly && requireTargetReadyAll,
      attempts: boundedAttempts,
      timeoutMs: boundedTimeoutMs,
      retryDelayMs: boundedRetryDelayMs,
      fetchImpl,
      logger,
    });
    if (result === 'initializing') transientIds.push(locationId);
    if (result === 'target-ready') {
      availableIds.push(locationId);
      targetReadyIds.push(locationId);
    }
    if (result === 'compatible-fallback') {
      availableIds.push(locationId);
      compatibleFallbackIds.push(locationId);
    }
    if (result === 'generation-not-ready') {
      availableIds.push(locationId);
      generationNotReadyIds.push(locationId);
    }
  }

  // Partial availability requires at least one real 200 forecast response.
  // A typed 503 initialization response is safe and honest, but it is not an
  // available location and must never be enough to promote a release.
  if (availableIds.length === 0) {
    throw new WarmupError(
      'release has no ready forecast locations; refusing a zero-availability production release.',
    );
  }

  if (requireTargetReadyAll && targetReadyIds.length !== locationIds.length) {
    const notReady = locationIds.filter((id) => !targetReadyIds.includes(id));
    const targetLabel = expectedRelease
      ? `target release ${expectedRelease.dataGenerationId}`
      : `target payload v${version}`;
    throw new WarmupError(
      `${targetLabel} is not ready for every public location: ${notReady.join(', ')}. `
      + 'Legacy fallback and initialization never authorize production promotion.',
    );
  }

  const verifiedPriorApiSchemaVersions = [];
  if (requireTargetReadyAll) {
    for (const priorRelease of priorApiReleases) {
      for (const locationId of locationIds) {
        const url = new URL(
          `api/v${priorRelease.apiSchemaVersion}/forecast/${encodeURIComponent(locationId)}`,
          base,
        );
        await requirePriorApiForecastStage({
          url,
          locationId,
          expectedLocation: locationContractById.get(locationId),
          release: priorRelease,
          expectedWorkerVersionId: expectedWorkerId,
          versionOverride,
          attempts: boundedAttempts,
          timeoutMs: boundedTimeoutMs,
          retryDelayMs: boundedRetryDelayMs,
          fetchImpl,
          logger,
        });
      }
      verifiedPriorApiSchemaVersions.push(priorRelease.apiSchemaVersion);
    }
  }

  const health = await requireHealthStage({
    url: new URL('health', base),
    locationIds,
    transientIds,
    expectedWorkerVersionId: expectedWorkerId,
    expectedRelease,
    requireTargetReadyAll,
    versionOverride,
    attempts: boundedAttempts,
    timeoutMs: boundedTimeoutMs,
    retryDelayMs: boundedRetryDelayMs,
    propagationTimeoutMs: boundedPropagationTimeoutMs,
    propagationRetryDelayMs: boundedPropagationRetryDelayMs,
    fetchImpl,
    logger,
  });

  if (requireTargetReadyAll && health.staleDataReady.length > 0) {
    throw new WarmupError(
      `target release still has stale forecast data: ${health.staleDataReady.join(', ')}.`,
    );
  }

  if (transientIds.length > 0) {
    logger.warn(
      `[warm] AMBER: transient initialization observed for ${transientIds.join(', ')}; `
      + `${health.missing.length ? `still initializing: ${health.missing.join(', ')}` : 'all recovered before final health'}`,
    );
  }
  logger.info(`[warm] release gate passed for ${locationIds.length} locations`);
  return {
    availableLocationIds: availableIds,
    targetReadyLocationIds: targetReadyIds,
    compatibleFallbackLocationIds: compatibleFallbackIds,
    generationNotReadyLocationIds: generationNotReadyIds,
    verifiedPriorApiSchemaVersions,
    initializingLocationIds: health.missing,
    transientLocationIds: transientIds,
    staleDataLocationIds: health.staleDataReady,
  };
}

function parseArguments(argv) {
  const values = {};
  let requireTargetReadyAll = false;
  let readOnly = false;
  const known = new Set([
    '--base-url',
    '--expected-version',
    '--compatible-min-version',
    '--expected-worker-version-id',
    '--worker-name',
    '--attempts',
    '--timeout-ms',
    '--retry-delay-ms',
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') return { help: true };
    if (argument === '--require-target-ready-all') {
      requireTargetReadyAll = true;
      continue;
    }
    if (argument === '--read-only') {
      readOnly = true;
      continue;
    }
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
    compatibleMinVersion: values['--compatible-min-version'],
    expectedWorkerVersionId: values['--expected-worker-version-id'],
    workerName: values['--worker-name'],
    attempts: values['--attempts'],
    timeoutMs: values['--timeout-ms'],
    retryDelayMs: values['--retry-delay-ms'],
    requireTargetReadyAll,
    readOnly,
  };
}

function printHelp() {
  console.log(`Usage: npm run worker:warm -- --base-url <url> [options]

Options:
  --expected-version <n>  Override the checked-in payload version
  --compatible-min-version <n>
                          Audited oldest payload accepted by the release gate
  --expected-worker-version-id <uuid>
                          Exact Cloudflare version that must answer every stage
  --worker-name <name>    Route every request to that 0% version via Cloudflare's
                          version-override header (omit after 100% promotion)
  --require-target-ready-all
                          Require exact release metadata and fresh health for every
                          public location; legacy fallback never passes
  --read-only             Never append warm=1; prove ordinary cached traffic without
                          triggering provider work
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
  const compatibleMinVersion = options.compatibleMinVersion === undefined
    ? compatibleForecastVersionFloor(expectedVersion)
    : positiveInteger(options.compatibleMinVersion, 'Compatible minimum payload version');
  const expectedWorkerVersionId = options.expectedWorkerVersionId
    ?? environment.FRANK_EXPECTED_WORKER_VERSION_ID;
  const targetWorkerName = options.workerName ?? environment.FRANK_WORKER_NAME;

  await warmWorker({
    baseUrl: options.baseUrl ?? environment.FRANK_WORKER_BASE_URL,
    locationIds: contract.locationIds,
    locationContracts: contract.locations,
    expectedVersion,
    expectedRelease: contract.release,
    auditedPriorApiReleases: contract.auditedPriorApiReleases,
    compatibleMinVersion,
    expectedWorkerVersionId,
    workerName: targetWorkerName,
    requireTargetReadyAll: options.requireTargetReadyAll,
    readOnly: options.readOnly,
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
