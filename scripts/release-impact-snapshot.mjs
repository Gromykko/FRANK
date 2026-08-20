import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import ts from 'typescript';

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, '..');
const SNAPSHOT_SCHEMA_VERSION = 1;
const SOURCE_SHA = /^[a-f0-9]{40}$/i;
const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const LOCATION_ID = /^[a-z0-9-]+$/;
const GENERATION_ID = /^[A-Za-z0-9._:-]+$/;
const MAX_GIT_OUTPUT_BYTES = 32 * 1024 * 1024;

const PRODUCTION_PROVENANCE = 'attested-production';
const CANDIDATE_PROVENANCE = 'candidate';
const RELEASE_CONTRACT_FILE = 'src/features/forecast/releaseContract.ts';
const LOCATIONS_FILE = 'src/config/locations.json';
const MODEL_CONTRACT_FILE = 'scripts/forecast-model-contract.mjs';
const PAGES_ENTRY_FILE = 'src/main.tsx';
const WORKER_ENTRY_FILE = 'worker/index.ts';

const PAGES_CONFIG_FILES = Object.freeze([
  'index.html',
  'vite.config.ts',
  'tsconfig.json',
  'tsconfig.app.json',
  'tsconfig.node.json',
]);
const WORKER_CONFIG_FILES = Object.freeze([
  'wrangler.jsonc',
  'tsconfig.worker.json',
]);
const REQUIRED_CANDIDATE_RELEASE_TOOLS = Object.freeze([
  'scripts/release-impact.mjs',
  'scripts/release-impact-snapshot.mjs',
]);
const DIRTY_RELEVANT_PATHS = Object.freeze([
  '.github/workflows',
  'index.html',
  'package.json',
  'package-lock.json',
  'public',
  'release',
  'scripts',
  'src',
  'tsconfig.json',
  'tsconfig.app.json',
  'tsconfig.node.json',
  'tsconfig.worker.json',
  'vite.config.ts',
  'worker',
  'wrangler.jsonc',
]);
const RELEASE_TOOL_FILE = /^scripts\/(?:active-worker-version|check-release-contract|coordinated-release|forecast-model-contract|gc-worker-kv|release-artifact|release-impact(?:-snapshot)?|resolve-worker-release|verify-pages-release|verify-worker-deployment|warm-worker|worker-release-attestation|worker-version-by-tag)\.mjs$/;

const SOURCE_EXTENSIONS = Object.freeze([
  '',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.json',
  '.css',
  '/index.ts',
  '/index.tsx',
  '/index.js',
  '/index.jsx',
  '/index.mjs',
]);
const BUILTIN_PACKAGES = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

const USAGE = `Usage: node scripts/release-impact-snapshot.mjs \\
  --source-sha <40-hex-sha> \\
  --provenance <candidate|attested-production> \\
  [--output <snapshot.json>]
`;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

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

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function normalizeSourceSha(value, label = 'Source SHA') {
  if (typeof value !== 'string' || !SOURCE_SHA.test(value)) {
    throw new Error(`${label} must be a full 40-character Git SHA.`);
  }
  return value.toLowerCase();
}

function normalizeProvenance(value) {
  if (value !== CANDIDATE_PROVENANCE && value !== PRODUCTION_PROVENANCE) {
    throw new Error('Snapshot provenance must be candidate or attested-production.');
  }
  return value;
}

function buffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (value && Buffer.isBuffer(value.stdout)) return value.stdout;
  if (value && typeof value.stdout === 'string') return Buffer.from(value.stdout, 'utf8');
  throw new Error('Git returned an invalid response.');
}

async function defaultGit(repositoryRoot, args) {
  const result = await execFileAsync('git', ['-C', repositoryRoot, ...args], {
    encoding: 'buffer',
    windowsHide: true,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
  });
  return buffer(result);
}

function utf8(value, label) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch {
    throw new Error(`${label} is not valid UTF-8.`);
  }
}

function parseGitTree(raw) {
  const entries = new Map();
  for (const record of utf8(raw, 'Git tree').split('\0')) {
    if (!record) continue;
    const match = record.match(/^[0-7]{6} blob ([a-f0-9]{40}|[a-f0-9]{64})\t(.+)$/i);
    if (!match) continue;
    const [, objectId, fileName] = match;
    if (entries.has(fileName)) throw new Error(`Git tree contains duplicate path ${fileName}.`);
    entries.set(fileName, objectId.toLowerCase());
  }
  if (entries.size === 0) throw new Error('Source commit contains no readable Git blobs.');
  return entries;
}

class GitBlobTree {
  constructor(sourceSha, entries, runGit) {
    this.sourceSha = sourceSha;
    this.entries = entries;
    this.runGit = runGit;
    this.cache = new Map();
  }

  has(fileName) {
    return this.entries.has(fileName);
  }

  paths() {
    return [...this.entries.keys()].sort();
  }

  objectId(fileName) {
    const objectId = this.entries.get(fileName);
    if (!objectId || !GIT_OBJECT_ID.test(objectId)) {
      throw new Error(`Required source blob is missing: ${fileName}.`);
    }
    return objectId;
  }

  async read(fileName) {
    if (this.cache.has(fileName)) return this.cache.get(fileName);
    const value = await this.runGit(['cat-file', 'blob', this.objectId(fileName)]);
    this.cache.set(fileName, value);
    return value;
  }

  async readText(fileName) {
    return utf8(await this.read(fileName), fileName);
  }
}

async function loadGitBlobTree({ sourceSha, repositoryRoot, gitImpl }) {
  const runGit = gitImpl
    ? async (args) => buffer(await gitImpl(args))
    : async (args) => defaultGit(repositoryRoot, args);
  let resolved;
  try {
    resolved = utf8(
      await runGit(['rev-parse', '--verify', `${sourceSha}^{commit}`]),
      'Resolved source SHA',
    ).trim().toLowerCase();
  } catch (error) {
    throw new Error(
      `Source SHA does not identify an existing commit: ${error instanceof Error ? error.message : 'Git lookup failed'}.`,
    );
  }
  if (resolved !== sourceSha) {
    throw new Error('Source SHA did not resolve to the exact requested commit.');
  }
  const tree = parseGitTree(await runGit([
    'ls-tree',
    '-r',
    '-z',
    '--full-tree',
    sourceSha,
  ]));
  return { tree: new GitBlobTree(sourceSha, tree, runGit), runGit };
}

async function requireCleanCandidate({ sourceSha, runGit }) {
  const head = utf8(await runGit(['rev-parse', '--verify', 'HEAD^{commit}']), 'HEAD SHA')
    .trim()
    .toLowerCase();
  if (head !== sourceSha) {
    throw new Error('Candidate snapshot SHA must equal the repository HEAD commit.');
  }
  const status = await runGit([
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--',
    ...DIRTY_RELEVANT_PATHS,
  ]);
  if (status.length > 0) {
    throw new Error(
      'Candidate release inputs are dirty or untracked; snapshot only an exact committed tree.',
    );
  }
}

function unwrapExpression(node) {
  let current = node;
  while (ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
    || (ts.isSatisfiesExpression && ts.isSatisfiesExpression(current))) {
    current = current.expression;
  }
  return current;
}

function constInitializers(source, fileName) {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.ESNext,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  if (sourceFile.parseDiagnostics?.length > 0) {
    throw new Error(`${fileName} contains invalid TypeScript syntax.`);
  }
  const initializers = new Map();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      if (initializers.has(declaration.name.text)) {
        throw new Error(`${fileName} declares ${declaration.name.text} more than once.`);
      }
      initializers.set(declaration.name.text, declaration.initializer);
    }
  }
  return initializers;
}

function evaluateStaticConstant(initializers, name, fileName, stack = new Set()) {
  const initializer = initializers.get(name);
  if (!initializer) throw new Error(`${fileName} is missing ${name}.`);
  if (stack.has(name)) throw new Error(`${fileName} contains a constant cycle at ${name}.`);
  const nextStack = new Set(stack).add(name);

  const evaluate = (input) => {
    const node = unwrapExpression(input);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isPrefixUnaryExpression(node)
      && node.operator === ts.SyntaxKind.MinusToken
      && ts.isNumericLiteral(node.operand)) return -Number(node.operand.text);
    if (ts.isIdentifier(node)) {
      if (node.text === 'undefined') return undefined;
      return evaluateStaticConstant(initializers, node.text, fileName, nextStack);
    }
    if (ts.isCallExpression(node)
      && node.arguments.length === 1
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === 'Object'
      && node.expression.name.text === 'freeze') {
      return evaluate(node.arguments[0]);
    }
    if (ts.isArrayLiteralExpression(node)) {
      const values = [];
      for (const element of node.elements) {
        if (ts.isOmittedExpression(element)) {
          throw new Error(`${fileName} contains an array hole in ${name}.`);
        }
        if (ts.isSpreadElement(element)) {
          const spread = evaluate(element.expression);
          if (!Array.isArray(spread)) {
            throw new Error(`${fileName} contains a non-array spread in ${name}.`);
          }
          values.push(...spread);
        } else {
          values.push(evaluate(element));
        }
      }
      return values;
    }
    if (ts.isObjectLiteralExpression(node)) {
      const value = Object.create(null);
      for (const property of node.properties) {
        if (ts.isSpreadAssignment(property)) {
          const spread = evaluate(property.expression);
          if (!isRecord(spread)) {
            throw new Error(`${fileName} contains a non-object spread in ${name}.`);
          }
          Object.assign(value, spread);
          continue;
        }
        if (ts.isShorthandPropertyAssignment(property)) {
          value[property.name.text] = evaluateStaticConstant(
            initializers,
            property.name.text,
            fileName,
            nextStack,
          );
          continue;
        }
        if (!ts.isPropertyAssignment(property)
          || (!ts.isIdentifier(property.name)
            && !ts.isStringLiteral(property.name)
            && !ts.isNumericLiteral(property.name))) {
          throw new Error(`${fileName} contains an unsupported object member in ${name}.`);
        }
        value[property.name.text] = evaluate(property.initializer);
      }
      return value;
    }
    throw new Error(`${fileName} contains an executable or unsupported expression in ${name}.`);
  };

  return evaluate(initializer);
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
    throw new Error(`${label} release descriptor is malformed.`);
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

async function parseReleasePolicy(tree) {
  const initializers = constInitializers(
    await tree.readText(RELEASE_CONTRACT_FILE),
    RELEASE_CONTRACT_FILE,
  );
  const release = normalizeRelease(
    evaluateStaticConstant(initializers, 'CURRENT_RELEASE', RELEASE_CONTRACT_FILE),
    'Current',
  );
  const supported = evaluateStaticConstant(
    initializers,
    'SUPPORTED_FORECAST_API_SCHEMA_VERSIONS',
    RELEASE_CONTRACT_FILE,
  );
  if (!Array.isArray(supported)
    || supported.length === 0
    || supported.some((version) => !positiveInteger(version))
    || new Set(supported).size !== supported.length
    || !supported.includes(release.apiSchemaVersion)) {
    throw new Error('Supported forecast API schema policy is malformed.');
  }
  const previous = evaluateStaticConstant(
    initializers,
    'AUDITED_PREVIOUS_FORECAST_GENERATIONS',
    RELEASE_CONTRACT_FILE,
  );
  if (!Array.isArray(previous) || previous.length > 1) {
    throw new Error('Audited previous forecast release policy is malformed.');
  }
  return {
    release,
    supportedApiSchemaVersions: [...supported].sort((left, right) => left - right),
    auditedPreviousReleases: previous.map((value, index) => normalizeRelease(
      value,
      `Audited previous ${index + 1}`,
    )),
  };
}

function normalizedSource(value) {
  return value.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n');
}

async function forecastSemanticInputs(tree) {
  const initializers = constInitializers(
    await tree.readText(MODEL_CONTRACT_FILE),
    MODEL_CONTRACT_FILE,
  );
  const files = evaluateStaticConstant(
    initializers,
    'FORECAST_SEMANTIC_INPUT_FILES',
    MODEL_CONTRACT_FILE,
  );
  if (!Array.isArray(files)
    || files.length === 0
    || files.some((fileName) => typeof fileName !== 'string'
      || fileName.length === 0
      || fileName.startsWith('/')
      || fileName.split('/').includes('..'))
    || new Set(files).size !== files.length) {
    throw new Error('Forecast semantic input file policy is malformed.');
  }
  const entries = await Promise.all([...files].sort().map(async (fileName) => [
    fileName,
    sha256(normalizedSource(await tree.readText(fileName))),
  ]));
  return Object.fromEntries(entries);
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

async function forecastLocations(tree) {
  let value;
  try {
    value = JSON.parse(await tree.readText(LOCATIONS_FILE));
  } catch (error) {
    throw new Error(
      `Forecast location configuration is not valid JSON: ${error instanceof Error ? error.message : 'parse failed'}.`,
    );
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Forecast location configuration is empty or malformed.');
  }
  const seen = new Set();
  const locations = value.map((location) => {
    if (!isRecord(location)
      || typeof location.id !== 'string'
      || !LOCATION_ID.test(location.id)
      || seen.has(location.id)
      || !positiveInteger(location.forecastConfigRevision)
      || !isRecord(location.coordinate)
      || !Number.isFinite(location.coordinate.latitude)
      || location.coordinate.latitude < -90
      || location.coordinate.latitude > 90
      || !Number.isFinite(location.coordinate.longitude)
      || location.coordinate.longitude < -180
      || location.coordinate.longitude > 180
      || typeof location.timezone !== 'string'
      || location.timezone.length === 0
      || !isRecord(location.dmiCollections)
      || !Array.isArray(location.dmiCollections.water)
      || location.dmiCollections.water.length === 0
      || location.dmiCollections.water.some((entry) => typeof entry !== 'string' || !entry)
      || !Array.isArray(location.dmiCollections.waves)
      || location.dmiCollections.waves.length === 0
      || location.dmiCollections.waves.some((entry) => typeof entry !== 'string' || !entry)
      || (location.emmaId !== undefined && typeof location.emmaId !== 'string')
      || (location.kommuneAliases !== undefined
        && (!Array.isArray(location.kommuneAliases)
          || location.kommuneAliases.some((entry) => typeof entry !== 'string' || !entry)))) {
      throw new Error('Forecast location configuration contains an invalid location.');
    }
    seen.add(location.id);
    return {
      id: location.id,
      forecastConfigRevision: location.forecastConfigRevision,
      inputHash: sha256(canonicalJson(forecastLocationInput(location))),
    };
  });
  return locations.sort((left, right) => left.id.localeCompare(right.id));
}

function importedSpecifiers(source, fileName) {
  const scriptKind = fileName.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : fileName.endsWith('.jsx')
      ? ts.ScriptKind.JSX
      : fileName.endsWith('.js') || fileName.endsWith('.mjs')
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.ESNext,
    true,
    scriptKind,
  );
  const specifiers = new Set();
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier
      && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.add(node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression
      && ts.isStringLiteral(node.moduleReference.expression)) {
      specifiers.add(node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node)
      && node.arguments.length > 0
      && ts.isStringLiteral(node.arguments[0])
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      specifiers.add(node.arguments[0].text);
    } else if (ts.isNewExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'URL'
      && node.arguments?.length
      && ts.isStringLiteral(node.arguments[0])
      && (node.arguments[0].text.startsWith('./')
        || node.arguments[0].text.startsWith('../'))) {
      // Vite turns new URL('./asset', import.meta.url) into a build dependency.
      // Resolving any literal relative URL is conservative and avoids executing
      // the historical module merely to discover its asset graph.
      specifiers.add(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...specifiers];
}

function cssSpecifiers(source) {
  const specifiers = new Set();
  const patterns = [
    /@import\s+(?:url\()?\s*['"]([^'"]+)['"]/g,
    /url\(\s*['"]?([^'"\s)]+)['"]?\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.add(match[1]);
  }
  return [...specifiers];
}

function isRelativeSpecifier(value) {
  return value.startsWith('./') || value.startsWith('../');
}

function packageName(specifier) {
  if (!specifier
    || isRelativeSpecifier(specifier)
    || specifier.startsWith('/')
    || specifier.startsWith('data:')
    || specifier.startsWith('http:')
    || specifier.startsWith('https:')
    || specifier.startsWith('cloudflare:')
    || BUILTIN_PACKAGES.has(specifier)) return null;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function resolveRelativeImport(tree, importer, specifier) {
  const withoutQuery = specifier.split(/[?#]/, 1)[0];
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(importer), withoutQuery));
  if (base === '..' || base.startsWith('../') || path.posix.isAbsolute(base)) {
    throw new Error(`Source import escapes the repository: ${importer} -> ${specifier}.`);
  }
  for (const extension of SOURCE_EXTENSIONS) {
    const candidate = `${base}${extension}`;
    if (tree.has(candidate)) return candidate;
  }
  throw new Error(`Cannot resolve source import ${specifier} from ${importer}.`);
}

function relativeNodeModulePackage(importer, specifier) {
  const withoutQuery = specifier.split(/[?#]/, 1)[0];
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(importer), withoutQuery),
  );
  return resolved.startsWith('node_modules/')
    ? packageName(resolved.slice('node_modules/'.length))
    : null;
}

function pagesHtmlEntries(tree, source) {
  const entries = new Set();
  for (const match of source.matchAll(/\b(?:src|href)\s*=\s*['"]([^'"]+)['"]/gi)) {
    const raw = match[1].split(/[?#]/, 1)[0];
    const candidate = raw.startsWith('/src/')
      ? raw.slice(1)
      : raw.startsWith('src/')
        ? raw
        : raw.startsWith('./src/')
          ? raw.slice(2)
          : null;
    if (!candidate) continue;
    if (!tree.has(candidate)) {
      throw new Error(`Pages HTML references missing source entry ${candidate}.`);
    }
    entries.add(candidate);
  }
  if (entries.size === 0) {
    if (!tree.has(PAGES_ENTRY_FILE)) {
      throw new Error('Pages HTML contains no resolvable source entry.');
    }
    entries.add(PAGES_ENTRY_FILE);
  }
  return [...entries].sort();
}

async function sourceGraph(tree, entries) {
  const pending = [...entries];
  const visited = new Set();
  const externalPackages = new Set();
  while (pending.length > 0) {
    const fileName = pending.pop();
    if (visited.has(fileName)) continue;
    if (!tree.has(fileName)) throw new Error(`Source graph entry is missing: ${fileName}.`);
    visited.add(fileName);
    if (!/\.(?:[cm]?[jt]sx?|css)$/.test(fileName)) continue;
    const source = await tree.readText(fileName);
    const specifiers = fileName.endsWith('.css')
      ? cssSpecifiers(source)
      : importedSpecifiers(source, fileName);
    for (const specifier of specifiers) {
      if (isRelativeSpecifier(specifier)) {
        const dependency = relativeNodeModulePackage(fileName, specifier);
        if (dependency) externalPackages.add(dependency);
        else pending.push(resolveRelativeImport(tree, fileName, specifier));
      } else {
        const dependency = packageName(specifier);
        if (dependency) externalPackages.add(dependency);
      }
    }
  }
  return {
    files: [...visited].sort(),
    externalPackages: [...externalPackages].sort(),
  };
}

function parseJson(source, label) {
  try {
    const value = JSON.parse(source);
    if (!isRecord(value)) throw new Error('expected an object');
    return value;
  } catch (error) {
    throw new Error(`${label} is malformed: ${error instanceof Error ? error.message : 'parse failed'}.`);
  }
}

function resolveLockedPackage(packages, fromKey, dependencyName) {
  let cursor = fromKey;
  while (true) {
    const candidate = cursor
      ? `${cursor}/node_modules/${dependencyName}`
      : `node_modules/${dependencyName}`;
    if (packages[candidate]) return candidate;
    if (!cursor) return null;
    const parentMarker = cursor.lastIndexOf('/node_modules/');
    cursor = parentMarker >= 0 ? cursor.slice(0, parentMarker) : '';
  }
}

function lockedDependencyClosure(lock, directNames) {
  if (!positiveInteger(lock.lockfileVersion) || !isRecord(lock.packages) || !lock.packages['']) {
    throw new Error('package-lock.json does not contain a supported packages manifest.');
  }
  const packages = lock.packages;
  const selected = new Map();
  const queue = [...new Set(directNames)].sort().map((name) => ({
    fromKey: '',
    name,
    optional: false,
  }));
  while (queue.length > 0) {
    const { fromKey, name, optional } = queue.shift();
    const packageKey = resolveLockedPackage(packages, fromKey, name);
    if (!packageKey) {
      if (optional) continue;
      throw new Error(`package-lock.json is missing required dependency ${name}.`);
    }
    if (selected.has(packageKey)) continue;
    const entry = packages[packageKey];
    if (!isRecord(entry)) throw new Error(`package-lock entry ${packageKey} is malformed.`);
    selected.set(packageKey, entry);
    for (const dependencyName of Object.keys(entry.dependencies ?? {}).sort()) {
      queue.push({ fromKey: packageKey, name: dependencyName, optional: false });
    }
    for (const dependencyName of Object.keys(entry.optionalDependencies ?? {}).sort()) {
      queue.push({ fromKey: packageKey, name: dependencyName, optional: true });
    }
    for (const dependencyName of Object.keys(entry.peerDependencies ?? {}).sort()) {
      const optionalPeer = entry.peerDependenciesMeta?.[dependencyName]?.optional === true;
      queue.push({ fromKey: packageKey, name: dependencyName, optional: optionalPeer });
    }
  }
  return Object.fromEntries([...selected.entries()].sort(([left], [right]) => (
    left.localeCompare(right)
  )));
}

async function dependencyManifest(tree, {
  directNames,
  relevantScripts = [],
  includeAllScripts = false,
}) {
  const packageJson = parseJson(await tree.readText('package.json'), 'package.json');
  const lock = parseJson(await tree.readText('package-lock.json'), 'package-lock.json');
  const declared = {
    ...(packageJson.dependencies ?? {}),
    ...(packageJson.devDependencies ?? {}),
  };
  const names = [...new Set(directNames)].sort();
  for (const name of names) {
    if (typeof declared[name] !== 'string' || !declared[name]) {
      throw new Error(`package.json does not declare required dependency ${name}.`);
    }
  }
  const scripts = {};
  const scriptNames = includeAllScripts
    ? Object.keys(packageJson.scripts ?? {}).sort()
    : relevantScripts;
  for (const name of scriptNames) {
    const command = packageJson.scripts?.[name];
    if (typeof command !== 'string' || !command) {
      throw new Error(`package.json is missing required script ${name}.`);
    }
    scripts[name] = command;
  }
  return {
    package: {
      name: packageJson.name,
      version: packageJson.version,
      engines: packageJson.engines,
      scripts,
    },
    directDependencies: Object.fromEntries(names.map((name) => [name, declared[name]])),
    lockedPackages: lockedDependencyClosure(lock, names),
  };
}

async function fileIdentityManifest(tree, files) {
  const entries = await Promise.all([...new Set(files)].sort().map(async (fileName) => [
    fileName,
    sha256(await tree.read(fileName)),
  ]));
  return Object.fromEntries(entries);
}

function releaseToolFiles(tree) {
  return tree.paths().filter((fileName) => (
    fileName === 'release/forecast-model-baseline.json'
    || fileName === '.github/workflows/deploy-worker.yml'
    || fileName === '.github/workflows/deploy.yml'
    || RELEASE_TOOL_FILE.test(fileName)
  ));
}

async function pagesContentIdentity(tree) {
  for (const fileName of PAGES_CONFIG_FILES) tree.objectId(fileName);
  const appGraph = await sourceGraph(
    tree,
    pagesHtmlEntries(tree, await tree.readText('index.html')),
  );
  const configGraph = await sourceGraph(tree, ['vite.config.ts']);
  const publicFiles = tree.paths().filter((fileName) => fileName.startsWith('public/'));
  if (publicFiles.length === 0) throw new Error('Pages public asset tree is empty.');
  const packageJson = parseJson(await tree.readText('package.json'), 'package.json');
  const runtimeDependencies = Object.keys(packageJson.dependencies ?? {});
  const dependencies = await dependencyManifest(tree, {
    directNames: [
      ...runtimeDependencies,
      ...appGraph.externalPackages,
      ...configGraph.externalPackages,
      '@vitejs/plugin-react',
      'typescript',
      'vite',
    ],
    relevantScripts: ['build'],
  });
  return sha256(canonicalJson({
    schemaVersion: 1,
    files: await fileIdentityManifest(tree, [
      ...PAGES_CONFIG_FILES,
      ...appGraph.files,
      ...configGraph.files,
      ...publicFiles,
    ]),
    dependencies,
  }));
}

async function workerRuntimeIdentity(tree, provenance) {
  for (const fileName of WORKER_CONFIG_FILES) tree.objectId(fileName);
  if (provenance === CANDIDATE_PROVENANCE) {
    for (const fileName of REQUIRED_CANDIDATE_RELEASE_TOOLS) tree.objectId(fileName);
  }
  const graph = await sourceGraph(tree, [WORKER_ENTRY_FILE]);
  const tools = releaseToolFiles(tree);
  const toolGraph = await sourceGraph(tree, tools);
  const dependencies = await dependencyManifest(tree, {
    directNames: [
      ...graph.externalPackages,
      ...toolGraph.externalPackages,
      'typescript',
      'wrangler',
    ],
    includeAllScripts: true,
  });
  return sha256(canonicalJson({
    schemaVersion: 1,
    files: await fileIdentityManifest(tree, [
      ...WORKER_CONFIG_FILES,
      ...graph.files,
      ...toolGraph.files,
    ]),
    dependencies,
  }));
}

/**
 * Build an immutable impact snapshot entirely from Git blobs. `provenance`
 * states what the caller has already established; only the release controller
 * may label a captured active commit as attested production.
 */
export async function buildReleaseImpactSnapshot({
  sourceSha,
  provenance,
  repositoryRoot = REPOSITORY_ROOT,
  gitImpl,
} = {}) {
  const normalizedSha = normalizeSourceSha(sourceSha);
  const normalizedProvenance = normalizeProvenance(provenance);
  const resolvedRoot = path.resolve(repositoryRoot);
  const { tree, runGit } = await loadGitBlobTree({
    sourceSha: normalizedSha,
    repositoryRoot: resolvedRoot,
    gitImpl,
  });
  if (normalizedProvenance === CANDIDATE_PROVENANCE) {
    await requireCleanCandidate({ sourceSha: normalizedSha, runGit });
  }
  const [policy, semanticInputs, locations, pagesBuildId, workerRuntimeHash] = await Promise.all([
    parseReleasePolicy(tree),
    forecastSemanticInputs(tree),
    forecastLocations(tree),
    pagesContentIdentity(tree),
    workerRuntimeIdentity(tree, normalizedProvenance),
  ]);
  if (!SHA256.test(pagesBuildId) || !SHA256.test(workerRuntimeHash)) {
    throw new Error('Release-impact content fingerprints are invalid.');
  }
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    sourceSha: normalizedSha,
    provenance: normalizedProvenance,
    pagesBuildId,
    workerRuntimeHash,
    release: policy.release,
    supportedApiSchemaVersions: policy.supportedApiSchemaVersions,
    auditedPreviousReleases: policy.auditedPreviousReleases,
    semanticInputs,
    locations,
  };
}

export function parseReleaseImpactSnapshotArguments(argv) {
  if (!Array.isArray(argv)) throw new Error('Snapshot-builder arguments are invalid.');
  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  const known = new Set(['--source-sha', '--provenance', '--output']);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!known.has(option)) throw new Error(`Unknown snapshot-builder option: ${option ?? ''}.`);
    if (typeof value !== 'string' || !value || value.startsWith('--')) {
      throw new Error(`Missing value for ${option}.`);
    }
    if (Object.prototype.hasOwnProperty.call(values, option)) {
      throw new Error(`Duplicate snapshot-builder option: ${option}.`);
    }
    values[option] = value;
  }
  if (!values['--source-sha']) throw new Error('Missing required option: --source-sha.');
  if (!values['--provenance']) throw new Error('Missing required option: --provenance.');
  return {
    help: false,
    sourceSha: values['--source-sha'],
    provenance: values['--provenance'],
    outputFile: values['--output'],
  };
}

export async function runReleaseImpactSnapshotCli(
  argv = process.argv.slice(2),
  {
    buildImpl = buildReleaseImpactSnapshot,
    writeFileImpl = writeFile,
    stdout = process.stdout,
    repositoryRoot = REPOSITORY_ROOT,
  } = {},
) {
  const options = parseReleaseImpactSnapshotArguments(argv);
  if (options.help) {
    stdout.write(USAGE);
    return null;
  }
  const snapshot = await buildImpl({
    sourceSha: options.sourceSha,
    provenance: options.provenance,
    repositoryRoot,
  });
  const output = `${JSON.stringify(snapshot, null, 2)}\n`;
  if (options.outputFile) {
    await writeFileImpl(path.resolve(options.outputFile), output, 'utf8');
  } else {
    stdout.write(output);
  }
  return snapshot;
}

if (process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runReleaseImpactSnapshotCli().catch((error) => {
    console.error(`[release] ${error instanceof Error ? error.message : 'Snapshot build failed.'}`);
    process.exitCode = 1;
  });
}
