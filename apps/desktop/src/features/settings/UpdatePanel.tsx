import { useRef, useState } from 'react'
import { Button } from '../../components/ui/controls'
import {
  createDesktopUpdateAdapter,
  DesktopUpdateAdapterError,
  type DesktopUpdateActionResult,
  type DesktopUpdateCheckResult,
  type DesktopUpdateProgress,
} from '../../adapters/native/updates'

type UpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing'

interface DownloadProgress {
  readonly received: number
  readonly total: number | null
}

const panelStyle = {
  display: 'grid',
  gap: 'var(--space-3)',
  paddingTop: 'var(--space-4)',
  borderTop: '1px solid var(--color-border)',
} as const

const actionStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 'var(--space-2)',
} as const

/** Native updater UI. Offers stay in memory and are tied to the adapter that checked them. */
export function UpdatePanel() {
  const [adapter] = useState(() => createDesktopUpdateAdapter())
  const [phase, setPhase] = useState<UpdatePhase>('idle')
  const [check, setCheck] = useState<DesktopUpdateCheckResult | null>(null)
  const [action, setAction] = useState<DesktopUpdateActionResult | null>(null)
  const [progress, setProgress] = useState<DownloadProgress | null>(null)
  const [message, setMessage] = useState('')
  const [messageIsError, setMessageIsError] = useState(false)
  const operationInFlight = useRef(false)

  async function checkForUpdates(): Promise<void> {
    if (operationInFlight.current || phase === 'downloaded' || phase === 'installing') return
    operationInFlight.current = true
    setPhase('checking')
    setCheck(null)
    setAction(null)
    setProgress(null)
    setMessage('')
    setMessageIsError(false)
    try {
      const result = await adapter.check()
      setCheck(result)
      setPhase(result.status === 'available' ? 'available' : 'idle')
      setMessage(checkMessage(result))
      setMessageIsError(result.status === 'failed')
    } catch (error: unknown) {
      setPhase('idle')
      setMessage(adapterErrorMessage(error, '无法检查桌面更新，请稍后重试。'))
      setMessageIsError(true)
    } finally {
      operationInFlight.current = false
    }
  }

  async function downloadUpdate(): Promise<void> {
    const offer = check?.offer
    if (offer === null || offer === undefined || operationInFlight.current || phase !== 'available') return
    operationInFlight.current = true
    setPhase('downloading')
    setAction(null)
    setProgress({ received: 0, total: null })
    setMessage('正在下载并验证更新…')
    setMessageIsError(false)
    try {
      const result = await adapter.download(offer.offerId, recordProgress)
      setAction(result)
      switch (result.status) {
        case 'downloaded':
          setPhase('downloaded')
          setMessage('更新已下载并通过签名验证，可以安装。')
          break
        case 'busy':
          setPhase('available')
          setMessage(actionMessage(result, '桌面更新服务正忙，请稍后重试下载。'))
          break
        case 'stale':
          expireOffer(result)
          break
        case 'failed':
          setPhase('available')
          setMessage(actionMessage(result, '更新下载或签名验证失败，请重试。'))
          setMessageIsError(true)
          break
        default:
          setPhase('available')
          setMessage('桌面更新服务返回了无法识别的下载状态。')
      }
    } catch (error: unknown) {
      setPhase('available')
      setMessage(adapterErrorMessage(error, '无法下载或验证此更新。'))
      setMessageIsError(true)
    } finally {
      operationInFlight.current = false
    }
  }

  async function installUpdate(): Promise<void> {
    const offer = check?.offer
    if (offer === null || offer === undefined || operationInFlight.current || phase !== 'downloaded') return
    operationInFlight.current = true
    setAction(null)
    setMessage('正在请求桌面安装程序…')
    setMessageIsError(false)
    try {
      const result = await adapter.install(offer.offerId)
      setAction(result)
      switch (result.status) {
        case 'installing':
          setPhase('installing')
          setMessage('更新已应用，应用将退出；重新打开后确认版本。')
          break
        case 'cancelled':
          setPhase('downloaded')
          setMessage('已取消安装，应用没有更新。你可以稍后再次安装。')
          break
        case 'busy':
          setPhase('downloaded')
          setMessage(actionMessage(result, '桌面更新服务正忙，请稍后重试安装。'))
          break
        case 'stale':
          expireOffer(result)
          break
        case 'failed':
          setPhase('downloaded')
          setMessage(actionMessage(result, '安装程序未能启动；已下载的更新仍可重试。'))
          setMessageIsError(true)
          break
        default:
          setPhase('downloaded')
          setMessage('桌面更新服务返回了无法识别的安装状态。')
      }
    } catch (error: unknown) {
      setPhase('downloaded')
      setMessage(adapterErrorMessage(error, '无法启动桌面更新安装。'))
      setMessageIsError(true)
    } finally {
      operationInFlight.current = false
    }
  }

  function recordProgress(next: DesktopUpdateProgress): void {
    setProgress(current => ({
      received: (current?.received ?? 0) + next.chunkLength,
      total: next.contentLength ?? current?.total ?? null,
    }))
  }

  function expireOffer(result: DesktopUpdateActionResult): void {
    setCheck(current => current === null ? null : { ...current, status: 'stale', offer: null, error: result.error })
    setPhase('idle')
    setProgress(null)
    setMessage(actionMessage(result, '此更新已过期，请重新检查更新。'))
    setMessageIsError(false)
  }

  const offer = check?.offer ?? null
  const busy = phase === 'checking' || phase === 'downloading' || operationInFlight.current
  const checkDisabled = !adapter.available || busy || phase === 'downloaded' || phase === 'installing'

  return (
    <section aria-labelledby="desktop-update-title" style={panelStyle}>
      <div>
        <h3 id="desktop-update-title" style={{ margin: 0, fontSize: 'var(--font-size-md)' }}>软件更新</h3>
        <p style={{ margin: 'var(--space-2) 0 0', color: 'var(--color-ink-muted)', fontSize: 'var(--font-size-sm)' }}>
          更新包会在安装前验证签名。安装时若有 DSH 任务运行，桌面应用会先询问是否停止；任务不会自动恢复。
        </p>
      </div>

      {!adapter.available && (
        <p role="status" style={{ margin: 0, color: 'var(--color-ink-muted)' }}>
          更新服务仅在桌面应用中可用。
        </p>
      )}

      {check?.status === 'available' && offer !== null && (
        <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
          <p role="status" style={{ margin: 0 }}>
            发现新版本 <strong>{offer.version}</strong>（当前版本 {check.currentVersion || offer.currentVersion}）。
          </p>
          {offer.date && <p style={{ margin: 0, color: 'var(--color-ink-muted)', fontSize: 'var(--font-size-sm)' }}>发布日期：{offer.date}</p>}
          {offer.notes && (
            <p style={{ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{offer.notes}</p>
          )}
        </div>
      )}

      {phase === 'downloading' && progress !== null && (
        <DownloadProgressView progress={progress} />
      )}

      {message && (
        <p
          aria-live="polite"
          role={messageIsError ? 'alert' : 'status'}
          style={{ margin: 0, color: messageIsError ? 'var(--color-danger)' : 'var(--color-ink-muted)' }}
        >
          {message}
        </p>
      )}

      <div style={actionStyle}>
        <Button disabled={checkDisabled} onClick={() => { void checkForUpdates() }} variant="secondary">
          {phase === 'checking' ? '正在检查…' : '检查更新'}
        </Button>
        {(phase === 'available' || phase === 'downloading') && offer !== null && (
          <Button disabled={busy} onClick={() => { void downloadUpdate() }} variant="primary">
            {phase === 'downloading' ? '正在下载…' : '下载更新'}
          </Button>
        )}
        {phase === 'downloaded' && offer !== null && (
          <Button disabled={busy} onClick={() => { void installUpdate() }} variant="primary">安装更新</Button>
        )}
        {phase === 'installing' && (
          <Button disabled variant="primary">安装程序已启动</Button>
        )}
      </div>
    </section>
  )
}

function DownloadProgressView({ progress }: { readonly progress: DownloadProgress }) {
  const percent = progress.total !== null && progress.total > 0
    ? Math.min(100, Math.floor(progress.received / progress.total * 100))
    : null
  return (
    <div style={{ display: 'grid', gap: 'var(--space-1)' }}>
      {percent === null
        ? <progress aria-label="更新下载进度" />
        : <progress aria-label="更新下载进度" max={progress.total ?? undefined} value={Math.min(progress.received, progress.total ?? progress.received)} />}
      <p style={{ margin: 0, color: 'var(--color-ink-muted)', fontSize: 'var(--font-size-xs)' }}>
        {percent === null
          ? `已接收 ${formatBytes(progress.received)}`
          : `${percent}% · ${formatBytes(progress.received)} / ${formatBytes(progress.total ?? 0)}`}
      </p>
    </div>
  )
}

function checkMessage(result: DesktopUpdateCheckResult): string {
  switch (result.status) {
    case 'unavailable': return errorText(result.error?.message, '此桌面构建尚未配置更新来源。')
    case 'current': return `当前已是最新版本（${result.currentVersion || '版本未知'}）。`
    case 'available': return '可以下载并安装此版本。'
    case 'busy': return errorText(result.error?.message, '更新服务正忙，请稍后重试。')
    case 'stale': return '检查结果已过期，请重新检查更新。'
    case 'failed': return errorText(result.error?.message, '检查更新失败，请稍后重试。')
  }
}

function actionMessage(result: DesktopUpdateActionResult, fallback: string): string {
  return errorText(result.error?.message, fallback)
}

function adapterErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof DesktopUpdateAdapterError) return error.message
  return fallback
}

function errorText(message: string | undefined, fallback: string): string {
  return message && message.trim() !== '' ? message : fallback
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}
