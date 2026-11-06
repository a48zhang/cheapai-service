import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '@cheapai/api-client/types';
import type { RequestRecord } from '@cheapai/contracts/requests';
import { collectRequestExport, requestExportCsv } from './export';

const row = (id: string, cost: string | null = '123456789'): RequestRecord => ({
  id,
  user_id: 'u1',
  api_key_id: 'k1',
  source: 'api',
  group_id: 'g1',
  channel_id: 'c1',
  public_model_id: 'gpt-5',
  upstream_model: 'gpt-5',
  downstream_protocol: 'chat',
  upstream_protocol: 'chat',
  execution_status: 'succeeded',
  billing_status: 'settled',
  created_at: 1000,
  started_at: 1000,
  finished_at: 2000,
  updated_at: 2000,
  usage: null,
  usage_valid: null,
  price_snapshot: null,
  price_snapshot_valid: false,
  cost_units: cost,
  error: null,
  retry_count: 0,
  next_retry_at: null,
});
const page = (items: RequestRecord[], nextCursor: string | null) => ({
  data: { items, nextCursor, snapshotAt: 2000 },
});

describe('request CSV export', () => {
  it('exports every matching page from the start, retaining exact costs and missing usage', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce(page([row('one')], 'next'))
      .mockResolvedValueOnce(page([row('two', null)], null));
    const progress = vi.fn();
    const signal = new AbortController().signal;
    const result = await collectRequestExport(
      { client: { get } as unknown as ApiClient, userId: 'u1', scope: 'personal' },
      { model: 'gpt-5', from: 500, status: 'succeeded', userId: 'other' },
      signal,
      progress,
    );
    expect(get.mock.calls.map(([path, options]) => [path, options.query])).toEqual([
      [
        '/api/v1/usage/requests',
        { model: 'gpt-5', from: 500, status: 'succeeded', cursor: null, limit: 20 },
      ],
      [
        '/api/v1/usage/requests',
        { model: 'gpt-5', from: 500, status: 'succeeded', cursor: 'next', limit: 20 },
      ],
    ]);
    expect(result.map((item) => item.id)).toEqual(['one', 'two']);
    expect(progress.mock.calls).toEqual([[1], [2]]);
    const csv = requestExportCsv(result);
    expect(csv).toContain('"1.23456789","","",""');
    expect(csv).toContain('"已结算","","","",""');
    expect(csv.startsWith('\uFEFF')).toBe(true);
  });

  it('uses admin scope and fails the whole export when a later page fails', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce(page([row('one')], 'next'))
      .mockRejectedValueOnce(new Error('读取失败'));
    await expect(
      collectRequestExport(
        { client: { get } as unknown as ApiClient, userId: 'admin', scope: 'admin' },
        { userId: 'u1' },
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toThrow('读取失败');
    expect(get.mock.calls[1]?.[0]).toBe('/api/v1/admin/requests');
    expect(get.mock.calls[1]?.[1].query.userId).toBe('u1');
  });

  it('cancels before requesting the next page and rejects a repeated cursor', async () => {
    const abort = new AbortController();
    const get = vi.fn().mockResolvedValue(page([row('one')], 'next'));
    const context = {
      client: { get } as unknown as ApiClient,
      userId: 'u1',
      scope: 'personal' as const,
    };
    await expect(
      collectRequestExport(context, {}, abort.signal, () => abort.abort()),
    ).rejects.toThrow();
    expect(get).toHaveBeenCalledTimes(1);
    get.mockClear();
    await expect(
      collectRequestExport(context, {}, new AbortController().signal, () => {}),
    ).rejects.toThrow('重复游标');
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('escapes spreadsheet formulas, commas, quotes and line breaks', () => {
    const csv = requestExportCsv([{ ...row('one'), public_model_id: '=SUM(1,2)"\n' }]);
    expect(csv).toContain('"\'=SUM(1,2)""\n"');
  });
});
