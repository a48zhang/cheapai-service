import { Hono } from '../../apps/worker/node_modules/hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_USERS_PATH, ADMIN_USER_BODY_MAX_BYTES, createAdminUserRoutes } from '../../apps/worker/admin/user-routes';
import type { AdminUserListItem } from '../../apps/worker/admin/user-routes';
import { createCookieSession } from '../../apps/worker/auth/sessions';
import { issueCsrfToken, CSRF_HEADER_NAME } from '../../apps/worker/auth/csrf';
import * as passwords from '../../apps/worker/auth/password';
import { prepare } from '../../apps/worker/db';
import { testEnv } from '../helpers/database';

const now = 1_788_631_000_123;
const admin = 'a22-admin';
const admin2 = 'a22-admin-other';
const group = 'a22-users';
const secret = 'a22-SECRET-PASSWORD-HASH';
const cookies = new Map<string, string>();

it('reads Origin only after write authentication and never for GET', async () => {
  const getter = vi.fn(() => { throw new Error('PRIVATE ORIGIN'); });
  const dependencies = Object.defineProperty({ database: testEnv.DB, now: () => now }, 'trustedOrigin', { get: getter });
  const app = createAdminUserRoutes(dependencies);
  expect((await request(app)).status).toBe(200);
  for (const [method, suffix] of [['POST', ''], ['PATCH', '/a22-user-b']]) {
    expect((await app.request(`https://local.test${ADMIN_USERS_PATH}${suffix}`, { method }, { DB: testEnv.DB })).status).toBe(401);
    expect((await app.request(`https://local.test${ADMIN_USERS_PATH}${suffix}`, { method, headers: { Cookie: cookies.get('user')! } }, { DB: testEnv.DB })).status).toBe(403);
  }
  expect(getter).not.toHaveBeenCalled();
  const invalid = await request(app, '', cookies.get(admin), 'POST');
  expect(invalid.status).toBe(503); expect(await invalid.text()).not.toContain('PRIVATE');
  const csrf = issueCsrfToken();
  const lazy = createAdminUserRoutes({ database: testEnv.DB, now: () => now, trustedOrigin: async () => 'https://local.test' });
  const response = await lazy.request(`https://local.test${ADMIN_USERS_PATH}/a22-user-b`, { method: 'PATCH',
    headers: { Cookie: `${cookies.get(admin)}; ${csrf.setCookie.split(';')[0]}`, Origin: 'https://local.test',
      'X-CSRF-Token': csrf.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ version: 1, rpmLimit: 30 }) }, { DB: testEnv.DB });
  expect(response.status).toBe(200);
});
function appAt(time = now) { return createAdminUserRoutes({ database: testEnv.DB, now: () => time }); }
function request(app: ReturnType<typeof appAt>, query = '', cookie = cookies.get(admin), method = 'GET') {
  return app.request(`https://local.test${ADMIN_USERS_PATH}${query}`, { method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), 'X-Actor-Id': admin, 'X-Request-Id': 'client-id' } }, { DB: testEnv.DB });
}
async function insertUser(id: string, groupId = group, status = 'active', createdAt = now, role = 'user', balance = 0) {
  await prepare(testEnv.DB, `INSERT INTO users (id,email_normalized,password_hash,role,status,group_id,balance_units,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,2,60,'bootstrap',?,?)`, [id, `${id}@example.invalid`, secret, role, status, groupId, balance, createdAt, createdAt]).run();
}
async function body(response: Response): Promise<{ data: { items: AdminUserListItem[]; nextCursor: string | null; snapshotAt: number }; request_id: string }> {
  return await response.json() as never;
}

beforeEach(async () => {
  cookies.clear();
  for (const id of [group, 'a22-admin-group']) {
    await prepare(testEnv.DB, 'INSERT INTO groups (id,name,status,version,created_at,updated_at) VALUES (?,?,?,1,?,?)', [id, id, 'active', now, now]).run();
  }
  for (const id of [admin, admin2]) {
    await insertUser(id, 'a22-admin-group', 'active', now - 1, 'admin');
    cookies.set(id, (await createCookieSession(testEnv.DB, id, now, { sessionTtlMs: 60_000 })).setCookie.split(';')[0]!);
  }
  await insertUser('a22-user-a', group, 'active', now, 'user', -9007199254740991);
  await insertUser('a22-user-b');
  await insertUser('a22-user-c', group, 'disabled');
  cookies.set('user', (await createCookieSession(testEnv.DB, 'a22-user-a', now, { sessionTtlMs: 60_000 })).setCookie.split(';')[0]!);
});

describe('administrator user list HTTP with native D1', () => {
  it('returns an explicit public projection including negative balance as a string', async () => {
    const response = await request(appAt(), `?groupId=${group}`);
    expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('no-store');
    const text = await response.text();
    expect(text).not.toContain(secret); expect(text).not.toMatch(/password|token_hash|code_hash|registration_code_id/);
    const result = JSON.parse(text);
    expect(result.data.items).toHaveLength(3);
    expect(result.data.items.find((row: AdminUserListItem) => row.id === 'a22-user-a')).toEqual({
      id: 'a22-user-a', email_normalized: 'a22-user-a@example.invalid', role: 'user', status: 'active',
      allowed_group_ids: [group], group_id: group, group_name: group, group_status: 'active', balance_units: '-9007199254740991',
      concurrency_limit: 2, rpm_limit: 60, email_verified_at: null, created_at: now, updated_at: now, version: 1,
    });
    expect(result.request_id).not.toBe('client-id');
  });

  it('combines status/group filters and allows administrators to view users in other groups', async () => {
    const result = await body(await request(appAt(), `?groupId=${group}&status=disabled`, cookies.get(admin2)));
    expect(result.data.items.map((row) => row.id)).toEqual(['a22-user-c']);
    expect((await body(await request(appAt(), '?groupId=missing'))).data.items).toEqual([]);
    expect((await body(await request(appAt(), '?status=active'))).data.items).toHaveLength(4);
  });

  it('requires a session and administrator role regardless of supplied actor headers', async () => {
    const missing = await request(appAt(), '', '');
    expect(missing.status).toBe(401); expect(missing.headers.get('Cache-Control')).toBe('no-store');
    const ordinary = await request(appAt(), '', cookies.get('user'));
    expect(ordinary.status).toBe(403); expect(ordinary.headers.get('Cache-Control')).toBe('no-store');
    await prepare(testEnv.DB, 'UPDATE users SET status=? WHERE id=?', ['disabled', admin]).run();
    expect((await request(appAt())).status).toBe(401);
  });

  it('paginates timestamp ties without duplicates and excludes users created after the first page', async () => {
    const first = await body(await request(appAt(), `?groupId=${group}&limit=2`));
    await insertUser('a22-new-user', group, 'active', now + 1);
    const second = await body(await request(appAt(now + 2), `?groupId=${group}&limit=2&cursor=${first.data.nextCursor}`));
    expect([...first.data.items, ...second.data.items].map((row) => row.id)).toEqual(['a22-user-c', 'a22-user-b', 'a22-user-a']);
    expect(second.data.snapshotAt).toBe(now); expect(second.data.nextCursor).toBeNull();
  });

  it('binds cursors to actor and exact filters', async () => {
    const first = await body(await request(appAt(), `?groupId=${group}&limit=1`));
    for (const query of [`?cursor=${first.data.nextCursor}`, `?groupId=${group}&status=active&cursor=${first.data.nextCursor}`, `?groupId=a22-admin-group&cursor=${first.data.nextCursor}`]) {
      expect((await request(appAt(), query)).status).toBe(400);
    }
    expect((await request(appAt(), `?groupId=${group}&cursor=${first.data.nextCursor}`, cookies.get(admin2))).status).toBe(400);
  });

  it('rejects malformed/duplicate/unknown parameters including attempted SQL injection', async () => {
    for (const query of ['?limit=0', '?limit=101', '?limit=02', '?limit=1&limit=2', '?cursor=', '?cursor=a&cursor=b',
      '?status=', '?status=enabled', '?status=active&status=disabled', '?groupId=', '?groupId=a&groupId=b',
      '?groupId=%27%20OR%201%3D1--', '?actorId=a22-admin', '?role=admin', '?cursor=invalid!']) {
      const response = await request(appAt(), query);
      expect(response.status, query).toBe(400); expect(response.headers.get('Cache-Control')).toBe('no-store');
    }
  });

  it('defaults to 20 items and accepts the maximum page size 100', async () => {
    for (let index = 0; index < 20; index++) await insertUser(`a22-page-${String(index).padStart(2, '0')}`);
    const defaultPage = await body(await request(appAt()));
    expect(defaultPage.data.items).toHaveLength(20); expect(defaultPage.data.nextCursor).not.toBeNull();
    expect((await body(await request(appAt(), '?limit=100'))).data.items).toHaveLength(25);
  });

  it('resolves dependencies lazily and uses a trusted request ID for sanitized errors', async () => {
    const resolve = vi.fn(() => { throw new Error('SECRET DATABASE DETAILS'); });
    const routes = createAdminUserRoutes(resolve); expect(resolve).not.toHaveBeenCalled();
    const app = new Hono<{ Variables: { requestId: string } }>();
    app.use('*', async (context, next) => { context.set('requestId', 'server-id'); await next(); });
    app.route('/', routes);
    const response = await app.request(`https://local.test${ADMIN_USERS_PATH}`, {}, { DB: testEnv.DB });
    expect(response.status).toBe(503); expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: { code: 'service_unavailable', message: 'Service temporarily unavailable.' }, request_id: 'server-id' });
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('keeps GET available without origin config and requires a target ID for PATCH', async () => {
    expect((await request(appAt())).status).toBe(200);
    expect((await request(appAt(), '', cookies.get(admin), 'PATCH')).status).toBe(404);
  });
});

describe('administrator user PATCH HTTP', () => {
  const origin = 'https://local.test';
  let csrf: ReturnType<typeof issueCsrfToken>;
  beforeEach(() => { csrf = issueCsrfToken(); });
  function headers(asUser = admin) {
    return { 'Content-Type': 'application/json', Origin: origin,
      Cookie: `${cookies.get(asUser) ?? ''}; ${csrf.setCookie.split(';')[0]}`, [CSRF_HEADER_NAME]: csrf.token };
  }
  function patch(input: unknown, options: { id?: string; headers?: Record<string, string>; body?: BodyInit; query?: string } = {}) {
    const app = createAdminUserRoutes({ database: testEnv.DB, now: () => now + 1, trustedOrigin: origin });
    return app.request(`${origin}${ADMIN_USERS_PATH}/${options.id ?? 'a22-user-b'}${options.query ?? ''}`, {
      method: 'PATCH', headers: options.headers ?? headers(), body: options.body ?? JSON.stringify(input),
    }, { DB: testEnv.DB });
  }

  it('updates approved fields with a versioned safe response and trusted-actor audit', async () => {
    const response = await patch({ version: 1, status: 'disabled', groupId: 'a22-admin-group', concurrencyLimit: 4, rpmLimit: 90 });
    expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('no-store');
    const text = await response.text(); expect(text).not.toContain(secret); expect(text).not.toContain('password_hash');
    expect(JSON.parse(text).data).toMatchObject({ id: 'a22-user-b', role: 'user', status: 'disabled', group_id: 'a22-admin-group',
      concurrency_limit: 4, rpm_limit: 90, balance_units: '0', version: 2 });
    const audit = await prepare(testEnv.DB, "SELECT actor_id FROM admin_audit WHERE target_id=? AND action='user.update'", ['a22-user-b']).first();
    expect(audit).toEqual({ actor_id: admin });
  });

  it('returns 409 for stale or concurrent versions without overwriting the winner', async () => {
    const responses = await Promise.all([patch({ version: 1, rpmLimit: 20 }), patch({ version: 1, rpmLimit: 30 })]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const winner = await prepare(testEnv.DB, 'SELECT rpm_limit,version FROM users WHERE id=?', ['a22-user-b']).first();
    const stale = await patch({ version: 1, rpmLimit: 40 });
    expect(stale.status).toBe(409); expect(stale.headers.get('Cache-Control')).toBe('no-store');
    expect(await prepare(testEnv.DB, 'SELECT rpm_limit,version FROM users WHERE id=?', ['a22-user-b']).first()).toEqual(winner);
    expect((await prepare(testEnv.DB, "SELECT id FROM admin_audit WHERE action='user.update'").all()).rows).toHaveLength(1);
  });

  it('enforces session/admin/Origin/CSRF and rejects privilege fields', async () => {
    expect((await patch({ version: 1, status: 'disabled' }, { headers: { ...headers(), Cookie: csrf.setCookie.split(';')[0]! } })).status).toBe(401);
    expect((await patch({ version: 1, status: 'disabled' }, { headers: headers('user') })).status).toBe(403);
    expect((await patch({ version: 1, status: 'disabled' }, { headers: { ...headers(), Origin: 'https://evil.invalid' } })).status).toBe(403);
    expect((await patch({ version: 1, status: 'disabled' }, { headers: { ...headers(), [CSRF_HEADER_NAME]: '' } })).status).toBe(403);
    for (const field of ['role', 'password', 'balance', 'balance_units', 'actorId', 'created_via']) {
      expect((await patch({ version: 1, [field]: 'admin' })).status).toBe(400);
    }
    expect((await prepare(testEnv.DB, "SELECT id FROM admin_audit WHERE action='user.update'").all()).rows).toEqual([]);
  });

  it('rejects missing/bad versions, invalid limits, inactive groups, query values and oversized bodies', async () => {
    for (const value of [null, [], {}, { version: 1 }, { version: 0, rpmLimit: 1 }, { version: '1', rpmLimit: 1 },
      { version: 1, rpmLimit: -1 }, { version: 1, groupId: 'missing' }]) expect((await patch(value)).status).toBe(400);
    await prepare(testEnv.DB, "INSERT INTO groups(id,name,status,version,created_at,updated_at) VALUES('inactive-target','Inactive target','disabled',1,0,0)").run();
    expect((await patch({ version: 1, groupId: 'inactive-target' })).status).toBe(400);
    expect((await patch({ version: 1, rpmLimit: 10 }, { query: '?actorId=other' })).status).toBe(400);
    expect((await patch({}, { body: 'x'.repeat(ADMIN_USER_BODY_MAX_BYTES + 1), headers: { ...headers(), 'Content-Length': '1' } })).status).toBe(413);
    expect((await patch({ version: 1, rpmLimit: 10 }, { id: 'missing' })).status).toBe(404);
  });

  it('protects the final active administrator through HTTP', async () => {
    await prepare(testEnv.DB, 'UPDATE users SET status=? WHERE id=?', ['disabled', admin2]).run();
    const response = await patch({ version: 1, status: 'disabled' }, { id: admin });
    expect(response.status).toBe(409);
    expect(await prepare(testEnv.DB, 'SELECT status FROM users WHERE id=?', [admin]).first()).toEqual({ status: 'active' });
  });

  it('returns safe 503 and rolls back the user change if audit storage fails', async () => {
    await testEnv.DB.exec("CREATE TRIGGER a24_fail_audit BEFORE INSERT ON admin_audit WHEN NEW.action='user.update' BEGIN SELECT RAISE(ABORT,'secret internal detail'); END");
    const response = await patch({ version: 1, rpmLimit: 10 });
    expect(response.status).toBe(503); expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.text()).not.toContain('secret internal detail');
    expect(await prepare(testEnv.DB, 'SELECT rpm_limit,version FROM users WHERE id=?', ['a22-user-b']).first()).toEqual({ rpm_limit: 60, version: 1 });
  });
});

describe('administrator user creation HTTP', () => {
  const origin = 'https://local.test';
  const password = 'a22-real-test-password-1234';
  let csrf: ReturnType<typeof issueCsrfToken>;
  beforeEach(() => {
    csrf = issueCsrfToken();
    vi.spyOn(passwords, 'hashPassword').mockResolvedValue('test-only-mocked-hash');
  });
  afterEach(() => vi.restoreAllMocks());
  function headers(asUser = admin) {
    return { 'Content-Type': 'application/json', Origin: origin,
      Cookie: `${cookies.get(asUser) ?? ''}; ${csrf.setCookie.split(';')[0]}`, [CSRF_HEADER_NAME]: csrf.token };
  }
  function post(input: unknown = { email: 'a22-created@example.invalid', password }, options: { headers?: Record<string, string>; body?: BodyInit; query?: string } = {}) {
    const app = createAdminUserRoutes({ database: testEnv.DB, now: () => now, trustedOrigin: origin });
    return app.request(`${origin}${ADMIN_USERS_PATH}${options.query ?? ''}`, {
      method: 'POST', headers: options.headers ?? headers(), body: options.body ?? JSON.stringify(input),
    }, { DB: testEnv.DB });
  }

  it('creates a real hashed, ordinary zero-balance user with safe 201 response and audit', async () => {
    vi.mocked(passwords.hashPassword).mockRestore();
    const response = await post();
    expect(response.status).toBe(201); expect(response.headers.get('Cache-Control')).toBe('no-store');
    const text = await response.text();
    expect(text).not.toContain(password); expect(text).not.toMatch(/password_hash|token_hash|\$argon2/);
    const result = JSON.parse(text);
    expect(result.data).toMatchObject({ email_normalized: 'a22-created@example.invalid', role: 'user', status: 'active', balance_units: '0', group_id: 'default' });
    const stored = await prepare<{ password_hash: string; created_via: string }>(testEnv.DB, 'SELECT password_hash,created_via FROM users WHERE id=?', [result.data.id]).first();
    expect(await passwords.verifyPassword(password, stored!.password_hash)).toBe(true);
    expect(stored!.created_via).toBe('admin');
    const audit = await prepare(testEnv.DB, 'SELECT actor_id,redacted_change_json FROM admin_audit WHERE target_id=?', [result.data.id]).first();
    expect(audit?.actor_id).toBe(admin); expect(JSON.stringify(audit)).not.toContain(password);
  });

  it('honors an explicit active group and returns duplicate email as 409', async () => {
    const input = { email: 'a22-explicit@example.invalid', password, groupId: group };
    const first = await post(input);
    expect(first.status).toBe(201);
    expect((await first.json() as { data: { group_id: string } }).data.group_id).toBe(group);
    const duplicate = await post(input);
    expect(duplicate.status).toBe(409); expect(duplicate.headers.get('Cache-Control')).toBe('no-store');
  });

  it('requires session, admin and matching origin/CSRF before processing body', async () => {
    expect((await post(undefined, { headers: { ...headers(), Cookie: csrf.setCookie.split(';')[0]! } })).status).toBe(401);
    expect((await post(undefined, { headers: headers('user') })).status).toBe(403);
    expect((await post(undefined, { headers: { ...headers(), Origin: 'https://evil.invalid' } })).status).toBe(403);
    expect((await post(undefined, { headers: { ...headers(), [CSRF_HEADER_NAME]: '' } })).status).toBe(403);
    expect((await post(undefined, { headers: { ...headers(), Origin: '' }, body: 'x'.repeat(ADMIN_USER_BODY_MAX_BYTES + 1) })).status).toBe(403);
    expect(passwords.hashPassword).not.toHaveBeenCalled();
  });

  it('rejects body/query privilege claims and malformed JSON before KDF', async () => {
    for (const field of ['role', 'balance', 'balance_units', 'created_via', 'source', 'actorId', 'actor_id', 'status']) {
      expect((await post({ email: 'a22-rejected@example.invalid', password, [field]: 'admin' })).status).toBe(400);
    }
    for (const input of [null, [], {}, { email: 'a22-bad@example.invalid', password: 'short' }]) expect((await post(input)).status).toBe(400);
    expect((await post(undefined, { body: '{bad' })).status).toBe(400);
    expect((await post(undefined, { query: '?actorId=a22-admin' })).status).toBe(400);
    expect((await post(undefined, { headers: { ...headers(), 'Content-Type': 'text/plain' } })).status).toBe(400);
    expect(passwords.hashPassword).not.toHaveBeenCalled();
  });

  it('limits actual streamed UTF-8 bytes despite a misleading Content-Length', async () => {
    const data = new TextEncoder().encode(JSON.stringify({ email: 'a22-large@example.invalid', password, extra: '界'.repeat(3000) }));
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(data.subarray(0, 4000)); controller.enqueue(data.subarray(4000)); controller.close();
    } });
    const response = await post(undefined, { headers: { ...headers(), 'Content-Length': '1' }, body: stream });
    expect(response.status).toBe(413); expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(passwords.hashPassword).not.toHaveBeenCalled();
  });

  it('maps Busy/KDF service failures to safe 503 with no user or password logging', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(passwords.hashPassword).mockRejectedValueOnce(new passwords.PasswordBusyError());
    let response = await post();
    expect(response.status).toBe(503); expect(response.headers.get('Cache-Control')).toBe('no-store');
    vi.mocked(passwords.hashPassword).mockRejectedValueOnce(new Error(password));
    response = await post();
    expect(response.status).toBe(503); expect(await response.text()).not.toContain(password);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(password);
    expect(await prepare(testEnv.DB, 'SELECT id FROM users WHERE email_normalized=?', ['a22-created@example.invalid']).first()).toBeNull();
  });

  it('requires trusted origin configuration only for POST', async () => {
    const app = appAt();
    expect((await request(app)).status).toBe(200);
    const response = await app.request(`${origin}${ADMIN_USERS_PATH}`, { method: 'POST', headers: headers(), body: JSON.stringify({ email: 'a22-config@example.invalid', password }) }, { DB: testEnv.DB });
    expect(response.status).toBe(503); expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
});
