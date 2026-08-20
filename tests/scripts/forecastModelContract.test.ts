// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  FORECAST_SEMANTIC_INPUT_FILES,
  assertRecordableForecastModelTransition,
  describeForecastModelDiff,
} from '../../scripts/forecast-model-contract.mjs';

const RELEASE_V7 = Object.freeze({
  apiSchemaVersion: 1,
  modelRevision: 7,
  assembledCacheSchema: 1,
  marineCacheSchema: 1,
  dataGenerationId: 'api1-model7',
  payloadVersion: 7,
});

const RELEASE_V8 = Object.freeze({
  ...RELEASE_V7,
  modelRevision: 8,
  dataGenerationId: 'api1-model8',
  payloadVersion: 8,
});

const hash = (character: string) => character.repeat(64);

function semanticInputs(overrides: Record<string, string> = {}) {
  return Object.fromEntries(FORECAST_SEMANTIC_INPUT_FILES.map((file) => [
    file,
    overrides[file] ?? hash('a'),
  ]));
}

function snapshot({
  release = RELEASE_V7,
  inputs = semanticInputs(),
  locations = [{ id: 'horsens', forecastConfigRevision: 1, inputHash: hash('b') }],
} = {}) {
  return {
    schemaVersion: 1,
    release: { ...release },
    semanticInputs: inputs,
    locations: locations.map((location) => ({ ...location })),
  };
}

describe('forecast model release guard', () => {
  it('accepts an unchanged recorded model', () => {
    const baseline = snapshot();
    expect(assertRecordableForecastModelTransition({
      baseline,
      current: snapshot(),
      auditedPreviousReleases: [],
    })).toEqual({
      releaseChanged: false,
      changedSemanticInputs: [],
      addedLocations: [],
      removedLocations: [],
      changedLocations: [],
      revisionOnlyLocations: [],
    });
  });

  it('requires a new model revision and generation for forecast-producing code', () => {
    const changedInputs = semanticInputs({
      [FORECAST_SEMANTIC_INPUT_FILES[0]]: hash('c'),
    });
    expect(() => assertRecordableForecastModelTransition({
      baseline: snapshot(),
      current: snapshot({ inputs: changedInputs }),
      auditedPreviousReleases: [],
    })).toThrow('advance FORECAST_MODEL_REVISION and FORECAST_DATA_GENERATION_ID');
  });

  it('records an intentional model advance only with the exact previous descriptor', () => {
    const changedInputs = semanticInputs({
      [FORECAST_SEMANTIC_INPUT_FILES[0]]: hash('c'),
    });
    expect(() => assertRecordableForecastModelTransition({
      baseline: snapshot(),
      current: snapshot({ release: RELEASE_V8, inputs: changedInputs }),
      auditedPreviousReleases: [],
    })).toThrow('previous full release descriptor');

    expect(assertRecordableForecastModelTransition({
      baseline: snapshot(),
      current: snapshot({ release: RELEASE_V8, inputs: changedInputs }),
      auditedPreviousReleases: [RELEASE_V7],
    }).changedSemanticInputs).toEqual([FORECAST_SEMANTIC_INPUT_FILES[0]]);
  });

  it('allows a new unique location at revision one without cooling existing cities', () => {
    const current = snapshot({
      locations: [
        { id: 'horsens', forecastConfigRevision: 1, inputHash: hash('b') },
        { id: 'odense', forecastConfigRevision: 1, inputHash: hash('d') },
      ],
    });
    expect(assertRecordableForecastModelTransition({
      baseline: snapshot(),
      current,
      auditedPreviousReleases: [],
    }).addedLocations).toEqual(['odense']);
  });

  it('requires a per-location revision when existing provider inputs change', () => {
    const changedWithoutRevision = snapshot({
      locations: [{ id: 'horsens', forecastConfigRevision: 1, inputHash: hash('d') }],
    });
    expect(() => assertRecordableForecastModelTransition({
      baseline: snapshot(),
      current: changedWithoutRevision,
      auditedPreviousReleases: [],
    })).toThrow('increase its forecastConfigRevision');

    const changedWithRevision = snapshot({
      locations: [{ id: 'horsens', forecastConfigRevision: 2, inputHash: hash('d') }],
    });
    expect(assertRecordableForecastModelTransition({
      baseline: snapshot(),
      current: changedWithRevision,
      auditedPreviousReleases: [],
    }).changedLocations).toEqual(['horsens']);
  });

  it('fails closed when a public location id disappears', () => {
    const baseline = snapshot({
      locations: [
        { id: 'horsens', forecastConfigRevision: 1, inputHash: hash('b') },
        { id: 'vejle', forecastConfigRevision: 1, inputHash: hash('c') },
      ],
    });
    expect(() => assertRecordableForecastModelTransition({
      baseline,
      current: snapshot(),
      auditedPreviousReleases: [],
    })).toThrow('cannot be removed or reused');
  });

  it('reports revision-only rebuilds separately from input changes', () => {
    expect(describeForecastModelDiff(snapshot(), snapshot({
      locations: [{ id: 'horsens', forecastConfigRevision: 2, inputHash: hash('b') }],
    })).revisionOnlyLocations).toEqual(['horsens']);
  });
});
