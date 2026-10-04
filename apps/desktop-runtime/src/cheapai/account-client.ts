import type {
  ApiErrorCode,
  DesktopAccountData,
  DesktopKeyResponse,
  DesktopLoginRequest,
  DesktopLoginResponse,
  DesktopPublicUser,
} from '@sub2api/desktop-contracts'
import type { DesktopAccountProblem } from '@sub2api/desktop-contracts'

const DESKTOP_LOGIN_PATH = '/api/v1/desktop/login'
const DESKTOP_KEY_PATH = '/api/v1/desktop/key'
const DESKTOP_ACCOUNT_PATH = '/api/v1/desktop/account'
const DESKTOP_LOGOUT_PATH = '/api/v1/desktop/logout'
const DEFAULT_TIMEOUT_MS = 15_000

type DesktopErrorReason =
  | 'invalid_token'
  | 'session_expired'
  | 'session_revoked'
  | 'user_inactive'
  | 'group_unavailable'
  | 'key_revoked'
  | 'binding_unavailable'
  | 'key_creation_unavailable'

export interface DesktopAccountRequestOptions {
  readonly signal?: AbortSignal
}

export interface DesktopAccountClientOptions {
  /** Origin or reverse-proxy prefix serving the Worker management API. */
  readonly baseUrl: string
  readonly fetch?: typeof fetch
  readonly timeoutMs?: number
}

export interface DesktopSessionCredential {
  readonly token: string
  readonly expiresAt: number
}

/** A cancellation requested by the caller is kept separate from a network error. */
export class DesktopAccountRequestCancelledError extends Error {
  constructor() {
    super('Desktop account request was cancelled.')
    this.name = 'DesktopAccountRequestCancelledError'
  }
}

/** Safe account API failure. It never retains the request, response body, or credentials. */
export class DesktopAccountApiError extends Error {
  constructor(
    readonly problem: DesktopAccountProblem,
    readonly code: ApiErrorCode | null = null,
    readonly requestId: string | null = null,
    readonly httpStatus: number | null = null,
  ) {
    super(problemMessage(problem))
    this.name = 'DesktopAccountApiError'
  }
}

interface RequestSettings extends DesktopAccountRequestOptions {
  readonly method: 'GET' | 'POST'
  readonly token?: string
  readonly body?: unknown
}

/** Typed client for the private desktop bearer endpoints. Callers keep returned
 * credentials inside Runtime/host code and pass only account-state projections
 * to the renderer.
 */
export class DesktopAccountClient {
  private readonly baseUrl: URL
  private readonly fetcher: typeof fetch
  private readonly timeoutMs: number

  constructor(options: DesktopAccountClientOptions) {
    this.baseUrl = normalizeApiBaseUrl(options.baseUrl)
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 300_000) {
      throw new TypeError('Desktop account request timeout is invalid.')
    }
  }

  async login(
    credentials: DesktopLoginRequest,
    options: DesktopAccountRequestOptions = {},
  ): Promise<DesktopLoginResponse> {
    if (typeof credentials?.email !== 'string' || credentials.email.length === 0
      || typeof credentials.password !== 'string' || credentials.password.length > 256) {
      throw new DesktopAccountApiError('serviceUnavailable', 'invalid_request')
    }
    const response = await this.request(DESKTOP_LOGIN_PATH, {
      method: 'POST',
      body: { email: credentials.email, password: credentials.password },
      ...options,
    })
    const data = successData(response)
    if (!isRecord(data) || !isCredential(data.token) || !isTimestamp(data.expiresAt)
      || !isDesktopPublicUser(data.user)) {
      throw invalidServerResponse(response)
    }
    return { token: data.token, expiresAt: data.expiresAt, user: projectUser(data.user) }
  }

  async getKey(
    session: DesktopSessionCredential,
    options: DesktopAccountRequestOptions = {},
  ): Promise<DesktopKeyResponse> {
    if (!isCredential(session?.token) || !isTimestamp(session.expiresAt)) {
      throw new DesktopAccountApiError('sessionExpired', 'unauthorized')
    }
    const response = await this.request(DESKTOP_KEY_PATH, {
      method: 'POST', token: session.token, ...options,
    })
    const data = successData(response)
    if (!isRecord(data) || !isCredential(data.key) || !isPublicId(data.keyId)
      || !isTimestamp(data.expiresAt) || data.expiresAt > session.expiresAt) {
      throw invalidServerResponse(response)
    }
    return { key: data.key, keyId: data.keyId, expiresAt: data.expiresAt }
  }

  async getAccount(
    token: string,
    options: DesktopAccountRequestOptions = {},
  ): Promise<DesktopAccountData> {
    if (!isCredential(token)) throw new DesktopAccountApiError('sessionExpired', 'unauthorized')
    const response = await this.request(DESKTOP_ACCOUNT_PATH, { method: 'GET', token, ...options })
    const data = successData(response)
    if (!isRecord(data) || !isDesktopPublicUser(data.user) || !isBalance(data.balance)) {
      throw invalidServerResponse(response)
    }
    return {
      user: projectUser(data.user),
      balance: {
        currency: 'USD',
        decimals: 8,
        balance_units: data.balance.balance_units,
        balance_usd: data.balance.balance_usd,
      },
    }
  }

  async logout(token: string, options: DesktopAccountRequestOptions = {}): Promise<void> {
    if (!isCredential(token)) throw new DesktopAccountApiError('sessionExpired', 'unauthorized')
    const response = await this.request(DESKTOP_LOGOUT_PATH, { method: 'POST', token, ...options })
    const data = successData(response)
    if (!isRecord(data) || data.loggedOut !== true) throw invalidServerResponse(response)
  }

  private async request(path: string, settings: RequestSettings): Promise<unknown> {
    const url = new URL(path.slice(1), ensureTrailingSlash(this.baseUrl))
    const controller = new AbortController()
    const callerSignal = settings.signal
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const abortFromCaller = (): void => controller.abort()

    if (callerSignal?.aborted) throw new DesktopAccountRequestCancelledError()
    callerSignal?.addEventListener('abort', abortFromCaller, { once: true })
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.timeoutMs)

    try {
      const headers = new Headers({ accept: 'application/json' })
      const init: RequestInit = {
        method: settings.method,
        headers,
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      }
      if (settings.token !== undefined) headers.set('authorization', `Bearer ${settings.token}`)
      if (settings.body !== undefined) {
        headers.set('content-type', 'application/json')
        init.body = JSON.stringify(settings.body)
      }

      let response: Response
      try {
        response = await this.fetcher(url, init)
      } catch {
        throw requestFailure(callerSignal, timedOut)
      }

      let payload: unknown
      try {
        payload = await response.json()
      } catch {
        if (callerSignal?.aborted || timedOut) throw requestFailure(callerSignal, timedOut)
        throw new DesktopAccountApiError('serviceUnavailable', null, null, response.status)
      }

      if (!response.ok) throw responseFailure(payload, response.status)
      if (!isRecord(payload) || !Object.hasOwn(payload, 'data')) {
        throw new DesktopAccountApiError('serviceUnavailable', null, safeRequestId(payload), response.status)
      }
      return payload
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      callerSignal?.removeEventListener('abort', abortFromCaller)
    }
  }
}

function normalizeApiBaseUrl(value: string): URL {
  let base: URL
  try {
    base = new URL(value)
  } catch {
    throw new TypeError('Desktop account API base URL is invalid.')
  }
  if ((base.protocol !== 'http:' && base.protocol !== 'https:') || base.username || base.password
    || base.search || base.hash || value.trim() !== value) {
    throw new TypeError('Desktop account API base URL is invalid.')
  }
  base.pathname = `${base.pathname.replace(/\/+$/u, '')}/`
  return base
}

function ensureTrailingSlash(url: URL): URL {
  const base = new URL(url.href)
  if (!base.pathname.endsWith('/')) base.pathname += '/'
  return base
}

function successData(response: unknown): unknown {
  if (isRecord(response) && Object.hasOwn(response, 'data')) return response.data
  throw new DesktopAccountApiError('serviceUnavailable')
}

function responseFailure(payload: unknown, status: number): DesktopAccountApiError {
  const error = isRecord(payload) && isRecord(payload.error) ? payload.error : null
  const code = error !== null && isApiErrorCode(error.code) ? error.code : null
  const requestId = safeRequestId(payload)
  const reason = error !== null && isDesktopErrorReason(error.reason) ? error.reason : null
  return new DesktopAccountApiError(classifyError(code, reason), code, requestId, status)
}

function classifyError(code: ApiErrorCode | null, reason: DesktopErrorReason | null): DesktopAccountProblem {
  if (reason === 'key_revoked') return 'keyRevoked'
  if (reason === 'group_unavailable' || code === 'forbidden') return 'groupUnavailable'
  if (reason === 'session_expired' || reason === 'session_revoked' || reason === 'invalid_token'
    || reason === 'user_inactive' || code === 'unauthorized') return 'sessionExpired'
  if (code === 'insufficient_balance') return 'insufficientBalance'
  return 'serviceUnavailable'
}

function requestFailure(signal: AbortSignal | undefined, timedOut: boolean): Error {
  if (!timedOut && signal?.aborted) return new DesktopAccountRequestCancelledError()
  return new DesktopAccountApiError('network')
}

function invalidServerResponse(response: unknown): DesktopAccountApiError {
  return new DesktopAccountApiError(
    'serviceUnavailable', null, safeRequestId(response), null,
  )
}

function problemMessage(problem: DesktopAccountProblem): string {
  switch (problem) {
    case 'network': return 'The desktop account service could not be reached.'
    case 'sessionExpired': return 'The desktop login has expired or is no longer valid.'
    case 'keyRevoked': return 'The account Key has been revoked.'
    case 'insufficientBalance': return 'The account balance is insufficient.'
    case 'groupUnavailable': return 'The account group is unavailable.'
    case 'serviceUnavailable': return 'The desktop account service is unavailable.'
  }
}

function projectUser(value: DesktopPublicUser): DesktopPublicUser {
  return {
    id: value.id,
    email_normalized: value.email_normalized,
    role: value.role,
    status: value.status,
    group_id: value.group_id,
    group_status: value.group_status,
    balance_units: value.balance_units,
    email_verified_at: value.email_verified_at,
  }
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

function isBalance(value: unknown): value is DesktopAccountData['balance'] {
  return isRecord(value) && value.currency === 'USD' && value.decimals === 8
    && typeof value.balance_units === 'string' && typeof value.balance_usd === 'string'
}

function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return value === 'invalid_request' || value === 'unauthorized' || value === 'insufficient_balance'
    || value === 'forbidden' || value === 'not_found' || value === 'conflict'
    || value === 'payload_too_large' || value === 'rate_limited' || value === 'internal_error'
    || value === 'service_unavailable'
}

function isDesktopErrorReason(value: unknown): value is DesktopErrorReason {
  return value === 'invalid_token' || value === 'session_expired' || value === 'session_revoked'
    || value === 'user_inactive' || value === 'group_unavailable' || value === 'key_revoked'
    || value === 'binding_unavailable' || value === 'key_creation_unavailable'
}

function safeRequestId(value: unknown): string | null {
  if (!isRecord(value) || typeof value.request_id !== 'string'
    || !/^[A-Za-z0-9_-]{1,128}$/u.test(value.request_id)) return null
  return value.request_id
}

function isCredential(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096
    && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value)
}

function isPublicId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
    && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value)
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
