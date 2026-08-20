import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import process from 'node:process';
import { defineConfig } from 'vitest/config';

// Wrangler validates required secrets while loading the test configuration,
// before Miniflare applies its local bindings. Keep that validation quiet with
// a deterministic test-only value; production never reads this process.
process.env.FRANK_WARM_TOKEN ??= 'frank-runtime-test-warm-token-32-chars';

export default defineConfig({
  plugins: [
    cloudflareTest({
      // The deployment config remains the single source of truth for the
      // entrypoint, compatibility date, and KV binding. Runtime tests must
      // never resolve a binding against the live Cloudflare account.
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          // This is deliberately test-only. Production still requires the
          // encrypted Cloudflare secret declared by wrangler.jsonc.
          FRANK_WARM_TOKEN: 'frank-runtime-test-warm-token-32-chars',
        },
      },
      remoteBindings: false,
    }),
  ],
  test: {
    include: ['tests/worker-runtime/**/*.test.ts'],
  },
});
