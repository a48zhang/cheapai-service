import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/desktop-ui',
  outputDir: './test-results/desktop-browser',
  workers: 1,
  timeout: 60_000,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4176',
    trace: 'retain-on-failure',
    launchOptions: process.env.CHEAPAI_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.CHEAPAI_CHROMIUM_EXECUTABLE }
      : {},
  },
  webServer: {
    command: 'pnpm --filter @sub2api/desktop exec vite --host 127.0.0.1 --port 4176 --strictPort',
    url: 'http://127.0.0.1:4176',
    timeout: 60_000,
    reuseExistingServer: false,
  },
});
