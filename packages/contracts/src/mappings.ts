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

export const modelMappingViewSchema = z.object({
  channelId: identifierSchema,
  publicModelId: identifierSchema,
  protocol: protocolSchema,
  upstreamModel: z.string(),
  configVersion: positiveCountSchema,
});

export const modelMappingListSchema = z.object({
  items: z.array(modelMappingViewSchema),
});

export const modelMappingInputSchema = z.object({
  channelId: identifierSchema,
  protocol: protocolSchema,
  upstreamModel: z.string(),
});

export const modelMappingPatchSchema = z
  .object({
    upstreamModel: z.string().optional(),
  })

  .refine((value) => Object.keys(value).length > 0);

export type Protocol = z.infer<typeof protocolSchema>;
export type ModelMappingView = z.infer<typeof modelMappingViewSchema>;
export type ModelMappingList = z.infer<typeof modelMappingListSchema>;
export type ModelMappingInput = z.infer<typeof modelMappingInputSchema>;
export type ModelMappingPatch = z.infer<typeof modelMappingPatchSchema>;

export interface ModelMappingQuery {
  readonly protocol?: Protocol;
  readonly activeOnly?: boolean;
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
