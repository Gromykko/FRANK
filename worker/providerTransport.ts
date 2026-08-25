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
): boolean {
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
  return previous === undefined;
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

type RetryAfterDisposition =
  | 'absent'
  | 'honored-wait'
  | 'honored-stop'
  | 'honored-no-retry'
  | 'ignored-invalid'
  | 'ignored-status';

interface UpstreamAttemptRecord {
  provider: BusyProvider;
  source: string;
  collection?: string;
  attempt: number;
  requestStarted: boolean;
  outcome: string;
  httpStatus: number | null;
  elapsedMs: number;
  // Only the disposition is logged. It already distinguishes no-header from
  // malformed from honoured ('absent' | 'ignored-status' | 'ignored-invalid' |
  // 'honored-wait' | 'honored-no-retry'), so the raw string and its parsed
  // seconds were three always-null columns on every upstream attempt. DMI has
  // never sent the header (12/12 429s, 2026-08-24); if the disposition ever
  // stops reading 'absent', put them back.
  retryAfterDisposition: RetryAfterDisposition;
  marineBusyCircuitOpenOnEntry: boolean;
  openedMarineBusyCircuit: boolean;
}

function emitUpstreamAttempt(record: UpstreamAttemptRecord): void {
  // Diagnostics must never become a provider-control dependency. These are
  // fixed, bounded scalars; no URL, response body, or error text enters them.
  try {
    console.log(JSON.stringify({
      event: 'upstream_attempt',
      provider: record.provider,
      source: record.source,
      ...(record.collection === undefined ? {} : { collection: record.collection }),
      attempt: record.attempt,
      requestStarted: record.requestStarted,
      outcome: record.outcome,
      httpStatus: record.httpStatus,
      elapsedMs: record.elapsedMs,
      retryAfterDisposition: record.retryAfterDisposition,
      marineBusyCircuitOpenOnEntry: record.marineBusyCircuitOpenOnEntry,
      openedMarineBusyCircuit: record.openedMarineBusyCircuit,
    }));
  } catch {
    // Best-effort observability only.
  }
}

function statusFromOutcome(outcome: string): number | null {
  if (outcome === 'not-modified') return 304;
  const match = /^http-(\d{3})$/.exec(outcome);
  return match ? Number(match[1]) : null;
}

// MET is a direct, single-attempt stage and still uses this small adapter.
// Retried stages below emit the same record with their attempt/circuit detail.
export function logUpstream(
  source: string,
  startedAt: number,
  outcome: string,
): void {
  emitUpstreamAttempt({
    provider: source.startsWith('met:') ? 'weather' : 'services',
    source,
    attempt: 1,
    requestStarted: true,
    outcome,
    httpStatus: statusFromOutcome(outcome),
    elapsedMs: Date.now() - startedAt,
    retryAfterDisposition: 'absent',
    marineBusyCircuitOpenOnEntry: false,
    openedMarineBusyCircuit: false,
  });
}

function retryAfterSeconds(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1, Math.ceil(seconds));
  const atMs = Date.parse(value);
  if (!Number.isFinite(atMs)) return undefined;
  return Math.max(1, Math.ceil((atMs - Date.now()) / 1000));
}

function requestAttemptPolicy(
  url: string,
  provider: BusyProvider,
  policy: ExecutionPolicy,
): { maxAttempts: number; collection?: string } {
  if (provider !== 'marine') return { maxAttempts: policy.maxAttempts };
  try {
    const pathname = new URL(url).pathname;
    const collection = /\/collections\/([^/]+)/.exec(pathname)?.[1];
    const isCatalogueStage = /\/collections\/[^/]+\/instances$/.test(pathname);
    const isPositionStage = /\/collections\/[^/]+\/instances\/[^/]+\/position$/.test(pathname);
    if (isCatalogueStage) {
      return { maxAttempts: policy.marineCatalogueMaxAttempts, collection };
    }
    return {
      maxAttempts: isPositionStage ? policy.marinePositionMaxAttempts : policy.maxAttempts,
      collection,
    };
  } catch {
    return { maxAttempts: policy.maxAttempts };
  }
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
  let sawBusyRefusal = false;
  let lastBusyError: ProviderUnavailableError | undefined;
  let pendingFinalAttemptRecord: UpstreamAttemptRecord | null = null;
  const requestPolicy = requestAttemptPolicy(url, provider, policy);
  const { maxAttempts } = requestPolicy;
  const attemptRecord = (
    attempt: number,
    startedAt: number,
    outcome: string,
    httpStatus: number | null,
    retryAfterDisposition: RetryAfterDisposition = 'absent',
    marineBusyCircuitOpenOnEntry = false,
  ): UpstreamAttemptRecord => ({
    provider,
    source: label,
    collection: requestPolicy.collection,
    attempt: attempt + 1,
    requestStarted: !marineBusyCircuitOpenOnEntry,
    outcome,
    httpStatus,
    elapsedMs: Date.now() - startedAt,
    retryAfterDisposition,
    marineBusyCircuitOpenOnEntry,
    openedMarineBusyCircuit: false,
  });
  const terminalProviderError = (error: Error): Error => {
    if (!lastBusyError
      || !(error instanceof ProviderUnavailableError)
      || error.busy) {
      return error;
    }

    // A later timeout or 5xx is the most useful terminal diagnostic, but it
    // does not erase the verified 429 seen earlier in this same retry chain.
    // Keep that terminal error as the cause while carrying the provider's
    // already-verified busy classification and Retry-After guidance forward.
    return new ProviderUnavailableError(
      error.provider,
      error.message,
      error,
      true,
      lastBusyError.retryAfterSeconds,
    );
  };

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const circuitCheckedAt = Date.now();
    if (provider === 'marine') {
      const circuit = await readMarineBusyCircuit(eventMemo);
      if (circuit) {
        emitUpstreamAttempt(attemptRecord(
          attempt,
          circuitCheckedAt,
          'circuit-open',
          null,
          'absent',
          true,
        ));
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
      if (lastError) throw terminalProviderError(lastError);
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
      const failedAttemptRecord = attemptRecord(
        attempt,
        startedAt,
        normalized.name === 'TimeoutError' ? 'timeout' : 'error',
        null,
      );
      if (attempt === maxAttempts - 1) {
        pendingFinalAttemptRecord = failedAttemptRecord;
      } else {
        emitUpstreamAttempt(failedAttemptRecord);
      }
      if (attempt < maxAttempts - 1) {
        try {
          await delayWithinDeadline(retryDelay(attempt, false, policy), policy, `${label} retry`);
        } catch (delayErr) {
          if (lastError) throw terminalProviderError(lastError);
          throw delayErr;
        }
      }
      continue;
    }

    const rawRetryAfterValue = response.headers?.get?.('Retry-After');
    const retryAfterRaw = typeof rawRetryAfterValue === 'string'
      ? rawRetryAfterValue
      : null;
    const headerRetrySeconds = response.status === 429
      ? retryAfterSeconds(retryAfterRaw)
      : undefined;
    let currentAttemptRecord = attemptRecord(
      attempt,
      startedAt,
      'error',
      response.status,
      retryAfterRaw === null ? 'absent' : 'ignored-status',
    );

    try {
      if (response.ok) {
        const json = await response.json();
        emitUpstreamAttempt(attemptRecord(
          attempt,
          startedAt,
          'ok',
          response.status,
          retryAfterRaw === null ? 'absent' : 'ignored-status',
        ));
        return json;
      }

      const statusError = errorWithStatus(
        `${label} failed with HTTP ${response.status}`,
        response.status,
      );
      // Only an EXPLICIT header spaces our own retries. The default below is
      // what we tell the browser to do when the provider gives no guidance;
      // borrowing it as an in-tick delay would spend the whole location budget
      // sleeping on a 429 that carried no instruction at all.
      if (response.status === 429) sawBusyRefusal = true;
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
      if (lastError instanceof ProviderUnavailableError && lastError.busy) {
        lastBusyError = lastError;
      }
      // Capture the request timing at the same point as the former bare log:
      // headers and Retry-After have arrived, but body draining and retry waits
      // have not inflated the provider's response time.
      currentAttemptRecord = attemptRecord(
        attempt,
        startedAt,
        `http-${response.status}`,
        response.status,
        retryAfterRaw === null
          ? 'absent'
          : response.status !== 429
            ? 'ignored-status'
            : headerRetrySeconds === undefined
              ? 'ignored-invalid'
              : attempt === maxAttempts - 1
                ? 'honored-no-retry'
                : 'honored-wait',
      );
      try {
        // Preserve the existing body-consumption timing without retaining or
        // logging provider-controlled bytes.
        await response.text();
      } catch {
        // The reached status owns classification; draining is best-effort.
      }
      // Non-429 4xx responses (e.g. 400, 404) are terminal.
      // 429 and 5xx responses retry within the execution policy budget and deadline.
      if (response.status !== 429 && response.status < 500) {
        pendingFinalAttemptRecord = currentAttemptRecord;
        break;
      }
    } catch (error) {
      // A reached 2xx response that cannot be parsed is a hard contract failure.
      lastError = error instanceof Error ? error : new Error(String(error));
      currentAttemptRecord = attemptRecord(
        attempt,
        startedAt,
        'invalid-response',
        response.status,
        retryAfterRaw === null ? 'absent' : 'ignored-status',
      );
      // Retrying a syntactically invalid success body only repeats a provider
      // contract violation and spends subrequests/CPU. Network and HTTP
      // failures are handled by the retry paths above; a reached 2xx that
      // cannot produce JSON is terminal for this stage.
      if (response.ok) {
        pendingFinalAttemptRecord = currentAttemptRecord;
        break;
      }
    }

    if (attempt < maxAttempts - 1) {
      const isBusy = response.status === 429;
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
        currentAttemptRecord.retryAfterDisposition = 'honored-stop';
        emitUpstreamAttempt(currentAttemptRecord);
        throw lastError;
      }
      const waitMs = serverRetryAfterMs === undefined
        ? backoffMs
        : Math.max(backoffMs, serverRetryAfterMs);
      try {
        await delayWithinDeadline(waitMs, policy, `${label} retry`);
      } catch (delayErr) {
        if (currentAttemptRecord.retryAfterDisposition === 'honored-wait') {
          currentAttemptRecord.retryAfterDisposition = 'honored-stop';
        }
        emitUpstreamAttempt(currentAttemptRecord);
        if (lastError) throw terminalProviderError(lastError);
        throw delayErr;
      }
      emitUpstreamAttempt(currentAttemptRecord);
    } else {
      pendingFinalAttemptRecord = currentAttemptRecord;
    }
  }

  // DMI documents one host-wide fair-use limit, so once a marine stage has
  // genuinely exhausted its attempts against a 429 there is no point letting
  // the other leg, or later cities in this same event, re-earn the refusal.
  //
  // But only THEN. This used to open on the first 429 and break immediately,
  // which meant marine got zero retries: the break sat above the retry block,
  // so the Retry-After handling below was unreachable for the one provider
  // that actually sends Retry-After. Observed behaviour contradicts that
  // design - the same DMI position request has returned seven 429s and
  // succeeded on the eighth - so a single refusal is evidence of nothing, and
  // treating it as provider-wide failure threw away recoverable data and left
  // cities on stale marine for a 20-minute backoff.
  let openedMarineBusyCircuit = false;
  if (sawBusyRefusal && provider === 'marine' && eventMemo) {
    openedMarineBusyCircuit = openMarineBusyCircuit(
      eventMemo,
      lastError instanceof ProviderUnavailableError
        ? lastError.retryAfterSeconds ?? MARINE_BUSY_DEFAULT_RETRY_SECONDS
        : MARINE_BUSY_DEFAULT_RETRY_SECONDS,
    );
  }
  if (pendingFinalAttemptRecord) {
    pendingFinalAttemptRecord.openedMarineBusyCircuit = openedMarineBusyCircuit;
    emitUpstreamAttempt(pendingFinalAttemptRecord);
  }

  if (!lastError) throw new Error(`${label} failed`);
  throw terminalProviderError(lastError);
}
