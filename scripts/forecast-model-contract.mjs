import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { loadReleaseContract } from './load-release-contract.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, '..');
export const FORECAST_MODEL_BASELINE_FILE = path.join(
  REPOSITORY_ROOT,
  'release',
  'forecast-model-baseline.json',
);

export const FORECAST_SEMANTIC_BOUNDARY_ID = 'worker-generation-owned-v1';

// Whole-file fingerprints only: there are no symbol whitelists or per-change
// exceptions. Mixed orchestration stays protected until every byte-affecting
// decision has moved behind the generation-owned module. Only provider
// transport retry/circuit mechanics and execution budgets are separate and
// therefore classify as Worker-nonsemantic; cache-health provenance remains
// protected because its run ids and expiry stamps feed later source selection.
export const FORECAST_SEMANTIC_INPUT_FILES = Object.freeze([
  'src/features/forecast/normalize.ts',
  'src/features/forecast/parseWarnings.ts',
  'src/features/forecast/providerUrls.ts',
  'src/features/forecast/releaseContract.ts',
  'src/features/forecast/sun.ts',
  'src/features/forecast/temporalPolicy.ts',
  'src/features/forecast/types.ts',
  'src/features/forecast/validatePayload.ts',
  'worker/cacheHealth.ts',
  'worker/forecastModel.ts',
  'worker/generation.ts',
  'worker/http.ts',
  'worker/domain.ts',
  'worker/index.ts',
  'worker/providerAvailability.ts',
  'worker/providers.ts',
  'worker/validation.ts',
]);

export const FORECAST_OPERATIONAL_INPUT_FILES = Object.freeze([
  'worker/execution.ts',
  'worker/providerTransport.ts',
]);

const BASELINE_SCHEMA_VERSION = 2;

const REQUIRED_BOUNDARY_IMPORTS = Object.freeze({
  'worker/index.ts': ['./cacheHealth', './providers'],
  'worker/providerAvailability.ts': ['./forecastModel'],
  'worker/providers.ts': ['./forecastModel', './providerTransport'],
});

const MODEL_OWNED_DECLARATIONS = Object.freeze([
  'FORECAST_PROVIDER_PARAMETERS',
  'FORECAST_SOURCE_POLICY',
  'assembleForecastFromSources',
  'canUseMetFallback',
  'currentMarineIngredient',
  'degradedSourcesAfterProbe',
  'deriveMarineSeedsFromPayload',
  'heldMarineFallback',
  'isMarineRunWithinFallbackAge',
  'isTransientProviderFailure',
  'latestInstanceFromResponse',
  'marineProbeDecision',
]);

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

// The fingerprint must move when BEHAVIOUR moves, not when prose does. These
// files carry their reasoning in comments, so hashing raw bytes made a
// comment-only edit demand a new FORECAST_MODEL_REVISION and a full generation
// rebuild: a guard that charges for documentation is a guard that teaches
// people to stop documenting. Re-emitting the parsed file without comments
// hashes what the compiler will actually run, and normalizes formatting and
// line endings along the way. It reuses the same parse this module already
// validates, rather than a hand-rolled tokenizer that would have to re-derive
// template-literal and regex-vs-division context to stay correct.
//
// The tradeoff is that the printer belongs to TypeScript, so a TypeScript
// upgrade can move every hash at once and cost one model revision. That is
// rare, loud, and pinned by package-lock, unlike editing a comment.
const FINGERPRINT_PRINTER = ts.createPrinter({
  removeComments: true,
  newLine: ts.NewLineKind.LineFeed,
});

function sourceFingerprint(source, fileName) {
  return sha256(FINGERPRINT_PRINTER.printFile(sourceFile(normalizedSource(source), fileName)));
}

function sourceFile(source, fileName) {
  const parsed = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.ESNext,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  if (parsed.parseDiagnostics?.length > 0) {
    throw new Error(`${fileName} contains invalid TypeScript syntax.`);
  }
  return parsed;
}

function moduleImports(source, fileName) {
  const imports = [];
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const namedBindings = clause?.namedBindings;
      const runtimeNamedImport = namedBindings && ts.isNamedImports(namedBindings)
        ? namedBindings.elements.some((element) => !element.isTypeOnly)
        : Boolean(namedBindings);
      const runtime = !clause
        || (!clause.isTypeOnly && (Boolean(clause.name) || runtimeNamedImport));
      imports.push({ specifier: node.moduleSpecifier.text, runtime });
      return;
    }
    if (ts.isExportDeclaration(node)
      && node.moduleSpecifier
      && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push({ specifier: node.moduleSpecifier.text, runtime: !node.isTypeOnly });
      return;
    }
    if (ts.isCallExpression(node)
      && node.arguments.length > 0
      && ts.isStringLiteral(node.arguments[0])
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      imports.push({ specifier: node.arguments[0].text, runtime: true });
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile(source, fileName));
  return imports;
}

function topLevelDeclarations(source, fileName) {
  const declarations = new Set();
  for (const statement of sourceFile(source, fileName).statements) {
    if ((ts.isFunctionDeclaration(statement)
      || ts.isClassDeclaration(statement)
      || ts.isInterfaceDeclaration(statement)
      || ts.isTypeAliasDeclaration(statement))
      && statement.name) {
      declarations.add(statement.name.text);
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) declarations.add(declaration.name.text);
      }
    }
  }
  return declarations;
}

function resolvedImport(importer, specifier) {
  if (!specifier.startsWith('.')) return null;
  const value = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
  if (value === '..' || value.startsWith('../')) {
    throw new Error(`Forecast semantic import escapes the repository: ${importer} -> ${specifier}.`);
  }
  return path.posix.extname(value) ? value : `${value}.ts`;
}

export async function assertForecastSemanticBoundary({
  repositoryRoot = REPOSITORY_ROOT,
  readFileImpl = readFile,
} = {}) {
  const modelFile = 'worker/forecastModel.ts';
  const files = [...new Set([
    modelFile,
    ...FORECAST_SEMANTIC_INPUT_FILES,
    ...FORECAST_OPERATIONAL_INPUT_FILES,
    ...Object.keys(REQUIRED_BOUNDARY_IMPORTS),
  ])];
  const sources = new Map(await Promise.all(files.map(async (fileName) => [
    fileName,
    normalizedSource(await readFileImpl(path.join(repositoryRoot, fileName), 'utf8')),
  ])));

  const protectedFiles = new Set(FORECAST_SEMANTIC_INPUT_FILES);
  const operationalFiles = new Set(FORECAST_OPERATIONAL_INPUT_FILES);
  for (const operationalFile of operationalFiles) {
    if (protectedFiles.has(operationalFile)) {
      throw new Error(`${operationalFile} cannot be both semantic and operational.`);
    }
  }

  for (const imported of moduleImports(sources.get(modelFile), modelFile)) {
    if (!imported.runtime) continue;
    const resolved = resolvedImport(modelFile, imported.specifier);
    if (!resolved) {
      throw new Error(`Forecast model cannot import runtime package ${imported.specifier}.`);
    }
    if (operationalFiles.has(resolved)) {
      throw new Error(`Forecast model cannot import operational module ${resolved}.`);
    }
    if (!protectedFiles.has(resolved)
      && resolved !== 'src/features/forecast/releaseContract.ts') {
      throw new Error(`Forecast model runtime dependency is not protected: ${resolved}.`);
    }
  }

  const operationalSource = FORECAST_OPERATIONAL_INPUT_FILES
    .map((fileName) => sources.get(fileName))
    .join('\n');
  if (/\bFRANK_FORECAST_CACHE\b|\bfetch\s*\(/.test(sources.get(modelFile))) {
    throw new Error('Forecast model boundary must remain free of network and KV I/O.');
  }
  if (!/\bfetch(?:WithTimeout)?\s*\(/.test(operationalSource)) {
    throw new Error('Forecast transport boundary no longer owns provider I/O.');
  }

  for (const [fileName, requiredSpecifiers] of Object.entries(REQUIRED_BOUNDARY_IMPORTS)) {
    const actual = new Set(moduleImports(sources.get(fileName), fileName)
      .map(({ specifier }) => specifier));
    for (const specifier of requiredSpecifiers) {
      if (!actual.has(specifier)) {
        throw new Error(`${fileName} must import ${specifier} through the semantic boundary.`);
      }
    }
  }

  for (const fileName of [
    'worker/cacheHealth.ts',
    'worker/index.ts',
    'worker/providerAvailability.ts',
    'worker/providerTransport.ts',
    'worker/providers.ts',
  ]) {
    const declarations = topLevelDeclarations(sources.get(fileName), fileName);
    const duplicates = MODEL_OWNED_DECLARATIONS.filter((name) => declarations.has(name));
    if (duplicates.length > 0) {
      throw new Error(`${fileName} duplicates generation-owned policy: ${duplicates.join(', ')}.`);
    }
  }

  return {
    id: FORECAST_SEMANTIC_BOUNDARY_ID,
    semanticFiles: [...FORECAST_SEMANTIC_INPUT_FILES],
    operationalFiles: [...FORECAST_OPERATIONAL_INPUT_FILES],
  };
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
    && value.semanticBoundary === FORECAST_SEMANTIC_BOUNDARY_ID
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

  await assertForecastSemanticBoundary({ repositoryRoot, readFileImpl });

  const semanticInputs = {};
  for (const relativePath of FORECAST_SEMANTIC_INPUT_FILES) {
    const source = await readFileImpl(path.join(repositoryRoot, relativePath), 'utf8');
    semanticInputs[relativePath] = sourceFingerprint(source, relativePath);
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
    semanticBoundary: FORECAST_SEMANTIC_BOUNDARY_ID,
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
