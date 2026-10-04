import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ApiClient } from '@cheapai/api-client/types';
import type { RequestFilters } from './filters';
import type { UseRequestPagesOptions } from './useRequestPages';
import { useRequestPages } from './useRequestPages';

interface TestRequest {
  readonly id: string;
  readonly updated_at: number;
}

interface TestPage {
  readonly items: readonly TestRequest[];
  readonly nextCursor: string | null;
}

const mocks = vi.hoisted(() => ({ read: vi.fn() }));

vi.mock('./api', () => ({
  requestListQueryOptions: (
    context: { readonly userId: string; readonly scope: string; readonly epoch: number },
    filters: Readonly<Record<string, unknown>>,
  ) => ({
    queryKey: ['request-pages-test', context.scope, context.userId, context.epoch, filters],
    queryFn: async () => mocks.read(context.userId, filters),
  }),
}));

const clients: QueryClient[] = [];

function queryHarness() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  });
  clients.push(client);
  function wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return { client, wrapper };
}

const makeOptions = (
  userId: string,
  epoch: number,
  filters: RequestFilters = {},
  cursor: string | null = null,
): UseRequestPagesOptions => ({
  context: { client: {} as ApiClient, userId, scope: 'personal' },
  epoch,
  filters,
  cursor,
});

const row = (id: string, updated_at = 1): TestRequest => ({ id, updated_at });
const page = (items: readonly TestRequest[], nextCursor: string | null): TestPage => ({
  items,
  nextCursor,
});

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  mocks.read.mockReset();
});

describe('useRequestPages', () => {
  it('does not repeatedly update state after a page loads', async () => {
    mocks.read.mockResolvedValue(page([row('request-a')], null));
    const { wrapper } = queryHarness();
    let renderCount = 0;
    const { result } = renderHook(
      ({ options }) => {
        renderCount += 1;
        return useRequestPages(options);
      },
      { initialProps: { options: makeOptions('user-a', 1) }, wrapper },
    );

    await waitFor(() => expect(result.current.rows.map((item) => item.id)).toEqual(['request-a']));
    expect(renderCount).toBeLessThan(12);
    expect(mocks.read).toHaveBeenCalledTimes(1);
  });

  it('accumulates URL cursor pages, keeps the newest duplicate and truncates on back navigation', async () => {
    mocks.read.mockImplementation((_userId: string, filters: Readonly<Record<string, unknown>>) => {
      switch (filters.cursor) {
        case null:
          return page([row('request-a', 1), row('request-b', 1)], 'cursor-a');
        case 'cursor-a':
          return page([row('request-a', 2), row('request-c', 1)], 'cursor-b');
        case 'cursor-b':
          return page([row('request-c', 3), row('request-d', 1)], null);
        default:
          throw new Error('Unexpected cursor.');
      }
    });
    const { wrapper } = queryHarness();
    const { result, rerender } = renderHook(({ options }) => useRequestPages(options), {
      initialProps: { options: makeOptions('user-a', 1) },
      wrapper,
    });

    await waitFor(() =>
      expect(result.current.rows.map((item) => item.id)).toEqual(['request-a', 'request-b']),
    );
    rerender({ options: makeOptions('user-a', 1, {}, 'cursor-a') });
    await waitFor(() =>
      expect(result.current.rows.map((item) => item.id)).toEqual([
        'request-a',
        'request-b',
        'request-c',
      ]),
    );
    expect(result.current.rows.find((item) => item.id === 'request-a')?.updated_at).toBe(2);

    rerender({ options: makeOptions('user-a', 1, {}, 'cursor-b') });
    await waitFor(() =>
      expect(result.current.rows.map((item) => item.id)).toEqual([
        'request-a',
        'request-b',
        'request-c',
        'request-d',
      ]),
    );
    expect(result.current.rows.find((item) => item.id === 'request-c')?.updated_at).toBe(3);

    rerender({ options: makeOptions('user-a', 1, {}, 'cursor-a') });
    await waitFor(() =>
      expect(result.current.rows.map((item) => item.id)).toEqual([
        'request-a',
        'request-b',
        'request-c',
      ]),
    );
    expect(result.current.rows.find((item) => item.id === 'request-a')?.updated_at).toBe(2);
    expect(result.current.nextCursor).toBe('cursor-b');
    expect(mocks.read).toHaveBeenCalledTimes(3);
  });

  it('hides loaded rows as filters, user, or session epoch changes', async () => {
    const pending: Array<(value: TestPage) => void> = [];
    mocks.read.mockImplementation((userId: string, filters: Readonly<Record<string, unknown>>) => {
      if (userId === 'user-a' && filters.status === undefined) return page([row('initial')], null);
      return new Promise<TestPage>((resolve) => {
        pending.push(resolve);
      });
    });
    const { wrapper } = queryHarness();
    const { result, rerender } = renderHook(({ options }) => useRequestPages(options), {
      initialProps: { options: makeOptions('user-a', 1) },
      wrapper,
    });

    await waitFor(() => expect(result.current.rows.map((item) => item.id)).toEqual(['initial']));
    rerender({ options: makeOptions('user-a', 1, { status: 'failed' }) });
    expect(result.current.rows).toEqual([]);
    await waitFor(() => expect(pending).toHaveLength(1));
    await act(async () => {
      pending.shift()?.(page([row('filtered')], null));
    });
    await waitFor(() => expect(result.current.rows.map((item) => item.id)).toEqual(['filtered']));

    rerender({ options: makeOptions('user-b', 1, { status: 'failed' }) });
    expect(result.current.rows).toEqual([]);
    await waitFor(() => expect(pending).toHaveLength(1));
    await act(async () => {
      pending.shift()?.(page([row('other-user')], null));
    });
    await waitFor(() => expect(result.current.rows.map((item) => item.id)).toEqual(['other-user']));

    rerender({ options: makeOptions('user-b', 2, { status: 'failed' }) });
    expect(result.current.rows).toEqual([]);
    await waitFor(() => expect(pending).toHaveLength(1));
    await act(async () => {
      pending.shift()?.(page([row('new-epoch')], null));
    });
    await waitFor(() => expect(result.current.rows.map((item) => item.id)).toEqual(['new-epoch']));
  });

  it('keeps earlier rows after a next-page failure and retries that cursor', async () => {
    let nextPageReads = 0;
    mocks.read.mockImplementation((_userId: string, filters: Readonly<Record<string, unknown>>) => {
      if (filters.cursor === null) return page([row('kept')], 'cursor-next');
      nextPageReads += 1;
      if (nextPageReads === 1) throw new Error('temporary read failure');
      return page([row('retried')], null);
    });
    const { wrapper } = queryHarness();
    const { result, rerender } = renderHook(({ options }) => useRequestPages(options), {
      initialProps: { options: makeOptions('user-a', 1) },
      wrapper,
    });

    await waitFor(() => expect(result.current.rows.map((item) => item.id)).toEqual(['kept']));
    rerender({ options: makeOptions('user-a', 1, {}, 'cursor-next') });
    await waitFor(() => expect(result.current.query.isError).toBe(true));
    expect(result.current.rows.map((item) => item.id)).toEqual(['kept']);
    expect(result.current.nextCursor).toBe('cursor-next');

    await act(async () => {
      await result.current.query.refetch();
    });
    await waitFor(() =>
      expect(result.current.rows.map((item) => item.id)).toEqual(['kept', 'retried']),
    );
    expect(mocks.read.mock.calls.map(([, filters]) => filters.cursor)).toEqual([
      null,
      'cursor-next',
      'cursor-next',
    ]);
  });

  it('stops self-loops and A-B-A cursor cycles', async () => {
    const scenarios = [
      {
        userId: 'self-loop',
        sequence: [null, 'A'] as const,
        pages: new Map<string | null, TestPage>([
          [null, page([row('one')], 'A')],
          ['A', page([row('two')], 'A')],
        ]),
      },
      {
        userId: 'cycle',
        sequence: [null, 'A', 'B'] as const,
        pages: new Map<string | null, TestPage>([
          [null, page([row('one')], 'A')],
          ['A', page([row('two')], 'B')],
          ['B', page([row('three')], 'A')],
        ]),
      },
    ];

    for (const scenario of scenarios) {
      mocks.read
        .mockReset()
        .mockImplementation((_userId: string, filters: Readonly<Record<string, unknown>>) => {
          const response = scenario.pages.get(filters.cursor as string | null);
          if (!response) throw new Error('Unexpected cursor.');
          return response;
        });
      const { wrapper } = queryHarness();
      const { result, rerender, unmount } = renderHook(({ options }) => useRequestPages(options), {
        initialProps: { options: makeOptions(scenario.userId, 1) },
        wrapper,
      });

      await waitFor(() => expect(result.current.rows).toHaveLength(1));
      for (const cursor of scenario.sequence.slice(1)) {
        rerender({ options: makeOptions(scenario.userId, 1, {}, cursor) });
        await waitFor(() =>
          expect(result.current.rows).toHaveLength(
            (scenario.sequence as readonly (string | null)[]).indexOf(cursor) + 1,
          ),
        );
      }
      expect(result.current.nextCursor).toBeUndefined();
      expect(result.current.error).toBeInstanceOf(Error);
      expect(mocks.read).toHaveBeenCalledTimes(scenario.sequence.length);
      unmount();
    }
  });
});
