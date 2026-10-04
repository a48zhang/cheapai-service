import { describe, expect, it } from 'vitest';
import { billingMultiplierSchema, decodeGroup } from '@cheapai/contracts/groups';
import { decodeRequest } from '@cheapai/contracts/requests';
import { createChannelsApi } from '@cheapai/api-client/channels';
import { createApiClient } from '@cheapai/api-client/client';

const isBillingMultiplier = (value: unknown): value is string => billingMultiplierSchema.safeParse(value).success;

const group = (patch: Record<string, unknown> = {}) => ({
  id: 'group-1', name: '标准组', status: 'active', version: 1, createdAt: 10, updatedAt: 10, channelIds: [], ...patch,
});

const request = (patch: Record<string, unknown> = {}) => ({
  id: 'request-1', user_id: 'user-1', api_key_id: 'key-1', channel_id: 'channel-1', public_model_id: 'model-1', upstream_model: 'model-1',
  downstream_protocol: 'chat', upstream_protocol: 'chat', execution_status: 'succeeded', billing_status: 'not_chargeable',
  created_at: 10, started_at: null, finished_at: 20, updated_at: 20, usage: null, usage_valid: null, price_snapshot: null,
  price_snapshot_valid: false, cost_units: null, error: null, retry_count: 0, next_retry_at: null, ...patch,
});

const priceSnapshot = (patch: Record<string, unknown> = {}) => ({
  schema_version: 1, canonical_json_version: 1, calculation_version: 1, currency: 'USD', decimals: 8,
  tokens_per_price_unit: 1_000_000, rounding: 'half_up_after_sum', public_model_id: 'model-1', upstream_model: 'model-1',
  upstream_protocol: 'chat', price_version: 1, sell_prices: { input: '1', output: '2' }, ...patch,
});

describe('web admin API contracts', () => {
  it('keeps group multipliers as exact non-negative decimal strings', () => {
    expect(isBillingMultiplier('0')).toBe(true);
    expect(isBillingMultiplier('0.2')).toBe(true);
    expect(isBillingMultiplier('1.000')).toBe(true);
    expect(isBillingMultiplier('1e-1')).toBe(false);
    expect(isBillingMultiplier('-0.1')).toBe(false);
    expect(isBillingMultiplier(' 0.2')).toBe(false);
    expect(isBillingMultiplier(`1.${'0'.repeat(19)}`)).toBe(false);
    expect(decodeGroup(group({ billingMultiplier: '0.2' })).billingMultiplier).toBe('0.2');
    expect(decodeGroup(group()).billingMultiplier).toBe('1');
  });

  it('uses only the trusted web-chat source field for request labels', () => {
    expect(decodeRequest(request({ source: 'web_chat', group_id: 'group-1' }))).toMatchObject({ source: 'web_chat', group_id: 'group-1' });
    expect(decodeRequest(request())).toMatchObject({ source: 'api', group_id: null });
    expect(() => decodeRequest(request({ source: 'web_chat', group_id: 42 }))).toThrow();
    expect(() => decodeRequest(request({ source: 'virtual_key' }))).toThrow();
  });

  it('decodes group facts in new price snapshots while preserving legacy snapshots', () => {
    const decoded = decodeRequest(request({ price_snapshot: priceSnapshot({ group_id: 'group-1', group_version: 3, billing_multiplier: '0.2' }), price_snapshot_valid: true }));
    expect(decoded.price_snapshot).toMatchObject({ group_id: 'group-1', group_version: 3, billing_multiplier: '0.2' });
    expect(decodeRequest(request())).toMatchObject({ price_snapshot: null, price_snapshot_valid: false });
    expect(() => decodeRequest(request({ price_snapshot: priceSnapshot({ group_version: 0 }), price_snapshot_valid: true }))).toThrow();
    expect(() => decodeRequest(request({ price_snapshot: priceSnapshot({ billing_multiplier: '1e-1' }), price_snapshot_valid: true }))).toThrow();
    expect(() => decodeRequest(request({ price_snapshot: priceSnapshot({ extra: 'unexpected' }), price_snapshot_valid: true }))).toThrow();
  });
});


const channel = (index: number) => ({
  id: `channel-${index}`, name: `Channel ${index}`, baseUrl: 'https://upstream.example.invalid',
  status: index === 41 ? 'disabled' : 'active', priority: 1, concurrencyLimit: 2, rpmLimit: 60,
  configVersion: 1, createdAt: 10, updatedAt: 10, hasCredential: true, models: [],
});

describe('complete administrator channel reads', () => {
  it('reads every page in order, preserves disabled channels and deduplicates IDs', async () => {
    const requests: URL[] = [];
    const api = createChannelsApi(createApiClient({ fetch: async input => {
      const url = new URL(String(input), 'https://console.example'); requests.push(url);
      const cursor = url.searchParams.get('cursor');
      const data = cursor === null
        ? { items: Array.from({ length: 20 }, (_, i) => channel(i + 1)), nextCursor: 'page-2' }
        : cursor === 'page-2'
          ? { items: [channel(20), ...Array.from({ length: 20 }, (_, i) => channel(i + 21))], nextCursor: 'page-3' }
          : { items: [channel(40), channel(41)], nextCursor: null };
      return Response.json({ data, request_id: 'channels-read' });
    } }));
    const result = await api.listAll();
    expect(result).toHaveLength(41);
    expect(result[20]?.id).toBe('channel-21');
    expect(result[40]).toMatchObject({ id: 'channel-41', status: 'disabled' });
    expect(requests.map(url => url.searchParams.get('cursor'))).toEqual([null, 'page-2', 'page-3']);
    expect(requests.every(url => url.searchParams.get('limit') === '20' && !url.searchParams.has('status'))).toBe(true);
  });

  it('preserves the paged list contract and optional status filtering', async () => {
    const requests: URL[] = [];
    const api = createChannelsApi(createApiClient({ fetch: async input => {
      const url = new URL(String(input), 'https://console.example'); requests.push(url);
      return Response.json({ data: { items: [channel(41)], nextCursor: url.searchParams.get('cursor') ? null : 'next' }, request_id: 'channels-read' });
    } }));
    expect((await api.list({ status: 'disabled' })).nextCursor).toBe('next');
    expect(requests).toHaveLength(1);
    expect(await api.listAll({ status: 'disabled' })).toHaveLength(1);
    expect(requests.map(url => url.searchParams.get('cursor'))).toEqual([null, null, 'next']);
    expect(requests.every(url => url.searchParams.get('status') === 'disabled')).toBe(true);
  });

  it('rejects repeated cursors rather than exposing a partial list or looping', async () => {
    let calls = 0;
    const api = createChannelsApi(createApiClient({ fetch: async () => {
      calls++;
      return Response.json({ data: { items: [channel(calls)], nextCursor: 'same-cursor' }, request_id: 'channels-read' });
    } }));
    await expect(api.listAll()).rejects.toThrow(TypeError);
    expect(calls).toBe(2);
  });

  it('rejects a middle-page failure and restarts a later read from the first page', async () => {
    const cursors: (string | null)[] = [];
    let fail = true;
    const api = createChannelsApi(createApiClient({ fetch: async input => {
      const cursor = new URL(String(input), 'https://console.example').searchParams.get('cursor'); cursors.push(cursor);
      if (cursor && fail) return Response.json({ error: { code: 'internal_error', message: 'page failed' }, request_id: 'channels-failed' }, { status: 500 });
      return Response.json({ data: { items: [channel(cursor ? 21 : 1)], nextCursor: cursor ? null : 'next' }, request_id: 'channels-read' });
    } }));
    await expect(api.listAll()).rejects.toMatchObject({ status: 500 });
    fail = false;
    expect((await api.listAll()).map(item => item.id)).toEqual(['channel-1', 'channel-21']);
    expect(cursors).toEqual([null, 'next', null, 'next']);
  });
});
