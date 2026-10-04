import { z } from 'zod';

const text = (max = 256) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim() === value);
const amount = z
  .string()
  .max(128)
  .regex(/^(?:0|-?[1-9][0-9]*)$/u);
const nonNegativeAmount = z
  .string()
  .max(128)
  .regex(/^(?:0|[1-9][0-9]*)$/u);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const billingKindSchema = z.enum(['consumption', 'grant', 'adjustment']);

/** Signed delta in integer USD units; never decode to a floating point number. */
export const billingEntrySchema = z.object({
  id: text(),
  operationId: text(),
  kind: billingKindSchema,
  userId: text(),
  requestId: text().nullable(),
  modelId: text().nullable().optional(),
  source: z.enum(['api', 'web_chat']).nullable().optional(),
  currency: z.literal('USD'),
  deltaUnits: amount,
  createdBy: text().nullable(),
  reason: text(4096).nullable(),
  createdAt: z
    .string()
    .max(64)
    .refine((value) => !Number.isNaN(Date.parse(value))),
});

export const billingSummarySchema = z.object({
  currency: z.literal('USD'),
  consumptionUnits: nonNegativeAmount,
  createdFrom: count.nullable(),
  createdBefore: count.nullable(),
});

export const billingPageSchema = z.object({
  items: z.array(billingEntrySchema),
  nextCursor: text(2048).nullable(),
  summary: billingSummarySchema.optional(),
});

export const balanceReconciliationSchema = z.object({
  userId: text(),
  currency: z.literal('USD'),
  balanceUnits: amount,
  ledgerUnits: amount,
  differenceUnits: amount,
  entryCount: count,
  matches: z.boolean(),
  negativeBalance: z.boolean(),
});

export const balanceReconciliationPageSchema = z.object({
  items: z.array(balanceReconciliationSchema),
  nextCursor: text(2048).nullable(),
});

export type BillingKind = z.infer<typeof billingKindSchema>;
export type BillingEntry = z.infer<typeof billingEntrySchema>;
export type BillingSummary = z.infer<typeof billingSummarySchema>;
export type BillingPage = z.infer<typeof billingPageSchema>;
export type BalanceReconciliation = z.infer<typeof balanceReconciliationSchema>;
export type BalanceReconciliationPage = z.infer<typeof balanceReconciliationPageSchema>;

export interface BillingQuery {
  readonly cursor?: string | null;
  readonly kind?: BillingKind;
  readonly requestId?: string;
  readonly createdFrom?: number;
  readonly createdBefore?: number;
}

export interface AdminBillingQuery extends BillingQuery {
  readonly userId?: string;
}

export function decodeBillingEntry(value: unknown): BillingEntry {
  const result = billingEntrySchema.safeParse(value);
  if (!result.success) throw new TypeError('Invalid billing response.');
  return result.data;
}

export function decodeBillingSummary(value: unknown): BillingSummary {
  const result = billingSummarySchema.safeParse(value);
  if (!result.success) throw new TypeError('Invalid billing response.');
  return result.data;
}

export function decodeBillingPage(value: unknown): BillingPage {
  const result = billingPageSchema.safeParse(value);
  if (!result.success) throw new TypeError('Invalid billing response.');
  return result.data;
}

export function decodeBalanceReconciliationPage(value: unknown): BalanceReconciliationPage {
  const result = balanceReconciliationPageSchema.safeParse(value);
  if (!result.success) throw new TypeError('Invalid administrator billing response.');
  return result.data;
}
