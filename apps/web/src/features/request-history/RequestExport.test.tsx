import { afterEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ApiClient } from '@cheapai/api-client/types';
import type { RequestRecord } from '@cheapai/contracts/requests';
import { RequestExport } from './RequestExport';

const mocks = vi.hoisted(() => ({ collect: vi.fn(), download: vi.fn() }));
vi.mock('./export', () => ({
  collectRequestExport: mocks.collect,
  downloadRequestExport: mocks.download,
}));
vi.mock('../session/public', () => ({
  useSession: () => ({
    client: {} as ApiClient,
    user: { id: 'u1' },
    epoch: 1,
  }),
}));
afterEach(() => vi.clearAllMocks());

it('downloads only a complete export and lets a failed export be retried', async () => {
  mocks.collect
    .mockRejectedValueOnce(new Error('第二页读取失败'))
    .mockResolvedValueOnce([{ id: 'one' }] as RequestRecord[]);
  render(<RequestExport scope="personal" filters={{ model: 'gpt-5' }} />);
  fireEvent.click(screen.getByRole('button', { name: '导出全部筛选结果（CSV）' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('第二页读取失败');
  expect(mocks.download).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  expect(await screen.findByRole('status')).toHaveTextContent('已导出 1 条记录');
  expect(mocks.download).toHaveBeenCalledTimes(1);
});

it('cancels in-flight export on filter changes and never downloads its late response', async () => {
  let finish!: (rows: RequestRecord[]) => void;
  mocks.collect.mockImplementationOnce(
    () =>
      new Promise<RequestRecord[]>((resolve) => {
        finish = resolve;
      }),
  );
  const view = render(<RequestExport scope="personal" filters={{ model: 'gpt-5' }} />);
  fireEvent.click(screen.getByRole('button', { name: '导出全部筛选结果（CSV）' }));
  const signal = mocks.collect.mock.calls[0]?.[2] as AbortSignal;
  expect(screen.getByRole('button', { name: '取消导出' })).toBeVisible();
  view.rerender(<RequestExport scope="personal" filters={{ model: 'gpt-4' }} />);
  expect(signal.aborted).toBe(true);
  finish([{ id: 'old' }] as RequestRecord[]);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '导出全部筛选结果（CSV）' })).toBeEnabled(),
  );
  expect(mocks.download).not.toHaveBeenCalled();
});
