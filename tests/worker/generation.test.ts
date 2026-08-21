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
  versionedForecastRoute,
} from '../../worker/generation';

const LOCATION = { id: 'horsens', forecastConfigRevision: 1 };

describe('release generation identity and storage isolation', () => {
  it('keeps the independent release identities explicit', () => {
    expect(RELEASE_IDENTITY).toMatchObject({
      apiSchemaVersion: 1,
      modelRevision: 11,
      assembledCacheSchema: 1,
      marineCacheSchema: 1,
      dataGenerationId: 'api1-model11',
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
      'frank:forecast-release:api:v1:model:v11:generation:api1-model11:payload:v7:assembled-cache:v1:marine-cache:v1',
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
    expect(rawKeys.every((key) => key.startsWith('frank:raw:'))).toBe(true);
    expect(rawKeys.some((key) => key.startsWith('frank:forecast-release:'))).toBe(false);

    expect(metRawKey(LOCATION)).toBe(
      'frank:raw:met:v1:location:horsens:config:v1',
    );
    expect(marineIngredientKey(LOCATION, 'water')).toBe(
      'frank:raw:marine:v1:water:location:horsens:config:v1',
    );
    expect(marineIngredientKey(LOCATION, 'waves')).toBe(
      'frank:raw:marine:v1:waves:location:horsens:config:v1',
    );
  });

  // An ingredient schema bump lands in a fresh KV key, so the new format is
  // isolated by construction. The old generation keeps reading its own schema;
  // nothing gets reinterpreted across a boundary.
  it('retires raw ingredients only through their own envelope schema version', () => {
    const defaultWater = marineIngredientKey(LOCATION, 'water');
    expect(defaultWater).toContain(':marine:v1:water:');
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
    expect(new Set([...revisionOneKeys, ...revisionTwoKeys]).size)
      .toBe(revisionOneKeys.length + revisionTwoKeys.length);
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
    expect(versionedForecastRoute('/api/v2/forecast/horsens')).toBeNull();
    expect(versionedForecastRoute('/forecast/horsens')).toBeNull();
  });
});
