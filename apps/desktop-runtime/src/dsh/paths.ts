import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DSH_PROFILE_NAME } from './config.ts'

export type DshRuntimeName = 'bun' | 'node'
export type DshRuntimeMode = 'development' | 'packaged'

export interface ResolveDshPathsOptions {
  mode: DshRuntimeMode
  runtime: DshRuntimeName
  /** Required for development; resolved from bundled `bin/` when packaged. */
  runtimeExecutable?: string
  /** Tauri's resource directory, required for installed application mode. */
  resourceDirectory?: string
  /** Per-user DSH home selected by the host. */
  home: string
}

export interface ResolvedDshPaths {
  mode: DshRuntimeMode
  runtime: DshRuntimeName
  runtimeRoot: string
  runtimeExecutable: string
  packageRoot: string
  cliEntry: string
  profilePatch: string
  home: string
  profileDirectory: string
  profileManifest: string
}

const PACKAGED_RUNTIME_PARTS = ['resources', 'generated', 'runtime'] as const
const require = createRequire(import.meta.url)

function requiredAbsolute(value: string | undefined, label: string): string {
  if (value === undefined || value.length === 0 || !isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`)
  }
  return resolve(value)
}

function runtimeExecutablePath(runtimeRoot: string, runtime: DshRuntimeName): string {
  const executable = runtime === 'bun' ? 'bun' : 'node'
  return join(runtimeRoot, 'bin', process.platform === 'win32' ? `${executable}.exe` : executable)
}

/** Resolve the pinned DSH CLI, profile patch, home, and selected runtime. */
export function resolveDshPaths(options: ResolveDshPathsOptions): ResolvedDshPaths {
  const home = requiredAbsolute(options.home, 'DSH home')
  let runtimeRoot: string
  let runtimeExecutable: string
  let packageRoot: string
  let profilePatch: string

  if (options.mode === 'development') {
    runtimeExecutable = requiredAbsolute(options.runtimeExecutable, 'Development runtime executable')
    const packageJson = require.resolve('@deepseek-ai/dsh/package.json') as string
    packageRoot = dirname(packageJson)
    const runtimePackageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
    runtimeRoot = runtimePackageRoot
    profilePatch = join(runtimePackageRoot, 'profiles', 'cheapai.yml')
  } else {
    const resourceDirectory = requiredAbsolute(options.resourceDirectory, 'Tauri resource directory')
    runtimeRoot = resolve(resourceDirectory, ...PACKAGED_RUNTIME_PARTS)
    runtimeExecutable = runtimeExecutablePath(runtimeRoot, options.runtime)
    packageRoot = join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh')
    profilePatch = join(runtimeRoot, 'profiles', 'cheapai.yml')
  }

  const profileDirectory = join(home, 'profiles', DSH_PROFILE_NAME)
  const paths: ResolvedDshPaths = {
    mode: options.mode,
    runtime: options.runtime,
    runtimeRoot,
    runtimeExecutable,
    packageRoot,
    cliEntry: join(packageRoot, 'lib', 'bin.js'),
    profilePatch,
    home,
    profileDirectory,
    profileManifest: join(profileDirectory, 'package.json'),
  }

  return paths
}
