import { randomInt } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { DshFetch } from '../../../apps/desktop-runtime/src/dsh/connection-info.ts'
import type { LaunchedDshProcess } from '../../../apps/desktop-runtime/src/dsh/launcher.ts'
import type { ResolvedDshPaths } from '../../../apps/desktop-runtime/src/dsh/paths.ts'

const PROCESS_TOKEN = 'A'.repeat(43)

/** Fake DSH process and Host endpoints contained under a disposable test root. */
export class FakeDshHost {
  readonly processes: FakeDshChild[] = []
  readonly homeDirectory: string
  readonly workspaceDirectory: string
  readonly fetch: DshFetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname === '/') return dshAuthenticationResponse()
    return successfulDshHostApiResponse(init)
  }

  private readonly launchWaiters: Array<{ count: number; resolve: (child: FakeDshChild) => void }> = []

  private constructor(readonly rootDirectory: string) {
    this.homeDirectory = join(rootDirectory, 'dsh-home')
    this.workspaceDirectory = join(rootDirectory, 'workspace')
  }

  static async create(): Promise<FakeDshHost> {
    const rootDirectory = await mkdtemp(join(tmpdir(), 'sub2api-runtime-lifecycle-'))
    const host = new FakeDshHost(rootDirectory)
    await Promise.all([
      mkdir(host.homeDirectory, { recursive: true }),
      mkdir(host.workspaceDirectory, { recursive: true }),
    ])
    return host
  }

  launch(): LaunchedDshProcess {
    const child = new FakeDshChild(randomInt(49_152, 65_536), process => {
      // A process that receives a termination signal exits on the next turn,
      // matching the asynchronous close ordering of a real child process.
      void Promise.resolve().then(() => process.exit(null, process.lastSignal ?? 'SIGTERM'))
    })
    this.processes.push(child)
    for (const waiter of [...this.launchWaiters]) {
      if (this.processes.length >= waiter.count) {
        this.launchWaiters.splice(this.launchWaiters.indexOf(waiter), 1)
        waiter.resolve(child)
      }
    }

    const runtimeRoot = join(this.rootDirectory, 'fake-runtime')
    const paths: ResolvedDshPaths = {
      mode: 'development',
      runtime: 'node',
      runtimeRoot,
      runtimeExecutable: join(runtimeRoot, 'bin', 'node'),
      packageRoot: join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh'),
      cliEntry: join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      profilePatch: join(runtimeRoot, 'profiles', 'cheapai.yml'),
      home: this.homeDirectory,
      profileDirectory: join(this.homeDirectory, 'profiles', 'cheapai'),
      profileManifest: join(this.homeDirectory, 'profiles', 'cheapai', 'package.json'),
    }
    return { child: child as unknown as ChildProcessWithoutNullStreams, paths }
  }

  waitForLaunch(count: number): Promise<FakeDshChild> {
    const existing = this.processes[count - 1]
    if (existing !== undefined) return Promise.resolve(existing)
    return new Promise(resolve => this.launchWaiters.push({ count, resolve }))
  }

  async dispose(): Promise<void> {
    for (const child of this.processes) {
      if (!child.closed) child.exit(0, null)
    }
    await Promise.all(this.processes.map(child => child.waitForClose()))
    for (const child of this.processes) child.releaseTestListeners()
    await rm(this.rootDirectory, { recursive: true, force: true })
  }
}

export class FakeDshChild extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly pid = randomInt(10_000, 2_000_000)
  readonly killSignals: NodeJS.Signals[] = []
  readonly port: number
  readonly closedPromise: Promise<void>

  closed = false
  lastSignal: NodeJS.Signals | undefined
  private resolveClosed!: () => void

  constructor(port: number, private readonly onKill: (child: FakeDshChild) => void) {
    super()
    this.port = port
    this.closedPromise = new Promise(resolve => { this.resolveClosed = resolve })
  }

  kill(signal?: NodeJS.Signals): boolean {
    if (this.closed) return false
    if (signal !== undefined) {
      this.lastSignal = signal
      this.killSignals.push(signal)
    }
    this.onKill(this)
    return true
  }

  announceReady(): void {
    this.stdout.write(`dsh web: http://127.0.0.1:${this.port}/?token=${PROCESS_TOKEN}\n`)
  }

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closed) return
    this.closed = true
    this.stdout.end()
    this.stderr.end()
    this.stdin.destroy()
    void Promise.resolve().then(() => {
      this.emit('close', code, signal)
      this.resolveClosed()
    })
  }

  waitForClose(): Promise<void> {
    return this.closedPromise
  }

  releaseTestListeners(): void {
    this.removeAllListeners()
    this.stdin.removeAllListeners()
    this.stdout.removeAllListeners()
    this.stderr.removeAllListeners()
  }
}

export function dshAuthenticationResponse(): Response {
  return new Response(null, {
    status: 303,
    headers: {
      location: './',
      'set-cookie': 'dsh-auth-test=temporary-cookie; Path=/; HttpOnly',
    },
  })
}

export function successfulDshHostApiResponse(init?: RequestInit): Response {
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { rpcId?: unknown } : {}
  return Response.json({
    type: 'server-response',
    rpcId: body.rpcId,
    result: { ok: true, value: { namespaces: [] } },
  })
}
