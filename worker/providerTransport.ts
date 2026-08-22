import {
  assertBeforeProviderDeadline,
  deadlineError,
  delayWithinDeadline,
  executionPolicy,
  fetchWithTimeout,
  isExternalSubrequestBudgetError,
  remainingProviderMs,
} from './execution';
import type { ExecutionPolicy } from './execution';
import type {
  BusyProvider,
  EventMemo,
  MarineBusyCircuit,
} from './domain';
import {
  ProviderUnavailableError,
  transientProviderError,
} from './providerAvailability';
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

// The longest we will sit on a provider's Retry-After inside a single
// invocation. Beyond this, deferring to the next scheduled tick is strictly
// better than holding the tick open.
const MAX_IN_TICK_RETRY_WAIT_MS = 10_000;
const MARINE_BUSY_CIRCUIT_KEY = 'provider-circuit:marine-busy';

function isMarineBusyCircuit(value: unknown): value is MarineBusyCircuit {
  return typeof value === 'object'
    && value !== null
    && 'status' in value
    && value.status === 'open'
    && 'provider' in value
    && value.provider === 'marine'
    && 'busy' in value
    && value.busy === true
    && 'retryAfterSeconds' in value
    && typeof value.retryAfterSeconds === 'number'
    && Number.isFinite(value.retryAfterSeconds)
    && value.retryAfterSeconds > 0;
}

async function readMarineBusyCircuit(
  eventMemo: EventMemo | undefined,
): Promise<MarineBusyCircuit | null> {
  const memo = eventMemo?.get(MARINE_BUSY_CIRCUIT_KEY);
  if (!memo) return null;
  const value = await memo;
  return isMarineBusyCircuit(value) ? value : null;
}

function openMarineBusyCircuit(
  eventMemo: EventMemo,
  retryAfterSeconds: number,
): void {
  const previous = eventMemo.get(MARINE_BUSY_CIRCUIT_KEY);
  const next = (previous ?? Promise.resolve(null)).then((value) => ({
    status: 'open' as const,
    provider: 'marine' as const,
    busy: true as const,
    retryAfterSeconds: Math.max(
      isMarineBusyCircuit(value) ? value.retryAfterSeconds : 0,
      retryAfterSeconds,
    ),
  } satisfies MarineBusyCircuit));
  eventMemo.set(MARINE_BUSY_CIRCUIT_KEY, next);
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
  let lastError: Error | undefined;
  let serverRetryAfterMs: number | undefined;

  for (let attempt = 0; attempt < policy.maxAttempts; attempt++) {
    if (provider === 'marine') {
      const circuit = await readMarineBusyCircuit(eventMemo);
      if (circuit) {
        throw new ProviderUnavailableError(
          'marine',
          'DMI is busy; further calls were deferred for this Worker event.',
          undefined,
          true,
          circuit.retryAfterSeconds,
        );
      }
    }
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
      }, policy, eventMemo);
    } catch (error) {
      if (isExternalSubrequestBudgetError(error)) throw error;
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
      // Only an EXPLICIT header spaces our own retries. The default below is
      // what we tell the browser to do when the provider gives no guidance;
      // borrowing it as an in-tick delay would spend the whole location budget
      // sleeping on a 429 that carried no instruction at all.
      const headerRetrySeconds = response.status === 429
        ? retryAfterSeconds(response)
        : undefined;
      serverRetryAfterMs = headerRetrySeconds === undefined
        ? undefined
        : headerRetrySeconds * 1000;
      const askedToWaitSeconds = response.status === 429
        ? headerRetrySeconds ?? MARINE_BUSY_DEFAULT_RETRY_SECONDS
        : undefined;
      lastError = transientProviderError(
        statusError,
        provider,
        `${label} is temporarily unavailable.`,
        askedToWaitSeconds,
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
      // DMI documents one host-wide fair-use limit. Once either of the two
      // already-parallel marine legs receives 429, do not let retries or later
      // locations in this same event re-earn the refusal. The response body is
      // consumed above before the circuit opens.
      if (response.status === 429
        && provider === 'marine'
        && eventMemo
        && lastError) {
        openMarineBusyCircuit(
          eventMemo,
          lastError instanceof ProviderUnavailableError
            ? lastError.retryAfterSeconds ?? MARINE_BUSY_DEFAULT_RETRY_SECONDS
            : MARINE_BUSY_DEFAULT_RETRY_SECONDS,
        );
        break;
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
      // Retrying a syntactically invalid success body only repeats a provider
      // contract violation and spends subrequests/CPU. Network and HTTP
      // failures are handled by the retry paths above; a reached 2xx that
      // cannot produce JSON is terminal for this stage.
      if (response.ok) break;
    }

    if (attempt < policy.maxAttempts - 1) {
      const isBusy = response?.status === 429;
      // Honour what the provider actually asked for. We already parse
      // Retry-After, attach it to the error and forward it to the browser - and
      // then ignored it here, retrying on our own ~1.5s backoff. That told the
      // client to wait ten minutes while hammering DMI another thirty times
      // inside the same tick, which is what pushed a bad DMI day past
      // Cloudflare's 50-subrequest ceiling. "Too many subrequests" is not
      // classified as transient, so it killed the whole invocation - the
      // remaining cities and the heartbeat with it.
      //
      // A wait longer than our budget correctly ENDS the retries instead of
      // sleeping past the deadline: delayWithinDeadline throws and the catch
      // below rethrows the typed provider error, so the held run still serves.
      const backoffMs = retryDelay(attempt, isBusy, policy);
      // Asked to wait longer than it is worth waiting inside one invocation:
      // stop, rather than sleep it out and retry anyway. Two ceilings apply -
      // whatever this tick has left, and a flat cap, because the next cron tick
      // is only minutes away and holding an invocation open longer than that
      // buys nothing while risking the subrequest and CPU limits. The flat cap
      // also matters when the policy carries no deadline at all, where
      // delayWithinDeadline would otherwise honour a 20-minute header
      // literally. Ending here surfaces the typed provider error, so the held
      // run still serves and the client still gets the provider's own
      // Retry-After.
      const maxWaitMs = Math.min(remainingProviderMs(policy), MAX_IN_TICK_RETRY_WAIT_MS);
      if (serverRetryAfterMs !== undefined && serverRetryAfterMs > maxWaitMs && lastError) {
        throw lastError;
      }
      const waitMs = serverRetryAfterMs === undefined
        ? backoffMs
        : Math.max(backoffMs, serverRetryAfterMs);
      try {
        await delayWithinDeadline(waitMs, policy, `${label} retry`);
      } catch (delayErr) {
        if (lastError) throw lastError;
        throw delayErr;
      }
    }
  }

  if (!lastError) throw new Error(`${label} failed`);
  throw lastError;
}
