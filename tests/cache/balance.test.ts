import { beforeEach, describe, expect, it, vi } from 'vitest';
import { balanceCacheKey, readBalance } from '../../apps/worker/cache/balance';
import { encodeSnapshot } from '../../apps/worker/cache/snapshot';
import { DEFAULT_CONFIG } from '../../apps/worker/config';
import { prepare } from '../../apps/worker/db';
import { testEnv } from '../helpers/database';

const userId = 'c15-user';
const now = 1_788_619_000_000;
const enabled = { balanceCacheEnabled: true, balanceCacheTtlMs: 15_000, admissionMinBalanceUnits: '100' };
const cached = (balance = '500', user = userId, observed = now) => ({ schema_version: 1 as const, observed_at: observed,
  data: { user_id: user, balance_units: balance, user_version: 1 } });

beforeEach(async () => {
  await prepare(testEnv.DB, 'INSERT INTO groups(id,name,status,version,created_at,updated_at) VALUES(?,?,?,?,?,?)',
    ['c15-group', 'C15 Group', 'active', 1, now, now]).run();
  await prepare(testEnv.DB, `INSERT INTO users
    (id,email_normalized,password_hash,role,status,group_id,balance_units,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
    VALUES(?,?,?,'user','active',?,500,2,60,'admin',?,?)`,
    [userId, 'c15@example.invalid', 'test-only-hash', 'c15-group', now, now]).run();
});

describe('optional balance snapshots on native D1/KV', () => {
  it('defaults off without touching KV', async () => {
    const kv = { get: vi.fn(), put: vi.fn() } as unknown as KVNamespace;
    expect(DEFAULT_CONFIG.balanceCacheEnabled).toBe(false);
    const result = await readBalance(testEnv.DB, kv, userId, undefined, () => now);
    expect(result?.source).toBe('d1');
    expect(result?.snapshot.data.balance_units).toBe('500');
    expect(kv.get).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it('uses high fresh cache only as a soft hint requiring final authoritative admission', async () => {
    await testEnv.CACHE.put(balanceCacheKey(userId), encodeSnapshot(cached())!);
    const database = { prepare: vi.fn(() => { throw new Error('Soft cache hit must not query balance'); }) } as unknown as D1Database;
    const result = await readBalance(database, testEnv.CACHE, userId, enabled, () => now);
    expect(result).toEqual({ source: 'cache', snapshot: cached(), requiresAuthoritativeAdmission: true });
    expect(database.prepare).not.toHaveBeenCalled();
  });

  it.each(['-100', '0', '99'])('rechecks old low balance %s after a credit', async balance => {
    await testEnv.CACHE.put(balanceCacheKey(userId), encodeSnapshot(cached(balance))!);
    const result = await readBalance(testEnv.DB, testEnv.CACHE, userId, enabled, () => now);
    expect(result?.source).toBe('d1');
    expect(result?.snapshot.data.balance_units).toBe('500');
  });

  it('allows equality at a positive threshold only as a soft cache hit', async () => {
    await testEnv.CACHE.put(balanceCacheKey(userId), encodeSnapshot(cached('100'))!);
    expect((await readBalance(testEnv.DB, testEnv.CACHE, userId, enabled, () => now))?.source).toBe('cache');
  });

  it('caps application age at 15 seconds even if configuration asks for more', async () => {
    await testEnv.CACHE.put(balanceCacheKey(userId), encodeSnapshot(cached('500', userId, now - 15_000))!);
    expect((await readBalance(testEnv.DB, testEnv.CACHE, userId, { ...enabled, balanceCacheTtlMs: 60_000 }, () => now))?.source).toBe('d1');
  });

  it('rejects another user payload under the correct key', async () => {
    await testEnv.CACHE.put(balanceCacheKey(userId), encodeSnapshot(cached('999', 'someone-else'))!);
    expect((await readBalance(testEnv.DB, testEnv.CACHE, userId, enabled, () => now))?.snapshot.data.user_id).toBe(userId);
  });

  it('preserves authoritative negative balances and user version as strings/metadata', async () => {
    await prepare(testEnv.DB, 'UPDATE users SET balance_units=?,version=? WHERE id=?', [-9007199254740991, 3, userId]).run();
    const result = await readBalance(testEnv.DB, testEnv.CACHE, userId, enabled, () => now);
    expect(result?.snapshot).toEqual({ schema_version: 1, observed_at: now, data: { user_id: userId, balance_units: '-9007199254740991', user_version: 3 } });
  });

  it('fails closed when required D1 fallback fails, without serving low cache', async () => {
    await testEnv.CACHE.put(balanceCacheKey(userId), encodeSnapshot(cached('0'))!);
    const database = { prepare: () => { throw new Error('D1 unavailable'); } } as unknown as D1Database;
    await expect(readBalance(database, testEnv.CACHE, userId, enabled, () => now)).rejects.toMatchObject({ code: 'service_unavailable' });
  });

  it('returns D1 results when KV is unavailable and retains read-start observation', async () => {
    const kv = { get: async () => { throw new Error('KV failed'); }, put: vi.fn(async () => { throw new Error('429'); }) } as unknown as KVNamespace;
    const clock = vi.fn().mockReturnValueOnce(now).mockReturnValueOnce(now + 1).mockReturnValue(now + 1000);
    const result = await readBalance(testEnv.DB, kv, userId, enabled, clock);
    expect(result?.source).toBe('d1');
    expect(result?.snapshot.observed_at).toBe(now + 1);
    expect(kv.put).toHaveBeenCalledTimes(1);
  });

  it('returns null for a missing authoritative user', async () => {
    expect(await readBalance(testEnv.DB, testEnv.CACHE, 'missing', enabled, () => now)).toBeNull();
  });
});
