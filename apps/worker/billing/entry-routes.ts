import { Hono } from 'hono';
import { requireSession } from '../auth/middleware';
import type { AuthEnv } from '../auth/middleware';
import { requireAdmin } from '../auth/roles';
import { ApiError, apiError, apiSuccess, createRequestId, parsePagination } from '../http';
import { queryBillingEntries, MAX_LEDGER_TIME_MS } from './entry-queries';
import type { BillingEntrySummary, EntryQueryOptions, BillingEntryPage } from './entry-queries';

export const BILLING_ENTRIES_PATH = '/api/v1/billing/entries';
export const ADMIN_BILLING_ENTRIES_PATH = '/api/v1/admin/billing/entries';
export type BillingEntryItem = Omit<BillingEntrySummary, 'createdAt'> & { readonly createdAt: string };
export interface BillingEntriesResponse {
  readonly items: readonly BillingEntryItem[];
  readonly nextCursor: string | null;
  readonly summary?: BillingEntryPage['summary'];
}
const noStore = (response: Response): Response => { response.headers.set('Cache-Control', 'no-store'); return response; };

function queryOptions(request: Request, admin = false): EntryQueryOptions {
  if (request.body !== null) throw new ApiError('invalid_request');
  const query = new URL(request.url).searchParams;
  for (const key of query.keys()) if (query.getAll(key).length !== 1) throw new ApiError('invalid_request');
  const page = parsePagination(query);
  const kind = query.get('kind');
  const requestId = query.get('requestId');
  const userId = query.get('userId');
  if (!admin && userId !== null) throw new ApiError('invalid_request');
  const times: { createdFrom?: number; createdBefore?: number } = {};
  for (const key of ['createdFrom', 'createdBefore'] as const) {
    const raw = query.get(key);
    if (raw === null) continue;
    if (raw.length > 16 || raw.trim() !== raw || !/^(?:0|[1-9][0-9]*)$/.test(raw)) throw new ApiError('invalid_request');
    const milliseconds = Number(raw);
    if (!Number.isSafeInteger(milliseconds) || milliseconds > MAX_LEDGER_TIME_MS) throw new ApiError('invalid_request');
    times[key] = milliseconds;
  }
  if (kind !== null && kind !== 'consumption' && kind !== 'grant' && kind !== 'adjustment') throw new ApiError('invalid_request');
  return { limit: page.limit, ...(page.cursor === null ? {} : { cursor: page.cursor }), ...(kind === null ? {} : { kind }),
    ...(requestId === null ? {} : { requestId }), ...(userId === null ? {} : { userId }), ...times };
}
function responsePage(page: BillingEntryPage): BillingEntriesResponse {
  return { nextCursor: page.nextCursor, ...(page.summary === undefined ? {} : { summary: page.summary }), items: page.items.map(item => {
    if (!Number.isSafeInteger(item.createdAt) || item.createdAt < 0 || item.createdAt > 8_640_000_000_000_000) throw new ApiError('service_unavailable');
    return { ...item, createdAt: new Date(item.createdAt).toISOString() };
  }) };
}

/** Full-path read-only router; no Origin resolver, CSRF write policy or mutation route. */
export function createBillingEntryRoutes(options: { now?: () => number } = {}): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  const clock = options.now ?? Date.now;
  app.use('*', async (context, next) => { await next(); context.res.headers.set('Cache-Control', 'no-store'); });
  app.onError((error, context) => noStore(apiError(error instanceof ApiError ? error : new ApiError('service_unavailable', { cause: error }), context.get('requestId') ?? createRequestId())));
  app.notFound(context => noStore(apiError(new ApiError('not_found'), context.get('requestId') ?? createRequestId())));
  app.get(BILLING_ENTRIES_PATH, requireSession(clock), async context => {
    const page = await queryBillingEntries(context.env.DB, { kind: 'owner', userId: context.get('user').id }, queryOptions(context.req.raw));
    return noStore(apiSuccess(responsePage(page), context.get('requestId')));
  });
  app.get(ADMIN_BILLING_ENTRIES_PATH, requireSession(clock), requireAdmin, async context => {
    const page = await queryBillingEntries(context.env.DB, { kind: 'admin', actorId: context.get('user').id }, queryOptions(context.req.raw, true));
    return noStore(apiSuccess(responsePage(page), context.get('requestId')));
  });
  return app;
}
