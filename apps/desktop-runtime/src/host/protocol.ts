import type {
  DesktopHostAccountRequest,
  DesktopHostAccountResult,
  DesktopPrivateSessionCredential,
  DesktopRuntimeAccountStateEvent,
  HostStartupEvent,
} from '@sub2api/desktop-contracts'
import type { CheapAiApiProtocol } from '../cheapai/provider.ts'
import type { DshConnectionInfo } from '../dsh/connection-info.ts'
import type { DshLifecycleSnapshot } from '../dsh/lifecycle.ts'

/** Private host-to-Runtime model configuration. The API key must stay on this pipe. */
export interface CheapAiPrivateConfiguration {
  readonly baseURL: string
  readonly api: CheapAiApiProtocol
  /** `null` removes the configured credential; the value is never echoed. */
  readonly apiKey: string | null
}

export interface HostConfigurationMessage {
  readonly type: 'host.configure'
  readonly id: string
  readonly configuration: CheapAiPrivateConfiguration
}

export type DshTransportOperation = 'call' | 'open' | 'uplink' | 'end' | 'cancel'

/** One already-decoded DSH stream frame sent over Runtime's private host pipe. */
export type DshRuntimeStreamEvent =
  | {
      readonly generation: number
      readonly streamId: string
      readonly sequence: number
      readonly value: unknown
    }
  | {
      readonly generation: number
      readonly streamId: string
      readonly sequence: number
      readonly error: { readonly code: string; readonly message: string }
    }
  | {
      readonly generation: number
      readonly streamId: string
      readonly sequence: number
      readonly done: true
    }

export type HostCommandName = 'start' | 'stop' | 'status' | 'account' | 'transport'

export type HostCommandMessage =
  | {
      readonly type: 'host.request'
      readonly id: string
      readonly command: 'start' | 'stop' | 'status'
    }
  | ({
      readonly type: 'host.request'
      readonly id: string
      readonly command: 'account'
    } & DesktopHostAccountRequest)
  | {
      readonly type: 'host.request'
      readonly id: string
      readonly command: 'transport'
      readonly operation: DshTransportOperation
      readonly payload: Record<string, unknown>
    }

export type HostRuntimeMessage = HostStartupEvent | HostConfigurationMessage | HostCommandMessage

export type RuntimeCommandResult =
  | { readonly kind: 'started'; readonly status: DshLifecycleSnapshot; readonly connection: DshConnectionInfo }
  | { readonly kind: 'stopped'; readonly status: DshLifecycleSnapshot }
  | { readonly kind: 'status'; readonly status: DshLifecycleSnapshot }
  | { readonly kind: 'configured'; readonly applied: boolean }
  | { readonly kind: 'account'; readonly value: DesktopHostAccountResult }
  | { readonly kind: 'transport'; readonly value: unknown }

export type RuntimeToHostMessage =
  | {
      readonly type: 'runtime.response'
      readonly id: string
      readonly ok: true
      readonly result: RuntimeCommandResult
    }
  | {
      readonly type: 'runtime.response'
      readonly id: string
      readonly ok: false
      readonly error: { readonly code: string; readonly message: string }
    }
  | {
      readonly type: 'runtime.event'
      readonly event: 'bootstrapped'
      readonly source: HostStartupEvent['source']
      readonly runtime: HostStartupEvent['runtime']
    }
  | {
      readonly type: 'runtime.event'
      readonly event: 'startup-failed'
      readonly error: { readonly code: string; readonly message: string }
    }
  | {
      readonly type: 'runtime.event'
      readonly event: 'status'
      readonly status: DshLifecycleSnapshot
    }
  | DesktopRuntimeAccountStateEvent
  | ({ readonly type: 'runtime.event'; readonly event: 'dsh.stream' } & DshRuntimeStreamEvent)

export interface ParsedHostStartupMessage extends HostStartupEvent {
  readonly type: 'host.startup'
}

export type ParsedHostRuntimeMessage = ParsedHostStartupMessage | HostConfigurationMessage | HostCommandMessage

/** Validate the newline-delimited JSON boundary without copying private values into diagnostics. */
export function parseHostRuntimeMessage(value: unknown): ParsedHostRuntimeMessage {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new TypeError('Runtime control message must be an object with a type')
  }

  if (value.type === 'host.startup') {
    if ((value.source !== 'development' && value.source !== 'sidecar')
      || (value.runtime !== 'bun' && value.runtime !== 'node')) {
      throw new TypeError('Runtime startup message has an invalid source or runtime')
    }
    return { type: 'host.startup', source: value.source, runtime: value.runtime }
  }

  if (value.type === 'host.configure') {
    const configuration = value.configuration
    if (!isRecord(configuration)
      || typeof configuration.baseURL !== 'string'
      || typeof configuration.api !== 'string'
      || !isApiProtocol(configuration.api)
      || (configuration.apiKey !== null && typeof configuration.apiKey !== 'string')) {
      throw new TypeError('Runtime configuration message has invalid provider fields')
    }
    return {
      type: 'host.configure',
      id: requestId(value.id),
      configuration: {
        baseURL: configuration.baseURL,
        api: configuration.api,
        apiKey: configuration.apiKey,
      },
    }
  }

  if (value.type === 'host.request') {
    const id = requestId(value.id)
    if (value.command === 'start' || value.command === 'stop' || value.command === 'status') {
      return { type: 'host.request', id, command: value.command }
    }
    if (value.command === 'account') {
      const request = parseDesktopHostAccountRequest(value.operation, value.payload)
      if (request === null) throw new TypeError('Runtime account request has an invalid operation or payload')
      return {
        type: 'host.request',
        id,
        command: 'account',
        ...request,
      }
    }
    if (value.command === 'transport'
      && isDshTransportOperation(value.operation)
      && isRecord(value.payload)) {
      return {
        type: 'host.request',
        id,
        command: 'transport',
        operation: value.operation,
        payload: value.payload,
      }
    }
    throw new TypeError('Runtime request has an unsupported command')
  }

  throw new TypeError('Runtime control message type is unsupported')
}

function parseDesktopHostAccountRequest(
  operation: unknown,
  payload: unknown,
): DesktopHostAccountRequest | null {
  if (!isRecord(payload)) return null
  if (operation === 'login'
    && typeof payload.email === 'string'
    && payload.email.length > 0
    && payload.email.length <= 320
    && typeof payload.password === 'string'
    && payload.password.length <= 256) {
    return { operation, payload: { email: payload.email, password: payload.password } }
  }
  if ((operation === 'restore' || operation === 'getAccount'
    || operation === 'getKey' || operation === 'logout')
    && isPrivateSessionCredential(payload)) {
    return { operation, payload: { token: payload.token, expiresAt: payload.expiresAt } }
  }
  return null
}

function isPrivateSessionCredential(value: Record<string, unknown>): value is Record<string, unknown> & DesktopPrivateSessionCredential {
  return typeof value.token === 'string'
    && value.token.length > 0
    && value.token.length <= 4096
    && value.token.trim() === value.token
    && !/[\u0000-\u001f\u007f]/u.test(value.token)
    && typeof value.expiresAt === 'number'
    && Number.isSafeInteger(value.expiresAt)
    && value.expiresAt >= 0
}

export function isDshTransportOperation(value: unknown): value is DshTransportOperation {
  return value === 'call'
    || value === 'open'
    || value === 'uplink'
    || value === 'end'
    || value === 'cancel'
}

function requestId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw new TypeError('Runtime control request id is invalid')
  }
  return value
}

function isApiProtocol(value: string): value is CheapAiApiProtocol {
  return value === 'openai-completions'
    || value === 'openai-responses'
    || value === 'anthropic-messages'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
