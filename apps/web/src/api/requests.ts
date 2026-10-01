import { createApiClient, readCsrfCookie } from './client.js';
import { authApi } from './auth.js';

export type Protocol = 'chat' | 'responses' | 'messages';
export type RequestSource = 'api' | 'web_chat';
export type ExecutionStatus = 'admitted' | 'succeeded' | 'failed' | 'cancelled' | 'abandoned';
export type BillingStatus = 'awaiting_usage' | 'settled' | 'not_chargeable' | 'settlement_pending' | 'usage_unknown';
export type UsageQuality = 'complete' | 'partial' | 'missing' | 'invalid';

export interface TokenCounts {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly cacheWrite5mTokens?: number;
  readonly cacheWrite1hTokens?: number;
  readonly reasoningTokens?: number;
}

export interface UsageSemantics {
  readonly cacheRead: 'included_in_input' | 'excluded_from_input' | 'unknown';
  readonly cacheWrite: 'included_in_input' | 'excluded_from_input' | 'unknown';
  readonly reasoning: 'included_in_output' | 'excluded_from_output' | 'unknown';
  readonly cacheWriteTtl: 'subsets_of_cache_write' | 'unknown';
}

/** Public query output is intentionally smaller than the internal UsageSnapshot.
 * It contains no provider raw objects, prompt content, or source history. */
export interface PublicUsage {
  readonly protocol: Protocol;
  readonly quality: UsageQuality;
  readonly counts?: TokenCounts;
  readonly semantics?: UsageSemantics;
}

export interface PriceSnapshot {
  readonly schema_version: 1;
  readonly canonical_json_version: 1;
  readonly calculation_version: 1;
  readonly currency: 'USD';
  readonly decimals: 8;
  readonly tokens_per_price_unit: 1_000_000;
  readonly rounding: 'half_up_after_sum';
  readonly public_model_id: string;
  readonly upstream_model: string;
  readonly upstream_protocol: Protocol;
  readonly price_version: number;
  readonly sell_prices: Readonly<Record<string, string>>;
  /** Optional group facts are absent from legacy request snapshots. */
  readonly group_id?: string;
  readonly group_version?: number;
  readonly billing_multiplier?: string;
}

export interface RequestError {
  readonly code: string;
  readonly message: string;
}

export interface RequestRecord {
  readonly id: string;
  readonly user_id: string;
  readonly api_key_id: string;
  /** Trusted source classification supplied by the gateway; never inferred from the key label. */
  readonly source: RequestSource;
  readonly group_id: string | null;
  readonly channel_id: string;
  readonly public_model_id: string;
  readonly upstream_model: string;
  readonly downstream_protocol: Protocol;
  readonly upstream_protocol: Protocol;
  readonly execution_status: ExecutionStatus;
  readonly billing_status: BillingStatus;
  readonly created_at: number;
  readonly started_at: number | null;
  readonly finished_at: number | null;
  readonly updated_at: number;
  readonly usage: PublicUsage | null;
  readonly usage_valid: boolean | null;
  readonly price_snapshot: PriceSnapshot | null;
  readonly price_snapshot_valid: boolean;
  readonly cost_units: string | null;
  readonly error: RequestError | null;
  readonly retry_count: number;
  readonly next_retry_at: number | null;
}

export interface RequestQuery {
  readonly cursor?: string | null;
  readonly from?: number;
  readonly to?: number;
  readonly status?: ExecutionStatus;
  readonly billingStatus?: BillingStatus;
  readonly model?: string;
  readonly userId?: string;
}

export interface RequestPage {
  readonly items: readonly RequestRecord[];
  readonly snapshotAt: number;
  readonly nextCursor: string | null;
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max = 256): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value;
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const amount = (value: unknown): value is string => typeof value === 'string' && value.length <= 128 && /^(?:0|-?[1-9][0-9]*)$/u.test(value);
const protocol = (value: unknown): value is Protocol => value === 'chat' || value === 'responses' || value === 'messages';
const source = (value: unknown): value is RequestSource => value === 'api' || value === 'web_chat';
const billingMultiplier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 64
  && value.trim() === value && /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/u.test(value);
const execution = (value: unknown): value is ExecutionStatus => value === 'admitted' || value === 'succeeded' || value === 'failed' || value === 'cancelled' || value === 'abandoned';
const billing = (value: unknown): value is BillingStatus => value === 'awaiting_usage' || value === 'settled' || value === 'not_chargeable'
  || value === 'settlement_pending' || value === 'usage_unknown';

function invalid(): never { throw new TypeError('Invalid request response.'); }

function decodeCounts(value: unknown): TokenCounts {
  if (!object(value)) invalid();
  const allowed = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'cacheWrite5mTokens', 'cacheWrite1hTokens', 'reasoningTokens'];
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid();
  for (const key of allowed) if (Object.hasOwn(value, key) && !count(value[key])) invalid();
  return Object.fromEntries(allowed.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]])) as TokenCounts;
}

function decodeSemantics(value: unknown): UsageSemantics {
  if (!object(value) || Object.keys(value).length !== 4
    || !['included_in_input', 'excluded_from_input', 'unknown'].includes(String(value.cacheRead))
    || !['included_in_input', 'excluded_from_input', 'unknown'].includes(String(value.cacheWrite))
    || !['included_in_output', 'excluded_from_output', 'unknown'].includes(String(value.reasoning))
    || !['subsets_of_cache_write', 'unknown'].includes(String(value.cacheWriteTtl))) invalid();
  return { cacheRead: value.cacheRead as UsageSemantics['cacheRead'], cacheWrite: value.cacheWrite as UsageSemantics['cacheWrite'],
    reasoning: value.reasoning as UsageSemantics['reasoning'], cacheWriteTtl: value.cacheWriteTtl as UsageSemantics['cacheWriteTtl'] };
}

function decodeUsage(value: unknown): PublicUsage | null {
  if (value === null) return null;
  if (!object(value) || !protocol(value.protocol) || !['complete', 'partial', 'missing', 'invalid'].includes(String(value.quality))) invalid();
  const quality = value.quality as UsageQuality;
  if (quality === 'missing') {
    if (Object.keys(value).length !== 2) invalid();
    return { protocol: value.protocol, quality };
  }
  if (!Object.hasOwn(value, 'counts') || !Object.hasOwn(value, 'semantics') || Object.keys(value).some(key => !['protocol', 'quality', 'counts', 'semantics'].includes(key))) invalid();
  return { protocol: value.protocol, quality, counts: decodeCounts(value.counts), semantics: decodeSemantics(value.semantics) };
}

function decodePrices(value: unknown): Readonly<Record<string, string>> {
  if (!object(value) || !Object.hasOwn(value, 'input') || !Object.hasOwn(value, 'output')) invalid();
  const allowed = ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite5m', 'cacheWrite1h', 'reasoning'];
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid();
  for (const key of Object.keys(value)) if (!text(value[key], 18) || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,8})?$/u.test(value[key])) invalid();
  return Object.freeze(Object.fromEntries(Object.keys(value).map(key => [key, value[key]])) as Record<string, string>);
}

function decodePriceSnapshot(value: unknown): PriceSnapshot | null {
  if (value === null) return null;
  if (!object(value) || value.schema_version !== 1 || value.canonical_json_version !== 1 || value.calculation_version !== 1
    || value.currency !== 'USD' || value.decimals !== 8 || value.tokens_per_price_unit !== 1_000_000 || value.rounding !== 'half_up_after_sum'
    || !text(value.public_model_id) || !text(value.upstream_model) || !protocol(value.upstream_protocol) || !count(value.price_version) || value.price_version < 1
    || !Object.hasOwn(value, 'sell_prices')) invalid();
  const allowed = ['schema_version', 'canonical_json_version', 'calculation_version', 'currency', 'decimals', 'tokens_per_price_unit', 'rounding',
    'public_model_id', 'upstream_model', 'upstream_protocol', 'price_version', 'sell_prices', 'group_id', 'group_version', 'billing_multiplier'];
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid();
  const groupId = value.group_id === undefined ? undefined : value.group_id;
  const groupVersion = value.group_version === undefined ? undefined : value.group_version;
  const multiplier = value.billing_multiplier === undefined ? undefined : value.billing_multiplier;
  if ((groupId !== undefined && !text(groupId, 256)) || (groupVersion !== undefined && (!count(groupVersion) || groupVersion < 1))
    || (multiplier !== undefined && !billingMultiplier(multiplier))) invalid();
  return { schema_version: 1, canonical_json_version: 1, calculation_version: 1, currency: 'USD', decimals: 8,
    tokens_per_price_unit: 1_000_000, rounding: 'half_up_after_sum', public_model_id: value.public_model_id,
    upstream_model: value.upstream_model, upstream_protocol: value.upstream_protocol, price_version: value.price_version,
    sell_prices: decodePrices(value.sell_prices), ...(groupId === undefined ? {} : { group_id: groupId }),
    ...(groupVersion === undefined ? {} : { group_version: groupVersion }), ...(multiplier === undefined ? {} : { billing_multiplier: multiplier }) };
}

function decodeError(value: unknown): RequestError | null {
  if (value === null) return null;
  if (!object(value) || !text(value.code, 128) || !text(value.message, 512) || Object.keys(value).some(key => !['code', 'message'].includes(key))) invalid();
  return { code: value.code, message: value.message };
}

export function decodeRequest(value: unknown): RequestRecord {
  if (!object(value) || !text(value.id) || !text(value.user_id) || !text(value.api_key_id) || !text(value.channel_id)
    || !text(value.public_model_id) || !text(value.upstream_model) || !protocol(value.downstream_protocol) || !protocol(value.upstream_protocol)
    || !execution(value.execution_status) || !billing(value.billing_status) || !count(value.created_at) || !(value.started_at === null || count(value.started_at))
    || !(value.finished_at === null || count(value.finished_at)) || !count(value.updated_at) || value.updated_at < value.created_at
    || !Object.hasOwn(value, 'usage') || !Object.hasOwn(value, 'usage_valid') || (value.usage_valid !== null && typeof value.usage_valid !== 'boolean')
    || !Object.hasOwn(value, 'price_snapshot') || typeof value.price_snapshot_valid !== 'boolean' || !(value.cost_units === null || (amount(value.cost_units) && !value.cost_units.startsWith('-')))
    || !Object.hasOwn(value, 'error') || !(value.next_retry_at === null || count(value.next_retry_at)) || !count(value.retry_count)) invalid();
  const usage = decodeUsage(value.usage);
  const price = decodePriceSnapshot(value.price_snapshot);
  const error = decodeError(value.error);
  // Responses from before 0023 do not carry source/group fields. They are
  // known API records, while their historical group remains unknown.
  const requestSource = value.source === undefined ? 'api' : value.source;
  const groupId = value.group_id === undefined ? null : value.group_id;
  if (!source(requestSource) || !(groupId === null || text(groupId, 128))) invalid();
  if (value.usage_valid === true && usage === null) invalid();
  if (value.price_snapshot_valid !== (price !== null)) invalid();
  return { id: value.id, user_id: value.user_id, api_key_id: value.api_key_id, source: requestSource, group_id: groupId, channel_id: value.channel_id,
    public_model_id: value.public_model_id, upstream_model: value.upstream_model, downstream_protocol: value.downstream_protocol,
    upstream_protocol: value.upstream_protocol, execution_status: value.execution_status, billing_status: value.billing_status,
    created_at: value.created_at, started_at: value.started_at, finished_at: value.finished_at, updated_at: value.updated_at,
    usage, usage_valid: value.usage_valid, price_snapshot: price, price_snapshot_valid: value.price_snapshot_valid,
    cost_units: value.cost_units, error, retry_count: value.retry_count, next_retry_at: value.next_retry_at };
}

export function decodeRequestPage(value: unknown): RequestPage {
  if (!object(value) || !Array.isArray(value.items) || !count(value.snapshotAt) || !(value.nextCursor === null || text(value.nextCursor, 2048))) invalid();
  return { items: value.items.map(decodeRequest), snapshotAt: value.snapshotAt, nextCursor: value.nextCursor };
}

const client = createApiClient({ getCsrfToken: async () => readCsrfCookie() ?? (await authApi.bootstrap()).csrfToken });
const path = (id: string, admin: boolean) => `${admin ? '/api/v1/admin/requests' : '/api/v1/usage/requests'}/${encodeURIComponent(id)}`;

export function createRequestsApi(api = client, admin = false) {
  const collection = admin ? '/api/v1/admin/requests' : '/api/v1/usage/requests';
  return Object.freeze({
    async list(options: RequestQuery = {}): Promise<RequestPage> {
      return (await api.get(collection, { query: { ...options, limit: 20 }, decode: decodeRequestPage })).data;
    },
    async get(id: string): Promise<RequestRecord> {
      return (await api.get(path(id, admin), { decode: decodeRequest })).data;
    },
  });
}

export const requestsApi = createRequestsApi();
