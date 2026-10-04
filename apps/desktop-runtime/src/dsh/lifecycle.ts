import { StringDecoder } from 'node:string_decoder'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  connectDshHost,
  DshConnectionProbeError,
  parseDshWebReadyLine,
  type DshConnectionInfo,
  type DshFetch,
} from './connection-info.ts'
import type { LaunchedDshProcess } from './launcher.ts'

export type DshLifecycleState = 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed'
export type DshLifecycleStage =
  | 'launch'
  | 'host-announcement'
  | 'browser-authentication'
  | 'host-api-handshake'
  | 'shutdown'
  | 'process-exit'

export interface DshLifecycleFailure {
  readonly code: 'launch-failed' | 'startup-failed' | 'startup-timeout' | 'process-failed' | 'exited-before-ready'
  readonly stage: DshLifecycleStage
  readonly message: string
  readonly exitCode?: number | null
  readonly signal?: NodeJS.Signals | null
}

export interface DshLifecycleSnapshot {
  readonly state: DshLifecycleState
  readonly generation: number
  readonly stage?: DshLifecycleStage
  readonly failure?: DshLifecycleFailure
}

export interface DshLifecycleOptions {
  /** Launch one configured DSH child through the pinned runtime executable. */
  readonly launch: () => LaunchedDshProcess
  readonly startupTimeoutMs?: number
  readonly shutdownGraceMs?: number
  readonly fetch?: DshFetch
  readonly onState?: (snapshot: DshLifecycleSnapshot) => void
}

export class DshLifecycleError extends Error {
  constructor(
    readonly code: DshLifecycleFailure['code'] | 'already-running' | 'stopped',
    readonly stage: DshLifecycleStage,
    message: string,
  ) {
    super(message)
    this.name = 'DshLifecycleError'
  }
}

interface ActiveRun {
  readonly generation: number
  readonly child: ChildProcessWithoutNullStreams
  readonly abortController: AbortController
  readonly decoder: StringDecoder
  readonly readyPromise: Promise<DshConnectionInfo>
  readonly resolveReady: (connection: DshConnectionInfo) => void
  readonly rejectReady: (error: Error) => void
  readonly exitPromise: Promise<void>
  readonly resolveExit: () => void
  stage: DshLifecycleStage
  lineBuffer: string
  readySettled: boolean
  probing: boolean
  exited: boolean
  stopping: boolean
  startupTimer?: ReturnType<typeof setTimeout>
  terminationTimer?: ReturnType<typeof setTimeout>
  stopPromise?: Promise<void>
  connection?: DshConnectionInfo
  failure?: DshLifecycleFailure
}

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000
const DEFAULT_SHUTDOWN_GRACE_MS = 3_000
const MAX_STDOUT_LINE_CHARS = 8_192

/** Owns one DSH child at a time and reports ready only after the Host RPC answers. */
export class DshLifecycle {
  private readonly startupTimeoutMs: number
  private readonly shutdownGraceMs: number
  private readonly fetcher?: DshFetch
  private readonly onState?: DshLifecycleOptions['onState']
  private generation = 0
  private active?: ActiveRun
  private current: DshLifecycleSnapshot = Object.freeze({ state: 'stopped', generation: 0 })

  constructor(private readonly options: DshLifecycleOptions) {
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS
    this.shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS
    this.fetcher = options.fetch
    this.onState = options.onState
    if (!Number.isFinite(this.startupTimeoutMs) || this.startupTimeoutMs <= 0) {
      throw new Error('DSH startup timeout must be a positive finite number')
    }
    if (!Number.isFinite(this.shutdownGraceMs) || this.shutdownGraceMs < 0) {
      throw new Error('DSH shutdown grace period must be a non-negative finite number')
    }
  }

  get status(): DshLifecycleSnapshot {
    return this.current
  }

  /** The cookie-bearing connection stays private to the Runtime transport owner. */
  get connectionInfo(): DshConnectionInfo | undefined {
    return this.active?.connection
  }

  start(): Promise<DshConnectionInfo> {
    const existing = this.active
    if (existing !== undefined && !existing.exited) {
      if (this.current.state === 'ready' && existing.connection !== undefined) {
        return Promise.resolve(existing.connection)
      }
      if (this.current.state === 'starting') return existing.readyPromise
      return Promise.reject(new DshLifecycleError(
        'already-running',
        this.current.stage ?? 'process-exit',
        'DSH must be stopped or restarted before another launch',
      ))
    }

    const generation = ++this.generation
    this.publish({ state: 'starting', generation, stage: 'launch' })

    let launched: LaunchedDshProcess
    try {
      launched = this.options.launch()
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'DSH launcher failed'
      const failure: DshLifecycleFailure = {
        code: 'launch-failed',
        stage: 'launch',
        message,
      }
      this.publish({ state: 'failed', generation, stage: 'launch', failure })
      return Promise.reject(new DshLifecycleError(failure.code, failure.stage, failure.message))
    }

    let resolveReady!: (connection: DshConnectionInfo) => void
    let rejectReady!: (error: Error) => void
    const readyPromise = new Promise<DshConnectionInfo>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    let resolveExit!: () => void
    const exitPromise = new Promise<void>(resolve => { resolveExit = resolve })
    const run: ActiveRun = {
      generation,
      child: launched.child,
      abortController: new AbortController(),
      decoder: new StringDecoder('utf8'),
      readyPromise,
      resolveReady,
      rejectReady,
      exitPromise,
      resolveExit,
      stage: 'host-announcement',
      lineBuffer: '',
      readySettled: false,
      probing: false,
      exited: false,
      stopping: false,
    }
    this.active = run
    this.publish({ state: 'starting', generation, stage: run.stage })

    run.child.stdout.on('data', chunk => this.readStdout(run, chunk))
    run.child.stdout.once('end', () => this.flushStdout(run))
    // Drain DSH diagnostics even when the native host does not forward logs.
    run.child.stderr.on('data', () => {})
    run.child.once('error', error => this.handleChildError(run, error))
    run.child.once('close', (code, signal) => this.handleExit(run, code, signal))
    run.startupTimer = setTimeout(() => {
      this.failStartup(run, new DshLifecycleError(
        'startup-timeout',
        run.stage,
        `DSH did not complete its Host handshake within ${this.startupTimeoutMs} ms`,
      ))
    }, this.startupTimeoutMs)

    return readyPromise
  }

  async restart(): Promise<DshConnectionInfo> {
    await this.stop()
    return this.start()
  }

  stop(): Promise<void> {
    const run = this.active
    if (run === undefined || run.exited) return Promise.resolve()
    if (run.stopPromise !== undefined) return run.stopPromise
    run.stopPromise = this.stopRun(run)
    return run.stopPromise
  }

  private async stopRun(run: ActiveRun): Promise<void> {
    run.stopping = true
    this.clearStartupTimer(run)
    this.clearTerminationTimer(run)
    run.abortController.abort()
    if (!run.readySettled) {
      run.readySettled = true
      run.rejectReady(new DshLifecycleError('stopped', 'shutdown', 'DSH startup was stopped'))
    }
    this.publish({ state: 'stopping', generation: run.generation, stage: 'shutdown' })
    this.signal(run, 'SIGTERM')

    let graceTimer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      run.exitPromise,
      new Promise<void>(resolve => {
        graceTimer = setTimeout(resolve, this.shutdownGraceMs)
      }),
    ])
    if (graceTimer !== undefined) clearTimeout(graceTimer)
    if (!run.exited) {
      this.signal(run, 'SIGKILL')
      let killTimer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        run.exitPromise,
        new Promise<void>(resolve => {
          killTimer = setTimeout(resolve, this.shutdownGraceMs)
        }),
      ])
      if (killTimer !== undefined) clearTimeout(killTimer)
      if (!run.exited) {
        const failure: DshLifecycleFailure = {
          code: 'process-failed',
          stage: 'shutdown',
          message: 'DSH did not exit after SIGKILL',
        }
        run.failure = failure
        this.publish({ state: 'failed', generation: run.generation, stage: 'shutdown', failure })
        throw new DshLifecycleError('process-failed', 'shutdown', failure.message)
      }
    }
  }

  private readStdout(run: ActiveRun, chunk: Buffer | string): void {
    if (run.exited || run.probing || run.readySettled) return
    run.lineBuffer += run.decoder.write(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    let newline = run.lineBuffer.indexOf('\n')
    while (newline >= 0) {
      const line = run.lineBuffer.slice(0, newline).replace(/\r$/u, '')
      run.lineBuffer = run.lineBuffer.slice(newline + 1)
      this.readLine(run, line)
      if (run.probing || run.readySettled || run.exited) return
      newline = run.lineBuffer.indexOf('\n')
    }
    if (run.lineBuffer.length > MAX_STDOUT_LINE_CHARS) run.lineBuffer = ''
  }

  private flushStdout(run: ActiveRun): void {
    if (run.probing || run.readySettled || run.exited) return
    run.lineBuffer += run.decoder.end()
    if (run.lineBuffer.length > 0) this.readLine(run, run.lineBuffer.replace(/\r$/u, ''))
    run.lineBuffer = ''
  }

  private readLine(run: ActiveRun, line: string): void {
    let announced: ReturnType<typeof parseDshWebReadyLine>
    try {
      announced = parseDshWebReadyLine(line)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Invalid DSH Web URL announcement'
      this.failStartup(run, new DshLifecycleError('startup-failed', 'host-announcement', message))
      return
    }
    if (announced === undefined) return

    run.probing = true
    run.stage = 'browser-authentication'
    this.publish({ state: 'starting', generation: run.generation, stage: run.stage })
    void connectDshHost(announced, {
      signal: run.abortController.signal,
      ...(this.fetcher === undefined ? {} : { fetch: this.fetcher }),
      onStage: stage => {
        if (run.exited || run.stopping || run.readySettled) return
        run.stage = stage
        this.publish({ state: 'starting', generation: run.generation, stage })
      },
    }).then(connection => {
      if (run.exited || run.stopping || run.readySettled || run.abortController.signal.aborted) return
      run.connection = connection
      run.readySettled = true
      this.clearStartupTimer(run)
      this.publish({ state: 'ready', generation: run.generation })
      run.resolveReady(connection)
    }).catch(cause => {
      const stage = cause instanceof DshConnectionProbeError
        ? lifecycleStageForProbe(cause.stage)
        : run.stage
      const message = cause instanceof Error ? cause.message : 'DSH Host handshake failed'
      this.failStartup(run, new DshLifecycleError('startup-failed', stage, message))
    })
  }

  private handleChildError(run: ActiveRun, error: Error): void {
    if (run.exited || run.stopping) return
    const stage = !run.readySettled && run.child.pid === undefined ? 'launch' : run.readySettled ? 'process-exit' : run.stage
    const message = error.message || 'DSH child process failed'
    if (!run.readySettled) {
      this.failStartup(run, new DshLifecycleError('process-failed', stage, message))
      return
    }
    run.failure = { code: 'process-failed', stage, message }
    run.abortController.abort()
    this.publish({ state: 'failed', generation: run.generation, stage, failure: run.failure })
    this.requestTermination(run)
  }

  private handleExit(run: ActiveRun, code: number | null, signal: NodeJS.Signals | null): void {
    if (run.exited) return
    run.exited = true
    this.clearStartupTimer(run)
    this.clearTerminationTimer(run)
    run.abortController.abort()

    if (!run.readySettled) {
      const failure: DshLifecycleFailure = {
        code: 'exited-before-ready',
        stage: run.stage,
        message: `DSH exited before the Host handshake completed (code ${String(code)}, signal ${String(signal)})`,
        exitCode: code,
        signal,
      }
      run.failure ??= failure
      run.readySettled = true
      run.rejectReady(new DshLifecycleError(failure.code, failure.stage, failure.message))
    } else if (!run.stopping && run.failure === undefined && run.connection !== undefined && code !== 0) {
      run.failure = {
        code: 'process-failed',
        stage: 'process-exit',
        message: `DSH exited after becoming ready (code ${String(code)}, signal ${String(signal)})`,
        exitCode: code,
        signal,
      }
    }

    if (this.active === run) this.active = undefined
    run.resolveExit()
    if (run.stopping || (run.connection !== undefined && code === 0 && run.failure === undefined)) {
      this.publish({ state: 'stopped', generation: run.generation })
    } else if (run.failure !== undefined) {
      this.publish({ state: 'failed', generation: run.generation, stage: run.failure.stage, failure: run.failure })
    } else {
      this.publish({ state: 'stopped', generation: run.generation })
    }
  }

  private failStartup(run: ActiveRun, error: DshLifecycleError): void {
    if (run.exited || run.readySettled || run.stopping) return
    run.readySettled = true
    run.failure = {
      code: error.code === 'startup-timeout'
        ? 'startup-timeout'
        : error.code === 'process-failed'
          ? 'process-failed'
          : 'startup-failed',
      stage: error.stage,
      message: error.message,
    }
    this.clearStartupTimer(run)
    run.abortController.abort()
    this.publish({ state: 'failed', generation: run.generation, stage: error.stage, failure: run.failure })
    run.rejectReady(error)
    this.requestTermination(run)
  }

  private requestTermination(run: ActiveRun): void {
    this.signal(run, 'SIGTERM')
    run.terminationTimer = setTimeout(() => this.signal(run, 'SIGKILL'), this.shutdownGraceMs)
  }

  private signal(run: ActiveRun, signal: NodeJS.Signals): void {
    if (run.exited) return
    try {
      run.child.kill(signal)
    } catch {
      // The close event remains the single authority for process cleanup.
    }
  }

  private clearStartupTimer(run: ActiveRun): void {
    if (run.startupTimer !== undefined) {
      clearTimeout(run.startupTimer)
      run.startupTimer = undefined
    }
  }

  private clearTerminationTimer(run: ActiveRun): void {
    if (run.terminationTimer !== undefined) {
      clearTimeout(run.terminationTimer)
      run.terminationTimer = undefined
    }
  }

  private publish(snapshot: DshLifecycleSnapshot): void {
    this.current = Object.freeze({
      ...snapshot,
      ...(snapshot.failure === undefined ? {} : { failure: Object.freeze({ ...snapshot.failure }) }),
    })
    try {
      this.onState?.(this.current)
    } catch {
      // A status observer must not interrupt process cleanup or readiness.
    }
  }
}

function lifecycleStageForProbe(stage: DshConnectionProbeError['stage']): DshLifecycleStage {
  switch (stage) {
    case 'announcement': return 'host-announcement'
    case 'browser-authentication': return 'browser-authentication'
    case 'host-api-handshake': return 'host-api-handshake'
  }
}
