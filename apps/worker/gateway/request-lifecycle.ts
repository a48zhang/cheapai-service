import { DEFAULT_CONFIG } from '../config';
import type { DualLeaseCleanupReport, DualLeasePermit } from '../limits/dual-lease';
import { startLeaseLifecycle } from '../limits/lease-lifecycle';
import type { LeaseLifecycle } from '../limits/lease-lifecycle';

export type RequestStopReason = 'cancelled' | 'request_timeout' | 'lease_lost' | 'failed';
export type BoundedResult<T> = { ok: true; value: T } | { ok: false };

/** Local resource owner only. Protocol parsing, D1 claim and accounting remain
 * with the executor. A losing CAS must close with release=false. */
export function createRequestLifecycle(permit: DualLeasePermit, options: {
  signal?: AbortSignal;
  clock?: () => number;
  maxDurationMs?: number;
  completionTimeoutMs?: number;
  onStop?: (reason: RequestStopReason) => void;
} = {}) {
  const controller = new AbortController();
  const completionMs = options.completionTimeoutMs ?? DEFAULT_CONFIG.settlementRetryBudgetMs;
  const durationMs = options.maxDurationMs ?? DEFAULT_CONFIG.requestMaxDurationMs;
  let lease: LeaseLifecycle | undefined;
  let reason: RequestStopReason | undefined;
  let finalizing = false;
  let closed = false;
  let totalTimer: ReturnType<typeof setTimeout> | undefined;
  let finalTimer: ReturnType<typeof setTimeout> | undefined;
  let upstreamCancel: (() => void) | undefined;
  let closing: Promise<DualLeaseCleanupReport> | undefined;
  const cleanups = new Set<() => void>();
  let rejectInterrupted!: (error: Error) => void;
  const interrupted = new Promise<never>((_resolve, reject) => { rejectInterrupted = reject; });
  void interrupted.catch(() => undefined);

  const uncertain = (): DualLeaseCleanupReport => ({ complete: false,
    outcomes: [permit.channel, permit.user].map(held => ({ subject: held.handle.subject,
      status: 'uncertain', rpcAttempts: 0, errorCode: 'unavailable' })) });
  function cancelUpstream(): void {
    const cancel = upstreamCancel;
    upstreamCancel = undefined;
    try { cancel?.(); } catch { /* A transport hook cannot prevent release. */ }
  }
  function detach(): void {
    if (totalTimer !== undefined) clearTimeout(totalTimer);
    totalTimer = undefined;
    options.signal?.removeEventListener('abort', sourceAbort);
  }
  function stop(value: RequestStopReason): void {
    if (closed || reason !== undefined) return;
    reason = value;
    detach();
    controller.abort();
    cancelUpstream();
    rejectInterrupted(new Error(`Request lifecycle interrupted: ${value}`));
    if (!finalizing) {
      try { options.onStop?.(value); } catch { /* Owner cleanup is independent. */ }
    }
  }
  function sourceAbort(): void { if (!finalizing) stop('cancelled'); }
  function leaseAbort(): void {
    if (!closed && !controller.signal.aborted) stop('lease_lost');
  }
  async function bounded<T>(task: () => Promise<T>, onTimeout?: () => void): Promise<BoundedResult<T>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(task).then(value => ({ ok: true as const, value }), () => ({ ok: false as const })),
        new Promise<{ ok: false }>(resolve => {
          timer = setTimeout(() => {
            try { onTimeout?.(); } catch { /* Still resolve the deadline. */ }
            resolve({ ok: false });
          }, Number.isSafeInteger(completionMs) && completionMs > 0 && completionMs <= 60_000
            ? completionMs : DEFAULT_CONFIG.settlementRetryBudgetMs);
        }),
      ]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }
  return {
    signal: controller.signal,
    interrupted,
    get reason() { return reason; },
    bounded,
    async persist<T>(task: () => Promise<T>): Promise<T> {
      let rejected = false;
      let rejection: unknown;
      const result = await bounded(async () => {
        try { return await task(); } catch (error) { rejected = true; rejection = error; throw error; }
      }, () => stop('request_timeout'));
      if (!result.ok) {
        if (rejected) throw rejection;
        throw new Error('Request persistence timed out.');
      }
      return result.value;
    },
    active<T>(work: Promise<T>): Promise<T> { return Promise.race([work, interrupted]); },
    start(): void {
      if (lease || closed) return;
      if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > 2_147_483_647
        || !Number.isSafeInteger(completionMs) || completionMs <= 0 || completionMs > 60_000) throw new Error('Invalid request deadlines');
      options.signal?.addEventListener('abort', sourceAbort, { once: true });
      if (options.signal?.aborted) sourceAbort();
      if (controller.signal.aborted) throw new Error('Request already cancelled');
      totalTimer = setTimeout(() => stop('request_timeout'), durationMs);
      const ttlMs = Math.min(permit.user.handle.expiresAt - permit.user.handle.acquiredAt,
        permit.channel.handle.expiresAt - permit.channel.handle.acquiredAt);
      const renewIntervalMs = Math.max(1, Math.min(DEFAULT_CONFIG.gateRenewIntervalMs, Math.floor(ttlMs / 3)));
      const safetyMarginMs = Math.max(1, Math.min(10_000, Math.floor(ttlMs / 6)));
      lease = startLeaseLifecycle(permit, { ttlMs, renewIntervalMs, safetyMarginMs,
        ...(options.clock === undefined ? {} : { clock: options.clock }), signal: controller.signal });
      lease.signal.addEventListener('abort', leaseAbort, { once: true });
      if (lease.signal.aborted) leaseAbort();
      if (controller.signal.aborted) throw new Error('Request lease unavailable');
    },
    attachUpstream(cancel: () => void): void {
      upstreamCancel = cancel;
      if (controller.signal.aborted || finalizing || closed) cancelUpstream();
    },
    addCleanup(cleanup: () => void): void { cleanups.add(cleanup); },
    beginFinalization(normal: boolean): void {
      if (finalizing || closed) return;
      finalizing = true;
      detach();
      cancelUpstream();
      if (!normal) stop('failed');
      // At most three persistence/hook regions plus one cleanup region.
      // Even a caller that forgets its bounded await cannot renew indefinitely.
      finalTimer = setTimeout(() => stop('request_timeout'), 4 * (Number.isSafeInteger(completionMs) && completionMs > 0 && completionMs <= 60_000
        ? completionMs : DEFAULT_CONFIG.settlementRetryBudgetMs));
    },
    stop,
    close(release = true): Promise<DualLeaseCleanupReport> {
      if (closing) return closing;
      closed = true;
      detach();
      if (finalTimer !== undefined) clearTimeout(finalTimer);
      finalTimer = undefined;
      lease?.signal.removeEventListener('abort', leaseAbort);
      cancelUpstream();
      for (const cleanup of cleanups) { try { cleanup(); } catch { /* Continue all cleanup. */ } }
      cleanups.clear();
      // Do not abort a not-owned permit after a failed start CAS.
      closing = release ? bounded(() => lease ? lease.close() : permit.release()).then(result => result.ok ? result.value : uncertain())
        : Promise.resolve({ complete: true, outcomes: [] });
      controller.abort();
      return closing;
    },
  };
}
