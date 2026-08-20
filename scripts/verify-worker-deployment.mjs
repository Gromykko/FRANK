import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const VERSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TRAFFIC_SPEC = /^([0-9a-f-]+)@(100|[0-9]{1,2})(?:%)?$/i;
const WRANGLER_CLI = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
const execFileAsync = promisify(execFile);
const DEFAULT_ATTEMPTS = 5;
const DEFAULT_RETRY_DELAY_MS = 2_000;

export function parseExpectedTraffic(specs) {
  if (!Array.isArray(specs) || specs.length === 0 || specs.length > 2) {
    throw new Error('Expected one or two Worker version traffic specifications.');
  }

  const expected = new Map();
  for (const spec of specs) {
    const match = typeof spec === 'string' ? TRAFFIC_SPEC.exec(spec) : null;
    if (!match || !VERSION_ID.test(match[1])) {
      throw new Error(`Invalid Worker traffic specification: ${String(spec)}.`);
    }
    const versionId = match[1].toLowerCase();
    if (expected.has(versionId)) {
      throw new Error(`Duplicate Worker version in traffic specification: ${versionId}.`);
    }
    expected.set(versionId, Number(match[2]));
  }

  const total = [...expected.values()].reduce((sum, percentage) => sum + percentage, 0);
  if (total !== 100) {
    throw new Error(`Worker traffic percentages must total 100; received ${total}.`);
  }
  return expected;
}

export function requireExactWorkerDeployment(value, expectedTraffic) {
  const expected = expectedTraffic instanceof Map
    ? expectedTraffic
    : parseExpectedTraffic(expectedTraffic);
  const versions = value && typeof value === 'object' && Array.isArray(value.versions)
    ? value.versions
    : null;
  if (!versions || versions.length !== expected.size) {
    throw new Error('Current Worker deployment does not contain the exact expected versions.');
  }

  const actual = new Map();
  for (const version of versions) {
    const versionId = version?.version_id;
    const percentage = Number(version?.percentage);
    if (typeof versionId !== 'string'
      || !VERSION_ID.test(versionId)
      || !Number.isFinite(percentage)
      || percentage < 0
      || percentage > 100
      || actual.has(versionId.toLowerCase())) {
      throw new Error('Current Worker deployment contains invalid version traffic metadata.');
    }
    actual.set(versionId.toLowerCase(), percentage);
  }

  for (const [versionId, percentage] of expected) {
    if (actual.get(versionId) !== percentage) {
      throw new Error(`Current Worker deployment does not route ${percentage}% to ${versionId}.`);
    }
  }
  return true;
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function verifyCurrentWorkerDeployment({
  specs,
  attempts = DEFAULT_ATTEMPTS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  execFileImpl = execFileAsync,
} = {}) {
  const expected = parseExpectedTraffic(specs);
  if (!Number.isSafeInteger(attempts) || attempts <= 0) {
    throw new Error('Deployment verification attempts must be a positive integer.');
  }
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs <= 0) {
    throw new Error('Deployment verification retry delay must be a positive integer.');
  }

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const { stdout } = await execFileImpl(
        process.execPath,
        [WRANGLER_CLI, 'deployments', 'status', '--json'],
        { encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 },
      );
      requireExactWorkerDeployment(JSON.parse(stdout), expected);
      return true;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await delay(retryDelayMs * attempt);
    }
  }

  const message = lastError instanceof Error ? lastError.message : 'deployment could not be verified';
  throw new Error(`Worker deployment did not reach the expected state after ${attempts} attempts: ${message}`);
}

export async function runCli(argv = process.argv.slice(2)) {
  await verifyCurrentWorkerDeployment({ specs: argv });
  process.stdout.write('verified');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    const message = error instanceof Error ? error.message : 'Worker deployment could not be verified.';
    console.error(`[release] ${message}`);
    process.exitCode = 1;
  });
}
