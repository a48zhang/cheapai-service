import { constants } from 'node:fs'
import { access, readFile, stat } from 'node:fs/promises'
import { spawn, spawnSync } from 'node:child_process'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDmg } from './create-dmg.mjs'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDirectory, '../..')
const desktopRoot = join(repositoryRoot, 'apps/desktop')
const versionsPath = join(scriptDirectory, 'runtime-versions.json')
const developmentKeyModeVariable = 'SUB2API_DESKTOP_DEVELOPMENT_KEY_MODE'
const desktopRuntimeExecutableVariable = 'SUB2API_DESKTOP_RUNTIME_EXECUTABLE'
const desktopRuntimeNameVariable = 'SUB2API_DESKTOP_RUNTIME_NAME'

const credentialEnvironmentVariables = [
  'CHEAPAI_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'DEEPSEEK_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'OPENROUTER_API_KEY',
]

function usage() {
  return [
    'Usage:',
    '  pnpm dev:desktop -- --runtime <bun|node> --target <host-triple> [--runtime-executable <absolute-path>] [--development-key-mode]',
    '  pnpm package:desktop -- --runtime <bun|node> --target <host-triple>',
    '',
    'The target must match the current host. Development starts Tauri, whose configured beforeDevCommand starts Vite; the native host starts Runtime.',
    'Runtime versions are checked against scripts/desktop/runtime-versions.json. package downloads the matching pinned artifact.',
    '--development-key-mode is a development-only opt-in to the gated local account path. It reads and supplies no Key by itself.',
  ].join('\n')
}

function parseArguments(args) {
  // pnpm callers may preserve the argument separator after the subcommand.
  if (args[1] === '--') args = [args[0], ...args.slice(2)]
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    return { help: true }
  }

  const command = args[0]
  if (command !== 'dev' && command !== 'package') {
    throw new Error(`Choose either dev or package.\n${usage()}`)
  }

  const options = { command, developmentKeyMode: false }
  const valueOptions = new Set(['--runtime', '--runtime-executable', '--target'])
  const seen = new Set()
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--help' || argument === '-h') return { help: true }
    if (argument === '--development-key-mode') {
      if (seen.has(argument)) throw new Error(`${argument} may be supplied only once`)
      seen.add(argument)
      options.developmentKeyMode = true
      continue
    }
    if (!valueOptions.has(argument)) throw new Error(`Unknown argument: ${argument}\n${usage()}`)
    if (seen.has(argument)) throw new Error(`${argument} may be supplied only once`)
    seen.add(argument)
    const value = args[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${argument} requires a value\n${usage()}`)
    options[argument] = value
    index += 1
  }

  if (options['--runtime'] !== 'bun' && options['--runtime'] !== 'node') {
    throw new Error('--runtime must be bun or node')
  }
  if (options['--target'] === undefined) throw new Error('--target is required')
  if (command === 'package' && options.developmentKeyMode) {
    throw new Error('--development-key-mode is available only with the dev command')
  }
  if (command === 'package' && options['--runtime-executable'] !== undefined) {
    throw new Error('--runtime-executable is only used by dev; package selects the pinned artifact from --runtime')
  }
  if (options['--runtime-executable'] !== undefined && !isAbsolute(options['--runtime-executable'])) {
    throw new Error('--runtime-executable must be an absolute path')
  }

  return {
    help: false,
    command,
    runtime: options['--runtime'],
    runtimeExecutable: options['--runtime-executable'],
    target: options['--target'],
    developmentKeyMode: options.developmentKeyMode,
  }
}

function hostTarget() {
  const arch = process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : process.arch
  const targetOs = process.platform === 'darwin'
    ? 'apple-darwin'
    : process.platform === 'win32'
      ? 'pc-windows-msvc'
      : process.platform === 'linux'
        ? 'unknown-linux-gnu'
        : null
  return targetOs === null ? null : `${arch}-${targetOs}`
}

function runtimePins(versions, runtimeName, target) {
  const runtime = versions?.runtimes?.[runtimeName]
  if (typeof runtime?.version !== 'string') throw new Error(`No exact ${runtimeName} version is recorded`)
  const artifact = runtime.artifacts?.[target]
  if (artifact === undefined) throw new Error(`No pinned ${runtimeName} artifact is recorded for ${target}`)
  return { version: runtime.version, artifact }
}

async function usableExecutable(path) {
  try {
    const metadata = await stat(path)
    if (!metadata.isFile()) return false
    await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

function executableExtensions() {
  if (process.platform !== 'win32') return ['']
  const extensions = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
    .split(';')
    .filter(Boolean)
    .map(extension => extension.startsWith('.') ? extension : `.${extension}`)
  return [...new Set(['', ...extensions])]
}

async function resolveRuntimeExecutable(runtime, explicitPath) {
  if (explicitPath !== undefined) {
    if (!await usableExecutable(explicitPath)) {
      throw new Error(`Runtime executable is missing or not executable: ${explicitPath}`)
    }
    return explicitPath
  }

  if (runtime === 'node' && isAbsolute(process.execPath) && await usableExecutable(process.execPath)) {
    return process.execPath
  }
  const executableName = runtime === 'bun' ? 'bun' : 'node'
  const directories = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean)
  for (const directory of directories) {
    for (const extension of executableExtensions()) {
      const candidate = join(directory, `${executableName}${extension}`)
      if (await usableExecutable(candidate)) return candidate
    }
  }
  throw new Error(`Could not find ${executableName} on PATH; pass --runtime-executable with an absolute path`)
}

function verifyRuntimeVersion(executable, runtime, expectedVersion) {
  const result = spawnSync(executable, ['--version'], {
    encoding: 'utf8',
    timeout: 5_000,
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error !== undefined) throw new Error(`Could not read the selected ${runtime} version: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`The selected ${runtime} executable failed its --version command`)
  const output = String(result.stdout ?? '').trim()
  const actualVersion = (output.split(/\r?\n/u)[0] ?? '').replace(/^v/u, '').trim()
  if (actualVersion !== expectedVersion) {
    throw new Error(`Expected pinned ${runtime} ${expectedVersion}, received ${actualVersion || 'an empty version'}`)
  }
}

function cleanEnvironment({ command, runtimeExecutable, runtime, developmentKeyMode }) {
  const env = { ...process.env }
  for (const name of credentialEnvironmentVariables) delete env[name]
  delete env[developmentKeyModeVariable]
  delete env[desktopRuntimeExecutableVariable]
  delete env[desktopRuntimeNameVariable]
  delete env.SUB2API_DSH_HOME
  delete env.SUB2API_DSH_WORKSPACE_DIRECTORY
  delete env.SUB2API_DSH_RESOURCE_DIRECTORY
  delete env.SUB2API_DSH_RUNTIME_EXECUTABLE
  if (command === 'dev') {
    env[desktopRuntimeExecutableVariable] = runtimeExecutable
    env[desktopRuntimeNameVariable] = runtime
    if (developmentKeyMode) env[developmentKeyModeVariable] = '1'
  }
  return env
}

async function resolveTauriCli(expectedVersion) {
  const packageDirectory = join(desktopRoot, 'node_modules/@tauri-apps/cli')
  let metadata
  try {
    metadata = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8'))
  } catch {
    throw new Error(`Pinned Tauri CLI is not installed at ${packageDirectory}; install the workspace dependencies first`)
  }
  if (metadata.version !== expectedVersion) {
    throw new Error(`Tauri CLI version mismatch: expected ${expectedVersion}, found ${metadata.version ?? 'unknown'}`)
  }
  const entry = join(packageDirectory, 'tauri.js')
  try {
    if (!(await stat(entry)).isFile()) throw new Error()
  } catch {
    throw new Error(`Pinned Tauri CLI entry is missing: ${entry}`)
  }
  return entry
}

function runProcess(label, executable, args, cwd, env) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(executable, args, {
        cwd,
        env,
        shell: false,
        windowsHide: false,
        stdio: 'inherit',
      })
    } catch {
      reject(new Error(`Could not start ${label}`))
      return
    }
    child.once('error', () => reject(new Error(`Could not start ${label}`)))
    child.once('close', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`${label} failed${signal === null ? ` with exit code ${code}` : ` after ${signal}`}`))
    })
  })
}

async function runPnpmBuild(env) {
  const pnpmScript = process.env.npm_execpath
  if (typeof pnpmScript === 'string' && isAbsolute(pnpmScript)) {
    const nodeExecutable = process.env.npm_node_execpath && isAbsolute(process.env.npm_node_execpath)
      ? process.env.npm_node_execpath
      : process.execPath
    await runProcess('pnpm desktop build', nodeExecutable, [pnpmScript, 'run', 'build:desktop'], repositoryRoot, env)
    return
  }
  if (process.platform === 'win32') {
    await runProcess('pnpm desktop build', 'cmd.exe', ['/d', '/s', '/c', 'pnpm run build:desktop'], repositoryRoot, env)
    return
  }
  await runProcess('pnpm desktop build', 'pnpm', ['run', 'build:desktop'], repositoryRoot, env)
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(`${usage()}\n`)
    return
  }

  const target = hostTarget()
  if (target === null) throw new Error(`Unsupported desktop development host: ${process.platform}-${process.arch}`)
  if (options.target !== target) {
    throw new Error(`--target must match this host (${target}); received ${options.target}`)
  }

  const versions = JSON.parse(await readFile(versionsPath, 'utf8'))
  const runtime = runtimePins(versions, options.runtime, target)
  if (options.command === 'package'
    && !versions.targets?.some(entry => entry.triple === target)) {
    throw new Error(`No Tauri package target is declared for ${target}`)
  }

  const cliVersion = versions.desktop?.tauri?.cli
  if (typeof cliVersion !== 'string') throw new Error('No exact Tauri CLI version is recorded')
  const tauriCli = await resolveTauriCli(cliVersion)

  let runtimeExecutable
  if (options.command === 'dev') {
    runtimeExecutable = await resolveRuntimeExecutable(options.runtime, options.runtimeExecutable)
    verifyRuntimeVersion(runtimeExecutable, options.runtime, runtime.version)
  }
  const env = cleanEnvironment({
    command: options.command,
    runtimeExecutable,
    runtime: options.runtime,
    developmentKeyMode: options.developmentKeyMode,
  })

  if (options.command === 'dev') {
    if (options.runtime === 'bun') {
      process.stdout.write(`Using pinned Bun ${runtime.version}; DSH compatibility remains unverified.\n`)
    } else {
      process.stdout.write(`Using pinned Node ${runtime.version}. Login-priority account mode is the default.\n`)
    }
    if (options.developmentKeyMode) {
      process.stdout.write('Development Key mode is explicitly enabled; no Key is read or supplied by this launcher.\n')
    }
    await runProcess('Tauri development host', process.execPath, [tauriCli, 'dev', '--target', target], desktopRoot, env)
    return
  }

  process.stdout.write(`Packaging the pinned ${options.runtime} ${runtime.version} artifact for ${target}.\n`)
  if (options.runtime === 'bun') {
    process.stdout.write('Bun remains an unverified DSH comparison candidate.\n')
  }
  await runPnpmBuild(env)
  await runProcess(
    'Runtime resource preparation',
    process.execPath,
    [join(scriptDirectory, 'prepare-runtime.mjs'), '--target', target, '--runtime', options.runtime],
    repositoryRoot,
    env,
  )
  await runProcess(
    'Tauri icon preparation',
    process.execPath,
    [join(scriptDirectory, 'prepare-icons.mjs')],
    repositoryRoot,
    env,
  )
  await runProcess(
    'Desktop release manifest preparation',
    process.execPath,
    [join(scriptDirectory, 'release-manifest.mjs'), '--target', target, '--runtime', options.runtime],
    repositoryRoot,
    env,
  )
  const config = JSON.parse(await readFile(join(desktopRoot, 'src-tauri/tauri.conf.json'), 'utf8'))
  // Keep configured signing workflows with Tauri. Unsigned developer images
  // need no writable mount or Finder customization (CI already skips it).
  const hasAppleSigning = config.bundle?.macOS?.signingIdentity || [
    'APPLE_SIGNING_IDENTITY', 'APPLE_CERTIFICATE', 'APPLE_API_KEY',
    'APPLE_API_ISSUER', 'APPLE_ID',
  ].some(name => Boolean(env[name]))
  const plainDmg = process.platform === 'darwin' && !hasAppleSigning
  const bundle = process.platform === 'darwin' ? (plainDmg ? 'app' : 'dmg') : 'nsis'
  // Tauri only emits installer subprocess stdout/stderr at verbose level.
  // Keep that evidence when hdiutil or NSIS fails after a successful Rust build.
  await runProcess('Tauri package build', process.execPath, [tauriCli, 'build', '--verbose', '--target', target, '--bundles', bundle], desktopRoot, env)
  if (plainDmg) {
    const bundleRoot = join(desktopRoot, 'src-tauri/target', target, 'release/bundle')
    const architecture = target.startsWith('aarch64-') ? 'aarch64' : 'x64'
    await createDmg({
      app: join(bundleRoot, 'macos', `${config.productName}.app`),
      output: join(bundleRoot, 'dmg', `${config.productName}_${config.version}_${architecture}.dmg`),
      volumeName: config.productName,
    })
  }
}

main().catch(error => {
  process.stderr.write(`Desktop command failed: ${error instanceof Error ? error.message : 'unknown error'}\n`)
  process.exitCode = 1
})
