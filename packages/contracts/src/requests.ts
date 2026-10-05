import { z } from 'zod';

const text = (max = 256) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim() === value);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const amount = z
  .string()
  .max(128)
  .regex(/^(?:0|-?[1-9][0-9]*)$/u);

export const protocolSchema = z.enum(['chat', 'responses', 'messages']);
export const requestSourceSchema = z.enum(['api', 'web_chat']);
export const executionStatusSchema = z.enum([
  'admitted',
  'succeeded',
  'failed',
  'cancelled',
  'abandoned',
]);
export const billingStatusSchema = z.enum([
  'awaiting_usage',
  'settled',
  'not_chargeable',
  'settlement_pending',
  'usage_unknown',
]);
export const usageQualitySchema = z.enum(['complete', 'partial', 'missing', 'invalid']);

const tokenCountsSchema = z.object({
  inputTokens: count.optional(),
  outputTokens: count.optional(),
  totalTokens: count.optional(),
  cacheReadTokens: count.optional(),
  cacheWriteTokens: count.optional(),
  cacheWrite5mTokens: count.optional(),
  cacheWrite1hTokens: count.optional(),
  reasoningTokens: count.optional(),
});

const usageSemanticsSchema = z.object({
  cacheRead: z.enum(['included_in_input', 'excluded_from_input', 'unknown']),
  cacheWrite: z.enum(['included_in_input', 'excluded_from_input', 'unknown']),
  reasoning: z.enum(['included_in_output', 'excluded_from_output', 'unknown']),
  cacheWriteTtl: z.enum(['subsets_of_cache_write', 'unknown']),
});

const missingUsageSchema = z.object({ protocol: protocolSchema, quality: z.literal('missing') });
const completeUsageSchema = z.object({
  protocol: protocolSchema,
  quality: z.enum(['complete', 'partial', 'invalid']),
  counts: tokenCountsSchema,
  semantics: usageSemanticsSchema,
});
const publicUsageSchema = z.union([missingUsageSchema, completeUsageSchema]);

const priceString = z
  .string()
  .max(18)
  .regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,8})?$/u);
const sellPricesSchema = z.object({
  input: priceString,
  output: priceString,
  cacheRead: priceString.optional(),
  cacheWrite: priceString.optional(),
  cacheWrite5m: priceString.optional(),
  cacheWrite1h: priceString.optional(),
  reasoning: priceString.optional(),
});

const multiplierSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => value.trim() === value)
  .regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/u);

export const priceSnapshotSchema = z.object({
  schema_version: z.literal(1),
  canonical_json_version: z.literal(1),
  calculation_version: z.literal(1),
  currency: z.literal('USD'),
  decimals: z.literal(8),
  tokens_per_price_unit: z.literal(1_000_000),
  rounding: z.literal('half_up_after_sum'),
  public_model_id: text(),
  upstream_model: text(),
  upstream_protocol: protocolSchema,
  price_version: count.min(1),
  sell_prices: sellPricesSchema,
  group_id: text().optional(),
  group_version: count.min(1).optional(),
  billing_multiplier: multiplierSchema.optional(),
});

const requestErrorSchema = z.object({ code: text(128), message: text(512) });

/** Public request data intentionally excludes private upstream payloads and headers. */
export const requestSchema = z
  .object({
    id: text(),
    user_id: text(),
    api_key_id: text(),
    source: requestSourceSchema.optional(),
    group_id: text(128).nullable().optional(),
    channel_id: text(),
    public_model_id: text(),
    upstream_model: text(),
    downstream_protocol: protocolSchema,
    upstream_protocol: protocolSchema,
    execution_status: executionStatusSchema,
    billing_status: billingStatusSchema,
    created_at: count,
    started_at: count.nullable(),
    finished_at: count.nullable(),
    updated_at: count,
    usage: publicUsageSchema.nullable(),
    usage_valid: z.boolean().nullable(),
    price_snapshot: priceSnapshotSchema.nullable(),
    price_snapshot_valid: z.boolean(),
    cost_units: amount.nullable(),
    error: requestErrorSchema.nullable(),
    retry_count: count,
    next_retry_at: count.nullable(),
  })
  .refine((value) => value.updated_at >= value.created_at, { path: ['updated_at'] })
  .refine((value) => value.usage_valid !== true || value.usage !== null, { path: ['usage_valid'] })
  .refine((value) => value.cost_units === null || !value.cost_units.startsWith('-'), {
    path: ['cost_units'],
  })
  .refine((value) => value.price_snapshot_valid === (value.price_snapshot !== null), {
    path: ['price_snapshot_valid'],
  })
  .transform((value) => ({
    ...value,
    source: value.source ?? ('api' as const),
    group_id: value.group_id ?? null,
  }));

export const requestPageSchema = z.object({
  items: z.array(requestSchema),
  snapshotAt: count,
  nextCursor: text(2048).nullable(),
});

export type Protocol = z.infer<typeof protocolSchema>;
export type RequestSource = z.infer<typeof requestSourceSchema>;
export type ExecutionStatus = z.infer<typeof executionStatusSchema>;
export type BillingStatus = z.infer<typeof billingStatusSchema>;
export type UsageQuality = z.infer<typeof usageQualitySchema>;
export type TokenCounts = z.infer<typeof tokenCountsSchema>;
export type UsageSemantics = z.infer<typeof usageSemanticsSchema>;
export type PublicUsage = z.infer<typeof publicUsageSchema>;
export type PriceSnapshot = z.infer<typeof priceSnapshotSchema>;
export type RequestError = z.infer<typeof requestErrorSchema>;
export type RequestRecord = z.infer<typeof requestSchema>;
export type RequestPage = z.infer<typeof requestPageSchema>;

export interface RequestQuery {
  readonly cursor?: string | null;
  readonly from?: number;
  readonly to?: number;
  readonly status?: ExecutionStatus;
  readonly billingStatus?: BillingStatus;
  readonly model?: string;
}

export interface AdminRequestQuery extends RequestQuery {
  readonly userId?: string;
}

export function decodeRequest(value: unknown): RequestRecord {
  const result = requestSchema.safeParse(value);
  if (!result.success) throw new TypeError('Invalid request response.');
  return result.data;
}

export function decodeRequestPage(value: unknown): RequestPage {
  const result = requestPageSchema.safeParse(value);
  if (!result.success) throw new TypeError('Invalid request response.');
  return result.data;
}
