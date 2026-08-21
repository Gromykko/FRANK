import { describe, expect, it } from 'vitest';
import { CURRENT_RELEASE } from '../../src/features/forecast/releaseContract';
import {
  RELEASE_IDENTITY,
  assembledForecastKey,
  assembledForecastKeyForRelease,
  generationKeyPrefix,
  initializationStateKey,
  marineIngredientKey,
  metRawKey,
  releaseForApiSchemaVersion,
  selectReleaseForApiSchemaVersion,
  versionedForecastRoute,
} from '../../worker/generation';

const LOCATION = { id: 'horsens', forecastConfigRevision: 1 };

describe('release generation identity and storage isolation', () => {
  it('keeps the independent release identities explicit', () => {
    expect(RELEASE_IDENTITY).toMatchObject({
      apiSchemaVersion: 1,
      modelRevision: 9,
      assembledCacheSchema: 1,
      marineCacheSchema: 1,
      dataGenerationId: 'api1-model9',
      payloadVersion: 7,
      metRawCacheSchemaVersion: 1,
      initializationStateSchemaVersion: 2,
    });
  });

  it('keeps every DERIVED KV object inside its immutable generation', () => {
    const derivedKeys = [
      assembledForecastKey(LOCATION),
      initializationStateKey(LOCATION),
    ];

    expect(derivedKeys).toHaveLength(new Set(derivedKeys).size);
    expect(derivedKeys.every((key) => key.startsWith(`${generationKeyPrefix(CURRENT_RELEASE)}:`)))
      .toBe(true);
    expect(generationKeyPrefix(CURRENT_RELEASE)).toBe(
      'frank:forecast-release:api:v1:model:v9:generation:api1-model9:payload:v7:assembled-cache:v1:marine-cache:v1',
    );
  });

  // The whole point of the raw layer: a candidate on a brand new model revision
  // addresses the exact same ingredients production is already filling, so it
  // can assemble immediately instead of re-fetching every provider from cold.
  it('keeps every RAW ingredient outside the generation, shared across releases', () => {
    const rawKeys = [
      metRawKey(LOCATION),
      marineIngredientKey(LOCATION, 'water'),
      marineIngredientKey(LOCATION, 'waves'),
    ];

    expect(rawKeys).toHaveLength(new Set(rawKeys).size);
    expect(rawKeys.some((key) => key.startsWith('frank:forecast-release:'))).toBe(false);
    expect(rawKeys.some((key) => key.includes(String(CURRENT_RELEASE.modelRevision)))).toBe(false);
    expect(rawKeys.some((key) => key.includes(CURRENT_RELEASE.dataGenerationId))).toBe(false);

    expect(rawKeys).toEqual([
      'frank:raw:met:v1:location:horsens:config:v1',
      'frank:raw:marine:v1:water:location:horsens:config:v1',
      'frank:raw:marine:v1:waves:location:horsens:config:v1',
    ]);
  });

  // A raw ingredient is read by code from other releases, so its own envelope
  // schema is the only thing that may retire it. Both roots must move together
  // when a schema is bumped, or a stale ingredient survives under a live key.
  it('retires raw ingredients only through their own envelope schema version', () => {
    const bumpedMarine = { ...CURRENT_RELEASE, marineCacheSchema: CURRENT_RELEASE.marineCacheSchema + 1 };

    expect(marineIngredientKey(LOCATION, 'water')).toContain(
      `:marine:v${CURRENT_RELEASE.marineCacheSchema}:`,
    );
    expect(metRawKey(LOCATION)).toContain(`:met:v${RELEASE_IDENTITY.metRawCacheSchemaVersion}:`);
    // Bumping the marine schema must also retire everything assembled from it.
    expect(generationKeyPrefix(bumpedMarine)).not.toBe(generationKeyPrefix(CURRENT_RELEASE));
  });

  it('changes the KV namespace when any release axis changes even if the label is forgotten', () => {
    const unchangedLabel = {
      ...CURRENT_RELEASE,
      dataGenerationId: 'forgotten:id/with space',
    };
    const releases = [
      unchangedLabel,
      { ...unchangedLabel, apiSchemaVersion: unchangedLabel.apiSchemaVersion + 1 },
      { ...unchangedLabel, modelRevision: unchangedLabel.modelRevision + 1 },
      { ...unchangedLabel, payloadVersion: unchangedLabel.payloadVersion + 1 },
      { ...unchangedLabel, assembledCacheSchema: unchangedLabel.assembledCacheSchema + 1 },
      { ...unchangedLabel, marineCacheSchema: unchangedLabel.marineCacheSchema + 1 },
      { ...unchangedLabel, dataGenerationId: `${unchangedLabel.dataGenerationId}-next` },
    ];
    const keys = releases.map((release) => assembledForecastKeyForRelease(release, LOCATION));

    expect(new Set(keys).size).toBe(releases.length);
    expect(keys[0]).toContain('generation:forgotten%3Aid%2Fwith%20space:');
  });

  it('isolates every location-scoped KV object when forecast-bearing config changes', () => {
    const revisedLocation = { ...LOCATION, forecastConfigRevision: 2 };
    const keysFor = (location: typeof LOCATION) => [
      assembledForecastKey(location),
      metRawKey(location),
      marineIngredientKey(location, 'water'),
      marineIngredientKey(location, 'waves'),
      initializationStateKey(location),
    ];

    const revisionOneKeys = keysFor(LOCATION);
    const revisionTwoKeys = keysFor(revisedLocation);

    expect(revisionOneKeys.every((key) => key.endsWith(':location:horsens:config:v1')))
      .toBe(true);
    expect(revisionTwoKeys.every((key) => key.endsWith(':location:horsens:config:v2')))
      .toBe(true);
    expect(new Set([...revisionOneKeys, ...revisionTwoKeys]).size).toBe(10);
  });

  it('accepts revision 1 for a new location and rejects invalid config revisions', () => {
    expect(assembledForecastKey({ id: 'new-fjord', forecastConfigRevision: 1 }))
      .toContain(':location:new-fjord:config:v1');
    expect(() => assembledForecastKey({ id: 'horsens', forecastConfigRevision: 0 }))
      .toThrow(/invalid forecast config revision/i);
  });

  it('can locate an explicitly audited N-1 generation with its own cache schema', () => {
    const previous = {
      ...CURRENT_RELEASE,
      modelRevision: 6,
      assembledCacheSchema: 4,
      dataGenerationId: 'api1-model6',
    };

    expect(assembledForecastKeyForRelease(previous, LOCATION)).toBe(
      'frank:forecast-release:api:v1:model:v6:generation:api1-model6:payload:v7:assembled-cache:v4:marine-cache:v1:forecast:assembled:location:horsens:config:v1',
    );
  });

  it('resolves only supported API routes to their exact release descriptor', () => {
    expect(versionedForecastRoute('/api/v1/forecast/horsens')).toEqual({
      locationId: 'horsens',
      release: CURRENT_RELEASE,
    });
    expect(releaseForApiSchemaVersion(1)).toBe(CURRENT_RELEASE);
    expect(versionedForecastRoute('/api/v2/forecast/horsens')).toBeNull();
    expect(versionedForecastRoute('/forecast/horsens')).toBeNull();
  });

  it('selects an audited v1 generation when a future breaking v2 is current', () => {
    const previousV1 = { ...CURRENT_RELEASE, dataGenerationId: 'api1-model7' };
    const futureV2 = {
      ...CURRENT_RELEASE,
      apiSchemaVersion: 2,
      modelRevision: 8,
      dataGenerationId: 'api2-model8',
    };
    expect(selectReleaseForApiSchemaVersion(2, [1, 2], futureV2, [previousV1]))
      .toBe(futureV2);
    expect(selectReleaseForApiSchemaVersion(1, [1, 2], futureV2, [previousV1]))
      .toBe(previousV1);
  });

});
