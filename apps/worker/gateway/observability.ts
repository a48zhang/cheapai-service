import type { UsageSnapshot, TerminalState } from '@sub2api/apicompat/types/shared';
import type { FinalizationReport } from './finalize';
import type { RequestRecord } from './request-repository';
import { parseUnits } from '../billing/money';

export type RequestStage = 'received' | 'admitted' | 'upstream_started' | 'first_byte' | 'stream_terminal' | 'settlement' | 'completed';
export interface ObservationDetails {
  terminal?: TerminalState;
  usage?: UsageSnapshot;
  finalization?: Pick<FinalizationReport, 'requestId' | 'usageQuality' | 'billingStatus' | 'accounting' | 'uncertain' | 'errors'>;
  costUnits?: string;
  balanceUnits?: string;
  upstreamRequestId?: string;
  upstreamStatus?: number;
}
export interface RequestObservation {
  readonly schema_version: 1;
  readonly request_id: string;
  readonly stage: RequestStage;
  readonly observed_at: number;
  readonly elapsed_ms: number;
  readonly stage_elapsed_ms: number;
  readonly public_model_id?: string;
  readonly channel_id?: string;
  readonly downstream_protocol?: string;
  readonly upstream_protocol?: string;
  readonly terminal_status?: string;
  readonly usage_quality?: string;
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly total_tokens?: number;
  readonly billing_status?: string;
  readonly accounting?: string;
  readonly cost_units?: string;
  readonly balance_units?: string;
  readonly upstream_request_id?: string;
  readonly upstream_status?: number;
  readonly anomalies: readonly string[];
}
export interface RequestObserver {
  mark(stage: Exclude<RequestStage, 'received' | 'completed'>, details?: ObservationDetails): boolean;
  finish(details?: ObservationDetails): boolean;
}
export type ObservationSink = (record: RequestObservation) => void | Promise<void>;
type Identity = Pick<RequestRecord, 'id' | 'public_model_id' | 'channel_id' | 'downstream_protocol' | 'upstream_protocol'>;

// Read only own data fields. Accessors/toJSON, provider objects and arbitrary
// exception strings never execute or get copied into a telemetry record.
function field(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') return undefined;
  try { const descriptor = Object.getOwnPropertyDescriptor(value, key); return descriptor && 'value' in descriptor ? descriptor.value : undefined; }
  catch { return undefined; }
}
function choice(value: unknown, allowed: readonly string[]): string | undefined {
  return typeof value === 'string' && allowed.includes(value) ? value : undefined;
}
function identifier(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(value)
    && !/(?:s2a_(?:key|session|invite)_|sk-|bearer|-----BEGIN)/i.test(value) ? value : undefined;
}
function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
const stages: readonly RequestStage[] = ['received', 'admitted', 'upstream_started', 'first_byte', 'stream_terminal', 'settlement', 'completed'];
const qualities = ['complete', 'partial', 'missing', 'invalid'];
const billing = ['awaiting_usage', 'settled', 'not_chargeable', 'settlement_pending', 'usage_unknown'];

/** One bounded observer per internal request UUID. Stages emit at most once,
 * terminal emission is final, and sink/clock failures never affect execution.
 * This is telemetry only: no writes to balances, request state, caches or leases.
 */
export function createRequestObserver(identity: Identity, options: { sink?: ObservationSink; now?: () => number } = {}): RequestObserver {
  const sink = options.sink ?? (record => console.info(JSON.stringify(record)));
  const clock = options.now ?? Date.now;
  const requestId = field(identity, 'id');
  const validId = typeof requestId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId);
  const model = identifier(field(identity, 'public_model_id'));
  const channel = identifier(field(identity, 'channel_id'));
  const downstream = choice(field(identity, 'downstream_protocol'), ['chat', 'responses', 'messages']);
  const upstream = choice(field(identity, 'upstream_protocol'), ['chat', 'responses', 'messages']);
  const seen = new Set<RequestStage>();
  let startedAt: number | undefined;
  let lastAt: number | undefined;
  let finished = false;
  const emit = (stage: RequestStage, details: ObservationDetails = {}): boolean => {
    if (!validId || finished || seen.has(stage) || !stages.includes(stage)) return false;
    let now: number;
    try { now = clock(); } catch { return false; }
    if (!Number.isSafeInteger(now) || now < 0 || (lastAt !== undefined && now < lastAt)) return false;
    startedAt ??= now;
    const anomalies = new Set<string>();
    const terminal = choice(field(field(details, 'terminal'), 'status'), ['completed', 'incomplete', 'failed', 'cancelled']);
    const usage = field(details, 'usage');
    const finalization = field(details, 'finalization');
    const reportMatches = field(finalization, 'requestId') === requestId;
    if (finalization !== undefined && !reportMatches) anomalies.add('finalization_request_mismatch');
    let quality = choice(field(usage, 'quality'), qualities) ?? (reportMatches ? choice(field(finalization, 'usageQuality'), qualities) : undefined);
    const usageMatches = usage !== undefined && field(usage, 'protocol') === upstream;
    if (usage !== undefined && !usageMatches) { quality = 'invalid'; anomalies.add('usage_protocol_mismatch'); }
    const counts = usageMatches ? field(usage, 'counts') : undefined;
    const input = count(field(counts, 'inputTokens')); const output = count(field(counts, 'outputTokens')); const total = count(field(counts, 'totalTokens'));
    const billingStatus = reportMatches ? choice(field(finalization, 'billingStatus'), billing) : undefined;
    const accounting = reportMatches ? choice(field(finalization, 'accounting'), ['settled', 'recovered', 'unavailable', 'already_finalized']) : undefined;
    if (quality !== undefined && quality !== 'complete') anomalies.add('usage_unreliable');
    if (terminal === 'failed') anomalies.add('execution_failed');
    if (billingStatus === 'settlement_pending') anomalies.add('settlement_pending');
    if (billingStatus === 'usage_unknown') anomalies.add('usage_unknown');
    if (accounting === 'unavailable' || (reportMatches && field(finalization, 'uncertain') === true)) anomalies.add('accounting_uncertain');
    if (billingStatus === 'settled' && quality !== undefined && quality !== 'complete') anomalies.add('settled_without_complete_usage');
    let cost: string | undefined; let balance: string | undefined;
    const rawCost = field(details, 'costUnits'); const rawBalance = field(details, 'balanceUnits');
    if (rawCost !== undefined) { try { if (parseUnits(rawCost) < 0n) throw new Error(); cost = rawCost as string; } catch { anomalies.add('invalid_cost'); } }
    if (rawBalance !== undefined) { try { if (parseUnits(rawBalance) < 0n) anomalies.add('negative_balance'); balance = rawBalance as string; } catch { anomalies.add('invalid_balance'); } }
    const upstreamId = identifier(field(details, 'upstreamRequestId'));
    const upstreamStatus = count(field(details, 'upstreamStatus'));
    const record: RequestObservation = Object.freeze({ schema_version: 1, request_id: requestId as string, stage, observed_at: now,
      elapsed_ms: now - startedAt, stage_elapsed_ms: now - (lastAt ?? now),
      ...(model === undefined ? {} : { public_model_id: model }), ...(channel === undefined ? {} : { channel_id: channel }),
      ...(downstream === undefined ? {} : { downstream_protocol: downstream }), ...(upstream === undefined ? {} : { upstream_protocol: upstream }),
      ...(terminal === undefined ? {} : { terminal_status: terminal }), ...(quality === undefined ? {} : { usage_quality: quality }),
      ...(input === undefined ? {} : { input_tokens: input }), ...(output === undefined ? {} : { output_tokens: output }), ...(total === undefined ? {} : { total_tokens: total }),
      ...(billingStatus === undefined ? {} : { billing_status: billingStatus }), ...(accounting === undefined ? {} : { accounting }),
      ...(cost === undefined ? {} : { cost_units: cost }), ...(balance === undefined ? {} : { balance_units: balance }),
      ...(upstreamId === undefined ? {} : { upstream_request_id: upstreamId }),
      ...(upstreamStatus === undefined || upstreamStatus < 100 || upstreamStatus > 599 ? {} : { upstream_status: upstreamStatus }),
      anomalies: Object.freeze([...anomalies]),
    });
    seen.add(stage); lastAt = now; if (stage === 'completed') finished = true;
    try {
      // Best-effort delivery only. Rejected async sinks must not become an
      // unhandled rejection or make logging part of the billing transaction.
      void Promise.resolve(sink(record)).catch(() => undefined);
      return true;
    } catch { return false; }
  };
  emit('received');
  return { mark: (stage, details) => emit(stage, details), finish: details => emit('completed', details) };
}
