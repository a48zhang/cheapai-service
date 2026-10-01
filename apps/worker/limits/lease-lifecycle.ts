import { DEFAULT_CONFIG } from '../config';
import type { DualLeaseCleanupReport, DualLeasePermit } from './dual-lease';
import type { HeldSubjectLease } from './dual-lease';
import type { LeaseHandle } from './client';

export interface LeaseScheduler {
  /** Return a stable, non-undefined handle that cancel() can reclaim. */
  schedule(callback: () => void | Promise<void>, delayMs: number): unknown;
  cancel(handle: unknown): void;
}
export type LeaseLifecycleStopReason = 'closed' | 'cancelled' | 'renewal_failed' | 'lease_unsafe' | 'clock_invalid' | 'clock_regression' | 'scheduler_failed';
export class LeaseLifecycleError extends Error {
  constructor(readonly code: LeaseLifecycleStopReason) {
    super(`Lease lifecycle: ${code}`);
    this.name = 'LeaseLifecycleError';
  }
}
export interface LeaseLifecycleOptions {
  ttlMs?: number;
  renewIntervalMs?: number;
  safetyMarginMs?: number;
  clock?: () => number;
  scheduler?: LeaseScheduler;
  signal?: AbortSignal;
}
export interface LeaseLifecycle {
  readonly signal: AbortSignal;
  close(): Promise<DualLeaseCleanupReport>;
  snapshot(): Readonly<{
    closed: boolean;
    renewing: boolean;
    expiresAt: number;
    reason?: LeaseLifecycleStopReason;
    cleanup?: DualLeaseCleanupReport;
  }>;
}

const defaultScheduler: LeaseScheduler = {
  schedule(callback, delayMs) { return setTimeout(() => { void callback(); }, delayMs); },
  cancel(handle) { clearTimeout(handle as ReturnType<typeof setTimeout>); },
};
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Start only when the caller is actively using the permit. Owns two timers and
 * no global loop. G callers must pass signal to the upstream
 * operation and finally await close(). Workers termination can still interrupt
 * RPC/cleanup: this is not durable background work or an unlimited waitUntil.
 * Invalid options throw before ownership transfers; the caller then releases permit.
 */
export function startLeaseLifecycle(permit: DualLeasePermit, options: LeaseLifecycleOptions = {}): LeaseLifecycle {
  const ttlMs = options.ttlMs ?? DEFAULT_CONFIG.gateLeaseTtlMs;
  const renewIntervalMs = options.renewIntervalMs ?? DEFAULT_CONFIG.gateRenewIntervalMs;
  const safetyMarginMs = options.safetyMarginMs ?? 10_000;
  if ([ttlMs, renewIntervalMs, safetyMarginMs].some((value) => !Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647)
    || renewIntervalMs + safetyMarginMs >= ttlMs) throw new TypeError('Invalid lease lifecycle timing policy');
  const clock = options.clock ?? Date.now;
  const scheduler = options.scheduler ?? defaultScheduler;
  const sourceSignal = options.signal;
  if (typeof clock !== 'function' || typeof scheduler.schedule !== 'function' || typeof scheduler.cancel !== 'function'
    || (sourceSignal !== undefined && !(sourceSignal instanceof AbortSignal))) throw new TypeError('Invalid lease lifecycle controls');
  const controller = new AbortController();
  let user = permit.user.handle;
  let channel = permit.channel.handle;
  let closed = false;
  let renewing = false;
  let reason: LeaseLifecycleStopReason | undefined;
  let lastNow = -1;
  let renewTimer: unknown;
  let safetyTimer: unknown;
  let cleanup: DualLeaseCleanupReport | undefined;
  let closePromise: Promise<DualLeaseCleanupReport> | undefined;
  const expiresAt = () => Math.min(user.expiresAt, channel.expiresAt);

  function cancelTimers(): boolean {
    let cancelled = true;
    for (const handle of [renewTimer, safetyTimer]) {
      if (handle !== undefined) {
        try { scheduler.cancel(handle); } catch { cancelled = false; }
      }
    }
    renewTimer = undefined;
    safetyTimer = undefined;
    return cancelled;
  }

  function releaseOnce(): Promise<DualLeaseCleanupReport> {
    closePromise ??= Promise.resolve().then(() => permit.release()).catch((): DualLeaseCleanupReport => Object.freeze({
      complete: false,
      outcomes: Object.freeze([permit.channel, permit.user].map((held) => Object.freeze({
        subject: held.handle.subject, status: 'uncertain' as const, rpcAttempts: 0, errorCode: 'unavailable' as const,
      }))),
    })).then((report) => { cleanup = report; return report; });
    return closePromise;
  }

  function stop(stopReason: LeaseLifecycleStopReason): void {
    if (closed) return;
    closed = true;
    reason = stopReason;
    cancelTimers();
    sourceSignal?.removeEventListener('abort', onSourceAbort);
    controller.abort(new LeaseLifecycleError(stopReason));
    // Release immediately; an in-flight renewal cannot be cancelled, but L02's
    // matching/non-upsert rule prevents a late renewal from reviving a release.
    void releaseOnce();
  }

  function readClock(): number | undefined {
    let now: number;
    try { now = clock(); } catch { stop('clock_invalid'); return undefined; }
    if (!Number.isSafeInteger(now) || now < 0) { stop('clock_invalid'); return undefined; }
    if (now < lastNow) { stop('clock_regression'); return undefined; }
    lastNow = now;
    return now;
  }

  function onSourceAbort(): void { stop('cancelled'); }

  function checkSafety(): void {
    safetyTimer = undefined;
    if (closed) return;
    const now = readClock();
    if (now === undefined) return;
    const remaining = expiresAt() - safetyMarginMs - now;
    if (remaining <= 0) { stop('lease_unsafe'); return; }
    try { safetyTimer = scheduler.schedule(checkSafety, Math.min(remaining, MAX_TIMER_DELAY_MS)); } catch { stop('scheduler_failed'); }
  }

  function arm(): void {
    if (closed) return;
    if (!cancelTimers()) { stop('scheduler_failed'); return; }
    const now = readClock();
    if (now === undefined) return;
    const safeFor = expiresAt() - safetyMarginMs - now;
    if (safeFor <= 0) { stop('lease_unsafe'); return; }
    try {
      safetyTimer = scheduler.schedule(checkSafety, Math.min(safeFor, MAX_TIMER_DELAY_MS));
      // A permit close to its margin must renew now, not wait a full interval.
      renewTimer = scheduler.schedule(renew, safeFor <= renewIntervalMs ? 0 : renewIntervalMs);
    } catch { stop('scheduler_failed'); }
  }

  async function renewOne(held: HeldSubjectLease, handle: LeaseHandle): Promise<LeaseHandle | undefined> {
    try {
      const result = await held.client.renew(handle, ttlMs);
      if (closed) return undefined;
      if (!result.renewed) { stop('renewal_failed'); return undefined; }
      return result.handle;
    } catch {
      if (!closed) stop('renewal_failed');
      return undefined;
    }
  }

  async function renew(): Promise<void> {
    renewTimer = undefined;
    if (closed || renewing) return;
    const now = readClock();
    if (now === undefined) return;
    if (expiresAt() - now <= safetyMarginMs) { stop('lease_unsafe'); return; }
    renewing = true;
    try {
      const [nextUser, nextChannel] = await Promise.all([renewOne(permit.user, user), renewOne(permit.channel, channel)]);
      if (closed) return;
      if (!nextUser || !nextChannel) { stop('renewal_failed'); return; }
      user = nextUser;
      channel = nextChannel;
      arm();
    } finally {
      renewing = false;
    }
  }

  sourceSignal?.addEventListener('abort', onSourceAbort, { once: true });
  if (sourceSignal?.aborted) stop('cancelled');
  else arm();
  return Object.freeze({
    signal: controller.signal,
    close() { stop('closed'); return releaseOnce(); },
    snapshot() { return Object.freeze({ closed, renewing, expiresAt: expiresAt(), ...(reason === undefined ? {} : { reason }), ...(cleanup === undefined ? {} : { cleanup }) }); },
  });
}
