import type { Env } from '../env';
import { ApiError } from '../http';
import { logError } from '../logging';
import { retryPendingSettlements } from './settlements';
import type { ScheduledSettlementResult } from './settlements';
import { markAbandonedRequests } from './abandoned';
import type { AbandonedScanResult } from './abandoned';
import { cleanupExpiredIdentityData } from './cleanup';
import type { IdentityCleanupResult } from './cleanup';

export type MaintenanceTaskResult<T> = { status: 'completed'; result: T } | { status: 'failed'; code: string } | { status: 'uncertain' };
export interface ScheduledMaintenanceReport {
  processedAt: number;
  elapsedMs: number;
  uncertain: boolean;
  settlements: MaintenanceTaskResult<Omit<ScheduledSettlementResult, 'inFlight'> & { inFlightCount: number }>;
  abandoned: MaintenanceTaskResult<AbandonedScanResult>;
  cleanup: MaintenanceTaskResult<IdentityCleanupResult>;
}
export interface ScheduledMaintenanceOptions {
  now?: () => number;
  budgetMs?: number;
  settlementLimit?: number;
  abandonedLimit?: number;
  cleanupLimit?: number;
}

/** One page per independent task; a failed/slow task never hides other results.
 * Timeouts are uncertain, not proof of cancellation. All work, including late
 * settlement promises, is associated with the same Worker execution context.
 */
export async function runScheduledMaintenance(database: D1Database, context: Pick<ExecutionContext, 'waitUntil'>,
  options: ScheduledMaintenanceOptions = {}): Promise<ScheduledMaintenanceReport> {
  const budget = options.budgetMs ?? 25_000;
  if (!Number.isInteger(budget) || budget < 1 || budget > 30_000) throw new ApiError('invalid_request');
  const now = (): number => {
    const time = options.now ? options.now() : Date.now();
    if (!Number.isSafeInteger(time) || time < 0) throw new ApiError('service_unavailable');
    return time;
  };
  const processedAt = now();
  const start = performance.now();
  const run = async <T>(task: string, operation: () => Promise<T>): Promise<MaintenanceTaskResult<T>> => {
    const work = Promise.resolve().then(operation).then<MaintenanceTaskResult<T>, MaintenanceTaskResult<T>>(
      result => ({ status: 'completed', result }),
      error => {
        logError('Scheduled maintenance task failed', error, { task });
        return { status: 'failed', code: error instanceof ApiError ? error.code : 'service_unavailable' };
      });
    context.waitUntil(work.then(() => undefined));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<MaintenanceTaskResult<T>>(resolve => {
      timer = setTimeout(() => resolve({ status: 'uncertain' }), Math.max(0, budget - (performance.now() - start)));
    });
    const result = await Promise.race([work, timeout]);
    if (result.status === 'uncertain') console.warn('Scheduled maintenance task timed out', { task, budget_ms: budget });
    if (timer !== undefined) clearTimeout(timer);
    return result;
  };
  const [settlements, abandoned, cleanup] = await Promise.all([
    run('settlements', async () => {
      const value = await retryPendingSettlements(database, now(), { limit: options.settlementLimit ?? 20, budgetMs: budget });
      const { inFlight, ...counts } = value;
      for (const promise of inFlight) context.waitUntil(promise.then(() => undefined, error => logError('Scheduled background settlement failed', error)));
      return { ...counts, inFlightCount: inFlight.length };
    }),
    run('abandoned', () => markAbandonedRequests(database, now(), { limit: options.abandonedLimit ?? 20 })),
    run('cleanup', () => cleanupExpiredIdentityData(database, now(), { limit: options.cleanupLimit ?? 50 })),
  ]);
  return { processedAt, elapsedMs: Math.max(0, performance.now() - start), settlements, abandoned, cleanup,
    uncertain: [settlements, abandoned, cleanup].some(result => result.status === 'uncertain')
      || (settlements.status === 'completed' && settlements.result.inFlightCount > 0) };
}

/** scheduledTime may be old after delayed delivery; actual processing time wins. */
export async function handleScheduled(_controller: ScheduledController, env: Env, context: ExecutionContext): Promise<void> {
  try {
    const report = await runScheduledMaintenance(env.DB, context);
    console.info('scheduled_maintenance', report);
  } catch (error) {
    logError('Scheduled maintenance failed', error, { cron: _controller.cron });
    throw error;
  }
}
