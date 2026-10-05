import { beforeEach, describe, expect, it } from 'vitest';
import { updateUser } from '../../apps/worker/admin/update-user';
import type { UpdateUserPatch } from '../../apps/worker/admin/update-user';
import { prepare } from '../../apps/worker/db';
import { testEnv } from '../helpers/database';

const now = 1_788_640_000_000;
const admin = 'a23-admin';
const target = 'a23-user';
function update(patch: UpdateUserPatch, id = target, version = 1, actorId = admin) {
  return updateUser(testEnv.DB, id, version, patch, { actorId, operationId: crypto.randomUUID(), now: now + 1 });
}
async function insertUser(id: string, role = 'user', group = 'a23-group') {
  await prepare(testEnv.DB, `INSERT INTO users (id,email_normalized,password_hash,role,status,group_id,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
    VALUES (?,?,?,?,'active',?,2,60,'bootstrap',?,?)`, [id, `${id}@example.invalid`, 'a23-test-only-hash', role, group, now, now]).run();
}
const audits = () => prepare(testEnv.DB, "SELECT * FROM admin_audit WHERE action='user.update'").all();
beforeEach(async () => {
  for (const id of ['a23-group', 'a23-other', 'a23-disabled']) {
    await prepare(testEnv.DB, 'INSERT INTO groups (id,name,status,version,created_at,updated_at) VALUES (?,?,?,1,?,?)',
      [id, id, id === 'a23-disabled' ? 'disabled' : 'active', now, now]).run();
  }
  await insertUser(admin, 'admin'); await insertUser(target);
});

describe('administrator user updates in native D1', () => {
  it('can remove old limits on a disabled account without activating its disabled group', async () => {
    await insertUser('inactive-old', 'user', 'a23-disabled');
    await prepare(testEnv.DB, "UPDATE users SET status='disabled' WHERE id='inactive-old'").run();
    expect(await update({ concurrencyLimit: 0, rpmLimit: 0 }, 'inactive-old')).toMatchObject({
      status: 'disabled', group_status: 'disabled', concurrency_limit: Number.MAX_SAFE_INTEGER, rpm_limit: Number.MAX_SAFE_INTEGER,
    });
    await expect(update({ status: 'active' }, 'inactive-old', 2)).rejects.toMatchObject({ code: 'invalid_request' });
  });
  it('updates only permitted fields with public result and atomic audit', async () => {
    const result = await update({ status: 'disabled', groupId: 'a23-other', concurrencyLimit: 4, rpmLimit: 90 });
    expect(result).toMatchObject({ id: target, role: 'user', status: 'disabled', group_id: 'a23-other', concurrency_limit: 4,
      rpm_limit: 90, balance_units: '0', version: 2, updated_at: now + 1 });
    expect(JSON.stringify(result)).not.toContain('hash');
    const rows = (await audits()).rows;
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ actor_id: admin, target_id: target });
    expect(JSON.stringify(rows)).not.toContain('a23-test-only-hash');
    expect(await prepare(testEnv.DB, 'SELECT password_hash,balance_units,role FROM users WHERE id=?', [target]).first())
      .toEqual({ password_hash: 'a23-test-only-hash', balance_units: 0, role: 'user' });
  });
  it('rejects empty patches and invalid business values', async () => {
    for (const patch of [{}, { role: 'admin' }, { password: 'secret' }, { balance_units: 1 }, { concurrencyLimit: -1 },
      { rpmLimit: 1.5 }, { rpmLimit: Number.MAX_SAFE_INTEGER + 1 }, { status: 'revoked' }, { groupId: '' }]) {
      await expect(update(patch as UpdateUserPatch)).rejects.toMatchObject({ code: 'invalid_request' });
    }
    for (const version of [0, 1.5, Number.MAX_SAFE_INTEGER]) await expect(update({ rpmLimit: 2 }, target, version)).rejects.toMatchObject({ code: 'invalid_request' });
    expect((await audits()).rows).toEqual([]);
  });
  it('ignores unsupported fields while preserving server-owned role and balance', async () => {
    const result = await update({ rpmLimit: 30, role: 'admin', balance_units: 100, extension: true } as UpdateUserPatch);
    expect(result).toMatchObject({ role: 'user', balance_units: '0', rpm_limit: 30 });
  });
  it('commits more than 100 group grants and full before/after audit atomically', async () => {
    const grants = ['a23-group', ...Array.from({ length: 150 }, (_, i) => `extra-group-${i}`)];
    await prepare(testEnv.DB, `INSERT INTO groups(id,name,status,version,created_at,updated_at)
      SELECT value,value,'active',1,?,? FROM json_each(?)`, [now,now,JSON.stringify(grants.slice(1))]).run();
    await update({ allowedGroupIds: grants });
    expect((await prepare(testEnv.DB, 'SELECT group_id FROM user_group_access WHERE user_id=?', [target]).all()).rows).toHaveLength(151);
    const first = JSON.parse((await audits()).rows[0]!.redacted_change_json as string);
    expect(first.after.allowed_group_ids).toEqual(grants);
    await update({ allowedGroupIds: ['a23-group'] }, target, 2);
    const second = (await audits()).rows.map(row => JSON.parse(row.redacted_change_json as string)).find(change => change.after.version === 3);
    expect(second.before.allowed_group_ids).toHaveLength(151);
    expect(second.after.allowed_group_ids).toEqual(['a23-group']);
  });
  it('rejects missing users, inactive destinations, and non-administrator actors', async () => {
    await expect(update({ rpmLimit: 20 }, 'a23-missing')).rejects.toMatchObject({ code: 'not_found' });
    for (const groupId of ['a23-missing', 'a23-disabled']) await expect(update({ groupId })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(update({ rpmLimit: 20 }, target, 1, target)).rejects.toMatchObject({ code: 'forbidden' });
    await prepare(testEnv.DB, 'UPDATE groups SET status=? WHERE id=?', ['disabled', 'a23-group']).run();
    await expect(update({ rpmLimit: 20 })).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('rejects old versions and permits only one concurrent update per version', async () => {
    const results = await Promise.allSettled([update({ rpmLimit: 20 }), update({ rpmLimit: 30 })]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({ reason: { code: 'conflict' } });
    await expect(update({ rpmLimit: 40 })).rejects.toMatchObject({ code: 'conflict' });
    expect((await audits()).rows).toHaveLength(1);
  });
  it('protects the last usable administrator even when another admin has an inactive group', async () => {
    await insertUser('a23-unusable-admin', 'admin', 'a23-disabled');
    await expect(update({ status: 'disabled' }, admin)).rejects.toMatchObject({ code: 'conflict' });
    expect(await prepare(testEnv.DB, 'SELECT status FROM users WHERE id=?', [admin]).first()).toEqual({ status: 'active' });
    expect((await audits()).rows).toEqual([]);
  });
  it('serializes concurrent attempts to disable the final two active administrators', async () => {
    const second = 'a23-second-admin'; await insertUser(second, 'admin');
    const results = await Promise.allSettled([
      update({ status: 'disabled' }, admin, 1, admin), update({ status: 'disabled' }, second, 1, second),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({ reason: { code: 'conflict' } });
    expect((await prepare(testEnv.DB, "SELECT id FROM users WHERE id IN (?,?) AND status='active'", [admin, second]).all()).rows).toHaveLength(1);
    expect((await audits()).rows).toHaveLength(1);
  });
  it('rolls back an update if the audit insert fails', async () => {
    await testEnv.DB.exec("CREATE TRIGGER a23_fail_audit BEFORE INSERT ON admin_audit WHEN NEW.action='user.update' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END");
    await expect(update({ rpmLimit: 20 })).rejects.toMatchObject({ code: 'service_unavailable' });
    expect(await prepare(testEnv.DB, 'SELECT rpm_limit,version FROM users WHERE id=?', [target]).first()).toEqual({ rpm_limit: 60, version: 1 });
    expect((await audits()).rows).toEqual([]);
  });
  it('does not audit an unexpected zero-row UPDATE', async () => {
    await testEnv.DB.exec('CREATE TRIGGER a23_ignore BEFORE UPDATE ON users BEGIN SELECT RAISE(IGNORE); END');
    await expect(update({ rpmLimit: 20 })).rejects.toMatchObject({ code: 'conflict' });
    expect((await audits()).rows).toEqual([]);
  });
});
