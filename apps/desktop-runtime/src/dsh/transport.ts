/** Runtime-owned authenticated carrier into the pinned DSH Client Gateway. */

import { Context } from '@deepseek-ai/cordis'
import { apply as installGatewayClient } from '@deepseek-ai/dsh-api-gateway/client'
import {
  installConnection,
  type ConnectionHandle,
  type RpcFetch,
} from '@deepseek-ai/dsh-client-connection/client'
import { apply as installTypertClient } from '@deepseek-ai/dsh-typert-registry/client'
import WebSocket from 'ws'
import type { DshConnectionInfo } from './connection-info.ts'
import { RuntimeControlError } from '../host/control.ts'
import type { DshRuntimeStreamEvent, DshTransportOperation } from '../host/protocol.ts'

const PINNED_GATEWAY_OPEN_SEAM = 'ClientRemoteService.openRemoteStream(endpoint,payload,signal,uplink)'
const DEFAULT_CALL_TIMEOUT_MS = 60_000
const MAX_ACTIVE_STREAMS = 64
const MAX_COMPLETED_STREAM_IDS = 256
const MAX_UPLINK_QUEUE_ITEMS = 128

const SESSION_UNARY_METHODS = new Set([
  'list', 'search', 'create', 'rename', 'fork', 'selectModel', 'modelCatalog',
  'canOpenWorkspacePath', 'prompt', 'attachment', 'updateQueue', 'cancel',
  'page', 'projections',
])
const SESSION_STREAM_METHODS = new Set(['follow', 'control'])
const WORKSPACE_UNARY_METHODS = new Set([
  'create', 'initializeDefault', 'rename', 'delete', 'insertBefore',
  'insertSessionBefore', 'archiveSession', 'unarchiveSession', 'pinSession', 'unpinSession',
])
const WORKSPACE_STREAM_METHODS = new Set(['follow'])
const WORKSPACE_FILES_UNARY_METHODS = new Set(['list', 'stat'])
const WORKSPACE_FILES_STREAM_METHODS = new Set(['changes'])

/** Decoded DSH RPC carrier exposed only on Runtime's private host pipe. */
export interface DshRuntimeTransport {
  /** Dispatch one native-originated carrier operation for this DSH generation. */
  handle(
    operation: DshTransportOperation,
    payload: unknown,
    publish: (event: DshRuntimeStreamEvent) => void,
  ): Promise<unknown>
  /** Cancel every active call/stream, dispose the official Gateway, and restore Runtime globals. */
  dispose(): Promise<void>
}

/**
 * Install one Runtime-owned DSH Client Connection and Gateway. Its private
 * WebSocket/client globals are scoped to this instance and never leave Runtime.
 */
export async function createDshRuntimeTransport(
  connection: DshConnectionInfo,
  generation: number,
  options: { readonly callTimeoutMs?: number } = {},
): Promise<DshRuntimeTransport> {
  validateConnectionInfo(connection)
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new TypeError('DSH Runtime generation is invalid')
  }
  const callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
  if (!Number.isSafeInteger(callTimeoutMs) || callTimeoutMs < 1 || callTimeoutMs > 300_000) {
    throw new TypeError('DSH Runtime call timeout is invalid')
  }

  const runtime = new DshRuntimeTransportOwner(connection, generation, callTimeoutMs)
  await runtime.initialize()
  return runtime
}

interface ParsedCallRequest {
  readonly generation: number
  readonly requestId: string
  readonly channel: string
  readonly endpoint: string
  readonly payload: unknown
}

interface ParsedStreamOpenRequest {
  readonly generation: number
  readonly streamId: string
  readonly channel: string
  readonly endpoint: string
  readonly payload: unknown
}

interface ParsedStreamRequest {
  readonly generation: number
  readonly streamId: string
}

interface ActiveStream extends ParsedStreamRequest {
  readonly controller: AbortController
  readonly uplink: RuntimeUplink
  readonly publish: (event: DshRuntimeStreamEvent) => void
  task: Promise<void> | undefined
  sequence: number
}

class DshRuntimeTransportOwner implements DshRuntimeTransport {
  private readonly context = new Context()
  private readonly lifetime = new AbortController()
  private readonly activeStreams = new Map<string, ActiveStream>()
  private readonly completedStreamIds = new Map<string, true>()
  private restoreGlobals: (() => void) | undefined
  private gatewayDispose: (() => Promise<void>) | undefined
  private gatewayRemote: object | undefined
  private rpc: ConnectionHandle['rpc'] | undefined
  private openRemoteStream: GatewayRemoteStreamOpen | undefined
  private disposePromise: Promise<void> | undefined
  private disposed = false

  constructor(
    private readonly connectionInfo: DshConnectionInfo,
    private readonly generation: number,
    private readonly callTimeoutMs: number,
  ) {}

  async initialize(): Promise<void> {
    this.restoreGlobals = installGatewayGlobalsLease(this.connectionInfo)
    try {
      installConnection(this.context, {
        transport: {
          fetch: createAuthenticatedFetch(this.connectionInfo),
          ownsHost: true,
        },
      })
      installTypertClient(this.context)

      const connection = this.context.get('connection') as ConnectionHandle | undefined
      if (connection === undefined) throw new Error('DSH Connection hook did not provide its service')
      this.rpc = connection.rpc

      // This Runtime Gateway is a stream backend only. The renderer's Gateway
      // owns `$events`, so this Context must not start a second event consumer.
      connection.start = () => ({ stop: () => {} })
      const gatewayFiber = this.context.plugin({
        name: 'desktop-runtime-dsh-gateway-client',
        apply: (ctx) => {
          installGatewayClient(ctx)
          this.gatewayRemote = ctx.get('remote') as object | undefined
        },
      })
      try {
        await gatewayFiber
      } catch (cause) {
        await gatewayFiber.dispose()
        throw cause
      }
      this.gatewayDispose = () => gatewayFiber.dispose()

      const remote = this.gatewayRemote
      if (remote === undefined) throw incompatibleGateway()
      this.openRemoteStream = resolveGatewayRemoteStreamOpen(remote)
    } catch (cause) {
      await this.dispose()
      if (cause instanceof RuntimeControlError) throw cause
      throw incompatibleGateway()
    }
  }

  async handle(
    operation: DshTransportOperation,
    payload: unknown,
    publish: (event: DshRuntimeStreamEvent) => void,
  ): Promise<unknown> {
    this.assertActive()
    switch (operation) {
      case 'call':
        return this.call(parseCallRequest(payload, this.generation))
      case 'open':
        return this.open(parseStreamOpenRequest(payload, this.generation), publish)
      case 'uplink': {
        const request = parseStreamRequest(payload, this.generation)
        const stream = this.activeStreams.get(request.streamId)
        if (stream === undefined) {
          if (this.completedStreamIds.has(request.streamId)) {
            throw new RuntimeControlError('stream-closed', 'DSH stream has already ended')
          }
          throw new RuntimeControlError('stream-not-found', 'DSH stream is not open')
        }
        if (!Object.hasOwn(payload as object, 'value')) {
          throw new RuntimeControlError('invalid-request', 'DSH uplink item is missing its value')
        }
        try {
          stream.uplink.push(Reflect.get(payload as object, 'value'))
        } catch {
          throw new RuntimeControlError('stream-closed', 'DSH stream no longer accepts uplink items')
        }
        return { generation: this.generation, streamId: stream.streamId }
      }
      case 'end': {
        const request = parseStreamRequest(payload, this.generation)
        this.activeStreams.get(request.streamId)?.uplink.end()
        return { generation: this.generation, streamId: request.streamId }
      }
      case 'cancel': {
        const request = parseStreamRequest(payload, this.generation)
        const stream = this.activeStreams.get(request.streamId)
        stream?.uplink.close()
        stream?.controller.abort(new Error('DSH stream cancelled by its Client'))
        if (stream === undefined && !this.completedStreamIds.has(request.streamId)) {
          throw new RuntimeControlError('stream-not-found', 'DSH stream is not open')
        }
        return { generation: this.generation, streamId: request.streamId }
      }
    }
  }

  dispose(): Promise<void> {
    if (this.disposePromise !== undefined) return this.disposePromise
    this.disposed = true
    this.disposePromise = this.disposeOwnedResources()
    return this.disposePromise
  }

  private async call(request: ParsedCallRequest): Promise<unknown> {
    this.assertTarget(request.channel, request.endpoint, 'call')
    const rpc = this.rpc
    if (rpc === undefined) throw incompatibleGateway()
    const deadline = AbortSignal.timeout(this.callTimeoutMs)
    const signal = AbortSignal.any([this.lifetime.signal, deadline])
    try {
      const value = await rpc.call(request.channel, request.endpoint, request.payload, signal)
      signal.throwIfAborted()
      return {
        generation: this.generation,
        requestId: request.requestId,
        value: redactPrivateValues(value, this.connectionInfo),
      }
    } catch (cause) {
      if (signal.aborted && !this.lifetime.signal.aborted) {
        throw new RuntimeControlError('deadline-exceeded', 'DSH RPC call exceeded its Runtime deadline')
      }
      throw cause
    }
  }

  private open(
    request: ParsedStreamOpenRequest,
    publish: (event: DshRuntimeStreamEvent) => void,
  ): unknown {
    this.assertTarget(request.channel, request.endpoint, 'open')
    if (this.activeStreams.has(request.streamId) || this.completedStreamIds.has(request.streamId)) {
      throw new RuntimeControlError('duplicate-stream', 'DSH stream id is already in use')
    }
    if (this.activeStreams.size >= MAX_ACTIVE_STREAMS) {
      throw new RuntimeControlError('too-many-streams', 'DSH Runtime has reached its active stream limit')
    }

    const openRemoteStream = this.openRemoteStream
    if (openRemoteStream === undefined) throw incompatibleGateway()
    const stream: ActiveStream = {
      generation: this.generation,
      streamId: request.streamId,
      controller: new AbortController(),
      uplink: new RuntimeUplink(request.endpoint),
      publish,
      task: undefined,
      sequence: 0,
    }
    const signal = AbortSignal.any([this.lifetime.signal, stream.controller.signal])
    let source: AsyncIterable<unknown>
    try {
      source = openRemoteStream(request.endpoint, request.payload, signal, stream.uplink)
    } catch (cause) {
      stream.uplink.close()
      throw cause
    }
    this.activeStreams.set(request.streamId, stream)
    stream.task = this.consumeStream(stream, source)
    return { generation: this.generation, streamId: request.streamId }
  }

  private async consumeStream(stream: ActiveStream, source: AsyncIterable<unknown>): Promise<void> {
    let failed: unknown
    try {
      for await (const value of source) {
        if (this.disposed || stream.controller.signal.aborted) break
        this.publishStream(stream, {
          generation: this.generation,
          streamId: stream.streamId,
          sequence: this.takeSequence(stream),
          value: redactPrivateValues(value, this.connectionInfo),
        })
      }
    } catch (cause) {
      if (!this.disposed && !stream.controller.signal.aborted && !this.lifetime.signal.aborted) failed = cause
    } finally {
      stream.uplink.close()
      if (!this.disposed) {
        if (failed === undefined) {
          this.publishStream(stream, {
            generation: this.generation,
            streamId: stream.streamId,
            sequence: this.takeSequence(stream),
            done: true,
          })
        } else {
          this.publishStream(stream, {
            generation: this.generation,
            streamId: stream.streamId,
            sequence: this.takeSequence(stream),
            error: publicStreamError(failed, this.connectionInfo),
          })
        }
      }
      this.activeStreams.delete(stream.streamId)
      this.rememberCompletedStream(stream.streamId)
    }
  }

  private assertTarget(channel: string, endpoint: string, mode: 'call' | 'open'): void {
    if (channel !== '/api') {
      throw new RuntimeControlError('unsupported-channel', 'DSH Runtime only exposes the /api Remote channel')
    }
    const [namespace, method, ...extra] = endpoint.split('/')
    if (extra.length !== 0 || namespace === undefined || method === undefined) {
      if (mode === 'open' && endpoint === '$events') return
      throw new RuntimeControlError('unsupported-endpoint', 'DSH Remote endpoint is not enabled in Desktop Runtime')
    }
    const allowed = namespace === 'session'
      ? (mode === 'call' ? SESSION_UNARY_METHODS : SESSION_STREAM_METHODS)
      : namespace === '$events'
        ? (mode === 'call' ? new Set(['result']) : new Set<string>())
        : namespace === 'workspace'
          ? (mode === 'call' ? WORKSPACE_UNARY_METHODS : WORKSPACE_STREAM_METHODS)
          : namespace === 'workspaceFiles'
            ? (mode === 'call' ? WORKSPACE_FILES_UNARY_METHODS : WORKSPACE_FILES_STREAM_METHODS)
            : namespace === 'userQuestions'
              ? new Set(mode === 'call' ? ['answer'] : ['attachWait'])
              : undefined
    if (!allowed?.has(method)) {
      throw new RuntimeControlError('unsupported-endpoint', 'DSH Remote endpoint is not enabled in Desktop Runtime')
    }
  }

  private publishStream(stream: ActiveStream, event: DshRuntimeStreamEvent): void {
    try {
      stream.publish(event)
    } catch {
      stream.uplink.close()
      stream.controller.abort(new Error('Runtime could not publish a DSH stream frame'))
    }
  }

  private takeSequence(stream: ActiveStream): number {
    const sequence = stream.sequence
    if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence === Number.MAX_SAFE_INTEGER) {
      stream.controller.abort(new Error('DSH stream sequence was exhausted'))
      throw new RuntimeControlError('stream-sequence-exhausted', 'DSH stream sequence was exhausted')
    }
    stream.sequence++
    return sequence
  }

  private rememberCompletedStream(streamId: string): void {
    this.completedStreamIds.delete(streamId)
    this.completedStreamIds.set(streamId, true)
    while (this.completedStreamIds.size > MAX_COMPLETED_STREAM_IDS) {
      const oldest = this.completedStreamIds.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.completedStreamIds.delete(oldest)
    }
  }

  private assertActive(): void {
    if (this.disposed) throw new RuntimeControlError('stopped', 'DSH Runtime transport is stopped')
  }

  private async disposeOwnedResources(): Promise<void> {
    this.lifetime.abort(new Error('DSH Runtime transport is stopping'))
    const streams = [...this.activeStreams.values()]
    for (const stream of streams) {
      stream.uplink.close()
      stream.controller.abort(new Error('DSH Runtime transport is stopping'))
    }
    await Promise.allSettled(streams.map(stream => stream.task).filter(isPromise))
    try {
      await this.gatewayDispose?.()
    } finally {
      this.restoreGlobals?.()
      this.restoreGlobals = undefined
      this.activeStreams.clear()
      this.completedStreamIds.clear()
    }
  }
}

type GatewayRemoteStreamOpen = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
  uplink?: AsyncIterable<unknown>,
) => AsyncIterable<unknown>

/** Version check around the single pinned DSH-private gateway seam. */
function resolveGatewayRemoteStreamOpen(remote: object): GatewayRemoteStreamOpen {
  const prototype = Object.getPrototypeOf(remote) as object | null
  const candidate = prototype === null ? undefined : Reflect.get(prototype, 'openRemoteStream') as unknown
  if (typeof candidate !== 'function' || candidate.length !== 4) throw incompatibleGateway()
  return (endpoint, payload, signal, uplink) =>
    Reflect.apply(candidate, remote, [endpoint, payload, signal, uplink]) as AsyncIterable<unknown>
}

/** Construct the official Connection's relative-fetch carrier with Runtime-held auth. */
function createAuthenticatedFetch(connection: DshConnectionInfo): RpcFetch {
  const fetcher = globalThis.fetch.bind(globalThis)
  return async (input, init) => {
    const route = typeof input === 'string' ? input : input.href
    if (route.length === 0
      || route.startsWith('/')
      || route.startsWith('//')
      || /^[a-z][a-z\d+.-]*:/iu.test(route)
      || route.includes('?')
      || route.includes('#')) {
      throw new RuntimeControlError('unsafe-route', 'DSH Connection rejected a non-relative RPC route')
    }
    const target = new URL(route, connection.httpBaseUrl)
    if (target.origin !== connection.origin
      || target.protocol !== 'http:'
      || target.pathname !== `/${route}`
      || !target.pathname.startsWith('/api/')) {
      throw new RuntimeControlError('unsafe-route', 'DSH Connection route escaped its verified loopback origin')
    }
    const headers = new Headers(init.headers)
    headers.set('cookie', connection.auth.cookie)
    headers.set('origin', connection.origin)
    return fetcher(target, {
      ...init,
      headers,
      credentials: 'omit',
      redirect: 'manual',
    })
  }
}

/** Install only the global hooks read by the pinned official Gateway mux. */
let activeGatewayGlobalsOwner: object | undefined

function installGatewayGlobalsLease(connection: DshConnectionInfo): () => void {
  if (activeGatewayGlobalsOwner !== undefined) {
    throw new RuntimeControlError('transport-in-use', 'A DSH Runtime Gateway transport is already active')
  }
  const owner = {}
  activeGatewayGlobalsOwner = owner
  const previousTransport = Object.getOwnPropertyDescriptor(globalThis, '__DSH_TRANSPORT__')
  const previousWebSocket = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket')
  const priorValue = previousTransport?.value
  const transportValue = {
    ...(isRecord(priorValue) ? priorValue : {}),
    streamBaseUrl: connection.streamBaseUrl,
  }
  class RuntimeAuthenticatedWebSocket extends WebSocket {
    constructor(address: string | URL) {
      const target = new URL(address)
      if (target.href !== `${connection.streamBaseUrl}api/remote.mux`
        || target.protocol !== 'ws:'
        || target.hostname !== '127.0.0.1'
        || target.port !== String(connection.port)) {
        throw new RuntimeControlError('unsafe-stream-route', 'DSH Gateway rejected a non-loopback stream route')
      }
      super(target, {
        headers: {
          Cookie: connection.auth.cookie,
          Origin: connection.origin,
        },
      })
    }
  }

  try {
    Object.defineProperty(globalThis, '__DSH_TRANSPORT__', {
      configurable: true,
      enumerable: previousTransport?.enumerable ?? false,
      writable: true,
      value: transportValue,
    })
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      enumerable: previousWebSocket?.enumerable ?? false,
      writable: true,
      value: RuntimeAuthenticatedWebSocket,
    })
  } catch {
    restoreProperty('__DSH_TRANSPORT__', previousTransport)
    restoreProperty('WebSocket', previousWebSocket)
    activeGatewayGlobalsOwner = undefined
    throw new RuntimeControlError('transport-unavailable', 'DSH Gateway Runtime hooks could not be installed')
  }

  return () => {
    if (activeGatewayGlobalsOwner !== owner) return
    if (Reflect.get(globalThis, '__DSH_TRANSPORT__') === transportValue) {
      restoreProperty('__DSH_TRANSPORT__', previousTransport)
    }
    if (Object.getOwnPropertyDescriptor(globalThis, 'WebSocket')?.value === RuntimeAuthenticatedWebSocket) {
      restoreProperty('WebSocket', previousWebSocket)
    }
    activeGatewayGlobalsOwner = undefined
  }
}

function restoreProperty(name: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor === undefined) Reflect.deleteProperty(globalThis, name)
  else Object.defineProperty(globalThis, name, descriptor)
}

function validateConnectionInfo(connection: DshConnectionInfo): void {
  const origin = `http://127.0.0.1:${String(connection.port)}`
  const streamBase = `ws://127.0.0.1:${String(connection.port)}/`
  if (!Number.isInteger(connection.port)
    || connection.port < 1
    || connection.port > 65_535
    || connection.origin !== origin
    || connection.httpBaseUrl !== `${origin}/`
    || connection.streamBaseUrl !== streamBase
    || connection.auth?.type !== 'dsh-browser-cookie'
    || typeof connection.auth.cookie !== 'string'
    || !/^dsh-auth-[A-Za-z0-9_-]+=[A-Za-z0-9_-]+$/u.test(connection.auth.cookie)) {
    throw new RuntimeControlError('invalid-connection', 'DSH connection did not match the verified loopback profile')
  }
}

function parseCallRequest(value: unknown, generation: number): ParsedCallRequest {
  const record = parseTransportPayload(value, ['generation', 'requestId', 'channel', 'endpoint', 'payload'])
  return {
    generation: requestGeneration(record.generation, generation),
    requestId: requestId(record.requestId),
    channel: requestString(record.channel, 'channel'),
    endpoint: requestString(record.endpoint, 'endpoint'),
    payload: record.payload,
  }
}

function parseStreamOpenRequest(value: unknown, generation: number): ParsedStreamOpenRequest {
  const record = parseTransportPayload(value, ['generation', 'streamId', 'channel', 'endpoint', 'payload'])
  return {
    generation: requestGeneration(record.generation, generation),
    streamId: requestId(record.streamId),
    channel: requestString(record.channel, 'channel'),
    endpoint: requestString(record.endpoint, 'endpoint'),
    payload: record.payload,
  }
}

function parseStreamRequest(value: unknown, generation: number): ParsedStreamRequest {
  const record = parseTransportPayload(value, ['generation', 'streamId'], ['value'])
  return {
    generation: requestGeneration(record.generation, generation),
    streamId: requestId(record.streamId),
  }
}

function parseTransportPayload(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!isRecord(value)) throw new RuntimeControlError('invalid-request', 'DSH transport payload is invalid')
  const keys = Reflect.ownKeys(value)
  if (!required.every(key => Object.hasOwn(value, key))
    || keys.some(key => typeof key !== 'string' || (!required.includes(key) && !optional.includes(key)))) {
    throw new RuntimeControlError('invalid-request', 'DSH transport payload fields are invalid')
  }
  return value
}

function requestGeneration(value: unknown, expected: number): number {
  if (!Number.isSafeInteger(value) || value !== expected) {
    throw new RuntimeControlError('stale-generation', 'DSH transport request belongs to another Runtime generation')
  }
  return expected
}

function requestId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw new RuntimeControlError('invalid-request', 'DSH transport request id is invalid')
  }
  return value
}

function requestString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    throw new RuntimeControlError('invalid-request', `DSH transport ${name} is invalid`)
  }
  return value
}

class RuntimeUplink implements AsyncIterable<unknown>, AsyncIterator<unknown> {
  private readonly values: unknown[] = []
  private waiter: ((value: IteratorResult<unknown>) => void) | undefined
  private ended = false
  private closed = false

  constructor(private readonly endpoint: string) {}

  push(value: unknown): void {
    if (this.closed || this.ended) throw new Error('Uplink is closed')
    if (this.values.length >= MAX_UPLINK_QUEUE_ITEMS) throw new Error('Uplink queue is full')
    const waiter = this.waiter
    if (waiter !== undefined) {
      this.waiter = undefined
      waiter({ value, done: false })
      return
    }
    this.values.push(value)
  }

  end(): void {
    if (this.ended || this.closed) return
    this.ended = true
    if (this.values.length === 0) this.resolveDone()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.values.length = 0
    this.resolveDone()
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return this
  }

  next(): Promise<IteratorResult<unknown>> {
    if (this.closed || (this.ended && this.values.length === 0)) {
      return Promise.resolve({ value: undefined, done: true })
    }
    if (this.values.length > 0) {
      return Promise.resolve({ value: this.values.shift(), done: false })
    }
    if (this.waiter !== undefined) {
      return Promise.reject(new Error(`DSH uplink ${this.endpoint} has a pending read`))
    }
    return new Promise(resolve => { this.waiter = resolve })
  }

  return(): Promise<IteratorResult<unknown>> {
    this.close()
    return Promise.resolve({ value: undefined, done: true })
  }

  private resolveDone(): void {
    const waiter = this.waiter
    this.waiter = undefined
    waiter?.({ value: undefined, done: true })
  }
}

function publicStreamError(cause: unknown, connection: DshConnectionInfo): { code: string; message: string } {
  const record = typeof cause === 'object' && cause !== null ? cause as { code?: unknown; message?: unknown } : undefined
  const code = typeof record?.code === 'string' && record.code.length <= 128
    ? record.code
    : 'dsh-stream-failed'
  const rawMessage = typeof record?.message === 'string'
    ? record.message
    : 'DSH stream failed'
  return { code, message: redactPrivateText(rawMessage, connection).slice(0, 2_048) }
}

function redactPrivateValues(value: unknown, connection: DshConnectionInfo, seen = new WeakMap<object, unknown>()): unknown {
  if (typeof value === 'string') return redactPrivateText(value, connection)
  if (typeof value !== 'object' || value === null || value instanceof Uint8Array) return value
  const previous = seen.get(value)
  if (previous !== undefined) return previous
  if (Array.isArray(value)) {
    const copy: unknown[] = []
    seen.set(value, copy)
    for (const item of value) copy.push(redactPrivateValues(item, connection, seen))
    return copy
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return value
  const copy: Record<string, unknown> = Object.create(prototype) as Record<string, unknown>
  seen.set(value, copy)
  for (const [key, item] of Object.entries(value)) {
    copy[key] = redactPrivateValues(item, connection, seen)
  }
  return copy
}

function redactPrivateText(text: string, connection: DshConnectionInfo): string {
  return [connection.auth.cookie, connection.origin, connection.httpBaseUrl, connection.streamBaseUrl]
    .reduce((safe, secret) => secret.length === 0 ? safe : safe.replaceAll(secret, '[redacted DSH transport]'), text)
}

function incompatibleGateway(): RuntimeControlError {
  return new RuntimeControlError(
    'dsh-gateway-incompatible',
    `Pinned DSH Gateway does not expose the expected ${PINNED_GATEWAY_OPEN_SEAM}`,
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPromise(value: unknown): value is Promise<unknown> {
  return typeof value === 'object' && value !== null && 'then' in value
}
