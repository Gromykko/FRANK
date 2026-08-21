import {
  assertBeforeProviderDeadline,
  deadlineError,
  delayWithinDeadline,
  executionPolicy,
  fetchWithTimeout,
  remainingProviderMs,
} from './execution';
import type { ExecutionPolicy } from './execution';
import type {
  BusyProvider,
  EventMemo,
  MarineBusyCircuit,
} from './domain';
import { transientProviderError } from './providerAvailability';
import { errorWithStatus } from './validation';

const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_BUSY_DELAY_MS = 1_200;
const RETRY_BUSY_JITTER_MS = 600;
export const MARINE_BUSY_DEFAULT_RETRY_SECONDS = 10 * 60;

function isTestEnvironment(): boolean {
  const g = globalThis as {
    process?: { env?: Record<string, string> };
    __vitest_worker__?: unknown;
    __vitest_environment__?: unknown;
    VITEST?: unknown;
  };
  return Boolean(
    g.__vitest_worker__
    || g.__vitest_environment__
    || g.VITEST
    || (typeof g.process === 'object' && g.process !== null && (g.process.env?.NODE_ENV === 'test' || g.process.env?.VITEST === 'true'))
  );
}

function retryDelay(attempt: number, isBusy = false, policy?: ExecutionPolicy): number {
  if (isBusy && policy?.retryBusyDelayMs !== undefined) {
    return policy.retryBusyDelayMs;
  }
  if (policy?.retryDelayMs !== undefined) {
    return policy.retryDelayMs;
  }
  if (isTestEnvironment()) return 1;
  if (isBusy) {
    return RETRY_BUSY_DELAY_MS + Math.floor(Math.random() * RETRY_BUSY_JITTER_MS);
  }
  return RETRY_BASE_DELAY_MS * 2 ** Math.min(attempt, 4) + Math.floor(Math.random() * 500);
}

export function logUpstream(
  source: string,
  startedAt: number,
  outcome: string,
  extra = '',
): void {
  const ms = Date.now() - startedAt;
  console.log(`upstream ${source} ${outcome} ${ms}ms${extra ? ' ' + extra : ''}`);
}

export async function readMarineBusyCircuit(
  eventMemo?: EventMemo,
): Promise<MarineBusyCircuit | null> {
  void eventMemo;
  return null;
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

export async function fetchJsonWithRetries(
  url: string,
  label: string,
  policy: ExecutionPolicy = executionPolicy(),
  provider: BusyProvider = 'services',
  eventMemo?: EventMemo,
): Promise<unknown> {
  void eventMemo;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < policy.maxAttempts; attempt++) {
    if (remainingProviderMs(policy) <= 0) {
      if (lastError) throw lastError;
      throw deadlineError(`${label} attempt ${attempt + 1} (completion reserve reached)`, 'provider');
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
        try {
          await delayWithinDeadline(retryDelay(attempt, false, policy), policy, `${label} retry`);
        } catch (delayErr) {
          if (lastError) throw lastError;
          throw delayErr;
        }
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
      // 429 and 5xx responses retry within the execution policy budget and deadline.
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
      try {
        await delayWithinDeadline(retryDelay(attempt, isBusy, policy), policy, `${label} retry`);
      } catch (delayErr) {
        if (lastError) throw lastError;
        throw delayErr;
      }
    }
  }

  if (!lastError) throw new Error(`${label} failed`);
  throw lastError;
}
