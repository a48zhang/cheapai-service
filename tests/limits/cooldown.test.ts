import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseRetryAfter, getChannelCooldown, recordChannelCooldown } from '../../apps/worker/limits/cooldown';
import type { CooldownBinding } from '../../apps/worker/limits/cooldown';
import { GATE_COOLDOWN_STORAGE_KEY, MAX_COOLDOWN_TTL_MS } from '../../apps/worker/limits/gate';
import { acquireDualLease } from '../../apps/worker/limits/dual-lease';
import { LeaseStorage } from '../../apps/worker/limits/storage';
import { testEnv } from '../helpers/database';

let now: number;
beforeEach(() => { now = 1_800_000_000_000; vi.spyOn(Date, 'now').mockImplementation(() => now); });
afterEach(() => vi.restoreAllMocks());

describe('bounded Retry-After parsing', () => {
  it.each([['0', 0], ['60', 60_000], ['\t00120 ', 120_000], ['9999999999', 300_000]])('parses seconds case %# with a hard cap', (header, expected) => {
    expect(parseRetryAfter(header, now)).toBe(expected);
  });
  it('accepts canonical HTTP dates with elapsed time, past dates and long-delay caps', () => {
    expect(parseRetryAfter(new Date(now + 45_000).toUTCString(), now)).toBe(45_000);
    expect(parseRetryAfter(new Date(now - 1000).toUTCString(), now)).toBe(0);
    expect(parseRetryAfter(new Date(now + 86_400_000).toUTCString(), now)).toBe(MAX_COOLDOWN_TTL_MS);
  });
  it.each([undefined, null, '', '1.5', '-1', '+1', '1e3', '0x10', 'Infinity', '60\r\nInjected: x', '1'.repeat(129), '2027-01-01', 'Sun, 32 Jan 2027 00:00:00 GMT', 'Sunday, 06-Nov-94 08:49:37 GMT'])(
    'rejects malformed/noncanonical values case %# without permissive Date.parse fallback', (header) => {
      expect(parseRetryAfter(header, now)).toBeNull();
    },
  );
  it('rejects an invalid injected clock', () => { expect(() => parseRetryAfter('60', NaN)).toThrow(); });
});

describe('channel-only cooldown binding adapter', () => {
  it('persists a bounded 429 class and restores it after DO eviction', async () => {
    const result = await recordChannelCooldown(testEnv.GATE, { channelId: 'channel-1', status: 429, retryAfter: '120' });
    expect(result).toEqual({ applied: true, cooldown: { active: true, errorClass: 'rate_limited', cooldownUntil: now + 120_000, retryAfterMs: 120_000 } });
    await evictDurableObject(testEnv.GATE.get(testEnv.GATE.idFromName('channel:channel-1')));
    expect((await getChannelCooldown(testEnv.GATE, 'channel-1')).active).toBe(true);
    await runInDurableObject(testEnv.GATE.get(testEnv.GATE.idFromName('channel:channel-1')), (_instance, ctx) => {
      const stored = JSON.parse(ctx.storage.kv.get<string>(GATE_COOLDOWN_STORAGE_KEY)!);
      expect(Object.keys(stored).sort()).toEqual(['cooldownUntil', 'errorClass', 'schemaVersion']);
    });
    now += 120_000;
    expect(await getChannelCooldown(testEnv.GATE, 'channel-1')).toEqual({ active: false, retryAfterMs: 0 });
  });
  it.each([401, 403])('uses short auth class for %s without permanent channel state', async (status) => {
    expect(await recordChannelCooldown(testEnv.GATE, { channelId: 'channel-1', status, retryAfter: 'malformed upstream detail' })).toMatchObject({ applied: true, cooldown: { errorClass: 'auth_rejected', retryAfterMs: 30_000 } });
    now += 30_000;
    expect((await getChannelCooldown(testEnv.GATE, 'channel-1')).active).toBe(false);
  });
  it('uses explicit fallback/floor values and never shortens a longer cooldown', async () => {
    expect(await recordChannelCooldown(testEnv.GATE, { channelId: 'channel-1', status: 429 })).toMatchObject({ cooldown: { retryAfterMs: 60_000 } });
    expect(await recordChannelCooldown(testEnv.GATE, { channelId: 'channel-1', status: 403, retryAfter: '0' })).toMatchObject({ cooldown: { retryAfterMs: 60_000, errorClass: 'rate_limited' } });
    expect(await recordChannelCooldown(testEnv.GATE, { channelId: 'channel-2', status: 429, retryAfter: '0' })).toMatchObject({ cooldown: { retryAfterMs: 1_000 } });
    expect(await recordChannelCooldown(testEnv.GATE, { channelId: 'channel-3', status: 429, retryAfter: '9999999999' })).toMatchObject({ cooldown: { retryAfterMs: 300_000 } });
  });
  it('final acquire rejects cooling channels and dual acquisition compensates the user lease', async () => {
    await recordChannelCooldown(testEnv.GATE, { channelId: 'channel-1', status: 429, retryAfter: '60' });
    const result = await acquireDualLease(testEnv.GATE, { userId: 'user-1', channelId: 'channel-1', requestId: 'request-1', user: { limit: 1, ttlMs: 90_000 }, channel: { limit: 1, ttlMs: 90_000 } });
    expect(result).toMatchObject({ granted: false, stage: 'channel', denial: { reason: 'cooldown' }, cleanup: { complete: true } });
    expect(await runInDurableObject(testEnv.GATE.get(testEnv.GATE.idFromName('user:user-1')), (_instance, ctx) => new LeaseStorage(ctx.storage).read(now).leases.length)).toBe(0);
  });
  it('does not create cooldowns for unrelated statuses or accept arbitrary object names', async () => {
    const idFromName = vi.fn();
    const binding = { idFromName, get: vi.fn() } as unknown as CooldownBinding;
    for (const status of [200, 400, 404, 500, 503]) expect(await recordChannelCooldown(binding, { channelId: 'channel-1', status })).toEqual({ applied: false });
    expect(idFromName).not.toHaveBeenCalled();
    await expect(getChannelCooldown(binding, 'user:someone')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(recordChannelCooldown(binding, { channelId: 'channel-1', status: 429, now: 0 } as { channelId: string; status: number })).rejects.toMatchObject({ code: 'invalid_input' });
  });
  it('validates RPC results and always disposes their system resources', async () => {
    const disposeSymbol = (Symbol as SymbolConstructor & { readonly dispose: symbol }).dispose;
    for (const raw of [{ active: 'yes', retryAfterMs: 1 }, { active: true, cooldownUntil: 1, retryAfterMs: 99, errorClass: 'rate_limited' }, { active: false, retryAfterMs: 0, errorClass: 'raw error' }]) {
      const dispose = vi.fn();
      const binding: CooldownBinding = {
        idFromName: (name) => testEnv.GATE.idFromName(name),
        get: () => ({ getCooldown: async () => ({ ...raw, [disposeSymbol]: dispose }), setCooldown: async () => null }),
      };
      await expect(getChannelCooldown(binding, 'channel-1')).rejects.toMatchObject({ code: 'invalid_response', retryable: false });
      expect(dispose).toHaveBeenCalledTimes(1);
    }
  });
  it('does not convert an unavailable binding into an eligible channel or expose raw errors', async () => {
    const binding: CooldownBinding = {
      idFromName: (name) => testEnv.GATE.idFromName(name),
      get: () => ({ getCooldown: async () => { throw new Error('secret provider detail'); }, setCooldown: async () => { throw new Error('secret provider detail'); } }),
    };
    await expect(getChannelCooldown(binding, 'channel-1')).rejects.toMatchObject({ code: 'unavailable', retryable: true, message: 'Channel cooldown: unavailable' });
    await expect(recordChannelCooldown(binding, { channelId: 'channel-1', status: 429 })).rejects.toMatchObject({ code: 'unavailable' });
  });
});

describe('BV02 cooldown write deadline', () => {
  it('reports timeout as uncertain and still disposes a late committed RPC response', async () => {
    let resolveWrite!: (value: unknown) => void;
    const dispose = vi.fn();
    const disposeSymbol = (Symbol as SymbolConstructor & { readonly dispose: symbol }).dispose;
    const binding: CooldownBinding = {
      idFromName: name => testEnv.GATE.idFromName(name),
      get: () => ({ getCooldown: async () => ({ active: false, retryAfterMs: 0 }),
        setCooldown: () => new Promise(resolve => { resolveWrite = resolve; }) }),
    };
    const pending = recordChannelCooldown(binding, { channelId: 'channel-1', status: 429 });
    await expect(pending).rejects.toMatchObject({ code: 'timeout', retryable: true });
    resolveWrite({ active: true, cooldownUntil: now + 60_000, retryAfterMs: 60_000, errorClass: 'rate_limited', [disposeSymbol]: dispose });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(dispose).toHaveBeenCalledOnce();
  });
});
