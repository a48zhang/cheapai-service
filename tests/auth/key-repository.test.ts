import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPlatformKey as createPlatformKeyRaw, PlatformKeyCreationError, PlatformKeyCreationConflict,
  findPlatformKeyById, findInternalPlatformKeyByHash, listPlatformKeys, PlatformKeyStorageError,
  updatePlatformKey, revokePlatformKey } from '../../apps/worker/auth/key-repository';
import type { CreatePlatformKeyInput } from '../../apps/worker/auth/key-repository';
import { apiError } from '../../apps/worker/http';
import { hashToken, TOKEN_SECRET_BYTES } from '../../apps/worker/auth/tokens';
import { testEnv } from '../helpers/database';

const now = 1_788_619_000_123;
const owner = 'a25-owner';

// Original A25 cases each exercise a fresh logical creation.
async function createPlatformKey(database: D1Database, userId: string, input: Omit<CreatePlatformKeyInput, 'operationId'>, at: number) {
  const result = await createPlatformKeyRaw(database, userId, { ...input, operationId: crypto.randomUUID() }, at);
  if (result.kind !== 'created') throw new Error('Expected a fresh creation.');
  return result;
}

async function group(id: string) {
  await testEnv.DB.prepare('INSERT INTO groups (id,name,status,version,created_at,updated_at) VALUES (?,?,?,1,?,?)')
    .bind(id, id, 'active', now, now).run();
}
async function user(id: string, groupId: string) {
  await testEnv.DB.prepare(`INSERT INTO users
    (id,email_normalized,password_hash,role,status,group_id,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
    VALUES (?,?,'test-only-hash','user','active',?,2,60,'admin',?,?)`)
    .bind(id, `${id}@example.invalid`, groupId, now, now).run();
}
async function accessibleModel(modelId: string, groupId = 'a25-group') {
  const channelId = `channel-${modelId}`;
  // Synthetic schema-valid envelope; this test never decrypts/calls an upstream.
  const envelope = JSON.stringify({ algorithm: 'A256GCM', format_version: 1, key_version: 'test', nonce: 'synthetic', ciphertext: 'synthetic' });
  await testEnv.DB.prepare(`INSERT INTO channels
    (id,name,base_url,secret_ciphertext,secret_key_version,status,priority,concurrency_limit,rpm_limit,config_version,created_at,updated_at)
    VALUES (?,?,'https://example.invalid',?,'test','active',0,2,60,1,?,?)`)
    .bind(channelId, channelId, envelope, now, now).run();
  await testEnv.DB.prepare('INSERT INTO channel_groups(channel_id,group_id) VALUES (?,?)').bind(channelId, groupId).run();
  await testEnv.DB.prepare(`INSERT INTO models (public_model_id,status,sell_prices_json,price_version,admission_min_balance_units,max_output_tokens,created_at,updated_at) VALUES (?,'active','{}',1,0,1024,?,?)`).bind(modelId, now, now).run();
  await testEnv.DB.prepare(`INSERT INTO channel_models(channel_id,public_model_id,upstream_model,protocol,capabilities_json,config_version)
    VALUES (?,?,'upstream','chat','{}',1)`).bind(channelId, modelId).run();
}

beforeEach(async () => {
  await group('a25-group'); await group('a25-other-group');
  await user(owner, 'a25-group'); await user('other-owner', 'a25-other-group');
});

describe('owner-scoped platform Key updates/revocation on native D1', () => {
  it('updates normalized name, expiry and sorted permissions together with one CAS version increment', async () => {
    await accessibleModel('model-a'); await accessibleModel('model-b');
    const created = await createPlatformKey(testEnv.DB, owner, { name: 'Before' }, now);
    const before = await testEnv.DB.prepare('SELECT key_hash,creation_operation_id,creation_fingerprint FROM api_keys WHERE id=?').bind(created.key.id).first();
    const result = await updatePlatformKey(testEnv.DB, owner, created.key.id, 1,
      { name: ' Cafe\u0301 ', expiresAt: now + 100, allowedModels: ['model-b', 'model-a'] }, now + 1);
    expect(result).toMatchObject({ kind: 'updated', key: { name: 'Café', expiresAt: now + 100, allowedModels: ['model-a', 'model-b'], version: 2, updatedAt: now + 1, status: 'active' } });
    expect(await testEnv.DB.prepare('SELECT key_hash,creation_operation_id,creation_fingerprint FROM api_keys WHERE id=?').bind(created.key.id).first()).toEqual(before);
  });

  it('keeps omitted fields unchanged and distinguishes explicit null from []', async () => {
    const created = await createPlatformKey(testEnv.DB, owner, { name: 'Original', expiresAt: now + 50 }, now);
    expect(await updatePlatformKey(testEnv.DB, owner, created.key.id, 1, { allowedModels: null }, now + 1))
      .toMatchObject({ kind: 'updated', key: { name: 'Original', expiresAt: now + 50, allowedModels: null, version: 2 } });
    expect(await updatePlatformKey(testEnv.DB, owner, created.key.id, 2, { expiresAt: null, allowedModels: [] }, now + 2))
      .toMatchObject({ kind: 'updated', key: { expiresAt: null, allowedModels: [], version: 3 } });
  });

  it('has one winner for concurrent version-CAS patches with no half-update', async () => {
    const created = await createPlatformKey(testEnv.DB, owner, { name: 'Original' }, now);
    const results = await Promise.all([
      updatePlatformKey(testEnv.DB, owner, created.key.id, 1, { name: 'First', expiresAt: now + 100 }, now + 1),
      updatePlatformKey(testEnv.DB, owner, created.key.id, 1, { name: 'Second', expiresAt: now + 200 }, now + 1),
    ]);
    expect(results.filter(result => result.kind === 'updated')).toHaveLength(1);
    expect(results.filter(result => result.kind === 'not_updated')).toHaveLength(1);
    const row = await findPlatformKeyById(testEnv.DB, owner, created.key.id, now + 1);
    expect(row?.version).toBe(2);
    expect(row?.expiresAt).toBe(row?.name === 'First' ? now + 100 : now + 200);
    expect(await updatePlatformKey(testEnv.DB, owner, created.key.id, 1, { name: 'Stale' }, now + 2)).toEqual({ kind: 'not_updated' });
  });

  it('does not distinguish nonexistent from another owner Key on either mutation', async () => {
    const other = await createPlatformKey(testEnv.DB, 'other-owner', { name: 'Other' }, now);
    for (const id of ['not-found', other.key.id]) {
      expect(await updatePlatformKey(testEnv.DB, owner, id, 1, { name: 'Attempt' }, now + 1)).toEqual({ kind: 'not_updated' });
      expect(await revokePlatformKey(testEnv.DB, owner, id, 1, now + 1)).toEqual({ kind: 'not_revoked' });
    }
    expect((await findPlatformKeyById(testEnv.DB, 'other-owner', other.key.id, now + 1))?.version).toBe(1);
  });

  it.each(['model-disabled', 'channel-disabled', 'group-mapping-removed', 'other-group'])('checks current model permissions atomically: %s', async change => {
    await accessibleModel('selected');
    const created = await createPlatformKey(testEnv.DB, owner, { name: 'Before', allowedModels: ['selected'] }, now);
    if (change === 'model-disabled') await testEnv.DB.prepare("UPDATE models SET status='disabled'").run();
    if (change === 'channel-disabled') await testEnv.DB.prepare("UPDATE channels SET status='disabled'").run();
    if (change === 'group-mapping-removed') await testEnv.DB.prepare('DELETE FROM channel_groups').run();
    if (change === 'other-group') await testEnv.DB.prepare('DELETE FROM user_group_access WHERE user_id=?').bind(owner).run();
    expect(await updatePlatformKey(testEnv.DB, owner, created.key.id, 1, { name: 'Must not partially update', expiresAt: now + 99 }, now + 1)).toEqual({ kind: 'not_updated' });
    expect(await findPlatformKeyById(testEnv.DB, owner, created.key.id, now + 1)).toMatchObject({ name: 'Before', expiresAt: null, version: 1 });
    if (change === 'other-group') { expect(await updatePlatformKey(testEnv.DB, owner, created.key.id, 1, { allowedModels: [] }, now + 1)).toEqual({ kind: 'not_updated' }); return; }
    expect(await updatePlatformKey(testEnv.DB, owner, created.key.id, 1, { name: 'Safely narrowed', allowedModels: [] }, now + 1))
      .toMatchObject({ kind: 'updated', key: { allowedModels: [], version: 2 } });
  });

  it('rejects expansion to an inaccessible model without changing other fields', async () => {
    await accessibleModel('available'); await accessibleModel('foreign', 'a25-other-group');
    const created = await createPlatformKey(testEnv.DB, owner, { name: 'Before' }, now);
    expect(await updatePlatformKey(testEnv.DB, owner, created.key.id, 1, { name: 'After', allowedModels: ['available', 'foreign'] }, now + 1)).toEqual({ kind: 'not_updated' });
    expect(await findPlatformKeyById(testEnv.DB, owner, created.key.id, now + 1)).toMatchObject({ name: 'Before', allowedModels: null, version: 1 });
  });

  it.each(['user', 'group'])('does not mutate for an inactive %s', async kind => {
    const created = await createPlatformKey(testEnv.DB, owner, { name: 'Before' }, now);
    if (kind === 'user') await testEnv.DB.prepare("UPDATE users SET status='disabled' WHERE id=?").bind(owner).run();
    else await testEnv.DB.prepare("UPDATE groups SET status='disabled' WHERE id='a25-group'").run();
    expect(await updatePlatformKey(testEnv.DB, owner, created.key.id, 1, { name: 'After' }, now + 1)).toEqual({ kind: 'not_updated' });
    expect(await revokePlatformKey(testEnv.DB, owner, created.key.id, 1, now + 1)).toEqual({ kind: 'not_revoked' });
    expect(await testEnv.DB.prepare('SELECT status,version FROM api_keys WHERE id=?').bind(created.key.id).first()).toEqual({ status: 'active', version: 1 });
  });

  it('revokes once and preserves updatedAt/version on repeated or concurrent revocations', async () => {
    const created = await createPlatformKey(testEnv.DB, owner, { name: 'Revoke' }, now);
    const results = await Promise.all(Array.from({ length: 5 }, () => revokePlatformKey(testEnv.DB, owner, created.key.id, 1, now + 1)));
    expect(results.filter(result => result.kind === 'revoked')).toHaveLength(1);
    expect(results.filter(result => result.kind === 'already_revoked')).toHaveLength(4);
    expect(await revokePlatformKey(testEnv.DB, owner, created.key.id, 1, now + 100))
      .toMatchObject({ kind: 'already_revoked', key: { status: 'revoked', updatedAt: now + 1, version: 2 } });
    expect(await findInternalPlatformKeyByHash(testEnv.DB, await hashToken('apiKey', created.token), now + 100)).toBeNull();
  });

  it('requires CAS for first revocation and cannot restore a revoked Key by patching expiry or models', async () => {
    const created = await createPlatformKey(testEnv.DB, owner, { name: 'Before' }, now);
    expect(await revokePlatformKey(testEnv.DB, owner, created.key.id, 2, now + 1)).toEqual({ kind: 'not_revoked' });
    await revokePlatformKey(testEnv.DB, owner, created.key.id, 1, now + 1);
    expect(await updatePlatformKey(testEnv.DB, owner, created.key.id, 2, { name: 'Restore?', expiresAt: null, allowedModels: null }, now + 2)).toEqual({ kind: 'not_updated' });
  });

  it('does not restore status when update and revocation race on the same version', async () => {
    const created = await createPlatformKey(testEnv.DB, owner, { name: 'Race' }, now);
    await Promise.all([
      updatePlatformKey(testEnv.DB, owner, created.key.id, 1, { name: 'Updated' }, now + 1),
      revokePlatformKey(testEnv.DB, owner, created.key.id, 1, now + 1),
    ]);
    const current = await findPlatformKeyById(testEnv.DB, owner, created.key.id, now + 1);
    expect(current?.version).toBe(2);
    expect(current?.status === 'revoked' ? current.name : current?.name).toBe(current?.status === 'revoked' ? 'Race' : 'Updated');
  });

  it('allows explicit renewal of an expired active Key, and revocation even when its old model access disappeared', async () => {
    const created = await createPlatformKey(testEnv.DB, owner, { name: 'Expired', expiresAt: now + 1 }, now);
    expect(await updatePlatformKey(testEnv.DB, owner, created.key.id, 1, { expiresAt: now + 20 }, now + 10))
      .toMatchObject({ kind: 'updated', key: { status: 'active', expiresAt: now + 20 } });
    await testEnv.DB.prepare('UPDATE api_keys SET allowed_models_json=? WHERE id=?').bind('["no-longer-accessible"]', created.key.id).run();
    expect(await revokePlatformKey(testEnv.DB, owner, created.key.id, 2, now + 30)).toMatchObject({ kind: 'revoked' });
  });

  it('never changes the immutable creation fingerprint and creation retries still return current metadata only', async () => {
    const input = { operationId: 'update-replay', name: 'Original', allowedModels: [] };
    const created = await createPlatformKeyRaw(testEnv.DB, owner, input, now);
    const before = await testEnv.DB.prepare('SELECT creation_operation_id,creation_fingerprint FROM api_keys WHERE id=?').bind(created.key.id).first();
    await updatePlatformKey(testEnv.DB, owner, created.key.id, 1, { name: 'Renamed' }, now + 1);
    await revokePlatformKey(testEnv.DB, owner, created.key.id, 2, now + 2);
    const replay = await createPlatformKeyRaw(testEnv.DB, owner, input, now + 3);
    expect(replay).toMatchObject({ kind: 'replayed', key: { name: 'Renamed', status: 'revoked', version: 3 } });
    expect(replay).not.toHaveProperty('token');
    expect(await testEnv.DB.prepare('SELECT creation_operation_id,creation_fingerprint FROM api_keys WHERE id=?').bind(created.key.id).first()).toEqual(before);
  });

  it.each([{}, { status: 'active' }, { userId: 'other-owner' }, { creation_operation_id: 'rewrite' }, { creation_fingerprint: 'b'.repeat(64) },
    { name: '' }, { name: undefined }, { expiresAt: undefined }, { expiresAt: now }, { expiresAt: now - 1 },
    { allowedModels: undefined }, { allowedModels: ['x', 'x'] }])('rejects invalid/forbidden patch %# before any write', async patch => {
    const created = await createPlatformKey(testEnv.DB, owner, { name: 'Original' }, now);
    await expect(updatePlatformKey(testEnv.DB, owner, created.key.id, 1, patch, now + 1)).rejects.toThrow(TypeError);
    expect((await findPlatformKeyById(testEnv.DB, owner, created.key.id, now + 1))?.version).toBe(1);
  });

  it('refuses time reversal and version exhaustion with explicit zero-write results', async () => {
    const created = await createPlatformKey(testEnv.DB, owner, { name: 'Time' }, now);
    await updatePlatformKey(testEnv.DB, owner, created.key.id, 1, { name: 'Later' }, now + 10);
    expect(await updatePlatformKey(testEnv.DB, owner, created.key.id, 2, { name: 'Earlier' }, now + 5)).toEqual({ kind: 'not_updated' });
    expect(await revokePlatformKey(testEnv.DB, owner, created.key.id, 2, now + 5)).toEqual({ kind: 'not_revoked' });
    await testEnv.DB.prepare('UPDATE api_keys SET version=? WHERE id=?').bind(Number.MAX_SAFE_INTEGER, created.key.id).run();
    expect(await updatePlatformKey(testEnv.DB, owner, created.key.id, Number.MAX_SAFE_INTEGER, { name: 'Overflow' }, now + 11)).toEqual({ kind: 'not_updated' });
    expect(await revokePlatformKey(testEnv.DB, owner, created.key.id, Number.MAX_SAFE_INTEGER, now + 11)).toEqual({ kind: 'not_revoked' });
  });
});

describe('platform Key reads on native D1', () => {
  it('projects only metadata in owner-scoped get/list, never hash/fingerprint/token', async () => {
    const key = await createPlatformKey(testEnv.DB, owner, { name: 'Owner Key' }, now);
    const other = await createPlatformKey(testEnv.DB, 'other-owner', { name: 'Other Key' }, now);
    expect(await findPlatformKeyById(testEnv.DB, owner, key.key.id, now)).toEqual(key.key);
    expect(await findPlatformKeyById(testEnv.DB, owner, other.key.id, now)).toBeNull();
    expect(await findPlatformKeyById(testEnv.DB, owner, 'unknown', now)).toBeNull();
    const page = await listPlatformKeys(testEnv.DB, owner, {}, now);
    expect(page).toEqual({ items: [key.key], nextCursor: null });
    for (const secret of [key.token, await hashToken('apiKey', key.token), 'creation_fingerprint', 'creation_operation_id']) {
      expect(JSON.stringify(page)).not.toContain(secret);
    }
  });

  it('returns internally needed owner/group status, limits and exact balance without secrets', async () => {
    const created = await createPlatformKey(testEnv.DB, owner, { name: 'Auth', allowedModels: null }, now);
    await testEnv.DB.prepare('UPDATE users SET balance_units=-123,concurrency_limit=3,rpm_limit=75 WHERE id=?').bind(owner).run();
    const internal = await findInternalPlatformKeyByHash(testEnv.DB, await hashToken('apiKey', created.token), now);
    expect(internal).toEqual({ key: created.key,
      user: { id: owner, status: 'active', role: 'user', version: 1, balanceUnits: '-123', concurrencyLimit: 3, rpmLimit: 75 },
      group: { id: 'a25-group', status: 'active', version: 1 } });
    expect(JSON.stringify(internal)).not.toContain(created.token);
    expect(internal).not.toHaveProperty('key_hash');
    expect(internal).not.toHaveProperty('password_hash');
  });

  it('distinguishes SQL NULL inheritance from [] on every read path', async () => {
    const inherited = await createPlatformKey(testEnv.DB, owner, { name: 'Inherited', allowedModels: null }, now);
    const empty = await createPlatformKey(testEnv.DB, owner, { name: 'Empty', allowedModels: [] }, now);
    expect((await findPlatformKeyById(testEnv.DB, owner, inherited.key.id, now))?.allowedModels).toBeNull();
    expect((await findPlatformKeyById(testEnv.DB, owner, empty.key.id, now))?.allowedModels).toEqual([]);
    expect((await findInternalPlatformKeyByHash(testEnv.DB, await hashToken('apiKey', inherited.token), now))?.key.allowedModels).toBeNull();
    expect((await findInternalPlatformKeyByHash(testEnv.DB, await hashToken('apiKey', empty.token), now))?.key.allowedModels).toEqual([]);
  });

  it('enforces the exact expiry boundary for auth but keeps expired metadata visible', async () => {
    const created = await createPlatformKey(testEnv.DB, owner, { name: 'Expires', expiresAt: now + 10 }, now);
    const hash = await hashToken('apiKey', created.token);
    expect(await findInternalPlatformKeyByHash(testEnv.DB, hash, now + 9)).not.toBeNull();
    expect(await findInternalPlatformKeyByHash(testEnv.DB, hash, now + 10)).toBeNull();
    expect(await findInternalPlatformKeyByHash(testEnv.DB, hash, now + 11)).toBeNull();
    expect(await findPlatformKeyById(testEnv.DB, owner, created.key.id, now + 10)).toEqual(created.key);
    expect((await listPlatformKeys(testEnv.DB, owner, { state: 'active' }, now + 10)).items).toEqual([]);
    expect((await listPlatformKeys(testEnv.DB, owner, { state: 'expired' }, now + 10)).items).toHaveLength(1);
  });

  it('excludes revoked Keys from auth, with revoked state taking precedence over expiry', async () => {
    const created = await createPlatformKey(testEnv.DB, owner, { name: 'Revoked', expiresAt: now + 1 }, now);
    await testEnv.DB.prepare("UPDATE api_keys SET status='revoked' WHERE id=?").bind(created.key.id).run();
    expect(await findInternalPlatformKeyByHash(testEnv.DB, await hashToken('apiKey', created.token), now + 2)).toBeNull();
    expect((await listPlatformKeys(testEnv.DB, owner, { state: 'revoked' }, now + 2)).items).toHaveLength(1);
    expect((await listPlatformKeys(testEnv.DB, owner, { state: 'expired' }, now + 2)).items).toEqual([]);
    expect((await findPlatformKeyById(testEnv.DB, owner, created.key.id, now + 2))?.status).toBe('revoked');
  });

  it.each(['user', 'group'])('returns no data for inactive %s on all three read paths', async kind => {
    const created = await createPlatformKey(testEnv.DB, owner, { name: 'Disabled owner' }, now);
    if (kind === 'user') await testEnv.DB.prepare("UPDATE users SET status='disabled' WHERE id=?").bind(owner).run();
    else await testEnv.DB.prepare("UPDATE groups SET status='disabled' WHERE id='a25-group'").run();
    expect(await findPlatformKeyById(testEnv.DB, owner, created.key.id, now)).toBeNull();
    expect(await listPlatformKeys(testEnv.DB, owner, {}, now)).toEqual({ items: [], nextCursor: null });
    expect(await findInternalPlatformKeyByHash(testEnv.DB, await hashToken('apiKey', created.token), now)).toBeNull();
  });

  it('does not authorize missing hashes or future-created Keys', async () => {
    const created = await createPlatformKey(testEnv.DB, owner, { name: 'Future' }, now + 1);
    expect(await findInternalPlatformKeyByHash(testEnv.DB, '0'.repeat(64), now)).toBeNull();
    expect(await findInternalPlatformKeyByHash(testEnv.DB, await hashToken('apiKey', created.token), now)).toBeNull();
    expect(await findPlatformKeyById(testEnv.DB, owner, created.key.id, now)).toBeNull();
  });

  it('pages equal timestamps by ID without duplicates and excludes later creations from the cursor snapshot', async () => {
    const expected = [];
    for (let index = 0; index < 7; index++) expected.push((await createPlatformKey(testEnv.DB, owner, { name: `Key ${index}` }, now + (index > 4 ? 1 : 0))).key);
    expected.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
    const first = await listPlatformKeys(testEnv.DB, owner, { limit: 2 }, now + 2);
    expect(first.items).toEqual(expected.slice(0, 2));
    await createPlatformKey(testEnv.DB, owner, { name: 'Later' }, now + 3);
    const found = [...first.items];
    let cursor = first.nextCursor;
    while (cursor !== null) {
      const next = await listPlatformKeys(testEnv.DB, owner, { limit: 2, cursor }, now + 4);
      found.push(...next.items); cursor = next.nextCursor;
    }
    expect(found).toEqual(expected);
    expect(new Set(found.map(key => key.id)).size).toBe(7);
  });

  it('binds cursors to owner and state and preserves expiry asOf while time advances', async () => {
    for (let index = 0; index < 3; index++) await createPlatformKey(testEnv.DB, owner, { name: `Timed ${index}`, expiresAt: now + 10 }, now);
    const page = await listPlatformKeys(testEnv.DB, owner, { limit: 1, state: 'active' }, now);
    expect(page.nextCursor).not.toBeNull();
    await expect(listPlatformKeys(testEnv.DB, 'other-owner', { limit: 1, state: 'active', cursor: page.nextCursor }, now)).rejects.toThrow(TypeError);
    await expect(listPlatformKeys(testEnv.DB, owner, { limit: 1, state: 'expired', cursor: page.nextCursor }, now)).rejects.toThrow(TypeError);
    expect((await listPlatformKeys(testEnv.DB, owner, { limit: 2, state: 'active', cursor: page.nextCursor }, now + 20)).items).toHaveLength(2);
    expect((await listPlatformKeys(testEnv.DB, owner, { state: 'active' }, now + 20)).items).toEqual([]);
  });

  it.each(['[null]', '[1]', '[""]', '["x","x"]', '[" bad "]', JSON.stringify(Array.from({ length: 101 }, (_, i) => `m${i}`))])('fails closed on malformed stored restrictions %#', async json => {
    const created = await createPlatformKey(testEnv.DB, owner, { name: 'Malformed' }, now);
    await testEnv.DB.prepare('UPDATE api_keys SET allowed_models_json=? WHERE id=?').bind(json, created.key.id).run();
    await expect(findPlatformKeyById(testEnv.DB, owner, created.key.id, now)).rejects.toThrow(PlatformKeyStorageError);
    await expect(listPlatformKeys(testEnv.DB, owner, {}, now)).rejects.toThrow(PlatformKeyStorageError);
    await expect(findInternalPlatformKeyByHash(testEnv.DB, await hashToken('apiKey', created.token), now)).rejects.toThrow(PlatformKeyStorageError);
  });

  it('fails closed on invalid metadata instead of returning it with valid-looking permissions', async () => {
    const created = await createPlatformKey(testEnv.DB, owner, { name: 'Malformed metadata' }, now);
    await testEnv.DB.prepare('UPDATE api_keys SET updated_at=? WHERE id=?').bind(now - 1, created.key.id).run();
    await expect(findInternalPlatformKeyByHash(testEnv.DB, await hashToken('apiKey', created.token), now)).rejects.toThrow(PlatformKeyStorageError);
    await expect(findPlatformKeyById(testEnv.DB, owner, created.key.id, now)).rejects.toThrow(PlatformKeyStorageError);
  });

  it.each(['', 'not-base64!', 'W10', 'a'.repeat(1025)])('rejects malformed cursors %#', async cursor => {
    await expect(listPlatformKeys(testEnv.DB, owner, { cursor }, now)).rejects.toThrow(TypeError);
  });
  it('rejects UTF-8 BOM cursors rather than silently stripping their prefix', async () => {
    await createPlatformKey(testEnv.DB, owner, { name: 'BOM 1' }, now);
    await createPlatformKey(testEnv.DB, owner, { name: 'BOM 2' }, now);
    const page = await listPlatformKeys(testEnv.DB, owner, { limit: 1 }, now);
    const cursor = page.nextCursor!;
    const raw = atob(cursor.replace(/-/g, '+').replace(/_/g, '/'));
    const withBom = btoa(String.fromCharCode(0xef, 0xbb, 0xbf) + raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    await expect(listPlatformKeys(testEnv.DB, owner, { limit: 1, cursor: withBom }, now)).rejects.toThrow(TypeError);
    expect((await listPlatformKeys(testEnv.DB, owner, { limit: 1, cursor }, now)).items).toHaveLength(1);
  });
  it('fails closed on malformed group version instead of exposing an auth context', async () => {
    const created = await createPlatformKey(testEnv.DB, owner, { name: 'Bad group metadata' }, now);
    // D01 checks integer/positivity, but not the JavaScript safe-integer ceiling.
    await testEnv.DB.prepare("UPDATE groups SET version=9007199254740992 WHERE id='a25-group'").run();
    await expect(findInternalPlatformKeyByHash(testEnv.DB, await hashToken('apiKey', created.token), now)).rejects.toThrow(PlatformKeyStorageError);
  });
  it.each([0, 101, 1.2, NaN])('bounds page size %s', async limit => {
    await expect(listPlatformKeys(testEnv.DB, owner, { limit }, now)).rejects.toThrow(TypeError);
  });
  it('validates injected time, owner and hash format', async () => {
    await expect(findPlatformKeyById(testEnv.DB, '', 'key', now)).rejects.toThrow(TypeError);
    await expect(listPlatformKeys(testEnv.DB, owner, {}, -1)).rejects.toThrow(TypeError);
    await expect(findInternalPlatformKeyByHash(testEnv.DB, 's2a_key_raw', now)).rejects.toThrow(TypeError);
    await expect(findInternalPlatformKeyByHash(testEnv.DB, 'A'.repeat(64), now)).rejects.toThrow(TypeError);
  });
});

describe('platform Key creation on native D1', () => {
  it('returns a 256-bit secret once and persists only its digest and display prefix', async () => {
    const created = await createPlatformKey(testEnv.DB, owner, { name: 'Console Key' }, now);
    expect(TOKEN_SECRET_BYTES).toBe(32);
    expect(created.token).toMatch(/^s2a_key_[A-Za-z0-9_-]{43}$/);
    expect(created.key.displayPrefix).toBe(created.token.slice(0, 16));
    const row = await testEnv.DB.prepare('SELECT * FROM api_keys WHERE id=?').bind(created.key.id).first();
    expect(row).toMatchObject({ user_id: owner, key_hash: await hashToken('apiKey', created.token), display_prefix: created.key.displayPrefix,
      name: 'Console Key', status: 'active', expires_at: null, allowed_models_json: null, created_at: now, updated_at: now, version: 1 });
    expect(JSON.stringify(row)).not.toContain(created.token);
    expect(created.key).not.toHaveProperty('keyHash');
    expect(created.key.allowedModels).toBeNull();
  });

  it('distinguishes explicit null inheritance from an empty restriction with no model seeds', async () => {
    const inherited = await createPlatformKey(testEnv.DB, owner, { name: 'Inherited', allowedModels: null }, now);
    const denied = await createPlatformKey(testEnv.DB, owner, { name: 'No models', allowedModels: [] }, now);
    expect(inherited.key.allowedModels).toBeNull();
    expect(await testEnv.DB.prepare('SELECT allowed_models_json FROM api_keys WHERE id=?').bind(inherited.key.id).first('allowed_models_json')).toBeNull();
    expect(await testEnv.DB.prepare('SELECT allowed_models_json FROM api_keys WHERE id=?').bind(denied.key.id).first('allowed_models_json')).toBe('[]');
  });

  it('stores a permitted subset and precise expiry without changing user/group state', async () => {
    await accessibleModel('model-a'); await accessibleModel('model-b');
    const created = await createPlatformKey(testEnv.DB, owner, { name: 'Subset', allowedModels: ['model-b'], expiresAt: now + 1 }, now);
    expect(created.key.allowedModels).toEqual(['model-b']);
    expect(created.key.expiresAt).toBe(now + 1);
    expect(await testEnv.DB.prepare('SELECT balance_units FROM users WHERE id=?').bind(owner).first('balance_units')).toBe(0);
  });

  it.each(['missing', 'other-group', 'disabled-model', 'disabled-channel', 'removed-mapping'])('does not grant unavailable model selection %s', async kind => {
    if (kind !== 'missing') await accessibleModel('target', kind === 'other-group' ? 'a25-other-group' : 'a25-group');
    if (kind === 'disabled-model') await testEnv.DB.prepare("UPDATE models SET status='disabled' WHERE public_model_id='target'").run();
    if (kind === 'disabled-channel') await testEnv.DB.prepare("UPDATE channels SET status='disabled'").run();
    if (kind === 'removed-mapping') await testEnv.DB.prepare('DELETE FROM channel_models').run();
    await expect(createPlatformKey(testEnv.DB, owner, { name: 'Denied', allowedModels: ['target'] }, now)).rejects.toThrow(PlatformKeyCreationError);
    expect(await testEnv.DB.prepare('SELECT COUNT(*) FROM api_keys').first('COUNT(*)')).toBe(0);
  });

  it.each(['missing-owner', 'disabled-owner', 'disabled-group', 'future-owner'])('rechecks owner/group at insertion: %s', async kind => {
    if (kind === 'disabled-owner') await testEnv.DB.prepare("UPDATE users SET status='disabled' WHERE id=?").bind(owner).run();
    if (kind === 'disabled-group') await testEnv.DB.prepare("UPDATE groups SET status='disabled' WHERE id='a25-group'").run();
    if (kind === 'future-owner') await testEnv.DB.prepare('UPDATE users SET created_at=? WHERE id=?').bind(now + 1, owner).run();
    await expect(createPlatformKey(testEnv.DB, kind === 'missing-owner' ? 'missing' : owner, { name: 'Denied', allowedModels: null }, now)).rejects.toThrow(PlatformKeyCreationError);
    expect(await testEnv.DB.prepare('SELECT COUNT(*) FROM api_keys').first('COUNT(*)')).toBe(0);
  });

  it('rejects a mixed accessible/inaccessible selection without a partial key', async () => {
    await accessibleModel('allowed');
    await expect(createPlatformKey(testEnv.DB, owner, { name: 'Mixed', allowedModels: ['allowed', 'not-allowed'] }, now)).rejects.toThrow(PlatformKeyCreationError);
    expect(await testEnv.DB.prepare('SELECT COUNT(*) FROM api_keys').first('COUNT(*)')).toBe(0);
  });

  it('takes ownership only from the trusted parameter, rejecting body ownership', async () => {
    for (const extra of [{ userId: 'other-owner' }, { ownerId: 'other-owner' }]) {
      await expect(createPlatformKey(testEnv.DB, owner, { name: 'Invalid', ...extra }, now)).rejects.toThrow(TypeError);
    }
    const created = await createPlatformKey(testEnv.DB, 'other-owner', { name: 'Other' }, now);
    expect(created.key.userId).toBe('other-owner');
  });

  it('makes independent tokens on concurrent/retried creation, never recovering earlier plaintext', async () => {
    const [a, b] = await Promise.all([
      createPlatformKey(testEnv.DB, owner, { name: 'Same request' }, now),
      createPlatformKey(testEnv.DB, owner, { name: 'Same request' }, now),
    ]);
    expect(a.token).not.toBe(b.token); expect(a.key.id).not.toBe(b.key.id);
    expect(await testEnv.DB.prepare('SELECT COUNT(*) FROM api_keys').first('COUNT(*)')).toBe(2);
    const persisted = await testEnv.DB.prepare('SELECT * FROM api_keys').all();
    expect(JSON.stringify(persisted.results)).not.toContain(a.token);
    expect(JSON.stringify(persisted.results)).not.toContain(b.token);
  });

  it.each(['', ' ', 'new\nline', 'x'.repeat(129), `s2a_key_${'A'.repeat(43)}`])('rejects invalid/sensitive names %#', async name => {
    await expect(createPlatformKey(testEnv.DB, owner, { name }, now)).rejects.toThrow(TypeError);
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('validates timestamps %s', async invalid => {
    await expect(createPlatformKey(testEnv.DB, owner, { name: 'Time' }, invalid)).rejects.toThrow(TypeError);
    await expect(createPlatformKey(testEnv.DB, owner, { name: 'Time', expiresAt: invalid }, now)).rejects.toThrow(TypeError);
  });

  it('rejects expiry at creation or earlier', async () => {
    for (const expiresAt of [now, now - 1]) await expect(createPlatformKey(testEnv.DB, owner, { name: 'Expired', expiresAt }, now)).rejects.toThrow(TypeError);
  });

  it.each([[''], [' x'], ['x', 'x'], ['x\n'], ['x'.repeat(129)], Array.from({ length: 101 }, (_, i) => `m-${i}`)].map(models => [models]))('rejects malformed model selection %#', async models => {
    await expect(createPlatformKey(testEnv.DB, owner, { name: 'Models', allowedModels: models }, now)).rejects.toThrow(TypeError);
  });
});

describe('platform Key creation idempotency on native D1', () => {
  const input = (): CreatePlatformKeyInput => ({ operationId: 'request-1', name: 'Original', allowedModels: [] });

  it('replays an ACK-lost creation with metadata only and no regenerated credential', async () => {
    const first = await createPlatformKeyRaw(testEnv.DB, owner, input(), now);
    expect(first.kind).toBe('created');
    const replay = await createPlatformKeyRaw(testEnv.DB, owner, input(), now + 1);
    expect(replay).toEqual({ kind: 'replayed', key: first.key });
    expect(replay).not.toHaveProperty('token');
    expect(replay.key).not.toHaveProperty('creation_fingerprint');
    expect(replay.key).not.toHaveProperty('key_hash');
    expect(await testEnv.DB.prepare('SELECT COUNT(*) FROM api_keys').first('COUNT(*)')).toBe(1);
  });

  it('has exactly one token winner for concurrent identical operations', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => createPlatformKeyRaw(testEnv.DB, owner, input(), now)));
    expect(results.filter(result => result.kind === 'created')).toHaveLength(1);
    expect(results.filter(result => result.kind === 'replayed')).toHaveLength(7);
    expect(new Set(results.map(result => result.key.id)).size).toBe(1);
    expect(results.filter(result => 'token' in result)).toHaveLength(1);
  });

  it('makes concurrent different payloads conflict and maps conflict to HTTP 409', async () => {
    const results = await Promise.allSettled([
      createPlatformKeyRaw(testEnv.DB, owner, input(), now),
      createPlatformKeyRaw(testEnv.DB, owner, { ...input(), name: 'Different' }, now),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejection = results.find(result => result.status === 'rejected');
    expect(rejection?.status).toBe('rejected');
    if (rejection?.status === 'rejected') {
      expect(rejection.reason).toBeInstanceOf(PlatformKeyCreationConflict);
      expect(apiError(rejection.reason, 'test-request').status).toBe(409);
    }
  });

  it('normalizes display name and model ordering, without normalizing model identifiers', async () => {
    await accessibleModel('Model-A'); await accessibleModel('model-b');
    const first = await createPlatformKeyRaw(testEnv.DB, owner, { ...input(), name: '  Cafe\u0301  ', allowedModels: ['model-b', 'Model-A'] }, now);
    expect(first.key.name).toBe('Café');
    expect(first.key.allowedModels).toEqual(['Model-A', 'model-b']);
    expect((await createPlatformKeyRaw(testEnv.DB, owner, { ...input(), name: 'Café', allowedModels: ['Model-A', 'model-b'] }, now + 1)).kind).toBe('replayed');
    const row = await testEnv.DB.prepare('SELECT creation_fingerprint,creation_operation_id,name FROM api_keys WHERE id=?').bind(first.key.id).first();
    expect(row).toMatchObject({ creation_operation_id: 'request-1', name: 'Café' });
    expect(row?.creation_fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('fingerprints expiry and distinguishes inheritance from an empty model restriction', async () => {
    await createPlatformKeyRaw(testEnv.DB, owner, input(), now);
    for (const changed of [{ ...input(), allowedModels: null }, { ...input(), expiresAt: now + 1000 }, { ...input(), name: 'Changed' }]) {
      await expect(createPlatformKeyRaw(testEnv.DB, owner, changed, now + 1)).rejects.toThrow(PlatformKeyCreationConflict);
    }
    expect((await createPlatformKeyRaw(testEnv.DB, owner, { operationId: 'request-1', name: 'Original', expiresAt: null, allowedModels: [] }, now + 1)).kind).toBe('replayed');
  });

  it('returns current metadata after rename/revoke/expiry without changing the creation fingerprint', async () => {
    const original = { ...input(), expiresAt: now + 10 };
    const first = await createPlatformKeyRaw(testEnv.DB, owner, original, now);
    const hash = await testEnv.DB.prepare('SELECT creation_fingerprint FROM api_keys WHERE id=?').bind(first.key.id).first('creation_fingerprint');
    await testEnv.DB.prepare("UPDATE api_keys SET name='Renamed',status='revoked',expires_at=?,updated_at=?,version=2 WHERE id=?")
      .bind(now + 20, now + 1, first.key.id).run();
    const replay = await createPlatformKeyRaw(testEnv.DB, owner, original, now + 100);
    expect(replay).toMatchObject({ kind: 'replayed', key: { id: first.key.id, name: 'Renamed', status: 'revoked', expiresAt: now + 20, version: 2 } });
    expect(replay).not.toHaveProperty('token');
    expect(await testEnv.DB.prepare('SELECT creation_fingerprint FROM api_keys WHERE id=?').bind(first.key.id).first('creation_fingerprint')).toBe(hash);
    await expect(createPlatformKeyRaw(testEnv.DB, owner, { ...original, name: 'Renamed' }, now + 100)).rejects.toThrow(PlatformKeyCreationConflict);
  });

  it('scopes identical operation IDs to their authenticated owners', async () => {
    const first = await createPlatformKeyRaw(testEnv.DB, owner, input(), now);
    const other = await createPlatformKeyRaw(testEnv.DB, 'other-owner', input(), now);
    expect(other.kind).toBe('created');
    expect(other.key.id).not.toBe(first.key.id);
    expect((await createPlatformKeyRaw(testEnv.DB, 'other-owner', input(), now + 1)).key.id).toBe(other.key.id);
  });

  it.each(['owner', 'group'])('does not replay metadata for a disabled %s', async disabled => {
    await createPlatformKeyRaw(testEnv.DB, owner, input(), now);
    if (disabled === 'owner') await testEnv.DB.prepare("UPDATE users SET status='disabled' WHERE id=?").bind(owner).run();
    else await testEnv.DB.prepare("UPDATE groups SET status='disabled' WHERE id='a25-group'").run();
    await expect(createPlatformKeyRaw(testEnv.DB, owner, input(), now + 1)).rejects.toThrow(PlatformKeyCreationError);
  });

  it('does not treat an unrelated primary-key collision as an operation replay', async () => {
    const first = await createPlatformKeyRaw(testEnv.DB, owner, input(), now);
    const spy = vi.spyOn(crypto, 'randomUUID').mockReturnValue(first.key.id as `${string}-${string}-${string}-${string}-${string}`);
    try {
      await expect(createPlatformKeyRaw(testEnv.DB, owner, { ...input(), operationId: 'different-operation' }, now + 1)).rejects.toThrow();
    } finally { spy.mockRestore(); }
    expect(await testEnv.DB.prepare('SELECT COUNT(*) FROM api_keys').first('COUNT(*)')).toBe(1);
  });

  it('propagates unrelated insertion failures even when an operation already exists', async () => {
    await createPlatformKeyRaw(testEnv.DB, owner, input(), now);
    await testEnv.DB.prepare("CREATE TRIGGER a25_test_failure BEFORE INSERT ON api_keys BEGIN SELECT RAISE(ABORT,'synthetic_storage_failure'); END").run();
    await expect(createPlatformKeyRaw(testEnv.DB, owner, input(), now + 1)).rejects.toThrow('synthetic_storage_failure');
  });

  it.each(['', ' ', 'bad/id', 'bad\n', 'x'.repeat(129)])('requires a schema-compatible operation ID %#', async operationId => {
    await expect(createPlatformKeyRaw(testEnv.DB, owner, { ...input(), operationId }, now)).rejects.toThrow(TypeError);
  });
  it('requires operationId rather than implicitly generating retry identity', async () => {
    await expect(createPlatformKeyRaw(testEnv.DB, owner, { name: 'Missing' } as CreatePlatformKeyInput, now)).rejects.toThrow(TypeError);
  });
});
