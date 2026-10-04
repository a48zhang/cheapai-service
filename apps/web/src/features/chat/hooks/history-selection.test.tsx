import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ApiClient } from '@cheapai/api-client/types';
import type { ChatApiContext } from '../api';
import { modelOptionKey } from '../model/model-options';
import { useHistory } from './useHistory';
import { useModelSelection } from './useModelSelection';

const timestamp = 1_700_000_000_000;
const conversation = (id: string, patch: Record<string, unknown> = {}) => ({
  id,
  title: id,
  groupId: 'group-1',
  modelId: 'model-1',
  version: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
  ...patch,
});

const models = {
  items: [
    { id: 'empty-group', name: 'empty', billingMultiplier: '1', models: [] },
    {
      id: 'group-1',
      name: 'primary',
      billingMultiplier: '0.5',
      models: [{ publicModelId: 'model-1' }, { publicModelId: 'model-2', maxOutputTokens: 4096 }],
    },
  ],
};

type ChatRead = (path: string, cursor: string | null) => unknown | Promise<unknown>;

function chatContext(
  userId: string,
  epoch: number,
  read: ChatRead,
): { context: ChatApiContext; get: ReturnType<typeof vi.fn> } {
  const get = vi.fn(
    async (path: string, input?: { readonly query?: { readonly cursor?: string | null } }) => ({
      data: await read(path, input?.query?.cursor ?? null),
    }),
  );
  const client = { get } as unknown as ApiClient;
  return {
    context: { userId, epoch, client, getCsrfToken: () => 'csrf' },
    get,
  };
}

function queryHarness() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  function wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return { client, wrapper };
}

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

afterEach(() => cleanup());

describe('React chat history hook', () => {
  it('single-flights page loads and merges duplicate rows using the newest server version', async () => {
    let resolveNext!: (value: unknown) => void;
    const { context, get } = chatContext('history-user', 1, (_path, cursor) => {
      if (cursor === null)
        return {
          items: [
            conversation('conversation-a'),
            conversation('conversation-b', { updatedAt: timestamp + 5 }),
          ],
          nextCursor: 'next',
        };
      return new Promise((resolve) => {
        resolveNext = resolve;
      });
    });
    const { wrapper } = queryHarness();
    const { result } = renderHook(() => useHistory({ context }), { wrapper });
    await waitFor(() =>
      expect(result.current.conversations.map((item) => item.id)).toEqual([
        'conversation-b',
        'conversation-a',
      ]),
    );

    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current.loadMore();
    });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    act(() => {
      void result.current.loadMore();
    });
    expect(get).toHaveBeenCalledTimes(2);

    act(() =>
      resolveNext({
        items: [
          conversation('conversation-a', { version: 3, title: 'newer', updatedAt: timestamp + 10 }),
          conversation('conversation-c', { updatedAt: timestamp + 8 }),
        ],
        nextCursor: null,
      }),
    );
    await act(async () => {
      await pending;
    });
    await waitFor(() =>
      expect(result.current.conversations.map((item) => item.id)).toEqual([
        'conversation-a',
        'conversation-c',
        'conversation-b',
      ]),
    );
    expect(result.current.conversations[0]).toMatchObject({ version: 3, title: 'newer' });
    expect(result.current.hasMore).toBe(false);
  });

  it('stops on a repeated cursor and refreshes the query from its first page on retry', async () => {
    let firstPageReads = 0;
    const { context } = chatContext('cursor-user', 2, (_path, cursor) => {
      if (cursor === null) {
        firstPageReads += 1;
        return firstPageReads === 1
          ? { items: [conversation('first')], nextCursor: 'loop' }
          : { items: [conversation('refreshed')], nextCursor: null };
      }
      if (cursor === 'loop') return { items: [conversation('second')], nextCursor: 'loop' };
      return { items: [], nextCursor: null };
    });
    const { wrapper } = queryHarness();
    const { result } = renderHook(() => useHistory({ context }), { wrapper });
    await waitFor(() => expect(result.current.hasMore).toBe(true));
    await act(async () => {
      await result.current.loadMore();
    });

    await waitFor(() => expect(result.current.hasMore).toBe(false));
    expect(result.current.conversations.map((item) => item.id)).toEqual(['second', 'first']);
    expect(result.current.error).toBeInstanceOf(Error);

    await act(async () => {
      await result.current.retry();
    });
    await waitFor(() =>
      expect(result.current.conversations.map((item) => item.id)).toEqual(['refreshed']),
    );
    expect(result.current.error).toBeNull();
  });

  it('keeps the failed cursor and retries the same page without dropping existing conversations', async () => {
    let nextPageReads = 0;
    const { context, get } = chatContext('retry-history-user', 1, (_path, cursor) => {
      if (cursor === null) return { items: [conversation('kept')], nextCursor: 'next-page' };
      nextPageReads += 1;
      if (nextPageReads === 1) throw new Error('temporary transport failure');
      return { items: [conversation('loaded-after-retry')], nextCursor: null };
    });
    const { wrapper } = queryHarness();
    const { result } = renderHook(() => useHistory({ context }), { wrapper });
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    await act(async () => {
      await result.current.loadMore();
    });
    await waitFor(() => expect(result.current.loadingMore).toBe(false));
    expect(result.current.conversations.map((item) => item.id)).toEqual(['kept']);
    expect(result.current.hasMore).toBe(true);
    expect(get.mock.calls.at(-1)?.[1]?.query?.cursor).toBe('next-page');

    await act(async () => {
      await result.current.retry();
    });
    await waitFor(() =>
      expect(result.current.conversations.map((item) => item.id)).toEqual([
        'loaded-after-retry',
        'kept',
      ]),
    );
    expect(get.mock.calls.at(-1)?.[1]?.query?.cursor).toBe('next-page');
    expect(result.current.hasMore).toBe(false);
  });

  it('keeps results scoped to the current user when an older identity query resolves late', async () => {
    let resolveOld!: (value: unknown) => void;
    const old = chatContext(
      'old-user',
      1,
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    const current = chatContext('current-user', 1, () => ({
      items: [conversation('current-conversation')],
      nextCursor: null,
    }));
    const { wrapper } = queryHarness();
    const { result, rerender } = renderHook(({ context }) => useHistory({ context }), {
      initialProps: { context: old.context },
      wrapper,
    });
    await waitFor(() => expect(old.get).toHaveBeenCalledTimes(1));
    rerender({ context: current.context });
    await waitFor(() =>
      expect(result.current.conversations.map((item) => item.id)).toEqual(['current-conversation']),
    );

    act(() => resolveOld({ items: [conversation('old-conversation')], nextCursor: null }));
    await waitFor(() =>
      expect(result.current.conversations.map((item) => item.id)).toEqual(['current-conversation']),
    );
  });
});

describe('React chat model selection hook', () => {
  it('persists authorized selection per account and preserves an unavailable conversation model', async () => {
    const storage = new MemoryStorage();
    const first = chatContext('model-user', 1, () => models);
    const other = chatContext('different-user', 1, () => models);
    const { wrapper } = queryHarness();
    const { result, unmount } = renderHook(
      ({ context, conversationId, conversationSelection }) =>
        useModelSelection({
          context,
          conversationId,
          ...(conversationSelection === undefined ? {} : { conversationSelection }),
          storage,
        }),
      {
        initialProps: {
          context: first.context,
          conversationId: null as string | null,
          conversationSelection: undefined as
            { groupId: string | null; modelId: string | null } | undefined,
        },
        wrapper,
      },
    );
    await waitFor(() => expect(result.current.selectedModel?.publicModelId).toBe('model-1'));
    act(() => result.current.selectOption(modelOptionKey('group-1', 'model-2')));
    expect(result.current.selection).toEqual({ groupId: 'group-1', modelId: 'model-2' });
    unmount();

    const restored = renderHook(
      () =>
        useModelSelection({
          context: first.context,
          conversationId: null,
          storage,
        }),
      { wrapper },
    );
    await waitFor(() =>
      expect(restored.result.current.selectedModel?.publicModelId).toBe('model-2'),
    );
    restored.unmount();

    const accountSwitch = renderHook(
      () =>
        useModelSelection({
          context: other.context,
          conversationId: null,
          storage,
        }),
      { wrapper },
    );
    await waitFor(() =>
      expect(accountSwitch.result.current.selectedModel?.publicModelId).toBe('model-1'),
    );
    accountSwitch.unmount();

    const unavailable = renderHook(
      ({ context, conversationId, conversationSelection }) =>
        useModelSelection({
          context,
          conversationId,
          conversationSelection,
          storage,
        }),
      {
        initialProps: {
          context: other.context,
          conversationId: 'conversation-with-old-model',
          conversationSelection: { groupId: 'removed-group', modelId: 'removed-model' },
        },
        wrapper,
      },
    );
    await waitFor(() =>
      expect(unavailable.result.current.selection).toEqual({
        groupId: 'removed-group',
        modelId: 'removed-model',
      }),
    );
    expect(unavailable.result.current.available).toBe(false);
    expect(unavailable.result.current.unavailableReason).toBeTruthy();
  });

  it('does not let a stale catalog response replace the new owner selection', async () => {
    let resolveOld!: (value: unknown) => void;
    const old = chatContext(
      'old-catalog-user',
      3,
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    const current = chatContext('new-catalog-user', 4, () => ({
      items: [
        {
          id: 'new-group',
          name: 'new',
          billingMultiplier: '1',
          models: [{ publicModelId: 'new-model' }],
        },
      ],
    }));
    const { wrapper } = queryHarness();
    const storage = new MemoryStorage();
    const { result, rerender } = renderHook(
      ({ context }) => useModelSelection({ context, conversationId: null, storage }),
      { initialProps: { context: old.context }, wrapper },
    );
    await waitFor(() => expect(old.get).toHaveBeenCalledTimes(1));
    rerender({ context: current.context });
    await waitFor(() => expect(result.current.selectedModel?.publicModelId).toBe('new-model'));

    act(() =>
      resolveOld({
        items: [
          {
            id: 'old-group',
            name: 'old',
            billingMultiplier: '1',
            models: [{ publicModelId: 'old-model' }],
          },
        ],
      }),
    );
    await waitFor(() => expect(result.current.selectedModel?.publicModelId).toBe('new-model'));
  });
});
