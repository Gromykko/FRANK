import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadReleaseContract } from './warm-worker.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, '..');
export const FORECAST_MODEL_BASELINE_FILE = path.join(
  REPOSITORY_ROOT,
  'release',
  'forecast-model-baseline.json',
);

// Conservative by design. These files can change the bytes, provenance, or
// fallback policy of a prepared forecast. UI, service-worker, health-page, and
// HTTP presentation changes are deliberately outside this list.
export const FORECAST_SEMANTIC_INPUT_FILES = Object.freeze([
  'src/features/forecast/normalize.ts',
  'src/features/forecast/parseWarnings.ts',
  'src/features/forecast/providerUrls.ts',
  'src/features/forecast/sun.ts',
  'src/features/forecast/types.ts',
  'src/features/forecast/validatePayload.ts',
  'src/features/forecast/weatherCodes.ts',
  'worker/domain.ts',
  'worker/execution.ts',
  'worker/index.ts',
  'worker/providerAvailability.ts',
  'worker/providers.ts',
  'worker/validation.ts',
]);

const BASELINE_SCHEMA_VERSION = 1;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizedSource(source) {
  return source.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n');
}

function releaseIdentity(release) {
  return {
    apiSchemaVersion: release.apiSchemaVersion,
    modelRevision: release.modelRevision,
    assembledCacheSchema: release.assembledCacheSchema,
    marineCacheSchema: release.marineCacheSchema,
    dataGenerationId: release.dataGenerationId,
    payloadVersion: release.payloadVersion,
  };
}

function forecastLocationInput(location) {
  return {
    coordinate: location.coordinate,
    timezone: location.timezone,
    dmiCollections: location.dmiCollections,
    emmaId: location.emmaId,
    kommuneAliases: location.kommuneAliases,
  };
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validRelease(value) {
  return value !== null
    && typeof value === 'object'
    && positiveInteger(value.apiSchemaVersion)
    && positiveInteger(value.modelRevision)
    && positiveInteger(value.assembledCacheSchema)
    && positiveInteger(value.marineCacheSchema)
    && typeof value.dataGenerationId === 'string'
    && value.dataGenerationId.length > 0
    && positiveInteger(value.payloadVersion);
}

function validBaseline(value) {
  return value !== null
    && typeof value === 'object'
    && value.schemaVersion === BASELINE_SCHEMA_VERSION
    && validRelease(value.release)
    && value.semanticInputs !== null
    && typeof value.semanticInputs === 'object'
    && !Array.isArray(value.semanticInputs)
    && Object.values(value.semanticInputs).every(
      (hash) => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash),
    )
    && Array.isArray(value.locations)
    && value.locations.every((location) => location !== null
      && typeof location === 'object'
      && typeof location.id === 'string'
      && location.id.length > 0
      && positiveInteger(location.forecastConfigRevision)
      && typeof location.inputHash === 'string'
      && /^[a-f0-9]{64}$/.test(location.inputHash));
}

function sameValue(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function exactReleaseListed(release, auditedPreviousReleases) {
  return auditedPreviousReleases.some((candidate) => sameValue(candidate, release));
}

export async function buildForecastModelSnapshot({
  release,
  locations,
  repositoryRoot = REPOSITORY_ROOT,
  readFileImpl = readFile,
}) {
  if (!validRelease(release)) throw new Error('Current forecast release metadata is invalid.');
  if (!Array.isArray(locations)) throw new Error('Forecast locations are invalid.');

  const semanticInputs = {};
  for (const relativePath of FORECAST_SEMANTIC_INPUT_FILES) {
    const source = await readFileImpl(path.join(repositoryRoot, relativePath), 'utf8');
    semanticInputs[relativePath] = sha256(normalizedSource(source));
  }

  const seenIds = new Set();
  const locationEntries = locations.map((location) => {
    if (!location || typeof location.id !== 'string' || !location.id) {
      throw new Error('Every forecast location needs a non-empty id.');
    }
    if (seenIds.has(location.id)) throw new Error(`Duplicate forecast location id: ${location.id}.`);
    seenIds.add(location.id);
    if (!positiveInteger(location.forecastConfigRevision)) {
      throw new Error(`${location.id} needs a positive forecastConfigRevision.`);
    }
    return {
      id: location.id,
      forecastConfigRevision: location.forecastConfigRevision,
      inputHash: sha256(canonicalJson(forecastLocationInput(location))),
    };
  }).sort((left, right) => left.id.localeCompare(right.id));

  return {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    release: releaseIdentity(release),
    semanticInputs,
    locations: locationEntries,
  };
}

export async function readForecastModelBaseline({
  baselineFile = FORECAST_MODEL_BASELINE_FILE,
  readFileImpl = readFile,
} = {}) {
  let baseline;
  try {
    baseline = JSON.parse(await readFileImpl(baselineFile, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read forecast model baseline: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
  if (!validBaseline(baseline)) throw new Error('Forecast model baseline is malformed.');
  return baseline;
}

export function describeForecastModelDiff(baseline, current) {
  const changedSemanticInputs = FORECAST_SEMANTIC_INPUT_FILES.filter(
    (file) => baseline.semanticInputs[file] !== current.semanticInputs[file],
  );
  const previousLocations = new Map(baseline.locations.map((location) => [location.id, location]));
  const currentLocations = new Map(current.locations.map((location) => [location.id, location]));
  const addedLocations = current.locations
    .filter((location) => !previousLocations.has(location.id))
    .map((location) => location.id);
  const removedLocations = baseline.locations
    .filter((location) => !currentLocations.has(location.id))
    .map((location) => location.id);
  const changedLocations = current.locations
    .filter((location) => {
      const previous = previousLocations.get(location.id);
      return previous && previous.inputHash !== location.inputHash;
    })
    .map((location) => location.id);
  const revisionOnlyLocations = current.locations
    .filter((location) => {
      const previous = previousLocations.get(location.id);
      return previous
        && previous.inputHash === location.inputHash
        && previous.forecastConfigRevision !== location.forecastConfigRevision;
    })
    .map((location) => location.id);

  return {
    releaseChanged: !sameValue(baseline.release, current.release),
    changedSemanticInputs,
    addedLocations,
    removedLocations,
    changedLocations,
    revisionOnlyLocations,
  };
}

export function assertRecordableForecastModelTransition({
  baseline,
  current,
  auditedPreviousReleases,
}) {
  if (!validBaseline(baseline) || !validBaseline(current)) {
    throw new Error('Forecast model transition contains a malformed snapshot.');
  }
  const diff = describeForecastModelDiff(baseline, current);
  if (diff.removedLocations.length > 0) {
    throw new Error(
      `Forecast location ids cannot be removed or reused without a compatibility plan: ${diff.removedLocations.join(', ')}.`,
    );
  }

  const previousLocations = new Map(baseline.locations.map((location) => [location.id, location]));
  for (const location of current.locations) {
    const previous = previousLocations.get(location.id);
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
  }

  if (diff.changedSemanticInputs.length > 0) {
    if (current.release.modelRevision <= baseline.release.modelRevision
      || current.release.dataGenerationId === baseline.release.dataGenerationId) {
      throw new Error(
        'Forecast-producing code changed; advance FORECAST_MODEL_REVISION and FORECAST_DATA_GENERATION_ID.',
      );
    }
  }

  if (diff.releaseChanged
    && !exactReleaseListed(baseline.release, auditedPreviousReleases)) {
    throw new Error(
      'The previous full release descriptor must be listed in AUDITED_PREVIOUS_FORECAST_GENERATIONS before recording a new release.',
    );
  }
  return diff;
}

export async function assertForecastModelBaseline({
  release,
  locations,
  baselineFile = FORECAST_MODEL_BASELINE_FILE,
  repositoryRoot = REPOSITORY_ROOT,
  readFileImpl = readFile,
} = {}) {
  const [baseline, current] = await Promise.all([
    readForecastModelBaseline({ baselineFile, readFileImpl }),
    buildForecastModelSnapshot({ release, locations, repositoryRoot, readFileImpl }),
  ]);
  if (!sameValue(baseline, current)) {
    const diff = describeForecastModelDiff(baseline, current);
    const details = [
      ...diff.changedSemanticInputs,
      ...diff.changedLocations.map((id) => `location:${id}`),
      ...diff.addedLocations.map((id) => `location-added:${id}`),
      ...diff.removedLocations.map((id) => `location-removed:${id}`),
      ...diff.revisionOnlyLocations.map((id) => `location-revision:${id}`),
      ...(diff.releaseChanged ? ['release-identity'] : []),
    ];
    throw new Error(
      `Forecast model baseline is out of date (${details.join(', ') || 'unknown difference'}). `
      + 'Review the change, then run npm run release:record-model.',
    );
  }
  return current;
}

export async function recordForecastModelBaseline({
  contract,
  baselineFile = FORECAST_MODEL_BASELINE_FILE,
  repositoryRoot = REPOSITORY_ROOT,
  readFileImpl = readFile,
  writeFileImpl = writeFile,
} = {}) {
  const resolvedContract = contract ?? await loadReleaseContract();
  const baseline = await readForecastModelBaseline({ baselineFile, readFileImpl });
  const current = await buildForecastModelSnapshot({
    release: resolvedContract.release,
    locations: resolvedContract.locations,
    repositoryRoot,
    readFileImpl,
  });
  assertRecordableForecastModelTransition({
    baseline,
    current,
    auditedPreviousReleases: resolvedContract.auditedPreviousReleases,
  });
  await writeFileImpl(baselineFile, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
  return current;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  recordForecastModelBaseline()
    .then((snapshot) => {
      process.stdout.write(
        `recorded forecast model ${snapshot.release.dataGenerationId} with ${snapshot.locations.length} locations`,
      );
    })
    .catch((error) => {
      console.error(`[release] ${error instanceof Error ? error.message : 'Could not record forecast model.'}`);
      process.exitCode = 1;
    });
}
