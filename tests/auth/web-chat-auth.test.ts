import { beforeEach, describe, expect, it } from 'vitest';
import { authenticateWebChat, WebChatAuthError } from '../../apps/worker/auth/web-chat-auth';
import { authenticatePlatformKey } from '../../apps/worker/auth/api-key-auth';
import { findPlatformKeyById, listPlatformKeys, revokePlatformKey, updatePlatformKey } from '../../apps/worker/auth/key-repository';
import { testEnv } from '../helpers/database';

const now = 10_000;

beforeEach(async () => {
  for (const id of ['web-owner-group', 'web-shared-group']) {
    await testEnv.DB.prepare('INSERT INTO groups(id,name,status,version,created_at,updated_at) VALUES(?,?,?,1,0,0)')
      .bind(id, id, 'active').run();
  }
  await testEnv.DB.prepare(`INSERT INTO users
    (id,email_normalized,password_hash,role,status,group_id,balance_units,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
    VALUES('web-owner','web-owner@example.invalid','test','user','active','web-owner-group',100,2,60,'admin',0,0)`).run();
  await testEnv.DB.prepare(`INSERT INTO users
    (id,email_normalized,password_hash,role,status,group_id,balance_units,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
    VALUES('web-other','web-other@example.invalid','test','user','active','web-owner-group',100,2,60,'admin',0,0)`).run();
  await testEnv.DB.prepare("INSERT INTO user_group_access(user_id,group_id,created_at) VALUES('web-owner','web-shared-group',0)").run();
});

describe('web-chat virtual Key authentication', () => {
  it('creates one group-less identity and scopes each result to the selected grant', async () => {
    const first = await authenticateWebChat(testEnv.DB, 'web-owner', 'web-owner-group', now);
    expect(first.key).toMatchObject({ kind: 'web_chat', userId: 'web-owner', groupId: null, groupName: null, displayPrefix: null, allowedModels: null });
    expect(first.group).toMatchObject({ id: 'web-owner-group', status: 'active' });
    const second = await authenticateWebChat(testEnv.DB, 'web-owner', 'web-shared-group', now);
    expect(second.key.id).toBe(first.key.id);
    expect(second.key.groupId).toBeNull();
    expect(second.group.id).toBe('web-shared-group');
    expect(await testEnv.DB.prepare("SELECT COUNT(*) FROM api_keys WHERE user_id='web-owner' AND kind='web_chat'").first('COUNT(*)')).toBe(1);
    expect(await testEnv.DB.prepare("SELECT group_id,key_hash,display_prefix FROM api_keys WHERE id=?").bind(first.key.id).first())
      .toEqual({ group_id: null, key_hash: null, display_prefix: null });
  });

  it('collapses concurrent first use into the unique per-user row', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => authenticateWebChat(testEnv.DB, 'web-owner', 'web-owner-group', now)));
    expect(new Set(results.map(result => result.key.id)).size).toBe(1);
    expect(await testEnv.DB.prepare("SELECT COUNT(*) FROM api_keys WHERE user_id='web-owner' AND kind='web_chat'").first('COUNT(*)')).toBe(1);
  });

  it('rechecks membership and active state on every call and never becomes a Bearer key', async () => {
    const first = await authenticateWebChat(testEnv.DB, 'web-owner', 'web-owner-group', now);
    await expect(authenticateWebChat(testEnv.DB, 'web-other', 'web-shared-group', now)).rejects.toMatchObject({ reason: 'unauthorized' });
    await testEnv.DB.prepare("DELETE FROM user_group_access WHERE user_id='web-owner' AND group_id='web-shared-group'").run();
    await expect(authenticateWebChat(testEnv.DB, 'web-owner', 'web-shared-group', now)).rejects.toMatchObject({ reason: 'unauthorized' });
    await testEnv.DB.prepare("UPDATE api_keys SET status='revoked' WHERE id=?").bind(first.key.id).run();
    await expect(authenticateWebChat(testEnv.DB, 'web-owner', 'web-owner-group', now)).rejects.toMatchObject({ reason: 'unauthorized' });
    await expect(authenticatePlatformKey(testEnv.DB, new Request('https://example.invalid', { headers: { 'x-api-key': 's2a_key_' + 'A'.repeat(43) } }), now))
      .rejects.toMatchObject({ reason: 'invalid_api_key' });
    expect(await testEnv.DB.prepare("SELECT COUNT(*) FROM api_keys WHERE user_id='web-owner' AND kind='web_chat'").first('COUNT(*)')).toBe(1);
  });

  it('keeps virtual rows outside every ordinary self-service Key operation', async () => {
    const auth = await authenticateWebChat(testEnv.DB, 'web-owner', 'web-owner-group', now);
    expect(await findPlatformKeyById(testEnv.DB, 'web-owner', auth.key.id, now)).toBeNull();
    expect((await listPlatformKeys(testEnv.DB, 'web-owner', {}, now)).items).toEqual([]);
    expect(await updatePlatformKey(testEnv.DB, 'web-owner', auth.key.id, 1, { name: 'attempt' }, now))
      .toEqual({ kind: 'not_updated' });
    expect(await revokePlatformKey(testEnv.DB, 'web-owner', auth.key.id, 1, now))
      .toEqual({ kind: 'not_revoked' });
  });

  it.each([
    ['', 'web-owner-group', now], ['web-owner', '', now], ['web-owner', 'web-owner-group', -1],
  ] as const)('rejects malformed trusted context %#', async (userId, groupId, at) => {
    await expect(authenticateWebChat(testEnv.DB, userId, groupId, at)).rejects.toBeInstanceOf(WebChatAuthError);
  });
});
