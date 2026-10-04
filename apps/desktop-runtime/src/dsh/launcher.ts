import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DESKTOP_CREDENTIAL_SOCKET_ENV } from '../cheapai/credential-bridge.ts'
import { createDshProfileLaunchConfig } from './config.ts'
import {
  resolveDshPaths,
  type DshRuntimeMode,
  type DshRuntimeName,
  type ResolvedDshPaths,
} from './paths.ts'

export interface LaunchDshOptions {
  mode: DshRuntimeMode
  runtime: DshRuntimeName
  /** Runtime executable path in development; packaged mode uses its bundled binary. */
  runtimeExecutable?: string
  /** Tauri resource directory in packaged mode. */
  resourceDirectory?: string
  /** Per-user DSH home supplied by the host. */
  home: string
  /** Selected project directory; DSH is never launched from the app install directory. */
  workspaceDirectory: string
  /** DSH Web Host port; zero requests an OS-assigned loopback port. */
  port?: number
  /** Additional non-secret inherited environment values. */
  env?: Record<string, string | undefined>
}

export interface LaunchedDshProcess {
  child: ChildProcessWithoutNullStreams
  paths: ResolvedDshPaths
}

function writeCredentialProviderPatch(paths: ResolvedDshPaths): string {
  const moduleExtension = paths.mode === 'development' ? 'ts' : 'js'
  const modulePath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'cheapai',
    `dsh-credential-provider.${moduleExtension}`,
  )
  if (!existsSync(modulePath)) {
    throw new Error(`DSH credential bridge provider is missing at ${modulePath}`)
  }

  const patchPath = join(paths.home, 'cheapai-credential-provider.yml')
  mkdirSync(paths.home, { recursive: true, mode: 0o700 })
  const patch = [
    '- id: credentials',
    '  disabled: true',
    '- insert:',
    '    - id: cheapai-credentials',
    `      name: ${JSON.stringify(pathToFileURL(modulePath).href)}`,
    '',
  ].join('\n')
  writeFileSync(patchPath, patch, { encoding: 'utf8', mode: 0o600 })
  chmodSync(patchPath, 0o600)
  return patchPath
}

function validateAbsoluteDirectory(value: string, label: string): string {
  if (!isAbsolute(value)) throw new Error(`${label} must be an absolute path`)
  return value
}

/** Spawn the pinned DSH CLI through an explicit Node or Bun executable path. */
export function launchDsh(options: LaunchDshOptions): LaunchedDshProcess {
  const workspaceDirectory = validateAbsoluteDirectory(options.workspaceDirectory, 'DSH workspace directory')
  const paths = resolveDshPaths(options)
  for (const [path, label] of [
    [paths.runtimeExecutable, 'runtime executable'],
    [paths.cliEntry, 'DSH CLI entry'],
    [paths.profilePatch, 'cheapai profile patch'],
  ] as const) {
    if (!existsSync(path)) throw new Error(`DSH ${label} is missing at ${path}`)
  }

  const profileDirectoryExists = existsSync(paths.profileDirectory)
  const profileManifestExists = existsSync(paths.profileManifest)
  if (profileDirectoryExists && !profileManifestExists) {
    throw new Error(`DSH profile directory exists without a package.json: ${paths.profileDirectory}`)
  }

  const credentialSocketAddress = options.env?.[DESKTOP_CREDENTIAL_SOCKET_ENV]
  if (credentialSocketAddress !== undefined && credentialSocketAddress.length === 0) {
    throw new Error('DSH credential bridge address is empty')
  }
  const credentialProviderPatchFile = credentialSocketAddress === undefined
    ? undefined
    : writeCredentialProviderPatch(paths)

  const profile = createDshProfileLaunchConfig({
    home: paths.home,
    patchFile: paths.profilePatch,
    ...(credentialProviderPatchFile === undefined ? {} : { credentialProviderPatchFile }),
    port: options.port ?? 0,
    initializeProfile: !profileDirectoryExists,
  })
  const env: Record<string, string> = { ...process.env as Record<string, string>, ...profile.env }
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value !== undefined) env[key] = value
    else delete env[key]
  }
  if (credentialSocketAddress === undefined) delete env[DESKTOP_CREDENTIAL_SOCKET_ENV]

  const child = spawn(paths.runtimeExecutable, [paths.cliEntry, ...profile.args], {
    cwd: workspaceDirectory,
    env,
    shell: false,
    windowsHide: true,
    stdio: 'pipe',
  })
  return { child, paths }
}
