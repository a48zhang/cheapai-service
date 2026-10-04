import { constants } from 'node:fs'
import { access, lstat, mkdir, readFile, realpath, stat } from 'node:fs/promises'
import { spawn, spawnSync } from 'node:child_process'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const FIXTURE_KIND = 'cheapai-desktop-runtime-fixture'
const FIXTURE_MARKER = '.cheapai-desktop-fixture.json'
const BOOTSTRAP_TIMEOUT_MS = 15_000
const START_TIMEOUT_MS = 40_000
const MAX_PROTOCOL_LINE_LENGTH = 1024 * 1024
const DEVELOPMENT_KEY_MODE_VARIABLE = 'SUB2API_DESKTOP_DEVELOPMENT_KEY_MODE'

function usage() {
  return [
    'Usage: node scripts/desktop/dev-runtime.mjs --runtime <bun|node> --home <new-temp-home> --workspace <fixture-workspace> [--runtime-executable <absolute-path>] [--development-key-mode]',
    'The workspace must come from create-fixture.mjs. The home must not exist and both paths must be inside the operating system temporary directory.',
    'Without --development-key-mode, this command starts only the Runtime sidecar and exits; it does not start DSH.',
    '--development-key-mode explicitly enables the no-account development fixture path. It reads and sends no Key.',
  ].join('\n')
}

function parseArguments(args) {
  const options = { developmentKeyMode: false }
  const valueOptions = new Set(['--runtime', '--runtime-executable', '--home', '--workspace'])
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--help' || argument === '-h') {
      options.help = true
      continue
    }
    if (argument === '--development-key-mode') {
      if (options.developmentKeyMode) throw new Error(`${argument} may be supplied only once`)
      options.developmentKeyMode = true
      continue
    }
    if (!valueOptions.has(argument)) throw new Error(`Unknown argument: ${argument}\n${usage()}`)
    if (options[argument] !== undefined) throw new Error(`${argument} may be supplied only once`)
    const value = args[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${argument} requires a value\n${usage()}`)
    options[argument] = value
    index += 1
  }
  if (options.help) return options
  for (const argument of ['--runtime', '--home', '--workspace']) {
    if (options[argument] === undefined) throw new Error(usage())
  }
  if (options['--runtime'] !== 'bun' && options['--runtime'] !== 'node') {
    throw new Error(`Unsupported runtime ${options['--runtime']}; choose bun or node`)
  }
  return {
    help: false,
    runtime: options['--runtime'],
    ...(options['--runtime-executable'] === undefined ? {} : { runtimeExecutable: options['--runtime-executable'] }),
    home: options['--home'],
    workspace: options['--workspace'],
    developmentKeyMode: options.developmentKeyMode,
  }
}

function isWithin(directory, candidate) {
  const pathFromDirectory = relative(directory, candidate)
  return pathFromDirectory === ''
    || (pathFromDirectory !== '..'
      && !pathFromDirectory.startsWith(`..${sep}`)
      && !isAbsolute(pathFromDirectory))
}

function isStrictlyWithin(directory, candidate) {
  return candidate !== directory && isWithin(directory, candidate)
}

async function canonicalExistingDirectory(pathArgument, label, temporaryRoot) {
  if (!isAbsolute(pathArgument)) throw new Error(`${label} must be an absolute path`)
  const path = await realpath(pathArgument)
  const info = await stat(path)
  if (!info.isDirectory()) throw new Error(`${label} must be a directory`)
  if (!isStrictlyWithin(temporaryRoot, path)) {
    throw new Error(`Refusing to use ${label} outside the operating system temporary directory: ${path}`)
  }
  return path
}

async function canonicalNewDirectory(pathArgument, label, temporaryRoot) {
  if (!isAbsolute(pathArgument)) throw new Error(`${label} must be an absolute path`)
  const requestedPath = join(resolve(pathArgument))
  const parentDirectory = await realpath(dirname(requestedPath))
  const path = join(parentDirectory, basename(requestedPath))
  if (!isStrictlyWithin(temporaryRoot, path)) {
    throw new Error(`Refusing to create ${label} outside the operating system temporary directory: ${requestedPath}`)
  }
  try {
    await lstat(path)
    throw new Error(`Refusing to reuse the existing ${label}: ${path}`)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Refusing to reuse')) throw error
    if (error?.code !== 'ENOENT') throw error
  }
  return path
}

async function validateFixtureWorkspace(workspace) {
  const markerPath = join(workspace, FIXTURE_MARKER)
  const markerInfo = await lstat(markerPath)
  if (!markerInfo.isFile()) throw new Error(`Fixture marker must be a regular file: ${markerPath}`)
  let marker
  try {
    marker = JSON.parse(await readFile(markerPath, 'utf8'))
  } catch {
    throw new Error(`Fixture marker is invalid: ${markerPath}`)
  }
  if (marker?.schema_version !== 1 || marker?.kind !== FIXTURE_KIND || typeof marker?.fixture_id !== 'string') {
    throw new Error(`Workspace was not created by create-fixture.mjs: ${workspace}`)
  }
}

function windowsExtensions() {
  if (process.platform !== 'win32') return ['']
  const extensions = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
    .split(';')
    .filter(Boolean)
    .map(extension => extension.startsWith('.') ? extension : `.${extension}`)
  return [...new Set(['', ...extensions])]
}

async function usableExecutable(path) {
  try {
    const info = await stat(path)
    if (!info.isFile()) return false
    await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function resolveRuntimeExecutable(runtime, explicitPath) {
  if (explicitPath !== undefined) {
    if (!isAbsolute(explicitPath)) throw new Error('--runtime-executable must be an absolute path')
    if (!await usableExecutable(explicitPath)) throw new Error(`Runtime executable is missing or not executable: ${explicitPath}`)
    return explicitPath
  }

  const name = runtime === 'bun' ? 'bun' : 'node'
  const searchDirectories = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean)
  for (const directory of searchDirectories) {
    for (const extension of windowsExtensions()) {
      const candidate = join(directory, `${name}${extension}`)
      if (await usableExecutable(candidate)) return candidate
    }
  }
  throw new Error(`Could not find ${name} on PATH; pass --runtime-executable with an absolute path`)
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
  const versionOutput = String(result.stdout ?? '').trim()
  const actualVersion = (versionOutput.split(/\r?\n/u)[0] ?? '').replace(/^v/u, '').trim()
  if (actualVersion !== expectedVersion) {
    throw new Error(`Expected pinned ${runtime} ${expectedVersion}, received ${actualVersion || 'an empty version'}`)
  }
}

function withTimeout(promise, timeoutMs, label) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs)
    }),
  ]).finally(() => clearTimeout(timer))
}

class RuntimeHost {
  constructor(child) {
    this.child = child
    this.pending = new Map()
    this.lineBuffer = ''
    this.failure = undefined
    this.bootstrapped = false
    this.bootstrapPromise = new Promise((resolve, reject) => {
      this.resolveBootstrap = resolve
      this.rejectBootstrap = reject
    })
    this.bootstrapPromise.catch(() => {})

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => this.readOutput(chunk))
    child.stdout.on('end', () => {
      if (this.lineBuffer.length > 0) this.fail(new Error('Runtime closed with an incomplete control message'))
    })
    child.stdin.on('error', error => this.fail(new Error(`Could not write to Runtime control channel: ${error.message}`)))
    child.on('error', error => this.fail(new Error(`Could not start Runtime: ${error.message}`)))
    child.on('close', (code, signal) => {
      const description = signal === null ? `exit code ${code}` : `signal ${signal}`
      if (this.failure === undefined && code !== 0) this.failure = new Error(`Runtime exited with ${description}`)
      if (!this.bootstrapped) this.rejectBootstrap(this.failure ?? new Error(`Runtime exited with ${description} before bootstrap`))
      for (const pending of this.pending.values()) pending.reject(this.failure ?? new Error(`Runtime exited with ${description}`))
      this.pending.clear()
    })
  }

  async send(message) {
    if (this.failure !== undefined) throw this.failure
    await new Promise((resolve, reject) => {
      this.child.stdin.write(`${JSON.stringify(message)}\n`, error => {
        if (error !== undefined && error !== null) reject(error)
        else resolve()
      })
    })
  }

  request(command) {
    const id = randomUUID()
    const response = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
    response.catch(() => {})
    return this.send({ type: 'host.request', id, command }).then(() => response)
  }

  readOutput(chunk) {
    this.lineBuffer += chunk
    if (this.lineBuffer.length > MAX_PROTOCOL_LINE_LENGTH && !this.lineBuffer.includes('\n')) {
      this.fail(new Error('Runtime emitted an oversized control message'))
      return
    }
    let newline
    while ((newline = this.lineBuffer.indexOf('\n')) !== -1) {
      const line = this.lineBuffer.slice(0, newline)
      this.lineBuffer = this.lineBuffer.slice(newline + 1)
      if (line.length > MAX_PROTOCOL_LINE_LENGTH) {
        this.fail(new Error('Runtime emitted an oversized control message'))
        return
      }
      this.acceptLine(line)
      if (this.failure !== undefined) return
    }
    if (this.lineBuffer.length > MAX_PROTOCOL_LINE_LENGTH) this.fail(new Error('Runtime emitted an oversized control message'))
  }

  acceptLine(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      this.fail(new Error('Runtime emitted non-JSON output on its private control channel'))
      return
    }
    if (message?.type === 'runtime.event' && message.event === 'bootstrapped') {
      if (message.source !== 'development' || (message.runtime !== 'bun' && message.runtime !== 'node') || this.bootstrapped) {
        this.fail(new Error('Runtime returned an invalid bootstrap event'))
        return
      }
      this.bootstrapped = true
      this.resolveBootstrap(message)
      return
    }
    if (message?.type === 'runtime.event' && message.event === 'startup-failed') {
      const code = typeof message.error?.code === 'string' ? message.error.code : 'startup-failed'
      this.fail(new Error(`Runtime startup failed (${code})`))
      return
    }
    if (message?.type === 'runtime.event' && message.event === 'status') {
      const state = message.status?.state
      if (state === 'failed') {
        const code = message.status?.failure?.code
        process.stderr.write(`Runtime reports DSH startup failure${typeof code === 'string' ? ` (${code})` : ''}.\n`)
      }
      return
    }
    if (message?.type === 'runtime.response' && typeof message.id === 'string') {
      const pending = this.pending.get(message.id)
      if (pending === undefined) {
        this.fail(new Error('Runtime returned a response for an unknown host request'))
        return
      }
      this.pending.delete(message.id)
      pending.resolve(message)
      return
    }
    this.fail(new Error('Runtime returned an unsupported control message'))
  }

  fail(error) {
    this.failure ??= error
    this.rejectBootstrap(this.failure)
    for (const pending of this.pending.values()) pending.reject(this.failure)
    this.pending.clear()
    if (this.child.exitCode === null && this.child.signalCode === null && this.child.pid !== undefined) {
      this.child.kill('SIGTERM')
    }
  }
}

function safeStartedPort(response) {
  if (response?.type !== 'runtime.response' || response.ok !== true || response.result?.kind !== 'started') {
    const code = typeof response?.error?.code === 'string' ? response.error.code : 'start-refused'
    throw new Error(`Runtime could not start DSH (${code})`)
  }
  if (response.result.status?.state !== 'ready') throw new Error('Runtime returned before DSH reached its ready state')

  const connection = response.result.connection
  let origin
  try {
    origin = new URL(connection?.origin)
  } catch {
    throw new Error('Runtime returned an invalid DSH Host origin')
  }
  if (origin.protocol !== 'http:'
    || origin.hostname !== '127.0.0.1'
    || origin.pathname !== '/'
    || origin.search !== ''
    || origin.hash !== ''
    || !Number.isInteger(connection?.port)
    || connection.port < 1
    || connection.port > 65535
    || Number(origin.port) !== connection.port) {
    throw new Error('Runtime returned a DSH Host address outside loopback')
  }
  return connection.port
}

function runtimeEnvironment(home, workspace, runtimeExecutable, developmentKeyMode) {
  const env = { ...process.env }
  for (const name of [
    'DSH_HOME',
    'SUB2API_DSH_HOME',
    'SUB2API_DSH_WORKSPACE_DIRECTORY',
    'SUB2API_DSH_RESOURCE_DIRECTORY',
    'SUB2API_DSH_RUNTIME_EXECUTABLE',
    'CHEAPAI_API_KEY',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'DEEPSEEK_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'OPENROUTER_API_KEY',
    DEVELOPMENT_KEY_MODE_VARIABLE,
  ]) delete env[name]
  env.SUB2API_DSH_HOME = home
  env.SUB2API_DSH_WORKSPACE_DIRECTORY = workspace
  env.SUB2API_DSH_RUNTIME_EXECUTABLE = runtimeExecutable
  if (developmentKeyMode) env[DEVELOPMENT_KEY_MODE_VARIABLE] = '1'
  return env
}

async function stopChild(child, exitPromise) {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return
  child.kill('SIGTERM')
  let timer
  const grace = new Promise(resolve => { timer = setTimeout(resolve, 3_000) })
  await Promise.race([exitPromise, grace])
  clearTimeout(timer)
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  await exitPromise
}

async function runRuntime(options, executable, home, workspace, pinnedVersion) {
  const scriptPath = fileURLToPath(import.meta.url)
  const repositoryRoot = resolve(dirname(scriptPath), '../..')
  const runtimeDirectory = join(repositoryRoot, 'apps', 'desktop-runtime')
  const runtimeEntry = join(runtimeDirectory, 'src', 'index.ts')
  await access(runtimeEntry)

  const runtimeArgs = options.runtime === 'node' ? ['--experimental-transform-types', runtimeEntry] : [runtimeEntry]
  const child = spawn(executable, runtimeArgs, {
    cwd: runtimeDirectory,
    env: runtimeEnvironment(home, workspace, executable, options.developmentKeyMode),
    shell: false,
    windowsHide: true,
    stdio: 'pipe',
  })
  child.stderr.pipe(process.stderr)

  let resolveExit
  const exitPromise = new Promise(resolve => { resolveExit = resolve })
  child.once('close', (code, signal) => resolveExit({ code, signal }))
  const host = new RuntimeHost(child)
  let interruptedWith = 0
  const forwardSignal = signal => {
    interruptedWith = signal === 'SIGINT' ? 130 : 143
    if (child.exitCode === null && child.signalCode === null) child.kill(signal)
  }
  const onSigint = () => forwardSignal('SIGINT')
  const onSigterm = () => forwardSignal('SIGTERM')
  process.once('SIGINT', onSigint)
  process.once('SIGTERM', onSigterm)

  try {
    await host.send({ type: 'host.startup', source: 'development', runtime: options.runtime })
    const bootstrap = await withTimeout(host.bootstrapPromise, BOOTSTRAP_TIMEOUT_MS, 'Runtime bootstrap')
    if (bootstrap.runtime !== options.runtime) throw new Error('Runtime bootstrapped with a different selected runtime')
    process.stdout.write(`Runtime bootstrapped with ${options.runtime} ${pinnedVersion}; no model Key was read or supplied.\n`)

    if (!options.developmentKeyMode) {
      if (host.failure !== undefined) throw host.failure
      process.stdout.write('This fixture has no account session. DSH was not started; the Runtime sidecar exited after bootstrap. Pass --development-key-mode only to run this isolated no-account fixture.\n')
      await stopChild(child, exitPromise)
      return
    }

    const response = await withTimeout(host.request('start'), START_TIMEOUT_MS, 'DSH startup')
    const port = safeStartedPort(response)
    process.stdout.write(`DSH Host is ready on loopback port ${port}. No provider configuration was sent.\n`)
    process.stdout.write('Press Ctrl+C to stop the local Runtime and DSH process.\n')

    const exit = await exitPromise
    if (interruptedWith !== 0) {
      process.exitCode = interruptedWith
      return
    }
    if (host.failure !== undefined) throw host.failure
    throw new Error(`Runtime stopped unexpectedly${exit.signal === null ? ` with code ${exit.code}` : ` after ${exit.signal}`}`)
  } catch (error) {
    await stopChild(child, exitPromise).catch(() => {})
    if (interruptedWith !== 0) {
      process.exitCode = interruptedWith
      return
    }
    throw error
  } finally {
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(`${usage()}\n`)
    return
  }

  const temporaryRoot = await realpath(tmpdir())
  const workspace = await canonicalExistingDirectory(options.workspace, 'workspace', temporaryRoot)
  await validateFixtureWorkspace(workspace)
  const home = await canonicalNewDirectory(options.home, 'DSH home', temporaryRoot)
  if (isWithin(home, workspace) || isWithin(workspace, home)) {
    throw new Error('DSH home and fixture workspace must be separate directories')
  }

  const versionsPath = join(dirname(fileURLToPath(import.meta.url)), 'runtime-versions.json')
  let versionPins
  try {
    versionPins = JSON.parse(await readFile(versionsPath, 'utf8'))
  } catch {
    throw new Error(`Could not read the pinned runtime versions: ${versionsPath}`)
  }
  const pinnedVersion = versionPins?.runtimes?.[options.runtime]?.version
  if (typeof pinnedVersion !== 'string') throw new Error(`No pinned ${options.runtime} version is recorded`)

  const executable = await resolveRuntimeExecutable(options.runtime, options.runtimeExecutable)
  verifyRuntimeVersion(executable, options.runtime, pinnedVersion)
  await mkdir(home, { mode: 0o700 })

  if (options.runtime === 'bun') {
    process.stdout.write(`Using pinned Bun ${pinnedVersion} (DSH compatibility is unverified).\n`)
  } else {
    process.stdout.write(`Using pinned Node ${pinnedVersion} as the comparison baseline.\n`)
  }
  await runRuntime(options, executable, home, workspace, pinnedVersion)
}

main().catch(error => {
  process.stderr.write(`Desktop dev runtime failed: ${error instanceof Error ? error.message : 'unknown startup error'}\n`)
  process.exitCode = 1
})
