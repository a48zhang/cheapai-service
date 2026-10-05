import { Hono } from 'hono';
import { requireSession } from '../auth/middleware';
import type { AuthEnv } from '../auth/middleware';
import { requireAdmin } from '../auth/roles';
import { ApiError, apiError, apiSuccess, createRequestId, parsePagination } from '../http';
import { prepare } from '../db';
import type { DbValue } from '../db';
import { AUDIT_LIMITS, redactAuditChanges } from './audit';

export const ADMIN_AUDIT_PATH = '/api/v1/admin/audit';
interface RouteEnv extends AuthEnv { Variables: AuthEnv['Variables'] & { auditQueryNow?: number } }
interface AuditRow { id: string; actor_id: string; action: string; target_type: string; target_id: string; operation_id: string; created_at: number; redacted_change_json: string }
function validId(value: string): boolean { return value.length <= 128 && value.trim() === value && /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(value); }
function time(value: string | null): number | null {
  if (value === null) return null;
  if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value)) || String(Number(value)) !== value) throw new ApiError('invalid_request');
  return Number(value);
}
function encode(value: unknown): string { return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value)))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''); }
function output(row: AuditRow) {
  const { redacted_change_json, ...metadata } = row;
  try {
    if (redacted_change_json.length > AUDIT_LIMITS.bytes || new TextEncoder().encode(redacted_change_json).byteLength > AUDIT_LIMITS.bytes) throw new Error();
    const value: unknown = JSON.parse(redacted_change_json);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    // Defense for legacy/manual rows: never serialize arbitrary stored JSON.
    return { ...metadata, changes: redactAuditChanges(value), redaction_valid: true };
  } catch { return { ...metadata, changes: null, redaction_valid: false }; }
}
function noStore(response: Response): Response { response.headers.set('Cache-Control', 'no-store'); return response; }

/** Read-only and DB/clock only. from/to are inclusive UTC milliseconds.
 * Audits are globally visible to active site admins; actorId is merely a filter.
 */
export function createAuditRoutes(dependencies: { now(): number } = { now: Date.now }): Hono<RouteEnv> {
  const app = new Hono<RouteEnv>();
  app.onError((error, context) => noStore(apiError(error instanceof ApiError ? error : new ApiError('service_unavailable', { cause: error }), context.get('requestId') ?? createRequestId())));
  app.get(ADMIN_AUDIT_PATH, async (context, next) => {
    context.set('requestId', context.get('requestId') ?? createRequestId());
    const now = dependencies.now();
    if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000) throw new ApiError('service_unavailable');
    context.set('auditQueryNow', now); await next(); context.res.headers.set('Cache-Control', 'no-store');
  }, (context, next) => requireSession(() => context.get('auditQueryNow')!)(context, next), requireAdmin, async context => {
    const query = new URL(context.req.url).searchParams;
    for (const key of query.keys()) if (!['limit', 'cursor', 'from', 'to', 'actorId', 'action', 'targetType', 'targetId', 'operationId'].includes(key) || query.getAll(key).length !== 1) throw new ApiError('invalid_request');
    const page = parsePagination(query);
    const filter = { from: time(query.get('from')), to: time(query.get('to')), actorId: query.get('actorId'), action: query.get('action'),
      targetType: query.get('targetType'), targetId: query.get('targetId'), operationId: query.get('operationId') };
    for (const value of [filter.actorId, filter.targetId, filter.operationId]) if (value !== null && !validId(value)) throw new ApiError('invalid_request');
    if ((filter.from !== null && filter.to !== null && filter.from > filter.to)
      || (filter.action !== null && (filter.action.trim() !== filter.action || !/^[a-z][a-z0-9_.-]{0,63}$/.test(filter.action)))
      || (filter.targetType !== null && (filter.targetType.trim() !== filter.targetType || !/^[a-z][a-z0-9_-]{0,63}$/.test(filter.targetType)))) throw new ApiError('invalid_request');
    const actor = context.get('user').id;
    let ceiling = context.get('auditQueryNow')!; let position: [number, string] | undefined;
    if (page.cursor !== null) {
      try {
        const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(atob(page.cursor.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0))));
        if (!Array.isArray(value) || value.length !== 6 || value[0] !== 1 || value[1] !== actor || JSON.stringify(value[2]) !== JSON.stringify(filter)
          || !Number.isSafeInteger(value[3]) || value[3] < 0 || value[3] > ceiling || !Number.isSafeInteger(value[4]) || value[4] < 0 || value[4] > value[3]
          || typeof value[5] !== 'string' || !validId(value[5]) || encode(value) !== page.cursor) throw new Error();
        ceiling = value[3] as number; position = [value[4] as number, value[5]];
      } catch { throw new ApiError('invalid_request'); }
    }
    const conditions = ['created_at<=?']; const values: DbValue[] = [ceiling];
    for (const [column, value] of [['actor_id', filter.actorId], ['action', filter.action], ['target_type', filter.targetType], ['target_id', filter.targetId], ['operation_id', filter.operationId]] as const) {
      if (value !== null) { conditions.push(`${column}=?`); values.push(value); }
    }
    if (filter.from !== null) { conditions.push('created_at>=?'); values.push(filter.from); }
    if (filter.to !== null) { conditions.push('created_at<=?'); values.push(filter.to); }
    if (position) { conditions.push('(created_at<? OR (created_at=? AND id<?))'); values.push(position[0], position[0], position[1]); }
    values.push(page.limit + 1);
    const rows = (await prepare<AuditRow>(context.env.DB,
      `SELECT id,actor_id,action,target_type,target_id,operation_id,created_at,
       CASE WHEN length(CAST(redacted_change_json AS BLOB))<=${AUDIT_LIMITS.bytes} THEN redacted_change_json ELSE 'null' END AS redacted_change_json FROM admin_audit
       WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC,id DESC LIMIT ?`, values).all()).rows;
    const selected = rows.slice(0, page.limit); const last = selected.at(-1);
    return noStore(apiSuccess({ items: selected.map(output), snapshotAt: ceiling,
      nextCursor: rows.length > page.limit && last ? encode([1, actor, filter, ceiling, last.created_at, last.id]) : null }, context.get('requestId')));
  });
  app.notFound(context => noStore(apiError(new ApiError('not_found'), context.get('requestId') ?? createRequestId())));
  return app;
}
