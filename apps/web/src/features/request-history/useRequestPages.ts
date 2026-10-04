import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { RequestPage } from '@cheapai/contracts/requests';
import type { RequestFilters } from './filters';
import { requestListQueryOptions } from './api';
import type { RequestHistoryContext } from './api';
import { mergePageItems, nextPageCursor } from '../../shared/lib/pagination';

interface LoadedRequestPage {
  readonly cursor: string | null;
  readonly page: RequestPage;
}

interface LoadedRequestPages {
  readonly scopeKey: string;
  readonly pages: readonly LoadedRequestPage[];
}

const EMPTY_PAGES: readonly LoadedRequestPage[] = [];

export interface UseRequestPagesOptions {
  readonly context: RequestHistoryContext;
  readonly epoch: number;
  readonly filters: RequestFilters;
  readonly cursor: string | null;
  readonly enabled?: boolean;
}

function includePage(
  currentPages: readonly LoadedRequestPage[],
  cursor: string | null,
  page: RequestPage,
): readonly LoadedRequestPage[] {
  const pageIndex = currentPages.findIndex((item) => item.cursor === cursor);
  if (pageIndex >= 0) return [...currentPages.slice(0, pageIndex), { cursor, page }];

  const previous = currentPages.at(-1);
  if (previous && previous.page.nextCursor === cursor) return [...currentPages, { cursor, page }];

  // A cursor loaded directly from the URL starts a new visible chain.
  return [{ cursor, page }];
}

/** Keeps cursor pages for the current identity and filter set while the URL selects each page. */
export function useRequestPages({
  context,
  epoch,
  filters,
  cursor,
  enabled = true,
}: UseRequestPagesOptions) {
  const queryOptions = requestListQueryOptions({ ...context, epoch }, { ...filters, cursor });
  const query = useQuery({
    ...queryOptions,
    enabled,
  });
  const scopeKey = JSON.stringify({ userId: context.userId, scope: context.scope, epoch, filters });
  const [loaded, setLoaded] = useState<LoadedRequestPages | null>(null);
  const storedPages = loaded?.scopeKey === scopeKey ? loaded.pages : EMPTY_PAGES;
  const pages = useMemo(
    () => (query.data ? includePage(storedPages, cursor, query.data) : storedPages),
    [query.data, storedPages, cursor],
  );

  useEffect(() => {
    if (!query.data) return;
    const page = query.data;
    setLoaded((current) => {
      const currentPages = current?.scopeKey === scopeKey ? current.pages : EMPTY_PAGES;
      const last = currentPages.at(-1);
      if (current && last?.cursor === cursor && last.page === page) return current;
      return { scopeKey, pages: includePage(currentPages, cursor, page) };
    });
  }, [query.data, scopeKey, cursor]);

  const rows = useMemo(() => mergePageItems(pages.map((item) => item.page)), [pages]);
  const currentPage = pages.at(-1)?.page;
  let nextCursor: string | undefined;
  let paginationError: Error | undefined;
  if (currentPage) {
    nextCursor = nextPageCursor(
      currentPage,
      pages.map((item) => item.page),
      '请求',
      (error) => {
        paginationError = error;
      },
    );
  }

  return {
    query,
    rows,
    currentPage,
    nextCursor,
    error: query.error ?? paginationError,
  };
}
