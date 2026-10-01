import { describe, expect, it } from 'vitest';
import { decodeGroup, isBillingMultiplier } from '../../apps/web/src/api/admin-groups';
import { decodeRequest } from '../../apps/web/src/api/requests';

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
    expect(() => decodeRequest(request({ source: 'web_chat', group_id: 42 }))).toThrow(TypeError);
    expect(() => decodeRequest(request({ source: 'virtual_key' }))).toThrow(TypeError);
  });

  it('decodes group facts in new price snapshots while preserving legacy snapshots', () => {
    const decoded = decodeRequest(request({ price_snapshot: priceSnapshot({ group_id: 'group-1', group_version: 3, billing_multiplier: '0.2' }), price_snapshot_valid: true }));
    expect(decoded.price_snapshot).toMatchObject({ group_id: 'group-1', group_version: 3, billing_multiplier: '0.2' });
    expect(decodeRequest(request())).toMatchObject({ price_snapshot: null, price_snapshot_valid: false });
    expect(() => decodeRequest(request({ price_snapshot: priceSnapshot({ group_version: 0 }), price_snapshot_valid: true }))).toThrow(TypeError);
    expect(() => decodeRequest(request({ price_snapshot: priceSnapshot({ billing_multiplier: '1e-1' }), price_snapshot_valid: true }))).toThrow(TypeError);
    expect(() => decodeRequest(request({ price_snapshot: priceSnapshot({ extra: 'unexpected' }), price_snapshot_valid: true }))).toThrow(TypeError);
  });
});
