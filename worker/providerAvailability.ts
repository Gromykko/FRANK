import type { BusyProvider } from './domain';
import { isTransientProviderFailure } from './forecastModel';
import { errorStatus } from './validation';

// Only errors deliberately classified at an upstream boundary may produce the
// public FORECAST_INITIALIZING response. Keeping this nominal class separate
// from ordinary Error prevents code, schema, KV, and deadline failures from
// accidentally being softened into an availability state.
export class ProviderUnavailableError extends Error {
  readonly code = 'PROVIDER_UNAVAILABLE' as const;
  readonly provider: BusyProvider;
  readonly busy: boolean;
  readonly retryAfterSeconds?: number;

  constructor(
    provider: BusyProvider,
    message: string,
    cause?: unknown,
    busy = false,
    retryAfterSeconds?: number,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ProviderUnavailableError';
    this.provider = provider;
    this.busy = busy;
    if (retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = retryAfterSeconds;
    }
  }
}

export function isProviderUnavailableError(
  error: unknown,
): error is ProviderUnavailableError {
  return error instanceof ProviderUnavailableError;
}

// Called only around fetch/provider operations. A bad payload, a normal 4xx,
// or an arbitrary Error is intentionally NOT transient: those can indicate a
// contract or implementation regression and must keep the release gate red.
function isTransientUpstreamError(error: unknown): boolean {
  const status = errorStatus(error);
  return isTransientProviderFailure({
    status,
    networkTypeError: status === undefined && error instanceof TypeError,
    errorName: error instanceof Error ? error.name : undefined,
  });
}

export function transientProviderError(
  error: unknown,
  provider: BusyProvider,
  message: string,
  retryAfterSeconds?: number,
): ProviderUnavailableError | null {
  return isTransientUpstreamError(error)
    ? new ProviderUnavailableError(
        provider,
        message,
        error,
        errorStatus(error) === 429,
        retryAfterSeconds,
      )
    : null;
}
