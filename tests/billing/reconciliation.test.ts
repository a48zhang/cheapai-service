import { beforeEach, describe, expect, it } from 'vitest';
import { reconcileBalances, reconcileUserBalance } from '../../apps/worker/billing/reconciliation';
import { adjustBalance } from '../../apps/worker/billing/adjustments';
import { testEnv } from '../helpers/database';

const actor = 'b19-admin', user = 'b19-user', other = 'b19-other';
const adjust = (operationId: string, deltaUnits: string, userId = user) => adjustBalance(testEnv.DB,
  { kind: 'adjustment', operationId, userId, deltaUnits, reason: 'Reconciliation fixture' }, actor, 1000);
beforeEach(async () => {
  await testEnv.DB.prepare("INSERT INTO groups(id,name,status,version,created_at,updated_at) VALUES('b19-group','B19','active',1,0,0)").run();
  for (const id of [actor, user, other]) {
    await testEnv.DB.prepare(`INSERT INTO users(id,email_normalized,password_hash,role,status,group_id,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
      VALUES(?,?,?,?,'active','b19-group',2,60,'bootstrap',0,0)`).bind(id, `${id}@example.invalid`, 'test-only-hash', id === actor ? 'admin' : 'user').run();
  }
});

describe('read-only native D1 ledger reconciliation', () => {
  it('matches initial zero and sums appended deltas including negative balances and replay', async () => {
    expect(await reconcileUserBalance(testEnv.DB, actor, user)).toMatchObject({ balanceUnits: '0', ledgerUnits: '0', differenceUnits: '0', entryCount: 0, matches: true });
    await adjust('b19-credit', '200'); await adjust('b19-debit', '-250'); await adjust('b19-debit', '-250');
    expect(await reconcileUserBalance(testEnv.DB, actor, user)).toEqual({ userId: user, currency: 'USD', balanceUnits: '-50', ledgerUnits: '-50',
      differenceUnits: '0', entryCount: 2, matches: true, negativeBalance: true });
  });
  it('locates a discrepancy without repairing user, ledger or audit records', async () => {
    await adjust('b19-credit', '100');
    await testEnv.DB.prepare('UPDATE users SET balance_units=999 WHERE id=?').bind(user).run();
    const ledger = await testEnv.DB.prepare('SELECT id,delta_units FROM billing_entries').all();
    const audit = await testEnv.DB.prepare('SELECT id FROM admin_audit').all();
    expect(await reconcileUserBalance(testEnv.DB, actor, user)).toMatchObject({ balanceUnits: '999', ledgerUnits: '100', differenceUnits: '899', matches: false, negativeBalance: false });
    expect(await testEnv.DB.prepare('SELECT balance_units FROM users WHERE id=?').bind(user).first('balance_units')).toBe(999);
    expect((await testEnv.DB.prepare('SELECT id,delta_units FROM billing_entries').all()).results).toEqual(ledger.results);
    expect((await testEnv.DB.prepare('SELECT id FROM admin_audit').all()).results).toEqual(audit.results);
  });
  it('preserves aggregate values beyond JS safe integer as exact strings', async () => {
    const maximum = String(Number.MAX_SAFE_INTEGER);
    await adjust('b19-large-first', maximum);
    // Deliberate fixture drift permits a second safe entry without violating the
    // account-column guard; reconciliation must discover the exact large sum.
    await testEnv.DB.prepare('UPDATE users SET balance_units=0 WHERE id=?').bind(user).run();
    await adjust('b19-large-second', maximum);
    expect(await reconcileUserBalance(testEnv.DB, actor, user)).toMatchObject({ balanceUnits: maximum,
      ledgerUnits: '18014398509481982', differenceUnits: '-9007199254740991', matches: false });
  });
  it('verifies native integer SUM precision up to signed 64-bit and rejects overflow rather than returning REAL', async () => {
    const sql = `WITH RECURSIVE entries(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM entries WHERE n<?)
      SELECT CAST(SUM(CAST(? AS INTEGER)) AS TEXT) AS total FROM entries`;
    expect(await testEnv.DB.prepare(sql).bind(1024, String(Number.MAX_SAFE_INTEGER)).first('total')).toBe('9223372036854774784');
    await expect(testEnv.DB.prepare(sql).bind(1025, String(Number.MAX_SAFE_INTEGER)).first('total')).rejects.toThrow('integer overflow');
  });
  it('does not report false discrepancies while atomic adjustments commit concurrently', async () => {
    const [result] = await Promise.all([
      reconcileUserBalance(testEnv.DB, actor, user), adjust('b19-racing-first', '5'), adjust('b19-racing-second', '-3'),
    ]);
    expect(result?.matches).toBe(true);
    expect(await reconcileUserBalance(testEnv.DB, actor, user)).toMatchObject({ balanceUnits: '2', ledgerUnits: '2', matches: true });
  });
  it('paginates all users without exposing credentials or omitting negative/mismatched accounts', async () => {
    await adjust('b19-negative', '-5');
    await testEnv.DB.prepare('UPDATE users SET balance_units=3 WHERE id=?').bind(other).run();
    const first = await reconcileBalances(testEnv.DB, actor, { limit: 2 });
    const second = await reconcileBalances(testEnv.DB, actor, { limit: 2, cursor: first.nextCursor! });
    const items = [...first.items, ...second.items];
    expect(items.map(item => item.userId)).toEqual([actor, other, user]); expect(second.nextCursor).toBeNull();
    expect(items.find(item => item.userId === other)?.matches).toBe(false);
    expect(items.find(item => item.userId === user)?.negativeBalance).toBe(true);
    expect(JSON.stringify(items)).not.toMatch(/password|hash|email/);
  });
  it('requires a trusted current administrator and validates cursor/limits', async () => {
    await expect(reconcileBalances(testEnv.DB, user)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(reconcileUserBalance(testEnv.DB, user, actor)).rejects.toMatchObject({ code: 'forbidden' });
    expect(await reconcileUserBalance(testEnv.DB, actor, 'missing')).toBeNull();
    for (const limit of [0, 1.5, 101]) await expect(reconcileBalances(testEnv.DB, actor, { limit })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(reconcileBalances(testEnv.DB, actor, { cursor: 'invalid!' })).rejects.toMatchObject({ code: 'invalid_request' });
    await testEnv.DB.prepare('UPDATE groups SET status=? WHERE id=?').bind('disabled', 'b19-group').run();
    await expect(reconcileBalances(testEnv.DB, actor)).rejects.toMatchObject({ code: 'forbidden' });
  });
});
