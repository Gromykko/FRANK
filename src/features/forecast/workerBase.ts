const DEFAULT_FORECAST_WORKER_BASE = 'https://frank-forecast.gromykko.workers.dev';

// One canonical origin for both forecast reads and the read-only availability
// summary. Keeping this separate from cache.ts lets recovery UI inspect
// /health without importing browser-cache machinery or drifting to a second
// hard-coded production URL.
export const FORECAST_WORKER_BASE = (
  import.meta.env.VITE_FORECAST_WORKER_BASE ?? DEFAULT_FORECAST_WORKER_BASE
).replace(/\/$/, '');
