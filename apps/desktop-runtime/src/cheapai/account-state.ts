import type {
  DesktopAccountData,
  DesktopAccountProblem,
  DesktopPublicAccountState,
  DesktopPublicUser,
} from '@sub2api/desktop-contracts'
import {
  resolveDshAccountHome,
  type DshAccountHomeScope,
} from '../dsh/paths.ts'

export type DesktopAccountOperation = 'restore' | 'login' | 'refresh' | 'logout'
export type DesktopAccountGeneration = number
export type DesktopAccountStateListener = (state: DesktopPublicAccountState) => void

export interface DshAccountBindingLifecycle {
  readonly accountHome: string | undefined
  bindHome(
    home: string | undefined,
    isCurrent: () => boolean,
    beforeStop: () => Promise<void>,
  ): Promise<boolean>
}

export interface DesktopDshAccountBindingOptions {
  readonly state: Pick<DesktopAccountStateStore, 'isCurrent'>
  readonly lifecycle: DshAccountBindingLifecycle
  readonly baseHome: string
  readonly scope: DshAccountHomeScope
  /** Dispose the old account's bridge/transport before DshLifecycle stops its child. */
  readonly beforeChange: () => Promise<void>
}

/**
 * Account-to-home binding for L06. The Token is deliberately absent: backend
 * user id selects persistent history, while the account-state generation
 * prevents a late login/restore response from re-binding an older account.
 */
export class DesktopDshAccountBinding {
  private boundUserId: string | undefined
  private boundHome: string | undefined

  constructor(private readonly options: DesktopDshAccountBindingOptions) {}

  bind(generation: DesktopAccountGeneration, userId: string): Promise<boolean> {
    if (!this.options.state.isCurrent(generation)) return Promise.resolve(false)
    const home = resolveDshAccountHome(this.options.baseHome, userId, this.options.scope)
    if (this.boundUserId === userId
      && this.boundHome === home
      && this.options.lifecycle.accountHome === home) {
      return Promise.resolve(true)
    }

    return this.options.lifecycle.bindHome(
      home,
      () => this.options.state.isCurrent(generation),
      this.options.beforeChange,
    ).then(bound => {
      if (!bound || !this.options.state.isCurrent(generation)) return false
      this.boundUserId = userId
      this.boundHome = home
      return true
    })
  }

  /** Clear the active binding without deleting that account's DSH history. */
  unbind(generation: DesktopAccountGeneration): Promise<boolean> {
    if (!this.options.state.isCurrent(generation)) return Promise.resolve(false)
    return this.options.lifecycle.bindHome(
      undefined,
      () => this.options.state.isCurrent(generation),
      this.options.beforeChange,
    ).then(unbound => {
      if (!unbound || !this.options.state.isCurrent(generation)) return false
      this.boundUserId = undefined
      this.boundHome = undefined
      return true
    })
  }
}

const SIGNED_OUT: DesktopPublicAccountState = Object.freeze({ status: 'signedOut' as const })

/** Public-only Runtime account state with a generation guard for asynchronous
 * login, restore, refresh, and logout responses. Tokens and Keys belong in the
 * private credential/session layer and are never accepted or retained here.
 */
export class DesktopAccountStateStore {
  private currentGeneration = 0
  private currentState: DesktopPublicAccountState = SIGNED_OUT
  private readonly listeners = new Set<DesktopAccountStateListener>()

  get generation(): DesktopAccountGeneration {
    return this.currentGeneration
  }

  getSnapshot(): DesktopPublicAccountState {
    return this.currentState
  }

  subscribe(listener: DesktopAccountStateListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Start a new operation and make any earlier async result stale. Restore or
   * login shows a loading state only when there is no known account to retain.
   */
  begin(operation: DesktopAccountOperation): DesktopAccountGeneration {
    const generation = this.nextGeneration()
    if ((operation === 'restore' || operation === 'login') && !hasKnownAccount(this.currentState)) {
      this.publish({ status: 'restoring' })
    }
    return generation
  }

  isCurrent(generation: DesktopAccountGeneration): boolean {
    return Number.isSafeInteger(generation) && generation === this.currentGeneration
  }

  setSignedIn(
    generation: DesktopAccountGeneration,
    account: DesktopAccountData,
    expiresAt: number,
  ): boolean {
    if (!this.isCurrent(generation) || !isTimestamp(expiresAt)) return false
    this.publish({ status: 'signedIn', account: projectAccount(account), expiresAt })
    return true
  }

  /** Refreshes only the public account projection, preserving the current
   * Token deadline. A stale or expired session cannot be restored this way.
   */
  setAccount(generation: DesktopAccountGeneration, account: DesktopAccountData): boolean {
    if (!this.isCurrent(generation)) return false
    const expiresAt = stateExpiresAt(this.currentState)
    if (expiresAt === null) return false
    this.publish({ status: 'signedIn', account: projectAccount(account), expiresAt })
    return true
  }

  /** Preserve the last public account through recoverable failures. Only an
   * authenticated-session failure removes its account/deadline projection; the
   * host decides whether its separately stored Token is deleted or retried.
   */
  setUnavailable(
    generation: DesktopAccountGeneration,
    problem: DesktopAccountProblem,
  ): boolean {
    if (!this.isCurrent(generation)) return false
    if (problem === 'sessionExpired') {
      this.publish({ status: 'unavailable', account: null, expiresAt: null, problem })
      return true
    }
    const { account, expiresAt } = stateAccountAndExpiry(this.currentState)
    this.publish({ status: 'unavailable', account, expiresAt, problem })
    return true
  }

  /** Complete a successful logout and invalidate every response from the
   * outgoing session. Call only after the caller has handled private storage.
   */
  finishLogout(generation: DesktopAccountGeneration): boolean {
    if (!this.isCurrent(generation)) return false
    this.nextGeneration()
    this.publish(SIGNED_OUT)
    return true
  }

  /** Drop a projection during explicit account replacement or credential
   * invalidation, while making all outstanding operations stale.
   */
  reset(): void {
    this.nextGeneration()
    this.publish(SIGNED_OUT)
  }

  private nextGeneration(): DesktopAccountGeneration {
    if (this.currentGeneration >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError('Desktop account operation generation is exhausted.')
    }
    this.currentGeneration += 1
    return this.currentGeneration
  }

  private publish(state: DesktopPublicAccountState): void {
    this.currentState = projectState(state)
    const snapshot = this.getSnapshot()
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot)
      } catch {
        // Observers cannot turn an already committed account state into a failure.
      }
    }
  }
}

function projectState(state: DesktopPublicAccountState): DesktopPublicAccountState {
  switch (state.status) {
    case 'signedOut':
      return SIGNED_OUT
    case 'restoring':
      return Object.freeze({ status: 'restoring' })
    case 'signedIn':
      return Object.freeze({
        status: 'signedIn',
        account: projectAccount(state.account),
        expiresAt: state.expiresAt,
      })
    case 'unavailable':
      return Object.freeze({
        status: 'unavailable',
        account: state.account === null ? null : projectAccount(state.account),
        expiresAt: state.expiresAt,
        problem: state.problem,
      })
  }
}

function projectAccount(account: DesktopAccountData): DesktopAccountData {
  return Object.freeze({
    user: projectUser(account.user),
    balance: Object.freeze({
      currency: 'USD' as const,
      decimals: 8 as const,
      balance_units: account.balance.balance_units,
      balance_usd: account.balance.balance_usd,
    }),
  })
}

function projectUser(user: DesktopPublicUser): DesktopPublicUser {
  return Object.freeze({
    id: user.id,
    email_normalized: user.email_normalized,
    role: user.role,
    status: user.status,
    group_id: user.group_id,
    group_status: user.group_status,
    balance_units: user.balance_units,
    email_verified_at: user.email_verified_at,
  })
}

function stateExpiresAt(state: DesktopPublicAccountState): number | null {
  if (state.status === 'signedIn') return state.expiresAt
  if (state.status === 'unavailable') return state.expiresAt
  return null
}

function stateAccountAndExpiry(state: DesktopPublicAccountState): {
  readonly account: DesktopAccountData | null
  readonly expiresAt: number | null
} {
  if (state.status === 'signedIn') {
    return { account: projectAccount(state.account), expiresAt: state.expiresAt }
  }
  if (state.status === 'unavailable') {
    return {
      account: state.account === null ? null : projectAccount(state.account),
      expiresAt: state.expiresAt,
    }
  }
  return { account: null, expiresAt: null }
}

function hasKnownAccount(state: DesktopPublicAccountState): boolean {
  return state.status === 'signedIn' || (state.status === 'unavailable' && state.account !== null)
}

function isTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}
