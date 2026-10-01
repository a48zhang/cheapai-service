import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../../apps/worker/app';
import type { Env } from '../../apps/worker/env';
import { createCookieSession } from '../../apps/worker/auth/sessions';
import { buildAuditStatement } from '../../apps/worker/admin/audit';
import { testEnv } from '../helpers/database';

const origin = 'https://console.example';
const admin = 'o03-http-admin';
const other = 'o03-http-user';
let adminCookie: string;
let otherCookie: string;
const bindings = (): Env => ({ ...testEnv, ENVIRONMENT: 'local', PUBLIC_BASE_URL: origin });
function call(path: string, cookie?: string) {
  return app.fetch(new Request(origin + path, { headers: cookie === undefined ? {} : { Cookie: cookie } }), bindings());
}

beforeEach(async () => {
  const now = Date.now();
  await testEnv.DB.prepare("INSERT INTO groups(id,name,status,version,created_at,updated_at) VALUES('o03-http-group','O03','active',1,?,?)").bind(now, now).run();
  for (const [id, role] of [[admin, 'admin'], [other, 'user']] as const) {
    await testEnv.DB.prepare(`INSERT INTO users(id,email_normalized,password_hash,role,status,group_id,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
      VALUES(?,?, 'test-only',?,'active','o03-http-group',2,60,'bootstrap',?,?)`).bind(id, `${id}@example.invalid`, role, now, now).run();
  }
  adminCookie = (await createCookieSession(testEnv.DB, admin, now)).setCookie.split(';')[0]!;
  otherCookie = (await createCookieSession(testEnv.DB, other, now)).setCookie.split(';')[0]!;
  for (const id of ['o03-a', 'o03-b', 'o03-c']) {
    await buildAuditStatement(testEnv.DB, { id, actor_id: admin, action: 'request.inspect', target_type: 'request', target_id: id,
      operation_id: 'o03-operation', created_at: 1000, changes: { status: 'observed' } }).run();
  }
});

describe('O03 audit query through the Worker entry', () => {
  it('enforces admin scope and serves a stable page/cursor from real D1', async () => {
    expect((await call('/api/v1/admin/audit')).status).toBe(401);
    const denied = await call('/api/v1/admin/audit', otherCookie);
    expect(denied.status).toBe(403); expect(denied.headers.get('Cache-Control')).toBe('no-store');
    const first = await call('/api/v1/admin/audit?limit=2', adminCookie);
    expect(first.status).toBe(200); expect(first.headers.get('Cache-Control')).toBe('no-store');
    const page = await first.json<{ data: { items: { id: string }[]; nextCursor: string | null } }>();
    expect(page.data.items.map(item => item.id)).toEqual(['o03-c', 'o03-b']); expect(page.data.nextCursor).toBeTruthy();
    const second = await call(`/api/v1/admin/audit?limit=2&cursor=${page.data.nextCursor}`, adminCookie);
    expect(await second.json()).toMatchObject({ data: { items: [{ id: 'o03-a' }], nextCursor: null } });
  });
});
