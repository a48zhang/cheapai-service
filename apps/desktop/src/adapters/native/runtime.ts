import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { ClientConnectionRpc, ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection/client'
import type { DshNativeRpc } from '../dsh/connection'

export interface NativeRuntimeStatus {
  readonly activeTaskCount: number
  readonly activityKnown: boolean
  readonly process: 'starting' | 'ready' | 'failed' | 'stopped'
  readonly dsh: {
    readonly state: 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed'
    readonly generation: number
    readonly stage: string | null
    readonly failure: { readonly code: string; readonly stage: string } | null
  }
  readonly connection: { readonly transport: 'tauri-ipc'; readonly generation: number } | null
  readonly problem: { readonly code: string; readonly message: string } | null
}

export interface NativeRuntimeSnapshot {
  readonly mode: 'native' | 'browser'
  readonly status: NativeRuntimeStatus | null
  /** Monotonic UI scope epoch, including sidecar restarts that reset DSH's counter. */
  readonly connectionGeneration: number
  readonly error: string | null
}

interface StreamFrame {
  readonly generation: number
  readonly streamId: string
  readonly sequence: number
  readonly value?: unknown
  readonly error?: { readonly code: string; readonly message: string }
  readonly done?: boolean
}

export class NativeRuntimeError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'NativeRuntimeError' }
}

/** One owner of native event listeners and decoded RPC/stream lifetimes. */
export class NativeRuntimeClient {
  private snapshot: NativeRuntimeSnapshot = Object.freeze({
    mode: isTauri() ? 'native' : 'browser', status: null, connectionGeneration: 0, error: null,
  })
  private readonly subscribers = new Set<() => void>()
  private readonly streams = new Map<string, NativeStream>()
  private readonly unlisten: UnlistenFn[] = []
  private initialization: Promise<void> | undefined
  private activityQueue: Promise<void> = Promise.resolve()
  private disposed = false
  private eventRevision = 0
  private wasConnected = false

  getSnapshot = (): NativeRuntimeSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => {
    this.subscribers.add(listener)
    return () => { this.subscribers.delete(listener) }
  }

  initialize(): Promise<void> {
    if (this.initialization !== undefined) return this.initialization
    const task = this.installListeners().catch(error => {
      if (this.initialization === task) this.initialization = undefined
      throw error
    })
    this.initialization = task
    return this.initialization
  }

  async start(): Promise<void> { await this.command('runtime_start') }
  async stop(): Promise<void> { await this.command('runtime_stop') }
  async restart(): Promise<void> { await this.command('runtime_restart') }

  async setTaskActivity(count: number, known = true): Promise<void> {
    const generation = this.snapshot.status?.connection?.generation
    if (this.snapshot.mode !== 'native' || generation === undefined) return
    if (!Number.isSafeInteger(count) || count < 0) throw new TypeError('Task activity count is invalid')
    const epoch = this.snapshot.connectionGeneration
    const task = this.activityQueue.then(async () => {
      if (this.disposed || this.snapshot.connectionGeneration !== epoch
        || this.snapshot.status?.connection?.generation !== generation) return
      await invoke('runtime_set_task_activity', { count, known, generation })
    })
    this.activityQueue = task.catch(() => undefined)
    await task
  }

  /** Bind the official DSH hook to exactly one authenticated native generation. */
  createRpc(): DshNativeRpc {
    const generation = this.requireGeneration()
    const epoch = this.snapshot.connectionGeneration
    const assertCurrent = (): void => {
      if (this.disposed || this.snapshot.connectionGeneration !== epoch || this.requireGeneration() !== generation) {
        throw staleConnection()
      }
    }
    const call: ClientConnectionRpc['call'] = async (channel, endpoint, payload, signal) => {
      assertCurrent()
      signal?.throwIfAborted()
      const requestId = crypto.randomUUID()
      const result = await withAbort(invoke<{
        generation: number; requestId: string; value: ConnectionRpcResult<unknown>
      }>('dsh_transport_call', { generation, requestId, channel, endpoint, payload }), signal)
      assertCurrent()
      signal?.throwIfAborted()
      if (result.generation !== generation || result.requestId !== requestId
        || typeof result.value !== 'object' || result.value === null || typeof result.value.ok !== 'boolean') {
        throw new NativeRuntimeError('invalid-response', 'The local service returned an invalid response')
      }
      return result.value
    }
    const open: NonNullable<ClientConnectionRpc['open']> = (channel, endpoint, payload, signal, uplink) => {
      const owner = this
      return (async function* () {
        assertCurrent()
        signal.throwIfAborted()
        const streamId = crypto.randomUUID()
        const queue = new NativeStream()
        const uplinkSignal = AbortSignal.any([signal, queue.signal])
        owner.streams.set(streamId, queue)
        const abort = (): void => queue.fail(signal.reason ?? new DOMException('Aborted', 'AbortError'))
        signal.addEventListener('abort', abort, { once: true })
        let uplinkIterator: AsyncIterator<unknown> | undefined
        let uplinkTask: Promise<void> | undefined
        try {
          const ack = await withAbort(invoke<{ generation: number; streamId: string }>('dsh_transport_open', {
            generation, streamId, channel, endpoint, payload,
          }), signal)
          assertCurrent()
          verifyAck(ack, generation, streamId)
          if (uplink !== undefined) {
            uplinkIterator = uplink[Symbol.asyncIterator]()
            const iterator = uplinkIterator
            uplinkTask = (async () => {
              while (!queue.ended && !signal.aborted) {
                const item = await withAbort(iterator.next(), uplinkSignal)
                if (queue.ended) return
                assertCurrent()
                if (item.done) break
                const ack = await withAbort(invoke<{ generation: number; streamId: string }>(
                  'dsh_transport_uplink', { generation, streamId, value: item.value }), uplinkSignal)
                verifyAck(ack, generation, streamId)
              }
              if (!queue.ended && !signal.aborted) {
                const ack = await withAbort(invoke<{ generation: number; streamId: string }>('dsh_transport_end', { generation, streamId }), uplinkSignal)
                assertCurrent()
                verifyAck(ack, generation, streamId)
              }
            })().catch(error => { queue.fail(error) })
          }
          for await (const value of queue) { assertCurrent(); yield value }
        } finally {
          signal.removeEventListener('abort', abort)
          owner.streams.delete(streamId)
          queue.end()
          // Cancellation is bounded by the native owner's deadline. Do not wait
          // for an arbitrary producer's next() before cancelling the remote stream.
          void invoke('dsh_transport_cancel', { generation, streamId }).catch(() => {})
          void uplinkIterator?.return?.().catch(() => {})
          void uplinkTask
        }
      })()
    }
    return Object.freeze({ call, open })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const unsubscribe of this.unlisten.splice(0)) unsubscribe()
    for (const stream of this.streams.values()) stream.fail(staleConnection())
    this.streams.clear()
    this.subscribers.clear()
  }

  private async installListeners(): Promise<void> {
    if (this.disposed) throw staleConnection()
    if (this.snapshot.mode === 'browser') return
    try {
      const statusUnlisten = await listen<NativeRuntimeStatus>('desktop-runtime-status', event => {
        this.eventRevision += 1
        this.acceptStatus(event.payload)
      })
      if (this.disposed) { statusUnlisten(); return }
      this.unlisten.push(statusUnlisten)
      const streamUnlisten = await listen<StreamFrame>('desktop-dsh-stream', event => {
        const frame = event.payload
        if (frame.generation !== this.snapshot.status?.connection?.generation) return
        this.streams.get(frame.streamId)?.accept(frame)
      })
      if (this.disposed) { streamUnlisten(); return }
      this.unlisten.push(streamUnlisten)
      const revision = this.eventRevision
      const status = await invoke<NativeRuntimeStatus>('runtime_status')
      if (revision === this.eventRevision) this.acceptStatus(status)
    } catch (error) {
      for (const unsubscribe of this.unlisten.splice(0)) unsubscribe()
      if (!this.disposed) this.publish({ ...this.snapshot, error: safeErrorCode(error) })
      throw error
    }
  }

  private async command(command: string): Promise<void> {
    await this.initialize()
    if (this.snapshot.mode !== 'native' || this.disposed) {
      throw new NativeRuntimeError('native-unavailable', 'The native host is unavailable in this browser')
    }
    const revision = this.eventRevision
    const status = await invoke<NativeRuntimeStatus>(command)
    if (revision === this.eventRevision) this.acceptStatus(status)
  }

  private requireGeneration(): number {
    const status = this.snapshot.status
    if (status?.process !== 'ready' || status.dsh.state !== 'ready' || status.connection === null) {
      throw new NativeRuntimeError('runtime-unavailable', 'The local service is not ready')
    }
    return status.connection.generation
  }

  private acceptStatus(status: NativeRuntimeStatus): void {
    if (this.disposed) return
    const connected = status.process === 'ready' && status.dsh.state === 'ready' && status.connection !== null
    const changed = this.snapshot.status?.connection?.generation !== status.connection?.generation
    const newConnection = connected && (!this.wasConnected || changed)
    const epoch = this.snapshot.connectionGeneration + (newConnection ? 1 : 0)
    if (!connected || changed) {
      for (const stream of this.streams.values()) stream.fail(staleConnection())
      this.streams.clear()
    }
    this.wasConnected = connected
    this.publish({ ...this.snapshot, status, connectionGeneration: epoch, error: null })
  }

  private publish(snapshot: NativeRuntimeSnapshot): void {
    this.snapshot = Object.freeze(snapshot)
    for (const subscriber of [...this.subscribers]) { try { subscriber() } catch { /* Isolate observers. */ } }
  }
}

class NativeStream implements AsyncIterable<unknown> {
  private readonly lifetime = new AbortController()
  readonly signal = this.lifetime.signal
  private readonly values: unknown[] = []
  private waiter: (() => void) | undefined
  private failure: unknown
  private lastSequence = -1
  ended = false

  accept(frame: StreamFrame): void {
    if (this.ended) return
    if (!Number.isSafeInteger(frame.sequence) || frame.sequence <= this.lastSequence) return
    if (frame.sequence !== this.lastSequence + 1) {
      this.fail(new NativeRuntimeError('stream-gap', 'The local stream missed an event')); return
    }
    this.lastSequence = frame.sequence
    if (frame.error !== undefined) {
      this.fail(new NativeRuntimeError(frame.error.code, frame.error.message))
    } else if (frame.done === true) { this.end() }
    else if (Object.hasOwn(frame, 'value')) {
      if (this.values.length >= 256) {
        this.fail(new NativeRuntimeError('stream-overflow', 'The local stream consumer fell behind')); return
      }
      this.values.push(frame.value)
      this.wake()
    } else { this.fail(new NativeRuntimeError('invalid-frame', 'The local stream returned an invalid event')) }
  }

  fail(error: unknown): void { if (!this.ended) { this.failure = error; this.ended = true; this.values.length = 0; this.lifetime.abort(error); this.wake() } }
  end(): void { this.ended = true; this.lifetime.abort(); this.wake() }
  private wake(): void { const waiter = this.waiter; this.waiter = undefined; waiter?.() }
  async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
    while (true) {
      if (this.failure !== undefined) throw this.failure
      if (this.values.length > 0) { yield this.values.shift(); continue }
      if (this.ended) return
      await new Promise<void>(resolve => { this.waiter = resolve })
    }
  }
}

function verifyAck(ack: { generation: number; streamId: string }, generation: number, streamId: string): void {
  if (ack.generation !== generation || ack.streamId !== streamId) {
    throw new NativeRuntimeError('invalid-response', 'The local stream response did not match its request')
  }
}
function staleConnection(): NativeRuntimeError { return new NativeRuntimeError('stale-generation', 'The local connection changed') }
function safeErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') return error.code
  return 'runtime-unavailable'
}
function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
  return new Promise((resolve, reject) => {
    const abort = (): void => { cleanup(); reject(signal.reason ?? new DOMException('Aborted', 'AbortError')) }
    const cleanup = (): void => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
  })
}
