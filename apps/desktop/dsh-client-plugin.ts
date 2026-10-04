import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { normalizePath, type Plugin } from 'vite'

const require = createRequire(import.meta.url)
const clients = [
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-api-gateway',
  '@deepseek-ai/dsh-typert-registry',
  '@deepseek-ai/dsh-api-session-controller',
] as const

/** Adapt the pinned upstream ModuleLoader factories into static browser ESM.
 * The published code executes normally; no eval or global loader is required.
 */
export function dshClientModules(): Plugin {
  const files = new Map(clients.map(name => [normalizePath(require.resolve(`${name}/client`)), name]))
  return {
    name: 'desktop-dsh-client-modules',
    enforce: 'pre',
    transform(source, id) {
      const filename = id.split('?')[0]!
      const name = files.get(filename)
      if (!name) return
      const metadata = JSON.parse(readFileSync(require.resolve(`${name}/package.json`), 'utf8'))
      if (metadata.version !== '0.2.1-alpha.1'
        || !source.startsWith('window.__ModuleLoader__.load({')) {
        throw new Error(`Unsupported DSH client bundle: ${name}`)
      }
      const dependencies = [...new Set([...source.matchAll(/require\("([^"]+)"\)/gu)].map(match => match[1]!))]
      const exports = [...new Set([...source.matchAll(/\bexports\.([A-Za-z_$][\w$]*) =/gu)].map(match => match[1]!))]
      if (exports.length === 0) throw new Error(`Missing DSH client exports: ${name}`)
      const localRequire = createRequire(filename)
      const imports = dependencies.map((dependency, index) => {
        if (!['@deepseek-ai/cordis', '@deepseek-ai/dsh-api-gateway/client', '@deepseek-ai/dsh-client-store'].includes(dependency)) {
          throw new Error(`Unsupported DSH client dependency: ${dependency}`)
        }
        return `import * as dependency${index} from ${JSON.stringify(localRequire.resolve(dependency))};`
      })
      return {
        code: `${imports.join('\n')}
const dependencies = {${dependencies.map((dependency, index) => `${JSON.stringify(dependency)}: dependency${index}`).join(',')}};
let client;
((window) => {
${source.replace(/\/\/# sourceMappingURL=.*$/mu, '')}
})({ __ModuleLoader__: { load(descriptor) {
  if (client || descriptor.id !== ${JSON.stringify(name)} || typeof descriptor.factory !== 'function') throw new Error('Invalid DSH client registration');
  client = descriptor.factory(name => {
    if (!Object.hasOwn(dependencies, name)) throw new Error('Unsupported DSH dependency: ' + name);
    return dependencies[name];
  });
} } });
${exports.map((name, index) => `const export${index} = client.${name};\nexport { export${index} as ${name} };`).join('\n')}
`,
        map: null,
      }
    },
  }
}
