import { beforeEach, describe, expect, it } from 'vitest';
import { queryBillingEntries } from '../../apps/worker/billing/entry-queries';
import type { EntryQueryOptions } from '../../apps/worker/billing/entry-queries';
import { testEnv } from '../helpers/database';

async function entry(id: string, userId: string, time: number, kind = 'adjustment', delta = -1) {
  await testEnv.DB.prepare(`INSERT INTO billing_entries(id,operation_id,kind,user_id,currency,delta_units,fingerprint,created_by,reason,created_at)
    VALUES(?,?,?,?,'USD',?,?,'b09-admin','Synthetic reason',?)`).bind(id, `op-${id}`, kind, userId, delta, `fingerprint-${id}`, time).run();
}
beforeEach(async () => {
  await testEnv.DB.prepare("INSERT INTO groups(id,name,status,version,created_at,updated_at) VALUES('b09-group','Fixture','active',1,0,0)").run();
  for (const id of ['b09-admin', 'b09-admin-two', 'b09-owner', 'b09-other']) await testEnv.DB.prepare(`INSERT INTO users(id,email_normalized,password_hash,role,status,group_id,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
    VALUES(?,?,'synthetic',?,'active','b09-group',1,60,'admin',0,0)`).bind(id, `${id}@example.invalid`, id.includes('admin') ? 'admin' : 'user').run();
  await entry('entry-c', 'b09-owner', 2000);
  await entry('entry-a', 'b09-owner', 2000, 'grant', 2);
  await entry('entry-b', 'b09-owner', 2000);
  await entry('entry-old', 'b09-owner', 1000);
  await entry('foreign-entry', 'b09-other', 3000, 'grant', 1);
});

describe('B09 scoped append-only ledger pagination', () => {
  it('applies inclusive/exclusive UTC millisecond bounds independently for owner and admin', async () => {
    const owner = { kind: 'owner' as const, userId: 'b09-owner' };
    expect((await queryBillingEntries(testEnv.DB, owner, { createdFrom: 1000, createdBefore: 2000 })).items.map(item => item.id)).toEqual(['entry-old']);
    expect((await queryBillingEntries(testEnv.DB, owner, { createdFrom: 2000 })).items.map(item => item.id)).toEqual(['entry-a', 'entry-b', 'entry-c']);
    expect((await queryBillingEntries(testEnv.DB, owner, { createdBefore: 2000 })).items.map(item => item.id)).toEqual(['entry-old']);
    expect((await queryBillingEntries(testEnv.DB, owner, { createdFrom: 2000, createdBefore: 2000 })).items).toEqual([]);
    expect((await queryBillingEntries(testEnv.DB, { kind: 'admin', actorId: 'b09-admin' }, { createdFrom: 3000, createdBefore: 3001 })).items.map(item => item.id)).toEqual(['foreign-entry']);
  });

  it('binds both time filters and the append-only watermark into version 2 cursors', async () => {
    const scope = { kind: 'owner' as const, userId: 'b09-owner' };
    const filters = { createdFrom: 1000, createdBefore: 3000 };
    const first = await queryBillingEntries(testEnv.DB, scope, { ...filters, limit: 1 });
    await entry('late-filtered', 'b09-owner', 1500);
    const next = await queryBillingEntries(testEnv.DB, scope, { ...filters, cursor: first.nextCursor! });
    expect(next.items.map(item => item.id)).toEqual(['entry-b', 'entry-c', 'entry-old']);
    for (const altered of [{ createdFrom: 0, createdBefore: 3000 }, { createdFrom: 1000, createdBefore: 4000 }, {}])
      await expect(queryBillingEntries(testEnv.DB, scope, { ...altered, cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('rejects unsafe, nonnumeric, null and reversed time intervals', async () => {
    for (const filters of [{ createdFrom: -1 }, { createdBefore: 1.5 }, { createdFrom: '1000' }, { createdBefore: null },
      { createdFrom: NaN }, { createdBefore: Infinity }, { createdFrom: Number.MAX_SAFE_INTEGER }, { createdFrom: 3000, createdBefore: 2000 }])
      await expect(queryBillingEntries(testEnv.DB, { kind: 'owner', userId: 'b09-owner' }, filters as unknown as EntryQueryOptions)).rejects.toMatchObject({ code: 'invalid_request' });
  });
  it('uses deterministic DESC timestamp / ASC id order without exposing another owner', async () => {
    const first = await queryBillingEntries(testEnv.DB, { kind: 'owner', userId: 'b09-owner' }, { limit: 2 });
    expect(first.items.map(item => item.id)).toEqual(['entry-a', 'entry-b']);
    expect(first.nextCursor).not.toBeNull();
    const second = await queryBillingEntries(testEnv.DB, { kind: 'owner', userId: 'b09-owner' }, { limit: 2, cursor: first.nextCursor! });
    expect(second.items.map(item => item.id)).toEqual(['entry-c', 'entry-old']);
    expect(second.nextCursor).toBeNull();
    expect([...first.items, ...second.items].every(item => item.userId === 'b09-owner')).toBe(true);
    expect(JSON.stringify([first, second])).not.toContain('foreign-entry');
    expect(Object.keys(first.items[0]!)).not.toEqual(expect.arrayContaining(['fingerprint', 'usage_snapshot', 'price_snapshot']));
  });

  it('keeps an existing page sequence stable even after a backdated append', async () => {
    const first = await queryBillingEntries(testEnv.DB, { kind: 'owner', userId: 'b09-owner' }, { limit: 2 });
    await entry('entry-late', 'b09-owner', 1500);
    const second = await queryBillingEntries(testEnv.DB, { kind: 'owner', userId: 'b09-owner' }, { limit: 10, cursor: first.nextCursor! });
    expect(second.items.map(item => item.id)).toEqual(['entry-c', 'entry-old']);
    expect((await queryBillingEntries(testEnv.DB, { kind: 'owner', userId: 'b09-owner' })).items.map(item => item.id)).toContain('entry-late');
  });

  it('binds cursors to owner, admin actor and filters', async () => {
    const owner = await queryBillingEntries(testEnv.DB, { kind: 'owner', userId: 'b09-owner' }, { limit: 1 });
    await expect(queryBillingEntries(testEnv.DB, { kind: 'owner', userId: 'b09-other' }, { cursor: owner.nextCursor! })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(queryBillingEntries(testEnv.DB, { kind: 'owner', userId: 'b09-owner' }, { cursor: owner.nextCursor!, kind: 'grant' })).rejects.toMatchObject({ code: 'invalid_request' });
    const admin = await queryBillingEntries(testEnv.DB, { kind: 'admin', actorId: 'b09-admin' }, { limit: 1 });
    await expect(queryBillingEntries(testEnv.DB, { kind: 'admin', actorId: 'b09-admin-two' }, { cursor: admin.nextCursor! })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(queryBillingEntries(testEnv.DB, { kind: 'admin', actorId: 'b09-admin' }, { cursor: owner.nextCursor! })).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('enforces current administrator privilege and safe optional owner/kind/request filters', async () => {
    await expect(queryBillingEntries(testEnv.DB, { kind: 'admin', actorId: 'b09-owner' })).rejects.toMatchObject({ code: 'forbidden' });
    const all = await queryBillingEntries(testEnv.DB, { kind: 'admin', actorId: 'b09-admin' }); expect(all.items).toHaveLength(5);
    const filtered = await queryBillingEntries(testEnv.DB, { kind: 'admin', actorId: 'b09-admin' }, { userId: 'b09-owner', kind: 'grant' });
    expect(filtered.items.map(item => item.id)).toEqual(['entry-a']);
    expect((await queryBillingEntries(testEnv.DB, { kind: 'admin', actorId: 'b09-admin' }, { requestId: 'no-request' })).items).toEqual([]);
    await testEnv.DB.prepare("UPDATE users SET status='disabled' WHERE id='b09-admin'").run();
    await expect(queryBillingEntries(testEnv.DB, { kind: 'admin', actorId: 'b09-admin' })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('returns exact signed units strings including the safe integer maximum', async () => {
    await testEnv.DB.prepare("UPDATE users SET balance_units=0 WHERE id='b09-other'").run();
    await entry('maximum', 'b09-other', 4000, 'grant', Number.MAX_SAFE_INTEGER);
    const result = await queryBillingEntries(testEnv.DB, { kind: 'owner', userId: 'b09-other' });
    expect(result.items[0]).toMatchObject({ deltaUnits: '9007199254740991', currency: 'USD' });
    expect((await queryBillingEntries(testEnv.DB, { kind: 'owner', userId: 'b09-owner' })).items.find(item => item.id === 'entry-b')?.deltaUnits).toBe('-1');
  });

  it('rejects owner overrides, malformed filters and invalid pagination', async () => {
    for (const options of [{ userId: 'b09-other' }, { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: null },
      { kind: 'unknown' }, { cursor: 'not-json' }, { cursor: '!' }, { cursor: null }, { requestId: "x' OR 1=1--" }, { unknown: true }]) {
      await expect(queryBillingEntries(testEnv.DB, { kind: 'owner', userId: 'b09-owner' }, options as unknown as EntryQueryOptions)).rejects.toMatchObject({ code: 'invalid_request' });
    }
  });

  it('uses the owner pagination index and fails closed on database errors', async () => {
    const plan = await testEnv.DB.prepare('EXPLAIN QUERY PLAN SELECT id FROM billing_entries WHERE user_id=? AND rowid<=? ORDER BY created_at DESC,id ASC LIMIT ?').bind('b09-owner', 100, 20).all<{ detail: string }>();
    expect(plan.results.some(row => row.detail.includes('idx_billing_entries_user_created_id'))).toBe(true);
    const unavailable = { prepare() { throw new Error('Synthetic DB error'); } } as unknown as D1Database;
    await expect(queryBillingEntries(unavailable, { kind: 'owner', userId: 'b09-owner' })).rejects.toMatchObject({ code: 'service_unavailable' });
  });
});
