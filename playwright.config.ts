import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// The workspace root is CommonJS; Playwright transforms this .ts config to CJS.
const root = __dirname;
const baseURL = `https://127.0.0.1:${process.env.SUB2API_E2E_PORT ?? '9789'}`;
const edge = process.platform === 'win32' ? [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find(existsSync) : undefined;
const chromium = process.env.CHEAPAI_CHROMIUM_EXECUTABLE ?? edge;

export default defineConfig({
  testDir: './tests/e2e', fullyParallel: false, workers: 1, retries: 0, timeout: 60_000,
  expect: { timeout: 10_000 }, reporter: [['list'], ['json', { outputFile: 'test-results/browser-results.json' }]],
  use: { baseURL, ignoreHTTPSErrors: true, actionTimeout: 10_000, trace: 'retain-on-failure',
    launchOptions: chromium ? { executablePath: chromium } : {} },
  webServer: {
    command: `"${process.execPath}" "${join(root, 'scripts/start-local-test-server.mjs')}"`,
    cwd: root, url: `${baseURL}/healthz`, ignoreHTTPSErrors: true,
    timeout: 180_000, reuseExistingServer: false,
  },
});
