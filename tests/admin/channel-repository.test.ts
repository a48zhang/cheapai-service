import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '../../apps/worker/http';
import { createChannel, getChannelById, listChannels, readChannelForForwarding, updateChannel } from '../../apps/worker/admin/channel-repository';
import type { ChannelAuditContext, ChannelPatch, ChannelPageOptions, CreateChannelInput } from '../../apps/worker/admin/channel-repository';
import { testEnv } from '../helpers/database';

const input: CreateChannelInput = { name: 'Test channel', baseUrl: 'https://API.Example.com:443/provider/%76%31', upstreamKey: 'sk-test-secret-never-return', concurrencyLimit: 2, rpmLimit: 60 };
let encryption: { keyVersion: string; key: Uint8Array };
const audit = (operationId: string, now = 1000): ChannelAuditContext => ({ actorId: 'c03-admin', operationId, now });
async function counts() {
  return {
    channels: await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM channels').first('count'),
    audits: await testEnv.DB.prepare("SELECT COUNT(*) AS count FROM admin_audit WHERE target_type='channel'").first('count'),
  };
}

describe('channel repository with native D1 and encryption', () => {
  beforeEach(async () => {
    encryption = { keyVersion: 'v1', key: crypto.getRandomValues(new Uint8Array(32)) };
    await testEnv.DB.prepare("INSERT INTO groups (id,name,status,version,created_at,updated_at) VALUES ('c03-group','C03 group','active',1,0,0)").run();
    await testEnv.DB.prepare(`INSERT INTO users (id,email_normalized,password_hash,role,status,group_id,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
      VALUES ('c03-admin','c03@example.invalid','test-only','admin','active','c03-group',2,60,'admin',0,0)`).run();
  });

  it('creates a parameterized encrypted channel and sanitized audit in one batch', async () => {
    const saved = await createChannel(testEnv.DB, { ...input, name: "quoted '; DROP TABLE channels; --" }, audit('create-op'), encryption);
    expect(saved).toMatchObject({ name: "quoted '; DROP TABLE channels; --", baseUrl: 'https://api.example.com/provider/v1', hasCredential: true, configVersion: 1, status: 'active', priority: 0 });
    expect(await getChannelById(testEnv.DB, saved.id)).toEqual(saved);
    expect(JSON.stringify(saved)).not.toContain(input.upstreamKey);
    expect(Object.keys(saved)).not.toContain('secret_ciphertext');
    const stored = await testEnv.DB.prepare('SELECT secret_ciphertext,secret_key_version FROM channels WHERE id=?').bind(saved.id).first<{ secret_ciphertext: string; secret_key_version: string }>();
    expect(stored?.secret_ciphertext).not.toContain(input.upstreamKey);
    expect(stored?.secret_key_version).toBe('v1');
    const internal = await readChannelForForwarding(testEnv.DB, saved.id, new Map([['v1', encryption.key]]));
    expect(internal?.upstreamKey).toBe(input.upstreamKey);
    const auditRow = await testEnv.DB.prepare("SELECT * FROM admin_audit WHERE operation_id='create-op'").first();
    expect(JSON.stringify(auditRow)).not.toContain(input.upstreamKey);
    expect(JSON.stringify(auditRow)).not.toContain(saved.name);
    expect(JSON.stringify(auditRow)).not.toContain(saved.baseUrl);
    expect(JSON.stringify(auditRow)).not.toContain(stored?.secret_ciphertext ?? 'unexpected');
    expect(await counts()).toEqual({ channels: 1, audits: 1 });
  });

  it('preserves omitted credentials and only rotates them through explicit encryption', async () => {
    const saved = await createChannel(testEnv.DB, input, audit('create'), encryption);
    const original = await testEnv.DB.prepare('SELECT secret_ciphertext FROM channels WHERE id=?').bind(saved.id).first('secret_ciphertext');
    const updated = await updateChannel(testEnv.DB, saved.id, 1, { name: 'Changed', status: 'disabled', concurrencyLimit: 4 }, audit('update', 2000));
    expect(updated).toMatchObject({ configVersion: 2, name: 'Changed', status: 'disabled', concurrencyLimit: 4 });
    expect(await testEnv.DB.prepare('SELECT secret_ciphertext FROM channels WHERE id=?').bind(saved.id).first('secret_ciphertext')).toBe(original);
    const nextKey = { keyVersion: 'v2', key: crypto.getRandomValues(new Uint8Array(32)) };
    await updateChannel(testEnv.DB, saved.id, 2, { upstreamKey: 'sk-new-secret' }, audit('rotate', 3000), nextKey);
    expect((await readChannelForForwarding(testEnv.DB, saved.id, new Map([['v2', nextKey.key]])))?.upstreamKey).toBe('sk-new-secret');
    await expect(readChannelForForwarding(testEnv.DB, saved.id, new Map([['v1', encryption.key]]))).rejects.toMatchObject({ code: 'service_unavailable' });
    const logs = JSON.stringify((await testEnv.DB.prepare("SELECT redacted_change_json FROM admin_audit WHERE target_id=?").bind(saved.id).all()).results);
    expect(logs).not.toContain('sk-new-secret');
    expect(logs).toContain('credential_changed');
  });

  it('rejects empty/null/undefined keys and unauthorized fields without credential deletion', async () => {
    const saved = await createChannel(testEnv.DB, input, audit('create'), encryption);
    for (const patch of [{ upstreamKey: '' }, { upstreamKey: ' ' }, { upstreamKey: null }, { upstreamKey: undefined }, { secret_ciphertext: '{}' }, { secret_key_version: 'other' }, { id: 'overwrite' }, { configVersion: 99 }, {}]) {
      await expect(updateChannel(testEnv.DB, saved.id, 1, patch as ChannelPatch, audit('bad-patch'), encryption)).rejects.toBeInstanceOf(ApiError);
    }
    expect((await getChannelById(testEnv.DB, saved.id))?.configVersion).toBe(1);
    expect((await readChannelForForwarding(testEnv.DB, saved.id, new Map([['v1', encryption.key]])))?.upstreamKey).toBe(input.upstreamKey);
    expect(await counts()).toEqual({ channels: 1, audits: 1 });
  });

  it('validates URLs, limits and explicit values without network activity', async () => {
    for (const patch of [{ baseUrl: 'http://api.example.com' }, { baseUrl: 'https://127.0.0.1' }, { baseUrl: 'https://user:pass@api.example.com' },
      { concurrencyLimit: -1 }, { rpmLimit: -1 }, { rpmLimit: 1.5 }, { priority: -1 }, { priority: null }, { status: null }, { status: 'enabled' }, { extra: true }, { upstreamKey: '' }]) {
      await expect(createChannel(testEnv.DB, { ...input, ...patch } as CreateChannelInput, audit('bad-create'), encryption)).rejects.toMatchObject({ code: 'invalid_request' });
    }
    expect(await counts()).toEqual({ channels: 0, audits: 0 });
  });

  it('uses version conditions to select exactly one concurrent update and audit', async () => {
    const saved = await createChannel(testEnv.DB, input, audit('create'), encryption);
    const results = await Promise.allSettled([
      updateChannel(testEnv.DB, saved.id, 1, { priority: 5 }, audit('race-one', 2000)),
      updateChannel(testEnv.DB, saved.id, 1, { priority: 9 }, audit('race-two', 2000)),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason.code).toBe('conflict');
    expect((await getChannelById(testEnv.DB, saved.id))?.configVersion).toBe(2);
    expect(await counts()).toEqual({ channels: 1, audits: 2 });
    await expect(updateChannel(testEnv.DB, saved.id, 1, { name: 'stale' }, audit('stale'))).rejects.toMatchObject({ code: 'conflict' });
  });

  it('rolls back a zero-row update as an explicit conflict without an orphan audit', async () => {
    const saved = await createChannel(testEnv.DB, input, audit('create'), encryption);
    await testEnv.DB.exec("CREATE TRIGGER c03_ignore_update BEFORE UPDATE ON channels BEGIN SELECT RAISE(IGNORE); END;");
    await expect(updateChannel(testEnv.DB, saved.id, 1, { name: 'ignored' }, audit('ignored', 2000))).rejects.toMatchObject({ code: 'conflict' });
    expect(await getChannelById(testEnv.DB, saved.id)).toEqual(saved);
    expect(await counts()).toEqual({ channels: 1, audits: 1 });
  });

  it('rolls back creation and updates when the same-batch audit fails', async () => {
    const saved = await createChannel(testEnv.DB, input, audit('create'), encryption);
    await testEnv.DB.exec("CREATE TRIGGER c03_fail_audit BEFORE INSERT ON admin_audit BEGIN SELECT RAISE(ABORT, 'test_audit_failure'); END;");
    await expect(createChannel(testEnv.DB, input, audit('failed-create'), encryption)).rejects.toMatchObject({ code: 'service_unavailable' });
    await expect(updateChannel(testEnv.DB, saved.id, 1, { upstreamKey: 'replacement-not-committed' }, audit('failed-update'), encryption)).rejects.toMatchObject({ code: 'service_unavailable' });
    expect(await getChannelById(testEnv.DB, saved.id)).toEqual(saved);
    expect((await readChannelForForwarding(testEnv.DB, saved.id, new Map([['v1', encryption.key]])))?.upstreamKey).toBe(input.upstreamKey);
    expect(await counts()).toEqual({ channels: 1, audits: 1 });
  });

  it('paginates stably with tied timestamps and binds the cursor to its status filter', async () => {
    const created = [];
    for (let index = 0; index < 5; index++) created.push(await createChannel(testEnv.DB, { ...input, name: `channel-${index}`, status: index === 4 ? 'disabled' : 'active' }, audit(`create-${index}`), encryption));
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await listChannels(testEnv.DB, { limit: 2, ...(cursor ? { cursor } : {}) });
      seen.push(...page.items.map((item) => item.id));
      expect(JSON.stringify(page)).not.toContain(input.upstreamKey);
      expect(JSON.stringify(page)).not.toContain('secret_ciphertext');
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(created.map((item) => item.id).sort().reverse());
    const active = await listChannels(testEnv.DB, { limit: 1, status: 'active' });
    expect(active.nextCursor).not.toBeNull();
    await expect(listChannels(testEnv.DB, { status: 'disabled', cursor: active.nextCursor! })).rejects.toMatchObject({ code: 'invalid_request' });
    for (const options of [{ limit: 0 }, { limit: 101 }, { limit: null }, { cursor: 'bad-json' }, { cursor: '!' }, { status: 'enabled' }, { extra: true }]) {
      await expect(listChannels(testEnv.DB, options as ChannelPageOptions)).rejects.toMatchObject({ code: 'invalid_request' });
    }
  });

  it('returns null for missing reads and rejects unavailable version increments', async () => {
    expect(await getChannelById(testEnv.DB, 'missing')).toBeNull();
    expect(await readChannelForForwarding(testEnv.DB, 'missing', new Map())).toBeNull();
    await expect(updateChannel(testEnv.DB, 'missing', 1, { name: 'changed' }, audit('missing'))).rejects.toMatchObject({ code: 'not_found' });
    const saved = await createChannel(testEnv.DB, input, audit('create'), encryption);
    await testEnv.DB.prepare('UPDATE channels SET config_version=? WHERE id=?').bind(Number.MAX_SAFE_INTEGER, saved.id).run();
    await expect(updateChannel(testEnv.DB, saved.id, Number.MAX_SAFE_INTEGER, { name: 'overflow' }, audit('overflow'))).rejects.toMatchObject({ code: 'conflict' });
  });
});
