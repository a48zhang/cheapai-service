import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../../apps/worker/app';
import {
  createDesktopSession,
  revokeDesktopSession,
} from '../../apps/worker/auth/desktop/session-repository';
import { createCookieSession } from '../../apps/worker/auth/sessions';
import { testEnv } from '../helpers/database';

const origin = 'https://console.example';
const env = () => ({ ...testEnv, ENVIRONMENT: 'local' as const, PUBLIC_BASE_URL: origin });
let issued: Awaited<ReturnType<typeof createDesktopSession>>;
const call = (path: string, method = 'GET', body?: unknown, token = issued.token) =>
  app.request(
    origin + path,
    {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': crypto.randomUUID(),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env(),
  );
beforeEach(async () => {
  const now = Date.now();
  await testEnv.DB.prepare(
    "INSERT INTO groups(id,name,status,version,created_at,updated_at) VALUES('console-group','Console','active',1,?,?)",
  )
    .bind(now, now)
    .run();
  for (const user of ['console-owner', 'console-other'])
    await testEnv.DB.prepare(
      `INSERT INTO users(id,email_normalized,password_hash,role,status,group_id,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
    VALUES(?,?,'test','admin','active','console-group',2,60,'admin',?,?)`,
    )
      .bind(user, `${user}@example.invalid`, now, now)
      .run();
  issued = await createDesktopSession(testEnv.DB, 'console-owner', now);
});
describe('native personal console authentication', () => {
  it('uses the desktop session for personal reads and explicit writes without a browser cookie', async () => {
    for (const path of [
      '/api/v1/auth/me',
      '/api/v1/account/balance',
      '/api/v1/account/key-groups',
      '/api/v1/keys',
      '/api/v1/billing/entries',
      '/api/v1/usage/requests',
      '/api/v1/images/models',
      '/api/v1/images/generations',
    ]) {
      const response = await call(path);
      expect(response.status, path).toBe(200);
      expect(await response.text()).not.toContain(issued.token);
    }
    const created = await call('/api/v1/keys', 'POST', {
      name: 'Desktop console key',
      groupId: 'console-group',
      expiresAt: null,
    });
    expect(created.status).toBe(201);
    expect((await call('/api/v1/images/generations', 'POST', {})).status).toBe(400);
  });
  it('rejects revoked sessions, other users resources and all admin operations', async () => {
    const created = await call('/api/v1/keys', 'POST', {
      name: 'Owner only',
      groupId: 'console-group',
      expiresAt: null,
    });
    const payload = await created.json<{ data: { key: { id: string } } }>();
    const other = await createDesktopSession(testEnv.DB, 'console-other', Date.now());
    expect(
      (await call(`/api/v1/keys/${payload.data.key.id}`, 'GET', undefined, other.token)).status,
    ).toBe(404);
    for (const path of ['/api/v1/admin/groups', '/api/v1/admin/users', '/api/v1/admin/channels'])
      expect((await call(path)).status).toBe(401);
    await revokeDesktopSession(testEnv.DB, issued.session.id, 'console-owner', Date.now());
    expect((await call('/api/v1/account/balance')).status).toBe(401);
  });
  it('does not waive CSRF for cookie sessions or a fabricated Authorization header', async () => {
    const cookie = (
      await createCookieSession(testEnv.DB, 'console-owner', Date.now())
    ).setCookie.split(';')[0]!;
    const body = JSON.stringify({ name: 'No CSRF', groupId: 'console-group', expiresAt: null });
    const response = await app.request(
      origin + '/api/v1/keys',
      { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body },
      env(),
    );
    expect(response.status).toBe(403);
    const spoofed = await app.request(
      origin + '/api/v1/keys',
      {
        method: 'POST',
        headers: {
          Cookie: cookie,
          Authorization: 'Bearer invalid',
          'Content-Type': 'application/json',
        },
        body,
      },
      env(),
    );
    expect(spoofed.status).toBe(403);
    const invalidDesktop = await app.request(
      origin + '/api/v1/keys',
      {
        method: 'POST',
        headers: {
          Cookie: cookie,
          Authorization: 'Bearer s2a_desktop_invalid',
          'Content-Type': 'application/json',
        },
        body,
      },
      env(),
    );
    expect(invalidDesktop.status).toBe(401);
  });
});
