import { Console } from 'node:console'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { HostStartupEvent } from '@sub2api/desktop-contracts'
import { CHEAPAI_API_KEY_CREDENTIAL_REF } from './dsh/config.ts'
import { launchDsh } from './dsh/launcher.ts'
import { DshLifecycle, type DshLifecycleSnapshot } from './dsh/lifecycle.ts'
import type { DshConnectionInfo } from './dsh/connection-info.ts'
import { createCheapAiProviderProfile, normalizeCheapAiBaseURL } from './cheapai/provider.ts'
import { discoverCheapAiModels } from './cheapai/model-catalog.ts'
import type { CheapAiPrivateConfiguration } from './host/protocol.ts'
import { RuntimeControlChannel, RuntimeControlError } from './host/control.ts'

const DSH_SETTINGS_NAMESPACE = 'llm-pi-ai'
const REMOTE_TIMEOUT_MS = 30_000

let startup: HostStartupEvent | undefined
let lifecycle: DshLifecycle | undefined
let control: RuntimeControlChannel | undefined
let privateConfiguration: CheapAiPrivateConfiguration | undefined
let configurationRevision = 0
let configurationQueue: Promise<void> = Promise.resolve()

function requiredAbsolutePath(value: string | undefined, fallback: string, label: string): string {
  const candidate = value ?? fallback
  if (!isAbsolute(candidate)) throw new RuntimeControlError('invalid-path', `${label} must be absolute`)
  return resolve(candidate)
}

function createLifecycle(): DshLifecycle {
  return new DshLifecycle({
    launch: () => {
      if (startup === undefined) throw new RuntimeControlError('not-started', 'Runtime startup is incomplete')
      const mode = startup.source === 'development' ? 'development' : 'packaged'
      const home = requiredAbsolutePath(
        process.env.SUB2API_DSH_HOME,
        join(homedir(), '.cheapai.dev', 'dsh'),
        'DSH home',
      )
      const workspaceDirectory = requiredAbsolutePath(
        process.env.SUB2API_DSH_WORKSPACE_DIRECTORY,
        homedir(),
        'DSH workspace directory',
      )
      const resourceDirectory = process.env.SUB2API_DSH_RESOURCE_DIRECTORY
      const runtimeExecutable = process.env.SUB2API_DSH_RUNTIME_EXECUTABLE
        ?? (startup.runtime === 'node' && process.versions.bun === undefined ? process.execPath : undefined)

      return launchDsh({
        mode,
        runtime: startup.runtime,
        ...(runtimeExecutable === undefined ? {} : { runtimeExecutable }),
        ...(resourceDirectory === undefined ? {} : { resourceDirectory }),
        home,
        workspaceDirectory,
        // DSH resolves this credential through its own mutable credential store.
        // A parent environment value would shadow writes and defeat key rotation.
        env: { [CHEAPAI_API_KEY_CREDENTIAL_REF]: undefined },
      })
    },
    onState: status => control?.publishStatus(status),
  })
}

function requireLifecycle(): DshLifecycle {
  if (lifecycle === undefined) throw new RuntimeControlError('not-started', 'Runtime has not received its host startup event')
  return lifecycle
}

async function applyConfiguration(connection: DshConnectionInfo, configuration: CheapAiPrivateConfiguration): Promise<void> {
  if (configuration.apiKey === null) {
    await callDshRemote(connection, 'credentials', 'unset', { ref: CHEAPAI_API_KEY_CREDENTIAL_REF })
    return
  }

  await callDshRemote(connection, 'credentials', 'set', {
    ref: CHEAPAI_API_KEY_CREDENTIAL_REF,
    value: configuration.apiKey,
  })

  const models = await discoverCheapAiModels({
    baseURL: configuration.baseURL,
    api: configuration.api,
    getKey: async () => configuration.apiKey ?? undefined,
    signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
  })
  const profile = createCheapAiProviderProfile({
    baseURL: configuration.baseURL,
    api: configuration.api,
    models,
  })
  await callDshRemote(connection, 'settings', 'update', {
    ns: DSH_SETTINGS_NAMESPACE,
    patch: profile,
  })
}

function applyLatestConfiguration(connection: DshConnectionInfo): Promise<void> {
  const task = configurationQueue.then(async () => {
    let appliedRevision = -1
    while (appliedRevision !== configurationRevision) {
      const targetRevision = configurationRevision
      const configuration = privateConfiguration
      if (configuration !== undefined) await applyConfiguration(connection, configuration)
      appliedRevision = targetRevision
    }
  })
  configurationQueue = task.catch(() => {})
  return task
}

async function callDshRemote(
  connection: DshConnectionInfo,
  namespace: 'credentials' | 'settings',
  method: 'set' | 'unset' | 'update',
  args: Record<string, unknown>,
): Promise<unknown> {
  const rpcId = randomUUID()
  let response: Response
  try {
    response = await fetch(new URL(`/api/${namespace}/${method}`, connection.httpBaseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: connection.auth.cookie,
        origin: connection.origin,
      },
      body: JSON.stringify({
        type: 'client-request',
        rpcId,
        method,
        payload: { args },
      }),
      signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
    })
  } catch {
    throw new RuntimeControlError('dsh-remote-unavailable', `Could not reach DSH ${namespace}.${method}`)
  }
  if (!response.ok) {
    throw new RuntimeControlError('dsh-remote-refused', `DSH ${namespace}.${method} returned HTTP ${response.status}`)
  }

  let envelope: unknown
  try {
    envelope = await response.json()
  } catch {
    throw new RuntimeControlError('dsh-remote-invalid-response', `DSH ${namespace}.${method} returned invalid JSON`)
  }
  if (!isRecord(envelope)
    || envelope.type !== 'server-response'
    || envelope.rpcId !== rpcId
    || !isRecord(envelope.result)
    || envelope.result.ok !== true) {
    throw new RuntimeControlError('dsh-remote-refused', `DSH refused ${namespace}.${method}`)
  }
  return envelope.result.value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function redirectOrdinaryLogsToStderr(): void {
  globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr })
}

async function main(): Promise<void> {
  redirectOrdinaryLogsToStderr()

  const runtimeControl = new RuntimeControlChannel({
    input: process.stdin,
    output: process.stdout,
    diagnostic: message => process.stderr.write(`${message}\n`),
  }, {
    onStartup: event => {
      if (startup !== undefined) throw new RuntimeControlError('duplicate-startup', 'Runtime startup was already initialized')
      startup = event
      lifecycle = createLifecycle()
    },
    start: async () => {
      const owner = requireLifecycle()
      const connection = await owner.start()
      const configuration = privateConfiguration
      if (configuration !== undefined) {
        try {
          await applyLatestConfiguration(connection)
        } catch {
          process.stderr.write('CheapAI configuration could not be applied to DSH\n')
        }
      }
      return connection
    },
    stop: async () => {
      await lifecycle?.stop()
    },
    status: (): DshLifecycleSnapshot => lifecycle?.status ?? { state: 'stopped', generation: 0 },
    configure: async configuration => {
      let normalized: CheapAiPrivateConfiguration
      try {
        normalized = {
          baseURL: normalizeCheapAiBaseURL(configuration.baseURL),
          api: configuration.api,
          apiKey: configuration.apiKey,
        }
      } catch {
        throw new RuntimeControlError('invalid-provider-configuration', 'CheapAI provider settings are invalid')
      }
      if (normalized.apiKey !== null
        && (normalized.apiKey.length === 0 || /[\r\n]/u.test(normalized.apiKey))) {
        throw new RuntimeControlError('invalid-provider-credential', 'CheapAI credential is empty or invalid')
      }
      privateConfiguration = normalized
      configurationRevision += 1

      const connection = lifecycle?.connectionInfo
      if (lifecycle?.status.state !== 'ready' || connection === undefined) return { applied: false }
      try {
        await applyLatestConfiguration(connection)
      } catch {
        throw new RuntimeControlError('provider-configuration-failed', 'CheapAI settings could not be applied to DSH')
      }
      return { applied: true }
    },
  })
  control = runtimeControl
  runtimeControl.start()

  let shutdownPromise: Promise<void> | undefined
  const onShutdown = (): void => {
    if (shutdownPromise !== undefined) return
    runtimeControl.close()
    process.stdin.pause()
    process.off('SIGINT', onShutdown)
    process.off('SIGTERM', onShutdown)
    process.stdin.off('end', onShutdown)
    shutdownPromise = lifecycle?.stop().catch(() => {}) ?? Promise.resolve()
    void shutdownPromise
  }
  process.once('SIGINT', onShutdown)
  process.once('SIGTERM', onShutdown)
  process.stdin.once('end', onShutdown)
}

void main().catch(() => {
  process.stderr.write('Desktop Runtime could not initialize\n')
  process.exitCode = 1
})
