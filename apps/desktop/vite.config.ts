import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { dshClientModules } from './dsh-client-plugin';

export default defineConfig({
  base: './',
  plugins: [dshClientModules(), react()],
  // Keep the upstream non-ESM factories in Vite's transform pipeline in dev.
  optimizeDeps: {
    exclude: [
      '@deepseek-ai/dsh-client-connection/client',
      '@deepseek-ai/dsh-api-gateway/client',
      '@deepseek-ai/dsh-typert-registry/client',
      '@deepseek-ai/dsh-api-session-controller/client',
    ],
  },
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
