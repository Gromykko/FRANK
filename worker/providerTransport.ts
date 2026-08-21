import {
  assertBeforeProviderDeadline,
  delayWithinDeadline,
  executionPolicy,
  fetchWithTimeout,
} from './execution';
import type { ExecutionPolicy } from './execution';
import type {
  BusyProvider,
  EventMemo,
  MarineBusyCircuit,
} from './domain';
import {
  ProviderUnavailableError,
  isProviderUnavailableError,
  transientProviderError,
} from './providerAvailability';
import { errorWithStatus, isRecord } from './validation';

const RETRY_BASE_DELAY_MS = 1_500;
const RETRY_BUSY_DELAY_MS = 3_000;
const MARINE_BUSY_CIRCUIT_KEY = 'provider-circuit:marine-busy';
export const MARINE_BUSY_DEFAULT_RETRY_SECONDS = 10 * 60;

function isTestEnvironment(): boolean {
  const nodeProcess = (globalThis as { process?: { env?: Record<string, string> } }).process;
  return typeof nodeProcess === 'object' && nodeProcess !== null && nodeProcess.env?.NODE_ENV === 'test';
}

function retryDelay(attempt: number, isBusy = false, policy?: ExecutionPolicy): number {
  if (isBusy) {
    if (policy?.retryBusyDelayMs !== undefined) return policy.retryBusyDelayMs;
    if (policy?.retryDelayMs !== undefined) return policy.retryDelayMs;
    if (isTestEnvironment()) return 1;
    return RETRY_BUSY_DELAY_MS + Math.floor(Math.random() * 500);
  }
  if (policy?.retryDelayMs !== undefined) {
    return policy.retryDelayMs;
  }
  if (isTestEnvironment()) return 1;
  return RETRY_BASE_DELAY_MS * 2 ** attempt + Math.floor(Math.random() * 500);
}

function isMarineBusyCircuit(value: unknown): value is MarineBusyCircuit {
  return isRecord(value)
    && value.status === 'open'
    && value.provider === 'marine'
    && value.busy === true
    && typeof value.retryAfterSeconds === 'number'
    && Number.isFinite(value.retryAfterSeconds)
    && value.retryAfterSeconds > 0;
}

export async function readMarineBusyCircuit(
  eventMemo?: EventMemo,
): Promise<MarineBusyCircuit | null> {
  const stored = eventMemo?.get(MARINE_BUSY_CIRCUIT_KEY);
  if (!stored) return null;
  const value = await stored;
  if (!isMarineBusyCircuit(value)) {
    throw new Error('Marine provider circuit state is invalid.');
  }
  return value;
}

export function openMarineBusyCircuit(
  eventMemo: EventMemo | undefined,
  error: ProviderUnavailableError,
): void {
  if (!eventMemo || error.provider !== 'marine' || !error.busy
    || eventMemo.has(MARINE_BUSY_CIRCUIT_KEY)) return;
  const advertisedRetrySeconds = error.retryAfterSeconds;
  const retryAfterSeconds = typeof advertisedRetrySeconds === 'number'
    && Number.isFinite(advertisedRetrySeconds)
    && advertisedRetrySeconds > 0
    ? Math.ceil(advertisedRetrySeconds)
    : MARINE_BUSY_DEFAULT_RETRY_SECONDS;
  eventMemo.set(MARINE_BUSY_CIRCUIT_KEY, Promise.resolve({
    status: 'open',
    provider: 'marine',
    busy: true,
    retryAfterSeconds,
  } satisfies MarineBusyCircuit));
}

function retryAfterSeconds(response: Response): number | undefined {
  // Tests and edge mocks may provide the minimum Response-shaped object.
  const value = response.headers?.get?.('Retry-After');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1, Math.ceil(seconds));
  const atMs = Date.parse(value);
  if (!Number.isFinite(atMs)) return undefined;
  return Math.max(1, Math.ceil((atMs - Date.now()) / 1000));
}

function marineCircuitError(circuit: MarineBusyCircuit): ProviderUnavailableError {
  return new ProviderUnavailableError(
    'marine',
    'DMI marine service is busy; this refresh cycle has deferred further calls.',
    undefined,
    true,
    circuit.retryAfterSeconds,
  );
}

// Structured provider diagnostics belong to transport, never forecast-model
// identity. They are visible in Workers Logs but not copied into public data.
export function logUpstream(
  source: string,
  startedAt: number,
  outcome: string,
  extra = '',
): void {
  const ms = Date.now() - startedAt;
  console.log(`upstream ${source} ${outcome} ${ms}ms${extra ? ' ' + extra : ''}`);
}

export async function fetchJsonWithRetries(
  url: string,
  label: string,
  policy: ExecutionPolicy = executionPolicy(),
  provider: BusyProvider = 'services',
  eventMemo?: EventMemo,
): Promise<unknown> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < policy.maxAttempts; attempt++) {
    // A sibling request can open the event circuit during an in-flight call or
    // backoff. Recheck immediately before every network attempt.
    if (provider === 'marine') {
      const circuit = await readMarineBusyCircuit(eventMemo);
      if (circuit) throw marineCircuitError(circuit);
    }
    assertBeforeProviderDeadline(policy, `${label} attempt ${attempt + 1}`);
    const startedAt = Date.now();
    let response: Response;
    try {
      response = await fetchWithTimeout(url, {
        headers: {
          Accept: 'application/geo+json, application/json',
        },
      }, policy);
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      lastError = transientProviderError(
        normalized,
        provider,
        `${label} is temporarily unavailable.`,
      ) ?? normalized;
      logUpstream(
        label,
        startedAt,
        normalized.name === 'TimeoutError' ? 'timeout' : 'error',
        String(normalized.message ?? '').slice(0, 120),
      );
      if (attempt < policy.maxAttempts - 1) {
        await delayWithinDeadline(retryDelay(attempt, false, policy), policy, `${label} retry`);
      }
      continue;
    }

    try {
      if (response.ok) {
        const json = await response.json();
        logUpstream(label, startedAt, 'ok');
        return json;
      }

      logUpstream(label, startedAt, `http-${response.status}`);
      const statusError = errorWithStatus(
        `${label} failed with HTTP ${response.status}`,
        response.status,
      );
      lastError = transientProviderError(
        statusError,
        provider,
        `${label} is temporarily unavailable.`,
        response.status === 429
          ? retryAfterSeconds(response) ?? MARINE_BUSY_DEFAULT_RETRY_SECONDS
          : undefined,
      ) ?? statusError;
      if (isProviderUnavailableError(lastError) && url.endsWith('/instances')) {
        openMarineBusyCircuit(eventMemo, lastError);
      }
      let providerMessage = '';
      try {
        providerMessage = (await response.text()).slice(0, 180);
      } catch {
        // Diagnostics are best-effort; the reached status owns classification.
      }
      if (providerMessage) {
        console.warn({
          event: 'upstream_http_error',
          source: label,
          status: response.status,
          providerMessage,
        });
      }
      // Non-429 4xx responses (e.g. 400, 404) are terminal.
      // 429 responses retry with a 3-second backoff within the execution policy deadline.
      if (response.status !== 429 && response.status < 500) break;
    } catch (error) {
      // A reached 2xx response that cannot be parsed is a hard contract failure.
      lastError = error instanceof Error ? error : new Error(String(error));
      logUpstream(
        label,
        startedAt,
        'invalid-response',
        String(lastError.message ?? '').slice(0, 120),
      );
    }

    if (attempt < policy.maxAttempts - 1) {
      const isBusy = response?.status === 429;
      await delayWithinDeadline(retryDelay(attempt, isBusy, policy), policy, `${label} retry`);
    }
  }

  if (!lastError) throw new Error(`${label} failed`);
  throw lastError;
}
