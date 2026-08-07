/// <reference types="vitest" />
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

const packageJson = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version?: string }

function getGitCommit() {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
  } catch {
    return 'local'
  }
}

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
    // Recharts and React set inline style ATTRIBUTES; the font CSS is fetched
    // from Google. Self-hosting the two families would let both go away.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    `connect-src 'self' ${WORKER_ORIGIN}`,
    "base-uri 'self'",
    "form-action 'none'",
    "object-src 'none'",
  ].join('; ')

  return {
    name: 'frank-csp-meta',
    apply: 'build' as const,
    transformIndexHtml(html: string) {
      return html.replace(
        '<meta charset="UTF-8" />',
        `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`
      )
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), cspMeta()],
  base: '/FRANK/',
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(packageJson.version ?? '0.0.0'),
    'import.meta.env.VITE_APP_COMMIT': JSON.stringify(getGitCommit()),
    'import.meta.env.VITE_APP_BUILD_TIME': JSON.stringify(new Date().toISOString()),
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
  },
})
