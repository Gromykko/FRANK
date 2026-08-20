import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { loadReleaseContract } from './warm-worker.mjs';
import { decodeReleaseAttestation } from './worker-release-attestation.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, '..');
const WRANGLER_BIN = path.join(REPOSITORY_ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const WRANGLER_CONFIG = path.join(REPOSITORY_ROOT, 'wrangler.jsonc');
const execFileAsync = promisify(execFile);

export const FORECAST_KV_BINDING = 'FRANK_FORECAST_CACHE';
export const FRANK_GENERATION_KEY_ROOT = 'frank:forecast-release:';
export const MAX_BULK_DELETE_KEYS = 10_000;
const DEFAULT_VERIFICATION_ATTEMPTS = 5;
const DEFAULT_VERIFICATION_DELAY_MS = 2_000;

const GENERATION_KEY = /^frank:forecast-release:api:v([1-9][0-9]*):model:v([1-9][0-9]*):generation:([^:]+):payload:v([1-9][0-9]*):assembled-cache:v([1-9][0-9]*):marine-cache:v([1-9][0-9]*):(.+)$/;
const GENERATION_ID = /^[A-Za-z0-9._:-]+$/;

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validRelease(value) {
  return value !== null
    && typeof value === 'object'
    && positiveInteger(value.apiSchemaVersion)
    && positiveInteger(value.modelRevision)
    && positiveInteger(value.payloadVersion)
    && positiveInteger(value.assembledCacheSchema)
    && positiveInteger(value.marineCacheSchema)
    && typeof value.dataGenerationId === 'string'
    && GENERATION_ID.test(value.dataGenerationId);
}

function sameRelease(left, right) {
  return generationKeyPrefix(left) === generationKeyPrefix(right);
}

function sleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export function generationKeyPrefix(release) {
  if (!validRelease(release)) throw new Error('Forecast release metadata is invalid for KV GC.');
  return [
    'frank:forecast-release',
    `api:v${release.apiSchemaVersion}`,
    `model:v${release.modelRevision}`,
    `generation:${encodeURIComponent(release.dataGenerationId)}`,
    `payload:v${release.payloadVersion}`,
    `assembled-cache:v${release.assembledCacheSchema}`,
    `marine-cache:v${release.marineCacheSchema}`,
  ].join(':');
}

export function parseGenerationScopedKey(key) {
  if (typeof key !== 'string') return null;
  const match = key.match(GENERATION_KEY);
  if (!match) return null;

  const [
    ,
    apiSchemaVersion,
    modelRevision,
    encodedGenerationId,
    payloadVersion,
    assembledCacheSchema,
    marineCacheSchema,
  ] = match;
  let dataGenerationId;
  try {
    dataGenerationId = decodeURIComponent(encodedGenerationId);
  } catch {
    return null;
  }
  if (!GENERATION_ID.test(dataGenerationId)
    || encodeURIComponent(dataGenerationId) !== encodedGenerationId) return null;

  const release = {
    apiSchemaVersion: Number(apiSchemaVersion),
    modelRevision: Number(modelRevision),
    dataGenerationId,
    payloadVersion: Number(payloadVersion),
    assembledCacheSchema: Number(assembledCacheSchema),
    marineCacheSchema: Number(marineCacheSchema),
  };
  if (!validRelease(release)) return null;
  const prefix = generationKeyPrefix(release);
  return key.startsWith(`${prefix}:`) ? { key, prefix, release } : null;
}

function listedKeyNames(value) {
  if (!Array.isArray(value)) throw new Error('Wrangler returned an invalid KV key list.');
  const names = value.map((entry) => {
    if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string') {
      throw new Error('Wrangler returned a malformed KV key entry.');
    }
    return entry.name;
  });
  if (new Set(names).size !== names.length) {
    throw new Error('Wrangler returned duplicate KV keys; refusing cleanup.');
  }
  return names;
}

function retainedReleases(currentRelease, auditedPreviousReleases) {
  if (!validRelease(currentRelease) || !Array.isArray(auditedPreviousReleases)) {
    throw new Error('Forecast release retention policy is invalid.');
  }
  if (!auditedPreviousReleases.every(validRelease)) {
    throw new Error('An audited previous forecast release is malformed.');
  }
  const sameApiPrevious = auditedPreviousReleases.filter(
    (release) => release.apiSchemaVersion === currentRelease.apiSchemaVersion,
  );
  if (auditedPreviousReleases.length !== sameApiPrevious.length) {
    throw new Error('Cross-API KV generation cleanup needs an explicit compatibility retention policy.');
  }
  if (sameApiPrevious.length > 1) {
    throw new Error('KV GC accepts at most one audited previous generation; ordering is ambiguous.');
  }
  if (sameApiPrevious[0] && sameRelease(sameApiPrevious[0], currentRelease)) {
    throw new Error('The audited previous generation duplicates CURRENT_RELEASE.');
  }
  if (sameApiPrevious[0]
    && sameApiPrevious[0].modelRevision >= currentRelease.modelRevision) {
    throw new Error('The audited previous generation must have an older model revision.');
  }
  return [currentRelease, ...sameApiPrevious];
}

function requireAttestedActiveRelease(
  attestedActiveRelease,
  currentRelease,
  auditedPreviousReleases,
) {
  if (!validRelease(attestedActiveRelease)) {
    throw new Error('KV GC apply requires an attested captured Worker release.');
  }
  const retained = retainedReleases(currentRelease, auditedPreviousReleases);
  if (!retained.some((release) => sameRelease(release, attestedActiveRelease))) {
    throw new Error('Attested captured Worker release is outside the current/N-1 retention policy.');
  }
}

export function planWorkerKvGc({
  listedKeys,
  currentRelease,
  auditedPreviousReleases = [],
}) {
  const keyNames = listedKeyNames(listedKeys);
  const keepReleases = retainedReleases(currentRelease, auditedPreviousReleases);
  const retainedPrefixes = keepReleases.map(generationKeyPrefix);
  const retainedPrefixSet = new Set(retainedPrefixes);
  const oldestRetainedModelRevision = Math.min(
    ...keepReleases.map((release) => release.modelRevision),
  );
  const deleteKeys = [];
  const retainedKeys = [];
  const ignoredKeys = [];
  const ambiguousPrefixes = new Set();
  const stalePrefixes = new Set();

  for (const key of keyNames) {
    const parsed = parseGenerationScopedKey(key);
    if (!parsed) {
      ignoredKeys.push(key);
      continue;
    }
    if (retainedPrefixSet.has(parsed.prefix)) {
      retainedKeys.push(key);
      continue;
    }

    // Model revision is the only monotonic semantic release axis. A different
    // API or a same/newer model could belong to a future or concurrent release;
    // never guess its age from a free-form generation label or cache schema.
    if (parsed.release.apiSchemaVersion !== currentRelease.apiSchemaVersion
      || parsed.release.modelRevision >= oldestRetainedModelRevision) {
      ambiguousPrefixes.add(parsed.prefix);
      continue;
    }
    stalePrefixes.add(parsed.prefix);
    deleteKeys.push(key);
  }

  if (ambiguousPrefixes.size > 0) {
    throw new Error(
      `KV GC found generation prefixes that are not retained and cannot be proven older: ${[
        ...ambiguousPrefixes,
      ].sort().join(', ')}.`,
    );
  }

  return {
    retainedPrefixes,
    stalePrefixes: [...stalePrefixes].sort(),
    deleteKeys: deleteKeys.sort(),
    retainedKeys: retainedKeys.sort(),
    ignoredKeys: ignoredKeys.sort(),
  };
}

async function invokeWrangler(args, execFileImpl = execFileAsync) {
  return execFileImpl(process.execPath, [WRANGLER_BIN, ...args], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });
}

export async function listRemoteForecastKvKeys({ execFileImpl = execFileAsync } = {}) {
  const { stdout } = await invokeWrangler([
    'kv', 'key', 'list',
    '--binding', FORECAST_KV_BINDING,
    '--remote',
    '--prefix', FRANK_GENERATION_KEY_ROOT,
    '--config', WRANGLER_CONFIG,
  ], execFileImpl);
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error('Wrangler KV key listing was not valid JSON.');
  }
}

export async function deleteRemoteForecastKvKeys(
  keys,
  { execFileImpl = execFileAsync } = {},
) {
  if (!Array.isArray(keys) || keys.some((key) => typeof key !== 'string')) {
    throw new Error('KV bulk-delete keys are invalid.');
  }
  if (new Set(keys).size !== keys.length) {
    throw new Error('KV bulk-delete keys contain duplicates.');
  }
  if (keys.some((key) => parseGenerationScopedKey(key) === null)) {
    throw new Error('KV bulk delete accepts only recognized FRANK generation-scoped keys.');
  }
  if (keys.length === 0) return;

  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'frank-kv-gc-'));
  try {
    for (let offset = 0; offset < keys.length; offset += MAX_BULK_DELETE_KEYS) {
      const batch = keys.slice(offset, offset + MAX_BULK_DELETE_KEYS);
      const batchFile = path.join(temporaryDirectory, `delete-${offset}.json`);
      await writeFile(batchFile, `${JSON.stringify(batch)}\n`, { encoding: 'utf8', flag: 'wx' });
      await invokeWrangler([
        'kv', 'bulk', 'delete', batchFile,
        '--binding', FORECAST_KV_BINDING,
        '--remote',
        '--force',
        '--config', WRANGLER_CONFIG,
      ], execFileImpl);
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function sameStringArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export async function gcWorkerKv({
  apply = false,
  attestedActiveRelease,
  contract,
  listKeysImpl = listRemoteForecastKvKeys,
  deleteKeysImpl = deleteRemoteForecastKvKeys,
  verificationAttempts = DEFAULT_VERIFICATION_ATTEMPTS,
  verificationDelayMs = DEFAULT_VERIFICATION_DELAY_MS,
  sleepImpl = sleep,
  logger = console,
} = {}) {
  if (typeof apply !== 'boolean') throw new Error('KV GC apply policy must be boolean.');
  if (!positiveInteger(verificationAttempts) || !positiveInteger(verificationDelayMs)) {
    throw new Error('KV GC verification retry policy is invalid.');
  }
  if (typeof sleepImpl !== 'function') throw new Error('KV GC verification sleeper is invalid.');
  const resolvedContract = contract ?? await loadReleaseContract();
  const policy = {
    currentRelease: resolvedContract.release,
    auditedPreviousReleases: resolvedContract.auditedPreviousReleases,
  };
  if (apply) {
    requireAttestedActiveRelease(
      attestedActiveRelease,
      policy.currentRelease,
      policy.auditedPreviousReleases,
    );
  }
  const firstPlan = planWorkerKvGc({
    listedKeys: await listKeysImpl(),
    ...policy,
  });
  logger.info(
    `[kv-gc] retain ${firstPlan.retainedPrefixes.length} generation(s); `
    + `delete ${firstPlan.deleteKeys.length} key(s) from ${firstPlan.stalePrefixes.length} old generation(s); `
    + `ignore ${firstPlan.ignoredKeys.length} unrecognized key(s)`,
  );

  if (!apply || firstPlan.deleteKeys.length === 0) {
    logger.info(apply ? '[kv-gc] nothing to delete' : '[kv-gc] dry run; no keys deleted');
    return { ...firstPlan, applied: false };
  }

  // Re-list immediately before mutation. The production workflow serializes
  // releases, but this second plan also prevents a local/manual race from
  // deleting against a stale view of the namespace.
  const confirmedPlan = planWorkerKvGc({
    listedKeys: await listKeysImpl(),
    ...policy,
  });
  if (!sameStringArray(firstPlan.deleteKeys, confirmedPlan.deleteKeys)
    || !sameStringArray(firstPlan.retainedPrefixes, confirmedPlan.retainedPrefixes)) {
    throw new Error('KV keys changed while the cleanup plan was being confirmed; nothing was deleted.');
  }

  await deleteKeysImpl(confirmedPlan.deleteKeys);
  let verificationPlan;
  for (let attempt = 1; attempt <= verificationAttempts; attempt += 1) {
    verificationPlan = planWorkerKvGc({
      listedKeys: await listKeysImpl(),
      ...policy,
    });
    if (verificationPlan.deleteKeys.length === 0) break;
    if (attempt < verificationAttempts) {
      await sleepImpl(verificationDelayMs * (2 ** (attempt - 1)));
    }
  }
  if (verificationPlan.deleteKeys.length > 0) {
    throw new Error(
      `KV GC verification still found ${verificationPlan.deleteKeys.length} stale key(s) `
      + `after ${verificationAttempts} attempt(s).`,
    );
  }
  logger.info(`[kv-gc] deleted and verified ${confirmedPlan.deleteKeys.length} key(s)`);
  return { ...confirmedPlan, applied: true };
}

function cliApplyPolicy(argv) {
  if (argv.includes('--help')) {
    return { help: true, apply: false, releaseAttestation: null };
  }
  let releaseAttestation = null;
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply' || argument === '--dry-run') {
      flags.add(argument);
      continue;
    }
    if (argument === '--attested-active-release') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--') || releaseAttestation !== null) {
        throw new Error('Usage: node scripts/gc-worker-kv.mjs [--dry-run|--apply] [--attested-active-release <token>]');
      }
      releaseAttestation = value;
      index += 1;
      continue;
    }
    throw new Error('Usage: node scripts/gc-worker-kv.mjs [--dry-run|--apply] [--attested-active-release <token>]');
  }
  if (flags.has('--apply') && flags.has('--dry-run')) {
    throw new Error('Usage: node scripts/gc-worker-kv.mjs [--dry-run|--apply] [--attested-active-release <token>]');
  }
  return {
    help: false,
    apply: flags.has('--apply'),
    releaseAttestation,
  };
}

async function runCli(argv = process.argv.slice(2)) {
  const policy = cliApplyPolicy(argv);
  if (policy.help) {
    process.stdout.write(
      'Usage: node scripts/gc-worker-kv.mjs [--dry-run|--apply] '
      + '[--attested-active-release <token>]\n',
    );
    return;
  }
  await gcWorkerKv({
    apply: policy.apply,
    attestedActiveRelease: policy.releaseAttestation
      ? decodeReleaseAttestation(policy.releaseAttestation)
      : undefined,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCli().catch((error) => {
    console.error(`[kv-gc] ${error instanceof Error ? error.message : 'Unexpected cleanup failure.'}`);
    process.exitCode = 1;
  });
}
