import { defineConfig } from 'playwright/test';

const previewOrigin = 'http://127.0.0.1:4173';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI
    ? [['line'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
    : 'line',
  expect: {
    timeout: 8_000,
  },
  timeout: 45_000,
  use: {
    baseURL: `${previewOrigin}/FRANK/`,
    locale: 'da-DK',
    timezoneId: 'Europe/Copenhagen',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // Route interception is deterministic only without a controlling service
    // worker. The dedicated offline project below is the sole exception and
    // goes offline before its first controlled navigation.
    serviceWorkers: 'block',
  },
  projects: [
    {
      name: 'desktop-chromium',
      use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'pixel-5-chromium',
      use: {
        browserName: 'chromium',
        viewport: { width: 393, height: 851 },
        deviceScaleFactor: 2.75,
        hasTouch: true,
        isMobile: true,
      },
    },
    {
      name: 'small-phone-chromium',
      use: {
        browserName: 'chromium',
        viewport: { width: 320, height: 568 },
        deviceScaleFactor: 2,
        hasTouch: true,
        isMobile: true,
      },
    },
    {
      name: 'service-worker-chromium',
      use: {
        browserName: 'chromium',
        viewport: { width: 1440, height: 900 },
        serviceWorkers: 'allow',
      },
    },
  ],
  webServer: {
    // `npm run test:e2e` builds first; this command only ever serves that
    // immutable production output, never Vite's development transform path.
    command: 'npm run preview -- --host 127.0.0.1 --port 4173 --strictPort',
    url: `${previewOrigin}/FRANK/`,
    // Reusing an arbitrary process on this common port can silently turn an
    // E2E run into a test of stale output or the development server.
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
