import { useRef, useState } from 'react'
import type {
  DshWorkspaceDirectoryAdapter,
  WorkspaceDirectoryAdapter,
  WorkspaceDirectoryEntry,
} from '../../adapters/native/directories'

export interface WorkspacePickerProps {
  readonly adapter: WorkspaceDirectoryAdapter
  readonly currentDirectory: string | null
  /** A changed directory on an existing Session must be applied by creating a new Session. */
  readonly activeSessionId: string | null
  readonly onDirectorySelected: (directory: string) => void | Promise<void>
  readonly onCreateSessionAtDirectory: (directory: string) => void | Promise<void>
}

export function WorkspacePicker({
  adapter,
  currentDirectory,
  activeSessionId,
  onDirectorySelected,
  onCreateSessionAtDirectory,
}: WorkspacePickerProps) {
  const [browserOpen, setBrowserOpen] = useState(false)
  const [browserStack, setBrowserStack] = useState<readonly string[]>([])
  const [directoryListing, setDirectoryListing] = useState<readonly WorkspaceDirectoryEntry[]>([])
  const [listingTruncated, setListingTruncated] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const browserRequest = useRef(0)

  const browserPath = browserStack[browserStack.length - 1] ?? null

  async function loadDirectory(adapterToUse: DshWorkspaceDirectoryAdapter, path: string): Promise<void> {
    const request = ++browserRequest.current
    setLoading(true)
    setErrorMessage('')
    try {
      const listing = await adapterToUse.listDirectories(path)
      if (browserRequest.current !== request) return
      setDirectoryListing(listing.entries)
      setListingTruncated(listing.truncated)
    } catch {
      if (browserRequest.current === request) {
        setDirectoryListing([])
        setListingTruncated(false)
        setErrorMessage('DSH 无法读取此工作目录。请返回当前会话目录后重试。')
      }
    } finally {
      if (browserRequest.current === request) setLoading(false)
    }
  }

  async function chooseDirectory(): Promise<void> {
    setErrorMessage('')
    if (adapter.kind === 'unavailable') {
      setErrorMessage(adapter.message)
      return
    }

    if (adapter.kind === 'native') {
      setSaving(true)
      try {
        const selected = await adapter.chooseDirectory()
        if (selected !== null) await applyDirectory(selected)
      } catch {
        setErrorMessage('无法选择工作目录，请稍后重试。')
      } finally {
        setSaving(false)
      }
      return
    }

    setBrowserOpen(true)
    setBrowserStack([adapter.rootPath])
    setDirectoryListing([])
    setListingTruncated(false)
    await loadDirectory(adapter, adapter.rootPath)
  }

  async function applyDirectory(directory: string): Promise<void> {
    if (directory === currentDirectory) {
      setBrowserOpen(false)
      return
    }
    setSaving(true)
    setErrorMessage('')
    try {
      if (activeSessionId === null) await onDirectorySelected(directory)
      else await onCreateSessionAtDirectory(directory)
      setBrowserOpen(false)
    } catch {
      setErrorMessage('无法应用此工作目录；当前会话仍保持不变。')
    } finally {
      setSaving(false)
    }
  }

  async function selectCurrentBrowserDirectory(): Promise<void> {
    if (adapter.kind !== 'dsh' || browserPath === null) return
    setSaving(true)
    setErrorMessage('')
    try {
      const selected = await adapter.selectDirectory(browserPath)
      setSaving(false)
      await applyDirectory(selected)
    } catch {
      setErrorMessage('DSH 无法确认此工作目录，请选择当前列表中的目录。')
    } finally {
      setSaving(false)
    }
  }

  async function navigateInto(entry: WorkspaceDirectoryEntry): Promise<void> {
    if (adapter.kind !== 'dsh') return
    const nextStack = [...browserStack, entry.path]
    setBrowserStack(nextStack)
    await loadDirectory(adapter, entry.path)
  }

  async function navigateUp(): Promise<void> {
    if (adapter.kind !== 'dsh' || browserStack.length <= 1) return
    const nextStack = browserStack.slice(0, -1)
    const parent = nextStack[nextStack.length - 1]
    if (parent === undefined) return
    setBrowserStack(nextStack)
    await loadDirectory(adapter, parent)
  }

  return (
    <section aria-label="工作目录" style={{ display: 'grid', gap: 'var(--space-3)' }}>
      <div>
        <h2 style={{ margin: 0, fontSize: 'var(--font-size-lg)' }}>工作目录</h2>
        <p style={{ margin: 'var(--space-1) 0 0', color: 'var(--color-ink-muted)', fontSize: 'var(--font-size-sm)' }}>
          {currentDirectory ?? '尚未选择目录；开始对话前需要指定一个工作目录。'}
        </p>
      </div>

      {adapter.kind === 'unavailable' && (
        <p role="status" style={{ margin: 0, color: 'var(--color-ink-muted)', fontSize: 'var(--font-size-sm)' }}>
          {adapter.message}
        </p>
      )}

      <div>
        <button
          className="ui-button"
          data-variant="secondary"
          disabled={saving || loading || adapter.kind === 'unavailable'}
          onClick={() => { void chooseDirectory() }}
          type="button"
        >
          {currentDirectory === null ? '选择工作目录' : '更改工作目录'}
        </button>
        {activeSessionId !== null && (
          <p style={{ margin: 'var(--space-2) 0 0', color: 'var(--color-ink-muted)', fontSize: 'var(--font-size-xs)' }}>
            更改目录会创建一个新会话，当前会话继续保留原目录。
          </p>
        )}
      </div>

      {browserOpen && adapter.kind === 'dsh' && (
        <div
          aria-label="选择 DSH 工作目录"
          aria-modal="true"
          role="dialog"
          style={{ display: 'grid', gap: 'var(--space-3)', padding: 'var(--space-4)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', background: 'var(--color-surface)' }}
        >
          <div>
            <h3 style={{ margin: 0, fontSize: 'var(--font-size-md)' }}>选择工作目录</h3>
            <p style={{ margin: 'var(--space-1) 0 0', color: 'var(--color-ink-muted)', fontSize: 'var(--font-size-xs)' }}>
              浏览范围来自当前 DSH 会话的真实工作区。
            </p>
          </div>

          {browserPath !== null && (
            <code style={{ overflowWrap: 'anywhere', color: 'var(--color-ink-muted)', fontSize: 'var(--font-size-xs)' }}>
              {browserPath}
            </code>
          )}

          {browserStack.length > 1 && (
            <button className="ui-button" data-variant="quiet" disabled={loading || saving} onClick={() => { void navigateUp() }} type="button">
              返回上一级
            </button>
          )}

          {loading ? (
            <p role="status" style={{ margin: 0, color: 'var(--color-ink-muted)', fontSize: 'var(--font-size-sm)' }}>正在读取 DSH 目录…</p>
          ) : directoryListing.length > 0 ? (
            <ul style={{ display: 'grid', gap: 'var(--space-1)', maxHeight: '16rem', overflow: 'auto', margin: 0, padding: 0, listStyle: 'none' }}>
              {directoryListing.map(entry => (
                <li key={entry.path}>
                  <button
                    className="ui-button"
                    data-variant="quiet"
                    disabled={saving}
                    onClick={() => { void navigateInto(entry) }}
                    style={{ width: '100%', justifyContent: 'flex-start' }}
                    type="button"
                  >
                    {entry.name}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p style={{ margin: 0, color: 'var(--color-ink-muted)', fontSize: 'var(--font-size-sm)' }}>
              此目录下没有可浏览的子目录。
            </p>
          )}

          {listingTruncated && (
            <p role="status" style={{ margin: 0, color: 'var(--color-ink-muted)', fontSize: 'var(--font-size-xs)' }}>
              DSH 返回的目录列表已截断，当前只显示可见条目。
            </p>
          )}

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
            <button className="ui-button" data-variant="primary" disabled={saving || loading || browserPath === null} onClick={() => { void selectCurrentBrowserDirectory() }} type="button">
              使用此目录
            </button>
            <button className="ui-button" data-variant="secondary" disabled={saving} onClick={() => { browserRequest.current += 1; setLoading(false); setBrowserOpen(false) }} type="button">
              取消
            </button>
          </div>
        </div>
      )}

      {errorMessage.length > 0 && <p role="alert" style={{ margin: 0, color: 'var(--color-danger)', fontSize: 'var(--font-size-sm)' }}>{errorMessage}</p>}
    </section>
  )
}
