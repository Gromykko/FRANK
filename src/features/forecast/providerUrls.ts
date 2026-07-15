// Provider request vocabulary shared by the Worker and the dev-only client
// fetcher. The parameter lists must stay in lockstep with the properties
// normalize.ts reads off the responses — one copy, so they can't drift.
// PURE module (worker-safe): base URLs arrive as arguments because the client
// and worker resolve them differently (dev proxy vs direct), and only the bare
// coordinate is taken so this never drags in the client-only location config.

export const FORECAST_HOURS = 132;

export const WAM_PARAMETERS = [
  'significant-wave-height',
  'mean-wave-dir',
  'mean-wave-period',
  'dominant-wave-period',
];

export const DKSS_PARAMETERS = [
  'sea-mean-deviation',
  'water-temperature',
  'current-u',
  'current-v',
];

export interface Coordinate {
  latitude: number;
  longitude: number;
}

// 6h back (so the current hour always has context) to the forecast horizon.
export function getDmiDateRange(nowMs: number = Date.now()): string {
  const start = new Date(nowMs - 6 * 60 * 60 * 1000);
  const end = new Date(nowMs + FORECAST_HOURS * 60 * 60 * 1000);
  return `${start.toISOString()}/${end.toISOString()}`;
}

// DMI forecastedr position query; `instanceId` pins a specific model run (the
// worker's marine-fallback mechanism), omitted for "latest".
export function buildDmiUrl(
  base: string,
  collection: string,
  parameters: string[],
  coordinate: Coordinate,
  instanceId?: string
): string {
  const query = new URLSearchParams({
    coords: `POINT(${coordinate.longitude} ${coordinate.latitude})`,
    crs: 'crs84',
    'parameter-name': parameters.join(','),
    datetime: getDmiDateRange(),
    f: 'GeoJSON',
  });

  const instancePath = instanceId ? `/instances/${encodeURIComponent(instanceId)}` : '';
  return `${base}/collections/${collection}${instancePath}/position?${query.toString()}`;
}

export function buildDmiInstancesUrl(base: string, collection: string): string {
  return `${base}/collections/${collection}/instances`;
}

export function buildMetUrl(base: string, coordinate: Coordinate): string {
  // MET recommends truncating coordinates to 4 decimals to improve cache hits.
  const lat = coordinate.latitude.toFixed(4);
  const lon = coordinate.longitude.toFixed(4);
  return `${base}?lat=${lat}&lon=${lon}`;
}
