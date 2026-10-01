// Hono is owned by the Worker workspace, not the root test package.
import { Hono } from '../../apps/worker/node_modules/hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authenticatePlatformKey, PlatformKeyAuthError, requirePlatformKey } from '../../apps/worker/auth/api-key-auth';
import type { PlatformKeyAuthEnv } from '../../apps/worker/auth/api-key-auth';
import { createPlatformKey, revokePlatformKey } from '../../apps/worker/auth/key-repository';
import { createCookieSession } from '../../apps/worker/auth/sessions';
import { generateToken } from '../../apps/worker/auth/tokens';
import { testEnv } from '../helpers/database';

const now = 2000;
let token: string;
let keyId: string;
const request = (headers: HeadersInit = {}) => new Request('https://gateway.example/v1/messages', { headers });
const auth = (headers: HeadersInit, at = now) => authenticatePlatformKey(testEnv.DB, request(headers), at);

beforeEach(async () => {
  await testEnv.DB.prepare("INSERT INTO groups(id,name,status,version,created_at,updated_at) VALUES('a27-group','A27 group','active',1,0,0)").run();
  await testEnv.DB.prepare(`INSERT INTO users
    (id,email_normalized,password_hash,role,status,group_id,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
    VALUES('a27-owner','a27@example.invalid','test-only','user','active','a27-group',2,60,'admin',0,0)`).run();
  const created = await createPlatformKey(testEnv.DB, 'a27-owner', { operationId: 'a27-create', name: 'Gateway Key', allowedModels: null }, 1000);
  if (created.kind !== 'created') throw new Error('Expected fresh test Key.');
  token = created.token; keyId = created.key.id;
});

describe('A27 platform-Key authentication on native D1', () => {
  it.each(['bearer', 'x-api-key', 'both'])('authenticates %s and returns only frozen authoritative metadata', async style => {
    const headers: Record<string, string> = {};
    if (style !== 'x-api-key') headers.Authorization = `Bearer ${token}`;
    if (style !== 'bearer') headers['x-api-key'] = token;
    const result = await auth(headers);
    expect(result).toMatchObject({ key: { id: keyId, userId: 'a27-owner', allowedModels: null }, user: { id: 'a27-owner', status: 'active', concurrencyLimit: 2, rpmLimit: 60 }, group: { id: 'a27-group', status: 'active' } });
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.key)).toBe(true);
    const encoded = JSON.stringify(result);
    for (const forbidden of [token, 'key_hash', 'password_hash', 'creation_fingerprint']) expect(encoded).not.toContain(forbidden);
  });

  it('supports case-insensitive Bearer scheme without changing the token', async () => {
    expect((await auth({ Authorization: `bEaReR ${token}` })).key.id).toBe(keyId);
  });

  it('rejects conflicting valid credentials instead of choosing one', async () => {
    await expect(auth({ Authorization: `Bearer ${token}`, 'x-api-key': generateToken('apiKey') }))
      .rejects.toMatchObject({ status: 400, code: 'invalid_request', reason: 'conflicting_api_key_headers' });
  });

  it.each(['missing', 'basic', 'empty-bearer', 'two-spaces', 'duplicate-bearer', 'duplicate-x-key', 'session-token', 'truncated'])('rejects malformed/missing credentials: %s', async kind => {
    const headers = new Headers();
    if (kind === 'basic') headers.set('Authorization', `Basic ${token}`);
    if (kind === 'empty-bearer') headers.set('Authorization', 'Bearer');
    if (kind === 'two-spaces') headers.set('Authorization', `Bearer  ${token}`);
    if (kind === 'duplicate-bearer') { headers.append('Authorization', `Bearer ${token}`); headers.append('Authorization', `Bearer ${token}`); }
    if (kind === 'duplicate-x-key') { headers.append('x-api-key', token); headers.append('x-api-key', token); }
    if (kind === 'session-token') headers.set('x-api-key', generateToken('session'));
    if (kind === 'truncated') headers.set('x-api-key', token.slice(0, -1));
    await expect(auth(headers)).rejects.toMatchObject({ status: 401, reason: 'invalid_api_key' });
  });

  it('does not let a valid alternative hide a malformed credential header', async () => {
    await expect(auth({ Authorization: 'Basic ignored', 'x-api-key': token })).rejects.toMatchObject({ status: 401 });
    await expect(auth({ Authorization: `Bearer ${token}`, 'x-api-key': 'bad' })).rejects.toMatchObject({ status: 401 });
  });

  it('rejects unknown, expired and revoked Keys identically', async () => {
    await expect(auth({ 'x-api-key': generateToken('apiKey') })).rejects.toMatchObject({ status: 401 });
    await testEnv.DB.prepare('UPDATE api_keys SET expires_at=? WHERE id=?').bind(now, keyId).run();
    expect((await auth({ 'x-api-key': token }, now - 1)).key.id).toBe(keyId);
    await expect(auth({ 'x-api-key': token })).rejects.toMatchObject({ status: 401 });
    await testEnv.DB.prepare('UPDATE api_keys SET expires_at=NULL WHERE id=?').bind(keyId).run();
    await revokePlatformKey(testEnv.DB, 'a27-owner', keyId, 1, now);
    await expect(auth({ Authorization: `Bearer ${token}` })).rejects.toMatchObject({ status: 401 });
  });

  it.each(['user', 'group'])('rechecks current %s status on every call without caching', async kind => {
    await auth({ 'x-api-key': token });
    await testEnv.DB.prepare(kind === 'user' ? "UPDATE users SET status='disabled' WHERE id='a27-owner'" : "UPDATE groups SET status='disabled' WHERE id='a27-group'").run();
    await expect(auth({ 'x-api-key': token })).rejects.toMatchObject({ status: 401 });
  });

  it('does not derive identity from Cookie, query, body, owner headers or forwarded claims', async () => {
    const session = (await createCookieSession(testEnv.DB, 'a27-owner', 1000)).setCookie.split(';')[0]!;
    await expect(auth({ Cookie: session, 'X-User-Id': 'a27-owner', 'X-Role': 'admin' })).rejects.toMatchObject({ status: 401 });
    const req = new Request(`https://gateway.example/v1/messages?api_key=${token}&owner=attacker`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_key: token, owner: 'a27-owner' }),
    });
    await expect(authenticatePlatformKey(testEnv.DB, req, now)).rejects.toMatchObject({ status: 401 });
    expect((await auth({ 'x-api-key': token, 'X-User-Id': 'attacker', 'X-Role': 'admin' })).user.id).toBe('a27-owner');
  });

  it('does not read request bodies and does not turn [] into inherited model permissions', async () => {
    await testEnv.DB.prepare("UPDATE api_keys SET allowed_models_json='[]' WHERE id=?").bind(keyId).run();
    const pull = vi.fn(() => { throw new Error('auth should not read content'); });
    const req = new Request('https://gateway.example/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 }) });
    const result = await authenticatePlatformKey(testEnv.DB, req, now);
    expect(result.key.allowedModels).toEqual([]); expect(pull).not.toHaveBeenCalled();
    expect(Object.isFrozen(result.key.allowedModels)).toBe(true);
  });

  it('leaves balance admission to the gateway and performs no authentication writes', async () => {
    await testEnv.DB.prepare("UPDATE users SET balance_units=-100 WHERE id='a27-owner'").run();
    const before = await testEnv.DB.prepare('SELECT * FROM api_keys WHERE id=?').bind(keyId).first();
    expect((await auth({ 'x-api-key': token })).user.balanceUnits).toBe('-100');
    expect(await testEnv.DB.prepare('SELECT * FROM api_keys WHERE id=?').bind(keyId).first()).toEqual(before);
  });

  it('distinguishes malformed stored permissions and unavailable D1 from bad credentials', async () => {
    await testEnv.DB.prepare("UPDATE api_keys SET allowed_models_json='[null]' WHERE id=?").bind(keyId).run();
    await expect(auth({ 'x-api-key': token })).rejects.toMatchObject({ status: 503, code: 'service_unavailable', reason: 'authentication_unavailable' });
    await testEnv.DB.prepare('DROP TABLE api_keys').run();
    const error: unknown = await auth({ 'x-api-key': token }).then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(PlatformKeyAuthError);
    expect(error).toMatchObject({ status: 503 });
    expect(JSON.stringify(error)).not.toContain(token);
    if (error instanceof Error) expect(error.message).not.toContain('api_keys');
  });

  it('classifies crypto or invalid clock failures as unavailable, with no secret-bearing cause', async () => {
    const spy = vi.spyOn(crypto.subtle, 'digest').mockRejectedValueOnce(new Error(`private backend ${token}`));
    try { await expect(auth({ 'x-api-key': token })).rejects.toMatchObject({ status: 503 }); } finally { spy.mockRestore(); }
    await expect(auth({ 'x-api-key': token }, NaN)).rejects.toMatchObject({ status: 503 });
  });
});

describe('A27 unmounted Hono middleware', () => {
  function harness(clock = () => now) {
    const app = new Hono<PlatformKeyAuthEnv>();
    // Test-only error renderer; production gateway chooses each native protocol.
    app.onError((error, c) => error instanceof PlatformKeyAuthError
      ? c.json({ error: { code: error.code, reason: error.reason } }, error.status)
      : c.json({ error: 'downstream_failure' }, 500));
    app.use('/v1/*', requirePlatformKey(clock));
    app.get('/v1/check', c => c.json({ owner: c.get('platformKeyAuth').user.id, keyId: c.get('platformKeyAuth').key.id }));
    app.get('/v1/failure', () => { throw new Error('business failure'); });
    return app;
  }
  it('populates trusted context only after authentication', async () => {
    const app = harness();
    const ok = await app.request('/v1/check', { headers: { 'x-api-key': token, 'X-User-Id': 'attacker' } }, { DB: testEnv.DB });
    expect(ok.status).toBe(200); expect(await ok.json()).toEqual({ owner: 'a27-owner', keyId });
    expect((await app.request('/v1/check', {}, { DB: testEnv.DB })).status).toBe(401);
    const conflict = await app.request('/v1/check', { headers: { 'x-api-key': token, Authorization: `Bearer ${generateToken('apiKey')}` } }, { DB: testEnv.DB });
    expect(conflict.status).toBe(400);
  });
  it('does not relabel downstream failures and safely handles clock failure', async () => {
    const failure = await harness().request('/v1/failure', { headers: { 'x-api-key': token } }, { DB: testEnv.DB });
    expect(failure.status).toBe(500); expect(await failure.json()).toEqual({ error: 'downstream_failure' });
    expect((await harness(() => { throw new Error('clock'); }).request('/v1/check', { headers: { 'x-api-key': token } }, { DB: testEnv.DB })).status).toBe(503);
  });
});
