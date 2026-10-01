import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAdminBalanceRoutes, BALANCE_BODY_MAX_BYTES } from '../../apps/worker/admin/balance-routes';
import { createCookieSession } from '../../apps/worker/auth/sessions';
import { issueCsrfToken } from '../../apps/worker/auth/csrf';
import { testEnv } from '../helpers/database';

const now = 5000;
const origin = 'https://local.test';
const path = `${origin}/api/v1/admin/users/b08-user/balance-adjustments`;
let adminCookie: string;
let userCookie: string;
const content = { kind: 'grant', deltaUnits: '100', reason: 'Synthetic grant' };
function headers(cookie = adminCookie, key = 'fixture-operation'): Headers {
  const csrf = issueCsrfToken();
  return new Headers({ Cookie: `${cookie}; ${csrf.setCookie.split(';')[0]}`, Origin: origin, 'X-CSRF-Token': csrf.token,
    'Content-Type': 'application/json', 'Idempotency-Key': key });
}
const app = () => createAdminBalanceRoutes({ database: testEnv.DB, now: () => now, trustedOrigin: async () => origin });
const request = (value: unknown = content, supplied = headers()) => app().request(path, { method: 'POST', headers: supplied, body: JSON.stringify(value) }, { DB: testEnv.DB });
beforeEach(async () => {
  await testEnv.DB.prepare("INSERT INTO groups(id,name,status,version,created_at,updated_at) VALUES('b08-group','Fixture','active',1,0,0)").run();
  for (const [id, role] of [['b08-admin', 'admin'], ['b08-user', 'user']]) await testEnv.DB.prepare(`INSERT INTO users(id,email_normalized,password_hash,role,status,group_id,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
    VALUES(?,?,'synthetic',?,'active','b08-group',1,60,'admin',0,0)`).bind(id, `${id}@example.invalid`, role).run();
  adminCookie = (await createCookieSession(testEnv.DB, 'b08-admin', 1000, { sessionTtlMs: 60000 })).setCookie.split(';')[0]!;
  userCookie = (await createCookieSession(testEnv.DB, 'b08-user', 1000, { sessionTtlMs: 60000 })).setCookie.split(';')[0]!;
});

describe('B08 administrator balance writes', () => {
  it('authenticates before reading lazy Origin or malformed write input', async () => {
    const getter = vi.fn(() => { throw new Error('PRIVATE origin config'); });
    const deps = Object.defineProperty({ database: testEnv.DB, now: () => now }, 'trustedOrigin', { get: getter });
    const router = createAdminBalanceRoutes(deps);
    const anonymous = await router.request(path, { method: 'POST', body: 'bad' }, { DB: testEnv.DB });
    const user = await router.request(path, { method: 'POST', headers: { Cookie: userCookie }, body: 'bad' }, { DB: testEnv.DB });
    expect(anonymous.status).toBe(401); expect(user.status).toBe(403); expect(getter).not.toHaveBeenCalled();
    expect(anonymous.headers.get('Cache-Control')).toBe('no-store'); expect(user.headers.get('Cache-Control')).toBe('no-store');
    const admin = await router.request(path, { method: 'POST', headers: { Cookie: adminCookie } }, { DB: testEnv.DB });
    expect(admin.status).toBe(503); expect(await admin.text()).not.toContain('PRIVATE');
  });

  it('creates, replays and rejects conflicts using the header key and trusted session actor', async () => {
    const first = await request(); expect(first.status).toBe(201);
    expect(first.headers.get('Cache-Control')).toBe('no-store');
    const firstBody = await first.json() as { data: { entry: { id: string; createdBy: string; deltaUnits: string } } };
    expect(firstBody.data.entry).toMatchObject({ createdBy: 'b08-admin', deltaUnits: '100' });
    const replay = await request(); expect(replay.status).toBe(200);
    expect((await replay.json() as typeof firstBody).data.entry.id).toBe(firstBody.data.entry.id);
    const conflict = await request({ ...content, deltaUnits: '101' }); expect(conflict.status).toBe(409);
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM billing_entries').first('n')).toBe(1);
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM admin_audit').first('n')).toBe(1);
  });

  it('supports signed adjustments resulting in negative balance', async () => {
    expect((await request({ kind: 'adjustment', deltaUnits: '-50', reason: 'Synthetic correction' })).status).toBe(201);
    expect(await testEnv.DB.prepare("SELECT balance_units FROM users WHERE id='b08-user'").first('balance_units')).toBe(-50);
  });

  it('rejects absent/duplicate idempotency keys and failed CSRF', async () => {
    const absent = headers(); absent.delete('Idempotency-Key'); expect((await request(content, absent)).status).toBe(400);
    const duplicate = headers(); duplicate.append('Idempotency-Key', 'other'); expect((await request(content, duplicate)).status).toBe(400);
    const foreign = headers(); foreign.set('Origin', 'https://evil.test'); expect((await request(content, foreign)).status).toBe(403);
    const missing = headers(); missing.delete('X-CSRF-Token'); expect((await request(content, missing)).status).toBe(403);
  });

  it('requires string units and reason and disallows actor/recipient/fingerprint body overrides', async () => {
    for (const patch of [{ deltaUnits: 100 }, { deltaUnits: '1.1' }, { deltaUnits: '9007199254740992' }, { reason: '' },
      { kind: 'consumption' }, { userId: 'b08-admin' }, { createdBy: 'b08-admin' }, { fingerprint: 'forged' }, { operationId: 'forged' }]) {
      const result = await request({ ...content, ...patch }); expect(result.status).toBe(400); expect(result.headers.get('Cache-Control')).toBe('no-store');
    }
  });

  it('enforces actual streamed bytes even with a lying Content-Length', async () => {
    const supplied = headers(); supplied.set('Content-Length', '1');
    const bytes = new TextEncoder().encode(JSON.stringify({ ...content, reason: 'x'.repeat(BALANCE_BODY_MAX_BYTES) }));
    const response = await app().request(new Request(path, { method: 'POST', headers: supplied,
      body: new ReadableStream({ start(controller) { controller.enqueue(bytes.slice(0, 100)); controller.enqueue(bytes.slice(100)); controller.close(); } }) }), undefined, { DB: testEnv.DB });
    expect(response.status).toBe(413); expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('rejects malformed UTF-8 and rolls back the adjustment when audit fails', async () => {
    const bad = await app().request(path, { method: 'POST', headers: headers(), body: new Uint8Array([0xff]) }, { DB: testEnv.DB });
    expect(bad.status).toBe(400);
    await testEnv.DB.exec("CREATE TRIGGER b08_fail_audit BEFORE INSERT ON admin_audit BEGIN SELECT RAISE(ABORT,'synthetic'); END;");
    const failed = await request(); expect(failed.status).toBe(503); expect(failed.headers.get('Cache-Control')).toBe('no-store');
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM billing_entries').first('n')).toBe(0);
    expect(await testEnv.DB.prepare("SELECT balance_units FROM users WHERE id='b08-user'").first('balance_units')).toBe(0);
  });
});
