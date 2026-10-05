import { LeaseClient, LeaseClientError } from './client';
import type { LeaseAcquireInput, LeaseAcquireOutcome, LeaseBinding, LeaseClientErrorCode, LeaseHandle, LeaseSubject } from './client';

export const DUAL_LEASE_CLEANUP_ATTEMPTS = 2;
export interface DualLeaseInput {
  /** Trusted authenticated user ID. API Key IDs must never be used as this subject. */
  userId: string;
  channelId: string;
  /** One server-generated lease/D1 ID per candidate; do not run competing lifecycles for it. */
  requestId: string;
  user: Omit<LeaseAcquireInput, 'requestId'>;
  channel: Omit<LeaseAcquireInput, 'requestId'>;
}
export interface HeldSubjectLease { readonly client: LeaseClient; readonly handle: LeaseHandle }
export interface LeaseCleanupOutcome {
  readonly subject: LeaseSubject;
  readonly status: 'released' | 'absent' | 'superseded' | 'uncertain';
  readonly rpcAttempts: number;
  readonly errorCode?: LeaseClientErrorCode;
}
export interface DualLeaseCleanupReport {
  readonly complete: boolean;
  readonly outcomes: readonly LeaseCleanupOutcome[];
}
export interface DualLeasePermit {
  readonly user: HeldSubjectLease;
  readonly channel: HeldSubjectLease;
  /** Coalesces concurrent calls; subsequent calls may retry previously uncertain cleanup. */
  release(): Promise<DualLeaseCleanupReport>;
}
export type DualLeaseAcquireResult =
  | { granted: true; lease: DualLeasePermit }
  | {
    granted: false;
    stage: 'user' | 'channel';
    reason: 'denied' | 'cancelled' | 'acquire_error' | 'expired';
    denial?: Extract<LeaseAcquireOutcome, { granted: false }>;
    errorCode?: LeaseClientErrorCode;
    cleanup: DualLeaseCleanupReport;
    retryCleanup(): Promise<DualLeaseCleanupReport>;
  };

interface CleanupTarget {
  client: LeaseClient;
  input: LeaseAcquireInput;
  recoveryDeadline: number;
  handle?: LeaseHandle;
  confirmed?: LeaseCleanupOutcome;
  rpcAttempts: number;
}

function snapshot(requestId: string, limits: DualLeaseInput['user']): LeaseAcquireInput {
  return Object.freeze({ requestId, limit: limits.limit, ttlMs: limits.ttlMs,
    ...(limits.rate === undefined ? {} : { rate: Object.freeze({ ...limits.rate, operationId: limits.rate.operationId ?? requestId }) }),
  });
}

function errorCode(error: unknown): LeaseClientErrorCode {
  return error instanceof LeaseClientError ? error.code : 'unavailable';
}

async function cleanTarget(target: CleanupTarget): Promise<LeaseCleanupOutcome> {
  if (target.confirmed) return target.confirmed;
  let failure: LeaseClientErrorCode = 'unavailable';
  for (let attempt = 0; attempt < DUAL_LEASE_CLEANUP_ATTEMPTS; attempt++) {
    try {
      if (!target.handle) {
        // Recover an ambiguous acquisition using its original request ID. Never
        // start fresh recovery after the original local TTL budget has elapsed.
        if (Date.now() >= target.recoveryDeadline) break;
        target.rpcAttempts++;
        const recovered = await target.client.acquire(target.input);
        if (!recovered.granted) break; // A denial is not proof a delayed RPC cannot still commit.
        target.handle = recovered.handle;
      }
      target.rpcAttempts++;
      const released = await target.client.release(target.handle);
      target.confirmed = Object.freeze({
        subject: target.client.subject,
        status: released.released ? 'released' : released.reason === 'missing' ? 'absent' : 'superseded',
        rpcAttempts: target.rpcAttempts,
      });
      return target.confirmed;
    } catch (error) {
      failure = errorCode(error);
      if (!(error instanceof LeaseClientError) || !error.retryable) break;
    }
  }
  return Object.freeze({ subject: target.client.subject, status: 'uncertain', rpcAttempts: target.rpcAttempts, errorCode: failure });
}

function cleanupController(targets: CleanupTarget[]): () => Promise<DualLeaseCleanupReport> {
  let pending: Promise<DualLeaseCleanupReport> | undefined;
  let completed: DualLeaseCleanupReport | undefined;
  return () => {
    if (completed) return Promise.resolve(completed);
    if (pending) return pending;
    pending = (async () => {
      try {
        // Reverse acquisition order; failure on one subject cannot skip the other.
        const outcomes = await Promise.all([...targets].reverse().map(cleanTarget));
        const report = Object.freeze({ complete: outcomes.every((outcome) => outcome.status !== 'uncertain'), outcomes: Object.freeze(outcomes) });
        if (report.complete) completed = report;
        return report;
      } finally {
        pending = undefined;
      }
    })();
    return pending;
  };
}

/**
 * Obtain user then channel admission. No upstream work is authorized on a failed
 * result. Await an in-flight RPC before compensating cancellation: racing/abandoning
 * it could lose a late lease. RPC object disposal is owned by LeaseClient.
 * Network partitions can make cleanup unconfirmable; report that explicitly and
 * retain retryCleanup. Finite DO TTL is the final fallback, not a release guarantee.
 */
export async function acquireDualLease(
  binding: LeaseBinding,
  input: DualLeaseInput,
  options: { signal?: AbortSignal } = {},
): Promise<DualLeaseAcquireResult> {
  const signal = options.signal;
  const userInput = snapshot(input.requestId, input.user);
  const channelInput = snapshot(input.requestId, input.channel);
  const userClient = new LeaseClient(binding, { kind: 'user', id: input.userId });
  const channelClient = new LeaseClient(binding, { kind: 'channel', id: input.channelId });
  const targets: CleanupTarget[] = [];
  const cleanup = cleanupController(targets);
  const fail = async (details: Omit<Extract<DualLeaseAcquireResult, { granted: false }>, 'granted' | 'cleanup' | 'retryCleanup'>): Promise<DualLeaseAcquireResult> => ({
    granted: false, ...details, cleanup: await cleanup(), retryCleanup: cleanup,
  });
  let user: HeldSubjectLease | undefined;
  let channel: HeldSubjectLease | undefined;
  for (const [stage, client, args] of [
    ['user', userClient, userInput], ['channel', channelClient, channelInput],
  ] as const) {
    if (signal?.aborted) return fail({ stage, reason: 'cancelled' });
    const target: CleanupTarget = { client, input: args, recoveryDeadline: Date.now() + args.ttlMs, rpcAttempts: 0 };
    let result: LeaseAcquireOutcome;
    try {
      result = await client.acquire(args);
    } catch (error) {
      targets.push(target);
      return fail({ stage, reason: signal?.aborted ? 'cancelled' : 'acquire_error', errorCode: errorCode(error) });
    }
    if (!result.granted) return fail({ stage, reason: signal?.aborted ? 'cancelled' : 'denied', denial: result });
    target.handle = result.handle;
    targets.push(target);
    const held = Object.freeze({ client, handle: result.handle });
    if (stage === 'user') user = held;
    else channel = held;
  }
  if (signal?.aborted) return fail({ stage: 'channel', reason: 'cancelled' });
  if (!user || !channel) throw new Error('Incomplete internal dual lease acquisition');
  if (Math.min(user.handle.expiresAt, channel.handle.expiresAt) <= Date.now()) return fail({ stage: 'channel', reason: 'expired' });
  const release = () => {
    signal?.removeEventListener('abort', onAbort);
    return cleanup();
  };
  const onAbort = () => { void release(); };
  signal?.addEventListener('abort', onAbort, { once: true });
  return { granted: true, lease: Object.freeze({ user, channel, release }) };
}
