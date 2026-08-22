import type { EventMemo } from './domain';

// The authenticated candidate route has a 24-second hard budget and reserves
// four seconds for assembly and KV persistence, leaving at most 20 seconds for
// one provider stage. DMI position responses have repeatedly completed just
// beyond the former 15-second cutoff, so use the whole defensible provider
// window. Cron keeps its separate explicit 50-second timeout.
export const DEFAULT_FETCH_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_FETCH_ATTEMPTS = 1;
const CRON_FETCH_TIMEOUT_MS = 50_000;
const CRON_LOCATION_MIN_BUDGET_MS = 15_000;
const CRON_COMPLETION_RESERVE_MS = 8_000;
// Cadence arithmetic: 50s refresh budget - 8s completion reserve = one
// shared 42s provider window. Every attempt carries the 50s fetch cap, but
// every fetch and retry delay is clamped to that same remaining window; those
// individual caps are never additive. The scheduled handler then gives its
// heartbeat at most 3s, for a designed 53s total and about 7s before the next
// one-minute tick.
export const CRON_TICK_BUDGET_MS = 50_000;
// Retry depth is a provider-stage decision, not a way to spend the
// invocation-wide subrequest allowance. Catalogue probes keep the ordinary
// cap, while MET and warnings keep their existing single-pass behavior. Only
// a DMI marine position leg can use the larger cap below, where production has
// shown seven quick 429s followed by a success.
export const CRON_PROVIDER_MAX_ATTEMPTS = 3;
export const CRON_MARINE_POSITION_MAX_ATTEMPTS = 10;
export const DMI_BUSY_RETRY_DELAY_MS = 1_200;
// Workers Free permits 50 external subrequests per invocation. Keep five in
// reserve for platform/provider behavior outside the explicit retry loops.
export const EVENT_EXTERNAL_SUBREQUEST_BUDGET = 45;

export const CRON_SUBREQUEST_CALL_GRAPH = Object.freeze({
  marineKinds: 2,
  instanceCollectionsPerKind: 2,
  metForecasts: 1,
  warningFeeds: 1,
  warningDetails: 6,
});

// Actual one-city call graph in providers.ts:
// 2 marine kinds x 2 instance collections x 3 catalogue attempts
// + 2 position legs x 10 attempts + 1 MET + 1 warning feed + 6 CAP details
// = 40 app-started external requests, at most 45 and below the hard 50.
export const CRON_WORST_CASE_EXTERNAL_SUBREQUESTS =
  CRON_SUBREQUEST_CALL_GRAPH.marineKinds
    * CRON_SUBREQUEST_CALL_GRAPH.instanceCollectionsPerKind
    * CRON_PROVIDER_MAX_ATTEMPTS
  + CRON_SUBREQUEST_CALL_GRAPH.marineKinds
    * CRON_MARINE_POSITION_MAX_ATTEMPTS
  + CRON_SUBREQUEST_CALL_GRAPH.metForecasts
  + CRON_SUBREQUEST_CALL_GRAPH.warningFeeds
  + CRON_SUBREQUEST_CALL_GRAPH.warningDetails;

export class ExternalSubrequestBudgetError extends Error {
  constructor() {
    super(`External subrequest budget exhausted (${EVENT_EXTERNAL_SUBREQUEST_BUDGET} per event).`);
    this.name = 'ExternalSubrequestBudgetError';
  }
}

export function isExternalSubrequestBudgetError(
  error: unknown,
): error is ExternalSubrequestBudgetError {
  return error instanceof ExternalSubrequestBudgetError;
}

export type DeadlineKind = 'hard' | 'provider';

export interface ExecutionPolicyInput {
  deadlineAt?: number;
  hardDeadlineAt?: number;
  fetchTimeoutMs?: number;
  maxAttempts?: number;
  marinePositionMaxAttempts?: number;
  completionReserveMs?: number;
  retryDelayMs?: number;
  retryBusyDelayMs?: number;
}

export interface ExecutionPolicy {
  deadlineAt: number;
  hardDeadlineAt: number;
  fetchTimeoutMs: number;
  maxAttempts: number;
  marinePositionMaxAttempts: number;
  completionReserveMs: number;
  retryDelayMs?: number;
  retryBusyDelayMs?: number;
}

export type ExecutionDeadlineError = Error & { deadlineKind: DeadlineKind };

export function executionPolicy(policy: ExecutionPolicyInput = {}): ExecutionPolicy {
  const deadline = policy.deadlineAt ?? Number.POSITIVE_INFINITY;
  const reserve = Math.max(0, policy.completionReserveMs ?? 0);
  const availableMs = Number.isFinite(deadline) ? Math.max(0, deadline - Date.now() - reserve) : 0;
  const dynamicAttempts = availableMs >= 6_000
    ? Math.max(1, Math.floor(availableMs / 3_000))
    : DEFAULT_MAX_FETCH_ATTEMPTS;
  const maxAttempts = policy.maxAttempts !== undefined
    ? Math.max(1, policy.maxAttempts)
    : dynamicAttempts;

  return {
    deadlineAt: deadline,
    hardDeadlineAt: policy.hardDeadlineAt ?? policy.deadlineAt ?? Number.POSITIVE_INFINITY,
    fetchTimeoutMs: policy.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
    maxAttempts,
    marinePositionMaxAttempts: policy.marinePositionMaxAttempts !== undefined
      ? Math.max(1, policy.marinePositionMaxAttempts)
      : maxAttempts,
    completionReserveMs: reserve,
    retryDelayMs: policy.retryDelayMs,
    retryBusyDelayMs: policy.retryBusyDelayMs,
  };
}

// Must match `triggers.crons` in wrangler.jsonc. The rotation below turns the
// scheduled time into a tick counter, so a period larger than the real cron
// makes consecutive ticks share an index and start from the same city twice in
// a row - exactly when a budget-truncated tick starves the same tail of the
// list it starved last time. The test reads wrangler.jsonc and fails if these
// two ever drift apart again.
export const CRON_PERIOD_MS = 60_000;

export function rotateTickOrder<T>(
  scheduledTime: number | undefined,
  list: T[],
): T[] {
  const tickIndex = Math.round(Number(scheduledTime) / CRON_PERIOD_MS);
  if (!Number.isFinite(tickIndex) || list.length === 0) return list;
  const offset = ((tickIndex % list.length) + list.length) % list.length;
  return [...list.slice(offset), ...list.slice(0, offset)];
}

// Each remaining location receives an adaptive time/attempt ceiling. The actual
// invocation-wide fetch count is independently capped by
// EVENT_EXTERNAL_SUBREQUEST_BUDGET in fetchWithTimeout.
export function cronExecutionPolicy(
  nowMs: number,
  tickDeadlineAt: number,
  locationsRemaining: number,
): ExecutionPolicy | null {
  const remainingMs = tickDeadlineAt - nowMs;
  if (remainingMs < CRON_LOCATION_MIN_BUDGET_MS || remainingMs <= CRON_COMPLETION_RESERVE_MS || locationsRemaining <= 0) {
    return null;
  }
  const locationBudgetMs = Math.max(
    CRON_LOCATION_MIN_BUDGET_MS,
    Math.floor(remainingMs / locationsRemaining),
  );
  if (locationBudgetMs <= 0) return null;
  const maxAttempts = Math.min(
    CRON_PROVIDER_MAX_ATTEMPTS,
    Math.max(1, Math.floor(locationBudgetMs / 1_800)),
  );
  const marinePositionMaxAttempts = Math.min(
    CRON_MARINE_POSITION_MAX_ATTEMPTS,
    Math.max(1, Math.floor(locationBudgetMs / 1_800)),
  );
  return executionPolicy({
    deadlineAt: Math.min(tickDeadlineAt, nowMs + locationBudgetMs),
    fetchTimeoutMs: Math.min(CRON_FETCH_TIMEOUT_MS, locationBudgetMs),
    maxAttempts,
    marinePositionMaxAttempts,
    completionReserveMs: Math.min(
      CRON_COMPLETION_RESERVE_MS,
      Math.floor(locationBudgetMs / 5),
    ),
  });
}

export function remainingExecutionMs(policy: ExecutionPolicy): number {
  return policy.deadlineAt - Date.now();
}

export function deadlineError(stage: string, deadlineKind: DeadlineKind = 'hard'): ExecutionDeadlineError {
  return Object.assign(new Error(`Execution deadline reached before ${stage}`), {
    name: 'ExecutionDeadlineError',
    deadlineKind,
  });
}

export function isExecutionDeadlineError(error: unknown): error is ExecutionDeadlineError {
  return error instanceof Error
    && error.name === 'ExecutionDeadlineError'
    && 'deadlineKind' in error
    && (error.deadlineKind === 'hard' || error.deadlineKind === 'provider');
}

export function assertBeforeDeadline(policy: ExecutionPolicy, stage: string): void {
  if (remainingExecutionMs(policy) <= 0) throw deadlineError(stage);
}

export function remainingProviderMs(policy: ExecutionPolicy): number {
  return remainingExecutionMs(policy) - policy.completionReserveMs;
}

export function assertBeforeProviderDeadline(policy: ExecutionPolicy, stage: string): void {
  if (remainingProviderMs(policy) <= 0) {
    throw deadlineError(`${stage} (completion reserve reached)`, 'provider');
  }
}

export function rethrowIfDeadlineReached(
  error: unknown,
  policy: ExecutionPolicy,
  stage: string,
): void {
  if (isExecutionDeadlineError(error) && error.deadlineKind !== 'provider') throw error;
  assertBeforeDeadline(policy, stage);
}

export async function delayWithinDeadline(
  ms: number,
  policy: ExecutionPolicy,
  stage: string,
): Promise<void> {
  assertBeforeProviderDeadline(policy, stage);
  const remainingMs = remainingProviderMs(policy);
  const delayMs = Number.isFinite(remainingMs) ? Math.min(ms, remainingMs) : ms;
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  assertBeforeProviderDeadline(policy, stage);
}

export async function awaitWithinDeadline<T>(
  start: () => Promise<T>,
  policy: ExecutionPolicy,
  stage: string,
): Promise<T> {
  assertBeforeDeadline(policy, stage);
  const promise = start();
  // Prevent unhandled rejections in edge runtime if the deadline expires first
  // and the background promise rejects later.
  promise.catch(() => {});
  const remainingMs = remainingExecutionMs(policy);
  if (!Number.isFinite(remainingMs)) return promise;

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(deadlineError(stage)), Math.max(1, remainingMs));
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

// AbortSignal.timeout stays armed for the whole exchange, body included. A
// manual controller cleared when headers arrive would leave response parsing
// able to hang indefinitely.
export function fetchWithTimeout(
  url: RequestInfo | URL,
  init: RequestInit = {},
  policy: ExecutionPolicy = executionPolicy(),
  eventMemo?: EventMemo,
): Promise<Response> {
  assertBeforeProviderDeadline(policy, `fetch ${String(url)}`);
  if (eventMemo) {
    const started = eventMemo.externalSubrequestsStarted ?? 0;
    if (started >= EVENT_EXTERNAL_SUBREQUEST_BUDGET) {
      throw new ExternalSubrequestBudgetError();
    }
    // Increment synchronously before fetch() starts. Parallel provider legs run
    // in one JS event loop, so no two legs can observe and spend the same slot.
    eventMemo.externalSubrequestsStarted = started + 1;
  }
  const remainingMs = remainingProviderMs(policy);
  const timeoutMs = Math.max(1, Math.floor(Math.min(policy.fetchTimeoutMs, remainingMs)));
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}
