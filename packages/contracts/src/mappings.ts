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

export const EXTENSION_SCOPES = [
  'request',
  'message',
  'content',
  'image_source',
  'tool',
  'tool_function',
  'tool_call',
  'tool_choice',
  'response_format',
  'reasoning',
  'text',
  'thinking',
  'cache_control',
  'stream_options',
  'metadata',
  'output_config',
] as const;

export const capabilityFeatureSchema = z.enum(CAPABILITY_FEATURES);
export const extensionScopeSchema = z.enum(EXTENSION_SCOPES);

const uniqueArray = <T extends z.ZodTypeAny>(schema: T, max: number) =>
  z
    .array(schema)
    .max(max)
    .refine((values) => new Set(values).size === values.length);

const extensionNameSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/u)
  .refine(
    (value) =>
      ![
        'authorization',
        'headers',
        'api_key',
        'base_url',
        'url',
        'host',
        'constructor',
        'prototype',
      ].includes(value.toLowerCase()),
  );

const nativeExtensionSchema = z.object({
  scope: extensionScopeSchema,
  name: extensionNameSchema,
});
const nativeExtensionsSchema = z
  .array(nativeExtensionSchema)
  .max(32)
  .refine(
    (values) =>
      new Set(values.map((value) => `${value.scope}:${value.name}`)).size === values.length,
  );

export const channelCapabilitiesSchema = z
  .object({
    protocol: protocolSchema,
    features: uniqueArray(capabilityFeatureSchema, CAPABILITY_FEATURES.length),
    maxOutputTokens: positiveCountSchema.optional(),
    reasoningEfforts: uniqueArray(
      z
        .string()
        .min(1)
        .max(64)
        .regex(/^[a-z][a-z0-9_-]*$/u)
        .refine((value) => value.trim() === value),
      16,
    ).optional(),
    cacheTtls: uniqueArray(z.enum(['5m', '1h']), 2).optional(),
    nativeExtensions: nativeExtensionsSchema.optional(),
  })
  .superRefine((value, context) => {
    const enabled = new Set(value.features);
    const requires: readonly [string, string][] = [
      ['stream_usage', 'streaming'],
      ['tool_choice', 'tools'],
      ['parallel_tools', 'tools'],
      ['parallel_tool_control', 'tools'],
      ['strict_tools', 'tools'],
      ['tool_result_images', 'tools'],
      ['tool_result_error', 'tools'],
    ];
    for (const [child, parent] of requires) {
      if (
        enabled.has(child as (typeof value.features)[number]) &&
        !enabled.has(parent as (typeof value.features)[number])
      ) {
        context.addIssue({
          code: 'custom',
          path: ['features'],
          message: `${child} requires ${parent}.`,
        });
      }
    }
    if (value.reasoningEfforts !== undefined && !enabled.has('reasoning_effort')) {
      context.addIssue({
        code: 'custom',
        path: ['reasoningEfforts'],
        message: 'reasoningEfforts requires reasoning_effort.',
      });
    }
    if (value.cacheTtls !== undefined && !enabled.has('cache_control')) {
      context.addIssue({
        code: 'custom',
        path: ['cacheTtls'],
        message: 'cacheTtls requires cache_control.',
      });
    }
    if (
      value.nativeExtensions?.some(
        (extension) => extension.scope === 'output_config' && value.protocol !== 'messages',
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['nativeExtensions'],
        message: 'output_config is supported by messages only.',
      });
    }
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
  .strict()
  .refine((value) => value.capabilities.protocol === value.protocol, {
    path: ['capabilities', 'protocol'],
  });

export const modelMappingPatchSchema = z
  .object({
    upstreamModel: identifierSchema.optional(),
    capabilities: channelCapabilitiesSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);

export type Protocol = z.infer<typeof protocolSchema>;
export type CapabilityFeature = z.infer<typeof capabilityFeatureSchema>;
export type ExtensionScope = z.infer<typeof extensionScopeSchema>;
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
