import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

const appRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineProject({
  test: {
    name: 'react',
    root: appRoot,
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
  },
});
