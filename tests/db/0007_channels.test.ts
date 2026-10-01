import { beforeEach, describe, expect, it } from 'vitest';
import { decryptChannelSecret, encryptChannelSecret } from '../../apps/worker/admin/channel-secrets';
import { testEnv } from '../helpers/database';

const columns = ['id', 'name', 'base_url', 'secret_ciphertext', 'secret_key_version', 'status', 'priority', 'concurrency_limit', 'rpm_limit', 'config_version', 'created_at', 'updated_at'] as const;
type ChannelRow = Record<typeof columns[number], string | number | null>;
let valid: ChannelRow;
let key: Uint8Array;

function insert(changes: Partial<ChannelRow> = {}) {
  const row = { ...valid, ...changes };
  return testEnv.DB.prepare(`INSERT INTO channels (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
    .bind(...columns.map((column) => row[column])).run();
}

async function group(id: string) {
  await testEnv.DB.prepare('INSERT INTO groups (id,name,status,version,created_at,updated_at) VALUES (?, ?, ?, 1, 0, 0)')
    .bind(id, `D07 ${id}`, 'active').run();
}

describe('0007 channels and group membership in native D1', () => {
  beforeEach(async () => {
    key = crypto.getRandomValues(new Uint8Array(32));
    valid = {
      id: 'd07-channel', name: 'D07 test channel', base_url: 'https://upstream.example.invalid/v1',
      secret_ciphertext: await encryptChannelSecret('test-upstream-key', 'd07-channel', 'test-v1', key),
      secret_key_version: 'test-v1', status: 'active', priority: 0, concurrency_limit: 2,
      rpm_limit: 60, config_version: 1, created_at: 1000, updated_at: 1000,
    };
  });

  it('stores the real C01 envelope and preserves decryptability without plaintext', async () => {
    await insert();
    const row = await testEnv.DB.prepare('SELECT * FROM channels WHERE id = ?').bind(valid.id).first<ChannelRow>();
    expect(row).toEqual(valid);
    expect(row?.secret_ciphertext).not.toContain('test-upstream-key');
    expect(await decryptChannelSecret(String(row?.secret_ciphertext), 'd07-channel', new Map([['test-v1', key]]))).toBe('test-upstream-key');
    await testEnv.DB.prepare('UPDATE channels SET status = ?, config_version = 2, updated_at = 2000 WHERE id = ?').bind('disabled', valid.id).run();
    expect(await testEnv.DB.prepare('SELECT status FROM channels WHERE id = ?').bind(valid.id).first('status')).toBe('disabled');
  });

  it('rejects missing fields, empty identifiers, invalid status and duplicate IDs', async () => {
    for (const column of columns) await expect(insert({ [column]: null })).rejects.toThrow();
    for (const column of ['id', 'name', 'base_url', 'secret_key_version'] as const) await expect(insert({ [column]: ' ' })).rejects.toThrow();
    await expect(insert({ status: 'enabled' })).rejects.toThrow();
    await insert();
    await expect(insert()).rejects.toThrow();
  });

  it('rejects malformed or mismatched envelopes without invoking SQL encryption', async () => {
    const envelope = JSON.parse(String(valid.secret_ciphertext));
    const bad = ['plain-key', '{broken', 'null', '[]', '{}',
      JSON.stringify({ ...envelope, algorithm: 'plaintext' }),
      JSON.stringify({ ...envelope, format_version: '1' }),
      JSON.stringify({ ...envelope, key_version: 'other-version' }),
      JSON.stringify({ ...envelope, nonce: null }),
      JSON.stringify({ ...envelope, ciphertext: '' }),
    ];
    for (const ciphertext of bad) await expect(insert({ secret_ciphertext: ciphertext })).rejects.toThrow();
  });

  it('enforces positive safe counts/versions and nonnegative safe priority/time', async () => {
    for (const column of ['concurrency_limit', 'rpm_limit', 'config_version'] as const) {
      for (const value of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, 'not-integer']) {
        await expect(insert({ [column]: value })).rejects.toThrow();
      }
    }
    for (const column of ['priority', 'created_at', 'updated_at'] as const) {
      for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, 'not-integer']) {
        await expect(insert({ [column]: value })).rejects.toThrow();
      }
    }
    await expect(insert({ updated_at: 999 })).rejects.toThrow();
    await insert({ created_at: 0, updated_at: 0 });
    await testEnv.DB.prepare('DELETE FROM channels WHERE id = ?').bind(valid.id).run();
    await insert({ priority: Number.MAX_SAFE_INTEGER, concurrency_limit: Number.MAX_SAFE_INTEGER, rpm_limit: Number.MAX_SAFE_INTEGER, config_version: Number.MAX_SAFE_INTEGER, created_at: Number.MAX_SAFE_INTEGER, updated_at: Number.MAX_SAFE_INTEGER });
    expect(await testEnv.DB.prepare('SELECT config_version FROM channels WHERE id = ?').bind(valid.id).first('config_version')).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('allows many-to-many membership, forbids duplicates/orphans and restricts referenced deletion', async () => {
    await insert();
    await insert({ id: 'd07-channel-2', secret_ciphertext: await encryptChannelSecret('test-key-2', 'd07-channel-2', 'test-v1', key) });
    await group('d07-group-1');
    await group('d07-group-2');
    const link = (channelId: string, groupId: string) => testEnv.DB.prepare('INSERT INTO channel_groups (channel_id,group_id) VALUES (?,?)').bind(channelId, groupId).run();
    await link('d07-channel', 'd07-group-1');
    await link('d07-channel', 'd07-group-2');
    await link('d07-channel-2', 'd07-group-1');
    await expect(link('d07-channel', 'd07-group-1')).rejects.toThrow();
    await expect(link('missing-channel', 'd07-group-1')).rejects.toThrow();
    await expect(link('d07-channel', 'missing-group')).rejects.toThrow();
    await expect(testEnv.DB.prepare('DELETE FROM channels WHERE id = ?').bind('d07-channel').run()).rejects.toThrow();
    await expect(testEnv.DB.prepare('DELETE FROM groups WHERE id = ?').bind('d07-group-1').run()).rejects.toThrow();
    await expect(testEnv.DB.prepare('UPDATE channels SET id = ? WHERE id = ?').bind('changed-channel', 'd07-channel').run()).rejects.toThrow();
    await expect(testEnv.DB.prepare('UPDATE groups SET id = ? WHERE id = ?').bind('changed-group', 'd07-group-1').run()).rejects.toThrow();
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM channel_groups').first('count')).toBe(3);
    await testEnv.DB.prepare('DELETE FROM channel_groups WHERE channel_id = ?').bind('d07-channel').run();
    await testEnv.DB.prepare('DELETE FROM channels WHERE id = ?').bind('d07-channel').run();
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM channel_groups').first('count')).toBe(1);
  });

  it('provides the status/priority and group lookup indexes and valid foreign keys', async () => {
    const channelIndex = await testEnv.DB.prepare("PRAGMA index_info('idx_channels_status_priority_id')").all<{ name: string }>();
    expect(channelIndex.results.map((column) => column.name)).toEqual(['status', 'priority', 'id']);
    const groupIndex = await testEnv.DB.prepare("PRAGMA index_info('idx_channel_groups_group_channel')").all<{ name: string }>();
    expect(groupIndex.results.map((column) => column.name)).toEqual(['group_id', 'channel_id']);
    const foreignKeys = await testEnv.DB.prepare('PRAGMA foreign_key_list(channel_groups)').all<{ table: string; on_delete: string; on_update: string }>();
    expect(foreignKeys.results).toHaveLength(2);
    expect(foreignKeys.results.every((fk) => fk.on_delete === 'RESTRICT' && fk.on_update === 'RESTRICT')).toBe(true);
    expect((await testEnv.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });
});
