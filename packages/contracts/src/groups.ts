import { z } from 'zod';

const safeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const groupIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/u);
const channelIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
const groupNameSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value))
  .transform((value) => value.trim())
  .pipe(z.string().min(1).max(128));

export const groupStatusSchema = z.enum(['active', 'disabled']);
export const groupVersionSchema = safeInteger.min(1);
export const billingMultiplierSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/u);

const groupChannelIdsViewSchema = z
  .array(channelIdSchema)
  .refine((ids) => new Set(ids).size === ids.length);
const groupChannelIdsInputSchema = z
  .array(channelIdSchema)
  .max(100)
  .transform((ids) => [...new Set(ids)].sort());

export const groupSchema = z
  .object({
    id: groupIdSchema,
    name: groupNameSchema,
    status: groupStatusSchema,
    version: groupVersionSchema,
    createdAt: safeInteger,
    updatedAt: safeInteger,
    channelIds: groupChannelIdsViewSchema,
    /** Missing multipliers existed in early persisted group rows and mean 1. */
    billingMultiplier: billingMultiplierSchema.optional(),
  })
  .strict()
  .refine((value) => value.updatedAt >= value.createdAt, { path: ['updatedAt'] })
  .transform((value) => ({ ...value, billingMultiplier: value.billingMultiplier ?? '1' }));

const groupFieldsSchema = z
  .object({
    name: groupNameSchema,
    status: groupStatusSchema.optional(),
    channelIds: groupChannelIdsInputSchema.optional(),
    billingMultiplier: billingMultiplierSchema.optional(),
  })
  .strict();

export const groupInputSchema = groupFieldsSchema;
export const groupPatchSchema = groupFieldsSchema
  .partial()
  .strict()
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'At least one group field is required.',
  });

export const groupPageSchema = z
  .object({
    items: z.array(groupSchema),
    nextCursor: z.string().min(1).max(1024).nullable(),
  })
  .strict();

export const groupListQuerySchema = z
  .object({
    cursor: z.string().max(1024).nullable().optional(),
    status: groupStatusSchema.optional(),
  })
  .strict();

export type GroupStatus = z.infer<typeof groupStatusSchema>;
export type BillingMultiplier = z.infer<typeof billingMultiplierSchema>;
export type GroupView = z.infer<typeof groupSchema>;
export type GroupInput = z.infer<typeof groupInputSchema>;
export type GroupPatch = z.infer<typeof groupPatchSchema>;
export type GroupPage = z.infer<typeof groupPageSchema>;
export type GroupListQuery = z.infer<typeof groupListQuerySchema>;

export function decodeGroup(value: unknown): GroupView {
  return groupSchema.parse(value);
}

export function decodeGroupPage(value: unknown): GroupPage {
  return groupPageSchema.parse(value);
}
