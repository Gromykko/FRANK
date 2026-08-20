// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  classifyReleaseImpact,
  parseReleaseImpactArguments,
  runReleaseImpactCli,
} from '../../scripts/release-impact.mjs';

const BASE_SHA = 'a'.repeat(40);
const CANDIDATE_SHA = 'b'.repeat(40);
const hash = (character: string) => character.repeat(64);

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
});

interface SnapshotOptions {
  sourceSha?: string;
  provenance?: string;
  pagesBuildId?: string;
  workerRuntimeHash?: string;
  release?: typeof RELEASE_V7;
  supportedApiSchemaVersions?: number[];
  auditedPreviousReleases?: Array<typeof RELEASE_V7>;
  semanticInputs?: Record<string, string>;
  locations?: Array<{ id: string; forecastConfigRevision: number; inputHash: string }>;
}

function snapshot({
  sourceSha = CANDIDATE_SHA,
  provenance = 'candidate',
  pagesBuildId = 'pages-a',
  workerRuntimeHash = hash('c'),
  release = RELEASE_V7,
  supportedApiSchemaVersions = [1],
  auditedPreviousReleases = [],
  semanticInputs = { 'worker/forecast-model.ts': hash('d') },
  locations = [
    { id: 'horsens', forecastConfigRevision: 1, inputHash: hash('e') },
    { id: 'vejle', forecastConfigRevision: 1, inputHash: hash('f') },
  ],
}: SnapshotOptions = {}) {
  return {
    schemaVersion: 1,
    sourceSha,
    provenance,
    pagesBuildId,
    workerRuntimeHash,
    release: { ...release },
    supportedApiSchemaVersions: [...supportedApiSchemaVersions],
    auditedPreviousReleases: auditedPreviousReleases.map((entry) => ({ ...entry })),
    semanticInputs: { ...semanticInputs },
    locations: locations.map((location) => ({ ...location })),
  };
}

function base(overrides: SnapshotOptions = {}) {
  return snapshot({
    sourceSha: BASE_SHA,
    provenance: 'attested-production',
    ...overrides,
  });
}

function classify(candidate = snapshot(), trustedBase = base()) {
  return classifyReleaseImpact({
    trustedBase,
    candidate,
    trustedBaseSha: BASE_SHA,
    candidateSha: CANDIDATE_SHA,
  });
}

describe('release impact classification', () => {
  it('treats a source-SHA-only docs change as no production impact', () => {
    expect(classify()).toMatchObject({
      impact: 'none',
      automaticPromotionAllowed: true,
      warmLocationIds: [],
      locationChangeKind: 'none',
    });
  });

  it('fails closed without an exact attested production base and matching SHAs', () => {
    expect(() => classify(snapshot(), snapshot({
      sourceSha: BASE_SHA,
      provenance: 'candidate',
    }))).toThrow('not an attested production snapshot');

    expect(() => classifyReleaseImpact({
      trustedBase: base(),
      candidate: snapshot(),
      trustedBaseSha: '0'.repeat(40),
      candidateSha: CANDIDATE_SHA,
    })).toThrow('does not belong to the requested source SHA');

    expect(() => classifyReleaseImpact({
      trustedBase: base(),
      candidate: snapshot(),
      trustedBaseSha: BASE_SHA,
    })).toThrow('candidate expected source SHA');
  });

  it('distinguishes Pages-only and nonsemantic Worker changes by fingerprints', () => {
    expect(classify(snapshot({ pagesBuildId: 'pages-b' }))).toMatchObject({
      impact: 'pages-only',
      warmLocationIds: [],
    });
    expect(classify(snapshot({
      pagesBuildId: 'pages-b',
      workerRuntimeHash: hash('1'),
    }))).toMatchObject({
      impact: 'worker-nonsemantic',
      warmLocationIds: [],
    });
  });

  it('classifies an add-only city and warms only the new id', () => {
    const result = classify(snapshot({
      workerRuntimeHash: hash('1'),
      locations: [
        { id: 'horsens', forecastConfigRevision: 1, inputHash: hash('e') },
        { id: 'odense', forecastConfigRevision: 1, inputHash: hash('2') },
        { id: 'vejle', forecastConfigRevision: 1, inputHash: hash('f') },
      ],
    }));
    expect(result).toMatchObject({
      impact: 'location-change',
      locationChangeKind: 'add-only',
      addedLocationIds: ['odense'],
      changedLocationIds: [],
      removedLocationIds: [],
      warmLocationIds: ['odense'],
      automaticPromotionAllowed: true,
    });
  });

  it('warms an existing location for input or revision-only changes', () => {
    for (const inputHash of [hash('9'), hash('e')]) {
      const result = classify(snapshot({
        locations: [
          { id: 'horsens', forecastConfigRevision: 2, inputHash },
          { id: 'vejle', forecastConfigRevision: 1, inputHash: hash('f') },
        ],
      }));
      expect(result).toMatchObject({
        impact: 'location-change',
        locationChangeKind: 'changed',
        changedLocationIds: ['horsens'],
        warmLocationIds: ['horsens'],
      });
    }
  });

  it('rejects an unsafe location revision and marks removals as non-promotable', () => {
    expect(() => classify(snapshot({
      locations: [
        { id: 'horsens', forecastConfigRevision: 1, inputHash: hash('9') },
        { id: 'vejle', forecastConfigRevision: 1, inputHash: hash('f') },
      ],
    }))).toThrow('increase its forecastConfigRevision');

    const result = classify(snapshot({
      locations: [
        { id: 'horsens', forecastConfigRevision: 1, inputHash: hash('e') },
      ],
    }));
    expect(result).toMatchObject({
      impact: 'location-change',
      locationChangeKind: 'removed-or-mixed',
      removedLocationIds: ['vejle'],
      automaticPromotionAllowed: false,
      blockingReasons: ['removed-locations'],
    });
  });

  it('requires an intentional audited model transition for semantic inputs', () => {
    const changedInputs = { 'worker/forecast-model.ts': hash('9') };
    expect(() => classify(snapshot({ semanticInputs: changedInputs })))
      .toThrow('advance model revision and data-generation id');
    expect(() => classify(snapshot({
      release: RELEASE_V8,
      semanticInputs: changedInputs,
    }))).toThrow('audit the exact trusted production release');

    const result = classify(snapshot({
      pagesBuildId: 'pages-b',
      workerRuntimeHash: hash('1'),
      release: RELEASE_V8,
      auditedPreviousReleases: [RELEASE_V7],
      semanticInputs: changedInputs,
      locations: [
        { id: 'horsens', forecastConfigRevision: 1, inputHash: hash('e') },
        { id: 'odense', forecastConfigRevision: 1, inputHash: hash('2') },
        { id: 'vejle', forecastConfigRevision: 1, inputHash: hash('f') },
      ],
    }));
    expect(result).toMatchObject({
      impact: 'forecast-semantic',
      changedSemanticInputs: ['worker/forecast-model.ts'],
      addedLocationIds: ['odense'],
      warmLocationIds: ['horsens', 'odense', 'vejle'],
    });
  });

  it('gives a breaking API highest precedence and blocks automatic promotion', () => {
    const api2 = {
      ...RELEASE_V8,
      apiSchemaVersion: 2,
      dataGenerationId: 'api2-model8',
      payloadVersion: 8,
    };
    const result = classify(snapshot({
      pagesBuildId: 'pages-b',
      workerRuntimeHash: hash('1'),
      release: api2,
      supportedApiSchemaVersions: [2],
      semanticInputs: { 'worker/forecast-model.ts': hash('9') },
      locations: [
        { id: 'horsens', forecastConfigRevision: 1, inputHash: hash('e') },
      ],
    }));
    expect(result).toMatchObject({
      impact: 'breaking-api',
      automaticPromotionAllowed: false,
      blockingReasons: ['breaking-api', 'removed-locations'],
      warmLocationIds: [],
    });
  });

  it('treats a same-route payload stamp change as a breaking representation', () => {
    expect(classify(snapshot({
      release: { ...RELEASE_V7, payloadVersion: 8 },
    }))).toMatchObject({
      impact: 'breaking-api',
      automaticPromotionAllowed: false,
    });
  });
});

describe('release impact CLI', () => {
  it('requires the explicit trusted/candidate snapshot and SHA contract', () => {
    expect(() => parseReleaseImpactArguments(['--candidate', 'candidate.json']))
      .toThrow('Missing required release-impact option: --trusted-base');
    expect(() => parseReleaseImpactArguments(['--unknown', 'value']))
      .toThrow('Unknown release-impact option');
  });

  it('prints JSON and writes machine-safe GitHub outputs', async () => {
    const baseJson = JSON.stringify(base());
    const candidateJson = JSON.stringify(snapshot({ pagesBuildId: 'pages-b' }));
    const readFileImpl = vi.fn(async (fileName: string) => (
      fileName.endsWith('base.json') ? baseJson : candidateJson
    ));
    const appendFileImpl = vi.fn(async () => undefined);
    const stdout = { write: vi.fn() };

    const result = await runReleaseImpactCli([
      '--trusted-base', 'base.json',
      '--trusted-base-sha', BASE_SHA,
      '--candidate', 'candidate.json',
      '--candidate-sha', CANDIDATE_SHA,
      '--github-output', 'github-output.txt',
    ], { readFileImpl, appendFileImpl, stdout });

    expect(result?.impact).toBe('pages-only');
    expect(stdout.write).toHaveBeenCalledWith(expect.stringContaining('"impact":"pages-only"'));
    expect(appendFileImpl).toHaveBeenCalledWith(
      'github-output.txt',
      expect.stringContaining('warm_location_ids=[]'),
      'utf8',
    );
  });
});
