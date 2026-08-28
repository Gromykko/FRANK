export type HttpStatusError = Error & { status: number };

export function errorWithStatus(message: string, status: number): HttpStatusError {
  return Object.assign(new Error(message), { status });
}

export function errorStatus(error: unknown): number | undefined {
  return error instanceof Error
    && 'status' in error
    && typeof error.status === 'number'
    ? error.status
    : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
