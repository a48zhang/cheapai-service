import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopAccountData, DesktopPrivateSessionCredential } from '@sub2api/desktop-contracts'
import { DesktopAccountApiError, DesktopAccountClient } from '../../apps/desktop-runtime/src/cheapai/account-client.ts'
import {
  DesktopAccountStateStore,
  DesktopDshAccountBinding,
} from '../../apps/desktop-runtime/src/cheapai/account-state.ts'
import { DesktopAccountController } from '../../apps/desktop-runtime/src/cheapai/account-controller.ts'
import { DesktopSessionManager } from '../../apps/desktop-runtime/src/cheapai/session-manager.ts'
import type { DshConnectionInfo } from '../../apps/desktop-runtime/src/dsh/connection-info.ts'
import { DshLifecycle } from '../../apps/desktop-runtime/src/dsh/lifecycle.ts'
import {
  fakeDesktopAccountData,
  fakeDesktopUser,
  FakeDesktopAccountApi,
} from './helpers/fake-account-api.ts'

const ACCOUNT_API = 'https://desktop-account-controller.test.invalid'
const NOW = 1_800_000_000_000
const TOKEN_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000

let fakeApi: FakeDesktopAccountApi

beforeEach(async () => {
  fakeApi = await FakeDesktopAccountApi.create()
})

afterEach(async () => {
  await fakeApi.dispose()
})

interface ControllerHarness {
  readonly client: DesktopAccountClient
  readonly controller: DesktopAccountController
  readonly state: DesktopAccountStateStore
  readonly sessions: DesktopSessionManager
  readonly lifecycle: DshLifecycle
  readonly activatedAccounts: DesktopAccountData[]
  readonly setActivationFailure: (error: Error | undefined) => void
  readonly stopCalls: () => number
}

function deferred<T = void>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T | PromiseLike<T>) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

const FAKE_CONNECTION: DshConnectionInfo = Object.freeze({
  origin: 'http://127.0.0.1:54321',
  httpBaseUrl: 'http://127.0.0.1:54321/',
  streamBaseUrl: 'ws://127.0.0.1:54321/',
  port: 54321,
  auth: Object.freeze({ type: 'dsh-browser-cookie' as const, cookie: 'fixture-only-cookie' }),
})

function createHarness(
  onActivate?: (account: DesktopAccountData) => Promise<void>,
  onStop?: () => Promise<void>,
): ControllerHarness {
  const client = new DesktopAccountClient({
    baseUrl: ACCOUNT_API,
    fetch: fakeApi.fetch,
    timeoutMs: 300_000,
  })
  const state = new DesktopAccountStateStore()
  const sessions = new DesktopSessionManager(client, () => NOW)
  const lifecycle = new DshLifecycle({
    launch: () => { throw new Error('Account controller tests must not launch DSH.') },
  })
  const binding = new DesktopDshAccountBinding({
    state,
    lifecycle,
    baseHome: fakeApi.dshBaseHome,
    scope: 'development',
    beforeChange: async () => {},
  })
  const activatedAccounts: DesktopAccountData[] = []
  let activationFailure: Error | undefined
  let stops = 0
  const controller = new DesktopAccountController({
    client,
    sessions,
    state,
    binding,
    activateProvider: async account => {
      activatedAccounts.push(account)
      await onActivate?.(account)
      if (activationFailure !== undefined) throw activationFailure
      return FAKE_CONNECTION
    },
    stopRuntime: async () => {
      stops += 1
      await onStop?.()
    },
    now: () => NOW,
  })

  return {
    client,
    controller,
    state,
    sessions,
    lifecycle,
    activatedAccounts,
    setActivationFailure: error => { activationFailure = error },
    stopCalls: () => stops,
  }
}

async function login(controller: DesktopAccountController, userId: string, token: string) {
  const expiresAt = NOW + TOKEN_LIFETIME_MS
  fakeApi.enqueueData('login', {
    token,
    expiresAt,
    user: fakeDesktopUser(userId),
  })
  const result = await controller.handle({
    operation: 'login',
    payload: { email: 'fixture@example.invalid', password: 'fixture-only' },
  })
  if (result.operation !== 'login') throw new Error('Expected a private login response.')
  return result.result
}

async function restore(
  controller: DesktopAccountController,
  credential: DesktopPrivateSessionCredential,
  userId: string,
) {
  fakeApi.enqueueData('account', fakeDesktopAccountData(userId))
  const result = await controller.handle({ operation: 'restore', payload: credential })
  if (result.operation !== 'restore') throw new Error('Expected an account restore response.')
  return result.result
}

describe('DesktopAccountController private lifecycle', () => {
  it('keeps login private and activates only after the host restores its persisted credential', async () => {
    let hostPersistedCredential = false
    const harness = createHarness(async () => {
      expect(hostPersistedCredential).toBe(true)
    })

    const privateLogin = await login(harness.controller, 'account-one', 'fixture-session-one')
    expect(privateLogin.token).toBe('fixture-session-one')
    expect(harness.activatedAccounts).toHaveLength(0)
    expect(harness.state.getSnapshot()).toEqual({ status: 'restoring' })
    expect(harness.sessions.getPublicStatus()).toEqual({ status: 'signedOut' })
    expect(harness.lifecycle.accountHome).toBeUndefined()

    // The native host persists the private login result before requesting restore.
    hostPersistedCredential = true
    const publicState = await restore(harness.controller, {
      token: privateLogin.token,
      expiresAt: privateLogin.expiresAt,
    }, 'account-one')

    expect(publicState).toMatchObject({ status: 'signedIn', account: { user: { id: 'account-one' } } })
    expect(harness.activatedAccounts).toHaveLength(1)
    expect(harness.lifecycle.accountHome).toBeDefined()
    expect(fakeApi.countCalls('key')).toBe(0)
  })

  it('retains the account and running session when server logout fails before local cleanup', async () => {
    const harness = createHarness()
    const privateLogin = await login(harness.controller, 'account-one', 'fixture-session-one')
    const credential = { token: privateLogin.token, expiresAt: privateLogin.expiresAt }
    const account = await restore(harness.controller, credential, 'account-one')
    expect(account.status).toBe('signedIn')
    const boundHome = harness.lifecycle.accountHome

    fakeApi.enqueueNetworkFailure('logout')
    await expect(harness.controller.handle({ operation: 'logout', payload: credential }))
      .rejects.toMatchObject({ problem: 'network' } satisfies Partial<DesktopAccountApiError>)

    expect(harness.state.getSnapshot()).toMatchObject({
      status: 'unavailable',
      account: { user: { id: 'account-one' } },
      problem: 'network',
    })
    expect(harness.sessions.getPublicStatus()).toMatchObject({ status: 'signedIn' })
    expect(harness.controller.getPublicStatus()).toMatchObject({ status: 'signedIn' })
    expect(harness.lifecycle.accountHome).toBe(boundHome)
    expect(harness.stopCalls()).toBe(0)
  })

  it('finishes local cleanup when logout confirms the Token is already expired', async () => {
    const harness = createHarness()
    const privateLogin = await login(harness.controller, 'account-one', 'fixture-session-one')
    const credential = { token: privateLogin.token, expiresAt: privateLogin.expiresAt }
    await restore(harness.controller, credential, 'account-one')

    fakeApi.enqueueError('logout', 'unauthorized', 401, 'session_expired')
    await expect(harness.controller.handle({ operation: 'logout', payload: credential }))
      .resolves.toMatchObject({ operation: 'logout', result: { loggedOut: true } })

    expect(harness.state.getSnapshot()).toEqual({ status: 'signedOut' })
    expect(harness.sessions.getPublicStatus()).toEqual({ status: 'signedOut' })
    expect(harness.controller.getPublicStatus()).toEqual({ status: 'signedOut' })
    expect(harness.lifecycle.accountHome).toBeUndefined()
    expect(harness.stopCalls()).toBe(1)
  })

  it('preserves the authenticated projection when provider startup fails', async () => {
    const harness = createHarness()
    const privateLogin = await login(harness.controller, 'account-one', 'fixture-session-one')
    const credential = { token: privateLogin.token, expiresAt: privateLogin.expiresAt }
    const account = await restore(harness.controller, credential, 'account-one')
    expect(account.status).toBe('signedIn')

    harness.setActivationFailure(new DesktopAccountApiError('serviceUnavailable'))
    await expect(harness.controller.start()).rejects.toMatchObject({ problem: 'serviceUnavailable' })

    expect(harness.state.getSnapshot()).toMatchObject({
      status: 'unavailable',
      account: { user: { id: 'account-one' } },
      expiresAt: credential.expiresAt,
      problem: 'serviceUnavailable',
    })
    expect(harness.sessions.getPublicStatus()).toMatchObject({ status: 'signedIn' })
    expect(harness.controller.getPublicStatus()).toMatchObject({ status: 'signedIn' })
    expect(harness.stopCalls()).toBe(0)
  })

  it('rejects future Key resolution after session expiry but retains the active DSH home', async () => {
    const harness = createHarness()
    const privateLogin = await login(harness.controller, 'account-one', 'fixture-session-one')
    const credential = { token: privateLogin.token, expiresAt: privateLogin.expiresAt }
    await restore(harness.controller, credential, 'account-one')
    const boundHome = harness.lifecycle.accountHome
    expect(boundHome).toBeDefined()

    fakeApi.enqueueError('key', 'unauthorized', 401, 'session_expired')
    await expect(harness.controller.getKey())
      .rejects.toMatchObject({ problem: 'sessionExpired' } satisfies Partial<DesktopAccountApiError>)
    expect(harness.controller.getPublicStatus()).toEqual({ status: 'signedOut' })

    // A subsequent serialized host request sees the expired credential fenced
    // without asking the running DSH child to retry the failed call.
    await expect(harness.controller.handle({ operation: 'getKey', payload: credential }))
      .rejects.toMatchObject({ problem: 'sessionExpired' } satisfies Partial<DesktopAccountApiError>)
    expect(harness.sessions.getPublicStatus()).toEqual({ status: 'signedOut' })
    expect(harness.lifecycle.accountHome).toBe(boundHome)
    expect(harness.stopCalls()).toBe(0)
    await expect(harness.controller.getKey())
      .rejects.toMatchObject({ problem: 'sessionExpired' } satisfies Partial<DesktopAccountApiError>)
  })

  it('keeps the bound account and does not stop DSH on a recoverable Key network error', async () => {
    const harness = createHarness()
    const privateLogin = await login(harness.controller, 'account-one', 'fixture-session-one')
    const credential = { token: privateLogin.token, expiresAt: privateLogin.expiresAt }
    await restore(harness.controller, credential, 'account-one')
    const boundHome = harness.lifecycle.accountHome

    fakeApi.enqueueNetworkFailure('key')
    await expect(harness.controller.getKey())
      .rejects.toMatchObject({ problem: 'network' } satisfies Partial<DesktopAccountApiError>)

    expect(harness.lifecycle.accountHome).toBe(boundHome)
    expect(harness.sessions.getPublicStatus()).toMatchObject({ status: 'signedIn' })
    expect(harness.controller.getPublicStatus()).toMatchObject({ status: 'signedIn' })
    expect(harness.stopCalls()).toBe(0)
  })

  it('does not let a deferred provider activation restore state after shutdown', async () => {
    const activationStarted = deferred()
    const releaseActivation = deferred()
    const harness = createHarness(async () => {
      activationStarted.resolve(undefined)
      await releaseActivation.promise
    })
    const privateLogin = await login(harness.controller, 'account-one', 'fixture-session-one')
    const credential = { token: privateLogin.token, expiresAt: privateLogin.expiresAt }
    fakeApi.enqueueData('account', fakeDesktopAccountData('account-one'))
    const lateRestore = harness.controller.handle({ operation: 'restore', payload: credential })

    await activationStarted.promise
    expect(harness.lifecycle.accountHome).toBeDefined()
    harness.controller.shutdown()
    releaseActivation.resolve(undefined)
    await expect(lateRestore).rejects.toBeDefined()

    expect(harness.state.getSnapshot()).toEqual({ status: 'signedOut' })
    expect(harness.sessions.getPublicStatus()).toEqual({ status: 'signedOut' })
    expect(harness.controller.getPublicStatus()).toEqual({ status: 'signedOut' })
  })
})


describe('desktop console account scope', () => {
  it('allows logout during a console request and drops its late reply', async () => {
    const harness = createHarness();
    const credential = { token: 'fixture-session', expiresAt: NOW + TOKEN_LIFETIME_MS };
    await restore(harness.controller, credential, 'account-one');
    const response = deferred<{ status: number; contentType: string; encoding: 'utf8'; body: string }>();
    const send = vi.spyOn(harness.client, 'console').mockReturnValue(response.promise);
    const pending = harness.controller.handle({ operation: 'console', payload: { accountId: 'account-one', method: 'GET', path: '/api/v1/account/balance' } });
    const rejected = expect(pending).rejects.toThrow();
    fakeApi.enqueueData('logout', { loggedOut: true });
    await harness.controller.handle({ operation: 'logout', payload: credential });
    expect(harness.state.getSnapshot().status).toBe('signedOut');
    response.resolve({ status: 200, contentType: 'application/json', encoding: 'utf8', body: '{}' });
    await rejected;
    expect(send).toHaveBeenCalledOnce();
  });
  it('rejects a request bound to a different account before transport', async () => {
    const harness = createHarness();
    await restore(harness.controller, { token: 'fixture-session', expiresAt: NOW + TOKEN_LIFETIME_MS }, 'account-one');
    const send = vi.spyOn(harness.client, 'console');
    await expect(harness.controller.handle({ operation: 'console', payload: { accountId: 'account-two', method: 'GET', path: '/api/v1/keys' } })).rejects.toMatchObject({ problem: 'sessionExpired' });
    expect(send).not.toHaveBeenCalled();
  });
});


describe('desktop console independent availability', () => {
  it('can read the account after chat provider startup fails', async () => {
    const harness = createHarness();
    await restore(harness.controller, { token: 'fixture-session', expiresAt: NOW + TOKEN_LIFETIME_MS }, 'account-one');
    harness.setActivationFailure(new DesktopAccountApiError('noModels'));
    await expect(harness.controller.start()).rejects.toMatchObject({ problem: 'noModels' });
    vi.spyOn(harness.client, 'console').mockResolvedValue({ status: 200, contentType: 'application/json', encoding: 'utf8', body: '{}' });
    await expect(harness.controller.handle({ operation: 'console', payload: { accountId: 'account-one', method: 'GET', path: '/api/v1/account/balance' } })).resolves.toMatchObject({ operation: 'console', result: { status: 200 } });
  });
  it('expires native credentials when the console API rejects the session', async () => {
    const harness = createHarness();
    await restore(harness.controller, { token: 'fixture-session', expiresAt: NOW + TOKEN_LIFETIME_MS }, 'account-one');
    vi.spyOn(harness.client, 'console').mockResolvedValue({ status: 401, contentType: 'application/json', encoding: 'utf8', body: '{}' });
    const request = { operation: 'console' as const, payload: { accountId: 'account-one', method: 'GET', path: '/api/v1/account/balance' } };
    expect(await harness.controller.handle(request)).toMatchObject({ result: { status: 401 } });
    await expect(harness.controller.handle(request)).rejects.toMatchObject({ problem: 'sessionExpired' });
    expect(harness.sessions.getPublicStatus().status).toBe('signedOut');
  });
});
