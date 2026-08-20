import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const VERSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WRANGLER_CLI = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
const execFileAsync = promisify(execFile);
const DEFAULT_ATTEMPTS = 5;
const DEFAULT_RETRY_DELAY_MS = 2_000;

function requireVersionTag(value) {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > 128
    || [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
    })) {
    throw new Error('A non-empty Worker version tag without control characters is required.');
  }
  return value;
}

export function requireWorkerVersionByTag(value, expectedTag) {
  const tag = requireVersionTag(expectedTag);
  if (!Array.isArray(value)) {
    throw new Error('Expected Wrangler versions list output to be an array.');
  }

  const matches = value.filter((version) => version?.annotations?.['workers/tag'] === tag);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one recent Worker version tagged ${tag}.`);
  }

  const versionId = matches[0]?.id;
  if (typeof versionId !== 'string' || !VERSION_ID.test(versionId)) {
    throw new Error(`Worker version tagged ${tag} has an invalid version ID.`);
  }
  return versionId.toLowerCase();
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function resolveRecentWorkerVersion({
  tag,
  attempts = DEFAULT_ATTEMPTS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  execFileImpl = execFileAsync,
} = {}) {
  const expectedTag = requireVersionTag(tag);
  if (!Number.isSafeInteger(attempts) || attempts <= 0) {
    throw new Error('Version-list attempts must be a positive integer.');
  }
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs <= 0) {
    throw new Error('Version-list retry delay must be a positive integer.');
  }

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const { stdout } = await execFileImpl(
        process.execPath,
        [WRANGLER_CLI, 'versions', 'list', '--json'],
        { encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 },
      );
      return requireWorkerVersionByTag(JSON.parse(stdout), expectedTag);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await delay(retryDelayMs * attempt);
    }
  }

  const message = lastError instanceof Error ? lastError.message : 'uploaded version could not be resolved';
  throw new Error(`Uploaded Worker version did not appear after ${attempts} attempts: ${message}`);
}

export async function runCli(argv = process.argv.slice(2)) {
  if (argv.length !== 1) {
    throw new Error('Usage: node scripts/worker-version-by-tag.mjs <version-tag>');
  }
  const versionId = await resolveRecentWorkerVersion({ tag: argv[0] });
  process.stdout.write(versionId);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    const message = error instanceof Error ? error.message : 'Uploaded Worker version could not be resolved.';
    console.error(`[release] ${message}`);
    process.exitCode = 1;
  });
}
