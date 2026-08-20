import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BUILD_ID = /^[A-Za-z0-9._:+-]+$/;
const STATIC_SHELL_FILES = [
  'manifest.json',
  'favicon.svg',
  'icon-192.png',
  'icon-512.png',
  'apple-touch-icon.png',
];

function validBuildId(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && BUILD_ID.test(value);
}

export function requireReleaseManifest(value) {
  if (!value || typeof value !== 'object'
    || value.schemaVersion !== 1
    || !validBuildId(value.buildId)
    || !Array.isArray(value.assets)
    || value.assets.length === 0
    || value.assets.some((asset) => typeof asset !== 'string'
      || !/^assets\/[A-Za-z0-9._-]+$/.test(asset))
    || new Set(value.assets).size !== value.assets.length) {
    throw new Error('The Pages artifact does not contain a valid FRANK release manifest.');
  }
  return { buildId: value.buildId, assets: [...value.assets] };
}

function requireReleaseUrl(value, basePath, fileName, buildId, queryName = 'frank-build') {
  let url;
  try {
    url = new URL(value, 'https://frank-release.invalid');
  } catch {
    throw new Error('The Pages artifact contains an invalid FRANK release descriptor.');
  }
  if (typeof value !== 'string'
    || !value.startsWith('/')
    || value.startsWith('//')
    || url.origin !== 'https://frank-release.invalid'
    || url.username
    || url.password
    || url.pathname !== `${basePath}${fileName}`
    || url.searchParams.size !== 1
    || url.searchParams.get(queryName) !== buildId
    || url.hash) {
    throw new Error('The Pages artifact contains an invalid FRANK release descriptor.');
  }
}

export function requireReleaseDescriptor(value, {
  expectedBuildId,
  expectedBasePath,
} = {}) {
  if (!value || typeof value !== 'object'
    || value.schemaVersion !== 1
    || !validBuildId(value.buildId)
    || (expectedBuildId !== undefined && value.buildId !== expectedBuildId)
    || typeof value.builtAt !== 'string'
    || !Number.isFinite(Date.parse(value.builtAt))
    || typeof value.baseUrl !== 'string'
    || (value.baseUrl !== '/'
      && (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+\/$/.test(value.baseUrl)
        || value.baseUrl.includes('//')))
    || (expectedBasePath !== undefined && value.baseUrl !== expectedBasePath)
    || !Array.isArray(value.staticShellUrls)
    || value.staticShellUrls.length !== STATIC_SHELL_FILES.length) {
    throw new Error('The Pages artifact contains an invalid FRANK release descriptor.');
  }

  requireReleaseUrl(value.serviceWorkerUrl, value.baseUrl, 'sw.js', value.buildId, 'build');
  requireReleaseUrl(value.shellUrl, value.baseUrl, 'index.html', value.buildId);
  requireReleaseUrl(
    value.precacheManifestUrl,
    value.baseUrl,
    'frank-precache.json',
    value.buildId,
  );
  STATIC_SHELL_FILES.forEach((fileName, index) => {
    requireReleaseUrl(value.staticShellUrls[index], value.baseUrl, fileName, value.buildId);
  });
  return {
    buildId: value.buildId,
    builtAt: value.builtAt,
    baseUrl: value.baseUrl,
  };
}

export async function readReleaseManifest(fileName = 'dist/frank-precache.json') {
  const raw = await readFile(path.resolve(fileName), 'utf8');
  return requireReleaseManifest(JSON.parse(raw));
}

export async function readReleaseArtifact(manifestFileName = 'dist/frank-precache.json') {
  const manifestPath = path.resolve(manifestFileName);
  const manifest = await readReleaseManifest(manifestPath);
  const descriptorPath = path.join(path.dirname(manifestPath), 'frank-release.json');
  const descriptor = requireReleaseDescriptor(
    JSON.parse(await readFile(descriptorPath, 'utf8')),
    { expectedBuildId: manifest.buildId },
  );
  return { manifest, descriptor };
}

async function runCli(argv = process.argv.slice(2)) {
  if (argv.length > 1 || argv[0] === '--help') {
    throw new Error('Usage: node scripts/release-artifact.mjs [manifest-file]');
  }
  const artifact = await readReleaseArtifact(argv[0]);
  process.stdout.write(artifact.manifest.buildId);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCli().catch((error) => {
    const message = error instanceof Error ? error.message : 'Release artifact could not be read.';
    console.error(`[release] ${message}`);
    process.exitCode = 1;
  });
}
