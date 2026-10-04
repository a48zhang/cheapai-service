import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ApiClient, ApiRequestOptions } from '@cheapai/api-client/types';
import type { KeyCreation, KeyMetadata } from '@cheapai/api-client/keys';
import type { CodeBatch } from '@cheapai/contracts/registration-admin';
import KeysPage from '../../pages/keys/KeysPage';
import { KeyForm } from './KeyForm';
import { createApiAccessApi } from './api';
import { CodeBatchDialog } from '../admin-registration/public';

const mocks = vi.hoisted(() => ({
  session: {
    user: null as null | { id: string; role: 'user' | 'admin' },
    epoch: 0,
    client: null as unknown,
    queryClient: null as unknown,
  },
  createCodes: vi.fn(),
}));

vi.mock('../../features/session/useSession', () => ({ useSession: () => mocks.session }));
vi.mock('@cheapai/api-client/registration-admin', () => ({
  createAdminRegistrationApi: () => ({ createCodes: mocks.createCodes }),
}));

const keyToken = `s2a_key_${'K'.repeat(43)}`;
const keyTokenForNextOwner = `s2a_key_${'B'.repeat(43)}`;
const inviteToken = `s2a_invite_${'I'.repeat(43)}`;
const metadata = {
  id: 'key-1',
  userId: 'user-1',
  groupId: 'group-1',
  groupName: 'Default',
  name: 'fixture',
  displayPrefix: 's2a_key_ABCDEFGH',
  status: 'active',
  allowedModels: null,
  expiresAt: null,
  createdAt: 10,
  updatedAt: 10,
  version: 1,
} as const satisfies KeyMetadata;
const inviteMetadata = {
  id: 'invite-1',
  displayPrefix: 's2a_invite_ABCDEFGH',
  ordinal: 0,
  expiresAt: Date.now() + 3_600_000,
};
const createdCodes: CodeBatch = {
  batchId: 'batch-1',
  replayed: false,
  codes: [{ ...inviteMetadata, token: inviteToken }],
};
const replayedCodes: CodeBatch = {
  batchId: 'batch-1',
  replayed: true,
  codes: [inviteMetadata],
};

let keyCreation: KeyCreation;
let queryClient: QueryClient;

function createClient(
  delayedPost?: Promise<never>,
  queuedPosts: Promise<never>[] = [],
  onPost?: () => void,
): ApiClient {
  const postQueue = [...(delayedPost ? [delayedPost] : []), ...queuedPosts];
  return {
    get: async <T = unknown,>(
      path: string,
      input?: Omit<ApiRequestOptions<T>, 'method' | 'body'>,
    ) => {
      const rawData: unknown = path.endsWith('/key-groups')
        ? { items: [{ id: 'group-1', name: 'Default', models: [] }] }
        : { items: [], nextCursor: null };
      return {
        data: input?.decode ? input.decode(rawData) : (rawData as T),
        request_id: 'key-lifecycle',
      };
    },
    post: async () => {
      onPost?.();
      return postQueue.shift() ?? ({ data: keyCreation, request_id: 'key-lifecycle' } as never);
    },
  } as unknown as ApiClient;
}

function withKeysPage(client: QueryClient) {
  return (
    <QueryClientProvider client={client}>
      <KeysPage />
    </QueryClientProvider>
  );
}

function containsSecret(value: unknown, secret: string, seen = new Set<object>()): boolean {
  if (value === secret) return true;
  if (value === null || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  return Object.values(value).some((child) => containsSecret(child, secret, seen));
}

function futureLocalDateTime(): string {
  const date = new Date(Date.now() + 3_600_000);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

beforeEach(() => {
  vi.stubGlobal('crypto', { randomUUID: () => 'stable-test-operation' });
  mocks.session.user = { id: 'user-1', role: 'user' };
  mocks.session.epoch = 1;
  mocks.createCodes.mockReset();
  mocks.createCodes.mockResolvedValue(createdCodes);
  keyCreation = { kind: 'created', key: metadata, token: keyToken };
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mocks.session.queryClient = queryClient;
  mocks.session.client = createClient();
});

afterEach(() => {
  queryClient.clear();
  vi.unstubAllGlobals();
});

async function createKey(user = userEvent.setup()) {
  await user.click(screen.getByRole('button', { name: /创建 Key/ }));
  const dialog = await screen.findByRole('dialog');
  await user.type(within(dialog).getByLabelText(/名称/), metadata.name);
  await waitFor(() =>
    expect(within(dialog).getByRole('combobox', { name: /分组/ })).toHaveValue('group-1'),
  );
  await user.click(within(dialog).getByRole('button', { name: /创建 Key/ }));
  return within(await screen.findByRole('dialog')).findByRole('textbox', { name: /完整密钥/ });
}

async function createInvite(user = userEvent.setup(), onOpenChange = vi.fn(), expectSecret = true) {
  const view = render(<CodeBatchDialog open onOpenChange={onOpenChange} onCreated={vi.fn()} />);
  fireEvent.change(screen.getByLabelText(/有效期/), { target: { value: futureLocalDateTime() } });
  await user.click(screen.getByRole('button', { name: /生成邀请码/ }));
  if (expectSecret) await screen.findByText(inviteToken);
  else await screen.findByRole('listitem');
  return { view, onOpenChange, user };
}

describe('one-time credential lifecycle', () => {
  it('notifies the owner to close after handing off a newly created Key secret', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const onChanged = vi.fn();
    const onSecret = vi.fn();
    render(
      <QueryClientProvider client={queryClient}>
        <KeyForm
          open
          mode="create"
          api={createApiAccessApi(mocks.session.client as ApiClient)}
          userId="user-1"
          onOpenChange={onOpenChange}
          onChanged={onChanged}
          onSecret={onSecret}
        />
      </QueryClientProvider>,
    );
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/名称/), metadata.name);
    await waitFor(() =>
      expect(within(dialog).getByRole('combobox', { name: /分组/ })).toHaveValue('group-1'),
    );
    await user.click(within(dialog).getByRole('button', { name: /创建 Key/ }));

    await waitFor(() => expect(onSecret).toHaveBeenCalledTimes(1));
    expect(onSecret).toHaveBeenCalledWith(keyToken, metadata.name);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('clears a created Key on session identity change and unmount, and never puts it in query data', async () => {
    const user = userEvent.setup();
    const view = render(withKeysPage(queryClient));
    const secretField = await createKey(user);
    expect(secretField).toHaveValue(keyToken);
    expect(
      queryClient
        .getQueryCache()
        .getAll()
        .some((query) => containsSecret(query.state.data, keyToken)),
    ).toBe(false);

    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: /关闭密钥对话框/ }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: /完整密钥/ })).not.toBeInTheDocument(),
    );
    expect(document.body.textContent).not.toContain(keyToken);

    await createKey(user);
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: /完整密钥/ })).toHaveValue(keyToken),
    );

    mocks.session.epoch++;
    view.rerender(withKeysPage(queryClient));
    expect(screen.queryByRole('textbox', { name: /完整密钥/ })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(keyToken);

    const afterEpochSecret = await createKey(user);
    expect(afterEpochSecret).toHaveValue(keyToken);

    mocks.session.user = { id: 'user-2', role: 'user' };
    mocks.session.epoch++;
    view.rerender(withKeysPage(queryClient));
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: /完整密钥/ })).not.toBeInTheDocument(),
    );
    expect(document.body.textContent).not.toContain(keyToken);

    const nextSecretField = await createKey(user);
    expect(nextSecretField).toHaveValue(keyToken);
    view.unmount();
    expect(document.body.textContent).not.toContain(keyToken);
  });

  it('does not display a secret when a Key creation response is replayed', async () => {
    keyCreation = { kind: 'replayed', key: metadata };
    const user = userEvent.setup();
    render(withKeysPage(queryClient));
    await user.click(screen.getByRole('button', { name: /创建 Key/ }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/名称/), metadata.name);
    await waitFor(() =>
      expect(within(dialog).getByRole('combobox', { name: /分组/ })).toHaveValue('group-1'),
    );
    await user.click(within(dialog).getByRole('button', { name: /创建 Key/ }));

    await waitFor(() =>
      expect(within(screen.getByRole('dialog')).getByRole('status')).toBeInTheDocument(),
    );
    expect(screen.queryByRole('textbox', { name: /完整密钥/ })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(keyToken);
  });

  it('does not expose a late Key response after a session epoch change', async () => {
    let resolvePost!: (value: never) => void;
    const delayedPost = new Promise<never>((resolve) => {
      resolvePost = resolve;
    });
    mocks.session.client = createClient(delayedPost);
    const user = userEvent.setup();
    const view = render(withKeysPage(queryClient));
    await user.click(screen.getByRole('button', { name: /创建 Key/ }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/名称/), metadata.name);
    await waitFor(() =>
      expect(within(dialog).getByRole('combobox', { name: /分组/ })).toHaveValue('group-1'),
    );
    await user.click(within(dialog).getByRole('button', { name: /创建 Key/ }));
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: /正在确认/ })).toBeDisabled(),
    );

    mocks.session.epoch++;
    view.rerender(withKeysPage(queryClient));
    expect(screen.queryByRole('textbox', { name: /完整密钥/ })).not.toBeInTheDocument();
    resolvePost({ data: keyCreation, request_id: 'key-lifecycle' } as never);

    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: /完整密钥/ })).not.toBeInTheDocument(),
    );
    expect(document.body.textContent).not.toContain(keyToken);
  });

  it('keeps a new identity busy when an earlier create request settles', async () => {
    let resolveOldPost!: (value: never) => void;
    let resolveNextPost!: (value: never) => void;
    const oldPost = new Promise<never>((resolve) => {
      resolveOldPost = resolve;
    });
    const nextPost = new Promise<never>((resolve) => {
      resolveNextPost = resolve;
    });
    const post = vi.fn();
    const api = createApiAccessApi(createClient(oldPost, [nextPost], post));
    const onSecret = vi.fn();
    const onChanged = vi.fn();
    const onOpenChange = vi.fn();
    const renderForm = (userId: string, epoch: number, open: boolean) => (
      <QueryClientProvider client={queryClient}>
        <KeyForm
          open={open}
          mode="create"
          api={api}
          userId={userId}
          epoch={epoch}
          onOpenChange={onOpenChange}
          onChanged={onChanged}
          onSecret={onSecret}
        />
      </QueryClientProvider>
    );
    const user = userEvent.setup();
    const view = render(renderForm('user-1', 1, true));

    let dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/名称/), 'Key A');
    await waitFor(() =>
      expect(within(dialog).getByRole('combobox', { name: /分组/ })).toHaveValue('group-1'),
    );
    await user.click(within(dialog).getByRole('button', { name: /创建 Key/ }));
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: /正在确认/ })).toBeDisabled(),
    );
    expect(post).toHaveBeenCalledTimes(1);

    view.rerender(renderForm('user-2', 2, false));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    view.rerender(renderForm('user-2', 2, true));
    dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/名称/), 'Key B');
    await waitFor(() =>
      expect(within(dialog).getByRole('combobox', { name: /分组/ })).toHaveValue('group-1'),
    );
    await user.click(within(dialog).getByRole('button', { name: /创建 Key/ }));
    const nextOwnerSubmit = await within(dialog).findByRole('button', { name: /正在确认/ });
    expect(nextOwnerSubmit).toBeDisabled();
    expect(post).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveOldPost({
        data: {
          kind: 'created',
          key: { ...metadata, id: 'key-old-owner', userId: 'user-1', name: 'Key A' },
          token: keyToken,
        },
        request_id: 'key-old-owner',
      } as never);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(nextOwnerSubmit).toBeDisabled();
    fireEvent.click(nextOwnerSubmit);
    expect(post).toHaveBeenCalledTimes(2);
    expect(onSecret).not.toHaveBeenCalled();

    await act(async () => {
      resolveNextPost({
        data: {
          kind: 'created',
          key: { ...metadata, id: 'key-next-owner', userId: 'user-2', name: 'Key B' },
          token: keyTokenForNextOwner,
        },
        request_id: 'key-next-owner',
      } as never);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(() => expect(onSecret).toHaveBeenCalledTimes(1));
    expect(onSecret).toHaveBeenCalledWith(keyTokenForNextOwner, 'Key B');
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledWith({
      ...metadata,
      id: 'key-next-owner',
      userId: 'user-2',
      name: 'Key B',
    });
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('removes an invite batch secret on close, identity change, and unmount', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const { view } = await createInvite(user, onOpenChange);
    expect(screen.getByText(inviteToken)).toBeInTheDocument();
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getAllByRole('button', { name: /关闭/ })[0]!);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    view.rerender(<CodeBatchDialog open={false} onOpenChange={onOpenChange} onCreated={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText(inviteToken)).not.toBeInTheDocument());

    const second = await createInvite(user);
    mocks.session.epoch++;
    second.view.rerender(<CodeBatchDialog open onOpenChange={vi.fn()} onCreated={vi.fn()} />);
    expect(screen.queryByText(inviteToken)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(inviteToken);

    fireEvent.change(screen.getByLabelText(/有效期/), { target: { value: futureLocalDateTime() } });
    await user.click(screen.getByRole('button', { name: /生成邀请码/ }));
    await screen.findByText(inviteToken);

    mocks.session.user = { id: 'user-2', role: 'user' };
    mocks.session.epoch++;
    second.view.rerender(<CodeBatchDialog open onOpenChange={vi.fn()} onCreated={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText(inviteToken)).not.toBeInTheDocument());
    second.view.unmount();

    const third = await createInvite(user);
    third.view.unmount();
    expect(document.body.textContent).not.toContain(inviteToken);
  });

  it('renders replay metadata without a restored invite secret', async () => {
    mocks.createCodes.mockResolvedValue(replayedCodes);
    const { view } = await createInvite(userEvent.setup(), vi.fn(), false);
    expect(within(screen.getByRole('dialog')).getByRole('listitem')).toBeInTheDocument();
    expect(screen.queryByText(inviteToken)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(inviteToken);
    view.unmount();
  });
});
