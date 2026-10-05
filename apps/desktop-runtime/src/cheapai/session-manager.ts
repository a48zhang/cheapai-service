import type { DesktopKeyResponse } from '@sub2api/desktop-contracts'
import {
  DesktopAccountApiError,
  DesktopAccountRequestCancelledError,
} from './account-client.ts'
import type {
  DesktopAccountRequestOptions,
  DesktopSessionCredential,
} from './account-client.ts'

export interface DesktopKeyApi {
  getKey(
    session: DesktopSessionCredential,
    options?: DesktopAccountRequestOptions,
  ): Promise<DesktopKeyResponse>
}

export type DesktopSessionManagerPublicStatus =
  | { readonly status: 'signedOut' }
  | {
      readonly status: 'signedIn'
      readonly tokenExpiresAt: number
      readonly keyExpiresAt: number | null
    }

interface InFlightKeyRequest {
  readonly generation: number
  readonly controller: AbortController
  readonly promise: Promise<DesktopKeyResponse>
  waiters: number
}

/** A DSH-side credential resolve asks this manager for the active Token's Key.
 * The manager reuses the last server-returned Key until its natural deadline,
 * coalesces concurrent fetches, and rejects stale results after a session change.
 */
export class DesktopSessionManager {
  private currentGeneration = 0
  private session: DesktopSessionCredential | null = null
  private currentKey: DesktopKeyResponse | null = null
  private pendingKey: InFlightKeyRequest | null = null

  constructor(
    private readonly keyApi: DesktopKeyApi,
    private readonly now: () => number = Date.now,
  ) {}

  get generation(): number {
    return this.currentGeneration
  }

  /** Reserve a generation before an asynchronous login or logout operation.
   * Keep the current session until that operation succeeds, so network failure
   * does not erase a still-valid local login.
   */
  beginSessionChange(): number {
    const generation = this.nextGeneration()
    this.abortPendingKey()
    return generation
  }

  /** Install only the session produced by the latest login/restore operation. */
  setSession(generation: number, session: DesktopSessionCredential): boolean {
    if (!this.isCurrent(generation)) return false

    if (this.session?.token === session.token && this.session.expiresAt === session.expiresAt) return true

    this.abortPendingKey()
    this.session = Object.freeze({ token: session.token, expiresAt: session.expiresAt })
    this.currentKey = null
    return true
  }

  /** Clear only after the corresponding server logout/credential removal has
   * succeeded. A late logout cannot remove a newer session.
   */
  clearSession(generation: number): boolean {
    if (!this.isCurrent(generation)) return false
    this.nextGeneration()
    this.abortPendingKey()
    this.session = null
    this.currentKey = null
    return true
  }

  /** Return the active Key for DSH's per-model-call credential resolver. No
   * stream is restarted here: failures propagate to the original DSH call.
   */
  getKey(options: DesktopAccountRequestOptions = {}): Promise<DesktopKeyResponse> {
    if (options.signal?.aborted) return Promise.reject(new DesktopAccountRequestCancelledError())

    const session = this.session
    if (session === null) return Promise.reject(sessionExpired())
    const now = this.now()
    if (session.expiresAt <= now) return Promise.reject(sessionExpired())

    if (this.currentKey !== null) {
      if (this.currentKey.expiresAt > now) return Promise.resolve(copyKey(this.currentKey))
      this.currentKey = null
    }

    const pending = this.pendingKey
    if (pending !== null && pending.generation === this.currentGeneration) {
      if (!pending.controller.signal.aborted) return this.waitForKey(pending, options.signal)
      // All prior callers cancelled this shared request. Serialize a fresh
      // request after it settles so an aborted fetch cannot race a replacement.
      return this.waitForCancelledKey(pending, options.signal)
    }

    return this.startKeyRequest(session, options.signal)
  }

  /** Non-secret status for the private credential provider's describe path. */
  getPublicStatus(): DesktopSessionManagerPublicStatus {
    if (this.session === null) return Object.freeze({ status: 'signedOut' as const })
    const now = this.now()
    if (this.session.expiresAt <= now) return Object.freeze({ status: 'signedOut' as const })
    const keyExpiresAt = this.currentKey !== null && this.currentKey.expiresAt > now
      ? this.currentKey.expiresAt
      : null
    return Object.freeze({
      status: 'signedIn' as const,
      tokenExpiresAt: this.session.expiresAt,
      keyExpiresAt,
    })
  }

  private startKeyRequest(
    session: DesktopSessionCredential,
    signal: AbortSignal | undefined,
  ): Promise<DesktopKeyResponse> {
    const generation = this.currentGeneration
    const controller = new AbortController()
    const promise = Promise.resolve().then(() => this.keyApi.getKey(session, { signal: controller.signal })).then(key => {
      if (!this.isCurrent(generation) || this.session !== session) throw new DesktopSessionChangedError()

      const now = this.now()
      if (session.expiresAt <= now) throw sessionExpired()
      if (key.expiresAt <= now) {
        throw new DesktopAccountApiError('serviceUnavailable')
      }

      const cached = Object.freeze(copyKey(key))
      this.currentKey = cached
      return copyKey(cached)
    }).catch(error => {
      if (!this.isCurrent(generation) || this.session !== session) throw new DesktopSessionChangedError()
      throw error
    })
    const flight: InFlightKeyRequest = { generation, controller, promise, waiters: 0 }
    this.pendingKey = flight
    void promise.then(
      () => this.clearPending(flight),
      () => this.clearPending(flight),
    )
    return this.waitForKey(flight, signal)
  }

  private waitForKey(
    flight: InFlightKeyRequest,
    signal: AbortSignal | undefined,
  ): Promise<DesktopKeyResponse> {
    if (signal?.aborted) return Promise.reject(new DesktopAccountRequestCancelledError())
    flight.waiters += 1

    return new Promise<DesktopKeyResponse>((resolve, reject) => {
      let settled = false
      const release = (): void => {
        signal?.removeEventListener('abort', abortCaller)
        flight.waiters -= 1
        if (flight.waiters === 0 && this.pendingKey === flight && !flight.controller.signal.aborted) {
          flight.controller.abort()
        }
      }
      const abortCaller = (): void => {
        if (settled) return
        settled = true
        release()
        reject(new DesktopAccountRequestCancelledError())
      }

      signal?.addEventListener('abort', abortCaller, { once: true })
      flight.promise.then(key => {
        if (settled) return
        settled = true
        release()
        resolve(copyKey(key))
      }, error => {
        if (settled) return
        settled = true
        release()
        reject(error)
      })
    })
  }

  private waitForCancelledKey(
    flight: InFlightKeyRequest,
    signal: AbortSignal | undefined,
  ): Promise<DesktopKeyResponse> {
    if (signal?.aborted) return Promise.reject(new DesktopAccountRequestCancelledError())
    return new Promise<DesktopKeyResponse>((resolve, reject) => {
      let settled = false
      const finish = (action: () => void): void => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', abortCaller)
        action()
      }
      const abortCaller = (): void => {
        finish(() => reject(new DesktopAccountRequestCancelledError()))
      }
      const retry = (): void => {
        finish(() => {
          try {
            resolve(this.getKey(signal === undefined ? {} : { signal }))
          } catch (error) {
            reject(error)
          }
        })
      }

      signal?.addEventListener('abort', abortCaller, { once: true })
      flight.promise.then(retry, error => {
        if (error instanceof DesktopAccountRequestCancelledError) retry()
        else finish(() => reject(error))
      })
    })
  }

  private clearPending(flight: InFlightKeyRequest): void {
    if (this.pendingKey === flight) this.pendingKey = null
  }

  private abortPendingKey(): void {
    const pending = this.pendingKey
    this.pendingKey = null
    pending?.controller.abort()
  }

  private isCurrent(generation: number): boolean {
    return Number.isSafeInteger(generation) && generation === this.currentGeneration
  }

  private nextGeneration(): number {
    if (this.currentGeneration >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError('Desktop session generation is exhausted.')
    }
    this.currentGeneration += 1
    return this.currentGeneration
  }
}

export class DesktopSessionChangedError extends Error {
  constructor() {
    super('Desktop session changed while a Key request was in progress.')
    this.name = 'DesktopSessionChangedError'
  }
}

function sessionExpired(): DesktopAccountApiError {
  return new DesktopAccountApiError('sessionExpired', 'unauthorized')
}

function copyKey(key: DesktopKeyResponse): DesktopKeyResponse {
  return { key: key.key, keyId: key.keyId, expiresAt: key.expiresAt }
}
