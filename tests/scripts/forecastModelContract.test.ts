// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import locationData from '../../src/config/locations.json';
import { CURRENT_RELEASE } from '../../src/features/forecast/releaseContract';
import {
  FORECAST_SEMANTIC_BOUNDARY_ID,
  FORECAST_SEMANTIC_INPUT_FILES,
  FORECAST_OPERATIONAL_INPUT_FILES,
  assertForecastSemanticBoundary,
  assertForecastModelBaseline,
  assertRecordableForecastModelTransition,
  buildForecastModelSnapshot,
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
    schemaVersion: 2,
    semanticBoundary: FORECAST_SEMANTIC_BOUNDARY_ID,
    release: { ...release },
    semanticInputs: inputs,
    locations: locations.map((location) => ({ ...location })),
  };
}

describe('forecast model release guard', () => {
  it('enforces the generation-owned/operational module boundary', async () => {
    await expect(assertForecastSemanticBoundary()).resolves.toMatchObject({
      id: FORECAST_SEMANTIC_BOUNDARY_ID,
      operationalFiles: FORECAST_OPERATIONAL_INPUT_FILES,
    });
  });

  it('fails closed if model code imports transport or transport duplicates model policy', async () => {
    const mutatingReader = (mutate: (fileName: string, source: string) => string) =>
      async (fileName: string) => mutate(fileName.replaceAll('\\', '/'), await readFile(fileName, 'utf8'));

    await expect(assertForecastSemanticBoundary({
      readFileImpl: mutatingReader((fileName, source) => fileName.endsWith('/worker/forecastModel.ts')
        ? `${source}\nimport './providerTransport';\n`
        : source),
    })).rejects.toThrow('cannot import operational module');

    await expect(assertForecastSemanticBoundary({
      readFileImpl: mutatingReader((fileName, source) => fileName.endsWith('/worker/providerTransport.ts')
        ? `${source}\nconst FORECAST_SOURCE_POLICY = {};\n`
        : source),
    })).rejects.toThrow('duplicates generation-owned policy');
  });

  it('allows transport-only changes but rejects protected source wiring at model7', async () => {
    const mutatingReader = (target: string) => async (fileName: string) => {
      const source = await readFile(fileName, 'utf8');
      return fileName.replaceAll('\\', '/').endsWith(target)
        ? `${source}\nexport const RELEASE_BOUNDARY_MUTATION = 1;\n`
        : source;
    };
    await expect(assertForecastModelBaseline({
      release: CURRENT_RELEASE,
      locations: locationData,
      readFileImpl: mutatingReader('/worker/providerTransport.ts'),
    })).resolves.toMatchObject({
      semanticBoundary: FORECAST_SEMANTIC_BOUNDARY_ID,
    });
    await expect(assertForecastModelBaseline({
      release: CURRENT_RELEASE,
      locations: locationData,
      readFileImpl: mutatingReader('/worker/providers.ts'),
    })).rejects.toThrow('Forecast model baseline is out of date (worker/providers.ts)');
  }, 15_000);

  // The guard's price is a model revision and a full generation rebuild, so it
  // must be charged for behaviour only. If a comment ever starts costing that,
  // the honest response is to stop writing comments, which is the opposite of
  // what these files need.
  it('fingerprints forecast behaviour and ignores comments', async () => {
    const snapshotWith = (readFileImpl?: typeof readFile) => buildForecastModelSnapshot({
      release: CURRENT_RELEASE,
      locations: locationData,
      ...(readFileImpl ? { readFileImpl } : {}),
    });
    const appendEverywhere = (suffix: string) => (async (fileName: string) =>
      `${await readFile(fileName, 'utf8')}${suffix}`) as unknown as typeof readFile;

    const base = await snapshotWith();

    const commented = await snapshotWith(appendEverywhere(`
// prose, not behaviour
`));
    expect(commented.semanticInputs).toEqual(base.semanticInputs);

    const reformatted = await snapshotWith(appendEverywhere(`


`));
    expect(reformatted.semanticInputs).toEqual(base.semanticInputs);

    const edited = await snapshotWith((async (fileName: string) => {
      const source = await readFile(fileName, 'utf8');
      return fileName.endsWith('generation.ts')
        ? `${source}
export const BEHAVIOUR_CHANGE = 1;
`
        : source;
    }) as unknown as typeof readFile);
    expect(edited.semanticInputs['worker/generation.ts'])
      .not.toBe(base.semanticInputs['worker/generation.ts']);
    expect(edited.semanticInputs['worker/providers.ts'])
      .toBe(base.semanticInputs['worker/providers.ts']);
  }, 15_000);

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
