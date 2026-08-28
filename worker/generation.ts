import type { ForecastLocation } from '../src/config/locationTypes';
import {
  CURRENT_FORECAST_RELEASE,
  FORECAST_API_SCHEMA_VERSION,
  FORECAST_RELEASE_HEADERS,
  MARINE_INGREDIENT_CACHE_SCHEMA_VERSION,
} from '../src/features/forecast/releaseContract';
import type { ForecastReleaseMetadata } from '../src/features/forecast/releaseContract';
import type { ForecastData, MarineKind } from './domain';
import { isRecord } from './validation';

// These storage schemas are Worker-internal and deliberately independent of
// both the public API and the forecast model. Each is named in the key for the
// object it governs so format changes cannot reinterpret older bytes.
const MET_RAW_CACHE_SCHEMA_VERSION = 1;
export const INITIALIZATION_STATE_SCHEMA_VERSION = 2;

type StorageReleaseIdentity = Pick<
  ForecastReleaseMetadata,
  | 'apiSchemaVersion'
  | 'modelRevision'
  | 'dataGenerationId'
  | 'payloadVersion'
  | 'assembledCacheSchema'
  | 'marineCacheSchema'
>;

// Storage has exactly two layers.
//
//   frank:raw:...              provider truth. Shared by every app version.
//   frank:forecast-release:... everything this release DERIVED from that truth.
//
// The raw layer holds what the providers said, which no forecast model can
// change. It is therefore keyed only by its own envelope schema and the
// location's config revision, never by the release identity, so a freshly
// deployed candidate reads the running production ingredients and can assemble
// its first forecast on the very next cron tick instead of re-fetching every
// provider from cold. `generationKeyPrefix` below governs the derived layer.
//
// A maintainer-controlled generation label is useful for humans, but it is
// not a safe namespace by itself: forgetting to update it must never let a
// candidate overwrite production bytes. Derive storage identity from every
// independent release axis, and encode the free-form label so it cannot add
// accidental key segments.
export function generationKeyPrefix(release: StorageReleaseIdentity): string {
  return [
    'frank:forecast-release',
    `api:v${release.apiSchemaVersion}`,
    `model:v${release.modelRevision}`,
    `generation:${encodeURIComponent(release.dataGenerationId)}`,
    `payload:v${release.payloadVersion}`,
    `assembled-cache:v${release.assembledCacheSchema}`,
    // Also an axis of the derived layer: an assembled forecast is only valid
    // for the marine normalization it was built from, so bumping the marine
    // schema must retire the assembled bytes as well as the raw ingredients.
    `marine-cache:v${release.marineCacheSchema}`,
  ].join(':');
}

const GENERATION_KEY_PREFIX = generationKeyPrefix(CURRENT_FORECAST_RELEASE);

type CacheLocationIdentity = Pick<ForecastLocation, 'id' | 'forecastConfigRevision'>;

function locationKeySuffix(location: CacheLocationIdentity): string {
  if (!Number.isSafeInteger(location.forecastConfigRevision)
    || location.forecastConfigRevision < 1) {
    throw new Error(`Invalid forecast config revision for location ${location.id}.`);
  }
  return `location:${location.id}:config:v${location.forecastConfigRevision}`;
}

export const RELEASE_HEADER = FORECAST_RELEASE_HEADERS;

export function assembledForecastKey(location: CacheLocationIdentity): string {
  return assembledForecastKeyForRelease(CURRENT_FORECAST_RELEASE, location);
}

export function assembledForecastKeyForRelease(
  release: StorageReleaseIdentity,
  location: CacheLocationIdentity,
): string {
  return `${generationKeyPrefix(release)}:forecast:assembled:${locationKeySuffix(location)}`;
}

// Root of the shared raw layer. Deliberately not under the generation root, so
// `scripts/gc-worker-kv.mjs` — which only ever lists `frank:forecast-release:` —
// cannot mistake a live ingredient for an abandoned generation's leftovers.
// ponytail: the flip side is that nothing sweeps this root either, so a bumped
// ingredient schema or a retired forecastConfigRevision strands its old keys.
// That is 3 keys per location per bump against a 1 GB namespace; teach the GC
// script a second prefix only if the schemas ever start moving regularly.
const RAW_INGREDIENT_KEY_ROOT = 'frank:raw';

// MET's stored body is the provider response verbatim, so only the envelope
// shape can ever go stale. Sharing it also keeps the conditional-request
// contract intact: MET's terms require repeat requests to carry the
// If-Modified-Since they last received, and a per-generation copy would make
// every deployment re-request every location unconditionally.
export function metRawKey(location: CacheLocationIdentity): string {
  return `${RAW_INGREDIENT_KEY_ROOT}:met:v${MET_RAW_CACHE_SCHEMA_VERSION}:${locationKeySuffix(location)}`;
}

// The marine ingredient is DMI's run mapped to our series shape, so unlike MET
// it is app-shaped output: a release that changed the mapping would be handing
// its own dialect to every other release reading this key.
// MARINE_INGREDIENT_CACHE_SCHEMA_VERSION is the guard, and it is in the key, so
// a bump lands the new format in a new namespace instead of reinterpreting
// bytes. Bumping it is a judgement call, not an enforced one - see the constant
// for when it is actually owed. What keeps the unbumped case survivable is that
// every marine field is optional on SeriesPoint, so a reader from either side
// of a mapping change sees a missing field for one cycle, never a wrong one.
export function marineIngredientKey(
  location: CacheLocationIdentity,
  kind: MarineKind,
): string {
  return `${RAW_INGREDIENT_KEY_ROOT}:marine:v${MARINE_INGREDIENT_CACHE_SCHEMA_VERSION}:${kind}:${locationKeySuffix(location)}`;
}

export function initializationStateKey(location: CacheLocationIdentity): string {
  return `${GENERATION_KEY_PREFIX}:state:initialization:v${INITIALIZATION_STATE_SCHEMA_VERSION}:${locationKeySuffix(location)}`;
}

export interface VersionedForecastRoute {
  locationId: string;
  release: Readonly<ForecastReleaseMetadata>;
}

// The version is matched rather than embedded in the route expression so a
// future breaking /api/vN is a route this Worker knowingly declines, not an
// unrecognized path.
export function versionedForecastRoute(pathname: string): VersionedForecastRoute | null {
  const normalized = pathname.replace(/\/+$/, '') || '/';
  const match = normalized.match(/^\/api\/v([1-9][0-9]*)\/forecast\/([a-z0-9-]+)$/);
  if (!match || Number(match[1]) !== FORECAST_API_SCHEMA_VERSION) return null;
  return { locationId: match[2], release: CURRENT_FORECAST_RELEASE };
}

function hasReleaseMetadata(
  value: unknown,
  expected: ForecastReleaseMetadata,
): value is ForecastReleaseMetadata {
  if (!isRecord(value)) return false;
  return value.apiSchemaVersion === expected.apiSchemaVersion
    && value.modelRevision === expected.modelRevision
    && value.dataGenerationId === expected.dataGenerationId
    && value.assembledCacheSchema === expected.assembledCacheSchema
    && value.marineCacheSchema === expected.marineCacheSchema
    && value.payloadVersion === expected.payloadVersion;
}

export function isForecastForRelease(
  data: ForecastData,
  release: Readonly<ForecastReleaseMetadata>,
): boolean {
  return data.sources.payloadVersion === release.payloadVersion
    && hasReleaseMetadata(data.sources.release, release);
}

function exposeReleaseHeaders(response: Response): void {
  const existing = response.headers.get('Access-Control-Expose-Headers');
  const names = Object.values(RELEASE_HEADER);
  const exposed = new Set(
    `${existing ?? ''},${names.join(',')}`
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
  );
  response.headers.set('Access-Control-Expose-Headers', [...exposed].join(', '));
}

export function withReleaseHeaders(
  response: Response,
  options: {
    ready?: boolean;
    payloadVersion?: number;
    release?: Readonly<ForecastReleaseMetadata>;
  } = {},
): Response {
  const release = options.release ?? CURRENT_FORECAST_RELEASE;
  const forceRelease = options.release !== undefined;
  const setReleaseHeader = (name: string, value: string): void => {
    if (forceRelease || !response.headers.has(name)) response.headers.set(name, value);
  };
  setReleaseHeader(RELEASE_HEADER.apiSchema, String(release.apiSchemaVersion));
  setReleaseHeader(RELEASE_HEADER.modelRevision, String(release.modelRevision));
  setReleaseHeader(RELEASE_HEADER.dataGeneration, release.dataGenerationId);
  setReleaseHeader(
    RELEASE_HEADER.assembledCacheSchema,
    String(release.assembledCacheSchema),
  );
  setReleaseHeader(RELEASE_HEADER.marineCacheSchema, String(release.marineCacheSchema));
  if (options.payloadVersion !== undefined
    || !response.headers.has(RELEASE_HEADER.payloadVersion)) {
    response.headers.set(
      RELEASE_HEADER.payloadVersion,
      String(options.payloadVersion ?? release.payloadVersion),
    );
  }
  if (options.ready !== undefined) {
    response.headers.set(RELEASE_HEADER.generationReady, String(options.ready));
  }
  exposeReleaseHeaders(response);
  return response;
}

export const RELEASE_IDENTITY = Object.freeze({
  ...CURRENT_FORECAST_RELEASE,
  metRawCacheSchemaVersion: MET_RAW_CACHE_SCHEMA_VERSION,
  initializationStateSchemaVersion: INITIALIZATION_STATE_SCHEMA_VERSION,
});
