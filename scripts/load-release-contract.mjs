import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, '..');
export const DEFAULT_LOCATIONS_FILE = path.join(
  REPOSITORY_ROOT,
  'src',
  'config',
  'locations.json',
);
export const DEFAULT_CONTRACT_FILE = path.join(
  REPOSITORY_ROOT,
  'src',
  'features',
  'forecast',
  'releaseContract.ts',
);

export const IMPLEMENTED_CONTINUOUS_API_SCHEMA_VERSION = 2;

export class ContractError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ContractError';
  }
}



function validReleaseMetadata(value) {
  return value !== null
    && typeof value === 'object'
    && Number.isSafeInteger(value.apiSchemaVersion)
    && value.apiSchemaVersion > 0
    && Number.isSafeInteger(value.modelRevision)
    && value.modelRevision > 0
    && Number.isSafeInteger(value.payloadVersion)
    && value.payloadVersion > 0
    && Number.isSafeInteger(value.assembledCacheSchema)
    && value.assembledCacheSchema > 0
    && Number.isSafeInteger(value.marineCacheSchema)
    && value.marineCacheSchema > 0
    && typeof value.dataGenerationId === 'string'
    && /^[A-Za-z0-9._:-]+$/.test(value.dataGenerationId);
}

function sameStringSet(left, right) {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((item) => rightSet.has(item));
}

function contractConstantInitializers(source) {
  const sourceFile = ts.createSourceFile(
    'releaseContract.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const initializers = new Map();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) {
        initializers.set(declaration.name.text, declaration.initializer);
      }
    }
  }
  return initializers;
}

function evaluateContractConstant(initializers, name, stack = new Set()) {
  const initializer = initializers.get(name);
  if (!initializer) throw new ContractError(`The release contract is missing ${name}.`);
  if (stack.has(name)) throw new ContractError(`The release contract contains a cycle at ${name}.`);
  const nextStack = new Set(stack).add(name);

  const evaluate = (node) => {
    if (ts.isParenthesizedExpression(node)
      || ts.isAsExpression(node)
      || ts.isSatisfiesExpression(node)
      || ts.isNonNullExpression(node)) return evaluate(node.expression);
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isPrefixUnaryExpression(node)
      && node.operator === ts.SyntaxKind.MinusToken
      && ts.isNumericLiteral(node.operand)) return -Number(node.operand.text);
    if (ts.isIdentifier(node)) {
      return evaluateContractConstant(initializers, node.text, nextStack);
    }
    if (ts.isArrayLiteralExpression(node)) return node.elements.map(evaluate);
    if (ts.isObjectLiteralExpression(node)) {
      const result = {};
      for (const property of node.properties) {
        if (ts.isSpreadAssignment(property)) {
          const spread = evaluate(property.expression);
          if (!spread || typeof spread !== 'object' || Array.isArray(spread)) {
            throw new ContractError(`The release contract has an invalid object spread in ${name}.`);
          }
          Object.assign(result, spread);
          continue;
        }
        if (ts.isShorthandPropertyAssignment(property)) {
          result[property.name.text] = evaluateContractConstant(
            initializers,
            property.name.text,
            nextStack,
          );
          continue;
        }
        if (!ts.isPropertyAssignment(property)) {
          throw new ContractError(`The release contract has an unsupported property in ${name}.`);
        }
        const propertyName = ts.isIdentifier(property.name)
          || ts.isStringLiteralLike(property.name)
          || ts.isNumericLiteral(property.name)
          ? property.name.text
          : null;
        if (propertyName === null) {
          throw new ContractError(`The release contract has a computed property in ${name}.`);
        }
        result[propertyName] = evaluate(property.initializer);
      }
      return result;
    }
    if (ts.isCallExpression(node)
      && node.arguments.length === 1
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === 'Object'
      && node.expression.name.text === 'freeze') return evaluate(node.arguments[0]);
    throw new ContractError(`The release contract has an unsupported expression in ${name}.`);
  };

  return evaluate(initializer);
}

function uniqueApiVersions(value, { allowEmpty = false } = {}) {
  return Array.isArray(value)
    && (allowEmpty || value.length > 0)
    && value.every((version) => Number.isSafeInteger(version) && version > 0)
    && new Set(value).size === value.length;
}

export function parseReleasePolicy(source) {
  if (typeof source !== 'string') throw new ContractError('The release contract source is invalid.');
  const initializers = contractConstantInitializers(source);
  const release = evaluateContractConstant(initializers, 'CURRENT_RELEASE');
  const supportedApiSchemaVersions = evaluateContractConstant(
    initializers,
    'SUPPORTED_FORECAST_API_SCHEMA_VERSIONS',
  );
  const retiredApiSchemaVersions = evaluateContractConstant(
    initializers,
    'RETIRED_FORECAST_API_SCHEMA_VERSIONS',
  );
  const auditedPreviousReleases = evaluateContractConstant(
    initializers,
    'AUDITED_PREVIOUS_FORECAST_GENERATIONS',
  );
  if (!validReleaseMetadata(release)) {
    throw new ContractError('The current release descriptor is invalid.');
  }
  if (release.apiSchemaVersion !== IMPLEMENTED_CONTINUOUS_API_SCHEMA_VERSION) {
    throw new ContractError(
      `Breaking API v${release.apiSchemaVersion} is blocked. `
      + `FRANK currently continuously materializes only API v${IMPLEMENTED_CONTINUOUS_API_SCHEMA_VERSION}; `
      + 'implement and test an old-format adapter before changing the current API schema.',
    );
  }
  if (!uniqueApiVersions(supportedApiSchemaVersions)) {
    throw new ContractError('The supported API schema list is invalid.');
  }
  if (!uniqueApiVersions(retiredApiSchemaVersions, { allowEmpty: true })) {
    throw new ContractError('The retired API schema list is invalid.');
  }
  if (retiredApiSchemaVersions.includes(release.apiSchemaVersion)
    || retiredApiSchemaVersions.some((version) => supportedApiSchemaVersions.includes(version))) {
    throw new ContractError('A current or supported API schema cannot also be retired.');
  }
  if (!Array.isArray(auditedPreviousReleases)
    || !auditedPreviousReleases.every(validReleaseMetadata)) {
    throw new ContractError('An audited previous release descriptor is invalid.');
  }
  if (auditedPreviousReleases.length > 1) {
    throw new ContractError(
      'The release contract may retain only the current and one previous forecast generation.',
    );
  }

  const seenPriorApis = new Set();
  const auditedPriorApiReleases = [];
  for (const previous of auditedPreviousReleases) {
    if (previous.apiSchemaVersion === release.apiSchemaVersion
      || seenPriorApis.has(previous.apiSchemaVersion)) continue;
    seenPriorApis.add(previous.apiSchemaVersion);
    auditedPriorApiReleases.push(previous);
  }

  const activePriorApiReleases = auditedPriorApiReleases.filter(
    (previous) => !retiredApiSchemaVersions.includes(previous.apiSchemaVersion),
  );
  const descriptorApiVersions = new Set([
    release.apiSchemaVersion,
    ...activePriorApiReleases.map((previous) => previous.apiSchemaVersion),
  ]);
  if (!sameStringSet(
    supportedApiSchemaVersions.map(String),
    [...descriptorApiVersions].map(String),
  )) {
    throw new ContractError(
      'Supported API schema versions must exactly match the current and non-retired audited prior release descriptors.',
    );
  }
  if (activePriorApiReleases.length > 0) {
    const schemas = activePriorApiReleases
      .map((previous) => `v${previous.apiSchemaVersion}`)
      .join(', ');
    throw new ContractError(
      `Breaking API release is blocked for prior schema ${schemas}. `
      + 'Implement an explicit continuous representation-adapter registry and dual materialization; '
      + 'a deployment-time snapshot check cannot keep old clients fresh.',
    );
  }

  return {
    release,
    supportedApiSchemaVersions: [...supportedApiSchemaVersions],
    retiredApiSchemaVersions: [...retiredApiSchemaVersions],
    auditedPreviousReleases: [...auditedPreviousReleases],
    auditedPriorApiReleases,
  };
}

export function parseReleaseContract(source) {
  return parseReleasePolicy(source).release;
}

export async function loadReleaseContract({
  locationsFile = DEFAULT_LOCATIONS_FILE,
  contractFile = DEFAULT_CONTRACT_FILE,
} = {}) {
  let locations;
  let contractSource;
  try {
    [locations, contractSource] = await Promise.all([
      readFile(locationsFile, 'utf8').then(JSON.parse),
      readFile(contractFile, 'utf8'),
    ]);
  } catch {
    throw new ContractError('The checked-in release contract could not be loaded.');
  }

  if (!Array.isArray(locations) || locations.length === 0) {
    throw new ContractError('The location manifest is empty or invalid.');
  }

  const ids = locations.map((location) => location?.id);
  if (ids.some((id) => typeof id !== 'string' || !/^[a-z0-9-]+$/.test(id))) {
    throw new ContractError('The location manifest contains an invalid id.');
  }
  if (new Set(ids).size !== ids.length) {
    throw new ContractError('The location manifest contains duplicate ids.');
  }

  if (locations.some((location) => !Number.isFinite(location?.coordinate?.latitude)
    || !Number.isFinite(location?.coordinate?.longitude))) {
    throw new ContractError('The location manifest contains an invalid coordinate.');
  }
  if (locations.some((location) => !Number.isSafeInteger(location?.forecastConfigRevision)
    || location.forecastConfigRevision < 1)) {
    throw new ContractError('The location manifest contains an invalid forecastConfigRevision.');
  }

  const policy = parseReleasePolicy(contractSource);
  const { release } = policy;
  const expectedVersion = release.payloadVersion;

  return {
    locationIds: ids,
    locations: locations.map((location) => ({
      id: location.id,
      name: location.name,
      areaName: location.areaName,
      forecastConfigRevision: location.forecastConfigRevision,
      coordinate: {
        latitude: location.coordinate.latitude,
        longitude: location.coordinate.longitude,
      },
      timezone: location.timezone,
      dmiCollections: location.dmiCollections,
      emmaId: location.emmaId,
      kommuneAliases: location.kommuneAliases,
    })),
    expectedVersion,
    release,
    supportedApiSchemaVersions: policy.supportedApiSchemaVersions,
    retiredApiSchemaVersions: policy.retiredApiSchemaVersions,
    auditedPreviousReleases: policy.auditedPreviousReleases,
    auditedPriorApiReleases: policy.auditedPriorApiReleases,
  };
}
