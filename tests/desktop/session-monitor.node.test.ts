import { describe, expect, it, vi } from 'vitest'
import type { DshClient } from '../../apps/desktop/src/adapters/dsh/client'
import { SessionActivityMonitor } from '../../apps/desktop/src/features/conversations/session-monitor'

function harness() {
  const listeners = new Map<string, (...args: unknown[]) => void>()
  const pendingLists: Array<(result: unknown) => void> = []
  const list = vi.fn((_request: unknown, _signal?: AbortSignal) => new Promise(resolve => {
    pendingLists.push(resolve)
  }))
  const activity = vi.fn()
  const sessionsChanged = vi.fn()
  const failed = vi.fn()
  let generation: { readonly id: number } | undefined = { id: 1 }
  const generationListeners = new Set<() => void>()
  const client = {
    remote: { $on: (event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, listener)
      return () => {
        if (listeners.get(event) === listener) listeners.delete(event)
      }
    } },
    session: { list },
    connection: { generation: {
      getSnapshot: () => generation,
      subscribe: (listener: () => void) => {
        generationListeners.add(listener)
        return () => { generationListeners.delete(listener) }
      },
    } },
  } as unknown as DshClient
  const monitor = new SessionActivityMonitor(client, { activity, sessionsChanged, failed })
  const emit = (name: string, ...args: unknown[]) => listeners.get(name)?.(...args)
  const setGeneration = (value: { readonly id: number } | undefined): void => {
    generation = value
    for (const listener of [...generationListeners]) listener()
  }
  return {
    monitor, activity, sessionsChanged, failed, list, listeners, emit, setGeneration,
    completeAt: (index: number, items: unknown[]) => pendingLists[index]?.({ ok: true, value: { items } }),
    failAt: (index: number, error: unknown) => pendingLists[index]?.({ ok: false, error }),
    complete: (items: unknown[]) => pendingLists.at(-1)?.({ ok: true, value: { items } }),
    fail: (error: unknown) => pendingLists.at(-1)?.({ ok: false, error }),
  }
}

function session(id: string, cwd: string, running: boolean) {
  return { sessionId: id, cwd, title: id, createdAt: 1, updatedAt: 1, running }
}

describe('native exit activity from real global Session events', () => {
  it('counts running work across directories and reconciles changes during the baseline read', async () => {
    const h = harness()
    const ready = h.monitor.refresh()
    await Promise.resolve()
    h.emit('api-session/status', 'other-project', false)
    h.emit('api-session/added', session('new-project', '/third', true))
    h.complete([session('selected-project', '/selected', true), session('other-project', '/other', true)])
    await ready
    expect(h.activity).toHaveBeenLastCalledWith(2)
    const failureCount = h.failed.mock.calls.length
    h.emit('api-session/removed', 'selected-project')
    expect(h.activity).toHaveBeenLastCalledWith(1)
    h.emit('api-session/status', 'new-project', false)
    expect(h.activity).toHaveBeenLastCalledWith(0)
    expect(h.failed).toHaveBeenCalledTimes(failureCount)
    h.monitor.dispose()
  })

  it('shares a pending baseline and ignores its response after connection disposal', async () => {
    const h = harness()
    const first = h.monitor.refresh()
    expect(h.monitor.refresh()).toBe(first)
    await Promise.resolve()
    expect(h.list).toHaveBeenCalledTimes(1)
    const failureCount = h.failed.mock.calls.length
    h.monitor.dispose()
    h.complete([session('old-account', '/old', true)])
    await first
    expect(h.activity).not.toHaveBeenCalled()
    expect(h.failed).toHaveBeenCalledTimes(failureCount)
    expect(h.listeners.size).toBe(0)
  })

  it('reports an unavailable baseline without falsely reporting an empty task list', async () => {
    const h = harness()
    const ready = h.monitor.refresh()
    await Promise.resolve()
    const error = new Error('baseline unavailable')
    h.emit('api-session/added', session('partial-event', '/partial', true))
    h.fail(error)
    await ready
    expect(h.failed).toHaveBeenLastCalledWith(error)
    expect(h.activity).not.toHaveBeenCalled()
    const changes = h.sessionsChanged.mock.calls.length
    h.emit('api-session/status', 'partial-event', false)
    expect(h.sessionsChanged).toHaveBeenCalledTimes(changes + 1)
    expect(h.activity).not.toHaveBeenCalled()
    h.monitor.dispose()
  })

  it('marks a previously known count unknown while a replacement baseline is pending', async () => {
    const h = harness()
    const initial = h.monitor.refresh()
    await Promise.resolve()
    h.complete([session('initial-running', '/current', true)])
    await initial
    expect(h.activity).toHaveBeenLastCalledWith(1)

    const priorFailures = h.failed.mock.calls.length
    const refresh = h.monitor.refresh()
    expect(h.monitor.refresh()).toBe(refresh)
    expect(h.failed).toHaveBeenCalledTimes(priorFailures + 1)
    expect(h.failed).toHaveBeenLastCalledWith(expect.objectContaining({
      message: expect.stringContaining('activity is unknown'),
    }))
    await Promise.resolve()

    const priorActivityUpdates = h.activity.mock.calls.length
    h.emit('api-session/added', session('replacement-running', '/next', true))
    expect(h.activity).toHaveBeenCalledTimes(priorActivityUpdates)
    expect(h.sessionsChanged).toHaveBeenCalled()

    h.complete([
      session('replacement-idle', '/next', false),
      session('replacement-also-running', '/next', true),
    ])
    await refresh
    expect(h.activity).toHaveBeenLastCalledWith(2)
    expect(h.failed).toHaveBeenCalledTimes(priorFailures + 1)
    h.monitor.dispose()
  })

  it('starts a fresh baseline per generation and ignores late old results, events, and errors', async () => {
    const h = harness()
    const first = h.monitor.refresh()
    await Promise.resolve()
    expect(h.list).toHaveBeenCalledTimes(1)
    h.completeAt(0, [session('known', '/current', true)])
    await first
    expect(h.activity).toHaveBeenLastCalledWith(1)

    const staleSuccess = h.monitor.refresh()
    await Promise.resolve()
    expect(h.list).toHaveBeenCalledTimes(2)
    const oldAdded = h.listeners.get('api-session/added')!

    h.setGeneration(undefined)
    // A lost carrier is not a session-list baseline and must not clear activity.
    expect(h.activity).toHaveBeenLastCalledWith(1)
    expect(h.activity).not.toHaveBeenLastCalledWith(0)
    expect(h.failed).toHaveBeenLastCalledWith(expect.objectContaining({ message: expect.stringContaining('activity is unknown') }))

    h.setGeneration({ id: 2 })
    await Promise.resolve()
    expect(h.list).toHaveBeenCalledTimes(3)
    expect(h.failed).toHaveBeenLastCalledWith(expect.objectContaining({ message: expect.stringContaining('activity is unknown') }))
    h.emit('api-session/added', session('generation-two-event', '/two', true))
    expect(h.activity).toHaveBeenLastCalledWith(1)
    const generationTwo = h.monitor.refresh()
    h.completeAt(2, [session('generation-two-base', '/two', true)])
    await generationTwo
    expect(h.activity).toHaveBeenLastCalledWith(2)

    // Complete the old request after the new baseline and deliver a callback
    // captured from its listener set. Neither may overwrite the active view.
    h.completeAt(1, [session('stale-generation-one', '/old', false)])
    await staleSuccess
    oldAdded(session('stale-event', '/old', true))
    expect(h.activity).toHaveBeenLastCalledWith(2)

    const staleFailure = h.monitor.refresh()
    await Promise.resolve()
    expect(h.list).toHaveBeenCalledTimes(4)
    const oldStatus = h.listeners.get('api-session/status')!
    h.setGeneration({ id: 3 })
    await Promise.resolve()
    expect(h.list).toHaveBeenCalledTimes(5)
    const generationThree = h.monitor.refresh()
    h.completeAt(4, [session('generation-three-base', '/three', true)])
    await generationThree
    const changeCount = h.sessionsChanged.mock.calls.length
    const failureCount = h.failed.mock.calls.length

    oldStatus('generation-three-base', false)
    h.failAt(3, new Error('stale generation failure'))
    await staleFailure
    expect(h.failed).toHaveBeenCalledTimes(failureCount)
    expect(h.sessionsChanged).toHaveBeenCalledTimes(changeCount)
    expect(h.activity).toHaveBeenLastCalledWith(1)
    h.monitor.dispose()
  })
})
