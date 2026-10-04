import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DesktopAccountData, DesktopPublicUser } from '@sub2api/desktop-contracts'

export type FakeDesktopApiOperation = 'login' | 'key' | 'account' | 'logout'

export interface FakeDesktopApiCall {
  readonly operation: FakeDesktopApiOperation
  readonly method: string
  readonly hasAuthorization: boolean
}

export interface DeferredFakeAccountResponse {
  /** Complete the delayed route with a successful Worker-style `{ data }` envelope. */
  resolve(data: unknown): void
  /** Fail the fetch itself, as a disconnected or unreachable account service would. */
  rejectNetwork(): void
}

const API_PATHS: Readonly<Record<FakeDesktopApiOperation, string>> = Object.freeze({
  login: '/api/v1/desktop/login',
  key: '/api/v1/desktop/key',
  account: '/api/v1/desktop/account',
  logout: '/api/v1/desktop/logout',
})

/**
 * A local-only account API fixture. It records route shape without retaining
 * request bodies or bearer values and owns a disposable DSH home for path tests.
 */
export class FakeDesktopAccountApi {
  readonly calls: FakeDesktopApiCall[] = []
  readonly dshBaseHome: string
  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    const operation = operationForPath(url.pathname)
    const headers = new Headers(init?.headers)
    this.calls.push({
      operation,
      method: init?.method ?? 'GET',
      hasAuthorization: headers.has('authorization'),
    })
    this.resolveCallWaiters()

    const response = this.responses.get(operation)?.shift()
    return response === undefined ? successResponse(defaultData(operation)) : response()
  }

  private readonly responses = new Map<FakeDesktopApiOperation, Array<() => Promise<Response>>>()
  private readonly pendingGates = new Set<() => void>()
  private readonly callWaiters = new Set<{
    readonly operation: FakeDesktopApiOperation
    readonly count: number
    readonly resolve: () => void
  }>()

  private constructor(readonly rootDirectory: string) {
    this.dshBaseHome = join(rootDirectory, 'dsh-home')
  }

  static async create(): Promise<FakeDesktopAccountApi> {
    const rootDirectory = await mkdtemp(join(tmpdir(), 'sub2api-desktop-account-'))
    const fixture = new FakeDesktopAccountApi(rootDirectory)
    await mkdir(fixture.dshBaseHome, { recursive: true })
    return fixture
  }

  enqueueData(operation: FakeDesktopApiOperation, data: unknown): void {
    this.enqueue(operation, () => Promise.resolve(successResponse(data)))
  }

  enqueueError(
    operation: FakeDesktopApiOperation,
    code: string,
    status = 503,
    reason?: string,
  ): void {
    this.enqueue(operation, () => Promise.resolve(errorResponse(code, status, reason)))
  }

  enqueueNetworkFailure(operation: FakeDesktopApiOperation): void {
    this.enqueue(operation, async () => { throw new TypeError('Fixture network unavailable.') })
  }

  /** Queue a deliberately non-cooperative response to exercise stale-result guards. */
  deferNext(operation: FakeDesktopApiOperation): DeferredFakeAccountResponse {
    let resolvePromise!: (response: Response) => void
    let rejectPromise!: (error: Error) => void
    let settled = false
    const promise = new Promise<Response>((resolve, reject) => {
      resolvePromise = resolve
      rejectPromise = reject
    })

    const settle = (response: Response): void => {
      if (settled) return
      settled = true
      this.pendingGates.delete(disposeGate)
      resolvePromise(response)
    }
    const disposeGate = (): void => settle(errorResponse('service_unavailable', 503))
    this.pendingGates.add(disposeGate)
    this.enqueue(operation, () => promise)

    return {
      resolve: data => settle(successResponse(data)),
      rejectNetwork: () => {
        if (settled) return
        settled = true
        this.pendingGates.delete(disposeGate)
        rejectPromise(new TypeError('Fixture network unavailable.'))
      },
    }
  }

  waitForCall(operation: FakeDesktopApiOperation, count: number): Promise<void> {
    if (!Number.isSafeInteger(count) || count < 1) {
      return Promise.reject(new RangeError('Expected fake API call count must be positive.'))
    }
    if (this.countCalls(operation) >= count) return Promise.resolve()
    return new Promise(resolve => {
      this.callWaiters.add({ operation, count, resolve })
    })
  }

  countCalls(operation: FakeDesktopApiOperation): number {
    return this.calls.reduce((count, call) => count + Number(call.operation === operation), 0)
  }

  async dispose(): Promise<void> {
    for (const release of [...this.pendingGates]) release()
    await rm(this.rootDirectory, { recursive: true, force: true })
  }

  private enqueue(operation: FakeDesktopApiOperation, response: () => Promise<Response>): void {
    const queue = this.responses.get(operation) ?? []
    queue.push(response)
    this.responses.set(operation, queue)
  }

  private resolveCallWaiters(): void {
    for (const waiter of [...this.callWaiters]) {
      if (this.countCalls(waiter.operation) >= waiter.count) {
        this.callWaiters.delete(waiter)
        waiter.resolve()
      }
    }
  }
}

export function fakeDesktopUser(id = 'fixture-user'): DesktopPublicUser {
  return {
    id,
    email_normalized: 'fixture@example.invalid',
    role: 'user',
    status: 'active',
    group_id: 'fixture-group',
    group_status: 'active',
    balance_units: '1000000000',
    email_verified_at: null,
  }
}

export function fakeDesktopAccountData(userId = 'fixture-user'): DesktopAccountData {
  return {
    user: fakeDesktopUser(userId),
    balance: {
      currency: 'USD',
      decimals: 8,
      balance_units: '1000000000',
      balance_usd: '10.00000000',
    },
  }
}

function operationForPath(path: string): FakeDesktopApiOperation {
  const operation = (Object.entries(API_PATHS) as [FakeDesktopApiOperation, string][])
    .find(([, candidate]) => candidate === path)?.[0]
  if (operation === undefined) throw new Error('Unexpected fake account API path.')
  return operation
}

function defaultData(operation: FakeDesktopApiOperation): unknown {
  switch (operation) {
    case 'login':
      return {
        token: 'fixture-session-token',
        expiresAt: Date.now() + 90 * 24 * 60 * 60 * 1000,
        user: fakeDesktopUser(),
      }
    case 'key':
      return {
        key: 'fixture-model-key',
        keyId: 'fixture-key-id',
        expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
      }
    case 'account':
      return fakeDesktopAccountData()
    case 'logout':
      return { loggedOut: true }
  }
}

function successResponse(data: unknown): Response {
  return Response.json({ data, request_id: 'fixture-request' })
}

function errorResponse(code: string, status: number, reason?: string): Response {
  return Response.json({
    error: { code, ...(reason === undefined ? {} : { reason }) },
    request_id: 'fixture-request',
  }, { status })
}
