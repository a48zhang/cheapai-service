import { invoke } from '@tauri-apps/api/core'
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-api-workspace-files/remote'

export interface WorkspaceDirectoryEntry {
  readonly name: string
  readonly path: string
}

export interface WorkspaceDirectoryListing {
  readonly entries: readonly WorkspaceDirectoryEntry[]
  readonly truncated: boolean
}

export interface DshWorkspaceFilesListingValue {
  readonly path: string
  readonly entries: readonly {
    readonly name: string
    readonly type: 'file' | 'directory' | 'other'
    readonly size?: number
  }[]
  readonly truncated: boolean
}

export interface DshWorkspaceFilesStatValue {
  readonly absolutePath: string
  readonly version: unknown
  readonly bytes?: number
}

/** The actual pinned DSH Remote namespace; the caller mounts its descriptor once. */
export type DshWorkspaceFilesRemote = Pick<ClientRemote['workspaceFiles'], 'list' | 'stat'>

export interface NativeWorkspaceDirectoryAdapter {
  readonly kind: 'native'
  chooseDirectory(): Promise<string | null>
}

export interface DshWorkspaceDirectoryAdapter {
  readonly kind: 'dsh'
  /** Initial navigation root is the cwd of the DSH Session that scopes the Remote. */
  readonly rootPath: string
  listDirectories(path: string): Promise<WorkspaceDirectoryListing>
  selectDirectory(path: string): Promise<string>
}

export interface UnavailableWorkspaceDirectoryAdapter {
  readonly kind: 'unavailable'
  readonly message: string
}

export type WorkspaceDirectoryAdapter =
  | NativeWorkspaceDirectoryAdapter
  | DshWorkspaceDirectoryAdapter
  | UnavailableWorkspaceDirectoryAdapter

export interface DshWorkspaceDirectoryScope {
  /** ID of the real DSH Session whose header cwd scopes WorkspaceFiles calls. */
  readonly sessionId: string
  readonly cwd: string
}

export interface WorkspaceDirectoryAdapterOptions {
  readonly workspaceFiles?: DshWorkspaceFilesRemote | null
  readonly existingSession?: DshWorkspaceDirectoryScope | null
}

/** Native selection uses the host dialog; the browser only browses a real DSH Session scope. */
export function createWorkspaceDirectoryAdapter(
  options: WorkspaceDirectoryAdapterOptions = {},
): WorkspaceDirectoryAdapter {
  if (isNativeHost()) return createNativeDirectoryAdapter()

  if (options.workspaceFiles !== undefined && options.workspaceFiles !== null
    && options.existingSession !== undefined && options.existingSession !== null) {
    return createDshWorkspaceDirectoryAdapter(options.workspaceFiles, options.existingSession)
  }

  return Object.freeze({
    kind: 'unavailable',
    message: '浏览器目录浏览需要一个现有的 DSH 会话；连接就绪前不会使用默认目录。',
  })
}

/** Tauri implements this command through the native OS directory picker. */
export function createNativeDirectoryAdapter(): NativeWorkspaceDirectoryAdapter {
  return Object.freeze({
    kind: 'native',
    chooseDirectory: async () => {
      const selectedPath = await invoke<unknown>('choose_workspace_directory')
      if (selectedPath === null) return null
      if (typeof selectedPath !== 'string' || !isAbsolutePath(selectedPath)) {
        throw new Error('The native directory picker returned an invalid path')
      }
      return selectedPath
    },
  })
}

/**
 * Browser prototype backed by DSH's actual workspaceFiles.list/stat Remote.
 * Host confinement is derived from `scope.sessionId` and that Session's cwd;
 * it cannot browse arbitrary host paths before a matching DSH Session exists.
 */
export function createDshWorkspaceDirectoryAdapter(
  workspaceFiles: DshWorkspaceFilesRemote,
  scope: DshWorkspaceDirectoryScope,
): DshWorkspaceDirectoryAdapter {
  if (scope.sessionId.length === 0 || !isAbsolutePath(scope.cwd)) {
    throw new TypeError('A real DSH session id and absolute cwd are required for directory browsing')
  }
  const rootPath = scope.cwd

  return Object.freeze({
    kind: 'dsh',
    rootPath,
    listDirectories: async (path: string): Promise<WorkspaceDirectoryListing> => {
      const requestedPath = assertWithinRoot(rootPath, path)
      const listing = unwrapRemote<DshWorkspaceFilesListingValue>(
        await workspaceFiles.list(scope.sessionId, requestedPath),
      )
      if (!isDshListing(listing)) throw new Error('DSH returned an invalid workspace directory listing')

      const entries = listing.entries.flatMap(entry => {
        if (entry.type !== 'directory' || !isDirectoryName(entry.name)) return []
        return [{ name: entry.name, path: joinPath(requestedPath, entry.name) }]
      })
      return Object.freeze({
        entries: Object.freeze(entries),
        truncated: listing.truncated,
      })
    },
    selectDirectory: async (path: string): Promise<string> => {
      const requestedPath = assertWithinRoot(rootPath, path)
      // Listing proves this is a directory; stat confirms its canonical Host path.
      const listing = unwrapRemote<DshWorkspaceFilesListingValue>(
        await workspaceFiles.list(scope.sessionId, requestedPath),
      )
      if (!isDshListing(listing)) throw new Error('DSH returned an invalid workspace directory listing')
      const stat = unwrapRemote<DshWorkspaceFilesStatValue>(
        await workspaceFiles.stat(scope.sessionId, requestedPath),
      )
      if (!isDshStat(stat) || !isWithinRoot(rootPath, stat.absolutePath)) {
        throw new Error('DSH did not confirm a directory inside the selected Session workspace')
      }
      return stat.absolutePath
    },
  })
}

function isNativeHost(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

function unwrapRemote<T>(result: unknown): T {
  if (isRecord(result) && typeof result.ok === 'boolean') {
    if (result.ok && Object.hasOwn(result, 'value')) return result.value as T
    throw new Error('DSH workspace directory request failed')
  }
  return result as T
}

function isDshListing(value: unknown): value is DshWorkspaceFilesListingValue {
  return isRecord(value)
    && typeof value.path === 'string'
    && typeof value.truncated === 'boolean'
    && Array.isArray(value.entries)
    && value.entries.every(entry => isRecord(entry)
      && typeof entry.name === 'string'
      && (entry.type === 'file' || entry.type === 'directory' || entry.type === 'other'))
}

function isDshStat(value: unknown): value is DshWorkspaceFilesStatValue {
  return isRecord(value)
    && typeof value.absolutePath === 'string'
    && isAbsolutePath(value.absolutePath)
}

function assertWithinRoot(rootPath: string, path: string): string {
  if (!isAbsolutePath(path) || !isWithinRoot(rootPath, path)) {
    throw new Error('The selected directory is outside the DSH Session workspace')
  }
  return path
}

function isWithinRoot(rootPath: string, path: string): boolean {
  const root = normalizedPath(rootPath)
  const candidate = normalizedPath(path)
  const caseInsensitive = isWindowsAbsolutePath(rootPath)
  const comparableRoot = caseInsensitive ? root.toLowerCase() : root
  const comparableCandidate = caseInsensitive ? candidate.toLowerCase() : candidate
  return comparableCandidate === comparableRoot
    || comparableCandidate.startsWith(comparableRoot.endsWith('/') ? comparableRoot : `${comparableRoot}/`)
}

function normalizedPath(path: string): string {
  const separators = path.replace(/\\/gu, '/')
  const drive = /^[A-Za-z]:\//u.exec(separators)?.[0]
  const prefix = drive ?? (separators.startsWith('//') ? '//' : separators.startsWith('/') ? '/' : '')
  const body = separators.slice(prefix.length)
  const normalized = body.split('/').reduce<string[]>((parts, segment) => {
    if (segment.length === 0 || segment === '.') return parts
    if (segment === '..') {
      if (parts.length > 0) parts.pop()
      return parts
    }
    parts.push(segment)
    return parts
  }, []).join('/')
  if (prefix === '//') return `//${normalized}`
  if (prefix === '/') return `/${normalized}`
  return `${prefix}${normalized}`
}

function joinPath(parent: string, name: string): string {
  if (!isDirectoryName(name)) throw new Error('DSH returned an invalid directory name')
  const separator = isWindowsAbsolutePath(parent) && parent.includes('\\') ? '\\' : '/'
  const trimmedParent = parent.replace(/[\\/]+$/u, '')
  return `${trimmedParent}${separator}${name}`
}

function isDirectoryName(value: string): boolean {
  return value.length > 0
    && value !== '.'
    && value !== '..'
    && !/[\\/\u0000-\u001f\u007f]/u.test(value)
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/')
    || /^[A-Za-z]:[\\/]/u.test(value)
    || /^\\\\[^\\]+\\[^\\]+/u.test(value)
    || /^\/\/[^/]+\/[^/]+/u.test(value)
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(value)
    || /^\\\\[^\\]+\\[^\\]+/u.test(value)
    || /^\/\/[^/]+\/[^/]+/u.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
