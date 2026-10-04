import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type {
  DesktopAccountData,
  DesktopAccountProblem,
  DesktopLoginRequest,
  DesktopPublicAccountState,
  DesktopPublicUser,
} from '@sub2api/desktop-contracts'

export type DesktopAccountCommandName =
  | 'desktop_account_login'
  | 'desktop_account_restore'
  | 'desktop_account_refresh'
  | 'desktop_account_logout'

export class DesktopAccountAdapterError extends Error {
  constructor(
    readonly code: 'unavailable' | 'command-failed' | 'invalid-response',
    readonly problem: DesktopAccountProblem,
  ) {
    super(problemMessage(problem))
    this.name = 'DesktopAccountAdapterError'
  }
}

/** Renderer-facing account boundary. It contains no Token or model Key operation. */
export interface DesktopAccountAdapter {
  readonly available: boolean
  subscribe(listener: (state: DesktopPublicAccountState) => void): () => void
  login(credentials: DesktopLoginRequest): Promise<DesktopPublicAccountState>
  restore(): Promise<DesktopPublicAccountState>
  refresh(): Promise<DesktopPublicAccountState>
  logout(): Promise<DesktopPublicAccountState>
}

/** Select the native Tauri bridge when present; browser mode is explicitly unavailable. */
export function createDesktopAccountAdapter(): DesktopAccountAdapter {
  if (!isTauri()) return createUnavailableDesktopAccountAdapter()

  return Object.freeze({
    available: true,
    subscribe: subscribeToNativeAccountState,
    login: (credentials: DesktopLoginRequest) => invokeState('desktop_account_login', {
      email: credentials.email,
      password: credentials.password,
    }),
    restore: () => invokeState('desktop_account_restore'),
    refresh: () => invokeState('desktop_account_refresh'),
    logout: () => invokeState('desktop_account_logout'),
  })
}

export function createUnavailableDesktopAccountAdapter(): DesktopAccountAdapter {
  const unavailable = (): Promise<DesktopPublicAccountState> => Promise.reject(
    new DesktopAccountAdapterError('unavailable', 'serviceUnavailable'),
  )
  return Object.freeze({
    available: false,
    subscribe: () => () => {},
    login: unavailable,
    restore: unavailable,
    refresh: unavailable,
    logout: unavailable,
  })
}

/** Validate and copy the public projection so an accidental private field is never retained. */
export function projectDesktopPublicAccountState(value: unknown): DesktopPublicAccountState {
  if (!isRecord(value) || typeof value.status !== 'string') return invalidResponse()
  switch (value.status) {
    case 'signedOut':
      return Object.freeze({ status: 'signedOut' })
    case 'restoring':
      return Object.freeze({ status: 'restoring' })
    case 'signedIn': {
      if (!isDesktopAccountData(value.account) || !isTimestamp(value.expiresAt)) return invalidResponse()
      return Object.freeze({
        status: 'signedIn',
        account: projectAccount(value.account),
        expiresAt: value.expiresAt,
      })
    }
    case 'unavailable': {
      if (value.account !== null && !isDesktopAccountData(value.account)) return invalidResponse()
      if (value.expiresAt !== null && !isTimestamp(value.expiresAt)) return invalidResponse()
      if (!isAccountProblem(value.problem)) return invalidResponse()
      return Object.freeze({
        status: 'unavailable',
        account: value.account === null ? null : projectAccount(value.account),
        expiresAt: value.expiresAt,
        problem: value.problem,
      })
    }
    default:
      return invalidResponse()
  }
}

async function invokeState(
  command: DesktopAccountCommandName,
  args?: { readonly email: string; readonly password: string },
): Promise<DesktopPublicAccountState> {
  try {
    const result = args === undefined
      ? await invoke<unknown>(command)
      : await invoke<unknown>(command, args)
    return projectDesktopPublicAccountState(result)
  } catch (error) {
    if (error instanceof DesktopAccountAdapterError) throw error
    if (isRecord(error) && isAccountProblem(error.code)) {
      throw new DesktopAccountAdapterError('command-failed', error.code)
    }
    throw new DesktopAccountAdapterError('command-failed', 'serviceUnavailable')
  }
}

function subscribeToNativeAccountState(listener: (state: DesktopPublicAccountState) => void): () => void {
  let disposed = false
  let unlisten: UnlistenFn | undefined
  void listen<unknown>('desktop-account-state', event => {
    if (disposed) return
    try {
      listener(projectDesktopPublicAccountState(event.payload))
    } catch {
      // Malformed host events are ignored and never copied into renderer state.
    }
  }).then(unsubscribe => {
    if (disposed) unsubscribe()
    else unlisten = unsubscribe
  }).catch(() => {
    // Command responses remain usable if the native event channel is unavailable.
  })
  return () => {
    disposed = true
    unlisten?.()
    unlisten = undefined
  }
}

function isDesktopAccountData(value: unknown): value is DesktopAccountData {
  if (!isRecord(value) || !isDesktopPublicUser(value.user) || !isRecord(value.balance)) return false
  return value.balance.currency === 'USD'
    && value.balance.decimals === 8
    && typeof value.balance.balance_units === 'string'
    && typeof value.balance.balance_usd === 'string'
}

function isDesktopPublicUser(value: unknown): value is DesktopPublicUser {
  return isRecord(value)
    && isPublicId(value.id)
    && typeof value.email_normalized === 'string'
    && (value.role === 'user' || value.role === 'admin')
    && (value.status === 'active' || value.status === 'disabled')
    && isPublicId(value.group_id)
    && (value.group_status === 'active' || value.group_status === 'disabled')
    && typeof value.balance_units === 'string'
    && (value.email_verified_at === null || isTimestamp(value.email_verified_at))
}

function projectAccount(account: DesktopAccountData): DesktopAccountData {
  return Object.freeze({
    user: Object.freeze({
      id: account.user.id,
      email_normalized: account.user.email_normalized,
      role: account.user.role,
      status: account.user.status,
      group_id: account.user.group_id,
      group_status: account.user.group_status,
      balance_units: account.user.balance_units,
      email_verified_at: account.user.email_verified_at,
    }),
    balance: Object.freeze({
      currency: 'USD' as const,
      decimals: 8 as const,
      balance_units: account.balance.balance_units,
      balance_usd: account.balance.balance_usd,
    }),
  })
}

function invalidResponse(): never {
  throw new DesktopAccountAdapterError('invalid-response', 'serviceUnavailable')
}

function isPublicId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 128
    && !/[\u0000-\u001f\u007f]/u.test(value)
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isAccountProblem(value: unknown): value is DesktopAccountProblem {
  return value === 'network'
    || value === 'serviceUnavailable'
    || value === 'noModels'
    || value === 'sessionExpired'
    || value === 'keyRevoked'
    || value === 'insufficientBalance'
    || value === 'groupUnavailable'
}

function problemMessage(problem: DesktopAccountProblem): string {
  switch (problem) {
    case 'network': return 'The desktop account service could not be reached.'
    case 'sessionExpired': return 'The desktop login has expired or is no longer valid.'
    case 'keyRevoked': return 'The account Key has been revoked.'
    case 'insufficientBalance': return 'The account balance is insufficient.'
    case 'groupUnavailable': return 'The account group is unavailable.'
    case 'serviceUnavailable': return 'The desktop account service is unavailable.'
    case 'noModels': return 'This account currently has no available models.'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
