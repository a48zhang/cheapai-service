import { z } from 'zod';
import type {
  ModelInput,
  ModelPatch,
  ModelStatus,
  ModelView,
  SellPrices,
} from '@cheapai/api-client/models';
import {
  BILLABLE_BUCKETS,
  modelInputSchema,
  modelStatusSchema,
  sellPricesSchema,
} from '@cheapai/contracts/models';

const optionalRate = (
  bucket: 'cacheRead' | 'cacheWrite' | 'cacheWrite5m' | 'cacheWrite1h' | 'reasoning',
) => z.union([z.literal(''), sellPricesSchema.shape[bucket].unwrap()]);

const priceFormSchema = z
  .object({
    input: sellPricesSchema.shape.input,
    output: sellPricesSchema.shape.output,
    cacheRead: optionalRate('cacheRead'),
    cacheWrite: optionalRate('cacheWrite'),
    cacheWrite5m: optionalRate('cacheWrite5m'),
    cacheWrite1h: optionalRate('cacheWrite1h'),
    reasoning: optionalRate('reasoning'),
  })
  .transform((values): z.input<typeof sellPricesSchema> => ({
    input: values.input,
    output: values.output,
    cacheRead: values.cacheRead === '' ? undefined : values.cacheRead,
    cacheWrite: values.cacheWrite === '' ? undefined : values.cacheWrite,
    cacheWrite5m: values.cacheWrite5m === '' ? undefined : values.cacheWrite5m,
    cacheWrite1h: values.cacheWrite1h === '' ? undefined : values.cacheWrite1h,
    reasoning: values.reasoning === '' ? undefined : values.reasoning,
  }));

const maxOutputTokensText = z
  .string()
  .regex(/^[1-9][0-9]*$/u)
  .transform(Number)
  .pipe(modelInputSchema.shape.maxOutputTokens);

const requiredModelInputSchema = modelInputSchema.extend({ status: modelStatusSchema });

/** Form inputs keep price text exact and convert only empty optional buckets before contract validation. */
export const modelFormSchema = z
  .object({
    publicModelId: modelInputSchema.shape.publicModelId,
    status: modelStatusSchema,
    sellPrices: priceFormSchema,
    admissionMinBalanceUnits: modelInputSchema.shape.admissionMinBalanceUnits,
    maxOutputTokens: maxOutputTokensText,
  })
  .strict()
  .pipe(requiredModelInputSchema);

export type ModelFormValues = z.input<typeof modelFormSchema>;
export type ModelFormOutput = z.output<typeof modelFormSchema>;
export type ModelPriceFieldErrors = Partial<
  Record<(typeof BILLABLE_BUCKETS)[number], string | undefined>
>;

function priceValues(prices?: SellPrices): ModelFormValues['sellPrices'] {
  return {
    input: prices?.input ?? '',
    output: prices?.output ?? '',
    cacheRead: prices?.cacheRead ?? '',
    cacheWrite: prices?.cacheWrite ?? '',
    cacheWrite5m: prices?.cacheWrite5m ?? '',
    cacheWrite1h: prices?.cacheWrite1h ?? '',
    reasoning: prices?.reasoning ?? '',
  };
}

export function initialModelFormValues(model?: ModelView): ModelFormValues {
  return {
    publicModelId: model?.publicModelId ?? '',
    status: model?.status ?? 'active',
    sellPrices: priceValues(model?.sellPrices),
    admissionMinBalanceUnits: model?.admissionMinBalanceUnits ?? '',
    maxOutputTokens: model === undefined ? '' : String(model.maxOutputTokens),
  };
}

export function modelPriceErrors(value: unknown): ModelPriceFieldErrors {
  if (typeof value !== 'object' || value === null) return {};
  const errors: ModelPriceFieldErrors = {};
  for (const bucket of BILLABLE_BUCKETS) {
    const error = (value as Record<string, unknown>)[bucket];
    if (
      typeof error === 'object' &&
      error !== null &&
      'message' in error &&
      typeof error.message === 'string'
    ) {
      errors[bucket] = error.message;
    }
  }
  return errors;
}

function samePrices(left: SellPrices, right: SellPrices): boolean {
  return BILLABLE_BUCKETS.every(
    (bucket) => (left[bucket] ?? undefined) === (right[bucket] ?? undefined),
  );
}

export function createModelPatch(previous: ModelView, next: ModelInput): ModelPatch {
  const patch: {
    status?: ModelStatus;
    sellPrices?: SellPrices;
    admissionMinBalanceUnits?: string;
    maxOutputTokens?: number;
  } = {};
  if (next.status !== undefined && previous.status !== next.status) patch.status = next.status;
  if (!samePrices(previous.sellPrices, next.sellPrices)) patch.sellPrices = next.sellPrices;
  if (previous.admissionMinBalanceUnits !== next.admissionMinBalanceUnits)
    patch.admissionMinBalanceUnits = next.admissionMinBalanceUnits;
  if (previous.maxOutputTokens !== next.maxOutputTokens)
    patch.maxOutputTokens = next.maxOutputTokens;
  return patch;
}
