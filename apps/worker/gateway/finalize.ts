import type { UsageSnapshot, UsageQuality } from '@sub2api/apicompat/types/shared';
import { canonicalJson } from '../billing/fingerprint';
import { settleRequest } from '../billing/settlement';
import type { SettlementOptions } from '../billing/settlement';
import { saveSettlementRecovery } from '../billing/recovery';
import { ApiError } from '../http';
import type { DualLeaseCleanupReport } from '../limits/dual-lease';
import type { RequestRecord } from './request-repository';
import type { JsonExecutionResult } from './execute-json';

export interface FinalizationReport {
  readonly requestId: string;
  readonly usageQuality: UsageQuality;
  readonly billingStatus: string;
  readonly accounting: 'settled' | 'recovered' | 'unavailable' | 'already_finalized';
  readonly cleanup: DualLeaseCleanupReport | null;
  readonly uncertain: boolean;
  readonly errors: readonly string[];
  readonly inFlight: readonly Promise<void>[];
}
export interface FinalizerDependencies {
  readonly database: D1Database;
  readonly request: RequestRecord;
  readonly now?: () => number;
  /** G14 passes executionCtx.waitUntil, and also attaches execution.completion. */
  readonly waitUntil?: (work: Promise<unknown>) => void;
  /** Omit for executeStream: that executor owns cleanup after its onComplete hook. */
  readonly cleanup?: () => Promise<DualLeaseCleanupReport>;
  readonly budgetMs?: number;
  readonly cleanupTimeoutMs?: number;
  readonly settlement?: SettlementOptions;
}
export interface FinalizationInput { readonly requestId: string; readonly usage: UsageSnapshot }
export interface RequestFinalizer {
  finalize(input: FinalizationInput, signal?: AbortSignal): Promise<FinalizationReport>;
  onComplete(input: FinalizationInput, signal: AbortSignal): Promise<void>;
  readonly completion: Promise<FinalizationReport> | null;
}

/** G07 already owns accounting and cleanup. Adapt its result without running either again. */
export function finalizationFromJson(result: Pick<JsonExecutionResult<unknown>, 'requestId' | 'usage' | 'billingStatus' | 'cleanup'>): FinalizationReport {
  return { requestId: result.requestId, usageQuality: result.usage.quality, billingStatus: result.billingStatus,
    accounting: 'already_finalized', cleanup: result.cleanup, uncertain: !result.cleanup.complete, errors: [], inFlight: [] };
}

/** One local lifecycle, first terminal usage wins. Separate instances remain protected by B04/D13. */
export function createRequestFinalizer(dependencies: FinalizerDependencies): RequestFinalizer {
  const budget = dependencies.budgetMs ?? 5500;
  const cleanupBudget = dependencies.cleanupTimeoutMs ?? 1000;
  if (!Number.isInteger(budget) || budget < 1 || budget > 10_000 || !Number.isInteger(cleanupBudget) || cleanupBudget < 1 || cleanupBudget > 5000) throw new ApiError('invalid_request');
  const request = Object.freeze({ ...dependencies.request });
  let completion: Promise<FinalizationReport> | null = null;
  const finalize = (input: FinalizationInput, signal?: AbortSignal): Promise<FinalizationReport> => {
    if (input.requestId !== request.id) return Promise.reject(new ApiError('conflict'));
    if (completion) return completion;
    let usage: UsageSnapshot;
    try {
      usage = JSON.parse(canonicalJson(input.usage)) as UsageSnapshot;
      if (!usage || usage.protocol !== request.upstream_protocol || !['complete', 'partial', 'missing', 'invalid'].includes(usage.quality)) throw new Error();
    } catch {
      usage = { quality: 'invalid', protocol: request.upstream_protocol, counts: {}, sources: [], issues: ['invalid_final_usage'],
        semantics: { cacheRead: 'unknown', cacheWrite: 'unknown', reasoning: 'unknown', cacheWriteTtl: 'unknown' } };
    }
    completion = Promise.resolve().then(async () => {
      const deadline = performance.now() + budget;
      const errors: string[] = [];
      const inFlight: Promise<void>[] = [];
      let cleanup: DualLeaseCleanupReport | null = null;
      let billingStatus = request.billing_status;
      let accounting: FinalizationReport['accounting'] = 'unavailable';
      const track = (work: Promise<unknown>) => {
        const observed = work.then(() => undefined, () => undefined);
        inFlight.push(observed); dependencies.waitUntil?.(observed);
      };
      const now = () => {
        const value = dependencies.now ? dependencies.now() : Date.now();
        if (!Number.isSafeInteger(value) || value < 0) throw new ApiError('service_unavailable');
        return value;
      };
      const remaining = () => Math.max(0, Math.floor(deadline - performance.now()));
      const bounded = async <T>(operation: () => Promise<T>, ms: number, abort?: AbortSignal): Promise<T | undefined> => {
        if (ms <= 0 || abort?.aborted) { errors.push('finalization_timeout'); return undefined; }
        const work = Promise.resolve().then(operation);
        let timer: ReturnType<typeof setTimeout> | undefined;
        let onAbort: (() => void) | undefined;
        const timedOut = Symbol('timeout');
        const stopped = new Promise<typeof timedOut>(resolve => {
          timer = setTimeout(() => resolve(timedOut), ms);
          onAbort = () => resolve(timedOut); abort?.addEventListener('abort', onAbort, { once: true });
        });
        try {
          const result = await Promise.race([work, stopped]);
          if (result === timedOut) { track(work); errors.push('finalization_timeout'); return undefined; }
          return result;
        } finally {
          if (timer !== undefined) clearTimeout(timer);
          if (onAbort) abort?.removeEventListener('abort', onAbort);
        }
      };
      try {
        let recover = true;
        if (usage.quality === 'complete') {
          try {
            const outcome = await bounded(() => settleRequest(dependencies.database, request, usage,
              { ...dependencies.settlement, now, budgetMs: Math.max(1, Math.min(dependencies.settlement?.budgetMs ?? 6000, remaining() - 1000)) }), remaining(), signal);
            if (outcome?.status === 'settled') { billingStatus = 'settled'; accounting = 'settled'; recover = false; }
            else if (outcome?.status === 'pending' && outcome.inFlight) track(outcome.inFlight);
          } catch (error) {
            if (error instanceof ApiError && error.code === 'conflict') { errors.push('conflict'); recover = false; }
            else errors.push(error instanceof ApiError ? error.code : 'service_unavailable');
          }
        }
        if (recover) {
          const recovery = await bounded(() => saveSettlementRecovery(dependencies.database, { requestId: request.id, userId: request.user_id, usage }, now()), remaining(), signal);
          if (recovery) { billingStatus = recovery.billingStatus; accounting = billingStatus === 'settled' ? 'settled' : 'recovered'; }
        }
      } catch (error) { errors.push(error instanceof ApiError ? error.code : 'service_unavailable'); }
      finally {
        if (dependencies.cleanup) {
          try { cleanup = await bounded(dependencies.cleanup, cleanupBudget) ?? { complete: false, outcomes: [] }; }
          catch { cleanup = { complete: false, outcomes: [] }; errors.push('cleanup_failed'); }
        }
      }
      return { requestId: request.id, usageQuality: usage.quality, billingStatus, accounting, cleanup,
        uncertain: accounting === 'unavailable' || inFlight.length > 0 || cleanup?.complete === false, errors, inFlight };
    });
    return completion;
  };
  return { finalize, get completion() { return completion; }, async onComplete(input, signal) {
    const result = await finalize(input, signal);
    if (result.accounting === 'unavailable') throw new ApiError('service_unavailable');
  } };
}
