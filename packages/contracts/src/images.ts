import { z } from 'zod';

const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const units = z.string().regex(/^(0|[1-9][0-9]*)$/u);
export const imageSizes = [
  '1024x1024',
  '1024x1536',
  '1536x1024',
  '1024x1792',
  '1792x1024',
  '512x512',
  '256x256',
] as const;
export const imageSizeSchema = z.enum(imageSizes);
export const imageModelInputSchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    channelId: id,
    upstreamModel: z.string().trim().min(1).max(256),
    pricePerImage: z
      .string()
      .max(18)
      .regex(/^(0|[1-9][0-9]*)(\.[0-9]{1,8})?$/u),
    sizes: z
      .array(imageSizeSchema)
      .min(1)
      .max(imageSizes.length)
      .refine((values) => new Set(values).size === values.length),
    quality: z.enum(['default', 'auto', 'low', 'medium', 'high', 'standard', 'hd']),
    responseFormat: z.enum(['default', 'b64_json']),
    status: z.enum(['active', 'disabled']),
  })
  .strict();
export const imageModelSchema = imageModelInputSchema.extend({ id, version: count.min(1) });
export const imageModelsSchema = z.object({
  items: z.array(imageModelSchema),
  storageReady: z.boolean(),
});
export const imageChoiceSchema = z.object({
  modelId: id,
  name: z.string(),
  groupId: id,
  groupName: z.string(),
  sizes: z.array(imageSizeSchema).min(1),
  priceUnits: units,
});
export const imageChoicesSchema = z.object({
  items: z.array(imageChoiceSchema),
  available: z.boolean(),
});
export const imageGenerateInputSchema = z
  .object({
    operationId: id,
    modelId: id,
    groupId: id,
    prompt: z
      .string()
      .min(1)
      .refine((value) => value.trim().length > 0),
    size: imageSizeSchema,
  })
  .strict();
export const imageJobSchema = z.object({
  id,
  operationId: id,
  modelId: id,
  modelName: z.string(),
  groupId: id,
  prompt: z.string(),
  size: imageSizeSchema,
  status: z.enum(['generating', 'completed', 'failed']),
  error: z
    .enum([
      'provider_rejected',
      'provider_unavailable',
      'invalid_image',
      'storage_unavailable',
      'delivery_failed',
    ])
    .nullable(),
  priceUnits: units,
  billingStatus: z.enum(['unbilled', 'pending', 'settled']),
  createdAt: count,
  updatedAt: count,
});
export const imageJobPageSchema = z.object({
  items: z.array(imageJobSchema),
  nextCursor: z.string().nullable(),
});
export type ImageModelInput = z.infer<typeof imageModelInputSchema>;
export type ImageModel = z.infer<typeof imageModelSchema>;
export type ImageChoice = z.infer<typeof imageChoiceSchema>;
export type ImageGenerateInput = z.infer<typeof imageGenerateInputSchema>;
export type ImageJob = z.infer<typeof imageJobSchema>;
export type ImageSize = z.infer<typeof imageSizeSchema>;
