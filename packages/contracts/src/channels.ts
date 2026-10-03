import { z } from 'zod';

const safeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveVersion = safeInteger.min(1);
const channelIdSchema = z.string().min(1).max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
const modelIdSchema = z.string().min(1).max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/u);
const cleanText = (max: number) => z.string().min(1).max(max)
  .refine(value => value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value));

export const channelStatusSchema = z.enum(['active', 'disabled']);
export const channelProtocolSchema = z.enum(['chat', 'responses', 'messages']);
export const channelVersionSchema = positiveVersion;

/** The worker returns MAX_SAFE_INTEGER for unlimited; older data may return 0. */
const concurrencyLimitViewSchema = safeInteger.min(0).transform(value => value === 0 ? Number.MAX_SAFE_INTEGER : value);
const rpmLimitViewSchema = safeInteger.min(0)
  .refine(value => value === 0 || value === Number.MAX_SAFE_INTEGER || value <= 4096)
  .transform(value => value === 0 ? Number.MAX_SAFE_INTEGER : value);
const concurrencyLimitInputSchema = z.union([safeInteger.min(1), z.literal(0)]).nullable().optional();
const rpmLimitInputSchema = z.union([
  z.number().int().min(1).max(4096),
  z.literal(0),
  z.literal(Number.MAX_SAFE_INTEGER),
]).nullable().optional();

export const channelModelSchema = z.object({
  publicModelId: modelIdSchema,
  upstreamModel: cleanText(128),
  protocol: channelProtocolSchema,
  mappingVersion: positiveVersion,
  priceVersion: positiveVersion,
}).strict();

export const channelSchema = z.object({
  id: channelIdSchema,
  name: cleanText(200),
  baseUrl: cleanText(2048),
  status: channelStatusSchema,
  priority: safeInteger,
  concurrencyLimit: concurrencyLimitViewSchema,
  rpmLimit: rpmLimitViewSchema,
  configVersion: channelVersionSchema,
  createdAt: safeInteger,
  updatedAt: safeInteger,
  hasCredential: z.boolean(),
  models: z.array(channelModelSchema),
}).strict().refine(value => value.updatedAt >= value.createdAt, { path: ['updatedAt'] });

const channelFieldsSchema = z.object({
  name: cleanText(200),
  baseUrl: cleanText(2048),
  concurrencyLimit: concurrencyLimitInputSchema,
  rpmLimit: rpmLimitInputSchema,
  priority: safeInteger.optional(),
  status: channelStatusSchema.optional(),
}).strict();

export const channelInputSchema = channelFieldsSchema.extend({
  upstreamKey: cleanText(16_384),
}).strict();

export const channelPatchSchema = channelFieldsSchema.partial().extend({
  upstreamKey: cleanText(16_384).optional(),
}).strict().refine(value => Object.values(value).some(field => field !== undefined), {
  message: 'At least one channel field is required.',
});

export const channelPageSchema = z.object({
  items: z.array(channelSchema),
  nextCursor: z.string().min(1).max(2048).nullable(),
}).strict();

export const channelListQuerySchema = z.object({
  cursor: z.string().max(2048).nullable().optional(),
  status: channelStatusSchema.optional(),
}).strict();

export const channelProbeInputSchema = z.object({
  publicModelId: modelIdSchema,
  protocol: channelProtocolSchema,
  channelVersion: channelVersionSchema,
  mappingVersion: positiveVersion,
  priceVersion: positiveVersion,
}).strict();

export const channelProbeResultSchema = z.object({
  diagnosticId: cleanText(128),
  channelId: channelIdSchema,
  publicModelId: modelIdSchema,
  protocol: channelProtocolSchema,
  outcome: z.enum(['responded', 'http_error', 'invalid_response', 'timeout', 'cancelled', 'transport_error']),
  upstreamStatus: z.number().int().min(100).max(599).nullable(),
  channelVersion: positiveVersion,
  mappingVersion: positiveVersion,
  priceVersion: positiveVersion,
  maxOutputTokens: positiveVersion,
  mayIncurUpstreamCost: z.literal(true),
  userBalanceCharged: z.literal(false),
}).strict();

export type ChannelStatus = z.infer<typeof channelStatusSchema>;
export type ChannelProtocol = z.infer<typeof channelProtocolSchema>;
export type ChannelModel = z.infer<typeof channelModelSchema>;
export type ChannelView = z.infer<typeof channelSchema>;
export type ChannelInput = z.infer<typeof channelInputSchema>;
export type ChannelPatch = z.infer<typeof channelPatchSchema>;
export type ChannelPage = z.infer<typeof channelPageSchema>;
export type ChannelListQuery = z.infer<typeof channelListQuerySchema>;
export type ChannelProbeInput = z.infer<typeof channelProbeInputSchema>;
export type ChannelProbeResult = z.infer<typeof channelProbeResultSchema>;

export function decodeChannel(value: unknown): ChannelView {
  return channelSchema.parse(value);
}

export function decodeChannelPage(value: unknown): ChannelPage {
  return channelPageSchema.parse(value);
}

export function decodeChannelProbeResult(value: unknown): ChannelProbeResult {
  return channelProbeResultSchema.parse(value);
}
