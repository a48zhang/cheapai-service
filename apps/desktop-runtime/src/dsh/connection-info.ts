import { randomUUID } from 'node:crypto'

const READY_LINE_PREFIX = 'dsh web: '
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/
const DSH_AUTH_COOKIE_PREFIX = 'dsh-auth-'

export type DshConnectionProbeStage = 'browser-authentication' | 'host-api-handshake'

export interface ParsedDshWebUrl {
  /** The process-token URL emitted by the pinned DSH web-app bundle. Keep private. */
  readonly authenticatedUrl: string
  readonly origin: string
  readonly port: number
}

/** Private transport details for the local DSH Host. Do not place `auth` in page state or logs. */
export interface DshConnectionInfo {
  readonly origin: string
  readonly httpBaseUrl: string
  /** Root WebSocket authority; the DSH Remote mux is at `/api/remote.mux`. */
  readonly streamBaseUrl: string
  readonly port: number
  readonly auth: {
    readonly type: 'dsh-browser-cookie'
    /** Authority-bound cookie minted by DSH's process-token exchange. */
    readonly cookie: string
  }
}

export type DshFetch = (input: string | URL, init?: RequestInit) => Promise<Response>

export interface ConnectDshHostOptions {
  readonly signal: AbortSignal
  readonly fetch?: DshFetch
  readonly onStage?: (stage: DshConnectionProbeStage) => void
}

export class DshConnectionProbeError extends Error {
  constructor(
    readonly stage: 'announcement' | DshConnectionProbeStage,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'DshConnectionProbeError'
  }
}

/**
 * Parse only the pinned web-app's documented URL announcement. This discovers
 * the OS-assigned port and process token; it is not itself a readiness check.
 */
export function parseDshWebReadyLine(line: string): ParsedDshWebUrl | undefined {
  if (!line.startsWith(READY_LINE_PREFIX)) return undefined
  const announcedUrl = line.slice(READY_LINE_PREFIX.length)

  let url: URL
  try {
    url = new URL(announcedUrl)
  } catch (cause) {
    throw new DshConnectionProbeError('announcement', 'DSH emitted an invalid Web URL announcement', { cause })
  }

  const tokens = url.searchParams.getAll('token')
  const port = Number(url.port)
  if (url.protocol !== 'http:'
    || url.hostname !== '127.0.0.1'
    || !Number.isInteger(port)
    || port < 1
    || port > 65535
    || url.pathname !== '/'
    || url.username !== ''
    || url.password !== ''
    || url.hash !== ''
    || url.searchParams.size !== 1
    || tokens.length !== 1
    || !TOKEN_PATTERN.test(tokens[0] ?? '')) {
    throw new DshConnectionProbeError('announcement', 'DSH Web URL did not match the configured loopback profile')
  }

  return {
    authenticatedUrl: url.href,
    origin: url.origin,
    port,
  }
}

/**
 * Exchange DSH's one-process launch token for its authority-bound browser
 * cookie, then prove the Host RPC is mounted with the read-only settings.describe
 * Remote. A printed URL alone never makes the lifecycle ready.
 */
export async function connectDshHost(
  announcedUrl: ParsedDshWebUrl,
  options: ConnectDshHostOptions,
): Promise<DshConnectionInfo> {
  const fetcher = options.fetch ?? globalThis.fetch

  options.onStage?.('browser-authentication')
  let authResponse: Response
  try {
    authResponse = await fetcher(announcedUrl.authenticatedUrl, {
      method: 'GET',
      redirect: 'manual',
      signal: options.signal,
    })
  } catch (cause) {
    throw new DshConnectionProbeError(
      'browser-authentication',
      'Could not exchange the DSH process token for a browser session',
      { cause },
    )
  }

  const cookie = sessionCookie(authResponse)
  options.signal.throwIfAborted()

  options.onStage?.('host-api-handshake')
  const rpcId = randomUUID()
  let response: Response
  try {
    response = await fetcher(new URL('/api/settings/describe', announcedUrl.origin), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: announcedUrl.origin,
      },
      body: JSON.stringify({
        type: 'client-request',
        rpcId,
        method: 'describe',
        payload: { args: {} },
      }),
      signal: options.signal,
    })
  } catch (cause) {
    throw new DshConnectionProbeError(
      'host-api-handshake',
      'The DSH settings.describe Host API request failed',
      { cause },
    )
  }

  if (!response.ok) {
    throw new DshConnectionProbeError(
      'host-api-handshake',
      `The DSH settings.describe Host API returned HTTP ${response.status}`,
    )
  }

  let envelope: unknown
  try {
    envelope = await response.json()
  } catch (cause) {
    throw new DshConnectionProbeError(
      'host-api-handshake',
      'The DSH settings.describe Host API returned invalid JSON',
      { cause },
    )
  }
  if (!isRecord(envelope)
    || envelope.type !== 'server-response'
    || envelope.rpcId !== rpcId
    || !isRecord(envelope.result)
    || envelope.result.ok !== true
    || !isRecord(envelope.result.value)
    || !Array.isArray(envelope.result.value.namespaces)) {
    throw new DshConnectionProbeError(
      'host-api-handshake',
      'The DSH settings.describe Host API did not return a successful Remote response',
    )
  }

  const streamUrl = new URL(announcedUrl.origin)
  streamUrl.protocol = 'ws:'
  return Object.freeze({
    origin: announcedUrl.origin,
    httpBaseUrl: `${announcedUrl.origin}/`,
    streamBaseUrl: streamUrl.href,
    port: announcedUrl.port,
    auth: Object.freeze({
      type: 'dsh-browser-cookie' as const,
      cookie,
    }),
  })
}

function sessionCookie(response: Response): string {
  if (response.status !== 303 || response.headers.get('location') !== './') {
    throw new DshConnectionProbeError(
      'browser-authentication',
      `The DSH process-token exchange returned HTTP ${response.status}`,
    )
  }

  const setCookie = response.headers.get('set-cookie')
  const cookie = setCookie?.split(';', 1)[0]
  if (cookie === undefined
    || !cookie.startsWith(DSH_AUTH_COOKIE_PREFIX)
    || !/^dsh-auth-[^=;]+=([A-Za-z0-9_-]+)$/.test(cookie)) {
    throw new DshConnectionProbeError(
      'browser-authentication',
      'The DSH process-token exchange did not set its browser-session cookie',
    )
  }
  return cookie
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
