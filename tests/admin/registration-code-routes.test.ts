import { Hono } from '../../apps/worker/node_modules/hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRegistrationCodeRoutes, REGISTRATION_CODES_PATH, REGISTRATION_CODE_CREATE_BODY_MAX_BYTES } from '../../apps/worker/admin/registration-code-routes';
import { issueCsrfToken } from '../../apps/worker/auth/csrf';
import { generateRegistrationCodes } from '../../apps/worker/auth/registration-codes';
import { createCookieSession } from '../../apps/worker/auth/sessions';
import { prepare } from '../../apps/worker/db';
import { testEnv } from '../helpers/database';

const now = 1_788_630_000_123;
const admin = 'a12-admin';
const otherAdmin = 'a12-other-admin';
const user = 'a12-user';
const cookies = new Map<string, string>();
let secrets: string[];

it('resolves write Origin only after auth and never reads it for GET', async () => {
  const getter = vi.fn(() => { throw new Error('PRIVATE ORIGIN'); });
  const dependencies = Object.defineProperty({ database: testEnv.DB, now: () => now }, 'trustedOrigin', { get: getter });
  const app = createRegistrationCodeRoutes(dependencies);
  expect((await request(app)).status).toBe(200);
  for (const suffix of ['', '/missing/revoke']) {
    expect((await app.request(`https://local.test${REGISTRATION_CODES_PATH}${suffix}`, { method: 'POST' }, { DB: testEnv.DB })).status).toBe(401);
    expect((await app.request(`https://local.test${REGISTRATION_CODES_PATH}${suffix}`, { method: 'POST', headers: { Cookie: cookies.get(user)! } }, { DB: testEnv.DB })).status).toBe(403);
  }
  expect(getter).not.toHaveBeenCalled();
  const response = await request(app, '', cookies.get(admin), 'POST');
  expect(response.status).toBe(503); expect(await response.text()).not.toContain('PRIVATE');
  const csrf = issueCsrfToken();
  const lazy = createRegistrationCodeRoutes({ database: testEnv.DB, now: () => now, trustedOrigin: async () => 'https://local.test' });
  const valid = await lazy.request(`https://local.test${REGISTRATION_CODES_PATH}`, { method: 'POST',
    headers: { Cookie: `${cookies.get(admin)}; ${csrf.setCookie.split(';')[0]}`, Origin: 'https://local.test', 'X-CSRF-Token': csrf.token,
      'Content-Type': 'application/json', 'Idempotency-Key': 'a12-lazy-operation' },
    body: JSON.stringify({ quantity: 1, expiresAt: now + 60_000 }) }, { DB: testEnv.DB });
  expect(valid.status).toBe(201);
});
function routeAt(time = now) { return createRegistrationCodeRoutes({ database: testEnv.DB, now: () => time }); }
function request(app: ReturnType<typeof routeAt>, query = '', cookie = cookies.get(admin), method = 'GET') {
  return app.request(`https://local.test${REGISTRATION_CODES_PATH}${query}`, { method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), 'X-Request-Id': 'client-id', 'X-Actor-Id': admin } }, { DB: testEnv.DB });
}

beforeEach(async () => {
  cookies.clear(); secrets = [];
  await prepare(testEnv.DB, 'INSERT INTO groups (id,name,status,version,created_at,updated_at) VALUES (?,?,?,1,?,?)',
    ['a12-group', 'A12 Group', 'active', now, now]).run();
  for (const id of [admin, otherAdmin, user]) {
    await prepare(testEnv.DB, `INSERT INTO users (id,email_normalized,password_hash,role,status,group_id,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
      VALUES (?,?,?,?,'active',?,2,60,'bootstrap',?,?)`, [id, `${id}@example.invalid`, 'test-only-hash', id === user ? 'user' : 'admin', 'a12-group', now, now]).run();
    cookies.set(id, (await createCookieSession(testEnv.DB, id, now, { sessionTtlMs: 60_000 })).setCookie.split(';')[0]!);
  }
  for (const actorId of [admin, otherAdmin]) {
    const issued = await generateRegistrationCodes(testEnv.DB, { actorId, operationId: 'a12-generate', quantity: 3, expiresAt: now + 60_000, now });
    if (!issued.replayed) secrets.push(...issued.codes.map((code) => code.token));
  }
});

describe('registration code list HTTP on native D1 and Hono', () => {
  it('serves the full mounted path to another administrator with metadata only', async () => {
    const response = await request(routeAt(), '', cookies.get(otherAdmin));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const text = await response.text();
    for (const secret of secrets) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/code_hash|token_hash|password_hash|fingerprint/);
    const body = JSON.parse(text);
    expect(body.data.items).toHaveLength(6);
    expect(new Set(body.data.items.map((item: { createdBy: string }) => item.createdBy))).toEqual(new Set([admin, otherAdmin]));
    expect(body.request_id).not.toBe('client-id');
  });

  it('requires session then role authorization and never trusts actor headers', async () => {
    const unauthenticated = await request(routeAt(), '', '');
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get('Cache-Control')).toBe('no-store');
    const forbidden = await request(routeAt(), '', cookies.get(user));
    expect(forbidden.status).toBe(403);
    expect(forbidden.headers.get('Cache-Control')).toBe('no-store');
    expect((await forbidden.json() as { error: { code: string } }).error.code).toBe('forbidden');
  });

  it('translates creatorFilter and cursor into a stable creator-filtered page', async () => {
    const first = await request(routeAt(), `?creatorFilter=${admin}&limit=2`);
    const firstBody = await first.json() as { data: { items: { id: string; createdBy: string }[]; nextCursor: string } };
    expect(firstBody.data.items).toHaveLength(2);
    expect(firstBody.data.items.every((item) => item.createdBy === admin)).toBe(true);
    const second = await request(routeAt(), `?creatorFilter=${admin}&limit=2&cursor=${firstBody.data.nextCursor}`);
    const secondBody = await second.json() as { data: { items: { id: string }[]; nextCursor: null } };
    expect(secondBody.data.items).toHaveLength(1);
    expect(secondBody.data.nextCursor).toBeNull();
    expect(new Set([...firstBody.data.items, ...secondBody.data.items].map((item) => item.id)).size).toBe(3);
    expect((await request(routeAt(), `?creatorFilter=${otherAdmin}&cursor=${firstBody.data.nextCursor}`)).status).toBe(400);
    expect((await request(routeAt(), `?creatorFilter=${admin}&cursor=${firstBody.data.nextCursor}`, cookies.get(otherAdmin))).status).toBe(400);
  });

  it('rejects duplicate, malformed and unknown query parameters', async () => {
    for (const query of ['?limit=0', '?limit=101', '?limit=02', '?limit=2&limit=3', '?cursor=', '?cursor=x&cursor=y',
      '?creatorFilter=', '?creatorFilter=a&creatorFilter=b', '?creatorFilter=%20admin', '?actorId=a12-admin', '?createdBy=a12-admin', '?cursor=invalid!']) {
      const response = await request(routeAt(), query);
      expect(response.status, query).toBe(400);
      expect(response.headers.get('Cache-Control'), query).toBe('no-store');
      expect((await response.json() as { error: { code: string } }).error.code).toBe('invalid_request');
    }
  });

  it('rechecks disabled/revoked/expired sessions and users for every request', async () => {
    expect((await request(routeAt(now + 60_000))).status).toBe(401);
    await prepare(testEnv.DB, 'UPDATE users SET status=? WHERE id=?', ['disabled', admin]).run();
    expect((await request(routeAt())).status).toBe(401);
    await prepare(testEnv.DB, 'UPDATE users SET status=? WHERE id=?', ['active', admin]).run();
    await prepare(testEnv.DB, 'UPDATE sessions SET revoked_at=? WHERE user_id=?', [now, admin]).run();
    expect((await request(routeAt())).status).toBe(401);
  });

  it('resolves DB and clock lazily per request and keeps original bindings unchanged', async () => {
    const clock = vi.fn(() => now);
    const source = vi.fn((_env: { DB: D1Database }, _request: Request) => ({ database: testEnv.DB, now: clock }));
    const app = createRegistrationCodeRoutes(source);
    expect(source).not.toHaveBeenCalled(); expect(clock).not.toHaveBeenCalled();
    const original = { DB: { prepare: () => { throw new Error('wrong database'); } } as unknown as D1Database };
    const originalDB = original.DB;
    const response = await app.request(`https://local.test${REGISTRATION_CODES_PATH}`, { headers: { Cookie: cookies.get(admin)! } }, original);
    expect(response.status).toBe(200);
    expect(source).toHaveBeenCalledTimes(1); expect(clock).toHaveBeenCalledTimes(1);
    expect(original.DB).toBe(originalDB);
  });

  it('uses trusted upstream request IDs and sanitizes dependency failures', async () => {
    const routes = createRegistrationCodeRoutes(() => { throw new Error('SECRET DATABASE DETAIL'); });
    const app = new Hono<{ Variables: { requestId: string } }>();
    app.use('*', async (context, next) => { context.set('requestId', 'server-id'); await next(); });
    app.route('/', routes);
    const response = await app.request(`https://local.test${REGISTRATION_CODES_PATH}`, {}, { DB: testEnv.DB });
    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: { code: 'service_unavailable', message: 'Service temporarily unavailable.' }, request_id: 'server-id' });
  });

  it('keeps DELETE absent and refuses generation without trusted origin configuration', async () => {
    const before = (await prepare(testEnv.DB, 'SELECT id FROM registration_codes').all()).rows;
    expect((await request(routeAt(), '', cookies.get(admin), 'POST')).status).toBe(503);
    expect((await request(routeAt(), '', cookies.get(admin), 'DELETE')).status).toBe(404);
    expect((await prepare(testEnv.DB, 'SELECT id FROM registration_codes').all()).rows).toEqual(before);
  });
});

describe('registration code revocation HTTP', () => {
  const origin = 'https://local.test';
  function mutation() { return createRegistrationCodeRoutes({ database: testEnv.DB, now: () => now, trustedOrigin: origin }); }
  function revokeHeaders(actor = admin) {
    const nonce = issueCsrfToken();
    return { Origin: origin, Cookie: `${cookies.get(actor)!}; ${nonce.setCookie.split(';')[0]}`,
      'X-CSRF-Token': nonce.token, 'Content-Type': 'application/json', 'X-Actor-Id': otherAdmin };
  }
  async function target() {
    const row = await prepare<{ id: string }>(testEnv.DB, 'SELECT id FROM registration_codes WHERE created_by=? ORDER BY id LIMIT 1', [otherAdmin]).first();
    return row!.id;
  }
  const url = (id: string) => `${origin}${REGISTRATION_CODES_PATH}/${id}/revoke`;
  async function revocationAudits() { return (await prepare(testEnv.DB, "SELECT * FROM admin_audit WHERE action='registration_codes.revoke'").all()).rows; }

  it('lets a site administrator revoke another creator code and replays without another audit', async () => {
    const id = await target();
    const app = mutation();
    const first = await app.request(url(id), { method: 'POST', headers: revokeHeaders() }, { DB: testEnv.DB });
    expect(first.status).toBe(200);
    expect(first.headers.get('Cache-Control')).toBe('no-store');
    expect(await first.json()).toMatchObject({ data: { id, status: 'revoked', revokedAt: now } });
    const replay = await app.request(url(id), { method: 'POST', headers: revokeHeaders(), body: '{}' }, { DB: testEnv.DB });
    expect(replay.status).toBe(200);
    const text = await replay.text();
    expect(JSON.parse(text)).toMatchObject({ data: { id, status: 'already_revoked', revokedAt: now } });
    for (const secret of secrets) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/code_hash|fingerprint|"token"/);
    const logs = await revocationAudits();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ actor_id: admin, target_id: id });
    expect(logs[0]?.operation_id).toMatch(/^[a-f0-9-]{36}$/);
  });

  it('returns conflict for a used code, 404 for a missing code and never restores either', async () => {
    const id = await target();
    await prepare(testEnv.DB, 'UPDATE registration_codes SET used_by=?,used_at=? WHERE id=?', [user, now, id]).run();
    const used = await mutation().request(url(id), { method: 'POST', headers: revokeHeaders() }, { DB: testEnv.DB });
    expect(used.status).toBe(409);
    expect(await used.json()).toMatchObject({ error: { code: 'conflict' } });
    expect((await prepare(testEnv.DB, 'SELECT used_by,used_at,revoked_at FROM registration_codes WHERE id=?', [id]).first())).toEqual({ used_by: user, used_at: now, revoked_at: null });
    const missing = await mutation().request(url('missing-code'), { method: 'POST', headers: revokeHeaders() }, { DB: testEnv.DB });
    expect(missing.status).toBe(404);
    expect(await revocationAudits()).toEqual([]);
  });

  it('enforces session/admin/CSRF and rejects mutation fields or malformed IDs', async () => {
    const id = await target();
    expect((await mutation().request(url(id), { method: 'POST' }, { DB: testEnv.DB })).status).toBe(401);
    expect((await mutation().request(url(id), { method: 'POST', headers: revokeHeaders(user) }, { DB: testEnv.DB })).status).toBe(403);
    expect((await mutation().request(url(id), { method: 'POST', headers: { ...revokeHeaders(), Origin: 'https://attacker.example' } }, { DB: testEnv.DB })).status).toBe(403);
    for (const body of ['null', '[]', '{bad', '{"revokedAt":null}', '{"actorId":"a12-admin"}', '{"operationId":"client-op"}', '{"restore":true}']) {
      expect((await mutation().request(url(id), { method: 'POST', headers: revokeHeaders(), body }, { DB: testEnv.DB })).status).toBe(400);
    }
    for (const invalidId of ['a%2Fb', '%20bad', 'bad%0A', 'x'.repeat(129), 's2a_invite_fake']) {
      expect((await mutation().request(url(invalidId), { method: 'POST', headers: revokeHeaders() }, { DB: testEnv.DB })).status).toBe(400);
    }
    expect((await mutation().request(`${url(id)}?actorId=${admin}`, { method: 'POST', headers: revokeHeaders() }, { DB: testEnv.DB })).status).toBe(400);
    expect(await revocationAudits()).toEqual([]);
  });

  it('bounds streamed revoke bodies and applies CSRF before body consumption', async () => {
    const id = await target();
    const oversized = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(' '.repeat(REGISTRATION_CODE_CREATE_BODY_MAX_BYTES + 1))); controller.close(); } });
    const response = await mutation().request(new Request(url(id), { method: 'POST', headers: { ...revokeHeaders(), 'Content-Length': '1' }, body: oversized }), undefined, { DB: testEnv.DB });
    expect(response.status).toBe(413);
    const pull = vi.fn(() => { throw new Error('Do not read'); });
    const body = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
    const denied = await mutation().request(new Request(url(id), { method: 'POST', headers: { Cookie: cookies.get(admin)! }, body }), undefined, { DB: testEnv.DB });
    expect(denied.status).toBe(403);
    expect(pull).not.toHaveBeenCalled();
    expect(await revocationAudits()).toEqual([]);
  });

  it('serializes concurrent revocations and rolls back if audit persistence fails', async () => {
    const id = await target();
    const app = mutation();
    const responses = await Promise.all([1, 2].map(() => app.request(url(id), { method: 'POST', headers: revokeHeaders() }, { DB: testEnv.DB })));
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const bodies = await Promise.all(responses.map((response) => response.json())) as { data: { status: string } }[];
    expect(bodies.map((body) => body.data.status).sort()).toEqual(['already_revoked', 'revoked']);
    expect(await revocationAudits()).toHaveLength(1);
    const other = await prepare<{ id: string }>(testEnv.DB, 'SELECT id FROM registration_codes WHERE revoked_at IS NULL LIMIT 1').first();
    await testEnv.DB.exec("CREATE TRIGGER a12r_fail_audit BEFORE INSERT ON admin_audit BEGIN SELECT RAISE(ABORT,'private failure'); END;");
    const failed = await app.request(url(other!.id), { method: 'POST', headers: revokeHeaders() }, { DB: testEnv.DB });
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain('private failure');
    expect((await prepare(testEnv.DB, 'SELECT revoked_at FROM registration_codes WHERE id=?', [other!.id]).first())?.revoked_at).toBeNull();
    expect(await revocationAudits()).toHaveLength(1);
  });
});

describe('registration code generation HTTP', () => {
  const origin = 'https://local.test';
  const payload = { quantity: 2, expiresAt: now + 30_000 };
  function mutation(time = now) {
    return createRegistrationCodeRoutes({ database: testEnv.DB, now: () => time, trustedOrigin: origin });
  }
  function headers(actor = admin, operationId = 'a12c-operation') {
    const nonce = issueCsrfToken();
    return { 'Content-Type': 'application/json', Origin: origin,
      Cookie: `${cookies.get(actor)!}; ${nonce.setCookie.split(';')[0]}`, 'X-CSRF-Token': nonce.token,
      'Idempotency-Key': operationId, 'X-Actor-Id': otherAdmin };
  }
  async function count() { return prepare<{ count: number }>(testEnv.DB, 'SELECT COUNT(*) AS count FROM registration_codes').first(); }

  it('returns plaintext once, then only metadata on exact replay, with trusted audit ownership', async () => {
    const app = mutation();
    const first = await app.request(origin + REGISTRATION_CODES_PATH, { method: 'POST', headers: headers(), body: JSON.stringify(payload) }, { DB: testEnv.DB });
    expect(first.status).toBe(201);
    expect(first.headers.get('Cache-Control')).toBe('no-store');
    const initial = await first.json() as { data: { batchId: string; replayed: boolean; codes: { id: string; token: string }[] } };
    expect(initial.data.replayed).toBe(false);
    expect(initial.data.codes).toHaveLength(2);
    for (const code of initial.data.codes) expect(code.token).toMatch(/^s2a_invite_[A-Za-z0-9_-]{43}$/);
    const replay = await app.request(origin + REGISTRATION_CODES_PATH, { method: 'POST', headers: headers(), body: JSON.stringify(payload) }, { DB: testEnv.DB });
    expect(replay.status).toBe(200);
    const text = await replay.text();
    expect(JSON.parse(text)).toMatchObject({ data: { batchId: initial.data.batchId, replayed: true } });
    expect(text).not.toMatch(/"token"|code_hash|fingerprint/);
    for (const code of initial.data.codes) expect(text).not.toContain(code.token);
    expect((await count())?.count).toBe(8); // Six original list fixtures plus this one batch.
    const audit = await prepare(testEnv.DB, 'SELECT actor_id FROM admin_audit WHERE target_id=?', [initial.data.batchId]).first();
    expect(audit).toEqual({ actor_id: admin });
    const stored = JSON.stringify((await prepare(testEnv.DB, 'SELECT * FROM registration_codes WHERE operation_id=?', [initial.data.batchId]).all()).rows);
    for (const code of initial.data.codes) expect(stored).not.toContain(code.token);
  });

  it('returns 409 for different payloads and serializes concurrent replay without returning secrets twice', async () => {
    const app = mutation();
    const responses = await Promise.all([1, 2].map(() => app.request(origin + REGISTRATION_CODES_PATH, { method: 'POST', headers: headers(), body: JSON.stringify(payload) }, { DB: testEnv.DB })));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 201]);
    const bodies = await Promise.all(responses.map((response) => response.json())) as { data: { replayed: boolean; codes: Record<string, unknown>[] } }[];
    expect(bodies.filter((body) => body.data.codes.some((code) => 'token' in code))).toHaveLength(1);
    const conflict = await app.request(origin + REGISTRATION_CODES_PATH, { method: 'POST', headers: headers(), body: JSON.stringify({ ...payload, quantity: 3 }) }, { DB: testEnv.DB });
    expect(conflict.status).toBe(409);
    expect((await count())?.count).toBe(8);
  });

  it('requires an admin session, CSRF, and a mandatory nonambiguous idempotency key', async () => {
    const app = mutation();
    expect((await app.request(origin + REGISTRATION_CODES_PATH, { method: 'POST' }, { DB: testEnv.DB })).status).toBe(401);
    expect((await app.request(origin + REGISTRATION_CODES_PATH, { method: 'POST', headers: headers(user), body: JSON.stringify(payload) }, { DB: testEnv.DB })).status).toBe(403);
    const missingCsrf = headers(); delete (missingCsrf as Partial<typeof missingCsrf>)['X-CSRF-Token'];
    expect((await app.request(origin + REGISTRATION_CODES_PATH, { method: 'POST', headers: missingCsrf, body: JSON.stringify(payload) }, { DB: testEnv.DB })).status).toBe(403);
    for (const key of ['', 'key, key', 'bad key', 'x'.repeat(129), 's2a_invite_not-an-operation']) {
      expect((await app.request(origin + REGISTRATION_CODES_PATH, { method: 'POST', headers: headers(admin, key), body: JSON.stringify(payload) }, { DB: testEnv.DB })).status).toBe(400);
    }
    expect((await count())?.count).toBe(6);
  });

  it('rejects invalid quantities/expiry and extra actor/readiness fields', async () => {
    for (const body of [{ ...payload, quantity: 0 }, { ...payload, quantity: 101 }, { ...payload, quantity: 1.5 }, { ...payload, quantity: '2' },
      { ...payload, expiresAt: null }, { ...payload, expiresAt: now }, { ...payload, expiresAt: now + 30 * 86_400_000 + 1 },
      { ...payload, expiresAt: Number.MAX_SAFE_INTEGER + 1 }, { ...payload, expiresAt: 'tomorrow' }, { quantity: 2, expiry: payload.expiresAt },
      { ...payload, actorId: otherAdmin }, { ...payload, now }, { ...payload, role: 'admin' }]) {
      const response = await mutation().request(origin + REGISTRATION_CODES_PATH, { method: 'POST', headers: headers(), body: JSON.stringify(body) }, { DB: testEnv.DB });
      expect(response.status).toBe(400);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    }
    expect((await count())?.count).toBe(6);
  });

  it('checks actual stream bytes and CSRF before body consumption', async () => {
    const oversized = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(' '.repeat(REGISTRATION_CODE_CREATE_BODY_MAX_BYTES + 1))); controller.close(); } });
    const response = await mutation().request(new Request(origin + REGISTRATION_CODES_PATH, { method: 'POST', headers: { ...headers(), 'Content-Length': '1' }, body: oversized }), undefined, { DB: testEnv.DB });
    expect(response.status).toBe(413);
    const pull = vi.fn(() => { throw new Error('must not read'); });
    const body = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
    const denied = await mutation().request(new Request(origin + REGISTRATION_CODES_PATH, { method: 'POST', headers: { ...headers(), Origin: 'https://attacker.example' }, body }), undefined, { DB: testEnv.DB });
    expect(denied.status).toBe(403);
    expect(pull).not.toHaveBeenCalled();
    expect((await mutation().request(origin + REGISTRATION_CODES_PATH, { method: 'POST', headers: headers(), body: '{broken' }, { DB: testEnv.DB })).status).toBe(400);
    expect((await count())?.count).toBe(6);
  });

  it('replays metadata after absolute expiry rather than recomputing expiry from retry time', async () => {
    expect((await mutation().request(origin + REGISTRATION_CODES_PATH, { method: 'POST', headers: headers(), body: JSON.stringify(payload) }, { DB: testEnv.DB })).status).toBe(201);
    const replay = await mutation(now + 40_000).request(origin + REGISTRATION_CODES_PATH, { method: 'POST', headers: headers(), body: JSON.stringify(payload) }, { DB: testEnv.DB });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ data: { replayed: true, codes: [{ expiresAt: payload.expiresAt }, { expiresAt: payload.expiresAt }] } });
  });

  it('rolls back all newly generated codes when the atomic audit fails', async () => {
    await testEnv.DB.exec("CREATE TRIGGER a12c_fail_audit BEFORE INSERT ON admin_audit BEGIN SELECT RAISE(ABORT,'private failure'); END;");
    const response = await mutation().request(origin + REGISTRATION_CODES_PATH, { method: 'POST', headers: headers(), body: JSON.stringify(payload) }, { DB: testEnv.DB });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private failure');
    expect((await count())?.count).toBe(6);
    expect((await prepare<{ count: number }>(testEnv.DB, 'SELECT COUNT(*) AS count FROM registration_code_batches').first())?.count).toBe(2);
  });
});
