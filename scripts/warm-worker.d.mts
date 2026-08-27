export const WARM_LOCATION_IDS: readonly string[];
export const DEFAULT_WARM_TOTAL_TIMEOUT_MS: number;
export const DEFAULT_WARM_REQUEST_TIMEOUT_MS: number;
export const WARM_LOCATION_STAGGER_MS: number;

export interface WarmWorkerOptions {
  baseUrl?: string;
  token?: string;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
  sleepImpl?: (delayMs: number) => Promise<void>;
  logger?: { info: (...values: unknown[]) => void };
  totalTimeoutMs?: number;
  requestTimeoutMs?: number;
}

export function warmWorkerLocations(options?: WarmWorkerOptions): Promise<void>;
