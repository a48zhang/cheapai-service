import { z } from 'zod';
const text = z.string().min(1).max(128);
const count = z.number().int().nonnegative().refine(Number.isSafeInteger);
const time = count.nullable();
export const adminRegistrationSettingsSchema = z.object({
  registrationMode: z.enum(['closed', 'open', 'invite']).nullable(),
  emailVerificationEnabled: z.boolean().nullable(),
  version: count.refine((value) => value > 0).nullable(),
  updatedAt: time,
  valid: z.boolean(),
  ready: z.boolean(),
  emailAvailable: z.boolean(),
  issues: z.array(z.enum(['missing_settings', 'invalid_settings', 'email_unavailable'])),
});
export const codeMetadataSchema = z.object({
  id: text,
  displayPrefix: z.string().regex(/^s2a_invite_[A-Za-z0-9_-]{8}$/u),
  ordinal: count,
  expiresAt: time,
});
export const codeListItemSchema = codeMetadataSchema.extend({
  batchId: text,
  createdBy: text,
  createdAt: count,
  usedBy: text.nullable(),
  usedAt: time,
  revokedAt: time,
  status: z.enum(['unused', 'used', 'expired', 'revoked']),
});
export const codeBatchSchema = z.discriminatedUnion('replayed', [
  z.object({
    batchId: text,
    replayed: z.literal(true),
    codes: z.array(codeMetadataSchema).min(1).max(100),
  }),
  z.object({
    batchId: text,
    replayed: z.literal(false),
    codes: z
      .array(
        codeMetadataSchema.extend({ token: z.string().regex(/^s2a_invite_[A-Za-z0-9_-]{43}$/u) }),
      )
      .min(1)
      .max(100),
  }),
]);
export const codePageSchema = z.object({
  items: z.array(codeListItemSchema),
  nextCursor: z.string().nullable(),
  snapshotAt: count,
});
export const codeRevocationSchema = z.object({
  id: text,
  status: z.enum(['revoked', 'already_revoked']),
  revokedAt: time,
});
export const codeBatchInputSchema = z.object({
  quantity: z.number().int().min(1).max(100),
  expiresAt: count,
});
export type AdminRegistrationSettings = z.infer<typeof adminRegistrationSettingsSchema>;
export type CodeMetadata = z.infer<typeof codeMetadataSchema>;
export type CodeListItem = z.infer<typeof codeListItemSchema>;
export type CodeBatch = z.infer<typeof codeBatchSchema>;
export type CodePage = z.infer<typeof codePageSchema>;
export type CodeBatchInput = z.infer<typeof codeBatchInputSchema>;
export const decodeSettings = (value: unknown) => adminRegistrationSettingsSchema.parse(value);
export const decodeCodeBatch = (value: unknown) => codeBatchSchema.parse(value);
export const decodeCodePage = (value: unknown) => codePageSchema.parse(value);
