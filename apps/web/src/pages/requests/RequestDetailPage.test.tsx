import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { RequestDetailPage } from './RequestDetailPage';

const queryState = vi.hoisted(() => ({
  billingStatus: 'settled',
  nextRetryAt: 3000 as number | null,
  refetch: vi.fn(),
}));
afterEach(() => {
  queryState.billingStatus = 'settled';
  queryState.nextRetryAt = 3000;
  queryState.refetch.mockReset();
});

vi.mock('../../features/session/useSession', () => ({
  useSession: () => ({ client: {}, user: { id: 'user' }, state: { status: 'authenticated' } }),
}));
vi.mock('../../features/request-history/api', () => ({ requestDetailQueryOptions: () => ({}) }));
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
    refetch: queryState.refetch,
    isFetching: false,
    data: {
      id: 'request-for-support',
      user_id: 'user',
      api_key_id: 'key',
      public_model_id: 'public-model',
      group_name: '标准分组',
      group_id: 'internal-group',
      channel_id: 'private-channel',
      upstream_model: 'private-model',
      downstream_protocol: 'responses',
      upstream_protocol: 'chat',
      execution_status: 'failed',
      billing_status: queryState.billingStatus,
      source: 'api',
      created_at: 1000,
      started_at: 1000,
      finished_at: 2000,
      updated_at: 2000,
      retry_count: 2,
      next_retry_at: queryState.nextRetryAt,
      cost_units: '100000000',
      error: {
        code: 'upstream_error',
        message: 'HTTP 429: rate limit exceeded; retry after 30 seconds',
      },
      usage: {
        protocol: 'responses',
        quality: 'complete',
        counts: { inputTokens: 100, outputTokens: 20 },
        semantics: {
          cacheRead: 'unknown',
          cacheWrite: 'unknown',
          reasoning: 'unknown',
          cacheWriteTtl: 'unknown',
        },
      },
      usage_valid: true,
      price_snapshot_valid: true,
      price_snapshot: {
        public_model_id: 'public-model',
        upstream_model: 'private-model',
        upstream_protocol: 'chat',
        group_id: 'internal-group',
        billing_multiplier: '1.5',
        sell_prices: { input: '2', output: '6' },
      },
    },
  }),
}));

function show(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/requests/:id" element={<RequestDetailPage />} />
        <Route path="/admin/requests/:id" element={<RequestDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('使用记录信息范围', () => {
  it('个人记录保留核账依据和可复制错误详情，不展示内部路由', async () => {
    const user = userEvent.setup();
    show('/requests/request-for-support');
    await user.click(screen.getByRole('button', { name: '技术详情' }));
    await user.click(screen.getByRole('button', { name: '计费依据' }));
    expect(screen.getByText('request-for-support')).toBeVisible();
    expect(screen.getByText('输入 Token')).toBeVisible();
    expect(screen.getByText('计费倍率')).toBeVisible();
    expect(screen.getByText('1.5')).toBeVisible();
    expect(screen.getAllByText('responses')[0]).toBeVisible();
    expect(screen.queryByText('渠道 ID')).not.toBeInTheDocument();
    expect(screen.queryByText('private-model')).not.toBeInTheDocument();
    expect(screen.queryByText('internal-group')).not.toBeInTheDocument();
    expect(
      screen.getByText('HTTP 429: rate limit exceeded; retry after 30 seconds'),
    ).not.toBeVisible();
    const clipboard = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    await user.click(screen.getByRole('button', { name: '服务返回信息' }));
    expect(screen.getByText('HTTP 429: rate limit exceeded; retry after 30 seconds')).toBeVisible();
    expect(screen.getByText('upstream_error')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '复制错误详情' }));
    expect(clipboard).toHaveBeenCalledWith(
      '请求 ID: request-for-support\n错误码: upstream_error\nHTTP 429: rate limit exceeded; retry after 30 seconds',
    );
    expect(screen.queryByText('下次结算重试')).not.toBeInTheDocument();
  });

  it('暂停的结算提供核查编号和刷新出口，不承诺自动完成', async () => {
    const user = userEvent.setup();
    queryState.billingStatus = 'settlement_pending';
    queryState.nextRetryAt = null;
    show('/requests/request-for-support');
    expect(screen.getByText(/自动结算已暂停，需要管理员核查/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: '刷新处理状态' }));
    expect(queryState.refetch).toHaveBeenCalledOnce();
    const clipboard = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    await user.click(screen.getByRole('button', { name: '复制待核查请求编号' }));
    expect(clipboard).toHaveBeenCalledWith('request-for-support');
  });

  it('管理员仍可展开内部诊断与路由信息', async () => {
    const user = userEvent.setup();
    show('/admin/requests/request-for-support');
    await user.click(screen.getByRole('button', { name: '技术详情' }));
    await user.click(screen.getByRole('button', { name: '服务返回信息' }));
    expect(screen.getByText('private-channel')).toBeVisible();
    expect(screen.getByText('private-model')).toBeVisible();
    expect(screen.getByText('HTTP 429: rate limit exceeded; retry after 30 seconds')).toBeVisible();
    expect(screen.getByText('下次结算重试')).toBeVisible();
  });
});
