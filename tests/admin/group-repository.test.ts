import { beforeEach, describe, expect, it } from 'vitest';
import { createGroup, getGroupById, listGroups, updateGroup } from '../../apps/worker/admin/group-repository';
import { prepare } from '../../apps/worker/db';
import { testEnv } from '../helpers/database';

const now = 1_788_619_000_000;
const actor = { actorId: 'c06-admin', operationId: 'c06-op', now };
beforeEach(async () => {
  await prepare(testEnv.DB, 'INSERT INTO groups(id,name,status,version,created_at,updated_at) VALUES(?,?,?,?,?,?)',
    ['c06-admin-group', 'C06 Admin Group', 'active', 1, now - 1, now - 1]).run();
  await prepare(testEnv.DB, `INSERT INTO users(id,email_normalized,password_hash,role,status,group_id,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
    VALUES(?,?,?,'admin','active',?,2,60,'admin',?,?)`,
    [actor.actorId, 'c06@example.invalid', 'test-only-hash', 'c06-admin-group', now, now]).run();
  for (const channel of ['c06-channel-a', 'c06-channel-b']) {
    const credential = 'test-upstream-key';
    await prepare(testEnv.DB, `INSERT INTO channels(id,name,base_url,upstream_key,status,priority,concurrency_limit,rpm_limit,config_version,created_at,updated_at)
      VALUES(?,?,?,?,'active',1,2,60,1,?,?)`,
      [channel, channel, 'https://example.invalid', credential, now, now]).run();
  }
});

describe('group configuration and channel relationships on native D1', () => {
  it('accepts more than 100 channel relationships and audits all additions', async () => {
    const channelIds = Array.from({ length: 101 }, (_, i) => `many-channel-${i}`).sort();
    await prepare(testEnv.DB, `INSERT INTO channels(id,name,base_url,upstream_key,status,priority,concurrency_limit,rpm_limit,config_version,created_at,updated_at)
      SELECT value,value,'http://localhost:8080/v1','test-key','active',0,2,60,1,?,? FROM json_each(?)`,
      [now,now,JSON.stringify(channelIds)]).run();
    const group = await createGroup(testEnv.DB, { name: 'Many channels', channelIds }, actor);
    expect((await getGroupById(testEnv.DB, group.id))!.channelIds).toEqual(channelIds);
    expect(await testEnv.DB.prepare("SELECT count(*) FROM admin_audit WHERE target_id=? AND action='group.channel.attach'")
      .bind(group.id).first('count(*)')).toBe(101);
  });

  it('creates deduplicated relationships with same-transaction audit', async () => {
    const group = await createGroup(testEnv.DB, { name: 'Target', channelIds: ['c06-channel-b', 'c06-channel-a', 'c06-channel-a'] }, actor);
    expect(group.channelIds).toEqual(['c06-channel-a', 'c06-channel-b']);
    expect(group.version).toBe(1);
    expect(await getGroupById(testEnv.DB, group.id)).toEqual(group);
    const audits = await prepare(testEnv.DB, 'SELECT action,redacted_change_json FROM admin_audit WHERE target_id=?', [group.id]).all();
    expect(audits.rows.map(row => row.action).sort()).toEqual(['group.channel.attach', 'group.channel.attach', 'group.create']);
    expect(JSON.stringify(audits.rows)).toContain('c06-channel-a');
    expect((await prepare(testEnv.DB, 'SELECT group_id FROM users WHERE id=?', [actor.actorId]).first())?.group_id).toBe('c06-admin-group');
  });

  it('atomically replaces relationships and increments the group CAS version', async () => {
    const group = await createGroup(testEnv.DB, { name: 'Target', channelIds: ['c06-channel-a'] }, actor);
    const updated = await updateGroup(testEnv.DB, group.id, 1, { name: 'Renamed', channelIds: ['c06-channel-b', 'c06-channel-b'] }, actor);
    expect(updated).toMatchObject({ name: 'Renamed', version: 2, channelIds: ['c06-channel-b'] });
    expect((await prepare(testEnv.DB, 'SELECT channel_id FROM channel_groups WHERE group_id=?', [group.id]).all()).rows)
      .toEqual([{ channel_id: 'c06-channel-b' }]);
    await expect(updateGroup(testEnv.DB, group.id, 1, { channelIds: [] }, actor)).rejects.toMatchObject({ code: 'conflict' });
    expect((await getGroupById(testEnv.DB, group.id))?.channelIds).toEqual(['c06-channel-b']);
  });

  it('permits only one concurrent writer for an expected version', async () => {
    const group = await createGroup(testEnv.DB, { name: 'CAS' }, actor);
    const results = await Promise.allSettled([
      updateGroup(testEnv.DB, group.id, 1, { channelIds: ['c06-channel-a'] }, { ...actor, operationId: 'c06-race-a' }),
      updateGroup(testEnv.DB, group.id, 1, { channelIds: ['c06-channel-b'] }, { ...actor, operationId: 'c06-race-b' }),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect((await getGroupById(testEnv.DB, group.id))?.version).toBe(2);
    expect((await prepare(testEnv.DB, "SELECT COUNT(*) AS n FROM admin_audit WHERE target_id=? AND action='group.update'", [group.id]).first())?.n).toBe(1);
  });

  it('rolls back group and relationship changes when audit fails', async () => {
    const group = await createGroup(testEnv.DB, { name: 'Rollback', channelIds: ['c06-channel-a'] }, actor);
    await prepare(testEnv.DB, "CREATE TRIGGER c06_fail_audit BEFORE INSERT ON admin_audit BEGIN SELECT RAISE(ABORT,'test audit failure'); END").run();
    await expect(updateGroup(testEnv.DB, group.id, 1, { channelIds: ['c06-channel-b'] }, actor)).rejects.toMatchObject({ code: 'service_unavailable' });
    expect(await getGroupById(testEnv.DB, group.id)).toEqual(group);
    await expect(createGroup(testEnv.DB, { name: 'Never committed' }, actor)).rejects.toMatchObject({ code: 'service_unavailable' });
    expect(await prepare(testEnv.DB, 'SELECT id FROM groups WHERE name=?', ['Never committed']).first()).toBeNull();
  });

  it('rolls back invalid channel references and duplicate names', async () => {
    const group = await createGroup(testEnv.DB, { name: 'Unique', channelIds: ['c06-channel-a'] }, actor);
    await expect(updateGroup(testEnv.DB, group.id, 1, { channelIds: ['missing'] }, actor)).rejects.toMatchObject({ code: 'invalid_request' });
    expect(await getGroupById(testEnv.DB, group.id)).toEqual(group);
    await expect(createGroup(testEnv.DB, { name: 'Unique' }, actor)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('rejects disabling the configured default group', async () => {
    const group = await createGroup(testEnv.DB, { name: 'C06 Target Default' }, actor);
    await prepare(testEnv.DB, `INSERT INTO settings(key,value_json,version,updated_at) VALUES('default_group_id',?,1,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json`, [JSON.stringify(group.id), now]).run();
    await expect(updateGroup(testEnv.DB, group.id, 1, { status: 'disabled' }, actor)).rejects.toMatchObject({ code: 'conflict' });
    expect((await getGroupById(testEnv.DB, group.id))?.status).toBe('active');
  });

  it('rejects disabling the final active administrator group', async () => {
    await expect(updateGroup(testEnv.DB, 'c06-admin-group', 1, { status: 'disabled' }, actor)).rejects.toMatchObject({ code: 'conflict' });
    expect((await getGroupById(testEnv.DB, 'c06-admin-group'))?.status).toBe('active');
  });

  it('allows disabling an ordinary group and retains membership and relationships', async () => {
    const group = await createGroup(testEnv.DB, { name: 'Disable target', channelIds: ['c06-channel-a'] }, actor);
    const updated = await updateGroup(testEnv.DB, group.id, 1, { status: 'disabled' }, actor);
    expect(updated.status).toBe('disabled');
    expect(updated.channelIds).toEqual(['c06-channel-a']);
  });

  it('cannot concurrently disable both remaining administrator groups', async () => {
    const second = await createGroup(testEnv.DB, { name: 'C06 Second Admin Group' }, actor);
    await prepare(testEnv.DB, `INSERT INTO users(id,email_normalized,password_hash,role,status,group_id,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
      VALUES(?,?,?,'admin','active',?,2,60,'admin',?,?)`,
      ['c06-admin-second', 'c06-second@example.invalid', 'test-only-hash', second.id, now, now]).run();
    const results = await Promise.allSettled([
      updateGroup(testEnv.DB, 'c06-admin-group', 1, { status: 'disabled' }, actor),
      updateGroup(testEnv.DB, second.id, 1, { status: 'disabled' }, { ...actor, actorId: 'c06-admin-second' }),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const remaining = await prepare(testEnv.DB, `SELECT COUNT(*) AS n FROM users u JOIN groups g ON g.id=u.group_id
      WHERE u.role='admin' AND u.status='active' AND g.status='active'`).first();
    expect(remaining?.n).toBe(1);
  });

  it('fails actor authorization even if the repository is called without a role guard', async () => {
    await prepare(testEnv.DB, "UPDATE users SET role='user' WHERE id=?", [actor.actorId]).run();
    await expect(createGroup(testEnv.DB, { name: 'Forbidden' }, actor)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('paginates stable tied timestamps without omissions or duplicate groups', async () => {
    await createGroup(testEnv.DB, { name: 'Page A' }, actor);
    await createGroup(testEnv.DB, { name: 'Page B' }, actor);
    const all = await listGroups(testEnv.DB, { limit: 100 });
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listGroups(testEnv.DB, { limit: 1, ...(cursor ? { cursor } : {}) });
      seen.push(...page.items.map(group => group.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(all.items.map(group => group.id));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('rejects pagination overflow and filter/cursor mismatch', async () => {
    await createGroup(testEnv.DB, { name: 'Page extra' }, actor);
    const page = await listGroups(testEnv.DB, { limit: 1, status: 'active' });
    await expect(listGroups(testEnv.DB, { cursor: page.nextCursor!, status: 'disabled' })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(listGroups(testEnv.DB, { limit: 101 })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(listGroups(testEnv.DB, { cursor: 'broken' })).rejects.toMatchObject({ code: 'invalid_request' });
  });
});
