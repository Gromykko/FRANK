import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      // The deployment config remains the single source of truth for the
      // entrypoint, compatibility date, and KV binding. Runtime tests must
      // never resolve a binding against the live Cloudflare account.
      wrangler: { configPath: './wrangler.jsonc' },
      remoteBindings: false,
    }),
  ],
  test: {
    include: ['tests/worker-runtime/**/*.test.ts'],
  },
});
