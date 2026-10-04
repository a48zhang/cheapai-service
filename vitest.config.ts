import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';
import { createResendHttpFixture } from './tests/helpers/resend-http-fixture';

const root = fileURLToPath(new URL('.', import.meta.url));
// Pure modules must not require bindings; *.node.test.ts opts other folders in.
const nodeTests = ['tests/apicompat/**/*.test.ts', 'tests/unit/**/*.test.ts', 'tests/**/*.node.test.ts', 'tests/auth/email-sender.test.ts'];
const excluded = [...configDefaults.exclude, 'tests/e2e/**', 'tests/**/*.spec.ts'];

export default defineConfig(async () => {
  // Root package is CommonJS; keep the ESM-only pool as a native dynamic import.
  const { cloudflareTest, readD1Migrations } = await import('@cloudflare/vitest-pool-workers');
  const migrations = await readD1Migrations(fileURLToPath(new URL('./migrations', import.meta.url)));
  return {
    test: {
      projects: [
        './apps/web/vitest.config.ts',
        {
          test: { name: 'node', root, environment: 'node', include: nodeTests, exclude: excluded },
        },
        {
          plugins: [cloudflareTest({
            wrangler: { configPath: fileURLToPath(new URL('./apps/worker/wrangler.jsonc', import.meta.url)) },
            remoteBindings: false,
            miniflare: {
              outboundService: createResendHttpFixture(),
            },
          })],
          test: {
            name: 'workers',
            root,
            include: ['tests/**/*.test.ts'],
            exclude: [...excluded, ...nodeTests],
            setupFiles: ['./tests/helpers/database.ts'],
            provide: { d1Migrations: migrations },
            // reset() clears all bindings; concurrent cases would race that reset.
            fileParallelism: false,
            maxConcurrency: 1,
            sequence: { concurrent: false, hooks: 'stack' },
          },
        },
      ],
    },
  };
});
