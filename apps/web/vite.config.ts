import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, loadEnv } from 'vite';

const appRoot = fileURLToPath(new URL('.', import.meta.url));

function configuredPort(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535.`);
  }
  return port;
}

export default defineConfig(({ command, mode }) => {
  // Load local values from .env.local while allowing the launcher environment
  // to override them. These values stay in the Vite config process.
  const env = { ...loadEnv(mode, appRoot, ''), ...process.env };
  const webPort = configuredPort(env.CHEAPAI_WEB_PORT, 'CHEAPAI_WEB_PORT', 5173);
  const workerPort = configuredPort(env.CHEAPAI_WORKER_PORT, 'CHEAPAI_WORKER_PORT', 8787);

  let https: { key: Buffer; cert: Buffer } | undefined;
  if (command === 'serve') {
    const keyFile = env.CHEAPAI_WEB_TLS_KEY_FILE;
    const certFile = env.CHEAPAI_WEB_TLS_CERT_FILE;
    if (!keyFile || !certFile) {
      throw new Error(
        'Set CHEAPAI_WEB_TLS_KEY_FILE and CHEAPAI_WEB_TLS_CERT_FILE in apps/web/.env.local to use a trusted local HTTPS certificate.',
      );
    }

    https = {
      key: readFileSync(resolve(appRoot, keyFile)),
      cert: readFileSync(resolve(appRoot, certFile)),
    };
  }

  return {
    root: appRoot,
    base: '/',
    plugins: [react(), tailwindcss()],
    build: {
      outDir: 'dist',
      emptyOutDir: true,
    },
    server: {
      host: '127.0.0.1',
      port: webPort,
      strictPort: true,
      ...(https ? { https } : {}),
      proxy: {
        '/v1': {
          target: `http://127.0.0.1:${workerPort}`,
          // Keep the browser's same-origin Origin, Cookie, and CSRF headers.
          changeOrigin: false,
          configure(proxy) {
            // Vite's proxy pipes response streams; keep SSE responses unbuffered
            // if a local reverse proxy sits in front of the development server.
            proxy.on('proxyRes', (proxyResponse) => {
              if (proxyResponse.headers['content-type']?.includes('text/event-stream')) {
                proxyResponse.headers['cache-control'] ??= 'no-cache';
                proxyResponse.headers['x-accel-buffering'] = 'no';
              }
            });
          },
        },
        '/api': {
          target: `http://127.0.0.1:${workerPort}`,
          // Keep the browser's same-origin Origin, Cookie, and CSRF headers.
          changeOrigin: false,
          configure(proxy) {
            // Vite's proxy pipes response streams; keep SSE responses unbuffered
            // if a local reverse proxy sits in front of the development server.
            proxy.on('proxyRes', (proxyResponse) => {
              if (proxyResponse.headers['content-type']?.includes('text/event-stream')) {
                proxyResponse.headers['cache-control'] ??= 'no-cache';
                proxyResponse.headers['x-accel-buffering'] = 'no';
              }
            });
          },
        },
      },
    },
  };
});
