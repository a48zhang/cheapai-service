import { setImmediate as nextTurn } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DshFetch } from '../../apps/desktop-runtime/src/dsh/connection-info.ts'
import { DshLifecycle, type DshLifecycleOptions } from '../../apps/desktop-runtime/src/dsh/lifecycle.ts'
import {
  dshAuthenticationResponse,
  FakeDshHost,
  successfulDshHostApiResponse,
  type FakeDshChild,
} from './helpers/fake-host.ts'

let fakeHost: FakeDshHost
let lifecycle: DshLifecycle | undefined

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  fakeHost = await FakeDshHost.create()
  lifecycle = undefined
})

afterEach(async () => {
  try {
    await lifecycle?.stop()
  } catch {
    // Cleanup still owns the fake children and temporary runtime directories.
  }
  await fakeHost.dispose()
  vi.useRealTimers()
})

function createLifecycle(overrides: Omit<Partial<DshLifecycleOptions>, 'launch'> = {}): DshLifecycle {
  lifecycle = new DshLifecycle({
    launch: () => fakeHost.launch(),
    fetch: fakeHost.fetch,
    startupTimeoutMs: 100,
    shutdownGraceMs: 25,
    ...overrides,
  })
  return lifecycle
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function expectLifecycleError(result: unknown, code: string): void {
  expect(result).toMatchObject({ code })
}

describe('DSH runtime lifecycle cleanup', () => {
  it('times out a pending Host handshake and ignores its late successful response', async () => {
    const rpcStarted = deferred<void>()
    const pendingRpc = deferred<Response>()
    let rpcRequest: RequestInit | undefined
    const fetch: DshFetch = async (input, init) => {
      if (new URL(String(input)).pathname === '/') return dshAuthenticationResponse()
      rpcRequest = init
      rpcStarted.resolve()
      return pendingRpc.promise
    }
    const owner = createLifecycle({ fetch, startupTimeoutMs: 50 })
    const startup = owner.start().then(
      () => undefined,
      error => error as Error,
    )
    const child = fakeHost.processes[0]!
    child.announceReady()
    await rpcStarted.promise

    await vi.advanceTimersByTimeAsync(50)
    const failure = await startup
    expectLifecycleError(failure, 'startup-timeout')
    await child.waitForClose()
    await nextTurn()
    expect(child.killSignals).toEqual(['SIGTERM'])
    expect(owner.status).toMatchObject({ state: 'failed', generation: 1, failure: { code: 'startup-timeout' } })
    expect(vi.getTimerCount()).toBe(0)

    pendingRpc.resolve(successfulDshHostApiResponse(rpcRequest))
    await nextTurn()
    expect(owner.status).toMatchObject({ state: 'failed', generation: 1, failure: { code: 'startup-timeout' } })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports the actual child exit when DSH dies before becoming ready', async () => {
    const owner = createLifecycle()
    const startup = owner.start().then(
      () => undefined,
      error => error as Error,
    )
    const child = fakeHost.processes[0]!
    child.exit(23, null)

    const failure = await startup
    await child.waitForClose()
    expectLifecycleError(failure, 'exited-before-ready')
    expect(owner.status).toMatchObject({
      state: 'failed',
      generation: 1,
      failure: { code: 'exited-before-ready', exitCode: 23, signal: null },
    })
    expect(child.killSignals).toEqual([])
    await nextTurn()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('shares concurrent stop work and releases the process, timers, and lifecycle listeners', async () => {
    const owner = createLifecycle()
    const child = await startReady(owner, fakeHost)

    const firstStop = owner.stop()
    const secondStop = owner.stop()
    expect(secondStop).toBe(firstStop)
    await Promise.all([firstStop, secondStop])

    expect(child.killSignals).toEqual(['SIGTERM'])
    expect(child.closed).toBe(true)
    expect(owner.status).toMatchObject({ state: 'stopped', generation: 1 })
    expect(vi.getTimerCount()).toBe(0)
    await nextTurn()
    // The lifecycle owns these callbacks; a closed child retained by the fake
    // host must not retain lifecycle state or stream readers.
    expect(child.listenerCount('close')).toBe(0)
    expect(child.listenerCount('error')).toBe(0)
    expect(child.stdout.listenerCount('data')).toBe(0)
    expect(child.stdout.listenerCount('end')).toBe(0)
    expect(child.stderr.listenerCount('data')).toBe(0)
  })

  it('keeps a restarted generation ready when the previous Host probe replies late', async () => {
    let oldPort: number | undefined
    let oldRequest: RequestInit | undefined
    const oldRpcStarted = deferred<void>()
    const pendingOldRpc = deferred<Response>()
    const snapshots: unknown[] = []
    const fetch: DshFetch = async (input, init) => {
      const url = new URL(String(input))
      if (url.pathname === '/') return dshAuthenticationResponse()
      if (oldPort !== undefined && Number(url.port) === oldPort) {
        oldRequest = init
        oldRpcStarted.resolve()
        return pendingOldRpc.promise
      }
      return successfulDshHostApiResponse(init)
    }
    const owner = createLifecycle({ fetch, onState: snapshot => snapshots.push(snapshot) })
    const oldStartup = owner.start()
    const oldStartupResult = oldStartup.then(() => undefined, error => error as Error)
    const oldChild = fakeHost.processes[0]!
    oldPort = oldChild.port
    oldChild.announceReady()
    await oldRpcStarted.promise

    const restarted = owner.restart()
    const newChild = await fakeHost.waitForLaunch(2)
    newChild.announceReady()
    const newConnection = await restarted
    const currentReadySnapshot = owner.status
    expect(newConnection.port).toBe(newChild.port)
    expect(currentReadySnapshot).toMatchObject({ state: 'ready', generation: 2 })
    expectLifecycleError(await oldStartupResult, 'stopped')

    pendingOldRpc.resolve(successfulDshHostApiResponse(oldRequest))
    await nextTurn()
    expect(owner.status).toBe(currentReadySnapshot)
    expect(snapshots.at(-1)).toBe(currentReadySnapshot)
  })
})

async function startReady(owner: DshLifecycle, host: FakeDshHost): Promise<FakeDshChild> {
  const starting = owner.start()
  const child = host.processes.at(-1)!
  child.announceReady()
  await expect(starting).resolves.toMatchObject({ port: child.port })
  return child
}
