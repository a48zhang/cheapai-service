import type {
  DesktopAccountData,
  DesktopAccountProblem,
  DesktopHostAccountRequest,
  DesktopHostAccountResult,
  DesktopKeyResponse,
  DesktopLoginResponse,
  DesktopPrivateSessionCredential,
  DesktopPublicAccountState,
} from '@sub2api/desktop-contracts'
import { DesktopAccountApiError, DesktopAccountRequestCancelledError } from './account-client.ts'
import type { DesktopAccountClient, DesktopAccountRequestOptions, DesktopSessionCredential } from './account-client.ts'
import { DesktopDshAccountBinding, DesktopAccountStateStore } from './account-state.ts'
import type { DesktopCredentialManager, DesktopCredentialPublicStatus } from './credential-bridge.ts'
import { DesktopSessionChangedError, DesktopSessionManager } from './session-manager.ts'
import type { DshConnectionInfo } from '../dsh/connection-info.ts'

export interface DesktopAccountControllerOptions {
  readonly client: DesktopAccountClient
  readonly sessions: DesktopSessionManager
  readonly state: DesktopAccountStateStore
  readonly binding: DesktopDshAccountBinding
  /** Starts DSH only after a valid session is installed and its account home is bound. */
  readonly activateProvider: (account: DesktopAccountData, generation: number) => Promise<DshConnectionInfo>
  /** Closes the private bridge and Runtime transport, then stops the DSH child. */
  readonly stopRuntime: () => Promise<void>
  readonly now?: () => number
}

type ResultFor<Operation extends DesktopHostAccountResult['operation']> = Extract<
  DesktopHostAccountResult,
  { readonly operation: Operation }
>

const defaultNow = (): number => Date.now()

/**
 * The Runtime owns the ordered account lifecycle. Login is private API work
 * only; the native host persists its Token before calling restore to bind the
 * DSH home, enable the credential bridge, and publish a signed-in projection.
 */
export class DesktopAccountController implements DesktopCredentialManager {
  private operationQueue: Promise<void> = Promise.resolve()
  private activeCredential: DesktopSessionCredential | null = null
  private activeUserId: string | null = null
  private activeSessionGeneration: number | null = null
  /** The expired credential is forgotten immediately, but its running DSH
   * home remains bound until an authenticated replacement is ready. */
  private retainedExpiredBinding = false
  private keyResolutionEnabled = false
  private stopped = false
  private readonly now: () => number

  constructor(private readonly options: DesktopAccountControllerOptions) {
    this.now = options.now ?? defaultNow
  }

  /** Process native account commands serially so late login/logout work cannot
   * replace a newer account binding. Stream Key lookups remain concurrent and
   * are single-flighted by DesktopSessionManager.
   */
  handle(request: DesktopHostAccountRequest): Promise<DesktopHostAccountResult> {
    if (this.stopped) return Promise.reject(accountFailure('serviceUnavailable'))
    return this.enqueue(() => this.handleSerial(request))
  }

  /** Dynamic DSH credential resolver. A failed lookup updates only the public
   * status and then rejects the original stream; it never retries that stream.
   */
  async getKey(options: DesktopAccountRequestOptions = {}): Promise<DesktopKeyResponse> {
    const stateGeneration = this.options.state.generation
    const sessionGeneration = this.activeSessionGeneration
    if (this.stopped || !this.keyResolutionEnabled || this.activeCredential === null
      || this.activeSessionGeneration === null
      || this.activeSessionGeneration !== this.options.sessions.generation) {
      throw accountFailure('sessionExpired')
    }

    try {
      return await this.options.sessions.getKey(options)
    } catch (cause) {
      if (cause instanceof DesktopAccountApiError
        && !this.stopped
        && this.activeSessionGeneration === sessionGeneration
        && this.options.sessions.generation === sessionGeneration) {
        if (cause.problem === 'sessionExpired') {
          this.expireSession(sessionGeneration)
        } else {
          this.options.state.setUnavailable(stateGeneration, cause.problem)
        }
      }
      throw cause
    }
  }

  getPublicStatus(): DesktopCredentialPublicStatus {
    return this.keyResolutionEnabled
      ? this.options.sessions.getPublicStatus()
      : Object.freeze({ status: 'signedOut' as const })
  }

  /** Start or recover the current account's DSH runtime after restore. */
  start(): Promise<DshConnectionInfo> {
    if (this.stopped) return Promise.reject(accountFailure('serviceUnavailable'))
    return this.enqueue(() => this.startSerial())
  }

  /** Invalidate every late account/provider operation before shutdown begins. */
  shutdown(): void {
    if (this.stopped) return
    this.stopped = true
    this.keyResolutionEnabled = false
    this.activeCredential = null
    this.activeUserId = null
    this.activeSessionGeneration = null
    this.retainedExpiredBinding = false
    const sessionGeneration = this.options.sessions.beginSessionChange()
    this.options.sessions.clearSession(sessionGeneration)
    this.options.state.reset()
  }

  private async startSerial(): Promise<DshConnectionInfo> {
    const current = this.options.state.getSnapshot()
    const generation = this.options.state.generation
    const sessionGeneration = this.activeSessionGeneration
    const account = current.status === 'signedIn'
      ? current.account
      : current.status === 'unavailable'
        ? current.account
        : null
    if (this.stopped || account === null
      || this.activeCredential === null
      || sessionGeneration === null
      || this.activeSessionGeneration !== this.options.sessions.generation
      || !this.keyResolutionEnabled) {
      throw accountFailure('sessionExpired')
    }
    try {
      const connection = await this.options.activateProvider(account, generation)
      if (this.stopped
        || !this.options.state.isCurrent(generation)
        || this.activeSessionGeneration !== sessionGeneration
        || this.options.sessions.generation !== sessionGeneration) {
        throw new DesktopSessionChangedError()
      }
      return connection
    } catch (cause) {
      const problem = accountProblem(cause)
      if (problem === 'sessionExpired') {
        this.expireSession(sessionGeneration)
      } else if (!this.stopped
        && this.options.state.isCurrent(generation)
        && this.activeSessionGeneration === sessionGeneration
        && this.options.sessions.generation === sessionGeneration) {
        this.options.state.setUnavailable(generation, problem)
      }
      throw safeFailure(cause, problem)
    }
  }

  private handleSerial(request: DesktopHostAccountRequest): Promise<DesktopHostAccountResult> {
    if (this.stopped) return Promise.reject(accountFailure('serviceUnavailable'))
    switch (request.operation) {
      case 'login': return this.login(request.payload)
      case 'restore': return this.restore(request.payload)
      case 'getAccount': return this.getAccount(request.payload)
      case 'getKey': return this.getKeyForAccount(request.payload)
      case 'logout': return this.logout(request.payload)
    }
  }

  private async login(credentials: Extract<DesktopHostAccountRequest, { operation: 'login' }>['payload']): Promise<ResultFor<'login'>> {
    const previousState = this.options.state.getSnapshot()
    const generation = this.options.state.begin('login')
    const sessionGeneration = this.options.sessions.generation
    try {
      const result: DesktopLoginResponse = await this.options.client.login(credentials)
      if (!this.options.state.isCurrent(generation)
        || this.options.sessions.generation !== sessionGeneration) {
        throw new DesktopSessionChangedError()
      }
      // Deliberately return the private response to the native host only. It
      // must persist this Token and invoke restore before a public sign-in.
      return { operation: 'login', result }
    } catch (cause) {
      if (this.options.state.isCurrent(generation) && !hasPublicAccount(previousState)) {
        this.restorePriorState(previousState)
      }
      throw cause
    }
  }

  private async restore(credential: DesktopPrivateSessionCredential): Promise<ResultFor<'restore'>> {
    let generation = this.options.state.begin('restore')
    let sessionGeneration = this.options.sessions.beginSessionChange()
    const matchesActive = sameCredential(this.activeCredential, credential)
    let authenticatedAccount: DesktopAccountData | undefined
    if (this.activeCredential !== null && !matchesActive) {
      this.keyResolutionEnabled = false
      try {
        await this.options.stopRuntime()
        if (!await this.options.binding.unbind(generation)) throw new DesktopSessionChangedError()
        if (!this.options.sessions.clearSession(sessionGeneration)) throw new DesktopSessionChangedError()
        this.activeCredential = null
        this.activeUserId = null
        this.activeSessionGeneration = null
        sessionGeneration = this.options.sessions.beginSessionChange()
      } catch (cause) {
        if (this.options.state.isCurrent(generation)) {
          this.options.state.setUnavailable(generation, 'serviceUnavailable')
        }
        throw safeFailure(cause)
      }
    } else if (matchesActive) {
      this.activeSessionGeneration = sessionGeneration
    }

    try {
      if (credential.expiresAt <= this.now()) throw accountFailure('sessionExpired')
      const account = await this.options.client.getAccount(credential.token)
      if (!this.options.state.isCurrent(generation)
        || this.options.sessions.generation !== sessionGeneration) {
        throw new DesktopSessionChangedError()
      }
      authenticatedAccount = account

      // After expiry, keep the old process/home alive for its existing work.
      // Only a successfully authenticated replacement credential may retire
      // that binding and install the new credential bridge.
      if (this.retainedExpiredBinding) {
        this.keyResolutionEnabled = false
        await this.options.stopRuntime()
        if (!this.options.state.isCurrent(generation)
          || this.options.sessions.generation !== sessionGeneration) {
          throw new DesktopSessionChangedError()
        }
        if (!await this.options.binding.unbind(generation)) throw new DesktopSessionChangedError()
        if (!this.options.state.isCurrent(generation)
          || this.options.sessions.generation !== sessionGeneration) {
          throw new DesktopSessionChangedError()
        }
        if (!this.options.sessions.clearSession(sessionGeneration)) throw new DesktopSessionChangedError()
        this.retainedExpiredBinding = false
        sessionGeneration = this.options.sessions.beginSessionChange()
      }

      const previousUserId = publicUserId(this.options.state.getSnapshot())
      if (previousUserId !== null && previousUserId !== account.user.id) {
        // The authenticated response confirms an account switch. Clear the
        // previous account projection before any new home/provider can start.
        this.options.state.reset()
        generation = this.options.state.begin('restore')
      }

      if (!await this.options.binding.bind(generation, account.user.id)) {
        throw new DesktopSessionChangedError()
      }
      if (!this.options.sessions.setSession(sessionGeneration, credential)) {
        throw new DesktopSessionChangedError()
      }

      this.activeCredential = copyCredential(credential)
      this.activeUserId = account.user.id
      this.activeSessionGeneration = sessionGeneration
      this.keyResolutionEnabled = true

      // Authentication and provider readiness are separate facts. Commit the
      // safe user projection now; the native host suppresses account events
      // while this restore command is pending. If provider activation fails,
      // setUnavailable below retains this authenticated account for retry.
      if (!this.options.state.setSignedIn(generation, account, credential.expiresAt)) {
        throw new DesktopSessionChangedError()
      }

      await this.options.activateProvider(account, generation)
      if (!this.options.state.isCurrent(generation)
        || this.options.sessions.generation !== sessionGeneration) {
        throw new DesktopSessionChangedError()
      }
      return { operation: 'restore', result: this.options.state.getSnapshot() }
    } catch (cause) {
      const problem = accountProblem(cause)
      if (problem === 'sessionExpired') {
        this.expireSession(sessionGeneration)
      } else if (this.options.state.isCurrent(generation)) {
        if (authenticatedAccount !== undefined) {
          this.options.state.setSignedIn(generation, authenticatedAccount, credential.expiresAt)
        }
        this.options.state.setUnavailable(generation, problem)
      }
      if (problem !== 'sessionExpired'
        && matchesActive
        && this.options.sessions.generation === sessionGeneration) {
        // A transient refresh failure keeps the current account and cached Key
        // usable. A different incoming Token remains blocked until it restores.
        this.activeSessionGeneration = sessionGeneration
        this.keyResolutionEnabled = true
      }
      throw safeFailure(cause, problem)
    }
  }

  private async getAccount(credential: DesktopPrivateSessionCredential): Promise<ResultFor<'getAccount'>> {
    this.requireActiveCredential(credential)
    const sessionGeneration = this.activeSessionGeneration
    const generation = this.options.state.begin('refresh')
    try {
      const account = await this.options.client.getAccount(credential.token)
      if (!this.options.state.isCurrent(generation)
        || this.activeUserId !== account.user.id
        || !sameCredential(this.activeCredential, credential)) {
        throw new DesktopSessionChangedError()
      }
      if (!this.options.state.setAccount(generation, account)) throw new DesktopSessionChangedError()
      return { operation: 'getAccount', result: account }
    } catch (cause) {
      const problem = accountProblem(cause)
      if (problem === 'sessionExpired') {
        this.expireSession(sessionGeneration)
      } else if (this.options.state.isCurrent(generation)) {
        this.options.state.setUnavailable(generation, problem)
      }
      throw safeFailure(cause, problem)
    }
  }

  private async getKeyForAccount(credential: DesktopPrivateSessionCredential): Promise<ResultFor<'getKey'>> {
    this.requireActiveCredential(credential)
    try {
      const result = await this.getKey()
      return { operation: 'getKey', result }
    } catch (cause) {
      throw safeFailure(cause)
    }
  }

  private async logout(credential: DesktopPrivateSessionCredential): Promise<ResultFor<'logout'>> {
    if (this.activeCredential !== null && !sameCredential(this.activeCredential, credential)) {
      throw accountFailure('sessionExpired')
    }

    const generation = this.options.state.begin('logout')
    const sessionGeneration = this.options.sessions.beginSessionChange()
    this.keyResolutionEnabled = false
    let revoked = false
    try {
      await this.options.client.logout(credential.token)
      revoked = true
    } catch (cause) {
      if (accountProblem(cause) !== 'sessionExpired') {
        if (this.activeCredential !== null
          && sameCredential(this.activeCredential, credential)
          && this.options.sessions.generation === sessionGeneration) {
          this.activeSessionGeneration = sessionGeneration
          this.keyResolutionEnabled = true
        }
        if (this.options.state.isCurrent(generation)) {
          this.options.state.setUnavailable(generation, accountProblem(cause))
        }
        throw safeFailure(cause)
      }
      // A server-confirmed expiry or revocation already means this Token has no
      // live session; finish the local cleanup without pretending to renew it.
      revoked = true
    }

    if (!revoked) throw accountFailure('serviceUnavailable')
    if (this.options.sessions.generation === sessionGeneration) {
      this.options.sessions.clearSession(sessionGeneration)
    }
    this.activeCredential = null
    this.activeUserId = null
    this.activeSessionGeneration = null
    try {
      await this.options.stopRuntime()
      if (!await this.options.binding.unbind(generation)) throw new DesktopSessionChangedError()
      this.retainedExpiredBinding = false
      if (!this.options.state.finishLogout(generation)) throw new DesktopSessionChangedError()
    } catch (cause) {
      if (this.options.state.isCurrent(generation)) {
        this.options.state.setUnavailable(generation, 'serviceUnavailable')
      }
      throw safeFailure(cause)
    }

    return { operation: 'logout', result: { loggedOut: true } }
  }

  private requireActiveCredential(credential: DesktopPrivateSessionCredential): void {
    if (!this.keyResolutionEnabled
      || this.activeCredential === null
      || this.activeSessionGeneration === null
      || this.activeSessionGeneration !== this.options.sessions.generation
      || !sameCredential(this.activeCredential, credential)) {
      throw accountFailure('sessionExpired')
    }
  }

  /** Revoke the credential capability synchronously without interrupting a
   * DSH process that may already have work in flight. A later authenticated
   * restore, explicit logout, account replacement, or shutdown owns teardown.
   */
  private expireSession(sessionGeneration: number | null): boolean {
    if (this.stopped
      || sessionGeneration === null
      || this.options.sessions.generation !== sessionGeneration
      || (this.activeSessionGeneration !== null
        && this.activeSessionGeneration !== sessionGeneration)) return false

    const hadActiveBinding = this.activeSessionGeneration === sessionGeneration
      && this.activeCredential !== null
    this.keyResolutionEnabled = false
    if (!this.options.sessions.clearSession(sessionGeneration)) return false
    if (hadActiveBinding) this.retainedExpiredBinding = true
    if (this.activeSessionGeneration === sessionGeneration) {
      this.activeCredential = null
      this.activeUserId = null
      this.activeSessionGeneration = null
    }
    const generation = this.options.state.begin('refresh')
    this.options.state.setUnavailable(generation, 'sessionExpired')
    return true
  }

  private restorePriorState(state: DesktopPublicAccountState): void {
    this.options.state.reset()
    const generation = this.options.state.generation
    if (state.status === 'signedIn') {
      this.options.state.setSignedIn(generation, state.account, state.expiresAt)
    } else if (state.status === 'unavailable') {
      if (state.account !== null && state.expiresAt !== null) this.options.state.setSignedIn(generation, state.account, state.expiresAt)
      this.options.state.setUnavailable(generation, state.problem)
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.operationQueue.then(operation)
    this.operationQueue = pending.then(() => undefined, () => undefined)
    return pending
  }
}

function publicUserId(state: DesktopPublicAccountState): string | null {
  if (state.status === 'signedIn') return state.account.user.id
  return state.status === 'unavailable' ? state.account?.user.id ?? null : null
}

function hasPublicAccount(state: DesktopPublicAccountState): boolean {
  return state.status === 'signedIn'
    || (state.status === 'unavailable' && state.account !== null)
}

function sameCredential(
  current: DesktopSessionCredential | null,
  candidate: DesktopPrivateSessionCredential,
): boolean {
  return current !== null
    && current.token === candidate.token
    && current.expiresAt === candidate.expiresAt
}

function copyCredential(credential: DesktopPrivateSessionCredential): DesktopSessionCredential {
  return { token: credential.token, expiresAt: credential.expiresAt }
}

function accountFailure(problem: DesktopAccountProblem): DesktopAccountApiError {
  return new DesktopAccountApiError(problem)
}

function accountProblem(cause: unknown): DesktopAccountProblem {
  return cause instanceof DesktopAccountApiError ? cause.problem : 'serviceUnavailable'
}

function safeFailure(cause: unknown, problem = accountProblem(cause)): DesktopAccountApiError {
  if (cause instanceof DesktopAccountApiError) return cause
  if (cause instanceof DesktopAccountRequestCancelledError) return accountFailure('serviceUnavailable')
  if (cause instanceof DesktopSessionChangedError) return accountFailure('serviceUnavailable')
  return accountFailure(problem)
}
