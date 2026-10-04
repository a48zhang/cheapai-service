/** Load the fixed DSH browser bundles through their published factory contract.
 * These are trusted installed dependencies, not ESM modules or user-provided code.
 * Keep the registration window local: Runtime must not acquire browser globals.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { compileFunction } from 'node:vm'
import * as cordis from '@deepseek-ai/cordis'

const require = createRequire(import.meta.url)
const CLIENT_VERSION = '0.2.1-alpha.1'

type ClientPackage =
  | '@deepseek-ai/dsh-client-connection'
  | '@deepseek-ai/dsh-api-gateway'
  | '@deepseek-ai/dsh-typert-registry'

function loadClient(name: ClientPackage, requiredExport: string): Record<string, unknown> {
  const metadata = JSON.parse(readFileSync(require.resolve(`${name}/package.json`), 'utf8')) as { version?: unknown }
  if (metadata.version !== CLIENT_VERSION) throw new Error(`Unsupported DSH client version: ${name}`)
  const filename = require.resolve(`${name}/client`)
  let registered = false
  let exports: unknown
  const loader = Object.freeze({
    load(descriptor: unknown): void {
      if (registered || typeof descriptor !== 'object' || descriptor === null
        || !('id' in descriptor) || descriptor.id !== name
        || !('factory' in descriptor) || typeof descriptor.factory !== 'function') {
        throw new Error(`Invalid DSH client registration: ${name}`)
      }
      registered = true
      exports = descriptor.factory((dependency: string): unknown => {
        // All three pinned bundles externalize only the shared Cordis instance.
        if (dependency === '@deepseek-ai/cordis') return cordis
        throw new Error(`Unsupported DSH client dependency: ${dependency}`)
      })
    },
  })
  compileFunction(readFileSync(filename, 'utf8'), ['window'], { filename })(
    Object.freeze({ __ModuleLoader__: loader }),
  )
  if (!registered || typeof exports !== 'object' || exports === null
    || typeof Reflect.get(exports, requiredExport) !== 'function') {
    throw new Error(`Missing DSH client export: ${name}/${requiredExport}`)
  }
  return exports as Record<string, unknown>
}

export const { installConnection } = loadClient('@deepseek-ai/dsh-client-connection', 'installConnection') as
  Pick<typeof import('@deepseek-ai/dsh-client-connection/client'), 'installConnection'>
export const { apply: installGatewayClient } = loadClient('@deepseek-ai/dsh-api-gateway', 'apply') as
  Pick<typeof import('@deepseek-ai/dsh-api-gateway/client'), 'apply'>
export const { apply: installTypertClient } = loadClient('@deepseek-ai/dsh-typert-registry', 'apply') as
  Pick<typeof import('@deepseek-ai/dsh-typert-registry/client'), 'apply'>
