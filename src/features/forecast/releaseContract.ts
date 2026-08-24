// Release identities deliberately have different lifetimes. Changing an
// internal cache format must not make an otherwise compatible browser reject
// the public forecast API, and rebuilding the same model must not look like a
// new software contract.
export const FORECAST_API_SCHEMA_VERSION = 1;
export const SUPPORTED_FORECAST_API_SCHEMA_VERSIONS = [1] as const;
export const FORECAST_MODEL_REVISION = 41;
export const ASSEMBLED_FORECAST_CACHE_SCHEMA_VERSION = 1;

// Unlike the versions above, this one is a CROSS-RELEASE contract, not a
// private cache tag: the marine ingredient lives in the shared raw layer
// (`frank:raw:marine:v<this>:...`), so a candidate and the production version
// it is shadowing read and write the same objects. Bump it whenever the stored
// series changes meaning — different units, a different point spacing, a
// renamed field. Adding an optional field does not need a bump, because every
// marine field is already optional on SeriesPoint and a reader that predates it
// simply ignores it. Bumping moves both the raw key and the generation prefix,
// which retires the ingredients and everything assembled from them together.
export const MARINE_INGREDIENT_CACHE_SCHEMA_VERSION = 1;

// Compiled into an immutable Worker version. A serious model release writes a
// new generation in parallel, proves every public location is complete, and
// only then receives production traffic. Never replace this with an eventually
// consistent KV "active generation" pointer.
export const FORECAST_DATA_GENERATION_ID = 'api1-model41';

// `payloadVersion` is the historical browser/Worker payload stamp. It remains
// independent from the API, model and storage identities, but there is no
// pre-launch client-compatibility bridge: the canonical baseline is v7.
// Future breaking APIs get a new /api/vN route.
export const LEGACY_FORECAST_PAYLOAD_VERSION = 7;
export const SUPPORTED_LEGACY_FORECAST_PAYLOAD_VERSIONS = [7] as const;

export interface ReleaseMetadata {
  apiSchemaVersion: number;
  modelRevision: number;
  assembledCacheSchema: number;
  marineCacheSchema: number;
  dataGenerationId: string;
  payloadVersion: number;
}

export const FORECAST_RELEASE_HEADERS = Object.freeze({
  apiSchema: 'X-FRANK-API-Schema',
  modelRevision: 'X-FRANK-Model-Revision',
  dataGeneration: 'X-FRANK-Data-Generation',
  assembledCacheSchema: 'X-FRANK-Assembled-Cache-Schema',
  marineCacheSchema: 'X-FRANK-Marine-Cache-Schema',
  payloadVersion: 'X-FRANK-Payload-Version',
  generationReady: 'X-FRANK-Generation-Ready',
} as const);

export type ForecastReleaseMetadata = ReleaseMetadata;

// Rollback retention, not compatibility. Nothing serves these bytes: a request
// for a location this generation has not assembled yet gets the typed
// initializing 503, never a verdict computed by the model revision we just
// replaced. What the list does is tell `scripts/gc-worker-kv.mjs` which
// generation prefix it may not sweep, so `wrangler versions deploy <previous>`
// lands on warm KV instead of a cold namespace. The full descriptor is required
// because the previous generation's internal assembled schema may differ.
// scripts/forecast-model-contract.mjs refuses to record a new release until the
// outgoing one is listed here, which is what makes the retention deliberate.
export const AUDITED_PREVIOUS_FORECAST_GENERATIONS: readonly Readonly<ReleaseMetadata>[] = Object.freeze([
  Object.freeze({
    apiSchemaVersion: 1,
    modelRevision: 40,
    assembledCacheSchema: 1,
    marineCacheSchema: 1,
    dataGenerationId: 'api1-model40',
    payloadVersion: 7,
  }),
]);

export const CURRENT_RELEASE: Readonly<ReleaseMetadata> = Object.freeze({
  apiSchemaVersion: FORECAST_API_SCHEMA_VERSION,
  modelRevision: FORECAST_MODEL_REVISION,
  assembledCacheSchema: ASSEMBLED_FORECAST_CACHE_SCHEMA_VERSION,
  marineCacheSchema: MARINE_INGREDIENT_CACHE_SCHEMA_VERSION,
  dataGenerationId: FORECAST_DATA_GENERATION_ID,
  payloadVersion: LEGACY_FORECAST_PAYLOAD_VERSION,
});

export const CURRENT_FORECAST_RELEASE = CURRENT_RELEASE;

export function isSupportedLegacyForecastPayloadVersion(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && (SUPPORTED_LEGACY_FORECAST_PAYLOAD_VERSIONS as readonly number[]).includes(value);
}

export function isSupportedForecastApiSchemaVersion(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && (SUPPORTED_FORECAST_API_SCHEMA_VERSIONS as readonly number[]).includes(value);
}

export function forecastApiPath(locationId: string): string {
  return `/api/v${FORECAST_API_SCHEMA_VERSION}/forecast/${locationId}`;
}

export function supportedForecastApiPaths(locationId: string): string[] {
  return [...SUPPORTED_FORECAST_API_SCHEMA_VERSIONS]
    .sort((left, right) => right - left)
    .map((version) => `/api/v${version}/forecast/${locationId}`);
}
