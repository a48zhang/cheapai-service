import { randomUUID } from 'node:crypto'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { DesktopKeyResponse } from '@sub2api/desktop-contracts'

import { CHEAPAI_API_KEY_CREDENTIAL_REF } from '../dsh/config.ts'

export const DESKTOP_CREDENTIAL_SOCKET_ENV = 'SUB2API_DSH_CREDENTIAL_SOCKET'

const PROTOCOL_VERSION = 1
const MAX_FRAME_BYTES = 4096
const MAX_CLIENTS = 64
const DEFAULT_TIMEOUT_MS = 20_000
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const API_KEY_PATTERN = /^s2a_key_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/

export type DesktopCredentialPublicStatus =
  | { readonly status: 'signedOut' }
  | { readonly status: 'signedIn'; readonly tokenExpiresAt: number; readonly keyExpiresAt: number | null }

export interface DesktopCredentialManager {
  getKey(options?: { readonly signal?: AbortSignal }): Promise<DesktopKeyResponse>
  getPublicStatus(): DesktopCredentialPublicStatus
}

type BridgeCommand = 'resolve' | 'status'

interface BridgeRequest {
  readonly version: 1
  readonly id: string
  readonly command: BridgeCommand
  readonly ref: typeof CHEAPAI_API_KEY_CREDENTIAL_REF
}

type BridgeResult = { readonly key: string } | DesktopCredentialPublicStatus
type BridgeResponse =
  | { readonly version: 1; readonly id: string; readonly ok: true; readonly result: BridgeResult }
  | { readonly version: 1; readonly id: string; readonly ok: false; readonly error: 'unavailable' | 'timeout' }

export class DesktopCredentialBridgeError extends Error {
  constructor(readonly code: 'cancelled' | 'timeout' | 'unavailable' | 'closed') {
    super(bridgeErrorMessage(code))
    this.name = 'DesktopCredentialBridgeError'
  }
}

/** Runtime-side server for one private DSH child. The endpoint is transport
 * metadata, never a credential; each resolve command calls the session manager
 * and returns its Key only to the connected DSH process.
 */
export class DesktopCredentialBridge {
  private readonly timeoutMs: number
  private address: string | undefined
  private privateDirectory: string | undefined
  private server: Server | undefined
  private listenPromise: Promise<string> | undefined
  private serverClosePromise: Promise<void> | undefined
  private readonly sockets = new Set<Socket>()
  private readonly requests = new Map<Socket, AbortController>()
  private epoch = 0
  private closed = false
  private closing: Promise<void> | undefined

  constructor(
    private readonly manager: DesktopCredentialManager,
    options: { readonly timeoutMs?: number } = {},
  ) {
    this.timeoutMs = validateTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  }

  /** Start before spawning DSH; pass the returned non-secret address in the
   * child's SUB2API_DSH_CREDENTIAL_SOCKET environment variable.
   */
  listen(): Promise<string> {
    if (this.closed) return Promise.reject(new DesktopCredentialBridgeError('closed'))
    // The in-flight startup owns the one server and endpoint. Concurrent
    // callers share its result until binding and Unix permissions are ready.
    if (this.listenPromise !== undefined) return this.listenPromise
    if (this.server?.listening && this.address !== undefined) return Promise.resolve(this.address)

    const pending = this.startListening()
    this.listenPromise = pending
    void pending.then(
      () => { if (this.listenPromise === pending) this.listenPromise = undefined },
      () => { if (this.listenPromise === pending) this.listenPromise = undefined },
    )
    return pending
  }

  private async startListening(): Promise<string> {
    if (this.closed) throw new DesktopCredentialBridgeError('closed')
    if (process.platform === 'win32') {
      this.address ??= `\\\\.\\pipe\\cheapai-dsh-${randomUUID()}`
    } else {
      this.privateDirectory ??= await mkdtemp(join(tmpdir(), 'dsh-'))
      if (this.closed) {
        await this.cleanupEndpoint()
        throw new DesktopCredentialBridgeError('closed')
      }
      this.address ??= join(this.privateDirectory, 'c')
      if (Buffer.byteLength(this.address) > 90) {
        await this.cleanupEndpoint()
        throw new Error('Desktop credential IPC socket path is too long.')
      }
    }
    if (this.closed) {
      await this.cleanupEndpoint()
      throw new DesktopCredentialBridgeError('closed')
    }

    const server = createServer(socket => this.accept(socket))
    this.server = server
    server.on('error', () => { void this.close() })
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off('listening', onListening)
        reject(error)
      }
      const onListening = (): void => {
        server.off('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(this.address!)
    }).catch(async () => {
      if (this.server === server) this.server = undefined
      await this.stopServer(server)
      await this.cleanupEndpoint()
      throw new Error('Desktop credential IPC could not start.')
    })

    if (this.closed) throw new DesktopCredentialBridgeError('closed')

    if (process.platform !== 'win32') {
      try {
        await chmod(this.address!, 0o600)
      } catch {
        this.beginShutdown()
        if (this.server === server) this.server = undefined
        await this.stopServer(server)
        await this.cleanupEndpoint()
        throw new Error('Desktop credential IPC permissions could not be restricted.')
      }
    }
    if (this.closed) throw new DesktopCredentialBridgeError('closed')
    return this.address!
  }

  /** Stop accepting requests, abort in-flight resolutions, and remove the
   * private Unix socket directory. No key material is logged or persisted.
   */
  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    this.beginShutdown()
    const pendingListen = this.listenPromise

    this.closing = (async () => {
      // listen owns endpoint creation and chmod. Wait until it has settled so
      // it cannot bind or return an address after cleanup has begun.
      await pendingListen?.catch(() => {})
      const server = this.server
      this.server = undefined
      await this.stopServer(server)
      await this.cleanupEndpoint()
    })()
    return this.closing
  }

  private beginShutdown(): void {
    if (!this.closed) {
      this.closed = true
      this.epoch += 1
    }
    for (const request of this.requests.values()) request.abort()
    for (const socket of this.sockets) socket.destroy()
  }

  private stopServer(server: Server | undefined): Promise<void> {
    if (server === undefined || !server.listening) return Promise.resolve()
    if (this.serverClosePromise !== undefined) return this.serverClosePromise
    this.serverClosePromise = new Promise<void>(resolve => server.close(() => resolve()))
    return this.serverClosePromise
  }

  private accept(socket: Socket): void {
    if (this.closed || this.sockets.size >= MAX_CLIENTS) {
      socket.destroy()
      return
    }
    this.sockets.add(socket)
    socket.setNoDelay(true)
    socket.setTimeout(this.timeoutMs, () => socket.destroy())
    socket.once('close', () => {
      this.sockets.delete(socket)
      this.requests.get(socket)?.abort()
      this.requests.delete(socket)
    })

    let buffer = Buffer.alloc(0)
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length > MAX_FRAME_BYTES) {
        socket.destroy()
        return
      }
      const newline = buffer.indexOf(0x0a)
      if (newline < 0) return
      if (newline !== buffer.length - 1) {
        socket.destroy()
        return
      }
      socket.off('data', onData)
      socket.pause()
      void this.respond(socket, buffer.subarray(0, newline))
    }
    socket.on('data', onData)
  }

  private async respond(socket: Socket, frame: Buffer): Promise<void> {
    const request = parseRequest(frame)
    if (request === null) {
      socket.destroy()
      return
    }
    const epoch = this.epoch
    const controller = new AbortController()
    this.requests.set(socket, controller)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.timeoutMs)
    timer.unref?.()

    try {
      let result: BridgeResult
      if (request.command === 'resolve') {
        const current = await this.manager.getKey({ signal: controller.signal })
        if (!isDesktopKeyResponse(current)) throw new Error('invalid_key_response')
        result = { key: current.key }
      } else {
        result = projectPublicStatus(this.manager.getPublicStatus())
      }
      if (this.closed || epoch !== this.epoch || controller.signal.aborted || socket.destroyed) {
        if (!socket.destroyed) socket.destroy()
        return
      }
      this.write(socket, { version: PROTOCOL_VERSION, id: request.id, ok: true, result })
    } catch {
      if (this.closed || epoch !== this.epoch || socket.destroyed) return
      this.write(socket, {
        version: PROTOCOL_VERSION,
        id: request.id,
        ok: false,
        error: timedOut ? 'timeout' : 'unavailable',
      })
    } finally {
      clearTimeout(timer)
      if (this.requests.get(socket) === controller) this.requests.delete(socket)
    }
  }

  private write(socket: Socket, response: BridgeResponse): void {
    if (socket.destroyed) return
    const frame = `${JSON.stringify(response)}\n`
    if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) {
      socket.destroy()
      return
    }
    socket.end(frame)
  }

  private async cleanupEndpoint(): Promise<void> {
    const address = this.address
    const privateDirectory = this.privateDirectory
    this.address = undefined
    this.privateDirectory = undefined
    if (process.platform !== 'win32' && address !== undefined) await rm(address, { force: true }).catch(() => {})
    if (privateDirectory !== undefined) await rm(privateDirectory, { recursive: true, force: true }).catch(() => {})
  }
}

/** DSH-side client used only by DesktopCredentialProvider. It opens a fresh
 * local connection per resolve/status call so disconnect and timeout cancel a
 * private request without sharing a response channel between model calls.
 */
export class DesktopCredentialBridgeClient {
  private readonly timeoutMs: number

  constructor(options: { readonly endpoint: string | undefined; readonly timeoutMs?: number }) {
    this.endpoint = validateEndpoint(options.endpoint)
    this.timeoutMs = validateTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  }

  private readonly endpoint: string

  resolveKey(signal?: AbortSignal): Promise<string> {
    return this.request('resolve', signal).then(result => {
      if ('key' in result && isApiKey(result.key)) return result.key
      throw new DesktopCredentialBridgeError('unavailable')
    })
  }

  getPublicStatus(): Promise<DesktopCredentialPublicStatus> {
    return this.request('status').then(result => {
      if ('status' in result && isPublicStatus(result)) return result
      throw new DesktopCredentialBridgeError('unavailable')
    })
  }

  private request(command: BridgeCommand, signal?: AbortSignal): Promise<BridgeResult> {
    if (signal?.aborted) return Promise.reject(new DesktopCredentialBridgeError('cancelled'))
    const id = randomUUID()
    const request: BridgeRequest = {
      version: PROTOCOL_VERSION,
      id,
      command,
      ref: CHEAPAI_API_KEY_CREDENTIAL_REF,
    }
    const frame = `${JSON.stringify(request)}\n`
    if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) {
      return Promise.reject(new DesktopCredentialBridgeError('unavailable'))
    }

    return new Promise((resolve, reject) => {
      const socket = createConnection(this.endpoint)
      let buffer = Buffer.alloc(0)
      let settled = false
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        socket.destroy()
      }, this.timeoutMs)
      timer.unref?.()
      const abort = (): void => socket.destroy()
      signal?.addEventListener('abort', abort, { once: true })

      const finish = (error?: DesktopCredentialBridgeError, result?: BridgeResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        if (error !== undefined) reject(error)
        else resolve(result!)
        socket.destroy()
      }

      socket.once('connect', () => socket.write(frame))
      socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk])
        if (buffer.length > MAX_FRAME_BYTES) {
          finish(new DesktopCredentialBridgeError('unavailable'))
          return
        }
        const newline = buffer.indexOf(0x0a)
        if (newline < 0) return
        if (newline !== buffer.length - 1) {
          finish(new DesktopCredentialBridgeError('unavailable'))
          return
        }
        const response = parseResponse(buffer.subarray(0, newline), id)
        if (response === null) {
          finish(new DesktopCredentialBridgeError('unavailable'))
        } else if (!response.ok) {
          finish(new DesktopCredentialBridgeError(response.error))
        } else {
          finish(undefined, response.result)
        }
      })
      socket.once('error', () => {
        finish(new DesktopCredentialBridgeError(
          signal?.aborted ? 'cancelled' : timedOut ? 'timeout' : 'unavailable',
        ))
      })
      socket.once('close', () => {
        if (!settled) {
          finish(new DesktopCredentialBridgeError(
            signal?.aborted ? 'cancelled' : timedOut ? 'timeout' : 'unavailable',
          ))
        }
      })
    })
  }
}

function parseRequest(frame: Buffer): BridgeRequest | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame))
    if (!isRecord(value) || Object.keys(value).length !== 4
      || value.version !== PROTOCOL_VERSION || typeof value.id !== 'string' || !UUID_PATTERN.test(value.id)
      || (value.command !== 'resolve' && value.command !== 'status')
      || value.ref !== CHEAPAI_API_KEY_CREDENTIAL_REF) return null
    return value as BridgeRequest
  } catch {
    return null
  }
}

function parseResponse(frame: Buffer, expectedId: string): BridgeResponse | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame))
    if (!isRecord(value) || value.version !== PROTOCOL_VERSION || value.id !== expectedId
      || typeof value.ok !== 'boolean') return null
    if (value.ok === false) {
      if (value.error !== 'unavailable' && value.error !== 'timeout') return null
      return value as BridgeResponse
    }
    if (!isRecord(value.result)) return null
    if (Object.hasOwn(value.result, 'key') && isApiKey(value.result.key)) return value as BridgeResponse
    if (isPublicStatus(value.result)) return value as BridgeResponse
    return null
  } catch {
    return null
  }
}

function projectPublicStatus(value: DesktopCredentialPublicStatus): DesktopCredentialPublicStatus {
  if (value?.status === 'signedOut') return { status: 'signedOut' }
  if (value?.status === 'signedIn' && isTimestamp(value.tokenExpiresAt)
    && (value.keyExpiresAt === null || isTimestamp(value.keyExpiresAt))) {
    return {
      status: 'signedIn',
      tokenExpiresAt: value.tokenExpiresAt,
      keyExpiresAt: value.keyExpiresAt,
    }
  }
  throw new Error('invalid_public_status')
}

function isPublicStatus(value: unknown): value is DesktopCredentialPublicStatus {
  if (!isRecord(value)) return false
  if (value.status === 'signedOut') return Object.keys(value).length === 1
  return value.status === 'signedIn'
    && Object.keys(value).length === 3
    && isTimestamp(value.tokenExpiresAt)
    && (value.keyExpiresAt === null || isTimestamp(value.keyExpiresAt))
}

function isDesktopKeyResponse(value: unknown): value is DesktopKeyResponse {
  return isRecord(value) && Object.keys(value).length === 3
    && isApiKey(value.key) && isSafeIdentifier(value.keyId) && isTimestamp(value.expiresAt)
}

function isApiKey(value: unknown): value is string {
  return typeof value === 'string' && API_KEY_PATTERN.test(value)
}

function isSafeIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
    && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value)
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 300_000) {
    throw new TypeError('Desktop credential IPC timeout is invalid.')
  }
  return value
}

function validateEndpoint(value: string | undefined): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new DesktopCredentialBridgeError('unavailable')
  }
  if (process.platform === 'win32') {
    if (!value.startsWith('\\\\.\\pipe\\') || value.length > 240 || /[\r\n\0]/u.test(value)) {
      throw new DesktopCredentialBridgeError('unavailable')
    }
  } else if (!value.startsWith('/') || Buffer.byteLength(value) > 90 || /[\r\n\0]/u.test(value)) {
    throw new DesktopCredentialBridgeError('unavailable')
  }
  return value
}

function bridgeErrorMessage(code: DesktopCredentialBridgeError['code']): string {
  switch (code) {
    case 'cancelled': return 'Desktop credential IPC request was cancelled.'
    case 'timeout': return 'Desktop credential IPC request timed out.'
    case 'closed': return 'Desktop credential IPC is closed.'
    case 'unavailable': return 'Desktop credential IPC is unavailable.'
  }
}
