import { expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { createApiClient } from '@cheapai/api-client/client';
import { render, screen, waitFor, within } from '../../test/render';
import { useSession } from '../../features/session/useSession';
import { BillingPage } from './BillingPage';

vi.mock('../../features/session/useSession', () => ({ useSession: vi.fn() }));

it('keeps billing rows and original pagination diagnostics, then retries the failed cursor', async () => {
  const cursors: (string | null)[] = [];
  let failNextPage = true;
  const envelope = (data: unknown) => Response.json({ data, request_id: 'billing-test' });
  const client = createApiClient({
    fetch: async (input) => {
      const url = new URL(String(input), 'https://example.test');
      if (url.pathname === '/api/v1/account/balance')
        return envelope({
          currency: 'USD',
          decimals: 8,
          balance_units: '100000000',
          balance_usd: '1.00000000',
        });
      const cursor = url.searchParams.get('cursor');
      cursors.push(cursor);
      if (cursor && failNextPage)
        return Response.json(
          {
            error: { code: 'service_unavailable', message: 'Ledger read timed out' },
            request_id: 'billing-page-failure',
          },
          { status: 503 },
        );
      return envelope({
        items: [
          {
            id: cursor ? 'entry-two' : 'entry-one',
            operationId: cursor ? 'op-two' : 'op-one',
            kind: 'consumption',
            userId: 'owner',
            requestId: null,
            currency: 'USD',
            deltaUnits: '-10000',
            createdBy: null,
            reason: null,
            modelId: cursor ? 'second-model' : 'first-model',
            createdAt: '2026-11-06T00:00:00Z',
          },
        ],
        nextCursor: cursor ? null : 'next-page',
        summary: {
          currency: 'USD',
          consumptionUnits: '20000',
          createdFrom: null,
          createdBefore: null,
        },
      });
    },
  });
  vi.mocked(useSession).mockReturnValue({
    client,
    user: { id: 'owner' },
    state: { status: 'authenticated' },
  } as unknown as ReturnType<typeof useSession>);
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={['/billing?period=all']}>
      <BillingPage />
    </MemoryRouter>,
  );
  await screen.findByRole('button', { name: '加载更多' });
  await user.click(screen.getByRole('button', { name: '加载更多' }));
  const alert = await screen.findByRole('alert');
  expect(screen.getAllByText('first-model').length).toBeGreaterThan(0);
  expect(screen.queryByText('费用读取失败。')).not.toBeInTheDocument();
  await user.click(within(alert).getByRole('button', { name: '查看错误详情' }));
  expect(within(alert).getByText(/Ledger read timed out/)).toBeVisible();
  expect(within(alert).getByText(/HTTP 状态：503/)).toBeVisible();
  expect(within(alert).getByText(/billing-page-failure/)).toBeVisible();
  expect(within(alert).getByRole('button', { name: '复制错误详情' })).toBeVisible();
  failNextPage = false;
  await user.click(within(alert).getByRole('button', { name: '重试' }));
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  expect(screen.getAllByText('second-model').length).toBeGreaterThan(0);
  expect(cursors).toEqual([null, 'next-page', 'next-page']);
});
