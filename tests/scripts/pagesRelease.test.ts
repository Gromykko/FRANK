// @vitest-environment node
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  requireReleaseDescriptor,
  requireReleaseManifest,
} from '../../scripts/release-artifact.mjs';
import { verifyPagesRelease } from '../../scripts/verify-pages-release.mjs';

const BUILD_ID = '0.1.0-a1b2c3d-2026-08-20T15:00:00.000Z';
const ASSETS = ['assets/index-abc123.js', 'assets/index-def456.css'];
const BASE_PATH = '/FRANK/';
const openServers: Server[] = [];
const silentLogger = { info: () => {}, warn: () => {} };

async function listen(handler: Parameters<typeof createServer>[0]) {
  const server = createServer(handler);
  openServers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Mock server has no address');
  return `http://127.0.0.1:${address.port}/FRANK/`;
}

function send(response: Parameters<NonNullable<Parameters<typeof createServer>[0]>>[1], body: string, type: string, status = 200) {
  response.writeHead(status, { 'Content-Type': type });
  response.end(body);
}

function releaseDescriptor(buildId = BUILD_ID) {
  const releaseUrl = (fileName: string) => `${BASE_PATH}${fileName}?frank-build=${encodeURIComponent(buildId)}`;
  return {
    schemaVersion: 1,
    buildId,
    builtAt: '2026-08-20T15:00:00.000Z',
    baseUrl: BASE_PATH,
    serviceWorkerUrl: `${BASE_PATH}sw.js?build=${encodeURIComponent(buildId)}`,
    shellUrl: releaseUrl('index.html'),
    precacheManifestUrl: releaseUrl('frank-precache.json'),
    staticShellUrls: [
      'manifest.json',
      'favicon.svg',
      'icon-192.png',
      'icon-512.png',
      'apple-touch-icon.png',
    ].map(releaseUrl),
  };
}

function releaseServer({ oldManifestAttempts = 0, missingAsset = false } = {}) {
  let manifestRequests = 0;
  return listen((request, response) => {
    const url = new URL(request.url ?? '/', 'http://example.test');
    if (url.pathname === '/FRANK/' || url.pathname === '/FRANK/index.html') {
      return send(
        response,
        `<meta name="frank-build-id" content="${BUILD_ID}">`
          + '<script type="module" src="/FRANK/assets/index-abc123.js"></script>'
          + '<link rel="stylesheet" href="/FRANK/assets/index-def456.css">',
        'text/html; charset=utf-8',
      );
    }
    if (url.pathname === '/FRANK/frank-precache.json') {
      manifestRequests += 1;
      const buildId = manifestRequests <= oldManifestAttempts ? 'old-build' : BUILD_ID;
      return send(response, JSON.stringify({ schemaVersion: 1, buildId, assets: ASSETS }), 'application/json');
    }
    if (url.pathname === '/FRANK/frank-release.json') {
      return send(response, JSON.stringify(releaseDescriptor()), 'application/json');
    }
    if (url.pathname === '/FRANK/assets/index-abc123.js') {
      return send(response, 'export {};', 'text/javascript');
    }
    if (url.pathname === '/FRANK/assets/index-def456.css') {
      return send(response, missingAsset ? 'missing' : 'body {}', 'text/css', missingAsset ? 404 : 200);
    }
    if (url.pathname === '/FRANK/sw.js') return send(response, 'self.addEventListener("fetch",()=>{});', 'application/javascript');
    if (url.pathname.endsWith('.json')) return send(response, '{}', 'application/json');
    if (url.pathname.endsWith('.svg')) return send(response, '<svg/>', 'image/svg+xml');
    if (url.pathname.endsWith('.png')) return send(response, 'png', 'image/png');
    return send(response, 'not found', 'text/plain', 404);
  });
}

afterEach(async () => {
  const servers = openServers.splice(0);
  for (const server of servers) server.closeAllConnections?.();
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('Pages release artifact contract', () => {
  it('accepts one immutable build with unique scoped assets', () => {
    expect(requireReleaseManifest({ schemaVersion: 1, buildId: BUILD_ID, assets: ASSETS })).toEqual({
      buildId: BUILD_ID,
      assets: ASSETS,
    });
  });

  it.each([
    null,
    { schemaVersion: 1, buildId: '', assets: ASSETS },
    { schemaVersion: 1, buildId: BUILD_ID, assets: [] },
    { schemaVersion: 1, buildId: BUILD_ID, assets: ['../index.js'] },
    { schemaVersion: 1, buildId: BUILD_ID, assets: [ASSETS[0], ASSETS[0]] },
  ])('rejects malformed or path-escaping manifests', (manifest) => {
    expect(() => requireReleaseManifest(manifest)).toThrow('valid FRANK release manifest');
  });

  it('binds the update descriptor and every URL to the same build and base path', () => {
    expect(requireReleaseDescriptor(releaseDescriptor(), {
      expectedBuildId: BUILD_ID,
      expectedBasePath: BASE_PATH,
    })).toMatchObject({ buildId: BUILD_ID, baseUrl: BASE_PATH });

    expect(() => requireReleaseDescriptor({
      ...releaseDescriptor(),
      serviceWorkerUrl: '/OTHER/sw.js?frank-build=wrong',
    }, { expectedBuildId: BUILD_ID, expectedBasePath: BASE_PATH })).toThrow(
      'invalid FRANK release descriptor',
    );
  });
});

describe('live Pages release verification', () => {
  it('retries propagation, then verifies exact HTML, manifest, assets, and shell', async () => {
    const baseUrl = await releaseServer({ oldManifestAttempts: 1 });
    await expect(verifyPagesRelease({
      baseUrl,
      expectedBuildId: BUILD_ID,
      attempts: 2,
      timeoutMs: 500,
      retryDelayMs: 1,
      logger: silentLogger,
    })).resolves.toEqual({ buildId: BUILD_ID, assetCount: 2 });
  });

  it('fails closed when an asset from the exact manifest is unavailable', async () => {
    const baseUrl = await releaseServer({ missingAsset: true });
    await expect(verifyPagesRelease({
      baseUrl,
      expectedBuildId: BUILD_ID,
      attempts: 1,
      timeoutMs: 500,
      retryDelayMs: 1,
      logger: silentLogger,
    })).rejects.toThrow('required resource returned HTTP 404');
  });

  it('refuses a non-loopback plaintext production URL', async () => {
    await expect(verifyPagesRelease({
      baseUrl: 'http://example.test/FRANK/',
      expectedBuildId: BUILD_ID,
      attempts: 1,
      timeoutMs: 1,
      retryDelayMs: 1,
      logger: silentLogger,
    })).rejects.toThrow('must use HTTPS');
  });
});
