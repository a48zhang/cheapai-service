import { z } from 'zod';

const safeCountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveCountSchema = safeCountSchema.min(1);
const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/u)
  .refine((value) => value.trim() === value);

export const protocolSchema = z.enum(['chat', 'responses', 'messages']);

export const CAPABILITY_FEATURES = [
  'streaming',
  'stream_usage',
  'tools',
  'tool_choice',
  'parallel_tools',
  'parallel_tool_control',
  'strict_tools',
  'image_url',
  'image_base64',
  'image_file_id',
  'image_detail',
  'tool_result_images',
  'tool_result_error',
  'refusal_history',
  'json_object',
  'json_schema',
  'reasoning_effort',
  'reasoning_summary',
  'reasoning_history',
  'thinking_budget',
  'thinking_adaptive',
  'thinking_control',
  'signed_thinking',
  'redacted_thinking',
  'encrypted_reasoning',
  'cache_control',
  'response_history',
  'item_references',
  'file_inputs',
  'file_references',
  'temperature',
  'top_p',
  'top_k',
  'stop_sequences',
  'seed',
  'penalties',
  'multiple_choices',
  'service_tier',
  'metadata',
  'message_names',
  'store',
  'verbosity',
  'citations',
  'logprobs',
  'system_developer_priority',
] as const;

export const capabilityFeatureSchema = z.string().min(1);

export const channelCapabilitiesSchema = z.object({
  protocol: protocolSchema,
  features: z.array(capabilityFeatureSchema),
  maxOutputTokens: positiveCountSchema.optional(),
  reasoningEfforts: z.array(z.string().min(1)).optional(),
  cacheTtls: z.array(z.string().min(1)).optional(),
});

export const modelMappingViewSchema = z
  .object({
    channelId: identifierSchema,
    publicModelId: identifierSchema,
    protocol: protocolSchema,
    upstreamModel: identifierSchema,
    capabilities: channelCapabilitiesSchema,
    configVersion: positiveCountSchema,
  })
  .refine((value) => value.capabilities.protocol === value.protocol, {
    path: ['capabilities', 'protocol'],
  });

export const modelMappingListSchema = z.object({
  items: z.array(modelMappingViewSchema),
});

export const modelMappingInputSchema = z
  .object({
    channelId: identifierSchema,
    protocol: protocolSchema,
    upstreamModel: identifierSchema,
    capabilities: channelCapabilitiesSchema,
  })

  .refine((value) => value.capabilities.protocol === value.protocol, {
    path: ['capabilities', 'protocol'],
  });

export const modelMappingPatchSchema = z
  .object({
    upstreamModel: identifierSchema.optional(),
    capabilities: channelCapabilitiesSchema.optional(),
  })

  .refine((value) => Object.keys(value).length > 0);

export type Protocol = z.infer<typeof protocolSchema>;
export type CapabilityFeature = z.infer<typeof capabilityFeatureSchema>;
export type ChannelCapabilities = z.infer<typeof channelCapabilitiesSchema>;
export type ModelMappingView = z.infer<typeof modelMappingViewSchema>;
export type ModelMappingList = z.infer<typeof modelMappingListSchema>;
export type ModelMappingInput = z.infer<typeof modelMappingInputSchema>;
export type ModelMappingPatch = z.infer<typeof modelMappingPatchSchema>;

export interface ModelMappingQuery {
  readonly protocol?: Protocol;
  readonly activeOnly?: boolean;
}

export function decodeCapabilities(value: unknown): ChannelCapabilities {
  const result = channelCapabilitiesSchema.safeParse(value);
  if (!result.success) throw new TypeError('Invalid administrator model mapping response.');
  return result.data;
}

export function decodeMapping(value: unknown): ModelMappingView {
  const result = modelMappingViewSchema.safeParse(value);
  if (!result.success) throw new TypeError('Invalid administrator model mapping response.');
  return result.data;
}

export function decodeMappings(value: unknown): ModelMappingList {
  const result = modelMappingListSchema.safeParse(value);
  if (!result.success) throw new TypeError('Invalid administrator model mapping response.');
  return result.data;
}
