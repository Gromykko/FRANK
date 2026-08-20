/// <reference types="vitest" />
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { configDefaults, defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

const packageJson = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version?: string }

function getGitCommit() {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
  } catch {
    return 'local'
  }
}

const APP_VERSION = packageJson.version ?? '0.0.0'
const APP_COMMIT = getGitCommit()
const APP_BUILD_TIME = new Date().toISOString()
const APP_BASE = '/FRANK/'
// This is intentionally unique for every production build, even when the
// source commit and package version are unchanged (for example, a manual
// redeploy). The client passes it in the service-worker script URL and the
// generated precache manifest repeats it, so a worker can never bless assets
// assembled from two different deployments.
const APP_BUILD_ID = `${APP_VERSION}-${APP_COMMIT}-${APP_BUILD_TIME}`

const WORKER_ORIGIN = process.env.VITE_FORECAST_WORKER_BASE ?? 'https://frank-forecast.alswatchs.workers.dev'

// GitHub Pages serves static files and cannot set response headers, so a <meta>
// CSP is the only one available. Injected at BUILD time only: the dev server
// injects its own inline HMR/react-refresh scripts, which a real script-src
// would block. There is no injection sink in the app today (no
// dangerouslySetInnerHTML, no innerHTML, no eval anywhere in src/) — this is
// defence in depth against a future compromised dependency, which is exactly
// the case where connect-src earns its keep.
function cspMeta() {
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    // Recharts and React set inline style attributes. Both font families are
    // bundled with the app, so production does not need any font CDN origins.
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data:",
    `connect-src 'self' ${WORKER_ORIGIN}`,
    "base-uri 'self'",
    "form-action 'none'",
    "object-src 'none'",
  ].join('; ')
  const escapedBuildId = APP_BUILD_ID
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')

  return {
    name: 'frank-csp-meta',
    apply: 'build' as const,
    transformIndexHtml(html: string) {
      return html.replace(
        '<meta charset="UTF-8" />',
        `<meta charset="UTF-8" />\n    <meta name="frank-build-id" content="${escapedBuildId}" />\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`
      )
    },
  }
}

// The service worker is copied verbatim from public/, so it cannot know Vite's
// content-hashed output names at authoring time. Emit a small build manifest
// containing every generated asset (including lazy chunks) and let the worker
// install that exact, self-consistent set transactionally.
function serviceWorkerReleaseArtifacts(): Plugin {
  return {
    name: 'frank-service-worker-release-artifacts',
    apply: 'build' as const,
    generateBundle(_options, bundle) {
      const assets = Object.keys(bundle)
        .filter((fileName) => fileName.startsWith('assets/'))
        .sort()

      const releaseQuery = encodeURIComponent(APP_BUILD_ID)
      const releaseUrl = (path: string) => `${path}?frank-build=${releaseQuery}`

      this.emitFile({
        type: 'asset',
        fileName: 'frank-precache.json',
        source: `${JSON.stringify({ schemaVersion: 1, buildId: APP_BUILD_ID, assets }, null, 2)}\n`,
      })

      // GitHub Pages cannot give sw.js a short, controllable Cache-Control
      // header. A release descriptor plus build-bound URLs lets an already
      // active app discover the next deployment without first accepting its
      // HTML, while a candidate worker can prove every file belongs to the
      // same build before it becomes eligible for activation.
      this.emitFile({
        type: 'asset',
        fileName: 'frank-release.json',
        source: `${JSON.stringify({
          schemaVersion: 1,
          buildId: APP_BUILD_ID,
          builtAt: APP_BUILD_TIME,
          baseUrl: APP_BASE,
          serviceWorkerUrl: `${APP_BASE}sw.js?build=${releaseQuery}`,
          shellUrl: releaseUrl(`${APP_BASE}index.html`),
          precacheManifestUrl: releaseUrl(`${APP_BASE}frank-precache.json`),
          staticShellUrls: [
            `${APP_BASE}manifest.json`,
            `${APP_BASE}favicon.svg`,
            `${APP_BASE}icon-192.png`,
            `${APP_BASE}icon-512.png`,
            `${APP_BASE}apple-touch-icon.png`,
          ].map(releaseUrl),
        }, null, 2)}\n`,
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), cspMeta(), serviceWorkerReleaseArtifacts()],
  base: APP_BASE,
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(APP_VERSION),
    'import.meta.env.VITE_APP_COMMIT': JSON.stringify(APP_COMMIT),
    'import.meta.env.VITE_APP_BUILD_TIME': JSON.stringify(APP_BUILD_TIME),
    'import.meta.env.VITE_APP_BUILD_ID': JSON.stringify(APP_BUILD_ID),
  },
  // No manualChunks. The hand-rolled buckets did the opposite of their intent:
  // `id.includes('react')` swallowed lucide-react (so the 'icons' bucket never
  // existed) and, worse, forcing recharts into a named 'charts' chunk defeated
  // App.tsx's `lazy(() => import('./components/WeatherCharts'))` — the entry
  // ended up statically importing that chunk and index.html modulepreloaded it,
  // so 339 KB of charting downloaded and parsed on every first paint for a
  // panel that starts collapsed. Rolldown's default splitting respects the
  // dynamic import. Re-add only if the default output measurably regresses.
  server: {
    proxy: {
      '/dmi-forecast': {
        target: 'https://opendataapi.dmi.dk/v1/forecastedr',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/dmi-forecast/, ''),
      },
      // MET Norway rejects requests without an identifying User-Agent, which the
      // browser cannot set. The dev proxy injects one so the client can fetch
      // MET directly during local development.
      '/met-forecast': {
        target: 'https://api.met.no',
        changeOrigin: true,
        headers: {
          'User-Agent': 'FRANK-kayak-forecast/1.0 (https://github.com/Gromykko/FRANK)',
        },
        rewrite: (path) => path.replace(/^\/met-forecast/, ''),
      },
      // MeteoAlarm's warning feed has no CORS headers, so the browser can't read
      // it directly in dev; the proxy fronts it (production reads the worker
      // payload, which already carries the parsed warnings).
      '/meteoalarm': {
        target: 'https://feeds.meteoalarm.org',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/meteoalarm/, ''),
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    // Playwright owns real-browser production tests, while the Worker runtime
    // suite has its own pool/config. Preserve Vitest's built-in excludes too.
    exclude: [...configDefaults.exclude, 'tests/e2e/**', 'tests/worker-runtime/**'],
  },
})
