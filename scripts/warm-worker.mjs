import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const WARM_LOCATION_IDS = Object.freeze([
  'horsens',
  'vejle',
  'kolding',
  'aarhus',
]);

// The authenticated Worker route applies a 90-second provider cooldown. This
// window still fits six worst-case serial passes across all four locations.
export const DEFAULT_WARM_TOTAL_TIMEOUT_MS = 13 * 60_000;
export const DEFAULT_WARM_REQUEST_TIMEOUT_MS = 30_000;
export const WARM_LOCATION_STAGGER_MS = 1_000;

function sleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function requireSetting(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`[worker-warm] Required repository setting ${name} is missing.`);
  }
  return value.trim();
}

function normalizedBaseUrl(value) {
  const raw = requireSetting(value, 'FRANK_WORKER_BASE_URL');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('[worker-warm] FRANK_WORKER_BASE_URL must be a valid URL.');
  }
  if (url.protocol !== 'https:') {
    throw new Error('[worker-warm] FRANK_WORKER_BASE_URL must use https.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('[worker-warm] FRANK_WORKER_BASE_URL must not contain credentials, a query, or a fragment.');
  }
  return raw.replace(/\/+$/, '');
}

function positiveDuration(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`[worker-warm] ${name} must be a positive integer.`);
  }
  return value;
}

function retryAfterMs(value, nowMs) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isSafeInteger(seconds) ? Math.max(1_000, seconds * 1_000) : null;
  }
  const retryAt = Date.parse(trimmed);
  return Number.isFinite(retryAt) ? Math.max(1_000, retryAt - nowMs) : null;
}

async function requestLocation({
  baseUrl,
  token,
  locationId,
  fetchImpl,
  now,
  deadlineAt,
  requestTimeoutMs,
  logger,
}) {
  const remainingMs = deadlineAt - now();
  if (remainingMs <= 0) return { ready: false, retryInMs: Number.POSITIVE_INFINITY };

  const url = `${baseUrl}/api/v2/forecast/${encodeURIComponent(locationId)}?warm=1`;
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(Math.max(1, Math.min(requestTimeoutMs, remainingMs))),
      redirect: 'error',
    });
  } catch {
    throw new Error(`[worker-warm] ${locationId}: request failed.`);
  }

  if (response.status === 200) {
    logger.info(`[worker-warm] ${locationId}: ready (200).`);
    return { ready: true, retryInMs: 0 };
  }

  if (response.status === 404) {
    throw new Error(
      `[worker-warm] ${locationId}: received 404; verify the FRANK_WARM_TOKEN repository secret.`,
    );
  }

  if (response.status !== 503) {
    throw new Error(`[worker-warm] ${locationId}: unexpected HTTP ${response.status}.`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`[worker-warm] ${locationId}: HTTP 503 response was not valid JSON.`);
  }
  if (payload === null || typeof payload !== 'object' || payload.code !== 'FORECAST_INITIALIZING') {
    throw new Error(
      `[worker-warm] ${locationId}: HTTP 503 did not contain FORECAST_INITIALIZING.`,
    );
  }

  const retryInMs = retryAfterMs(response.headers.get('Retry-After'), now());
  if (retryInMs === null) {
    throw new Error(`[worker-warm] ${locationId}: retryable 503 had no valid Retry-After header.`);
  }
  logger.info(`[worker-warm] ${locationId}: initializing; retrying in ${Math.ceil(retryInMs / 1_000)}s.`);
  return { ready: false, retryInMs };
}

function deadlineError(locationIds) {
  return new Error(
    `[worker-warm] Warm-up deadline cannot be met; locations not ready: ${locationIds.join(', ')}.`,
  );
}

export async function warmWorkerLocations({
  baseUrl,
  token,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  sleepImpl = sleep,
  logger = console,
  totalTimeoutMs = DEFAULT_WARM_TOTAL_TIMEOUT_MS,
  requestTimeoutMs = DEFAULT_WARM_REQUEST_TIMEOUT_MS,
} = {}) {
  const resolvedBaseUrl = normalizedBaseUrl(baseUrl);
  const resolvedToken = requireSetting(token, 'FRANK_WARM_TOKEN');
  positiveDuration(totalTimeoutMs, 'totalTimeoutMs');
  positiveDuration(requestTimeoutMs, 'requestTimeoutMs');
  if (typeof fetchImpl !== 'function' || typeof now !== 'function' || typeof sleepImpl !== 'function') {
    throw new Error('[worker-warm] Invalid warm-up runtime adapter.');
  }

  const deadlineAt = now() + totalTimeoutMs;
  const pending = new Map(WARM_LOCATION_IDS.map((locationId) => [locationId, now()]));
  const attemptedLocations = new Set();
  let lastRequestStartedAt = Number.NEGATIVE_INFINITY;

  while (pending.size > 0) {
    const currentTime = now();
    if (currentTime >= deadlineAt) throw deadlineError([...pending.keys()]);

    const dueLocations = [...pending.entries()]
      .filter(([, retryAt]) => retryAt <= currentTime)
      .map(([locationId]) => locationId);

    if (dueLocations.length === 0) {
      const nextRetryAt = Math.min(...pending.values());
      await sleepImpl(Math.min(nextRetryAt - currentTime, deadlineAt - currentTime));
      continue;
    }

    const locationId = dueLocations.find((id) => !attemptedLocations.has(id))
      ?? dueLocations[0];
    const nextRequestAt = lastRequestStartedAt + WARM_LOCATION_STAGGER_MS;
    if (currentTime < nextRequestAt) {
      await sleepImpl(Math.min(nextRequestAt - currentTime, deadlineAt - currentTime));
      continue;
    }

    attemptedLocations.add(locationId);
    lastRequestStartedAt = currentTime;
    const result = await requestLocation({
      baseUrl: resolvedBaseUrl,
      token: resolvedToken,
      locationId,
      fetchImpl,
      now,
      deadlineAt,
      requestTimeoutMs,
      logger,
    });
    if (result.ready) {
      pending.delete(locationId);
    } else {
      pending.set(locationId, now() + result.retryInMs);
    }

    if (pending.size > 0 && Math.min(...pending.values()) >= deadlineAt) {
      throw deadlineError([...pending.keys()]);
    }
  }

  logger.info('[worker-warm] All four forecast locations are ready.');
}

async function runCli() {
  await warmWorkerLocations({
    baseUrl: process.env.FRANK_WORKER_BASE_URL,
    token: process.env.FRANK_WARM_TOKEN,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : '[worker-warm] Unexpected warm-up failure.');
    process.exitCode = 1;
  });
}
