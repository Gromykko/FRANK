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

const LOCATION = { id: 'horsens' };

describe('release generation identity and storage isolation', () => {
  it('keeps the independent release identities explicit', () => {
    expect(RELEASE_IDENTITY).toMatchObject({
      apiSchemaVersion: 1,
      modelRevision: 7,
      assembledCacheSchema: 1,
      marineCacheSchema: 1,
      dataGenerationId: 'api1-model7',
      payloadVersion: 7,
      metRawCacheSchemaVersion: 1,
      initializationStateSchemaVersion: 1,
    });
  });

  it('puts every candidate-mutated KV object inside its immutable generation', () => {
    const mutableKeys = [
      assembledForecastKey(LOCATION),
      metRawKey(LOCATION),
      marineIngredientKey(LOCATION, 'water'),
      marineIngredientKey(LOCATION, 'waves'),
      initializationStateKey(LOCATION),
    ];

    expect(mutableKeys).toHaveLength(new Set(mutableKeys).size);
    expect(mutableKeys.every((key) => key.startsWith(`${generationKeyPrefix(CURRENT_RELEASE)}:`)))
      .toBe(true);
    expect(generationKeyPrefix(CURRENT_RELEASE)).toBe(
      'frank:forecast-release:api:v1:model:v7:generation:api1-model7:payload:v7:assembled-cache:v1:marine-cache:v1',
    );
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

  it('can locate an explicitly audited N-1 generation with its own cache schema', () => {
    const previous = {
      ...CURRENT_RELEASE,
      modelRevision: 6,
      assembledCacheSchema: 4,
      dataGenerationId: 'api1-model6',
    };

    expect(assembledForecastKeyForRelease(previous, LOCATION)).toBe(
      'frank:forecast-release:api:v1:model:v6:generation:api1-model6:payload:v7:assembled-cache:v4:marine-cache:v1:forecast:assembled:location:horsens',
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
