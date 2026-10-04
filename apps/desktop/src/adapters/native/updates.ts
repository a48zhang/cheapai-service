import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export type DesktopUpdateCheckStatus = 'unavailable' | 'current' | 'available' | 'busy' | 'stale' | 'failed'
export type DesktopUpdateDownloadStatus = 'downloaded' | 'busy' | 'stale' | 'failed'
export type DesktopUpdateInstallStatus = 'cancelled' | 'installing' | 'busy' | 'stale' | 'failed'

export interface DesktopUpdateErrorValue {
  readonly code: string
  readonly message: string
}

export interface DesktopUpdateOffer {
  readonly offerId: number
  readonly currentVersion: string
  readonly version: string
  readonly date: string | null
  readonly notes: string | null
}

export interface DesktopUpdateCheckResult {
  readonly status: DesktopUpdateCheckStatus
  readonly currentVersion: string
  readonly offer: DesktopUpdateOffer | null
  readonly error: DesktopUpdateErrorValue | null
}

export interface DesktopUpdateActionResult {
  readonly status: DesktopUpdateDownloadStatus | DesktopUpdateInstallStatus
  readonly offerId: number
  readonly version: string | null
  readonly error: DesktopUpdateErrorValue | null
}

export interface DesktopUpdateProgress {
  readonly offerId: number
  readonly chunkLength: number
  readonly contentLength: number | null
}

export interface DesktopUpdateAdapter {
  readonly available: boolean
  check(): Promise<DesktopUpdateCheckResult>
  download(offerId: number, onProgress: (progress: DesktopUpdateProgress) => void): Promise<DesktopUpdateActionResult>
  install(offerId: number): Promise<DesktopUpdateActionResult>
}

export class DesktopUpdateAdapterError extends Error {
  constructor(readonly code: 'unavailable' | 'command-failed' | 'invalid-response', message: string) {
    super(message)
    this.name = 'DesktopUpdateAdapterError'
  }
}

/** Typed Tauri boundary for the native updater; browser mode is explicitly unavailable. */
export function createDesktopUpdateAdapter(): DesktopUpdateAdapter {
  if (!isTauri()) return createUnavailableDesktopUpdateAdapter()

  let currentOfferId: number | undefined
  return Object.freeze({
    available: true,
    check: async (): Promise<DesktopUpdateCheckResult> => {
      // A new check invalidates every prior in-memory offer, even if its RPC fails.
      currentOfferId = undefined
      try {
        const result = projectCheck(await invoke<unknown>('desktop_update_check'))
        if (result.status === 'available' && result.offer !== null) currentOfferId = result.offer.offerId
        return result
      } catch (error) {
        if (error instanceof DesktopUpdateAdapterError) throw error
        throw new DesktopUpdateAdapterError('command-failed', '无法检查桌面更新，请稍后重试。')
      }
    },
    download: async (offerId, onProgress): Promise<DesktopUpdateActionResult> => {
      if (!isOfferId(offerId) || currentOfferId !== offerId) return staleAction(offerId)
      let unlisten: UnlistenFn | undefined
      try {
        unlisten = await listen<unknown>('desktop-update-download-progress', event => {
          const progress = projectProgress(event.payload)
          if (progress?.offerId === offerId) onProgress(progress)
        })
        const result = projectAction(
          await invoke<unknown>('desktop_update_download', { offerId }),
          offerId,
          ['downloaded', 'busy', 'stale', 'failed'],
        )
        if (result.status === 'stale') currentOfferId = undefined
        return result
      } catch (error) {
        if (error instanceof DesktopUpdateAdapterError) throw error
        throw new DesktopUpdateAdapterError('command-failed', '无法下载或验证此更新。')
      } finally {
        unlisten?.()
      }
    },
    install: async (offerId): Promise<DesktopUpdateActionResult> => {
      if (!isOfferId(offerId) || currentOfferId !== offerId) return staleAction(offerId)
      try {
        const result = projectAction(
          await invoke<unknown>('desktop_update_install', { offerId }),
          offerId,
          ['cancelled', 'installing', 'busy', 'stale', 'failed'],
        )
        if (result.status === 'stale') currentOfferId = undefined
        return result
      } catch (error) {
        if (error instanceof DesktopUpdateAdapterError) throw error
        throw new DesktopUpdateAdapterError('command-failed', '无法启动桌面更新安装。')
      }
    },
  })
}

export function createUnavailableDesktopUpdateAdapter(): DesktopUpdateAdapter {
  const unavailable = (): DesktopUpdateAdapterError => new DesktopUpdateAdapterError(
    'unavailable',
    '更新服务仅在桌面应用中可用。',
  )
  return Object.freeze({
    available: false,
    check: async (): Promise<DesktopUpdateCheckResult> => ({
      status: 'unavailable',
      currentVersion: '',
      offer: null,
      error: { code: 'native-unavailable', message: unavailable().message },
    }),
    download: async (): Promise<DesktopUpdateActionResult> => { throw unavailable() },
    install: async (): Promise<DesktopUpdateActionResult> => { throw unavailable() },
  })
}

function projectCheck(value: unknown): DesktopUpdateCheckResult {
  if (!isRecord(value)
    || !isOneOf(value.status, ['unavailable', 'current', 'available', 'busy', 'stale', 'failed'])
    || typeof value.currentVersion !== 'string'
    || (value.offer !== null && !isOffer(value.offer))
    || (value.error !== null && !isUpdateError(value.error))) return invalidResponse()

  if (value.status === 'available' && value.offer === null) return invalidResponse()
  if (value.status !== 'available' && value.offer !== null) return invalidResponse()
  return Object.freeze({
    status: value.status,
    currentVersion: value.currentVersion,
    offer: value.offer === null ? null : projectOffer(value.offer),
    error: value.error === null ? null : projectUpdateError(value.error),
  })
}

function projectAction(
  value: unknown,
  offerId: number,
  statuses: readonly string[],
): DesktopUpdateActionResult {
  if (!isRecord(value)
    || !isOneOf(value.status, statuses)
    || value.offerId !== offerId
    || (value.version !== null && typeof value.version !== 'string')
    || (value.error !== null && !isUpdateError(value.error))) return invalidResponse()
  return Object.freeze({
    status: value.status as DesktopUpdateActionResult['status'],
    offerId,
    version: value.version,
    error: value.error === null ? null : projectUpdateError(value.error),
  })
}

function projectProgress(value: unknown): DesktopUpdateProgress | undefined {
  if (!isRecord(value) || !isOfferId(value.offerId)
    || !isNonNegativeInteger(value.chunkLength)
    || (value.contentLength !== null && !isNonNegativeInteger(value.contentLength))) return undefined
  return Object.freeze({
    offerId: value.offerId,
    chunkLength: value.chunkLength,
    contentLength: value.contentLength,
  })
}

function projectOffer(value: unknown): DesktopUpdateOffer {
  if (!isOffer(value)) return invalidResponse()
  return Object.freeze({
    offerId: value.offerId,
    currentVersion: value.currentVersion,
    version: value.version,
    date: value.date,
    notes: value.notes,
  })
}

function isOffer(value: unknown): value is DesktopUpdateOffer {
  return isRecord(value)
    && isOfferId(value.offerId)
    && typeof value.currentVersion === 'string'
    && typeof value.version === 'string'
    && (value.date === null || typeof value.date === 'string')
    && (value.notes === null || typeof value.notes === 'string')
}

function isUpdateError(value: unknown): value is DesktopUpdateErrorValue {
  return isRecord(value) && typeof value.code === 'string' && typeof value.message === 'string'
}

function projectUpdateError(value: unknown): DesktopUpdateErrorValue {
  if (!isUpdateError(value)) return invalidResponse()
  return Object.freeze({ code: value.code, message: value.message })
}

function staleAction(offerId: number): DesktopUpdateActionResult {
  return Object.freeze({
    status: 'stale',
    offerId,
    version: null,
    error: Object.freeze({
      code: 'stale-offer',
      message: '此更新已过期，请重新检查更新。',
    }),
  })
}

function invalidResponse(): never {
  throw new DesktopUpdateAdapterError('invalid-response', '桌面更新服务返回了无效响应。')
}

function isOfferId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isOneOf<const Values extends readonly string[]>(value: unknown, values: Values): value is Values[number] {
  return typeof value === 'string' && values.includes(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
