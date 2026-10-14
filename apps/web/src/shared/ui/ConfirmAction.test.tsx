import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { ConfirmAction } from './ConfirmAction';

it('keeps an async confirmation open while pending and on failure, then closes after a successful retry', async () => {
  const user = userEvent.setup();
  let reject!: (error: Error) => void;
  const onConfirm = vi
    .fn<() => Promise<void>>()
    .mockImplementationOnce(
      () =>
        new Promise<void>((_, fail) => {
          reject = fail;
        }),
    )
    .mockResolvedValue(undefined);
  render(
    <ConfirmAction
      defaultOpen
      title="撤销密钥"
      description="撤销后无法继续使用。"
      onConfirm={onConfirm}
    />,
  );
  await user.click(screen.getByRole('button', { name: '确认' }));
  expect(screen.getByRole('button', { name: '确认' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '取消' })).toBeDisabled();
  await user.keyboard('{Escape}');
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  await act(async () => {
    reject(new Error('连接中断，请重试'));
  });
  expect(await screen.findByRole('alert')).toHaveTextContent('连接中断，请重试');
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '确认' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(onConfirm).toHaveBeenCalledTimes(2);
});
