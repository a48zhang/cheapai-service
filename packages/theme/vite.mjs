import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// A shared external script runs before the CSS/app bundle, including under
// Worker's script-src 'self'. Hashing avoids stale bootstrap code after release.
export function appearanceBootstrap() {
  const source = readFileSync(new URL('./src/bootstrap.js', import.meta.url), 'utf8');
  const fileName = `appearance-${createHash('sha256').update(source).digest('hex').slice(0, 12)}.js`;
  let base = '/';
  return {
    name: 'cheapai-appearance-bootstrap',
    configResolved(config) {
      base = config.base;
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split('?')[0] !== `/${fileName}`) return next();
        response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        response.end(source);
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName, source });
    },
    transformIndexHtml: {
      order: 'post',
      handler() {
        return [{ tag: 'script', attrs: { src: `${base}${fileName}` }, injectTo: 'head-prepend' }];
      },
    },
  };
}
