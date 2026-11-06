import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { RequestDetailPage } from './RequestDetailPage';

vi.mock('../../features/session/useSession', () => ({
  useSession: () => ({ client: {}, user: { id: 'user' }, state: { status: 'authenticated' } }),
}));
vi.mock('../../features/request-history/api', () => ({ requestDetailQueryOptions: () => ({}) }));
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
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
      billing_status: 'settled',
      source: 'api',
      created_at: 1000,
      started_at: 1000,
      finished_at: 2000,
      updated_at: 2000,
      retry_count: 2,
      next_retry_at: 3000,
      cost_units: '100000000',
      error: { code: 'upstream_error', message: 'internal provider diagnostic' },
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
  it('个人记录保留核账依据和请求编号，不展示内部路由与原始错误', async () => {
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
    expect(screen.queryByText('internal provider diagnostic')).not.toBeInTheDocument();
    expect(screen.queryByText('下次结算重试')).not.toBeInTheDocument();
  });

  it('管理员仍可展开内部诊断与路由信息', async () => {
    const user = userEvent.setup();
    show('/admin/requests/request-for-support');
    await user.click(screen.getByRole('button', { name: '技术详情' }));
    await user.click(screen.getByRole('button', { name: '服务返回信息' }));
    expect(screen.getByText('private-channel')).toBeVisible();
    expect(screen.getByText('private-model')).toBeVisible();
    expect(screen.getByText('internal provider diagnostic')).toBeVisible();
    expect(screen.getByText('下次结算重试')).toBeVisible();
  });
});
