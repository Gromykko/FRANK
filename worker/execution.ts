// The authenticated candidate route has a 24-second hard budget and reserves
// four seconds for assembly and KV persistence, leaving at most 20 seconds for
// one provider stage. DMI position responses have repeatedly completed just
// beyond the former 15-second cutoff, so use the whole defensible provider
// window. Cron keeps its separate explicit 50-second timeout.
export const DEFAULT_FETCH_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_FETCH_ATTEMPTS = 1;
const CRON_FETCH_TIMEOUT_MS = 15_000;
const CRON_LOCATION_MIN_BUDGET_MS = 15_000;
const CRON_COMPLETION_RESERVE_MS = 8_000;
export const CRON_TICK_BUDGET_MS = 4 * 60_000;
export const CRON_TOTAL_ATTEMPTS_BUDGET = 45;
export const DMI_BUSY_RETRY_DELAY_MS = 1_200;

export type DeadlineKind = 'hard' | 'provider';

export interface ExecutionPolicyInput {
  deadlineAt?: number;
  hardDeadlineAt?: number;
  fetchTimeoutMs?: number;
  maxAttempts?: number;
  completionReserveMs?: number;
  retryDelayMs?: number;
  retryBusyDelayMs?: number;
}

export interface ExecutionPolicy {
  deadlineAt: number;
  hardDeadlineAt: number;
  fetchTimeoutMs: number;
  maxAttempts: number;
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

  return {
    deadlineAt: deadline,
    hardDeadlineAt: policy.hardDeadlineAt ?? policy.deadlineAt ?? Number.POSITIVE_INFINITY,
    fetchTimeoutMs: policy.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
    maxAttempts: policy.maxAttempts !== undefined && policy.maxAttempts > 1
      ? policy.maxAttempts
      : (policy.maxAttempts === 1 && availableMs < 6_000 ? 1 : dynamicAttempts),
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
export const CRON_PERIOD_MS = 5 * 60_000;

export function rotateTickOrder<T>(
  scheduledTime: number | undefined,
  list: T[],
): T[] {
  const tickIndex = Math.floor(Number(scheduledTime) / CRON_PERIOD_MS);
  if (!Number.isFinite(tickIndex) || list.length === 0) return list;
  const offset = ((tickIndex % list.length) + list.length) % list.length;
  return [...list.slice(offset), ...list.slice(0, offset)];
}

// Each remaining location receives its adaptive share of the scheduled tick,
// distributing up to 200 attempts across unready cities to probe DMI backend nodes.
export function cronExecutionPolicy(
  nowMs: number,
  tickDeadlineAt: number,
  locationsRemaining: number,
): ExecutionPolicy | null {
  const remainingMs = tickDeadlineAt - nowMs;
  if (remainingMs <= 0 || locationsRemaining <= 0) return null;
  const locationBudgetMs = Math.max(
    CRON_LOCATION_MIN_BUDGET_MS,
    Math.floor(remainingMs / locationsRemaining),
  );
  if (locationBudgetMs <= 0) return null;
  const maxAttempts = Math.min(
    CRON_TOTAL_ATTEMPTS_BUDGET,
    Math.max(3, Math.floor(locationBudgetMs / 1_800)),
  );
  return executionPolicy({
    deadlineAt: Math.min(tickDeadlineAt, nowMs + locationBudgetMs),
    fetchTimeoutMs: Math.min(CRON_FETCH_TIMEOUT_MS, locationBudgetMs),
    maxAttempts,
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
): Promise<Response> {
  assertBeforeProviderDeadline(policy, `fetch ${String(url)}`);
  const remainingMs = remainingProviderMs(policy);
  const timeoutMs = Math.max(1, Math.floor(Math.min(policy.fetchTimeoutMs, remainingMs)));
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}
