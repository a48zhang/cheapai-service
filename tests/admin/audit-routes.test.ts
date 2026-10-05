import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuditRoutes, ADMIN_AUDIT_PATH } from '../../apps/worker/admin/audit-routes';
import { buildAuditStatement } from '../../apps/worker/admin/audit';
import { createCookieSession } from '../../apps/worker/auth/sessions';
import { testEnv } from '../helpers/database';

const admin = 'o02-admin', other = 'o02-other-admin', user = 'o02-user';
const cookies = new Map<string, string>();
function request(query = '', actor = admin, now = 10000) {
  return createAuditRoutes({ now: () => now }).request('https://console.example' + ADMIN_AUDIT_PATH + query,
    { headers: { Cookie: cookies.get(actor) ?? '', 'X-Actor-Id': admin } }, { DB: testEnv.DB });
}
async function audit(id: string, actorId = admin, time = 5000) {
  await buildAuditStatement(testEnv.DB, { id, actor_id: actorId, action: 'group.update', target_type: 'group', target_id: 'default',
    operation_id: 'o02-operation', created_at: time, changes: { status: { before: 'active', after: 'disabled' } } }).run();
}
beforeEach(async () => {
  cookies.clear();
  await testEnv.DB.prepare("INSERT INTO groups(id,name,status,version,created_at,updated_at) VALUES('o02-group','O02 Group','active',1,0,0)").run();
  for (const id of [admin, other, user]) {
    await testEnv.DB.prepare(`INSERT INTO users(id,email_normalized,password_hash,role,status,group_id,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
      VALUES(?,?,?,?,'active','o02-group',2,60,'bootstrap',0,0)`).bind(id, `${id}@example.invalid`, 'PRIVATE PASSWORD HASH', id === user ? 'user' : 'admin').run();
    cookies.set(id, (await createCookieSession(testEnv.DB, id, 1000)).setCookie.split(';')[0]!);
  }
  await audit('o02-a'); await audit('o02-b'); await audit('o02-c'); await audit('o02-other', other);
});

describe('administrator audit queries on native D1', () => {
  it('requires a real active administrator and never accepts a query actor as authorization', async () => {
    expect((await request('', 'missing')).status).toBe(401);
    const rejected = await request('?actorId=' + admin, user); expect(rejected.status).toBe(403); expect(rejected.headers.get('Cache-Control')).toBe('no-store');
    const allowed = await request('', other); expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({ data: { items: expect.any(Array) } });
  });
  it('returns caller-selected business changes without another field allowlist', async () => {
    const changes = { before: { status: 'active' }, billing_multiplier_changed: true };
    await testEnv.DB.prepare('UPDATE admin_audit SET redacted_change_json=? WHERE id=?')
      .bind(JSON.stringify(changes), 'o02-a').run();
    const response = await request('?actorId=' + admin);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const data = (await response.json<{ data: { items: { id: string; changes: unknown }[] } }>()).data;
    expect(data.items.find(row => row.id === 'o02-a')!.changes).toEqual(changes);
    expect(data.items).toHaveLength(3);
  });
  it('returns large grant changes instead of silently replacing them with null', async () => {
    const changes = { allowed_group_ids: Array.from({ length: 150 }, (_, i) => `group-${i}-${'a'.repeat(80)}`) };
    await testEnv.DB.prepare('UPDATE admin_audit SET redacted_change_json=? WHERE id=?').bind(JSON.stringify(changes), 'o02-a').run();
    expect(await (await request()).json()).toMatchObject({ data: { items: expect.arrayContaining([
      expect.objectContaining({ id: 'o02-a', changes, redaction_valid: true }),
    ]) } });
  });
  it('filters actor/time/action/target/operation and rejects invalid queries', async () => {
    const filtered = await request(`?actorId=${other}&from=5000&to=5000&action=group.update&targetType=group&targetId=default&operationId=o02-operation`);
    expect(await filtered.json()).toMatchObject({ data: { items: [{ id: 'o02-other' }] } });
    for (const query of ['from=-1', 'from=1%0A', 'to=1.5', 'from=2&to=1', 'limit=101', 'limit=1&limit=2', 'cursor=', 'actorId=', "targetId='%20OR%201=1", 'action=BadAction']) {
      expect((await request('?' + query)).status, query).toBe(400);
    }
  });
  it('paginates timestamp ties with filter/actor binding and a fixed creation ceiling', async () => {
    const first = await (await request(`?actorId=${admin}&limit=2`)).json<{ data: { items: { id: string }[]; nextCursor: string } }>();
    await audit('o02-new', admin, 10001);
    const second = await (await request(`?actorId=${admin}&limit=2&cursor=${first.data.nextCursor}`, admin, 10002)).json<{ data: { items: { id: string }[]; nextCursor: null } }>();
    expect([...first.data.items, ...second.data.items].map(row => row.id)).toEqual(['o02-c', 'o02-b', 'o02-a']); expect(second.data.nextCursor).toBeNull();
    expect((await request(`?actorId=${admin}&cursor=${first.data.nextCursor}`, other)).status).toBe(400);
    expect((await request(`?actorId=${other}&cursor=${first.data.nextCursor}`)).status).toBe(400);
  });
  it('does not access Secret/Origin configuration on reads', async () => {
    const getter = vi.fn(() => { throw new Error('PRIVATE SECRET'); });
    const bindings = Object.defineProperty({ DB: testEnv.DB }, 'EMAIL_HMAC_KEY', { enumerable: true, get: getter });
    const response = await createAuditRoutes({ now: () => 10000 }).request('https://console.example' + ADMIN_AUDIT_PATH,
      { headers: { Cookie: cookies.get(admin)! } }, bindings);
    expect(response.status).toBe(200); expect(getter).not.toHaveBeenCalled();
  });
});
