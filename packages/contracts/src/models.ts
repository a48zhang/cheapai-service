import { z } from 'zod';

const safeCountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveCountSchema = safeCountSchema.min(1);
const text = (max = 256) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim() === value);

export const modelStatusSchema = z.enum(['active', 'disabled']);
export const BILLABLE_BUCKETS = [
  'input',
  'output',
  'cacheRead',
  'cacheWrite',
  'cacheWrite5m',
  'cacheWrite1h',
  'reasoning',
] as const;

/** Decimal USD per million tokens. Strings stay exact across the API boundary. */
const priceStringSchema = z
  .string()
  .max(18)
  .regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,8})?$/u);

export const sellPricesSchema = z.object({
  input: priceStringSchema,
  output: priceStringSchema,
  cacheRead: priceStringSchema.optional(),
  cacheWrite: priceStringSchema.optional(),
  cacheWrite5m: priceStringSchema.optional(),
  cacheWrite1h: priceStringSchema.optional(),
  reasoning: priceStringSchema.optional(),
});

/** Integer USD smallest units are represented as decimal strings, never floats. */
const admissionUnitsSchema = z
  .string()
  .max(128)
  .regex(/^(?:0|[1-9][0-9]*)$/u);
const modelIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/u);

export const modelViewSchema = z
  .object({
    publicModelId: modelIdSchema,
    status: modelStatusSchema,
    sellPrices: sellPricesSchema,
    priceVersion: positiveCountSchema,
    admissionMinBalanceUnits: admissionUnitsSchema,
    maxOutputTokens: positiveCountSchema,
    createdAt: safeCountSchema,
    updatedAt: safeCountSchema,
  })
  .refine((value) => value.updatedAt >= value.createdAt, { path: ['updatedAt'] });

export const modelPageSchema = z.object({
  items: z.array(modelViewSchema),
  nextCursor: text(2048).nullable(),
});

export const modelInputSchema = z.object({
  publicModelId: modelIdSchema,
  status: modelStatusSchema.optional(),
  sellPrices: sellPricesSchema,
  admissionMinBalanceUnits: admissionUnitsSchema,
  maxOutputTokens: positiveCountSchema,
});

export const modelPatchSchema = z
  .object({
    status: modelStatusSchema.optional(),
    sellPrices: sellPricesSchema.optional(),
    admissionMinBalanceUnits: admissionUnitsSchema.optional(),
    maxOutputTokens: positiveCountSchema.optional(),
  })

  .refine((value) => Object.keys(value).length > 0);

export type ModelStatus = z.infer<typeof modelStatusSchema>;
export type SellPrices = z.infer<typeof sellPricesSchema>;
export type ModelView = z.infer<typeof modelViewSchema>;
export type ModelPage = z.infer<typeof modelPageSchema>;
export type ModelInput = z.infer<typeof modelInputSchema>;
export type ModelPatch = z.infer<typeof modelPatchSchema>;

export interface ModelQuery {
  readonly cursor?: string | null;
  readonly status?: ModelStatus;
}

export function decodeModel(value: unknown): ModelView {
  const result = modelViewSchema.safeParse(value);
  if (!result.success) throw new TypeError('Invalid administrator model response.');
  return result.data;
}

export function decodeModelPage(value: unknown): ModelPage {
  const result = modelPageSchema.safeParse(value);
  if (!result.success) throw new TypeError('Invalid administrator model response.');
  return result.data;
}
