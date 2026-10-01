import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createKeyRoutes, PLATFORM_KEYS_PATH as path, PLATFORM_KEY_BODY_MAX_BYTES } from '../../apps/worker/auth/key-routes';
import { issueCsrfToken } from '../../apps/worker/auth/csrf';
import { createPlatformKey } from '../../apps/worker/auth/key-repository';
import { createCookieSession } from '../../apps/worker/auth/sessions';
import { testEnv } from '../helpers/database';

const origin = 'https://console.example.com';
const now = 2000;
let cookie: string;
const bindings = () => ({ DB: testEnv.DB });
const app = () => createKeyRoutes({ now: () => now });
const headers = () => ({ Cookie: cookie });
const writeApp = () => createKeyRoutes({ now: () => now, trustedOrigin: origin });
function writeHeaders(operationId = 'create-operation') {
  const csrf = issueCsrfToken();
  return { Cookie: `${cookie}; ${csrf.setCookie.split(';')[0]}`, Origin: origin,
    'X-CSRF-Token': csrf.token, 'Content-Type': 'application/json', 'Idempotency-Key': operationId };
}
async function key(name = 'Test Key', owner = 'a26-owner') {
  return createPlatformKey(testEnv.DB, owner, { operationId: crypto.randomUUID(), name }, 1000);
}

beforeEach(async () => {
  await testEnv.DB.prepare("INSERT INTO groups(id,name,status,version,created_at,updated_at) VALUES('a26-group','A26 group','active',1,0,0)").run();
  for (const id of ['a26-owner', 'a26-other']) await testEnv.DB.prepare(`INSERT INTO users
    (id,email_normalized,password_hash,role,status,group_id,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
    VALUES(?,?,'test-only','user','active','a26-group',2,60,'admin',0,0)`).bind(id, `${id}@example.invalid`).run();
  cookie = (await createCookieSession(testEnv.DB, 'a26-owner', 1000)).setCookie.split(';')[0]!;
});

describe('A26-R Key revocation routes on native D1/Hono', () => {
  it('revokes once, returns safe metadata, and preserves time/version on replay', async () => {
    const created = await key();
    const url = `${origin}${path}/${created.key.id}/revoke`;
    const route = writeApp();
    const init = { method: 'POST', headers: writeHeaders(), body: '{"version":1}' };
    const first = await route.request(url, init, bindings());
    expect(first.status).toBe(200);
    expect(first.headers.get('Cache-Control')).toBe('no-store');
    expect(await first.json()).toMatchObject({ data: { kind: 'revoked', key: { id: created.key.id, status: 'revoked', version: 2, updatedAt: now } } });
    const replay = await route.request(url, init, bindings());
    const text = await replay.text();
    expect(replay.status).toBe(200);
    expect(JSON.parse(text)).toMatchObject({ data: { kind: 'already_revoked', key: { version: 2, updatedAt: now } } });
    for (const field of ['token', 'key_hash', 'creation_fingerprint']) expect(text).not.toContain(field);
  });
  it('handles concurrent revocation without repeated version increments', async () => {
    const created = await key();
    const route = writeApp();
    const results = await Promise.all(Array.from({ length: 4 }, () => route.request(`${origin}${path}/${created.key.id}/revoke`,
      { method: 'POST', headers: writeHeaders(), body: '{"version":1}' }, bindings())));
    expect(results.every(response => response.status === 200)).toBe(true);
    expect(await testEnv.DB.prepare('SELECT version,status FROM api_keys WHERE id=?').bind(created.key.id).first()).toEqual({ version: 2, status: 'revoked' });
  });
  it('uses identical failures for missing/foreign/stale Keys and never changes another owner', async () => {
    const own = await key(); const other = await key('Foreign', 'a26-other');
    for (const [id, version] of [['missing', 1], [other.key.id, 1], [own.key.id, 2]] as const) {
      const response = await writeApp().request(`${origin}${path}/${id}/revoke`, { method: 'POST', headers: writeHeaders(), body: JSON.stringify({ version }) }, bindings());
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: 'conflict', message: 'Resource conflict.' } });
    }
    expect(await testEnv.DB.prepare("SELECT COUNT(*) FROM api_keys WHERE status='revoked'").first('COUNT(*)')).toBe(0);
  });
  it('checks session/CSRF before consuming revoke body', async () => {
    const created = await key();
    const pull = vi.fn(() => { throw new Error('must not read'); });
    const body = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
    const response = await writeApp().request(new Request(`${origin}${path}/${created.key.id}/revoke`, { method: 'POST', headers: headers(), body }), undefined, bindings());
    expect(response.status).toBe(403); expect(pull).not.toHaveBeenCalled();
    expect((await writeApp().request(`${origin}${path}/${created.key.id}/revoke`, { method: 'POST' }, bindings())).status).toBe(401);
  });
  it.each([{}, { version: '1' }, { version: 0 }, { version: 1.5 }, { version: 1, userId: 'a26-other' }, { version: 1, status: 'active' }])('requires only an integer version %#', async body => {
    const created = await key();
    expect((await writeApp().request(`${origin}${path}/${created.key.id}/revoke`, { method: 'POST', headers: writeHeaders(), body: JSON.stringify(body) }, bindings())).status).toBe(400);
    expect(await testEnv.DB.prepare('SELECT version FROM api_keys WHERE id=?').bind(created.key.id).first('version')).toBe(1);
  });
  it('retains body limits and lazy trusted-origin failure handling', async () => {
    const created = await key();
    const url = `${origin}${path}/${created.key.id}/revoke`;
    expect((await writeApp().request(url, { method: 'POST', headers: writeHeaders(), body: ' '.repeat(PLATFORM_KEY_BODY_MAX_BYTES + 1) }, bindings())).status).toBe(413);
    const route = createKeyRoutes({ now: () => now, trustedOrigin: () => { throw new Error('private origin config'); } });
    const response = await route.request(url, { method: 'POST', headers: writeHeaders(), body: '{"version":1}' }, bindings());
    expect(response.status).toBe(503); expect(await response.text()).not.toContain('private');
  });
});

describe('A26-U Key update routes on native D1/Hono', () => {
  it('patches only allowed fields using version CAS and returns safe metadata', async () => {
    const created = await key();
    const before = await testEnv.DB.prepare('SELECT creation_operation_id,creation_fingerprint FROM api_keys WHERE id=?').bind(created.key.id).first();
    const response = await writeApp().request(`${origin}${path}/${created.key.id}`, { method: 'PATCH', headers: writeHeaders(),
      body: JSON.stringify({ version: 1, name: 'Renamed', expiresAt: now + 100, allowedModels: null }) }, bindings());
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ data: { id: created.key.id, name: 'Renamed', expiresAt: now + 100, allowedModels: null, version: 2 } });
    expect(await testEnv.DB.prepare('SELECT creation_operation_id,creation_fingerprint FROM api_keys WHERE id=?').bind(created.key.id).first()).toEqual(before);
  });
  it('allows one concurrent patch and consistently rejects a stale version', async () => {
    const created = await key();
    const route = writeApp();
    const responses = await Promise.all(['A', 'B'].map(name => route.request(`${origin}${path}/${created.key.id}`, {
      method: 'PATCH', headers: writeHeaders(), body: JSON.stringify({ version: 1, name }),
    }, bindings())));
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    const stale = await route.request(`${origin}${path}/${created.key.id}`, { method: 'PATCH', headers: writeHeaders(), body: '{"version":1,"name":"Stale"}' }, bindings());
    expect(stale.status).toBe(409);
  });
  it('does not distinguish missing, foreign or revoked Keys, and cannot restore status', async () => {
    const own = await key(); const foreign = await key('Foreign', 'a26-other');
    await testEnv.DB.prepare("UPDATE api_keys SET status='revoked' WHERE id=?").bind(own.key.id).run();
    for (const id of ['missing', own.key.id, foreign.key.id]) {
      const response = await writeApp().request(`${origin}${path}/${id}`, { method: 'PATCH', headers: writeHeaders(), body: '{"version":1,"name":"Attempt"}' }, bindings());
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: 'conflict', message: 'Resource conflict.' } });
    }
    expect(await testEnv.DB.prepare('SELECT name,status FROM api_keys WHERE id=?').bind(own.key.id).first()).toEqual({ name: 'Test Key', status: 'revoked' });
  });
  it('requires CSRF/session before parsing PATCH content', async () => {
    const created = await key();
    const pull = vi.fn(() => { throw new Error('not read'); });
    const body = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
    const response = await writeApp().request(new Request(`${origin}${path}/${created.key.id}`, { method: 'PATCH', headers: headers(), body }), undefined, bindings());
    expect(response.status).toBe(403); expect(pull).not.toHaveBeenCalled();
    expect((await writeApp().request(`${origin}${path}/${created.key.id}`, { method: 'PATCH' }, bindings())).status).toBe(401);
  });
  it.each([{ name: 'Missing version' }, { version: '1', name: 'String' }, { version: 0, name: 'Zero' }, { version: 1 },
    { version: 1, userId: 'a26-other' }, { version: 1, status: 'active' }, { version: 1, operationId: 'rewrite' },
    { version: 1, expiresAt: now }, { version: 1, allowedModels: [null] }])('rejects malformed or forbidden PATCH %#', async value => {
    const created = await key();
    const response = await writeApp().request(`${origin}${path}/${created.key.id}`, { method: 'PATCH', headers: writeHeaders(), body: JSON.stringify(value) }, bindings());
    expect(response.status).toBe(400);
    expect(await testEnv.DB.prepare('SELECT version FROM api_keys WHERE id=?').bind(created.key.id).first('version')).toBe(1);
  });
  it('cannot expand model access or partially update other fields', async () => {
    const created = await key();
    const response = await writeApp().request(`${origin}${path}/${created.key.id}`, { method: 'PATCH', headers: writeHeaders(),
      body: JSON.stringify({ version: 1, name: 'Must not change', allowedModels: ['unavailable-model'] }) }, bindings());
    expect(response.status).toBe(409);
    expect(await testEnv.DB.prepare('SELECT name,version FROM api_keys WHERE id=?').bind(created.key.id).first()).toEqual({ name: 'Test Key', version: 1 });
  });
  it('enforces PATCH body bytes and resolves origin lazily with stable failures', async () => {
    const created = await key();
    const response = await writeApp().request(`${origin}${path}/${created.key.id}`, { method: 'PATCH', headers: writeHeaders(), body: ' '.repeat(PLATFORM_KEY_BODY_MAX_BYTES + 1) }, bindings());
    expect(response.status).toBe(413);
    const broken = createKeyRoutes({ now: () => now, trustedOrigin: () => { throw new Error('private origin error'); } });
    const failure = await broken.request(`${origin}${path}/${created.key.id}`, { method: 'PATCH', headers: writeHeaders(), body: '{"version":1,"name":"x"}' }, bindings());
    expect(failure.status).toBe(503); expect(await failure.text()).not.toContain('private');
  });
});

describe('A26-C Key creation routes on native D1/Hono', () => {
  it('returns one created token and only safe metadata on ACK-loss replay', async () => {
    const route = writeApp();
    const init = { method: 'POST', headers: writeHeaders(), body: JSON.stringify({ name: 'Created' }) };
    const first = await route.request(origin + path, init, bindings());
    expect(first.status).toBe(201);
    expect(first.headers.get('Cache-Control')).toBe('no-store');
    const created = await first.json() as { data: { kind: string; token: string; key: { id: string; userId: string } } };
    expect(created.data).toMatchObject({ kind: 'created', token: expect.stringMatching(/^s2a_key_/), key: { userId: 'a26-owner' } });
    const replay = await route.request(origin + path, init, bindings());
    expect(replay.status).toBe(200);
    const replayText = await replay.text();
    expect(JSON.parse(replayText)).toMatchObject({ data: { kind: 'replayed', key: { id: created.data.key.id } } });
    expect(replayText).not.toContain('token');
    expect(replayText).not.toContain(created.data.token);
    expect(await testEnv.DB.prepare('SELECT COUNT(*) FROM api_keys').first('COUNT(*)')).toBe(1);
  });
  it('handles concurrent creation/replay and conflicting payloads', async () => {
    const route = writeApp();
    const init = { method: 'POST', headers: writeHeaders(), body: JSON.stringify({ name: 'Same' }) };
    const responses = await Promise.all([route.request(origin + path, init, bindings()), route.request(origin + path, init, bindings())]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 201]);
    const changed = await route.request(origin + path, { ...init, body: JSON.stringify({ name: 'Different' }) }, bindings());
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ error: { code: 'conflict' } });
  });
  it('requires session and valid CSRF before consuming a write body', async () => {
    const pull = vi.fn(() => { throw new Error('body must not be consumed'); });
    const body = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
    const denied = await writeApp().request(new Request(origin + path, { method: 'POST', headers: headers(), body }), undefined, bindings());
    expect(denied.status).toBe(403); expect(pull).not.toHaveBeenCalled();
    expect((await writeApp().request(origin + path, { method: 'POST', headers: { 'X-User-ID': 'a26-owner' } }, bindings())).status).toBe(401);
    expect(await testEnv.DB.prepare('SELECT COUNT(*) FROM api_keys').first('COUNT(*)')).toBe(0);
  });
  it.each(['', 'bad/id', 'x'.repeat(129), 'one,two'])('requires a valid Idempotency-Key %#', async operationId => {
    const response = await writeApp().request(origin + path, { method: 'POST', headers: writeHeaders(operationId), body: '{"name":"Key"}' }, bindings());
    expect(response.status).toBe(400);
  });
  it.each([{ name: 'Key', userId: 'a26-other' }, { name: 'Key', operationId: 'body-operation' }, { name: 'Key', status: 'active' }, {}, { name: 'Key', allowedModels: ['inaccessible'] }])('rejects body ownership/unsupported fields or denied model grants %#', async value => {
    const response = await writeApp().request(origin + path, { method: 'POST', headers: writeHeaders(), body: JSON.stringify(value) }, bindings());
    expect(response.status).toBe('allowedModels' in value ? 403 : 400);
    expect(await testEnv.DB.prepare('SELECT COUNT(*) FROM api_keys').first('COUNT(*)')).toBe(0);
  });
  it('resolves trustedOrigin only for authenticated writes and fails closed on invalid trusted config', async () => {
    const resolver = vi.fn(() => origin);
    const route = createKeyRoutes({ now: () => now, trustedOrigin: resolver });
    expect(resolver).not.toHaveBeenCalled();
    await route.request(origin + path, { headers: headers() }, bindings());
    expect(resolver).not.toHaveBeenCalled();
    expect((await route.request(origin + path, { method: 'POST', headers: writeHeaders(), body: '{"name":"Key"}' }, bindings())).status).toBe(201);
    expect(resolver).toHaveBeenCalledOnce();
    const bad = createKeyRoutes({ now: () => now, trustedOrigin: () => 'http://invalid.example' });
    const response = await bad.request(origin + path, { method: 'POST', headers: writeHeaders(), body: '{"name":"Other"}' }, bindings());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('invalid.example');
  });
  it('enforces streamed byte limits despite Content-Length and rejects broken JSON/media types', async () => {
    const oversized = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(' '.repeat(PLATFORM_KEY_BODY_MAX_BYTES + 1))); controller.close(); } });
    const response = await writeApp().request(new Request(origin + path, { method: 'POST', headers: { ...writeHeaders(), 'Content-Length': '1' }, body: oversized }), undefined, bindings());
    expect(response.status).toBe(413);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    for (const body of ['{bad', 'null', '[]']) expect((await writeApp().request(origin + path, { method: 'POST', headers: writeHeaders(), body }, bindings())).status).toBe(400);
    expect((await writeApp().request(origin + path, { method: 'POST', headers: { ...writeHeaders(), 'Content-Type': 'text/plain' }, body: '{}' }, bindings())).status).toBe(400);
  });
});

describe('A26 personal Key read routes on native D1/Hono', () => {
  it('lists only session-owner metadata with JSON/no-store and never secrets', async () => {
    const own = await key(); await key('Other', 'a26-other');
    const response = await app().request(origin + path, { headers: headers() }, bindings());
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('application/json');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ data: { items: [own.key], nextCursor: null }, request_id: expect.any(String) });
    for (const forbidden of ['key_hash', 'creation_fingerprint', 'creation_operation_id', 'token', 'Other']) expect(text).not.toContain(forbidden);
    if (own.kind === 'created') expect(text).not.toContain(own.token);
  });
  it('requires a live session and ignores forged owner/role headers', async () => {
    const response = await app().request(origin + path, { headers: { 'X-User-ID': 'a26-owner', 'X-Role': 'admin' } }, bindings());
    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await testEnv.DB.prepare("UPDATE users SET status='disabled' WHERE id='a26-owner'").run();
    expect((await app().request(origin + path, { headers: headers() }, bindings())).status).toBe(401);
  });
  it('returns own detail and identical 404 errors for missing/foreign IDs', async () => {
    const own = await key(); const other = await key('Other', 'a26-other');
    expect(await (await app().request(`${origin}${path}/${own.key.id}`, { headers: headers() }, bindings())).json()).toMatchObject({ data: own.key });
    for (const id of ['missing', other.key.id]) {
      const response = await app().request(`${origin}${path}/${id}`, { headers: headers() }, bindings());
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: 'not_found', message: 'Resource not found.' } });
    }
  });
  it('pages with owner/filter-bound cursors and applies state filtering', async () => {
    for (let i = 0; i < 3; i++) await key(`Key ${i}`);
    const first = await (await app().request(`${origin}${path}?limit=1&state=active`, { headers: headers() }, bindings())).json() as { data: { items: { id: string }[]; nextCursor: string } };
    const second = await (await app().request(`${origin}${path}?limit=2&state=active&cursor=${first.data.nextCursor}`, { headers: headers() }, bindings())).json() as { data: { items: { id: string }[]; nextCursor: null } };
    expect(new Set([...first.data.items, ...second.data.items].map(k => k.id)).size).toBe(3);
    expect(second.data.nextCursor).toBeNull();
    expect((await app().request(`${origin}${path}?state=revoked&cursor=${first.data.nextCursor}`, { headers: headers() }, bindings())).status).toBe(400);
  });
  it.each(['?owner=a26-other', '?limit=0', '?limit=101', '?limit=1&limit=2', '?state=unknown', '?cursor=bad!', '?state=active&state=all'])('rejects invalid query %s', async query => {
    expect((await app().request(origin + path + query, { headers: headers() }, bindings())).status).toBe(400);
  });
  it('does not resolve trustedOrigin for GET and maps storage failures to stable errors', async () => {
    const resolver = vi.fn(() => { throw new Error('private configuration detail'); });
    const route = createKeyRoutes({ now: () => now, trustedOrigin: resolver });
    expect((await route.request(origin + path, { headers: headers() }, bindings())).status).toBe(200);
    expect(resolver).not.toHaveBeenCalled();
    const created = await key();
    await testEnv.DB.prepare('UPDATE api_keys SET allowed_models_json=? WHERE id=?').bind('[null]', created.key.id).run();
    const response = await route.request(origin + path, { headers: headers() }, bindings());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'service_unavailable', message: 'Service temporarily unavailable.' } });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
});
