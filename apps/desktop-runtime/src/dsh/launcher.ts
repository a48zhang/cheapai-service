import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
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

  const profile = createDshProfileLaunchConfig({
    home: paths.home,
    patchFile: paths.profilePatch,
    port: options.port ?? 0,
    initializeProfile: !profileDirectoryExists,
  })
  const env: Record<string, string> = { ...process.env as Record<string, string>, ...profile.env }
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value !== undefined) env[key] = value
    else delete env[key]
  }

  const child = spawn(paths.runtimeExecutable, [paths.cliEntry, ...profile.args], {
    cwd: workspaceDirectory,
    env,
    shell: false,
    windowsHide: true,
    stdio: 'pipe',
  })
  return { child, paths }
}
