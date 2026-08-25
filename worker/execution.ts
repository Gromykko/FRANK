import type { EventMemo } from './domain';

// The authenticated candidate route has a 24-second hard budget and reserves
// four seconds for assembly and KV persistence, leaving at most 20 seconds for
// one provider stage. DMI position responses have repeatedly completed just
// beyond the former 15-second cutoff, so use the whole defensible provider
// window. Cron keeps its separate explicit 50-second timeout.
export const DEFAULT_FETCH_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_FETCH_ATTEMPTS = 1;
// A ceiling on the TIME-DERIVED attempt count only; an explicit policy
// maxAttempts stays a deliberate caller choice. Without it a generous budget
// bought floor(availableMs / 3000) swings - observed at 15 on one request.
// DMI refused 347 of 643 upstream attempts in 24h (2026-08-25) and sends no
// Retry-After, so the extra swings are spent on a provider that has already
// said no, against a 50-subrequest and 10ms-CPU invocation budget.
const MAX_DERIVED_FETCH_ATTEMPTS = 5;
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
// invocation-wide subrequest allowance. MET and warnings are direct,
// single-pass fetches. DMI catalogue probes are now rare behind the shared run
// manifest, so they get their own ceiling; position legs receive the larger
// ceiling and are reallocated from the live remaining count before build fanout.
export const CRON_PROVIDER_MAX_ATTEMPTS = 3;
export const CRON_MARINE_CATALOGUE_MAX_ATTEMPTS = 8;
export const CRON_MARINE_POSITION_MAX_ATTEMPTS = 18;
export const DMI_BUSY_RETRY_DELAY_MS = 1_200;
// Workers Free permits 50 external subrequests per invocation. Keep five in
// reserve for platform/provider behavior outside the explicit retry loops.
export const EVENT_EXTERNAL_SUBREQUEST_BUDGET = 45;

export const CRON_SUBREQUEST_CALL_GRAPH = Object.freeze({
  marineKinds: 2,
  instanceCollectionsPerKind: 2,
  concurrentPositionLegs: 2,
  metForecasts: 1,
  warningFeeds: 1,
  warningDetails: 6,
});

// These stages start concurrently with the two marine position legs and may
// not be starved: one direct MET fetch + one warning feed + up to six CAP
// detail fetches (MAX_DETAIL_FETCHES in parseWarnings.ts) = eight requests.
export const CRON_CONCURRENT_EXTERNAL_SUBREQUEST_RESERVE =
  CRON_SUBREQUEST_CALL_GRAPH.metForecasts
  + CRON_SUBREQUEST_CALL_GRAPH.warningFeeds
  + CRON_SUBREQUEST_CALL_GRAPH.warningDetails;

// A catalogue collection can spend its full retry ceiling and finally return
// a valid empty list, after which the fallback collection gets the same chance.
// Therefore the real catalogue maximum is 2 kinds x 2 collections x 8 = 32.
// A ninth attempt would be unsafe on a successful final probe:
// 2 x 2 x 9 catalogue + 2 minimum position attempts + 8 reserve = 46 > 45.
export const CRON_MAX_CATALOGUE_EXTERNAL_SUBREQUESTS =
  CRON_SUBREQUEST_CALL_GRAPH.marineKinds
    * CRON_SUBREQUEST_CALL_GRAPH.instanceCollectionsPerKind
    * CRON_MARINE_CATALOGUE_MAX_ATTEMPTS;

function normalizedExternalSubrequestsStarted(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isFinite(value)) return EVENT_EXTERNAL_SUBREQUEST_BUDGET;
  return Math.max(0, Math.floor(value));
}

function positionAttemptCapFromConsumed(
  ceiling: number,
  consumed: number | undefined,
): number {
  const remainingForPositions = EVENT_EXTERNAL_SUBREQUEST_BUDGET
    - normalizedExternalSubrequestsStarted(consumed)
    - CRON_CONCURRENT_EXTERNAL_SUBREQUEST_RESERVE;
  const fairShare = Math.floor(
    remainingForPositions / CRON_SUBREQUEST_CALL_GRAPH.concurrentPositionLegs,
  );
  return Math.max(1, Math.min(Math.max(1, Math.floor(ceiling)), fairShare));
}

function cronSubrequestPath(
  catalogueSubrequests: number,
  positionsRun: boolean,
) {
  const marinePositionAttemptsPerLeg = positionsRun
    ? positionAttemptCapFromConsumed(
        CRON_MARINE_POSITION_MAX_ATTEMPTS,
        catalogueSubrequests,
      )
    : 0;
  return Object.freeze({
    catalogueSubrequests,
    marinePositionAttemptsPerLeg,
    concurrentReserve: CRON_CONCURRENT_EXTERNAL_SUBREQUEST_RESERVE,
    total: catalogueSubrequests
      + CRON_SUBREQUEST_CALL_GRAPH.concurrentPositionLegs
        * marinePositionAttemptsPerLeg
      + CRON_CONCURRENT_EXTERNAL_SUBREQUEST_RESERVE,
  });
}

// A single summed worst case is false because catalogue and position spending
// are sequential and dynamically coupled. Model the three actual paths. Cold
// catalogue exhaustion stops before build, but valid retained run ids can let
// a build continue; model that stricter case because a missing raw-marine cache
// can still send both old-run position legs through the dynamic allocation.
export const CRON_EXTERNAL_SUBREQUEST_PATHS = Object.freeze({
  manifestHit: cronSubrequestPath(0, true),
  catalogueSucceeds: cronSubrequestPath(
    CRON_MAX_CATALOGUE_EXTERNAL_SUBREQUESTS,
    true,
  ),
  catalogueExhausts: cronSubrequestPath(
    CRON_MAX_CATALOGUE_EXTERNAL_SUBREQUESTS,
    true,
  ),
});

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
  marineCatalogueMaxAttempts?: number;
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
  marineCatalogueMaxAttempts: number;
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
    ? Math.min(MAX_DERIVED_FETCH_ATTEMPTS, Math.max(1, Math.floor(availableMs / 3_000)))
    : DEFAULT_MAX_FETCH_ATTEMPTS;
  const maxAttempts = policy.maxAttempts !== undefined
    ? Math.max(1, policy.maxAttempts)
    : dynamicAttempts;

  return {
    deadlineAt: deadline,
    hardDeadlineAt: policy.hardDeadlineAt ?? policy.deadlineAt ?? Number.POSITIVE_INFINITY,
    fetchTimeoutMs: policy.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
    maxAttempts,
    marineCatalogueMaxAttempts: policy.marineCatalogueMaxAttempts !== undefined
      ? Math.max(1, policy.marineCatalogueMaxAttempts)
      : maxAttempts,
    marinePositionMaxAttempts: policy.marinePositionMaxAttempts !== undefined
      ? Math.max(1, policy.marinePositionMaxAttempts)
      : maxAttempts,
    completionReserveMs: reserve,
    retryDelayMs: policy.retryDelayMs,
    retryBusyDelayMs: policy.retryBusyDelayMs,
  };
}

// Called exactly once at the build fanout boundary: catalogue/manifest
// resolution has finished, while MET, both position legs and warnings have not
// started. Read the event's live counter rather than reconstructing catalogue
// calls. The existing policy value remains a separate time/candidate ceiling.
export function reallocateMarinePositionAttempts(
  policy: ExecutionPolicy,
  eventMemo?: EventMemo,
): ExecutionPolicy {
  return {
    ...policy,
    marinePositionMaxAttempts: positionAttemptCapFromConsumed(
      policy.marinePositionMaxAttempts,
      eventMemo?.externalSubrequestsStarted,
    ),
  };
}

// Must match `triggers.crons` in wrangler.jsonc. The rotation below turns the
// scheduled time into a tick counter, so a period larger than the real cron
// makes consecutive ticks share an index and start from the same city twice in
// a row - exactly when a budget-truncated tick starves the same tail of the
// list it starved last time. The test reads wrangler.jsonc and fails if these
// two ever drift apart again.
export const CRON_PERIOD_MS = 60_000;

// How many scheduled ticks pass between routine heartbeat writes. Lives here
// beside CRON_PERIOD_MS, not in index.ts, so the status page can state the real
// cadence instead of a hardcoded sentence that silently goes stale when this
// number changes - which is exactly how it came to claim "every five minutes".
//
// Fifteen rather than five: cadence writes were 274 of our 749 KV writes a day
// (2026-08-25) against a 1,000-write ACCOUNT ceiling - the largest single line
// and the one carrying the least information. Fifteen costs ~96 a day instead.
// The trade is detection latency for total scheduler death only: a city going
// unreachable or recovering forces an immediate write regardless of this.
export const CRON_HEARTBEAT_THROTTLE_TICKS = 15;

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
  const timeBoundAttempts = Math.max(1, Math.floor(locationBudgetMs / 1_800));
  const maxAttempts = Math.min(
    CRON_PROVIDER_MAX_ATTEMPTS,
    timeBoundAttempts,
  );
  const marineCatalogueMaxAttempts = Math.min(
    CRON_MARINE_CATALOGUE_MAX_ATTEMPTS,
    timeBoundAttempts,
  );
  const marinePositionMaxAttempts = Math.min(
    CRON_MARINE_POSITION_MAX_ATTEMPTS,
    timeBoundAttempts,
  );
  return executionPolicy({
    deadlineAt: Math.min(tickDeadlineAt, nowMs + locationBudgetMs),
    fetchTimeoutMs: Math.min(CRON_FETCH_TIMEOUT_MS, locationBudgetMs),
    maxAttempts,
    marineCatalogueMaxAttempts,
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
