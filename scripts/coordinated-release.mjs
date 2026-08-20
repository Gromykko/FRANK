import { execFile } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { loadReleaseContract } from './warm-worker.mjs';
import {
  FORECAST_KV_BINDING,
  normalizeReleaseDescriptor,
} from './worker-release-attestation.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, '..');
const WRANGLER_BIN = path.join(REPOSITORY_ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const WRANGLER_CONFIG = path.join(REPOSITORY_ROOT, 'wrangler.jsonc');
const execFileAsync = promisify(execFile);

const defaultSleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs));

export const COORDINATED_RELEASE_KEY = 'frank:release-control:coordinated-production:v1';
const JOURNAL_SCHEMA_VERSION = 1;
const SOURCE_SHA = /^[a-f0-9]{40}$/i;
const VERSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAGES_BUILD_ID = /^[A-Za-z0-9._:+-]{1,256}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function normalizedSha(value, label = 'Source SHA') {
  if (typeof value !== 'string' || !SOURCE_SHA.test(value)) {
    throw new Error(`${label} must be a full 40-character Git SHA.`);
  }
  return value.toLowerCase();
}

function normalizedVersionId(value) {
  if (typeof value !== 'string' || !VERSION_ID.test(value)) {
    throw new Error('Worker version ID is invalid.');
  }
  return value.toLowerCase();
}

function normalizedPagesBuildId(value) {
  if (typeof value !== 'string' || !PAGES_BUILD_ID.test(value)) {
    throw new Error('Pages build ID is invalid.');
  }
  return value;
}

function normalizedPagesContentId(value) {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new Error('Pages content ID must be a SHA-256 fingerprint.');
  }
  return value;
}

function normalizedRecordedAt(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error('Coordinated release timestamp is invalid.');
  }
  return value;
}

export function normalizeCoordinatedRelease(value) {
  if (!value || typeof value !== 'object' || value.schemaVersion !== JOURNAL_SCHEMA_VERSION) {
    throw new Error('Coordinated production release journal is malformed.');
  }
  const release = normalizeReleaseDescriptor(value.release);
  if (!release) throw new Error('Coordinated production release descriptor is malformed.');
  return Object.freeze({
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    sourceSha: normalizedSha(value.sourceSha),
    workerVersionId: normalizedVersionId(value.workerVersionId),
    pagesContentId: normalizedPagesContentId(value.pagesContentId),
    pagesArtifactBuildId: normalizedPagesBuildId(value.pagesArtifactBuildId),
    release,
    recordedAt: normalizedRecordedAt(value.recordedAt),
  });
}

function sameRelease(left, right) {
  return JSON.stringify(normalizeReleaseDescriptor(left))
    === JSON.stringify(normalizeReleaseDescriptor(right));
}

function sameJournalIdentity(left, right) {
  return left.sourceSha === right.sourceSha
    && left.workerVersionId === right.workerVersionId
    && left.pagesContentId === right.pagesContentId
    && left.pagesArtifactBuildId === right.pagesArtifactBuildId
    && sameRelease(left.release, right.release);
}

async function invokeWrangler(args, execFileImpl = execFileAsync) {
  return execFileImpl(process.execPath, [WRANGLER_BIN, ...args], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });
}

function parseKeyList(stdout) {
  let entries;
  try {
    entries = JSON.parse(stdout);
  } catch {
    throw new Error('Coordinated release journal key listing was not valid JSON.');
  }
  if (!Array.isArray(entries)
    || entries.some((entry) => !entry || typeof entry.name !== 'string')) {
    throw new Error('Coordinated release journal key listing was malformed.');
  }
  if (entries.length === 0) return false;
  if (entries.length !== 1 || entries[0].name !== COORDINATED_RELEASE_KEY) {
    throw new Error('Coordinated release journal namespace is ambiguous.');
  }
  return true;
}

export async function readRemoteCoordinatedRelease({ execFileImpl = execFileAsync } = {}) {
  const { stdout: listSource } = await invokeWrangler([
    'kv', 'key', 'list',
    '--binding', FORECAST_KV_BINDING,
    '--remote',
    '--prefix', COORDINATED_RELEASE_KEY,
    '--config', WRANGLER_CONFIG,
  ], execFileImpl);
  if (!parseKeyList(listSource)) return null;

  const { stdout: valueSource } = await invokeWrangler([
    'kv', 'key', 'get',
    COORDINATED_RELEASE_KEY,
    '--binding', FORECAST_KV_BINDING,
    '--remote',
    '--config', WRANGLER_CONFIG,
  ], execFileImpl);
  let value;
  try {
    value = JSON.parse(valueSource);
  } catch {
    throw new Error('Coordinated production release journal was not valid JSON.');
  }
  return normalizeCoordinatedRelease(value);
}

export async function recordRemoteCoordinatedRelease({
  sourceSha,
  workerVersionId,
  pagesContentId,
  pagesArtifactBuildId,
  release,
  expectedPreviousSourceSha,
  now = () => new Date(),
  execFileImpl = execFileAsync,
  sleepImpl = defaultSleep,
  verificationAttempts = 5,
  verificationDelayMs = 500,
} = {}) {
  const previousExpectation = expectedPreviousSourceSha === 'none'
    ? 'none'
    : normalizedSha(expectedPreviousSourceSha, 'Expected previous source SHA');
  const desired = normalizeCoordinatedRelease({
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    sourceSha,
    workerVersionId,
    pagesContentId,
    pagesArtifactBuildId,
    release,
    recordedAt: now().toISOString(),
  });
  const existing = await readRemoteCoordinatedRelease({ execFileImpl });
  if (existing && sameJournalIdentity(existing, desired)) return existing;
  if (previousExpectation === 'none' && existing) {
    throw new Error('A coordinated production release already exists; refusing first-write overwrite.');
  }
  if (previousExpectation !== 'none'
    && (!existing || existing.sourceSha !== previousExpectation)) {
    throw new Error('Coordinated production release changed; refusing a stale journal write.');
  }

  await invokeWrangler([
    'kv', 'key', 'put',
    COORDINATED_RELEASE_KEY,
    JSON.stringify(desired),
    '--binding', FORECAST_KV_BINDING,
    '--remote',
    '--config', WRANGLER_CONFIG,
  ], execFileImpl);

  // Workers KV is deliberately not treated as a transactional lock. GitHub's
  // production concurrency group is the single-writer boundary; this read-back
  // only proves that the identity we just wrote became observable before the
  // release is reported as coordinated. A stale or conflicting observation
  // fails closed and the idempotent release can be resumed later.
  const attempts = Number.isInteger(verificationAttempts) && verificationAttempts > 0
    ? verificationAttempts
    : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const observed = await readRemoteCoordinatedRelease({ execFileImpl });
    if (observed && sameJournalIdentity(observed, desired)) return observed;
    if (attempt < attempts - 1) {
      await sleepImpl(verificationDelayMs * (2 ** attempt));
    }
  }
  throw new Error('Coordinated production release journal did not verify after write.');
}

export function coordinatedReleaseGithubOutput(value) {
  if (value === null) {
    return [
      'established=false',
      'source_sha=',
      'worker_version_id=',
      'pages_content_id=',
      'pages_artifact_build_id=',
      '',
    ].join('\n');
  }
  const journal = normalizeCoordinatedRelease(value);
  return [
    'established=true',
    `source_sha=${journal.sourceSha}`,
    `worker_version_id=${journal.workerVersionId}`,
    `pages_content_id=${journal.pagesContentId}`,
    `pages_artifact_build_id=${journal.pagesArtifactBuildId}`,
    '',
  ].join('\n');
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (command === '--help' || command === undefined) return { help: true };
  if (command !== 'read' && command !== 'record') {
    throw new Error('Usage: coordinated-release.mjs <read|record> [options]');
  }
  const allowed = command === 'read'
    ? new Set(['--github-output'])
    : new Set([
        '--source-sha',
        '--worker-version-id',
        '--pages-content-id',
        '--pages-artifact-build-id',
        '--expected-previous-source-sha',
        '--github-output',
      ]);
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const option = rest[index];
    const value = rest[index + 1];
    if (!allowed.has(option)) throw new Error(`Unknown coordinated-release option: ${option ?? ''}.`);
    if (!value || value.startsWith('--') || Object.hasOwn(values, option)) {
      throw new Error(`Option ${option} requires exactly one value.`);
    }
    values[option] = value;
  }
  if (command === 'read' && !values['--github-output']) {
    throw new Error('read requires --github-output.');
  }
  if (command === 'record') {
    for (const option of [
      '--source-sha',
      '--worker-version-id',
      '--pages-content-id',
      '--pages-artifact-build-id',
      '--expected-previous-source-sha',
    ]) {
      if (!values[option]) throw new Error(`record requires ${option}.`);
    }
  }
  return { help: false, command, values };
}

export async function runCli(argv = process.argv.slice(2), dependencies = {}) {
  const parsed = parseArguments(argv);
  const stdout = dependencies.stdout ?? process.stdout;
  if (parsed.help) {
    stdout.write(
      'Usage: coordinated-release.mjs read --github-output <path>\n'
      + '       coordinated-release.mjs record --source-sha <sha> '
      + '--worker-version-id <uuid> --pages-content-id <sha256> '
      + '--pages-artifact-build-id <id> '
      + '--expected-previous-source-sha <sha|none> [--github-output <path>]\n',
    );
    return null;
  }

  let result;
  if (parsed.command === 'read') {
    result = await readRemoteCoordinatedRelease(dependencies);
  } else {
    const contract = dependencies.contract ?? await loadReleaseContract();
    result = await recordRemoteCoordinatedRelease({
      sourceSha: parsed.values['--source-sha'],
      workerVersionId: parsed.values['--worker-version-id'],
      pagesContentId: parsed.values['--pages-content-id'],
      pagesArtifactBuildId: parsed.values['--pages-artifact-build-id'],
      expectedPreviousSourceSha: parsed.values['--expected-previous-source-sha'],
      release: contract.release,
      ...dependencies,
    });
  }
  const output = coordinatedReleaseGithubOutput(result);
  const outputPath = parsed.values['--github-output'];
  if (outputPath) {
    const appendFileImpl = dependencies.appendFileImpl ?? appendFile;
    await appendFileImpl(outputPath, output, 'utf8');
  }
  stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCli().catch((error) => {
    console.error(`[coordinated-release] ${error instanceof Error ? error.message : 'Unexpected failure.'}`);
    process.exitCode = 1;
  });
}
