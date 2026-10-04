import { createInterface, type Interface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import type {
  DesktopAccountData,
  DesktopAccountProblem,
  DesktopHostAccountRequest,
  DesktopHostAccountResult,
  DesktopPublicAccountState,
  HostStartupEvent,
} from '@sub2api/desktop-contracts'
import { DesktopAccountApiError } from '../cheapai/account-client.ts'
import type { DshConnectionInfo } from '../dsh/connection-info.ts'
import type { DshLifecycleSnapshot } from '../dsh/lifecycle.ts'
import {
  isDshTransportOperation,
  parseHostRuntimeMessage,
  type CheapAiPrivateConfiguration,
  type DshRuntimeStreamEvent,
  type DshTransportOperation,
  type HostCommandMessage,
  type HostRuntimeMessage,
  type RuntimeCommandResult,
  type RuntimeToHostMessage,
} from './protocol.ts'

export interface RuntimeControlActions {
  onStartup?: (event: HostStartupEvent) => Promise<void> | void
  start: () => Promise<DshConnectionInfo>
  stop: () => Promise<void>
  status: () => DshLifecycleSnapshot
  configure: (configuration: CheapAiPrivateConfiguration) => Promise<{ applied: boolean }>
  account?: (request: DesktopHostAccountRequest) => Promise<DesktopHostAccountResult>
  onAccountState?: (listener: (state: DesktopPublicAccountState) => void) => () => void
  transport?: (
    operation: DshTransportOperation,
    payload: unknown,
    publish: (event: DshRuntimeStreamEvent) => void,
  ) => Promise<unknown>
}

export interface RuntimeControlOptions {
  readonly input: Readable
  readonly output: Writable
  readonly diagnostic?: (message: string) => void
}

export class RuntimeControlError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'RuntimeControlError'
  }
}

/** One private JSON-lines request/response channel; ordinary logs use stderr. */
export class RuntimeControlChannel {
  private reader: Interface | undefined
  private unsubscribeAccountState: (() => void) | undefined
  private startup?: HostStartupEvent
  private startupPromise: Promise<void> = Promise.resolve()
  private startupFailure?: RuntimeControlError
  private outputQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly options: RuntimeControlOptions,
    private readonly actions: RuntimeControlActions,
  ) {}

  start(): void {
    if (this.reader !== undefined) throw new Error('Runtime control channel is already started')
    this.reader = createInterface({ input: this.options.input, crlfDelay: Infinity })
    this.reader.on('line', line => this.acceptLine(line))
    if (this.actions.onAccountState !== undefined) {
      this.unsubscribeAccountState = this.actions.onAccountState(state => this.publishAccountState(state))
    }
  }

  close(): void {
    this.reader?.close()
    this.reader = undefined
    this.unsubscribeAccountState?.()
    this.unsubscribeAccountState = undefined
  }

  /** Status events go only to the native parent process over this private pipe. */
  publishStatus(status: DshLifecycleSnapshot): void {
    this.enqueueWrite({ type: 'runtime.event', event: 'status', status })
  }

  /** Decoded DSH values cross only the private pipe to the native Runtime owner. */
  publishDshStream(event: DshRuntimeStreamEvent): void {
    this.enqueueWrite({ type: 'runtime.event', event: 'dsh.stream', ...event })
  }

  /** Only an explicit allowlist of account and balance fields reaches the host. */
  publishAccountState(state: DesktopPublicAccountState): void {
    this.enqueueWrite({
      type: 'runtime.event',
      event: 'account-state',
      state: projectPublicAccountState(state),
    })
  }

  private acceptLine(line: string): void {
    let message: ReturnType<typeof parseHostRuntimeMessage>
    try {
      message = parseHostRuntimeMessage(JSON.parse(line) as unknown)
    } catch {
      this.diagnostic('Ignored an invalid Runtime control message')
      return
    }

    if (message.type === 'host.startup') {
      this.acceptStartup(message)
      return
    }
    void this.dispatch(message)
  }

  private acceptStartup(message: Extract<HostRuntimeMessage, { type: 'host.startup' }>): void {
    if (this.startup !== undefined) {
      this.diagnostic('Ignored a duplicate Runtime startup message')
      return
    }
    this.startup = message
    this.startupPromise = Promise.resolve().then(() => this.actions.onStartup?.(message)).then(() => {
      this.enqueueWrite({
        type: 'runtime.event',
        event: 'bootstrapped',
        source: message.source,
        runtime: message.runtime,
      })
    }).catch(() => {
      this.startupFailure = new RuntimeControlError('startup-failed', 'Runtime could not accept the host startup configuration')
      this.enqueueWrite({
        type: 'runtime.event',
        event: 'startup-failed',
        error: { code: this.startupFailure.code, message: this.startupFailure.message },
      })
    })
  }

  private async dispatch(message: Exclude<HostRuntimeMessage, HostStartupEvent>): Promise<void> {
    const id = message.id
    try {
      if (this.startup === undefined) {
        throw new RuntimeControlError('not-started', 'Runtime has not received its host startup event')
      }
      await this.startupPromise
      if (this.startupFailure !== undefined) throw this.startupFailure

      let result: RuntimeCommandResult
      if (message.type === 'host.configure') {
        const configured = await this.actions.configure(message.configuration)
        result = { kind: 'configured', applied: configured.applied }
      } else {
        result = await this.dispatchCommand(message)
      }
      this.enqueueWrite({ type: 'runtime.response', id, ok: true, result })
    } catch (cause) {
      const error = controlError(cause)
      this.enqueueWrite({
        type: 'runtime.response',
        id,
        ok: false,
        error: { code: error.code, message: error.message },
      })
    }
  }

  private async dispatchCommand(message: HostCommandMessage): Promise<RuntimeCommandResult> {
    switch (message.command) {
      case 'start': {
        const connection = await this.actions.start()
        return { kind: 'started', status: this.actions.status(), connection }
      }
      case 'stop':
        await this.actions.stop()
        return { kind: 'stopped', status: this.actions.status() }
      case 'status':
        return { kind: 'status', status: this.actions.status() }
      case 'account': {
        if (this.actions.account === undefined) {
          throw new RuntimeControlError('unsupported', 'Account commands are not enabled in this Runtime')
        }
        // parseHostRuntimeMessage validates and allowlists each operation payload.
        const request = {
          operation: message.operation,
          payload: message.payload,
        } as DesktopHostAccountRequest
        const value = await this.actions.account(request)
        if (value.operation !== request.operation) {
          throw new RuntimeControlError('runtime-error', 'Account command failed')
        }
        return { kind: 'account', value }
      }
      case 'transport': {
        if (this.actions.transport === undefined || !isDshTransportOperation(message.operation)) {
          throw new RuntimeControlError('unsupported', 'DSH transport commands are not enabled in this Runtime')
        }
        const value = await this.actions.transport(
          message.operation,
          message.payload,
          event => this.publishDshStream(event),
        )
        return { kind: 'transport', value }
      }
    }
  }

  private enqueueWrite(message: RuntimeToHostMessage): void {
    const line = `${JSON.stringify(message)}\n`
    this.outputQueue = this.outputQueue.then(() => writeLine(this.options.output, line)).catch(() => {
      this.diagnostic('Runtime control response could not be written to the host pipe')
    })
  }

  private diagnostic(message: string): void {
    try {
      this.options.diagnostic?.(message)
    } catch {
      // Diagnostic sinks are not part of the control protocol.
    }
  }
}

function writeLine(output: Writable, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    output.write(line, error => {
      if (error !== undefined && error !== null) reject(error)
      else resolve()
    })
  })
}

function controlError(cause: unknown): RuntimeControlError {
  if (cause instanceof RuntimeControlError) return cause
  if (cause instanceof DesktopAccountApiError) {
    return new RuntimeControlError(cause.problem, accountProblemMessage(cause.problem))
  }
  if (cause instanceof Error && cause.name === 'DshLifecycleError' && 'code' in cause) {
    const code = Reflect.get(cause, 'code')
    if (typeof code === 'string') return new RuntimeControlError(code, cause.message)
  }
  return new RuntimeControlError('runtime-error', 'Runtime command failed')
}

function accountProblemMessage(problem: DesktopAccountProblem): string {
  switch (problem) {
    case 'network': return 'Could not reach the CheapAI account service'
    case 'serviceUnavailable': return 'The CheapAI account service is unavailable'
    case 'noModels': return 'No models are available for this account'
    case 'sessionExpired': return 'Sign in to CheapAI again'
    case 'keyRevoked': return 'The account Key is unavailable'
    case 'insufficientBalance': return 'The account has insufficient balance'
    case 'groupUnavailable': return 'The account group is unavailable'
  }
}

function projectPublicAccountState(state: DesktopPublicAccountState): DesktopPublicAccountState {
  switch (state.status) {
    case 'signedOut':
      return { status: 'signedOut' }
    case 'restoring':
      return { status: 'restoring' }
    case 'signedIn':
      return {
        status: 'signedIn',
        account: projectAccount(state.account),
        expiresAt: state.expiresAt,
      }
    case 'unavailable':
      return {
        status: 'unavailable',
        account: state.account === null ? null : projectAccount(state.account),
        expiresAt: state.expiresAt,
        problem: state.problem,
      }
  }
}

function projectAccount(account: DesktopAccountData): DesktopAccountData {
  return {
    user: {
      id: account.user.id,
      email_normalized: account.user.email_normalized,
      role: account.user.role,
      status: account.user.status,
      group_id: account.user.group_id,
      group_status: account.user.group_status,
      balance_units: account.user.balance_units,
      email_verified_at: account.user.email_verified_at,
    },
    balance: {
      currency: 'USD',
      decimals: 8,
      balance_units: account.balance.balance_units,
      balance_usd: account.balance.balance_usd,
    },
  }
}
