export const KV_WRITE_CATEGORIES = Object.freeze([
  'assembled-forecast',
  'raw-met',
  'raw-marine',
  'heartbeat-cadence',
  'heartbeat-anomaly',
  'initialization-marker',
  'failure-state',
  'dmi-run-manifest',
] as const);

export type KvWriteCategory = typeof KV_WRITE_CATEGORIES[number];

type KvWriter = Pick<KVNamespace, 'put'>;

export interface RawMarineCoverageLog {
  marineKind: 'water' | 'waves';
  seriesPointCount: number;
  seriesEndMs: number | null;
  declaredEndMs: number | null;
  coverageStatus: 'complete' | 'partial' | 'unknown';
  coverageGapMs: number | null;
}

export async function putKvWithLog(
  namespace: KvWriter,
  key: string,
  value: string,
  category: KvWriteCategory,
  locationId?: string,
  options?: KVNamespacePutOptions,
  rawMarineCoverage?: RawMarineCoverageLog,
): Promise<void> {
  if (options === undefined) {
    await namespace.put(key, value);
  } else {
    await namespace.put(key, value, options);
  }

  // Logging must never turn a completed persistence operation into a failed
  // application write. The fields are deliberately limited to non-sensitive
  // dimensions that Workers Logs can filter and group.
  try {
    console.log(JSON.stringify({
      event: 'kv_write',
      category,
      ...(locationId === undefined ? {} : { locationId }),
      ...(rawMarineCoverage === undefined ? {} : rawMarineCoverage),
    }));
  } catch {
    // A logging failure cannot undo the KV write that has already completed.
  }
}
