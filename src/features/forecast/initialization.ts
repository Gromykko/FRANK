import type { ForecastLocation } from '../../config/locations';

const FORECAST_INITIALIZING_CODE = 'FORECAST_INITIALIZING' as const;

export interface ForecastInitialization {
  schemaVersion: 1;
  status: 'initializing';
  code: typeof FORECAST_INITIALIZING_CODE;
  location: Pick<ForecastLocation, 'id' | 'name' | 'areaName'>;
  retryAfterSeconds: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRetryAfterHeader(value: string | null, nowMs: number): number | null {
  if (!value) return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return seconds;

  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs) || dateMs <= nowMs) return null;
  return Math.ceil((dateMs - nowMs) / 1_000);
}

// Treat a 503 as an expected first-build state only when the complete contract
// is trustworthy and belongs to the location that was requested. A proxy HTML
// page, a generic provider 503, or a response for another city remains a normal
// failure; none may steer the UI into the calmer preparation screen.
export async function parseForecastInitialization(
  response: Response,
  requestedLocation: ForecastLocation,
  nowMs = Date.now(),
): Promise<ForecastInitialization | null> {
  if (response.status !== 503) return null;

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }

  if (
    !isRecord(body)
    || body.schemaVersion !== 1
    || body.status !== 'initializing'
    || body.code !== FORECAST_INITIALIZING_CODE
    || typeof body.message !== 'string'
    || body.message.trim() === ''
  ) return null;
  if (!isRecord(body.location) || body.location.id !== requestedLocation.id) return null;
  if (
    typeof body.location.name !== 'string'
    || body.location.name.trim() === ''
    || typeof body.location.areaName !== 'string'
    || body.location.areaName.trim() === ''
  ) return null;

  const bodyDelay = body.retryAfterSeconds;
  if (typeof bodyDelay !== 'number' || !Number.isFinite(bodyDelay) || bodyDelay <= 0) return null;

  const headerDelay = parseRetryAfterHeader(response.headers.get('Retry-After'), nowMs);

  return {
    schemaVersion: 1,
    status: 'initializing',
    code: FORECAST_INITIALIZING_CODE,
    // The id and display copy come from the trusted local configuration. The
    // response fields are still validated above so contract drift is visible,
    // but an upstream response cannot inject or rename location UI.
    location: {
      id: requestedLocation.id,
      name: requestedLocation.name,
      areaName: requestedLocation.areaName,
    },
    // Respect whichever instruction asks us to wait longer. The lifecycle
    // applies its own documented upper/lower scheduling bounds afterwards.
    retryAfterSeconds: Math.max(bodyDelay, headerDelay ?? 0),
  };
}
