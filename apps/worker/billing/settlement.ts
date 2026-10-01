import type { UsageSnapshot } from '@sub2api/apicompat/types/shared';
import { ApiError } from '../http';
import { getRequest } from '../gateway/request-repository';
import type { RequestRecord } from '../gateway/request-repository';
import { canonicalJson, readPriceSnapshot } from './fingerprint';
import { calculatePrice } from './pricing';
import { findConsumptionSettlement, prepareConsumptionSettlement, settleConsumption } from './settlement-repository';
import type { ConsumptionEntry, ConsumptionSettlementInput, PreparedConsumptionSettlement } from './settlement-repository';

export const SETTLEMENT_MAX_ATTEMPTS = 3;
export const SETTLEMENT_RETRY_BUDGET_MS = 6000;
export interface SettlementOptions {
  readonly now?: () => number;
  /** Monotonic milliseconds; separate from ledger timestamps. */
  readonly elapsedNow?: () => number;
  /** Optional stricter limits, never larger than the hard maxima. */
  readonly maxAttempts?: number;
  readonly budgetMs?: number;
  readonly retryDelayMs?: number;
}
export type SettlementOutcome =
  | { readonly status: 'settled'; readonly entry: ConsumptionEntry; readonly attempts: number }
  | {
      readonly status: 'pending'; readonly evidence: PreparedConsumptionSettlement; readonly attempts: number;
      readonly reason: 'budget_exhausted' | 'attempts_exhausted';
      /** Attach to waitUntil if present; D1 cannot be cancelled. Never resend concurrently. */
      readonly inFlight: Promise<void> | null;
    };
type Attempt<T> = { kind: 'ok'; value: T } | { kind: 'error'; error: unknown } | { kind: 'timeout' };
const retryable = (error: unknown): boolean => !(error instanceof ApiError) || error.code === 'service_unavailable';

/**
 * B11 supplies the registered request, so recovery evidence survives a D1 outage.
 * Re-read its owner-scoped identity before submission, retain its original price
 * JSON, and derive one consumption operation ID. This service never generates,
 * reroutes, registers or finishes a model request. B14 owns pending persistence.
 */
export async function settleRequest(database: D1Database, request: RequestRecord, usage: UsageSnapshot, options: SettlementOptions = {}): Promise<SettlementOutcome> {
  const maximum = options.maxAttempts ?? SETTLEMENT_MAX_ATTEMPTS;
  const budget = options.budgetMs ?? SETTLEMENT_RETRY_BUDGET_MS;
  const delay = options.retryDelayMs ?? 100;
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > SETTLEMENT_MAX_ATTEMPTS
    || !Number.isInteger(budget) || budget < 1 || budget > SETTLEMENT_RETRY_BUDGET_MS
    || !Number.isInteger(delay) || delay < 0 || delay > 1000) throw new ApiError('invalid_request');
  const elapsed = options.elapsedNow ?? (() => performance.now());
  let last = elapsed();
  if (!Number.isFinite(last) || last < 0) throw new ApiError('service_unavailable');
  const deadline = last + budget;
  const remaining = (): number => {
    const current = elapsed();
    if (!Number.isFinite(current) || current < last) return 0; // Clock regression never renews the budget.
    last = current;
    return Math.max(0, deadline - current);
  };
  const wallTime = (): number => {
    const time = options.now ? options.now() : Date.now();
    if (!Number.isSafeInteger(time) || time < 0) throw new ApiError('service_unavailable');
    return time;
  };
  let input: ConsumptionSettlementInput;
  try {
    const price = readPriceSnapshot(request.price_snapshot);
    if (price.snapshot.public_model_id !== request.public_model_id || price.snapshot.upstream_model !== request.upstream_model
      || price.snapshot.upstream_protocol !== request.upstream_protocol) throw new Error();
    // Capture mutable caller objects once before any awaited storage operation.
    const evidence = JSON.parse(canonicalJson(usage)) as UsageSnapshot;
    const cost = calculatePrice(evidence, price.snapshot.sell_prices, price.snapshot.billing_multiplier ?? '1').costUnits;
    input = Object.freeze({ operationId: `consume:${request.id}`, userId: request.user_id, requestId: request.id,
      priceSnapshotJson: price.json, usage: evidence, costUnits: cost.toString() });
  } catch { throw new ApiError('invalid_request'); }
  const evidence = await prepareConsumptionSettlement(input);
  let attempts = 0;
  let inFlight: Promise<void> | null = null;
  const pending = (reason: 'budget_exhausted' | 'attempts_exhausted'): SettlementOutcome => ({ status: 'pending', evidence, attempts, reason, inFlight });
  const bounded = async <T>(operation: () => Promise<T>): Promise<Attempt<T>> => {
    const left = remaining();
    if (left <= 0) return { kind: 'timeout' };
    const work: Promise<Attempt<T>> = Promise.resolve().then(operation).then(value => ({ kind: 'ok', value }), error => ({ kind: 'error', error }));
    inFlight = work.then(() => undefined); // Observe both outcomes even after timeout.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<Attempt<T>>(resolve => { timer = setTimeout(() => resolve({ kind: 'timeout' }), left); });
    const result = await Promise.race([work, timeout]);
    if (timer !== undefined) clearTimeout(timer);
    if (result.kind !== 'timeout') inFlight = null;
    return result;
  };
  const settled = (entry: ConsumptionEntry): SettlementOutcome => ({ status: 'settled', entry, attempts });

  for (let round = 0; round < maximum; round++) {
    if (round > 0 && delay > 0) {
      const waited = await bounded(() => new Promise<void>(resolve => setTimeout(resolve, delay)));
      if (waited.kind === 'timeout') return pending('budget_exhausted');
    }
    // A failed read cannot establish absence; never follow it with a write.
    const known = await bounded(() => findConsumptionSettlement(database, input));
    if (known.kind === 'timeout') return pending('budget_exhausted');
    if (known.kind === 'error') { if (!retryable(known.error)) throw known.error; continue; }
    if (known.value) return settled(known.value);
    const registered = await bounded(() => getRequest(database, input.requestId, input.userId));
    if (registered.kind === 'timeout') return pending('budget_exhausted');
    if (registered.kind === 'error') { if (!retryable(registered.error)) throw registered.error; continue; }
    if (!registered.value || registered.value.price_snapshot !== input.priceSnapshotJson
      || registered.value.public_model_id !== evidence.publicModelId || registered.value.upstream_model !== evidence.upstreamModel
      || registered.value.upstream_protocol !== evidence.upstreamProtocol) throw new ApiError('conflict');
    if (registered.value.billing_status === 'settled') {
      // Another caller may commit between the ledger read and request read.
      const raced = await bounded(() => findConsumptionSettlement(database, input));
      if (raced.kind === 'timeout') return pending('budget_exhausted');
      if (raced.kind === 'error') { if (!retryable(raced.error)) throw raced.error; continue; }
      if (raced.value) return settled(raced.value);
      throw new ApiError('conflict');
    }
    const result = await bounded(() => { const now = wallTime(); attempts++; return settleConsumption(database, input, now); });
    if (result.kind === 'timeout') return pending('budget_exhausted');
    if (result.kind === 'ok') return settled(result.value.entry);
    if (!retryable(result.error)) throw result.error;
  }
  // No fourth submission, but a final read may confirm the last uncertain write.
  const final = await bounded(() => findConsumptionSettlement(database, input));
  if (final.kind === 'timeout') return pending('budget_exhausted');
  if (final.kind === 'ok' && final.value) return settled(final.value);
  if (final.kind === 'error' && !retryable(final.error)) throw final.error;
  return pending('attempts_exhausted');
}
