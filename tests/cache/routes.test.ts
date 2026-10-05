import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readRoutes, routesCacheKey } from '../../apps/worker/cache/routes';
import { prepare } from '../../apps/worker/db';
import { testEnv } from '../helpers/database';

const groupId = 'c13-group';
const modelId = 'c13-model';
const now = 1_788_619_000_000;
beforeEach(async () => {
  await prepare(testEnv.DB, 'INSERT INTO groups(id,name,status,version,created_at,updated_at) VALUES(?,?,?,?,?,?)',
    [groupId, 'C13 Group', 'active', 4, now, now]).run();
  await prepare(testEnv.DB, `INSERT INTO models (public_model_id,status,sell_prices_json,price_version,admission_min_balance_units,max_output_tokens,created_at,updated_at) VALUES (?,'active',?,5,0,4096,?,?)`, [modelId, JSON.stringify({ input: '1', output: '2' }), now, now]).run();
  for (const channel of ['c13-member', 'c13-outsider']) {
    const credential = 'test-upstream-key';
    await prepare(testEnv.DB, `INSERT INTO channels(id,name,base_url,upstream_key,status,priority,concurrency_limit,rpm_limit,config_version,created_at,updated_at)
      VALUES(?,?,?,?,'active',2,3,90,6,?,?)`,
      [channel, channel, 'https://provider.example.com/v1', credential, now, now]).run();
    for (const protocol of ['chat', 'messages']) {
      await prepare(testEnv.DB, `INSERT INTO channel_models(channel_id,public_model_id,protocol,upstream_model,capabilities_json,config_version) VALUES(?,?,?,?,?,7)`,
        [channel, modelId, protocol, `upstream-${protocol}`, JSON.stringify({ protocol, features: ['streaming'] })]).run();
    }
  }
  await prepare(testEnv.DB, 'INSERT INTO channel_groups(channel_id,group_id) VALUES(?,?)', ['c13-member', groupId]).run();
});

describe('route configuration snapshots on native D1/KV', () => {
  it('keeps group, model, channel and protocol mapping versions without credentials', async () => {
    const result = await readRoutes(testEnv.DB, testEnv.CACHE, groupId, modelId, { now: () => now });
    expect(result?.source).toBe('d1');
    expect(result?.requiresAuthoritativeRecheck).toBe(true);
    expect(result?.snapshot.data.group).toEqual({ id: groupId, version: 4 });
    expect(result?.snapshot.data.model).toEqual({ publicModelId: modelId, priceVersion: 5 });
    expect(result?.snapshot.data.candidates).toHaveLength(2);
    for (const candidate of result!.snapshot.data.candidates) {
      expect(candidate.channel.id).toBe('c13-member');
      expect(candidate.channel.configVersion).toBe(6);
      expect(candidate.mapping.configVersion).toBe(7);
      expect(candidate.mapping.channelId).toBe(candidate.channel.id);
      expect(candidate.mapping.capabilities.protocol).toBe(candidate.mapping.protocol);
    }
    const serialized = (await testEnv.CACHE.get(routesCacheKey(groupId, modelId)))!;
    expect(serialized).not.toMatch(/secret|upstream_key|test-upstream-key|upstreamKey|c13-outsider/);
    const database = { prepare: vi.fn(() => { throw new Error('Unexpected D1 read'); }) } as unknown as D1Database;
    expect((await readRoutes(database, testEnv.CACHE, groupId, modelId, { now: () => now }))?.source).toBe('cache');
    expect(database.prepare).not.toHaveBeenCalled();
  });

  it('reloads an expired snapshot and retains original snapshot age until then', async () => {
    await readRoutes(testEnv.DB, testEnv.CACHE, groupId, modelId, { now: () => now });
    expect((await readRoutes(testEnv.DB, testEnv.CACHE, groupId, modelId, { now: () => now + 59_999 }))?.snapshot.observed_at).toBe(now);
    const result = await readRoutes(testEnv.DB, testEnv.CACHE, groupId, modelId, { now: () => now + 60_000 });
    expect(result?.source).toBe('d1');
    expect(result?.snapshot.observed_at).toBe(now + 60_000);
  });

  it.each(['group', 'model'])('returns null and invalidates when authoritative %s is disabled', async target => {
    await readRoutes(testEnv.DB, testEnv.CACHE, groupId, modelId, { now: () => now });
    await prepare(testEnv.DB, target === 'group' ? "UPDATE groups SET status='disabled' WHERE id=?" : "UPDATE models SET status='disabled' WHERE public_model_id=?",
      [target === 'group' ? groupId : modelId]).run();
    expect(await readRoutes(testEnv.DB, testEnv.CACHE, groupId, modelId, { now: () => now, forceRefresh: true })).toBeNull();
    expect(await testEnv.CACHE.get(routesCacheKey(groupId, modelId))).toBeNull();
  });

  it('omits disabled channels and detached group relationships on refresh', async () => {
    await prepare(testEnv.DB, "UPDATE channels SET status='disabled' WHERE id=?", ['c13-member']).run();
    expect((await readRoutes(testEnv.DB, testEnv.CACHE, groupId, modelId, { now: () => now }))?.snapshot.data.candidates).toEqual([]);
    await prepare(testEnv.DB, "UPDATE channels SET status='active' WHERE id=?", ['c13-member']).run();
    await prepare(testEnv.DB, 'DELETE FROM channel_groups WHERE group_id=?', [groupId]).run();
    expect((await readRoutes(testEnv.DB, testEnv.CACHE, groupId, modelId, { now: () => now, forceRefresh: true }))?.snapshot.data.candidates).toEqual([]);
  });

  it.each(['scope', 'protocol', 'duplicate'])('rejects corrupted cached %s', async corruption => {
    const result = await readRoutes(testEnv.DB, testEnv.CACHE, groupId, modelId, { now: () => now });
    const snapshot = JSON.parse(JSON.stringify(result!.snapshot));
    if (corruption === 'scope') snapshot.data.group.id = 'other-group';
    if (corruption === 'protocol') snapshot.data.candidates[0].mapping.capabilities.protocol = 'responses';
    if (corruption === 'duplicate') snapshot.data.candidates.push(snapshot.data.candidates[0]);
    const kv = { get: async () => JSON.stringify(snapshot), put: async () => {} } as unknown as KVNamespace;
    const reloaded = await readRoutes(testEnv.DB, kv, groupId, modelId, { now: () => now });
    expect(reloaded?.source).toBe('d1');
    expect(reloaded?.snapshot.data.candidates).toHaveLength(2);
  });

  it('tolerates KV failures/429 and preserves the D1 read-start timestamp', async () => {
    const kv = { get: async () => { throw new Error('KV unavailable'); }, put: vi.fn(async () => { throw new Error('429'); }) } as unknown as KVNamespace;
    const clock = vi.fn().mockReturnValueOnce(now).mockReturnValueOnce(now + 1).mockReturnValue(now + 1000);
    const result = await readRoutes(testEnv.DB, kv, groupId, modelId, { now: clock });
    expect(result?.source).toBe('d1');
    expect(result?.snapshot.observed_at).toBe(now + 1);
    expect(kv.put).toHaveBeenCalledTimes(1);
  });

  it('does not fall back to expired routes after D1 failure', async () => {
    await readRoutes(testEnv.DB, testEnv.CACHE, groupId, modelId, { now: () => now });
    const database = { prepare: () => { throw new Error('Private D1 details'); } } as unknown as D1Database;
    await expect(readRoutes(database, testEnv.CACHE, groupId, modelId, { now: () => now + 60_000 })).rejects.toMatchObject({ code: 'service_unavailable' });
  });

  it('returns null for a missing authoritative group or model', async () => {
    expect(await readRoutes(testEnv.DB, testEnv.CACHE, 'missing', modelId, { now: () => now })).toBeNull();
    expect(await readRoutes(testEnv.DB, testEnv.CACHE, groupId, 'missing', { now: () => now })).toBeNull();
  });
});
