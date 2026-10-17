import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import type { ApiClient } from '@cheapai/api-client/types';
import { ApiClientError } from '@cheapai/api-client/errors';
import { createChannelsApi } from '@cheapai/api-client/channels';
import { ChannelMappingPanel } from './ChannelMappingPanel';
import { DeleteChannelAction } from './DeleteChannelAction';
import { makeChannel } from './diagnostic-test-fixtures';

it('requires confirmation before deleting a channel and closes after successful deletion', async () => {
  const user = userEvent.setup();
  const remove = vi.fn().mockResolvedValue({ data: { deleted: true } });
  const client = { delete: remove } as unknown as ApiClient;
  const onDeleted = vi.fn();
  const channel = makeChannel();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <DeleteChannelAction
          channel={channel}
          api={createChannelsApi(client)}
          actorId="admin"
          epoch={1}
          busy={false}
          onBusyChange={vi.fn()}
          onDeleted={onDeleted}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await user.click(screen.getByRole('button', { name: '删除渠道' }));
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '取消' }));
  expect(remove).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '删除渠道' }));
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '删除渠道' }));
  await waitFor(() => expect(onDeleted).toHaveBeenCalledOnce());
  expect(remove).toHaveBeenCalledWith(`/api/v1/admin/channels/${channel.id}`, {
    version: channel.configVersion,
  });
});

it('keeps a mapping deletion conflict visible and deletes only its tuple after retry', async () => {
  const user = userEvent.setup();
  const remove = vi
    .fn()
    .mockRejectedValueOnce(new ApiClientError('api', 'conflict', { status: 409, code: 'conflict' }))
    .mockResolvedValue({ data: { deleted: true } });
  const client = { delete: remove } as unknown as ApiClient;
  const channel = makeChannel();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ChannelMappingPanel channel={channel} client={client} actorId="admin" sessionEpoch={1} />
    </QueryClientProvider>,
  );
  await user.click(screen.getByRole('button', { name: '删除' }));
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '删除映射' }));
  expect(
    await screen.findByText('模型映射已被修改或删除，请关闭确认框，重新读取后再操作。'),
  ).toBeVisible();
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '取消' }));
  await user.click(screen.getByRole('button', { name: '删除' }));
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '删除映射' }));
  expect(await screen.findByText('模型映射已删除，全局模型已保留。')).toBeVisible();
  expect(remove).toHaveBeenLastCalledWith(
    `/api/v1/admin/models/gpt-demo-a/mappings/${channel.id}/chat`,
    { version: 2 },
  );
});
