import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  requireReleaseDescriptor,
  requireReleaseManifest,
} from './release-artifact.mjs';

const DEFAULT_ATTEMPTS = 12;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_DELAY_MS = 10_000;
const STATIC_SHELL = [
  'sw.js',
  'manifest.json',
  'favicon.svg',
  'icon-192.png',
  'icon-512.png',
  'apple-touch-icon.png',
];

class PagesReleaseError extends Error {}

function positiveInteger(value, label) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new PagesReleaseError(`${label} must be a positive integer.`);
  }
  return parsed;
}

function expectedBuildId(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256
    || !/^[A-Za-z0-9._:+-]+$/.test(value)) {
    throw new PagesReleaseError('A valid expected Pages build ID is required.');
  }
  return value;
}

function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new PagesReleaseError('A valid Pages base URL is required.');
  }
  const isLoopback = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback))
    || url.username || url.password || url.search || url.hash) {
    throw new PagesReleaseError('Pages base URL must use HTTPS without credentials, query, or fragment.');
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchRequired(url, expectedContentType, timeoutMs, fetchImpl) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  timeoutId.unref?.();
  try {
    const response = await fetchImpl(url, {
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok || response.status === 206) {
      throw new PagesReleaseError(`required resource returned HTTP ${response.status}: ${url.pathname}`);
    }
    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    if (expectedContentType && !contentType.includes(expectedContentType)) {
      throw new PagesReleaseError(`required resource has the wrong content type: ${url.pathname}`);
    }
    return response;
  } catch (error) {
    if (error instanceof PagesReleaseError) throw error;
    throw new PagesReleaseError(
      `${error?.name === 'AbortError' ? 'timeout fetching' : 'could not fetch'} ${url.pathname}`,
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

function htmlAssetUrls(html, base) {
  return [...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)]
    .map((match) => new URL(match[1], base))
    .filter((url) => url.origin === base.origin && url.pathname.startsWith(`${base.pathname}assets/`))
    .map((url) => url.toString());
}

async function verifyAttempt({ base, buildId, timeoutMs, fetchImpl, nonce }) {
  const indexUrl = new URL(`?frank-release=${encodeURIComponent(`${buildId}-${nonce}`)}`, base);
  const manifestUrl = new URL('frank-precache.json', base);
  manifestUrl.searchParams.set('frank-release', `${buildId}-${nonce}`);
  const descriptorUrl = new URL('frank-release.json', base);
  descriptorUrl.searchParams.set('frank-release', `${buildId}-${nonce}`);

  const [indexResponse, manifestResponse, descriptorResponse] = await Promise.all([
    fetchRequired(indexUrl, 'text/html', timeoutMs, fetchImpl),
    fetchRequired(manifestUrl, 'application/json', timeoutMs, fetchImpl),
    fetchRequired(descriptorUrl, 'application/json', timeoutMs, fetchImpl),
  ]);
  const [html, manifestValue, descriptorValue] = await Promise.all([
    indexResponse.text(),
    manifestResponse.json(),
    descriptorResponse.json(),
  ]);
  const manifest = requireReleaseManifest(manifestValue);
  if (manifest.buildId !== buildId) {
    throw new PagesReleaseError(`Pages still serves build ${manifest.buildId}; expected ${buildId}`);
  }
  requireReleaseDescriptor(descriptorValue, {
    expectedBuildId: buildId,
    expectedBasePath: base.pathname,
  });

  const htmlBuildId = html.match(
    /<meta\s+name=["']frank-build-id["']\s+content=["']([^"']+)["']/i,
  )?.[1];
  if (htmlBuildId !== buildId) {
    throw new PagesReleaseError(`deployed HTML does not identify exact build ${buildId}`);
  }

  const assetUrls = manifest.assets.map((asset) => new URL(asset, base));
  const assetSet = new Set(assetUrls.map((url) => url.toString()));
  const referencedAssets = htmlAssetUrls(html, base);
  if (referencedAssets.length === 0 || referencedAssets.some((url) => !assetSet.has(url))) {
    throw new PagesReleaseError('deployed HTML references assets outside the exact release manifest');
  }

  await Promise.all([
    ...assetUrls.map((url) => fetchRequired(url, null, timeoutMs, fetchImpl)),
    ...STATIC_SHELL.map((fileName) => fetchRequired(
      new URL(fileName, base),
      fileName === 'sw.js' ? 'javascript' : null,
      timeoutMs,
      fetchImpl,
    )),
  ]);
  return { buildId, assetCount: assetUrls.length };
}

export async function verifyPagesRelease({
  baseUrl,
  expectedBuildId: requestedBuildId,
  attempts = DEFAULT_ATTEMPTS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  fetchImpl = fetch,
  logger = console,
} = {}) {
  const base = normalizeBaseUrl(baseUrl);
  const buildId = expectedBuildId(requestedBuildId);
  const boundedAttempts = positiveInteger(attempts, 'Pages verification attempts');
  const boundedTimeoutMs = positiveInteger(timeoutMs, 'Pages verification timeout');
  const boundedRetryDelayMs = positiveInteger(retryDelayMs, 'Pages verification retry delay');

  let lastError;
  for (let attempt = 1; attempt <= boundedAttempts; attempt += 1) {
    try {
      logger.info(`[pages] verify ${buildId}: attempt ${attempt}/${boundedAttempts}`);
      const result = await verifyAttempt({
        base,
        buildId,
        timeoutMs: boundedTimeoutMs,
        fetchImpl,
        nonce: `${Date.now()}-${attempt}`,
      });
      logger.info(`[pages] exact release ready (${result.assetCount} assets)`);
      return result;
    } catch (error) {
      lastError = error;
      if (attempt < boundedAttempts) {
        logger.warn(`[pages] ${error instanceof Error ? error.message : 'verification failed'}; retrying`);
        await delay(boundedRetryDelayMs);
      }
    }
  }

  const message = lastError instanceof Error ? lastError.message : 'verification failed';
  throw new PagesReleaseError(
    `Pages did not serve the exact release after ${boundedAttempts} attempts: ${message}.`,
  );
}

function parseArguments(argv) {
  const known = new Set([
    '--base-url',
    '--expected-build-id',
    '--attempts',
    '--timeout-ms',
    '--retry-delay-ms',
  ]);
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--help') return { help: true };
    if (!known.has(option)) throw new PagesReleaseError(`Unknown option: ${option}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new PagesReleaseError(`Missing value for ${option}.`);
    values[option] = value;
    index += 1;
  }
  return values;
}

function printHelp() {
  console.log(`Usage: node scripts/verify-pages-release.mjs --base-url <url> --expected-build-id <id> [options]

Options:
  --attempts <n>       Propagation attempts (default: ${DEFAULT_ATTEMPTS})
  --timeout-ms <n>     Per-resource timeout (default: ${DEFAULT_TIMEOUT_MS})
  --retry-delay-ms <n> Delay between attempts (default: ${DEFAULT_RETRY_DELAY_MS})`);
}

async function runCli(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) return printHelp();
  await verifyPagesRelease({
    baseUrl: options['--base-url'],
    expectedBuildId: options['--expected-build-id'],
    attempts: options['--attempts'],
    timeoutMs: options['--timeout-ms'],
    retryDelayMs: options['--retry-delay-ms'],
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCli().catch((error) => {
    const message = error instanceof Error ? error.message : 'Pages release verification failed.';
    console.error(`[pages] failed: ${message}`);
    process.exitCode = 1;
  });
}
