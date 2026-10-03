import { z } from 'zod';
const text = z.string().min(1).max(256).refine(value => value.trim() === value);
const count = z.number().int().nonnegative().refine(Number.isSafeInteger);
export const auditEntrySchema = z.object({ id: text, actor_id: text, action: text.max(64), target_type: text.max(64), target_id: text, operation_id: text, created_at: count, changes: z.record(z.string(), z.unknown()).nullable(), redaction_valid: z.boolean() });
export const auditPageSchema = z.object({ items: z.array(auditEntrySchema), nextCursor: z.string().min(1).max(2048).nullable(), snapshotAt: count });
export const settlementResultSchema = z.object({ status: z.enum(['settled', 'already_settled']), requestId: z.string().min(1), entryId: z.string().min(1), costUnits: z.string().regex(/^(?:0|-?[1-9][0-9]*)$/u) });
export type AuditEntry = z.infer<typeof auditEntrySchema>;
export type AuditPage = z.infer<typeof auditPageSchema>;
export type SettlementResult = z.infer<typeof settlementResultSchema>;
export interface AuditQuery { cursor?: string | null; from?: number; to?: number; actorId?: string; action?: string; targetType?: string; targetId?: string; operationId?: string }
export const decodeAuditPage = (value: unknown) => auditPageSchema.parse(value);
export const decodeSettlementResult = (value: unknown) => settlementResultSchema.parse(value);
