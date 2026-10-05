import { prepare } from '../db';
import type { DbValue } from '../db';
import { ApiError, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '../http';
import { parseUnits } from './money';

export type EntryQueryScope = { readonly kind: 'owner'; readonly userId: string } | { readonly kind: 'admin'; readonly actorId: string };
export type BillingEntryKind = 'consumption' | 'adjustment' | 'grant';
export interface EntryQueryOptions {
  readonly limit?: number;
  readonly cursor?: string;
  /** Admin-only filter; owner identity always comes from the trusted scope. */
  readonly userId?: string;
  readonly kind?: BillingEntryKind;
  readonly requestId?: string;
  /** UTC epoch milliseconds, inclusive lower / exclusive upper bound. */
  readonly createdFrom?: number;
  readonly createdBefore?: number;
}
export interface BillingEntrySummary {
  readonly id: string;
  readonly operationId: string;
  readonly kind: BillingEntryKind;
  readonly userId: string;
  readonly requestId: string | null;
  readonly modelId: string | null;
  readonly source: 'api' | 'web_chat' | null;
  readonly currency: 'USD';
  readonly deltaUnits: string;
  readonly createdBy: string | null;
  readonly reason: string | null;
  readonly createdAt: number;
}
export interface BillingEntryPeriodSummary {
  readonly currency: 'USD';
  readonly consumptionUnits: string;
  readonly createdFrom: number | null;
  readonly createdBefore: number | null;
}
export interface BillingEntryPage { readonly items: readonly BillingEntrySummary[]; readonly nextCursor: string | null; readonly summary?: BillingEntryPeriodSummary }
interface Row { id: string; operation_id: string; kind: BillingEntryKind; user_id: string; request_id: string | null; model_id: string | null; source: 'api' | 'web_chat' | null; currency: string; delta_units: string; created_by: string | null; reason: string | null; created_at: number }
type Cursor = [2, 'owner' | 'admin', string, string | null, BillingEntryKind | null, string | null, number | null, number | null, number, number, string];
export const MAX_LEDGER_TIME_MS = 8_640_000_000_000_000;
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(value) && value.length <= 128;
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function encode(cursor: Cursor): string { return btoa(JSON.stringify(cursor)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''); }
function decode(raw: unknown, binding: Cursor): Cursor {
  try {
    if (typeof raw !== 'string' || raw.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error();
    const value: unknown = JSON.parse(atob(raw.replaceAll('-', '+').replaceAll('_', '/')));
    if (!Array.isArray(value) || value.length !== 11 || value.slice(0, 8).some((entry, index) => entry !== binding[index])
      || !integer(value[8]) || !integer(value[9]) || !validId(value[10])) throw new Error();
    const cursor = value as Cursor;
    return cursor;
  } catch { throw new ApiError('invalid_request'); }
}

/**
 * Caller supplies an authenticated owner/admin scope, never client role claims.
 * Admin authorization is also rechecked in D1. Owner queries always retain the
 * user_id predicate and follow idx_billing_entries_user_created_id's DESC/ASC
 * key order. The cursor binds actor, owner and filters. An internal rowid ceiling
 * freezes append-only pagination even when later insertions have older clocks.
 * This is not a signed cursor or a substitute for scope authorization.
 */
export async function queryBillingEntries(database: D1Database, scope: EntryQueryScope, options: EntryQueryOptions = {}): Promise<BillingEntryPage> {
  const trusted = scope;
  if (trusted.kind !== 'owner' && trusted.kind !== 'admin') throw new ApiError('invalid_request');
  const actor = trusted.kind === 'owner' ? trusted.userId : trusted.actorId;
  if (!validId(actor)) throw new ApiError('invalid_request');
  const input = options;
  if (trusted.kind === 'owner' && Object.hasOwn(input, 'userId')) throw new ApiError('invalid_request');
  const owner = trusted.kind === 'owner' ? actor : input.userId ?? null;
  const kind = input.kind ?? null;
  const requestId = input.requestId ?? null;
  const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
  const createdFrom = input.createdFrom ?? null;
  const createdBefore = input.createdBefore ?? null;
  for (const value of [createdFrom, createdBefore]) if (value !== null && (!integer(value) || value > MAX_LEDGER_TIME_MS)) throw new ApiError('invalid_request');
  if (typeof createdFrom === 'number' && typeof createdBefore === 'number' && createdFrom > createdBefore) throw new ApiError('invalid_request');
  if ((owner !== null && !validId(owner)) || (kind !== null && !['consumption', 'adjustment', 'grant'].includes(kind as string))
    || (requestId !== null && !validId(requestId)) || !integer(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) throw new ApiError('invalid_request');
  // Explicit null option values are invalid, unlike absent optional filters.
  if ([input.limit, input.cursor, input.userId, input.kind, input.requestId, input.createdFrom, input.createdBefore].some(value => value === null)) throw new ApiError('invalid_request');
  const binding: Cursor = [2, trusted.kind, actor, owner as string | null, kind as BillingEntryKind | null, requestId as string | null, createdFrom as number | null, createdBefore as number | null, 0, 0, 'initial'];
  const cursor = Object.hasOwn(input, 'cursor') ? decode(input.cursor, binding) : undefined;
  const clauses: string[] = [];
  const parameters: DbValue[] = [];
  if (owner !== null) { clauses.push('b.user_id=?'); parameters.push(owner as string); }
  if (kind !== null) { clauses.push('b.kind=?'); parameters.push(kind as string); }
  if (requestId !== null) { clauses.push('b.request_id=?'); parameters.push(requestId as string); }
  if (createdFrom !== null) { clauses.push('b.created_at>=?'); parameters.push(createdFrom as number); }
  if (createdBefore !== null) { clauses.push('b.created_at<?'); parameters.push(createdBefore as number); }
  try {
    if (trusted.kind === 'admin') {
      const admin = await prepare<{ id: string }>(database, "SELECT id FROM users WHERE id=? AND status='active' AND role='admin'", [actor]).first();
      if (!admin) throw new ApiError('forbidden');
    }
    let summary: BillingEntryPeriodSummary | undefined;
    if (trusted.kind === 'owner' && cursor === undefined) {
      const summaryClauses = ["kind='consumption'", 'user_id=?'];
      const summaryParameters: DbValue[] = [owner as string];
      if (createdFrom !== null) { summaryClauses.push('created_at>=?'); summaryParameters.push(createdFrom as number); }
      if (createdBefore !== null) { summaryClauses.push('created_at<?'); summaryParameters.push(createdBefore as number); }
      const aggregate = await prepare<{ consumption_units: string }>(database,
        `SELECT CAST(COALESCE(SUM(-delta_units),0) AS TEXT) AS consumption_units
         FROM billing_entries WHERE ${summaryClauses.join(' AND ')}`, summaryParameters).first();
      if (!aggregate || typeof aggregate.consumption_units !== 'string'
          || !/^(?:0|[1-9][0-9]*)$/.test(aggregate.consumption_units)) throw new ApiError('service_unavailable');
      summary = { currency: 'USD', consumptionUnits: aggregate.consumption_units,
        createdFrom: createdFrom as number | null, createdBefore: createdBefore as number | null };
    }
    const watermark = cursor?.[8] ?? (await prepare<{ watermark: number }>(database,
      `SELECT COALESCE(MAX(b.rowid),0) AS watermark FROM billing_entries b${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''}`, parameters).first())?.watermark;
    if (!integer(watermark)) throw new ApiError('service_unavailable');
    clauses.push('b.rowid<=?'); parameters.push(watermark);
    if (cursor) { clauses.push('(b.created_at<? OR (b.created_at=? AND b.id>?))'); parameters.push(cursor[9], cursor[9], cursor[10]); }
    parameters.push(limit + 1);
    const result = await prepare<Row>(database, `SELECT b.id,b.operation_id,b.kind,b.user_id,b.request_id,
        r.public_model_id AS model_id,r.source, b.currency,CAST(b.delta_units AS TEXT) AS delta_units,
        b.created_by,b.reason,b.created_at
      FROM billing_entries b LEFT JOIN requests r ON r.id=b.request_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY b.created_at DESC,b.id ASC LIMIT ?`, parameters).all();
    const rows = result.rows.slice(0, limit);
    const items = rows.map(row => {
      if (!validId(row.id) || !integer(row.created_at) || row.currency !== 'USD' || !['consumption', 'adjustment', 'grant'].includes(row.kind)) throw new ApiError('service_unavailable');
      const deltaUnits = parseUnits(row.delta_units).toString();
      if (row.source !== null && row.source !== 'api' && row.source !== 'web_chat') throw new ApiError('service_unavailable');
      return Object.freeze({ id: row.id, operationId: row.operation_id, kind: row.kind, userId: row.user_id, requestId: row.request_id,
        modelId: row.model_id, source: row.source, currency: 'USD' as const, deltaUnits, createdBy: row.created_by,
        reason: row.reason, createdAt: row.created_at });
    });
    const last = rows.at(-1);
    const nextCursor = result.rows.length > limit && last ? encode([2, binding[1], actor, binding[3], binding[4], binding[5], binding[6], binding[7], watermark, last.created_at, last.id]) : null;
    return { items, nextCursor, ...(summary === undefined ? {} : { summary }) };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('service_unavailable', { cause: error });
  }
}
