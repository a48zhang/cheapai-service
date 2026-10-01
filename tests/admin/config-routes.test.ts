import { beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../../apps/worker/app';
import type { Env } from '../../apps/worker/env';
import { readChannelKeyring, CHANNEL_KEYRING_LIMITS } from '../../apps/worker/channel-keyring';
import { decryptChannelSecret } from '../../apps/worker/admin/channel-secrets';
import { createCookieSession } from '../../apps/worker/auth/sessions';
import { issueCsrfToken } from '../../apps/worker/auth/csrf';
import { testEnv } from '../helpers/database';

const origin = 'https://console.example';
const actor = 'c17-admin';
const ordinary = 'c17-user';
let env: Env;
let encodedV1: string;
let encodedV2: string;
const cookies = new Map<string, string>();
const channelInput = { name: 'C17 Channel', baseUrl: 'https://provider.example.invalid', upstreamKey: 'c17-local-upstream-secret', concurrencyLimit: 2, rpmLimit: 60 };
const modelInput = { publicModelId: 'c17-model', sellPrices: { input: '1', output: '2' }, admissionMinBalanceUnits: '0', maxOutputTokens: 4096 };
function call(path: string, options: { method?: string; body?: unknown; actor?: string; bindings?: Env; headers?: Record<string, string> } = {}) {
  const method = options.method ?? 'GET';
  const csrf = issueCsrfToken();
  const cookie = cookies.get(options.actor ?? actor);
  return app.fetch(new Request(origin + path, { method,
    headers: { ...(cookie ? { Cookie: `${cookie}; ${csrf.setCookie.split(';')[0]}` } : {}),
      ...(method === 'GET' ? {} : { Origin: origin, 'X-CSRF-Token': csrf.token }),
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...options.headers },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) }), options.bindings ?? env);
}
async function data<T>(response: Response, status = 200): Promise<T> {
  expect(response.status).toBe(status); expect(response.headers.get('Cache-Control')).toBe('no-store');
  return (await response.json<{ data: T }>()).data;
}
async function channel() { return data<{ id: string; configVersion: number }>(await call('/api/v1/admin/channels', { method: 'POST', body: channelInput }), 201); }
beforeEach(async () => {
  cookies.clear();
  encodedV1 = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
  encodedV2 = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
  env = { ...testEnv, ENVIRONMENT: 'local', PUBLIC_BASE_URL: origin, EMAIL_VERIFICATION_READY: false,
    CHANNEL_KEYRING_JSON: JSON.stringify({ v1: encodedV1, v2: encodedV2 }), CHANNEL_ACTIVE_KEY_VERSION: 'v1' };
  const now = Date.now();
  for (const [id, role] of [[actor, 'admin'], [ordinary, 'user']] as const) {
    await testEnv.DB.prepare(`INSERT INTO users(id,email_normalized,password_hash,role,status,group_id,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
      VALUES(?,?,?,?,'active','default',2,60,'bootstrap',?,?)`).bind(id, `${id}@example.invalid`, 'test-only-hash', role, now, now).run();
    cookies.set(id, (await createCookieSession(testEnv.DB, id, Date.now())).setCookie.split(';')[0]!);
  }
});

describe('configuration CRUD through the real app entry', () => {
  it('creates and updates channels, groups, models and mappings with safe output and versioned audit', async () => {
    const createdChannel = await channel();
    const group = await data<{ id: string; channelIds: string[] }>(await call('/api/v1/admin/groups', { method: 'POST', body: { name: 'C17 Group', channelIds: [createdChannel.id] } }), 201);
    expect(group.channelIds).toEqual([createdChannel.id]);
    await data(await call(`/api/v1/admin/groups/${group.id}`, { method: 'PATCH', body: { version: 1, name: 'C17 Renamed Group' } }));
    const model = await data<{ priceVersion: number; sellPrices: { input: string } }>(await call('/api/v1/admin/models', { method: 'POST', body: modelInput }), 201);
    expect(model.priceVersion).toBe(1); expect(model.sellPrices.input).toBe('1');
    const mappingPath = '/api/v1/admin/models/c17-model/mappings';
    const mapping = await data<{ configVersion: number }>(await call(mappingPath, { method: 'POST', body: {
      channelId: createdChannel.id, protocol: 'chat', upstreamModel: 'upstream-model', capabilities: { protocol: 'chat', features: [], maxOutputTokens: 4096 },
    } }), 201);
    expect(mapping.configVersion).toBe(1);
    await data(await call(`${mappingPath}/${createdChannel.id}/chat`, { method: 'PATCH', body: { version: 1, upstreamModel: 'changed-upstream' } }));
    expect((await call(`${mappingPath}/${createdChannel.id}/chat`, { method: 'PATCH', body: { version: 1, upstreamModel: 'stale' } })).status).toBe(409);
    const updatedModel = await data<{ priceVersion: number }>(await call('/api/v1/admin/models/c17-model', { method: 'PATCH', body: { version: 1, sellPrices: { input: '3', output: '4' } } }));
    expect(updatedModel.priceVersion).toBe(2);
    await data(await call(`/api/v1/admin/channels/${createdChannel.id}`, { method: 'PATCH', body: { version: 1, status: 'disabled' } }));
    for (const path of ['/api/v1/admin/channels', '/api/v1/admin/groups', '/api/v1/admin/models', mappingPath]) {
      const output = JSON.stringify(await data(await call(path)));
      expect(output).not.toContain(channelInput.upstreamKey); expect(output).not.toContain(encodedV1);
      expect(output).not.toMatch(/secret_ciphertext|secret_key_version|ciphertext|nonce/);
    }
    const audits = (await testEnv.DB.prepare('SELECT action,redacted_change_json FROM admin_audit WHERE actor_id=?').bind(actor).all()).results;
    expect(audits.map(item => item.action)).toEqual(expect.arrayContaining(['channel.create', 'channel.update', 'group.create', 'group.update', 'model.create', 'model.update']));
    expect(JSON.stringify(audits)).not.toContain(channelInput.upstreamKey); expect(JSON.stringify(audits)).not.toContain(encodedV1);
    expect(await testEnv.DB.prepare('SELECT config_version FROM channel_models WHERE channel_id=?').bind(createdChannel.id).first()).toEqual({ config_version: 2 });
  });

  it('uses the active encryption version and retains old-version decryption across rotation', async () => {
    const created = await channel();
    const old = await testEnv.DB.prepare('SELECT secret_ciphertext,secret_key_version FROM channels WHERE id=?').bind(created.id).first<{ secret_ciphertext: string; secret_key_version: string }>();
    expect(old!.secret_key_version).toBe('v1');
    env.CHANNEL_ACTIVE_KEY_VERSION = 'v2';
    const keyring = readChannelKeyring(env);
    expect(keyring.active.keyVersion).toBe('v2'); expect(keyring.keyring.size).toBe(2);
    expect(await decryptChannelSecret(old!.secret_ciphertext, created.id, keyring.keyring)).toBe(channelInput.upstreamKey);
    await data(await call(`/api/v1/admin/channels/${created.id}`, { method: 'PATCH', body: { version: 1, upstreamKey: 'c17-new-local-secret' } }));
    const rotated = await testEnv.DB.prepare('SELECT secret_ciphertext,secret_key_version FROM channels WHERE id=?').bind(created.id).first<{ secret_ciphertext: string; secret_key_version: string }>();
    expect(rotated!.secret_key_version).toBe('v2');
    expect(await decryptChannelSecret(rotated!.secret_ciphertext, created.id, keyring.keyring)).toBe('c17-new-local-secret');
  });

  it('never reads encryption Secrets for GET, anonymous/ordinary writes, or metadata-only channel updates', async () => {
    const created = await channel();
    const getter = vi.fn(() => { throw new Error('PRIVATE KEYRING'); });
    const lazyEnv = { ...env };
    Object.defineProperty(lazyEnv, 'CHANNEL_KEYRING_JSON', { enumerable: true, get: getter });
    Object.defineProperty(lazyEnv, 'CHANNEL_ACTIVE_KEY_VERSION', { enumerable: true, get: getter });
    delete lazyEnv.PUBLIC_BASE_URL;
    for (const path of ['/api/v1/admin/channels', '/api/v1/admin/groups', '/api/v1/admin/models', '/api/v1/admin/models/c17-model/mappings']) {
      await data(await call(path, { bindings: lazyEnv }));
      expect((await call(path, { method: 'POST', body: {}, actor: 'missing', bindings: lazyEnv })).status).toBe(401);
      expect((await call(path, { method: 'POST', body: {}, actor: ordinary, bindings: lazyEnv })).status).toBe(403);
    }
    expect(getter).not.toHaveBeenCalled();
    lazyEnv.PUBLIC_BASE_URL = origin;
    await data(await call(`/api/v1/admin/channels/${created.id}`, { method: 'PATCH', body: { version: 1, name: 'Metadata only' }, bindings: lazyEnv }));
    expect(getter).not.toHaveBeenCalled();
    const rejected = await call('/api/v1/admin/channels', { method: 'POST', body: channelInput, bindings: lazyEnv });
    expect(rejected.status).toBe(503); expect(await rejected.text()).not.toContain('PRIVATE');
  });

  it('rejects malformed/oversized keyrings and missing active versions without echoing Secret data', async () => {
    const cases: Partial<Env>[] = [
      { CHANNEL_KEYRING_JSON: 'PRIVATE invalid JSON' }, { CHANNEL_KEYRING_JSON: '[]' }, { CHANNEL_KEYRING_JSON: '{}' },
      { CHANNEL_KEYRING_JSON: JSON.stringify({ v1: btoa('a'.repeat(31)) }) },
      { CHANNEL_KEYRING_JSON: JSON.stringify({ v1: encodedV1 + '\n' }) },
      { CHANNEL_KEYRING_JSON: JSON.stringify({ 'bad version': encodedV1 }) },
      { CHANNEL_ACTIVE_KEY_VERSION: 'missing' }, { CHANNEL_ACTIVE_KEY_VERSION: 'v1\n' },
      { CHANNEL_KEYRING_JSON: ' '.repeat(CHANNEL_KEYRING_LIMITS.bytes + 1) },
      { CHANNEL_KEYRING_JSON: JSON.stringify(Object.fromEntries(Array.from({ length: CHANNEL_KEYRING_LIMITS.entries + 1 }, (_, index) => [`v${index}`, encodedV1]))) },
    ];
    for (const patch of cases) {
      const response = await call('/api/v1/admin/channels', { method: 'POST', body: channelInput, bindings: { ...env, ...patch } });
      expect(response.status).toBe(503); const text = await response.text(); expect(text).not.toContain('PRIVATE'); expect(text).not.toContain(encodedV1);
    }
    expect((await testEnv.DB.prepare('SELECT id FROM channels').all()).results).toEqual([]);
  });

  it('enforces cross-role/Origin/CSRF protection and preserves unknown-path JSON404', async () => {
    for (const path of ['/api/v1/admin/channels', '/api/v1/admin/groups', '/api/v1/admin/models', '/api/v1/admin/models/c17-model/mappings']) {
      expect((await call(path, { actor: ordinary })).status).toBe(403);
      expect((await call(path, { method: 'POST', body: {}, headers: { Origin: 'https://evil.example' } })).status).toBe(403);
      expect((await call(path, { method: 'POST', body: {}, headers: { 'X-CSRF-Token': '' } })).status).toBe(403);
    }
    for (const path of ['/api/v1/admin/channels/missing/extra', '/api/v1/admin/groups/missing/extra', '/api/v1/admin/models/c17-model/mappings/extra/extra/more']) {
      const response = await call(path); expect(response.status).toBe(404); expect(await response.json()).toMatchObject({ error: { code: 'not_found' } });
    }
  });

  it('rolls back a mounted configuration update and its audit on failure', async () => {
    const created = await channel();
    await testEnv.DB.exec("CREATE TRIGGER c17_fail_audit BEFORE INSERT ON admin_audit WHEN NEW.action='channel.update' BEGIN SELECT RAISE(ABORT,'PRIVATE AUDIT DETAIL'); END");
    const response = await call(`/api/v1/admin/channels/${created.id}`, { method: 'PATCH', body: { version: 1, name: 'Must roll back' } });
    expect(response.status).toBe(503); expect(await response.text()).not.toContain('PRIVATE');
    expect(await testEnv.DB.prepare('SELECT name,config_version FROM channels WHERE id=?').bind(created.id).first()).toEqual({ name: channelInput.name, config_version: 1 });
  });
});
