import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_BILLING_ENTRIES_PATH, BILLING_ENTRIES_PATH, createBillingEntryRoutes } from '../../apps/worker/billing/entry-routes';
import type { BillingEntriesResponse } from '../../apps/worker/billing/entry-routes';
import { createCookieSession } from '../../apps/worker/auth/sessions';
import { testEnv } from '../helpers/database';

const now = 5000;
let ownerCookie: string;
let otherCookie: string;
let adminCookie: string;
const app = () => createBillingEntryRoutes({ now: () => now });
function get(query = '', cookie = ownerCookie, method = 'GET') {
  return app().request(`https://local.test${BILLING_ENTRIES_PATH}${query}`, { method, headers: { Cookie: cookie,
    Origin: 'https://irrelevant.example', 'X-User-Id': 'b10-other', 'X-Request-Id': 'untrusted-request-id' } }, { DB: testEnv.DB });
}
async function body(response: Response) { return await response.json() as { data: BillingEntriesResponse; request_id: string }; }
beforeEach(async () => {
  await testEnv.DB.prepare("INSERT INTO groups(id,name,status,version,created_at,updated_at) VALUES('b10-group','Fixture','active',1,0,0)").run();
  for (const id of ['b10-owner', 'b10-other', 'b10-admin']) await testEnv.DB.prepare(`INSERT INTO users(id,email_normalized,password_hash,role,status,group_id,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
    VALUES(?,?,'PRIVATE_PASSWORD_HASH',?,'active','b10-group',1,60,'admin',0,0)`).bind(id, `${id}@example.invalid`, id === 'b10-admin' ? 'admin' : 'user').run();
  ownerCookie = (await createCookieSession(testEnv.DB, 'b10-owner', 1000, { sessionTtlMs: 60000 })).setCookie.split(';')[0]!;
  otherCookie = (await createCookieSession(testEnv.DB, 'b10-other', 1000, { sessionTtlMs: 60000 })).setCookie.split(';')[0]!;
  adminCookie = (await createCookieSession(testEnv.DB, 'b10-admin', 1000, { sessionTtlMs: 60000 })).setCookie.split(';')[0]!;
  for (const [id, owner, kind, delta] of [['entry-a', 'b10-owner', 'grant', 10], ['entry-b', 'b10-owner', 'adjustment', -20], ['foreign-entry', 'b10-other', 'grant', 1]] as const) {
    await testEnv.DB.prepare(`INSERT INTO billing_entries(id,operation_id,kind,user_id,currency,delta_units,fingerprint,reason,created_at)
      VALUES(?,?,?,?,'USD',?,'PRIVATE_FINGERPRINT','Synthetic reason',2000)`).bind(id, `op-${id}`, kind, owner, delta).run();
  }
});

describe('B10-A administrator billing GET', () => {
  it('combines owner/kind/time filters and binds their values into the cursor', async () => {
    const query = '?userId=b10-owner&createdFrom=2000&createdBefore=2001&limit=1';
    const first = await body(await adminGet(query));
    expect(first.data.items).toHaveLength(1);
    const next = await body(await adminGet(`${query}&cursor=${first.data.nextCursor}`));
    expect(next.data.items[0]?.id).toBe('entry-b');
    expect((await adminGet(`${query.replace('createdFrom=2000', 'createdFrom=0')}&cursor=${first.data.nextCursor}`)).status).toBe(400);
    expect((await body(await adminGet('?kind=grant&createdBefore=2000'))).data.items).toEqual([]);
    expect((await adminGet('?status=failed')).status).toBe(200);
    expect((await adminGet('?createdBefore=2&createdBefore=3')).status).toBe(400);
  });
  function adminGet(query = '', cookie = adminCookie, method = 'GET') {
    return app().request(`https://local.test${ADMIN_BILLING_ENTRIES_PATH}${query}`, { method,
      headers: { Cookie: cookie, 'X-Role': 'admin', 'X-Actor-Id': 'b10-admin' } }, { DB: testEnv.DB });
  }

  it('requires current admin context before parsing filters and rejects later demotion', async () => {
    expect((await app().request(`https://local.test${ADMIN_BILLING_ENTRIES_PATH}?unknown=1`, {}, { DB: testEnv.DB })).status).toBe(401);
    const ordinary = await adminGet('?unknown=1', ownerCookie); expect(ordinary.status).toBe(403); expect(ordinary.headers.get('Cache-Control')).toBe('no-store');
    expect((await adminGet()).status).toBe(200);
    await testEnv.DB.prepare("UPDATE users SET role='user' WHERE id='b10-admin'").run();
    expect((await adminGet()).status).toBe(403);
  });

  it('returns global or filtered ledger summaries with safe amount/time types', async () => {
    const all = await adminGet(); expect(all.headers.get('Cache-Control')).toBe('no-store');
    const payload = await body(all); expect(payload.data.items).toHaveLength(3);
    expect(payload.data.summary).toBeUndefined();
    expect(payload.data.items.every(item => typeof item.deltaUnits === 'string' && typeof item.createdAt === 'string')).toBe(true);
    expect(JSON.stringify(payload)).not.toMatch(/PRIVATE_|usage_snapshot|price_snapshot/);
    const filtered = await body(await adminGet('?userId=b10-other&kind=grant'));
    expect(filtered.data.items.map(item => item.id)).toEqual(['foreign-entry']);
    expect((await body(await adminGet('?requestId=missing'))).data.items).toEqual([]);
  });

  it('binds pagination to admin scope and filters instead of accepting an owner cursor', async () => {
    const first = await body(await adminGet('?limit=1'));
    const second = await body(await adminGet(`?limit=1&cursor=${first.data.nextCursor}`));
    expect(second.data.items[0]?.id).not.toBe(first.data.items[0]?.id);
    expect((await adminGet(`?userId=b10-other&cursor=${first.data.nextCursor}`)).status).toBe(400);
    const owner = await body(await get('?limit=1'));
    expect((await adminGet(`?cursor=${owner.data.nextCursor}`)).status).toBe(400);
    for (const query of ['?userId=a&userId=b', '?kind=x', '?userId=', '?cursor=bad']) expect((await adminGet(query)).status).toBe(400);
  });

  it('does not register ledger mutation methods even for an administrator', async () => {
    const before = (await testEnv.DB.prepare('SELECT * FROM billing_entries ORDER BY id').all()).results;
    for (const method of ['POST', 'PATCH', 'DELETE']) {
      const response = await adminGet('', adminCookie, method); expect(response.status).toBe(404); expect(response.headers.get('Cache-Control')).toBe('no-store');
    }
    expect((await testEnv.DB.prepare('SELECT * FROM billing_entries ORDER BY id').all()).results).toEqual(before);
  });
});

describe('B10 owner billing GET', () => {
  it('supports exact [createdFrom,createdBefore) timestamps and ignores unsupported filter metadata', async () => {
    const bounded = await body(await get('?createdFrom=2000&createdBefore=2001'));
    expect(bounded.data.items).toHaveLength(2);
    expect(bounded.data.summary).toEqual({
      currency: 'USD',
      consumptionUnits: '0',
      createdFrom: 2000,
      createdBefore: 2001,
    });
    expect((await body(await get('?createdBefore=2000'))).data.items).toEqual([]);
    expect((await body(await get('?createdFrom=2001'))).data.items).toEqual([]);
    expect((await get('?status=succeeded')).status).toBe(200);
    for (const query of ['?createdFrom=', '?createdFrom=01', '?createdFrom=-1', '?createdBefore=1.5', '?createdFrom=1e3', '?createdFrom=%2B1',
      '?createdFrom=0%0A', '?createdFrom=%201', '?createdFrom=2026-01-01', '?createdBefore=8640000000000001', '?createdFrom=2001&createdBefore=2000', '?createdFrom=1&createdFrom=2'])
      expect((await get(query)).status).toBe(400);
  });
  it('uses only session ownership, string units, ISO timestamps and safe list metadata', async () => {
    const result = await get(); expect(result.status).toBe(200); expect(result.headers.get('Cache-Control')).toBe('no-store');
    const payload = await body(result);
    expect(payload.data.items.map(item => item.id)).toEqual(['entry-a', 'entry-b']);
    expect(payload.data.items[1]).toMatchObject({ userId: 'b10-owner', deltaUnits: '-20', currency: 'USD', createdAt: '1970-01-01T00:00:02.000Z' });
    expect(payload.request_id).not.toBe('untrusted-request-id');
    expect(JSON.stringify(payload)).not.toMatch(/foreign-entry|PRIVATE_|usage_snapshot|price_snapshot|token_hash/);
  });

  it('accepts valid pagination/kind filters and rejects cross-owner cursors', async () => {
    const first = await body(await get('?limit=1'));
    const second = await body(await get(`?limit=1&cursor=${first.data.nextCursor}`));
    expect(second.data.items.map(item => item.id)).toEqual(['entry-b']);
    expect((await get(`?cursor=${first.data.nextCursor}`, otherCookie)).status).toBe(400);
    expect((await body(await get('?kind=grant'))).data.items.map(item => item.id)).toEqual(['entry-a']);
    expect((await body(await get('?requestId=missing'))).data.items).toEqual([]);
  });

  it('does not broaden the personal path for administrators or consult Origin configuration', async () => {
    expect((await body(await get('', adminCookie))).data.items).toEqual([]);
    const getter = vi.fn(() => { throw new Error('Must not read Origin config'); });
    const options = Object.defineProperty({ now: () => now }, 'trustedOrigin', { get: getter });
    const result = await createBillingEntryRoutes(options).request(`https://local.test${BILLING_ENTRIES_PATH}`, { headers: { Cookie: ownerCookie } }, { DB: testEnv.DB });
    expect(result.status).toBe(200); expect(getter).not.toHaveBeenCalled();
  });

  it('authenticates before query validation and rechecks current session eligibility', async () => {
    expect((await app().request(`https://local.test${BILLING_ENTRIES_PATH}?userId=other`, {}, { DB: testEnv.DB })).status).toBe(401);
    await testEnv.DB.prepare("UPDATE users SET status='disabled' WHERE id='b10-owner'").run();
    const result = await get(); expect(result.status).toBe(401); expect(result.headers.get('Cache-Control')).toBe('no-store');
  });

  it('rejects ambiguous or malformed supported filters', async () => {
    for (const query of ['?userId=b10-other', '?kind=grant&kind=adjustment', '?requestId=a&requestId=b', '?limit=1&limit=2', '?limit=1.5', '?limit=101', '?cursor=', '?kind=']) {
      const result = await get(query); expect(result.status).toBe(400); expect(result.headers.get('Cache-Control')).toBe('no-store');
    }
  });

  it('offers no mutation endpoint and leaves the ledger unchanged', async () => {
    const before = (await testEnv.DB.prepare('SELECT * FROM billing_entries ORDER BY id').all()).results;
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const result = await get('', ownerCookie, method); expect(result.status).toBe(404); expect(result.headers.get('Cache-Control')).toBe('no-store');
    }
    expect((await testEnv.DB.prepare('SELECT * FROM billing_entries ORDER BY id').all()).results).toEqual(before);
  });

  it('fails closed on database errors or out-of-range response timestamps', async () => {
    const unavailable = { prepare() { throw new Error('PRIVATE DB ERROR'); } } as unknown as D1Database;
    const failed = await app().request(`https://local.test${BILLING_ENTRIES_PATH}`, { headers: { Cookie: ownerCookie } }, { DB: unavailable });
    expect(failed.status).toBe(503); expect(await failed.text()).not.toContain('PRIVATE');
    await testEnv.DB.prepare(`INSERT INTO billing_entries(id,operation_id,kind,user_id,currency,delta_units,fingerprint,reason,created_at)
      VALUES('too-late','too-late','grant','b10-owner','USD',1,'opaque','Synthetic',?)`).bind(Number.MAX_SAFE_INTEGER).run();
    expect((await get()).status).toBe(503);
  });
});
