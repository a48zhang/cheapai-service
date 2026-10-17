import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import type { ApiClient } from '@cheapai/api-client/types';
import { ApiClientError } from '@cheapai/api-client/errors';
import { createApiClient } from '@cheapai/api-client/client';
import { ChannelManagement } from './ChannelManagement';
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

it('saves settings with the refreshed version after mapping deletion without losing an unsaved draft', async () => {
  const user = userEvent.setup();
  const initial = makeChannel();
  let stored = initial;
  const patches: Record<string, unknown>[] = [];
  const client = createApiClient({
    getCsrfToken: () => 'test-csrf-token',
    fetch: async (input, init) => {
      const path = new URL(String(input), 'https://console.example').pathname;
      const method = init?.method ?? 'GET';
      const success = (data: unknown) => Response.json({ data, request_id: 'deletion-flow-test' });
      if (path === `/api/v1/admin/channels/${initial.id}` && method === 'GET')
        return success(stored);
      if (path.endsWith(`/mappings/${initial.id}/chat`) && method === 'DELETE') {
        stored = { ...stored, configVersion: stored.configVersion + 1, models: [] };
        return success({ deleted: true });
      }
      if (path === `/api/v1/admin/channels/${initial.id}` && method === 'PATCH') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        patches.push(body);
        if (body.version !== stored.configVersion)
          return Response.json(
            {
              error: { code: 'conflict', message: 'stale channel version' },
              request_id: 'deletion-flow-test',
            },
            { status: 409 },
          );
        stored = { ...stored, name: String(body.name), configVersion: stored.configVersion + 1 };
        return success(stored);
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    },
  });
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter>
        <ChannelManagement
          channel={initial}
          client={client}
          actorId="admin"
          sessionEpoch={1}
          initialTab="settings"
          onOpenChange={vi.fn()}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await user.clear(screen.getByRole('textbox', { name: '渠道名称' }));
  await user.type(screen.getByRole('textbox', { name: '渠道名称' }), 'Unsaved channel name');
  await user.type(screen.getByLabelText('替换上游凭证'), 'unsaved-test-credential');
  await user.click(screen.getByRole('tab', { name: '模型管理' }));
  await user.click(screen.getByRole('button', { name: '删除' }));
  await user.click(
    within(screen.getByRole('dialog', { name: /删除 gpt-demo-a/ })).getByRole('button', {
      name: '删除映射',
    }),
  );
  await screen.findByText('模型映射已删除，全局模型已保留。');
  await waitFor(() => expect(screen.getByRole('tab', { name: '渠道配置' })).toBeEnabled());
  await user.click(screen.getByRole('tab', { name: '渠道配置' }));
  expect(screen.getByRole('textbox', { name: '渠道名称' })).toHaveValue('Unsaved channel name');
  expect(screen.getByLabelText('替换上游凭证')).toHaveValue('unsaved-test-credential');
  await user.click(screen.getByRole('button', { name: '保存更改' }));
  await screen.findByText('更改已保存');
  expect(patches).toEqual([
    expect.objectContaining({
      version: initial.configVersion + 1,
      name: 'Unsaved channel name',
      upstreamKey: 'unsaved-test-credential',
    }),
  ]);
  expect(screen.getByLabelText('替换上游凭证')).toHaveValue('');
});
