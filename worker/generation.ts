import type { ForecastLocation } from '../src/config/locationTypes';
import {
  AUDITED_PREVIOUS_FORECAST_GENERATIONS,
  CURRENT_FORECAST_RELEASE,
  FORECAST_RELEASE_HEADERS,
  SUPPORTED_FORECAST_API_SCHEMA_VERSIONS,
} from '../src/features/forecast/releaseContract';
import type { ForecastReleaseMetadata } from '../src/features/forecast/releaseContract';
import type { ForecastData, MarineKind } from './domain';
import { isRecord } from './validation';

// These storage schemas are Worker-internal and deliberately independent of
// both the public API and the forecast model. Each is named in the key for the
// object it governs so format changes cannot reinterpret older bytes.
export const MET_RAW_CACHE_SCHEMA_VERSION = 1;
export const INITIALIZATION_STATE_SCHEMA_VERSION = 1;

type StorageReleaseIdentity = Pick<
  ForecastReleaseMetadata,
  | 'apiSchemaVersion'
  | 'modelRevision'
  | 'dataGenerationId'
  | 'payloadVersion'
  | 'assembledCacheSchema'
  | 'marineCacheSchema'
>;

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
    `marine-cache:v${release.marineCacheSchema}`,
  ].join(':');
}

const GENERATION_KEY_PREFIX = generationKeyPrefix(CURRENT_FORECAST_RELEASE);

export const RELEASE_HEADER = FORECAST_RELEASE_HEADERS;

export function assembledForecastKey(location: Pick<ForecastLocation, 'id'>): string {
  return assembledForecastKeyForRelease(CURRENT_FORECAST_RELEASE, location);
}

export function assembledForecastKeyForRelease(
  release: StorageReleaseIdentity,
  location: Pick<ForecastLocation, 'id'>,
): string {
  return `${generationKeyPrefix(release)}:forecast:assembled:location:${location.id}`;
}

export function metRawKey(location: Pick<ForecastLocation, 'id'>): string {
  return `${GENERATION_KEY_PREFIX}:ingredient:met-raw:v${MET_RAW_CACHE_SCHEMA_VERSION}:location:${location.id}`;
}

export function marineIngredientKey(
  location: Pick<ForecastLocation, 'id'>,
  kind: MarineKind,
): string {
  return `${GENERATION_KEY_PREFIX}:ingredient:marine:${kind}:location:${location.id}`;
}

export function initializationStateKey(location: Pick<ForecastLocation, 'id'>): string {
  return `${GENERATION_KEY_PREFIX}:state:initialization:v${INITIALIZATION_STATE_SCHEMA_VERSION}:location:${location.id}`;
}

export interface VersionedForecastRoute {
  locationId: string;
  release: Readonly<ForecastReleaseMetadata>;
}

export function selectReleaseForApiSchemaVersion(
  apiSchemaVersion: number,
  supportedApiSchemaVersions: readonly number[],
  currentRelease: Readonly<ForecastReleaseMetadata>,
  auditedPreviousGenerations: readonly Readonly<ForecastReleaseMetadata>[],
): Readonly<ForecastReleaseMetadata> | null {
  if (!Number.isInteger(apiSchemaVersion)
    || !supportedApiSchemaVersions.includes(apiSchemaVersion)) return null;
  if (currentRelease.apiSchemaVersion === apiSchemaVersion) return currentRelease;
  return auditedPreviousGenerations.find(
    (release) => release.apiSchemaVersion === apiSchemaVersion,
  ) ?? null;
}

export function releaseForApiSchemaVersion(
  apiSchemaVersion: number,
): Readonly<ForecastReleaseMetadata> | null {
  return selectReleaseForApiSchemaVersion(
    apiSchemaVersion,
    SUPPORTED_FORECAST_API_SCHEMA_VERSIONS,
    CURRENT_FORECAST_RELEASE,
    AUDITED_PREVIOUS_FORECAST_GENERATIONS,
  );
}

export function versionedForecastRoute(pathname: string): VersionedForecastRoute | null {
  const normalized = pathname.replace(/\/+$/, '') || '/';
  const match = normalized.match(/^\/api\/v([1-9][0-9]*)\/forecast\/([a-z0-9-]+)$/);
  if (!match) return null;
  const release = releaseForApiSchemaVersion(Number(match[1]));
  return release ? { locationId: match[2], release } : null;
}

export function hasReleaseMetadata(
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

export const AUDITED_PREVIOUS_GENERATIONS = AUDITED_PREVIOUS_FORECAST_GENERATIONS;
