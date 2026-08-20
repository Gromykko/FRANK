import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SNAPSHOT_SCHEMA_VERSION = 1;
const SOURCE_SHA = /^[a-f0-9]{40}$/i;
const SHA256 = /^[a-f0-9]{64}$/i;
const LOCATION_ID = /^[a-z0-9-]+$/;
const GENERATION_ID = /^[A-Za-z0-9._:-]+$/;
const PAGES_BUILD_ID = /^[A-Za-z0-9._:+-]+$/;
const PRODUCTION_PROVENANCE = 'attested-production';
const CANDIDATE_PROVENANCE = 'candidate';

export const RELEASE_IMPACTS = Object.freeze([
  'none',
  'pages-only',
  'worker-nonsemantic',
  'location-change',
  'forecast-semantic',
  'breaking-api',
]);

const USAGE = `Usage: node scripts/release-impact.mjs \\
  --trusted-base <snapshot.json> --trusted-base-sha <40-hex-sha> \\
  --candidate <snapshot.json> --candidate-sha <40-hex-sha> \\
  [--github-output <path>]

Snapshots are produced by a separate manifest builder. pagesBuildId must be a
stable Pages-content identity (not a deployment timestamp), workerRuntimeHash
must identify the immutable Worker runtime, and only a control-plane-attested
production snapshot may use provenance "${PRODUCTION_PROVENANCE}".
`;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function normalizedSha(value, label) {
  if (typeof value !== 'string' || !SOURCE_SHA.test(value)) {
    throw new Error(`${label} must be a full 40-character Git SHA.`);
  }
  return value.toLowerCase();
}

function normalizedHash(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new Error(`${label} must be a SHA-256 fingerprint.`);
  }
  return value.toLowerCase();
}

function normalizedPagesBuildId(value) {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > 256
    || !PAGES_BUILD_ID.test(value)) {
    throw new Error('Release-impact snapshot pagesBuildId is invalid.');
  }
  return value;
}

function normalizeRelease(value, label) {
  if (!isRecord(value)
    || !positiveInteger(value.apiSchemaVersion)
    || !positiveInteger(value.modelRevision)
    || !positiveInteger(value.assembledCacheSchema)
    || !positiveInteger(value.marineCacheSchema)
    || !positiveInteger(value.payloadVersion)
    || typeof value.dataGenerationId !== 'string'
    || !GENERATION_ID.test(value.dataGenerationId)) {
    throw new Error(`${label} release descriptor is invalid.`);
  }
  return {
    apiSchemaVersion: value.apiSchemaVersion,
    modelRevision: value.modelRevision,
    assembledCacheSchema: value.assembledCacheSchema,
    marineCacheSchema: value.marineCacheSchema,
    dataGenerationId: value.dataGenerationId,
    payloadVersion: value.payloadVersion,
  };
}

function normalizeApiVersions(value, release, label) {
  if (!Array.isArray(value)
    || value.length === 0
    || value.some((version) => !positiveInteger(version))
    || new Set(value).size !== value.length
    || !value.includes(release.apiSchemaVersion)) {
    throw new Error(`${label} supported API schema versions are invalid.`);
  }
  return [...value].sort((left, right) => left - right);
}

function normalizeAuditedPreviousReleases(value, label) {
  if (!Array.isArray(value) || value.length > 1) {
    throw new Error(`${label} must contain at most one audited previous release.`);
  }
  return value.map((release, index) => normalizeRelease(
    release,
    `${label} audited previous release ${index + 1}`,
  ));
}

function normalizeSemanticInputs(value, label) {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    throw new Error(`${label} semantic input fingerprints are missing.`);
  }
  const entries = Object.entries(value).map(([name, hash]) => {
    if (!name
      || name.length > 512
      || [...name].some((character) => character.codePointAt(0) < 32)) {
      throw new Error(`${label} contains an invalid semantic input name.`);
    }
    return [name, normalizedHash(hash, `${label} semantic input ${name}`)];
  });
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}

function normalizeLocations(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} location fingerprints are missing.`);
  }
  const seen = new Set();
  const locations = value.map((location) => {
    if (!isRecord(location)
      || typeof location.id !== 'string'
      || !LOCATION_ID.test(location.id)
      || seen.has(location.id)
      || !positiveInteger(location.forecastConfigRevision)) {
      throw new Error(`${label} contains an invalid or duplicate forecast location.`);
    }
    seen.add(location.id);
    return {
      id: location.id,
      forecastConfigRevision: location.forecastConfigRevision,
      inputHash: normalizedHash(location.inputHash, `${label} location ${location.id}`),
    };
  });
  return locations.sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Normalize a manifest-builder snapshot without inferring impact from changed
 * paths or Git history. The immutable Pages/Worker fingerprints are mandatory:
 * a source SHA alone cannot distinguish a docs-only commit from shipped code.
 */
export function normalizeReleaseImpactSnapshot(value, {
  role,
  expectedSourceSha,
} = {}) {
  if (!isRecord(value) || value.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new Error('Release-impact snapshot is missing or malformed.');
  }
  if (role !== 'trusted-base' && role !== 'candidate') {
    throw new Error('Release-impact snapshot role is invalid.');
  }
  const sourceSha = normalizedSha(value.sourceSha, `${role} source SHA`);
  if (expectedSourceSha !== undefined
    && sourceSha !== normalizedSha(expectedSourceSha, `${role} expected source SHA`)) {
    throw new Error(`${role} snapshot does not belong to the requested source SHA.`);
  }
  const expectedProvenance = role === 'trusted-base'
    ? PRODUCTION_PROVENANCE
    : CANDIDATE_PROVENANCE;
  if (value.provenance !== expectedProvenance) {
    throw new Error(role === 'trusted-base'
      ? 'Release-impact base is not an attested production snapshot.'
      : 'Release-impact candidate provenance is invalid.');
  }

  const release = normalizeRelease(value.release, role);
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    provenance: expectedProvenance,
    sourceSha,
    pagesBuildId: normalizedPagesBuildId(value.pagesBuildId),
    workerRuntimeHash: normalizedHash(value.workerRuntimeHash, `${role} Worker runtime`),
    release,
    supportedApiSchemaVersions: normalizeApiVersions(
      value.supportedApiSchemaVersions,
      release,
      role,
    ),
    auditedPreviousReleases: normalizeAuditedPreviousReleases(
      value.auditedPreviousReleases,
      role,
    ),
    semanticInputs: normalizeSemanticInputs(value.semanticInputs, role),
    locations: normalizeLocations(value.locations, role),
  };
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameRelease(left, right) {
  return sameJson(left, right);
}

function exactReleaseListed(release, auditedPreviousReleases) {
  return auditedPreviousReleases.some((candidate) => sameRelease(release, candidate));
}

function changedSemanticInputs(base, candidate) {
  const names = new Set([
    ...Object.keys(base.semanticInputs),
    ...Object.keys(candidate.semanticInputs),
  ]);
  return [...names]
    .filter((name) => base.semanticInputs[name] !== candidate.semanticInputs[name])
    .sort();
}

function describeLocationChanges(base, candidate) {
  const baseById = new Map(base.locations.map((location) => [location.id, location]));
  const candidateById = new Map(candidate.locations.map((location) => [location.id, location]));
  const addedLocationIds = candidate.locations
    .filter((location) => !baseById.has(location.id))
    .map((location) => location.id);
  const removedLocationIds = base.locations
    .filter((location) => !candidateById.has(location.id))
    .map((location) => location.id);
  const changedLocationIds = [];

  for (const location of candidate.locations) {
    const previous = baseById.get(location.id);
    if (!previous) {
      if (location.forecastConfigRevision !== 1) {
        throw new Error(`New location ${location.id} must start at forecastConfigRevision 1.`);
      }
      continue;
    }
    if (location.forecastConfigRevision < previous.forecastConfigRevision) {
      throw new Error(`forecastConfigRevision cannot decrease for ${location.id}.`);
    }
    if (location.inputHash !== previous.inputHash
      && location.forecastConfigRevision <= previous.forecastConfigRevision) {
      throw new Error(
        `Forecast inputs changed for ${location.id}; increase its forecastConfigRevision.`,
      );
    }
    if (location.inputHash !== previous.inputHash
      || location.forecastConfigRevision !== previous.forecastConfigRevision) {
      changedLocationIds.push(location.id);
    }
  }

  return {
    addedLocationIds: addedLocationIds.sort(),
    changedLocationIds: changedLocationIds.sort(),
    removedLocationIds: removedLocationIds.sort(),
  };
}

function locationChangeKind({
  addedLocationIds,
  changedLocationIds,
  removedLocationIds,
}) {
  if (removedLocationIds.length > 0) return 'removed-or-mixed';
  if (addedLocationIds.length > 0 && changedLocationIds.length > 0) {
    return 'added-and-changed';
  }
  if (addedLocationIds.length > 0) return 'add-only';
  if (changedLocationIds.length > 0) return 'changed';
  return 'none';
}

function releaseHasBreakingApiChange(base, candidate) {
  if (base.release.apiSchemaVersion !== candidate.release.apiSchemaVersion
    || base.release.payloadVersion !== candidate.release.payloadVersion
    || !sameJson(base.supportedApiSchemaVersions, candidate.supportedApiSchemaVersions)) {
    return true;
  }
  return candidate.auditedPreviousReleases.some(
    (release) => release.apiSchemaVersion !== candidate.release.apiSchemaVersion,
  );
}

function releaseHasGlobalForecastChange(base, candidate, semanticChanges) {
  return semanticChanges.length > 0
    || base.release.modelRevision !== candidate.release.modelRevision
    || base.release.dataGenerationId !== candidate.release.dataGenerationId
    || base.release.assembledCacheSchema !== candidate.release.assembledCacheSchema
    || base.release.marineCacheSchema !== candidate.release.marineCacheSchema;
}

function assertSafeGlobalForecastTransition(base, candidate, semanticChanges) {
  const { release: previous } = base;
  const { release: current } = candidate;
  if (current.modelRevision < previous.modelRevision) {
    throw new Error('Forecast model revision cannot decrease.');
  }
  if (current.assembledCacheSchema < previous.assembledCacheSchema
    || current.marineCacheSchema < previous.marineCacheSchema) {
    throw new Error('Forecast cache schema versions cannot decrease.');
  }

  const modelChanged = current.modelRevision !== previous.modelRevision;
  const generationChanged = current.dataGenerationId !== previous.dataGenerationId;
  if (modelChanged !== generationChanged) {
    throw new Error(
      'Forecast model revision and data-generation id must advance together.',
    );
  }
  if (semanticChanges.length > 0
    && (current.modelRevision <= previous.modelRevision || !generationChanged)) {
    throw new Error(
      'Forecast-producing inputs changed; advance model revision and data-generation id.',
    );
  }
  if (!exactReleaseListed(previous, candidate.auditedPreviousReleases)) {
    throw new Error(
      'A global forecast transition must audit the exact trusted production release as N-1.',
    );
  }
}

/**
 * Classify a candidate relative to an explicitly attested production snapshot.
 * Precedence is intentionally fixed: breaking API > forecast semantic >
 * location change > Worker-only > Pages-only > none.
 */
export function classifyReleaseImpact({
  trustedBase,
  candidate,
  trustedBaseSha,
  candidateSha,
} = {}) {
  const requiredBaseSha = normalizedSha(trustedBaseSha, 'trusted-base expected source SHA');
  const requiredCandidateSha = normalizedSha(candidateSha, 'candidate expected source SHA');
  const base = normalizeReleaseImpactSnapshot(trustedBase, {
    role: 'trusted-base',
    expectedSourceSha: requiredBaseSha,
  });
  const current = normalizeReleaseImpactSnapshot(candidate, {
    role: 'candidate',
    expectedSourceSha: requiredCandidateSha,
  });
  const semanticChanges = changedSemanticInputs(base, current);
  const locations = describeLocationChanges(base, current);
  const hasLocationChange = locations.addedLocationIds.length > 0
    || locations.changedLocationIds.length > 0
    || locations.removedLocationIds.length > 0;
  const breakingApi = releaseHasBreakingApiChange(base, current);
  const globalForecastChange = releaseHasGlobalForecastChange(
    base,
    current,
    semanticChanges,
  );

  if (!breakingApi && globalForecastChange) {
    assertSafeGlobalForecastTransition(base, current, semanticChanges);
  }

  let impact;
  if (breakingApi) impact = 'breaking-api';
  else if (globalForecastChange) impact = 'forecast-semantic';
  else if (hasLocationChange) impact = 'location-change';
  else if (base.workerRuntimeHash !== current.workerRuntimeHash) impact = 'worker-nonsemantic';
  else if (base.pagesBuildId !== current.pagesBuildId) impact = 'pages-only';
  else impact = 'none';

  const changeKind = locationChangeKind(locations);
  const blockingReasons = [
    ...(breakingApi ? ['breaking-api'] : []),
    ...(locations.removedLocationIds.length > 0 ? ['removed-locations'] : []),
  ];
  const warmLocationIds = impact === 'forecast-semantic'
    ? current.locations.map((location) => location.id)
    : impact === 'location-change'
      ? [...new Set([
          ...locations.addedLocationIds,
          ...locations.changedLocationIds,
        ])].sort()
      : [];

  return {
    impact,
    trustedBaseSha: base.sourceSha,
    candidateSha: current.sourceSha,
    automaticPromotionAllowed: blockingReasons.length === 0,
    blockingReasons,
    warmLocationIds,
    locationChangeKind: changeKind,
    ...locations,
    changedSemanticInputs: semanticChanges,
  };
}

export function parseReleaseImpactArguments(argv) {
  if (!Array.isArray(argv)) throw new Error('Release-impact arguments are invalid.');
  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  const known = new Set([
    '--trusted-base',
    '--trusted-base-sha',
    '--candidate',
    '--candidate-sha',
    '--github-output',
  ]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!known.has(option)) throw new Error(`Unknown release-impact option: ${option ?? ''}.`);
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
      throw new Error(`Missing value for ${option}.`);
    }
    if (Object.prototype.hasOwnProperty.call(values, option)) {
      throw new Error(`Duplicate release-impact option: ${option}.`);
    }
    values[option] = value;
  }
  for (const required of [
    '--trusted-base',
    '--trusted-base-sha',
    '--candidate',
    '--candidate-sha',
  ]) {
    if (!values[required]) throw new Error(`Missing required release-impact option: ${required}.`);
  }
  return {
    help: false,
    trustedBaseFile: values['--trusted-base'],
    trustedBaseSha: values['--trusted-base-sha'],
    candidateFile: values['--candidate'],
    candidateSha: values['--candidate-sha'],
    githubOutputFile: values['--github-output'],
  };
}

function parseSnapshotJson(source, label) {
  try {
    return JSON.parse(source);
  } catch {
    throw new Error(`${label} snapshot is not valid JSON.`);
  }
}

function githubOutput(result) {
  return [
    `impact=${result.impact}`,
    `automatic_promotion_allowed=${result.automaticPromotionAllowed}`,
    `blocking_reasons=${JSON.stringify(result.blockingReasons)}`,
    `warm_location_ids=${JSON.stringify(result.warmLocationIds)}`,
    `added_location_ids=${JSON.stringify(result.addedLocationIds)}`,
    `changed_location_ids=${JSON.stringify(result.changedLocationIds)}`,
    `removed_location_ids=${JSON.stringify(result.removedLocationIds)}`,
    `location_change_kind=${result.locationChangeKind}`,
    `trusted_base_sha=${result.trustedBaseSha}`,
    `candidate_sha=${result.candidateSha}`,
    '',
  ].join('\n');
}

export async function runReleaseImpactCli(
  argv = process.argv.slice(2),
  {
    readFileImpl = readFile,
    appendFileImpl = appendFile,
    stdout = process.stdout,
  } = {},
) {
  const options = parseReleaseImpactArguments(argv);
  if (options.help) {
    stdout.write(USAGE);
    return null;
  }
  const [baseSource, candidateSource] = await Promise.all([
    readFileImpl(path.resolve(options.trustedBaseFile), 'utf8'),
    readFileImpl(path.resolve(options.candidateFile), 'utf8'),
  ]);
  const result = classifyReleaseImpact({
    trustedBase: parseSnapshotJson(baseSource, 'Trusted production'),
    candidate: parseSnapshotJson(candidateSource, 'Candidate'),
    trustedBaseSha: options.trustedBaseSha,
    candidateSha: options.candidateSha,
  });
  if (options.githubOutputFile) {
    await appendFileImpl(options.githubOutputFile, githubOutput(result), 'utf8');
  }
  stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

if (process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runReleaseImpactCli().catch((error) => {
    console.error(`[release] ${error instanceof Error ? error.message : 'Impact classification failed.'}`);
    process.exitCode = 1;
  });
}
