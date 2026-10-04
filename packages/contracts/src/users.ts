import { z } from 'zod';
import { publicUserSchema } from './auth.js';

const text = z.string().min(1).max(254);
const count = z.number().int().nonnegative().refine(Number.isSafeInteger);
const positive = count.refine((value) => value > 0);
const units = z
  .string()
  .max(128)
  .regex(/^(?:0|-?[1-9][0-9]*)$/u);
export const userListItemSchema = publicUserSchema.extend({
  allowed_group_ids: z.array(text),
  group_name: text,
  concurrency_limit: positive,
  rpm_limit: positive,
  created_at: count,
  updated_at: count,
  version: positive,
});
export const userPageSchema = z.object({
  items: z.array(userListItemSchema),
  nextCursor: z.string().nullable(),
  snapshotAt: count,
});
export const userInputSchema = z.object({
  email: z.string(),
  password: z.string(),
  groupId: z.string().optional(),
});
export const userPatchSchema = z.object({
  status: z.enum(['active', 'disabled']),
  groupId: text,
  concurrencyLimit: positive,
  rpmLimit: positive,
  allowedGroupIds: z.array(text).optional(),
});
export const userGroupSchema = z.object({
  id: text,
  name: text,
  status: z.enum(['active', 'disabled']),
});
export const userGroupPageSchema = z.object({
  items: z.array(userGroupSchema),
  nextCursor: z.string().nullable(),
});
export const balanceAdjustmentInputSchema = z.object({
  kind: z.enum(['grant', 'adjustment']),
  deltaUnits: units,
  reason: z.string().min(1).max(4096),
  requestId: text.nullable().optional(),
});
export const balanceAdjustmentEntrySchema = z
  .object({
    id: text,
    operationId: text,
    kind: z.enum(['grant', 'adjustment']),
    userId: text,
    requestId: text.nullable(),
    deltaUnits: units,
    currency: z.literal('USD'),
    fingerprint: z.string().min(1).max(256),
    createdBy: text,
    reason: z.string().min(1).max(4096),
    createdAt: count,
  })
  .refine((value) => value.kind !== 'grant' || BigInt(value.deltaUnits) > 0n);
export const balanceAdjustmentResultSchema = z.object({
  entry: balanceAdjustmentEntrySchema,
  outcome: z.enum(['inserted', 'existing']),
});
const keyStateSchema = z.object({
  id: text,
  userId: text,
  status: z.enum(['active', 'revoked']),
  version: positive,
  createdAt: count,
  updatedAt: count,
});
export const adminKeyRevocationSchema = z.object({
  kind: z.enum(['revoked', 'already_revoked']),
  key: keyStateSchema,
});
export type UserListItem = z.infer<typeof userListItemSchema>;
export type UserPage = z.infer<typeof userPageSchema>;
export type UserInput = z.infer<typeof userInputSchema>;
export type UserPatch = z.infer<typeof userPatchSchema>;
export type UserGroup = z.infer<typeof userGroupSchema>;
export type BalanceAdjustmentInput = z.infer<typeof balanceAdjustmentInputSchema>;
export type BalanceAdjustmentResult = z.infer<typeof balanceAdjustmentResultSchema>;
export const decodeUser = (value: unknown) => userListItemSchema.parse(value);
export const decodeUserPage = (value: unknown) => userPageSchema.parse(value);
export const decodeBalanceAdjustment = (value: unknown) =>
  balanceAdjustmentResultSchema.parse(value);
