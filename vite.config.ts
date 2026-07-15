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

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: '/FRANK/',
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(packageJson.version ?? '0.0.0'),
    'import.meta.env.VITE_APP_COMMIT': JSON.stringify(getGitCommit()),
    'import.meta.env.VITE_APP_BUILD_TIME': JSON.stringify(new Date().toISOString()),
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('react')) return 'react';
          if (id.includes('recharts')) return 'charts';
          if (id.includes('lucide-react')) return 'icons';
          return 'vendor';
        },
      },
    },
  },
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
  },
})
