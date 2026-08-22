const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

// A device clock can be manually wrong by hours while an HTTPS Worker response
// is still genuine. Accept up to one day of skew for offline/student devices,
// but reject wrong-year/hostile timestamps so they cannot outrank real cache
// generations forever. Keep this shared between validation and ordering so a
// payload cannot be accepted by one layer and distrusted by the other.
export const FORECAST_CLOCK_LEAD_TOLERANCE_MS = DAY_MS;

// Cloudflare's clock is authoritative for KV and assembled-cache validation;
// only normal distributed-system/request skew belongs there. The wider device
// allowance above is specifically for browsers whose local clock may be wrong.
export const FORECAST_SERVER_CLOCK_LEAD_TOLERANCE_MS = 5 * MINUTE_MS;

// FRANK intentionally assembles roughly 5.5 days of forecast data. A seventh
// day leaves room for a final 12-hour MET period while still rejecting corrupt
// caches whose forecast itself starts years in the future.
export const MAX_FORECAST_LEAD_MS = 7 * DAY_MS;

export function isPlausibleSourceTimestamp(
  timestampMs: number,
  nowMs: number,
  maxLeadMs = FORECAST_CLOCK_LEAD_TOLERANCE_MS,
): boolean {
  return Number.isFinite(timestampMs)
    && Number.isFinite(nowMs)
    && Number.isFinite(maxLeadMs)
    && maxLeadMs >= 0
    && timestampMs <= nowMs + maxLeadMs;
}

export function isPlausibleForecastTimestamp(timestampMs: number, nowMs: number): boolean {
  return Number.isFinite(timestampMs)
    && Number.isFinite(nowMs)
    && timestampMs <= nowMs + MAX_FORECAST_LEAD_MS;
}
