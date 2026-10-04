import type {
  DesktopAccountProblem,
  DesktopLoginRequest,
  DesktopPublicAccountState,
} from '@sub2api/desktop-contracts'
import {
  createDesktopAccountAdapter,
  DesktopAccountAdapterError,
  projectDesktopPublicAccountState,
  type DesktopAccountAdapter,
} from '../../adapters/native/account'

export type DesktopAuthOperation = 'login' | 'restore' | 'refresh' | 'logout'

export interface DesktopAuthStoreSnapshot {
  readonly accountState: DesktopPublicAccountState
  readonly available: boolean
  readonly pendingOperation: DesktopAuthOperation | null
  readonly generation: number
}

const SIGNED_OUT: DesktopPublicAccountState = Object.freeze({ status: 'signedOut' })
const noop = (): void => {}

/** Stable external store for the safe account projection; passwords are never retained. */
export class DesktopAuthStore {
  private snapshot: DesktopAuthStoreSnapshot
  private generation = 0
  private pendingOperation: DesktopAuthOperation | null = null
  private restoreFlight: Promise<DesktopPublicAccountState> | undefined
  private nativeUnsubscribe: (() => void) | undefined
  private disposed = false
  private readonly listeners = new Set<() => void>()

  constructor(private readonly adapter: DesktopAccountAdapter = createDesktopAccountAdapter()) {
    const initialState: DesktopPublicAccountState = adapter.available
      ? SIGNED_OUT
      : Object.freeze({ status: 'unavailable', account: null, expiresAt: null, problem: 'serviceUnavailable' })
    this.snapshot = Object.freeze({
      accountState: initialState,
      available: adapter.available,
      pendingOperation: null,
      generation: 0,
    })
  }

  readonly getSnapshot = (): DesktopAuthStoreSnapshot => this.snapshot

  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return noop
    this.listeners.add(listener)
    this.ensureNativeSubscription()
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) this.releaseNativeSubscription()
    }
  }

  login(credentials: DesktopLoginRequest): Promise<DesktopPublicAccountState> {
    return this.run('login', () => this.adapter.login({
      email: credentials.email,
      password: credentials.password,
    }))
  }

  restore(): Promise<DesktopPublicAccountState> {
    if (this.restoreFlight !== undefined) return this.restoreFlight
    let wrapped!: Promise<DesktopPublicAccountState>
    wrapped = this.run('restore', () => this.adapter.restore()).finally(() => {
      if (this.restoreFlight === wrapped) this.restoreFlight = undefined
    })
    this.restoreFlight = wrapped
    return wrapped
  }

  refresh(): Promise<DesktopPublicAccountState> {
    return this.run('refresh', () => this.adapter.refresh())
  }

  logout(): Promise<DesktopPublicAccountState> {
    return this.run('logout', () => this.adapter.logout())
  }

  /** Release the Tauri event listener and invalidate every pending command result. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.advanceGeneration()
    this.pendingOperation = null
    this.releaseNativeSubscription()
    this.listeners.clear()
    this.publish(this.snapshot.accountState)
  }

  private async run(
    operation: DesktopAuthOperation,
    invokeOperation: () => Promise<DesktopPublicAccountState>,
  ): Promise<DesktopPublicAccountState> {
    if (this.disposed) throw new DesktopAccountAdapterError('unavailable', 'serviceUnavailable')
    if (!this.adapter.available) {
      const error = new DesktopAccountAdapterError('unavailable', 'serviceUnavailable')
      const generation = this.advanceGeneration()
      if (this.isCurrent(generation)) {
        this.pendingOperation = null
        this.publish(unavailableState(this.snapshot.accountState, error.problem), generation)
      }
      throw error
    }

    this.ensureNativeSubscription()
    const generation = this.advanceGeneration()
    this.pendingOperation = operation
    this.publish(this.snapshot.accountState, generation)

    try {
      const result = await invokeOperation()
      if (!this.isCurrent(generation)) return this.snapshot.accountState
      const safeState = projectDesktopPublicAccountState(result)
      this.pendingOperation = null
      const state = preserveKnownAccount(this.snapshot.accountState, safeState)
      this.publish(state, generation)
      return state
    } catch (cause) {
      if (!this.isCurrent(generation)) return this.snapshot.accountState
      const problem = cause instanceof DesktopAccountAdapterError
        ? cause.problem
        : 'serviceUnavailable'
      const state = unavailableState(this.snapshot.accountState, problem)
      this.pendingOperation = null
      this.publish(state, generation)
      throw cause instanceof DesktopAccountAdapterError
        ? cause
        : new DesktopAccountAdapterError('command-failed', problem)
    }
  }

  private ensureNativeSubscription(): void {
    if (this.nativeUnsubscribe !== undefined || this.disposed || !this.adapter.available) return
    try {
      this.nativeUnsubscribe = this.adapter.subscribe(state => {
        if (this.disposed || this.pendingOperation !== null) return
        const safeState = projectDesktopPublicAccountState(state)
        this.publish(preserveKnownAccount(this.snapshot.accountState, safeState), this.generation)
      })
    } catch {
      // Command responses remain authoritative when event subscription is unavailable.
    }
  }

  private releaseNativeSubscription(): void {
    const unsubscribe = this.nativeUnsubscribe
    this.nativeUnsubscribe = undefined
    try { unsubscribe?.() } catch { /* Native event cleanup is best-effort. */ }
  }

  private advanceGeneration(): number {
    if (this.generation >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError('Desktop account operation generation is exhausted.')
    }
    this.generation += 1
    return this.generation
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.generation
  }

  private publish(accountState: DesktopPublicAccountState, generation = this.generation): void {
    const safeState = projectDesktopPublicAccountState(accountState)
    this.snapshot = Object.freeze({
      accountState: safeState,
      available: this.adapter.available,
      pendingOperation: this.pendingOperation,
      generation,
    })
    for (const listener of [...this.listeners]) {
      try { listener() } catch { /* Subscribers cannot corrupt committed account state. */ }
    }
  }
}

export function createDesktopAuthStore(adapter?: DesktopAccountAdapter): DesktopAuthStore {
  return new DesktopAuthStore(adapter)
}

function preserveKnownAccount(
  previous: DesktopPublicAccountState,
  next: DesktopPublicAccountState,
): DesktopPublicAccountState {
  if (next.status !== 'unavailable' || next.account !== null || next.problem === 'sessionExpired') return next
  const known = knownAccount(previous)
  if (known === null) return next
  return Object.freeze({
    status: 'unavailable',
    account: known.account,
    expiresAt: known.expiresAt,
    problem: next.problem,
  })
}

function unavailableState(
  previous: DesktopPublicAccountState,
  problem: DesktopAccountProblem,
): DesktopPublicAccountState {
  if (problem === 'sessionExpired') {
    return Object.freeze({ status: 'unavailable', account: null, expiresAt: null, problem })
  }
  const known = knownAccount(previous)
  return Object.freeze({
    status: 'unavailable',
    account: known?.account ?? null,
    expiresAt: known?.expiresAt ?? null,
    problem,
  })
}

function knownAccount(state: DesktopPublicAccountState): {
  readonly account: Extract<DesktopPublicAccountState, { readonly status: 'signedIn' }>['account']
  readonly expiresAt: number
} | null {
  if (state.status === 'signedIn') return { account: state.account, expiresAt: state.expiresAt }
  if (state.status === 'unavailable' && state.account !== null && state.expiresAt !== null) {
    return { account: state.account, expiresAt: state.expiresAt }
  }
  return null
}
