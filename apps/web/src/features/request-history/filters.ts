import { billingStatusSchema, executionStatusSchema } from '@cheapai/contracts/requests';
import type { AdminRequestQuery, RequestQuery } from '@cheapai/contracts/requests';

export type RequestFilterScope = 'personal' | 'admin';
export type RequestFilters = Omit<RequestQuery, 'cursor'> & Pick<AdminRequestQuery, 'userId'>;

export interface RequestListUrlState {
  readonly filters: RequestFilters;
  readonly cursor: string | null;
}

const MAX_TIMESTAMP = 8_640_000_000_000_000;
const validId = (value: string): boolean => value.length > 0 && value.length <= 128
  && value.trim() === value && /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/u.test(value);

function searchParams(search: string | URLSearchParams): URLSearchParams {
  if (search instanceof URLSearchParams) return new URLSearchParams(search);
  return new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
}

function single(params: URLSearchParams, key: string): string | null {
  const values = params.getAll(key);
  return values.length === 1 ? values[0] ?? null : null;
}

function timestamp(value: string | null): number | undefined {
  if (value === null || !/^(?:0|[1-9][0-9]*)$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= MAX_TIMESTAMP ? parsed : undefined;
}

function copyFilters(filters: RequestFilters, scope: RequestFilterScope): RequestFilters {
  const from = typeof filters.from === 'number' && Number.isSafeInteger(filters.from) && filters.from >= 0 && filters.from <= MAX_TIMESTAMP
    ? filters.from : undefined;
  const to = typeof filters.to === 'number' && Number.isSafeInteger(filters.to) && filters.to >= 0 && filters.to <= MAX_TIMESTAMP
    ? filters.to : undefined;
  const validRange = from === undefined || to === undefined || from <= to;
  return {
    ...(validRange && from !== undefined ? { from } : {}),
    ...(validRange && to !== undefined ? { to } : {}),
    ...(filters.status !== undefined && executionStatusSchema.safeParse(filters.status).success ? { status: filters.status } : {}),
    ...(filters.billingStatus !== undefined && billingStatusSchema.safeParse(filters.billingStatus).success ? { billingStatus: filters.billingStatus } : {}),
    ...(filters.model !== undefined && validId(filters.model) ? { model: filters.model } : {}),
    ...(scope === 'admin' && filters.userId !== undefined && validId(filters.userId) ? { userId: filters.userId } : {}),
  };
}

export function parseRequestListUrl(search: string | URLSearchParams, scope: RequestFilterScope = 'personal'): RequestListUrlState {
  const params = searchParams(search);
  const from = timestamp(single(params, 'from'));
  const to = timestamp(single(params, 'to'));
  const status = executionStatusSchema.safeParse(single(params, 'status'));
  const billingStatus = billingStatusSchema.safeParse(single(params, 'billingStatus'));
  const model = single(params, 'model');
  const userId = scope === 'admin' ? single(params, 'userId') : null;
  const rawCursor = single(params, 'cursor');
  const filters = copyFilters({
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    ...(status.success ? { status: status.data } : {}),
    ...(billingStatus.success ? { billingStatus: billingStatus.data } : {}),
    ...(model !== null ? { model } : {}),
    ...(userId !== null ? { userId } : {}),
  }, scope);
  const cursor = rawCursor !== null && rawCursor.length <= 2048 && rawCursor.trim() === rawCursor && !/[\u0000-\u001f\u007f]/u.test(rawCursor)
    ? rawCursor : null;
  return { filters, cursor };
}

/** Serialize only backend-supported filters for the current scope and optional page cursor. */
export function serializeRequestListUrl(filters: RequestFilters, cursor: string | null, scope: RequestFilterScope = 'personal'): string {
  const normalized = copyFilters(filters, scope);
  const params = new URLSearchParams();
  if (normalized.from !== undefined) params.set('from', String(normalized.from));
  if (normalized.to !== undefined) params.set('to', String(normalized.to));
  if (normalized.status !== undefined) params.set('status', normalized.status);
  if (normalized.billingStatus !== undefined) params.set('billingStatus', normalized.billingStatus);
  if (normalized.model !== undefined) params.set('model', normalized.model);
  if (normalized.userId !== undefined) params.set('userId', normalized.userId);
  if (cursor !== null && cursor.length <= 2048 && cursor.trim() === cursor && !/[\u0000-\u001f\u007f]/u.test(cursor)) params.set('cursor', cursor);
  return params.toString();
}

/** Applying new filters always starts at the first page, dropping the old cursor. */
export function serializeRequestFilters(filters: RequestFilters, scope: RequestFilterScope = 'personal'): string {
  return serializeRequestListUrl(filters, null, scope);
}
