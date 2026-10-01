import { Hono } from 'hono';
import { requireSession } from '../auth/middleware';
import type { AuthEnv } from '../auth/middleware';
import { prepare } from '../db';
import { ApiError, apiError, apiSuccess, createRequestId } from '../http';
import { formatUnitsToUsd, MONEY_CURRENCY, MONEY_DECIMALS, parseUnits } from './money';

export const ACCOUNT_BALANCE_PATH = '/api/v1/account/balance';
export interface AccountBalance {
  currency: typeof MONEY_CURRENCY;
  decimals: typeof MONEY_DECIMALS;
  balance_units: string;
  balance_usd: string;
}

/** Always read the current owner's authoritative D1 balance, never the KV soft
 * admission snapshot. Reading a negative balance is a valid account operation. */
export function createBalanceRoutes(options: { now?: () => number } = {}) {
  const app = new Hono<AuthEnv>();
  app.use('*', async (context, next) => {
    await next(); context.res.headers.set('Cache-Control', 'no-store');
  });
  app.onError((error, context) => {
    const response = apiError(error instanceof ApiError ? error : new ApiError('service_unavailable'), context.get('requestId') ?? createRequestId());
    response.headers.set('Cache-Control', 'no-store'); return response;
  });
  app.get(ACCOUNT_BALANCE_PATH, requireSession(options.now), async context => {
    // No identity/filter inputs: even an admin may only read their own balance.
    if (new URL(context.req.url).search !== '') throw new ApiError('invalid_request');
    const owner = context.get('user').id;
    const row = await prepare<{ balance_units: string }>(context.env.DB,
      `SELECT CAST(u.balance_units AS TEXT) AS balance_units FROM users u
       JOIN groups g ON g.id=u.group_id WHERE u.id=? AND u.status='active' AND g.status='active'`, [owner]).first();
    if (!row) throw new ApiError('unauthorized');
    const balance = parseUnits(row.balance_units);
    return apiSuccess<AccountBalance>({ currency: MONEY_CURRENCY, decimals: MONEY_DECIMALS,
      balance_units: balance.toString(), balance_usd: formatUnitsToUsd(balance) }, context.get('requestId'));
  });
  return app;
}
