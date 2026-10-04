import { Console } from 'node:console'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { DesktopAccountData, HostStartupEvent } from '@sub2api/desktop-contracts'
import { CHEAPAI_API_KEY_CREDENTIAL_REF } from './dsh/config.ts'
import { createDshRuntimeTransport, type DshRuntimeTransport } from './dsh/transport.ts'
import { launchDsh } from './dsh/launcher.ts'
import { DshLifecycle, type DshLifecycleSnapshot } from './dsh/lifecycle.ts'
import type { DshConnectionInfo } from './dsh/connection-info.ts'
import { createCheapAiProviderProfile, normalizeCheapAiBaseURL } from './cheapai/provider.ts'
import type { CheapAiApiProtocol, CheapAiModelProfile } from './cheapai/provider.ts'
import { discoverCheapAiModels } from './cheapai/model-catalog.ts'
import { DesktopAccountApiError, DesktopAccountClient } from './cheapai/account-client.ts'
import { DesktopAccountController } from './cheapai/account-controller.ts'
import { DesktopAccountStateStore, DesktopDshAccountBinding } from './cheapai/account-state.ts'
import { DesktopCredentialBridge, DESKTOP_CREDENTIAL_SOCKET_ENV } from './cheapai/credential-bridge.ts'
import type { DshAccountHomeScope } from './dsh/paths.ts'
import { DesktopSessionManager } from './cheapai/session-manager.ts'
import type {
  CheapAiPrivateConfiguration,
  DshRuntimeStreamEvent,
  DshTransportOperation,
} from './host/protocol.ts'
import { RuntimeControlChannel, RuntimeControlError } from './host/control.ts'

const DSH_SETTINGS_NAMESPACE = 'llm-pi-ai'
const REMOTE_TIMEOUT_MS = 30_000

let startup: HostStartupEvent | undefined
let lifecycle: DshLifecycle | undefined
let control: RuntimeControlChannel | undefined
let privateConfiguration: CheapAiPrivateConfiguration | undefined
let configurationRevision = 0
let configurationQueue: Promise<void> = Promise.resolve()
let dshTransport: DshRuntimeTransport | undefined
let dshTransportGeneration: number | undefined
let dshTransportSetup: { generation: number; promise: Promise<void> } | undefined
let dshTransportDisposal: Promise<void> | undefined
let dshTransportEpoch = 0
const accountStateStore = new DesktopAccountStateStore()
let accountController: DesktopAccountController | undefined
let credentialBridge: DesktopCredentialBridge | undefined
let credentialBridgeAddress: string | undefined
let credentialBridgeSetup: { bridge: DesktopCredentialBridge; promise: Promise<string> } | undefined
let credentialBridgeEpoch = 0
let accountHomeBase: string | undefined
let runtimeShuttingDown = false

function lifecycleIsReady(generation: number): boolean {
  const status = lifecycle?.status
  return status?.state === 'ready' && status.generation === generation
}

function disposeDshTransport(): Promise<void> {
  if (dshTransportDisposal !== undefined) return dshTransportDisposal

  dshTransportEpoch += 1
  const setup = dshTransportSetup
  dshTransportSetup = undefined
  const current = dshTransport
  dshTransport = undefined
  dshTransportGeneration = undefined

  const task = (async () => {
    if (setup !== undefined) await setup.promise.catch(() => {})
    await current?.dispose()
  })()
  const tracked = task.finally(() => {
    if (dshTransportDisposal === tracked) dshTransportDisposal = undefined
  })
  dshTransportDisposal = tracked
  return tracked
}

function scheduleDshTransportDisposal(): void {
  void disposeDshTransport().catch(() => {
    process.stderr.write('DSH Runtime transport cleanup failed\n')
  })
}

function scheduleCredentialBridgeDisposal(): void {
  // closeCredentialBridge clears the endpoint globals and advances its epoch
  // synchronously before its first await, so a restart cannot reuse the old
  // child's capability while socket cleanup is still settling.
  void closeCredentialBridge().catch(() => {
    process.stderr.write('Desktop credential bridge cleanup failed\n')
  })
}

async function ensureDshTransport(connection: DshConnectionInfo, generation: number): Promise<void> {
  if (!lifecycleIsReady(generation)) {
    throw new RuntimeControlError('stale-generation', 'DSH is no longer ready for this Runtime generation')
  }
  if (dshTransport !== undefined && dshTransportGeneration === generation) return
  if (dshTransportSetup?.generation === generation) {
    await dshTransportSetup.promise
    if (dshTransport !== undefined && dshTransportGeneration === generation) return
    throw new RuntimeControlError('stale-generation', 'DSH transport setup belongs to an inactive Runtime generation')
  }

  await disposeDshTransport()
  if (!lifecycleIsReady(generation)) {
    throw new RuntimeControlError('stale-generation', 'DSH stopped before its Runtime transport could be created')
  }
  if (dshTransport !== undefined && dshTransportGeneration === generation) return
  if (dshTransportSetup?.generation === generation) {
    await dshTransportSetup.promise
    if (dshTransport !== undefined && dshTransportGeneration === generation) return
    throw new RuntimeControlError('stale-generation', 'DSH transport setup belongs to an inactive Runtime generation')
  }

  const epoch = dshTransportEpoch
  const setup: { generation: number; promise: Promise<void> } = {
    generation,
    promise: Promise.resolve().then(async () => {
      const candidate = await createDshRuntimeTransport(connection, generation)
      if (dshTransportEpoch !== epoch || !lifecycleIsReady(generation)) {
        await candidate.dispose()
        return
      }
      dshTransport = candidate
      dshTransportGeneration = generation
    }),
  }
  dshTransportSetup = setup
  try {
    await setup.promise
  } finally {
    if (dshTransportSetup === setup) dshTransportSetup = undefined
  }
  if (dshTransport === undefined || dshTransportGeneration !== generation || !lifecycleIsReady(generation)) {
    throw new RuntimeControlError('stale-generation', 'DSH transport setup completed after its Runtime generation stopped')
  }
}

async function dispatchDshTransport(
  operation: DshTransportOperation,
  payload: unknown,
  publish: (event: DshRuntimeStreamEvent) => void,
): Promise<unknown> {
  const target = dshTransport
  const generation = dshTransportGeneration
  if (target === undefined || generation === undefined || !lifecycleIsReady(generation)) {
    throw new RuntimeControlError('dsh-transport-unavailable', 'DSH Runtime transport is not ready')
  }

  return target.handle(operation, payload, event => {
    if (event.generation !== generation
      || dshTransport !== target
      || dshTransportGeneration !== generation
      || !lifecycleIsReady(generation)) return
    publish(event)
  })
}

async function stopDshRuntime(): Promise<void> {
  await closeCredentialBridge()
  let transportFailure: unknown
  try {
    await disposeDshTransport()
  } catch (cause) {
    transportFailure = cause
  }
  let lifecycleFailure: unknown
  try {
    await lifecycle?.stop()
  } catch (cause) {
    lifecycleFailure = cause
  }
  if (transportFailure !== undefined) {
    throw new RuntimeControlError('dsh-transport-cleanup-failed', 'DSH Runtime transport could not be disposed')
  }
  if (lifecycleFailure !== undefined) throw lifecycleFailure
}

function requiredAbsolutePath(value: string | undefined, fallback: string, label: string): string {
  const candidate = value ?? fallback
  if (!isAbsolute(candidate)) throw new RuntimeControlError('invalid-path', `${label} must be absolute`)
  return resolve(candidate)
}

function createLifecycle(): DshLifecycle {
  return new DshLifecycle({
    launch: (boundHome?: string) => {
      if (startup === undefined) throw new RuntimeControlError('not-started', 'Runtime startup is incomplete')
      const mode = startup.source === 'development' ? 'development' : 'packaged'
      const home = requiredAbsolutePath(
        boundHome ?? accountHomeBase ?? process.env.SUB2API_DSH_HOME,
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
        // Managed account mode uses a private per-child resolver. Static Key
        // configuration exists only behind the explicit development switch.
        env: {
          [CHEAPAI_API_KEY_CREDENTIAL_REF]: undefined,
          [DESKTOP_CREDENTIAL_SOCKET_ENV]: credentialBridgeAddress,
        },
      })
    },
    onState: status => {
      control?.publishStatus(status)
      if (status.state === 'stopping'
        || status.state === 'stopped'
        || status.state === 'failed'
        || (status.state === 'starting'
          && dshTransportGeneration !== undefined
          && dshTransportGeneration !== status.generation)) {
        scheduleDshTransportDisposal()
      }
      if (status.state === 'stopped' || status.state === 'failed') {
        scheduleCredentialBridgeDisposal()
      }
    },
  })
}

function requireLifecycle(): DshLifecycle {
  if (runtimeShuttingDown) throw new RuntimeControlError('runtime-shutting-down', 'Runtime is shutting down')
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

function developmentKeyModeEnabled(): boolean {
  return startup?.source === 'development'
    && process.env.SUB2API_DESKTOP_DEVELOPMENT_KEY_MODE === '1'
}

function modelConfiguration(): { readonly baseURL: string; readonly api: CheapAiApiProtocol } {
  const baseURL = normalizeCheapAiBaseURL(process.env.SUB2API_DESKTOP_MODEL_BASE_URL ?? 'https://cheapai.dev/v1')
  const configuredApi = process.env.SUB2API_DESKTOP_MODEL_API ?? 'openai-completions'
  if (configuredApi !== 'openai-completions'
    && configuredApi !== 'openai-responses'
    && configuredApi !== 'anthropic-messages') {
    throw new RuntimeControlError('invalid-model-configuration', 'CheapAI model protocol is invalid')
  }
  return { baseURL, api: configuredApi }
}

function currentAccountGeneration(generation: number): boolean {
  return accountStateStore.isCurrent(generation)
}

function assertCurrentAccountGeneration(generation: number): void {
  if (!currentAccountGeneration(generation)) {
    throw new RuntimeControlError('stale-account-generation', 'The active desktop account changed')
  }
}

async function ensureCredentialBridge(generation: number): Promise<string> {
  assertCurrentAccountGeneration(generation)
  if (credentialBridge !== undefined && credentialBridgeAddress !== undefined) {
    return credentialBridgeAddress
  }
  if (credentialBridgeSetup !== undefined) {
    const address = await credentialBridgeSetup.promise
    assertCurrentAccountGeneration(generation)
    return address
  }
  const manager = accountController
  if (manager === undefined) throw new RuntimeControlError('not-started', 'Account services are not ready')

  const epoch = ++credentialBridgeEpoch
  const bridge = new DesktopCredentialBridge(manager)
  const setup = {
    bridge,
    promise: bridge.listen().then(address => {
      if (epoch !== credentialBridgeEpoch || !currentAccountGeneration(generation)) {
        void bridge.close()
        throw new RuntimeControlError('stale-account-generation', 'The active desktop account changed')
      }
      credentialBridge = bridge
      credentialBridgeAddress = address
      return address
    }).finally(() => {
      if (credentialBridgeSetup === setup) credentialBridgeSetup = undefined
    }),
  }
  credentialBridgeSetup = setup
  return setup.promise
}

async function closeCredentialBridge(): Promise<void> {
  credentialBridgeEpoch += 1
  const active = credentialBridge
  const setup = credentialBridgeSetup
  credentialBridge = undefined
  credentialBridgeAddress = undefined
  credentialBridgeSetup = undefined
  const closing = [
    active?.close(),
    setup?.bridge.close(),
  ].filter((operation): operation is Promise<void> => operation !== undefined)
  await Promise.allSettled(closing)
  await setup?.promise.catch(() => undefined)
}

async function activateAccountProvider(
  account: DesktopAccountData,
  generation: number,
): Promise<DshConnectionInfo> {
  const owner = requireLifecycle()
  const controller = accountController
  if (controller === undefined) throw new RuntimeControlError('not-started', 'Account services are not ready')
  assertCurrentAccountGeneration(generation)
  const state = accountStateStore.getSnapshot()
  const activeAccount = state.status === 'signedIn'
    ? state.account
    : state.status === 'unavailable'
      ? state.account
      : null
  if (activeAccount?.user.id !== account.user.id) {
    throw new RuntimeControlError('stale-account-generation', 'The active desktop account changed')
  }

  await ensureCredentialBridge(generation)
  assertCurrentAccountGeneration(generation)
  const model = modelConfiguration()
  let models: CheapAiModelProfile[]
  try {
    models = await discoverCheapAiModels({
      ...model,
      getKey: async () => (await controller.getKey()).key,
      signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
    })
  } catch (cause) {
    if (cause instanceof DesktopAccountApiError && cause.problem === 'noModels') {
      await stopDshRuntime().catch(() => undefined)
    }
    throw cause
  }
  assertCurrentAccountGeneration(generation)

  const profile = createCheapAiProviderProfile({ ...model, models })
  const connection = owner.status.state === 'ready' && owner.connectionInfo !== undefined
    ? owner.connectionInfo
    : await owner.start()
  assertCurrentAccountGeneration(generation)
  const runtimeGeneration = owner.status.generation
  await ensureDshTransport(connection, runtimeGeneration)
  assertCurrentAccountGeneration(generation)
  await callDshRemote(connection, 'settings', 'update', {
    ns: DSH_SETTINGS_NAMESPACE,
    patch: profile,
  })
  assertCurrentAccountGeneration(generation)
  return connection
}

async function startDevelopmentKeyRuntime(): Promise<DshConnectionInfo> {
  if (!developmentKeyModeEnabled()
    || accountStateStore.getSnapshot().status !== 'signedOut'
    || privateConfiguration?.apiKey == null) {
    throw new RuntimeControlError('account-required', 'Sign in to start CheapAI')
  }
  const owner = requireLifecycle()
  const connection = await owner.start()
  const generation = owner.status.generation
  await ensureDshTransport(connection, generation)
  await applyLatestConfiguration(connection)
  return connection
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
      const baseHome = requiredAbsolutePath(
        process.env.SUB2API_DSH_HOME,
        join(homedir(), '.cheapai.dev', 'dsh'),
        'DSH base home',
      )
      const homeScope: DshAccountHomeScope = event.source === 'development' ? 'development' : 'production'
      accountHomeBase = baseHome
      lifecycle = createLifecycle()
      const client = new DesktopAccountClient({
        baseUrl: process.env.SUB2API_DESKTOP_API_BASE_URL ?? 'https://cheapai.dev',
      })
      const sessions = new DesktopSessionManager({
        getKey: (session, options) => client.getKey(session, options),
      })
      const binding = new DesktopDshAccountBinding({
        state: accountStateStore,
        lifecycle,
        baseHome,
        scope: homeScope,
        beforeChange: async () => {
          await closeCredentialBridge()
          await disposeDshTransport()
        },
      })
      accountController = new DesktopAccountController({
        client,
        sessions,
        state: accountStateStore,
        binding,
        activateProvider: activateAccountProvider,
        stopRuntime: stopDshRuntime,
      })
    },
    start: async () => {
      const controller = accountController
      if (controller === undefined) throw new RuntimeControlError('not-started', 'Account services are not ready')
      const state = accountStateStore.getSnapshot()
      if (state.status === 'signedIn' || (state.status === 'unavailable' && state.account !== null)) {
        return controller.start()
      }
      return startDevelopmentKeyRuntime()
    },
    stop: async () => {
      await stopDshRuntime()
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
      if (normalized.apiKey !== null && !developmentKeyModeEnabled()) {
        throw new RuntimeControlError('development-key-mode-required', 'Static provider credentials are disabled')
      }
      const accountState = accountStateStore.getSnapshot()
      if (normalized.apiKey !== null
        && (accountState.status === 'signedIn'
          || (accountState.status === 'unavailable' && accountState.account !== null))) {
        throw new RuntimeControlError('account-mode-active', 'Use the signed-in account for CheapAI')
      }
      if (!developmentKeyModeEnabled()) return { applied: false }
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
    account: request => {
      if (accountController === undefined) {
        throw new RuntimeControlError('not-started', 'Account services are not ready')
      }
      return accountController.handle(request)
    },
    onAccountState: listener => accountStateStore.subscribe(listener),
    transport: (operation, payload, publish) => dispatchDshTransport(operation, payload, publish),
  })
  control = runtimeControl
  runtimeControl.start()

  let shutdownPromise: Promise<void> | undefined
  const onShutdown = (): void => {
    if (shutdownPromise !== undefined) return
    runtimeShuttingDown = true
    runtimeControl.close()
    accountController?.shutdown()
    process.stdin.pause()
    process.off('SIGINT', onShutdown)
    process.off('SIGTERM', onShutdown)
    process.stdin.off('end', onShutdown)
    shutdownPromise = stopDshRuntime().catch(() => {})
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
