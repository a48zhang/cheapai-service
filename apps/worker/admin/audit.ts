import { prepare } from '../db';
import type { DbStatement } from '../db';

export interface AuditEvent {
  id?: string;
  actor_id: string;
  action: string;
  target_type: string;
  target_id: string;
  operation_id: string;
  created_at: number;
  changes: unknown;
}

/**
 * Callers construct the business change explicitly, without credentials or
 * request bodies. Keep this statement in the same D1 batch as the write.
 */
export function buildAuditStatement(database: D1Database, event: AuditEvent): DbStatement<{ id: string }> {
  return prepare<{ id: string }>(database,
    `INSERT INTO admin_audit (id, actor_id, action, target_type, target_id, redacted_change_json, operation_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    [event.id ?? crypto.randomUUID(), event.actor_id, event.action, event.target_type,
      event.target_id, JSON.stringify(event.changes), event.operation_id, event.created_at]);
}
