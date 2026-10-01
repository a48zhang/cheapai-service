import { batch, prepare } from '../db';
import { ApiError } from '../http';

export interface BalanceReconciliation {
  userId: string;
  currency: 'USD';
  balanceUnits: string;
  ledgerUnits: string;
  differenceUnits: string;
  entryCount: number;
  matches: boolean;
  negativeBalance: boolean;
}
interface Row { user_id: string; balance_units: string; ledger_units: string; entry_count: number }
function id(value: unknown): value is string { return typeof value === 'string' && value.trim() === value && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(value); }
function encode(actor: string, last: string): string { return btoa(JSON.stringify([1, actor, last])).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''); }
function view(row: Row): BalanceReconciliation {
  if (!/^(0|-?[1-9][0-9]*)$/.test(row.balance_units) || !/^(0|-?[1-9][0-9]*)$/.test(row.ledger_units)
    || !Number.isSafeInteger(row.entry_count) || row.entry_count < 0) throw new ApiError('service_unavailable');
  const balance = BigInt(row.balance_units); const sum = BigInt(row.ledger_units); const difference = balance - sum;
  return { userId: row.user_id, currency: 'USD', balanceUnits: row.balance_units, ledgerUnits: row.ledger_units,
    differenceUnits: difference.toString(), entryCount: row.entry_count, matches: difference === 0n, negativeBalance: balance < 0n };
}

async function read(database: D1Database, actorId: string, limit: number, after: string | null, userId: string | null) {
  if (!id(actorId)) throw new ApiError('invalid_request');
  try {
    // One read-only transaction authenticates the actor and compares balances
    // with the SAME database snapshot as its aggregate, avoiding false drift
    // from a settlement committing between two independent application reads.
    const result = await batch(database, [
      prepare(database, `SELECT CASE WHEN EXISTS(SELECT 1 FROM users u JOIN groups g ON g.id=u.group_id
        WHERE u.id=? AND u.role='admin' AND u.status='active' AND g.status='active') THEN 1
        ELSE json_extract('{}','reconciliation_actor_forbidden') END`, [actorId]),
      prepare<Row>(database, `WITH page AS (
        SELECT id,balance_units FROM users WHERE (? IS NULL OR id>?) AND (? IS NULL OR id=?) ORDER BY id LIMIT ?
      ) SELECT p.id AS user_id,CAST(p.balance_units AS TEXT) AS balance_units,
        CAST(COALESCE(SUM(b.delta_units),0) AS TEXT) AS ledger_units,COUNT(b.id) AS entry_count
        FROM page p LEFT JOIN billing_entries b ON b.user_id=p.id
        GROUP BY p.id,p.balance_units ORDER BY p.id`, [after, after, userId, userId, limit]),
    ] as const);
    return result[1].rows.map(view);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    for (let cause = error, depth = 0; cause instanceof Error && depth < 4; cause = cause.cause, depth++) {
      if (cause.message.includes('reconciliation_actor_forbidden')) throw new ApiError('forbidden');
    }
    // SQLite integer SUM overflow fails the page, never falls back to floating
    // TOTAL() or reports a rounded/partial sum as a successful reconciliation.
    throw new ApiError('service_unavailable');
  }
}

/** Read-only full ledger comparison for one user; a nonzero opening balance
 * without matching ledger entries is intentionally reported as a discrepancy.
 */
export async function reconcileUserBalance(database: D1Database, trustedAdminId: string, userId: string): Promise<BalanceReconciliation | null> {
  if (!id(userId)) throw new ApiError('invalid_request');
  return (await read(database, trustedAdminId, 1, null, userId))[0] ?? null;
}

/** Bounded user pages, but each selected user's ledger is summed in full.
 * Every page is a current consistent read; separate pages are not one global
 * historical snapshot. No balance repair, ledger rewrite, audit write or network.
 */
export async function reconcileBalances(database: D1Database, trustedAdminId: string, options: { limit?: number; cursor?: string } = {}): Promise<{
  items: BalanceReconciliation[]; nextCursor: string | null;
}> {
  const limit = options.limit ?? 50;
  if (!id(trustedAdminId) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new ApiError('invalid_request');
  let after: string | null = null;
  if (options.cursor !== undefined) {
    try {
      if (typeof options.cursor !== 'string' || options.cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(options.cursor)) throw new Error();
      const value: unknown = JSON.parse(atob(options.cursor.replaceAll('-', '+').replaceAll('_', '/')));
      if (!Array.isArray(value) || value.length !== 3 || value[0] !== 1 || value[1] !== trustedAdminId || !id(value[2])
        || encode(trustedAdminId, value[2]) !== options.cursor) throw new Error();
      after = value[2];
    } catch { throw new ApiError('invalid_request'); }
  }
  const rows = await read(database, trustedAdminId, limit + 1, after, null);
  const items = rows.slice(0, limit); const last = items.at(-1);
  return { items, nextCursor: rows.length > limit && last ? encode(trustedAdminId, last.userId) : null };
}
