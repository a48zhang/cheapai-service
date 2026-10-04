import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import type { DesktopAccountData, DesktopLoginResponse } from '@sub2api/desktop-contracts'
import { DesktopAccountClient } from '../../apps/desktop-runtime/src/cheapai/account-client.ts'
import {
  DesktopAccountStateStore,
  DesktopDshAccountBinding,
} from '../../apps/desktop-runtime/src/cheapai/account-state.ts'
import {
  DesktopSessionChangedError,
  DesktopSessionManager,
} from '../../apps/desktop-runtime/src/cheapai/session-manager.ts'
import { DshLifecycle } from '../../apps/desktop-runtime/src/dsh/lifecycle.ts'
import { resolveDshAccountHome } from '../../apps/desktop-runtime/src/dsh/paths.ts'
import {
  fakeDesktopAccountData,
  fakeDesktopUser,
  FakeDesktopAccountApi,
} from './helpers/fake-account-api.ts'

const DAY_MS = 24 * 60 * 60 * 1000
const TOKEN_LIFETIME_MS = 90 * DAY_MS
const KEY_LIFETIME_MS = 30 * DAY_MS
const ACCOUNT_API = 'https://desktop-account.test.invalid'

let fakeApi: FakeDesktopAccountApi

beforeEach(async () => {
  fakeApi = await FakeDesktopAccountApi.create()
})

afterEach(async () => {
  await fakeApi.dispose()
})

function createAccountClient(): DesktopAccountClient {
  return new DesktopAccountClient({
    baseUrl: ACCOUNT_API,
    fetch: fakeApi.fetch,
    timeoutMs: 300_000,
  })
}

function fakeKey(key: string, keyId: string, expiresAt: number): { key: string; keyId: string; expiresAt: number } {
  return { key, keyId, expiresAt }
}

function loginResponse(token: string, userId: string, expiresAt: number): DesktopLoginResponse {
  return { token, user: fakeDesktopUser(userId), expiresAt }
}

function signInState(
  state: DesktopAccountStateStore,
  userId: string,
  expiresAt: number,
): DesktopAccountData {
  const generation = state.begin('restore')
  const account = fakeDesktopAccountData(userId)
  expect(state.setSignedIn(generation, account, expiresAt)).toBe(true)
  return account
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

describe('desktop account and Key lifecycle', () => {
  it('reuses a live Key and coalesces the first refresh at its exact expiry', async () => {
    let now = 1_800_000_000_000
    const client = createAccountClient()
    const sessions = new DesktopSessionManager(client, () => now)
    const sessionGeneration = sessions.beginSessionChange()
    expect(sessions.setSession(sessionGeneration, {
      token: 'fixture-session-one',
      expiresAt: now + TOKEN_LIFETIME_MS,
    })).toBe(true)

    fakeApi.enqueueData('key', fakeKey('fixture-key-one', 'fixture-key-id-one', now + KEY_LIFETIME_MS))
    const first = await sessions.getKey()
    const cached = await sessions.getKey()
    expect(cached).toEqual(first)
    expect(fakeApi.countCalls('key')).toBe(1)

    now = first.expiresAt
    const delayedRefresh = fakeApi.deferNext('key')
    const refreshOne = sessions.getKey()
    const refreshTwo = sessions.getKey()
    await fakeApi.waitForCall('key', 2)
    delayedRefresh.resolve(fakeKey('fixture-key-two', 'fixture-key-id-two', now + DAY_MS))

    const [keyOne, keyTwo] = await Promise.all([refreshOne, refreshTwo])
    expect(keyOne).toEqual(keyTwo)
    expect(keyOne.keyId).toBe('fixture-key-id-two')
    expect(fakeApi.countCalls('key')).toBe(2)
  })

  it('does not publish a delayed login that returns after logout completed', async () => {
    const client = createAccountClient()
    const state = new DesktopAccountStateStore()
    const expiresAt = 1_800_000_000_000 + TOKEN_LIFETIME_MS
    const priorAccount = signInState(state, 'account-before-login', expiresAt)
    const delayedLogin = fakeApi.deferNext('login')

    const loginGeneration = state.begin('login')
    const loginRequest = client.login({ email: 'fixture@example.invalid', password: 'fixture-only' })
    await fakeApi.waitForCall('login', 1)

    const logoutGeneration = state.begin('logout')
    fakeApi.enqueueData('logout', { loggedOut: true })
    await client.logout('fixture-prior-session')
    expect(state.finishLogout(logoutGeneration)).toBe(true)

    delayedLogin.resolve(loginResponse('fixture-late-session', 'account-late-login', expiresAt))
    const lateLogin = await loginRequest
    expect(state.setSignedIn(loginGeneration, {
      user: lateLogin.user,
      balance: priorAccount.balance,
    }, lateLogin.expiresAt)).toBe(false)
    expect(state.getSnapshot()).toEqual({ status: 'signedOut' })
    expect(fakeApi.calls.map(call => call.operation)).toEqual(['login', 'logout'])
  })

  it('rejects a delayed getKey after the outgoing session generation is cleared', async () => {
    let now = 1_800_000_000_000
    const client = createAccountClient()
    const sessions = new DesktopSessionManager(client, () => now)
    const loginGeneration = sessions.beginSessionChange()
    expect(sessions.setSession(loginGeneration, {
      token: 'fixture-outgoing-session',
      expiresAt: now + TOKEN_LIFETIME_MS,
    })).toBe(true)

    const delayedKey = fakeApi.deferNext('key')
    const lateRequest = sessions.getKey()
    await fakeApi.waitForCall('key', 1)

    const logoutGeneration = sessions.beginSessionChange()
    expect(sessions.clearSession(logoutGeneration)).toBe(true)
    now += 1
    delayedKey.resolve(fakeKey('fixture-late-key', 'fixture-late-key-id', now + KEY_LIFETIME_MS))

    await expect(lateRequest).rejects.toBeInstanceOf(DesktopSessionChangedError)
    expect(sessions.getPublicStatus()).toEqual({ status: 'signedOut' })
  })

  it('selects stable isolated homes by user id and stops before switching accounts', async () => {
    const state = new DesktopAccountStateStore()
    const lifecycle = new DshLifecycle({
      launch: () => { throw new Error('Home selection must not launch DSH.') },
    })
    let beforeChangeCalls = 0
    let pendingBeforeChange: { readonly promise: Promise<void>; readonly started: () => void } | undefined
    const binding = new DesktopDshAccountBinding({
      state,
      lifecycle,
      baseHome: fakeApi.dshBaseHome,
      scope: 'development',
      beforeChange: async () => {
        beforeChangeCalls += 1
        const pending = pendingBeforeChange
        pendingBeforeChange = undefined
        if (pending !== undefined) {
          pending.started()
          await pending.promise
        }
      },
    })

    const firstGeneration = state.begin('login')
    expect(await binding.bind(firstGeneration, 'backend-account-one')).toBe(true)
    const firstHome = lifecycle.accountHome
    expect(firstHome).toBe(resolveDshAccountHome(fakeApi.dshBaseHome, 'backend-account-one', 'development'))

    // A new Token/session for the same backend account keeps its existing home.
    const sameAccountGeneration = state.begin('refresh')
    expect(await binding.bind(sameAccountGeneration, 'backend-account-one')).toBe(true)
    expect(lifecycle.accountHome).toBe(firstHome)
    expect(beforeChangeCalls).toBe(1)

    const otherAccountGeneration = state.begin('login')
    expect(await binding.bind(otherAccountGeneration, 'backend-account-two')).toBe(true)
    const otherHome = lifecycle.accountHome
    expect(otherHome).not.toBe(firstHome)
    expect(otherHome).toContain(join(fakeApi.dshBaseHome, 'accounts', 'development'))
    expect(otherHome).not.toContain('backend-account-one')
    expect(otherHome).not.toContain('backend-account-two')
    expect(beforeChangeCalls).toBe(2)

    const productionHome = resolveDshAccountHome(fakeApi.dshBaseHome, 'backend-account-one', 'production')
    expect(productionHome).not.toBe(firstHome)

    const delayedBeforeChange = deferred()
    const beforeChangeStarted = deferred()
    pendingBeforeChange = { promise: delayedBeforeChange.promise, started: beforeChangeStarted.resolve }
    const staleGeneration = state.begin('login')
    const staleBinding = binding.bind(staleGeneration, 'backend-account-three')
    await beforeChangeStarted.promise
    state.begin('logout')
    delayedBeforeChange.resolve()
    expect(await staleBinding).toBe(false)
    expect(lifecycle.accountHome).toBe(otherHome)
    expect(beforeChangeCalls).toBe(3)
  })

  it('keeps the known account and active Token when login fails at the network boundary', async () => {
    let now = 1_800_000_000_000
    const client = createAccountClient()
    const state = new DesktopAccountStateStore()
    const sessions = new DesktopSessionManager(client, () => now)
    const expiresAt = now + TOKEN_LIFETIME_MS
    const account = signInState(state, 'still-signed-in', expiresAt)
    const sessionGeneration = sessions.beginSessionChange()
    expect(sessions.setSession(sessionGeneration, {
      token: 'fixture-still-valid-session',
      expiresAt,
    })).toBe(true)

    const loginGeneration = state.begin('login')
    fakeApi.enqueueNetworkFailure('login')
    await expect(client.login({ email: 'fixture@example.invalid', password: 'fixture-only' }))
      .rejects.toMatchObject({ problem: 'network' })
    expect(state.setUnavailable(loginGeneration, 'network')).toBe(true)

    expect(state.getSnapshot()).toMatchObject({
      status: 'unavailable',
      account,
      expiresAt,
      problem: 'network',
    })
    expect(sessions.getPublicStatus()).toMatchObject({ status: 'signedIn', tokenExpiresAt: expiresAt })
  })
})
