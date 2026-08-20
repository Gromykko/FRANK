import { execFile } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { loadReleaseContract } from './warm-worker.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, '..');
const WRANGLER_BIN = path.join(REPOSITORY_ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const WRANGLER_CONFIG = path.join(REPOSITORY_ROOT, 'wrangler.jsonc');
const execFileAsync = promisify(execFile);

export const FORECAST_KV_BINDING = 'FRANK_FORECAST_CACHE';
export const COORDINATED_BASELINE_MARKER_KEY =
  'frank:release-control:coordinated-worker-baseline:v1';
const MARKER_SCHEMA_VERSION = 1;
const MAX_PROBE_BODY_CHARS = 64 * 1024;
const DEFAULT_PROBE_TIMEOUT_MS = 15_000;
const WORKER_VERSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORKER_NAME = /^[a-z0-9-]+$/;
const GENERATION_ID = /^[A-Za-z0-9._:-]+$/;
const VERSION_OVERRIDE_HEADER = 'Cloudflare-Workers-Version-Overrides';
const WORKER_VERSION_HEADER = 'x-frank-worker-version';
const RELEASE_HEADERS = Object.freeze({
  apiSchemaVersion: 'x-frank-api-schema',
  modelRevision: 'x-frank-model-revision',
  dataGenerationId: 'x-frank-data-generation',
  assembledCacheSchema: 'x-frank-assembled-cache-schema',
  marineCacheSchema: 'x-frank-marine-cache-schema',
  payloadVersion: 'x-frank-payload-version',
});

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

export function normalizeReleaseDescriptor(value) {
  if (!value || typeof value !== 'object') return null;
  const release = {
    apiSchemaVersion: value.apiSchemaVersion,
    modelRevision: value.modelRevision,
    dataGenerationId: value.dataGenerationId,
    assembledCacheSchema: value.assembledCacheSchema,
    marineCacheSchema: value.marineCacheSchema,
    payloadVersion: value.payloadVersion,
  };
  return positiveInteger(release.apiSchemaVersion)
    && positiveInteger(release.modelRevision)
    && typeof release.dataGenerationId === 'string'
    && GENERATION_ID.test(release.dataGenerationId)
    && positiveInteger(release.assembledCacheSchema)
    && positiveInteger(release.marineCacheSchema)
    && positiveInteger(release.payloadVersion)
    ? release
    : null;
}

function releaseSignature(release) {
  const normalized = normalizeReleaseDescriptor(release);
  if (!normalized) throw new Error('Worker release descriptor is invalid.');
  return JSON.stringify(normalized);
}

function sameRelease(left, right) {
  return releaseSignature(left) === releaseSignature(right);
}

export function encodeReleaseAttestation(release) {
  return Buffer.from(releaseSignature(release), 'utf8').toString('base64url');
}

export function decodeReleaseAttestation(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('Captured Worker release attestation is malformed.');
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Captured Worker release attestation is malformed.');
  }
  const release = normalizeReleaseDescriptor(parsed);
  if (!release || encodeReleaseAttestation(release) !== value) {
    throw new Error('Captured Worker release attestation is non-canonical.');
  }
  return release;
}

function allowedPreviousRelease(currentRelease, auditedPreviousReleases) {
  if (!normalizeReleaseDescriptor(currentRelease)
    || !Array.isArray(auditedPreviousReleases)
    || !auditedPreviousReleases.every(normalizeReleaseDescriptor)) {
    throw new Error('Forecast release compatibility policy is malformed.');
  }
  if (auditedPreviousReleases.some(
    (release) => release.apiSchemaVersion !== currentRelease.apiSchemaVersion,
  )) {
    throw new Error('Captured Worker attestation does not support cross-API rollback policy.');
  }
  if (auditedPreviousReleases.length > 1) {
    throw new Error('Captured Worker attestation accepts at most one audited N-1 release.');
  }
  return auditedPreviousReleases[0] ?? null;
}

export function classifyCapturedWorkerRelease({
  capturedRelease,
  currentRelease,
  auditedPreviousReleases = [],
  baselineEstablished,
}) {
  if (typeof baselineEstablished !== 'boolean') {
    throw new Error('Coordinated Worker baseline state is invalid.');
  }
  const previousRelease = allowedPreviousRelease(currentRelease, auditedPreviousReleases);
  if (capturedRelease === null) {
    if (baselineEstablished) {
      throw new Error(
        'Captured production Worker has no release descriptor after the coordinated baseline was established.',
      );
    }
    return {
      mode: 'bootstrap-unproven',
      kvGcAllowed: false,
      releaseAttestation: '',
      baselineMarkerRequired: true,
    };
  }
  const normalizedCaptured = normalizeReleaseDescriptor(capturedRelease);
  if (!normalizedCaptured) throw new Error('Captured production Worker release is malformed.');
  if (sameRelease(normalizedCaptured, currentRelease)) {
    return {
      mode: 'verified-current',
      kvGcAllowed: true,
      releaseAttestation: encodeReleaseAttestation(normalizedCaptured),
      baselineMarkerRequired: !baselineEstablished,
    };
  }
  if (previousRelease && sameRelease(normalizedCaptured, previousRelease)) {
    return {
      mode: 'verified-n-1',
      kvGcAllowed: true,
      releaseAttestation: encodeReleaseAttestation(normalizedCaptured),
      baselineMarkerRequired: !baselineEstablished,
    };
  }
  throw new Error(
    `Captured production Worker release ${normalizedCaptured.dataGenerationId} is neither CURRENT_RELEASE nor the audited N-1.`,
  );
}

function integerHeader(headers, name) {
  const value = headers.get(name);
  if (value === null || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function headerReleaseEvidence(headers) {
  const raw = Object.values(RELEASE_HEADERS).map((name) => headers.get(name));
  if (raw.every((value) => value === null)) return { present: false, release: null };
  const release = normalizeReleaseDescriptor({
    apiSchemaVersion: integerHeader(headers, RELEASE_HEADERS.apiSchemaVersion),
    modelRevision: integerHeader(headers, RELEASE_HEADERS.modelRevision),
    dataGenerationId: headers.get(RELEASE_HEADERS.dataGenerationId),
    assembledCacheSchema: integerHeader(headers, RELEASE_HEADERS.assembledCacheSchema),
    marineCacheSchema: integerHeader(headers, RELEASE_HEADERS.marineCacheSchema),
    payloadVersion: integerHeader(headers, RELEASE_HEADERS.payloadVersion),
  });
  if (!release) throw new Error('Captured Worker returned incomplete release headers.');
  return { present: true, release };
}

export async function probeCapturedWorkerRelease({
  baseUrl,
  workerName,
  expectedWorkerVersionId,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
}) {
  let url;
  try {
    url = new URL('/', baseUrl);
  } catch {
    throw new Error('Captured Worker probe URL is invalid.');
  }
  if (url.protocol !== 'https:' && url.hostname !== 'localhost') {
    throw new Error('Captured Worker probe requires HTTPS.');
  }
  if (typeof workerName !== 'string' || !WORKER_NAME.test(workerName)) {
    throw new Error('Captured Worker name is invalid.');
  }
  if (typeof expectedWorkerVersionId !== 'string'
    || !WORKER_VERSION_ID.test(expectedWorkerVersionId)) {
    throw new Error('Captured Worker version ID is invalid.');
  }
  if (!positiveInteger(timeoutMs)) throw new Error('Captured Worker probe timeout is invalid.');
  const expectedVersion = expectedWorkerVersionId.toLowerCase();
  const response = await fetchImpl(url, {
    cache: 'no-store',
    headers: {
      [VERSION_OVERRIDE_HEADER]: `${workerName}="${expectedVersion}"`,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Captured Worker probe returned HTTP ${response.status}.`);
  }
  const text = await response.text();
  if (text.length > MAX_PROBE_BODY_CHARS) {
    throw new Error('Captured Worker probe response was too large.');
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error('Captured Worker probe did not return JSON.');
  }
  if (!body || typeof body !== 'object' || body.service !== 'frank-forecast') {
    throw new Error('Captured Worker probe did not identify the FRANK forecast service.');
  }

  const headers = headerReleaseEvidence(response.headers);
  const bodyHasRelease = Object.prototype.hasOwnProperty.call(body, 'release');
  if (!headers.present && !bodyHasRelease) {
    const reportedVersion = response.headers.get(WORKER_VERSION_HEADER);
    if (reportedVersion !== null && reportedVersion.toLowerCase() !== expectedVersion) {
      throw new Error('Legacy Worker probe answered from a different version than captured.');
    }
    return null;
  }
  if (!headers.present || !bodyHasRelease) {
    throw new Error('Captured Worker returned partial release evidence.');
  }
  const bodyRelease = normalizeReleaseDescriptor(body.release);
  if (!bodyRelease || !sameRelease(headers.release, bodyRelease)) {
    throw new Error('Captured Worker body and release headers disagree.');
  }
  const reportedVersion = response.headers.get(WORKER_VERSION_HEADER)?.toLowerCase();
  if (reportedVersion !== expectedVersion) {
    throw new Error('Captured Worker did not attest the requested immutable version.');
  }
  return bodyRelease;
}

async function invokeWrangler(args, execFileImpl = execFileAsync) {
  return execFileImpl(process.execPath, [WRANGLER_BIN, ...args], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });
}

export async function remoteBaselineMarkerExists({ execFileImpl = execFileAsync } = {}) {
  const { stdout } = await invokeWrangler([
    'kv', 'key', 'list',
    '--binding', FORECAST_KV_BINDING,
    '--remote',
    '--prefix', COORDINATED_BASELINE_MARKER_KEY,
    '--config', WRANGLER_CONFIG,
  ], execFileImpl);
  let entries;
  try {
    entries = JSON.parse(stdout);
  } catch {
    throw new Error('Coordinated Worker baseline marker listing was not valid JSON.');
  }
  if (!Array.isArray(entries)
    || entries.some((entry) => !entry || typeof entry.name !== 'string')) {
    throw new Error('Coordinated Worker baseline marker listing was malformed.');
  }
  if (entries.length === 0) return false;
  if (entries.length !== 1 || entries[0].name !== COORDINATED_BASELINE_MARKER_KEY) {
    throw new Error('Coordinated Worker baseline marker namespace is ambiguous.');
  }
  return true;
}

export async function writeRemoteBaselineMarker(
  release,
  { execFileImpl = execFileAsync } = {},
) {
  const normalizedRelease = normalizeReleaseDescriptor(release);
  if (!normalizedRelease) throw new Error('Cannot mark an invalid coordinated Worker baseline.');
  const value = JSON.stringify({
    schemaVersion: MARKER_SCHEMA_VERSION,
    established: true,
    release: normalizedRelease,
  });
  await invokeWrangler([
    'kv', 'key', 'put',
    COORDINATED_BASELINE_MARKER_KEY,
    value,
    '--binding', FORECAST_KV_BINDING,
    '--remote',
    '--config', WRANGLER_CONFIG,
  ], execFileImpl);
}

export async function attestCapturedWorkerRelease({
  contract,
  baseUrl,
  workerName,
  expectedWorkerVersionId,
  fetchImpl = fetch,
  markerExistsImpl = remoteBaselineMarkerExists,
}) {
  const resolvedContract = contract ?? await loadReleaseContract();
  const baselineEstablished = await markerExistsImpl();
  const capturedRelease = await probeCapturedWorkerRelease({
    baseUrl,
    workerName,
    expectedWorkerVersionId,
    fetchImpl,
  });
  return classifyCapturedWorkerRelease({
    capturedRelease,
    currentRelease: resolvedContract.release,
    auditedPreviousReleases: resolvedContract.auditedPreviousReleases,
    baselineEstablished,
  });
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (command === '--help' || command === undefined
    || (rest.length === 1 && rest[0] === '--help')) return { help: true };
  if (command !== 'attest' && command !== 'mark-baseline') {
    throw new Error('Usage: worker-release-attestation.mjs <attest|mark-baseline> [options]');
  }
  const known = new Set([
    '--base-url',
    '--worker-name',
    '--expected-worker-version-id',
    '--github-output',
  ]);
  const values = {};
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (!known.has(argument)) throw new Error(`Unknown option: ${argument}`);
    const value = rest[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}.`);
    values[argument] = value;
    index += 1;
  }
  return { command, values };
}

async function runCli(argv = process.argv.slice(2)) {
  const parsed = parseArguments(argv);
  if (parsed.help) {
    process.stdout.write(
      'Usage: worker-release-attestation.mjs attest --base-url <url> --worker-name <name> '
      + '--expected-worker-version-id <uuid> --github-output <path>\n'
      + '       worker-release-attestation.mjs mark-baseline\n',
    );
    return;
  }
  const contract = await loadReleaseContract();
  if (parsed.command === 'mark-baseline') {
    if (Object.keys(parsed.values).length > 0) {
      throw new Error('mark-baseline does not accept options.');
    }
    await writeRemoteBaselineMarker(contract.release);
    process.stdout.write(
      `coordinated Worker baseline recorded for ${contract.release.dataGenerationId}\n`,
    );
    return;
  }
  const githubOutput = parsed.values['--github-output'];
  if (!githubOutput) throw new Error('attest requires --github-output.');
  const result = await attestCapturedWorkerRelease({
    contract,
    baseUrl: parsed.values['--base-url'],
    workerName: parsed.values['--worker-name'],
    expectedWorkerVersionId: parsed.values['--expected-worker-version-id'],
  });
  await appendFile(githubOutput, [
    `mode=${result.mode}`,
    `kv_gc_allowed=${result.kvGcAllowed}`,
    `release_attestation=${result.releaseAttestation}`,
    `baseline_marker_required=${result.baselineMarkerRequired}`,
    '',
  ].join('\n'), 'utf8');
  process.stdout.write(`captured Worker release attested: ${result.mode}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCli().catch((error) => {
    console.error(`[release-attestation] ${error instanceof Error ? error.message : 'Unexpected failure.'}`);
    process.exitCode = 1;
  });
}
