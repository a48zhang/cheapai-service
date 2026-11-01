import { useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import type { InfiniteData } from '@tanstack/react-query';
import { createImagesApi } from '@cheapai/api-client/images';
import { ApiClientError } from '@cheapai/api-client/errors';
import { imageGenerateInputSchema } from '@cheapai/contracts/images';
import type { ImageGenerateInput, ImageJob } from '@cheapai/contracts/images';
import type { ApiClient } from '@cheapai/api-client/types';
import { invalidatePersonalBilling } from '../billing/public';

function readPending(key: string): ImageGenerateInput | null {
  try {
    const value = imageGenerateInputSchema.safeParse(
      JSON.parse(localStorage.getItem(key) ?? 'null'),
    );
    return value.success ? value.data : null;
  } catch {
    return null;
  }
}
export function useImageWorkspace(client: ApiClient, userId: string, epoch: number) {
  const api = useMemo(() => createImagesApi(client), [client]);
  const queryClient = useQueryClient();
  const historyKey = useMemo(() => ['images', userId, epoch, 'history'] as const, [userId, epoch]);
  const storageKey = `cheapai:image-pending:${userId}`;
  const [pending, setPending] = useState<ImageGenerateInput | null>(() => readPending(storageKey));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [rejected, setRejected] = useState<ImageGenerateInput | null>(null);
  const lock = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const models = useQuery({
    queryKey: ['images', userId, epoch, 'models'],
    queryFn: () => api.models(),
    retry: false,
  });
  const history = useInfiniteQuery({
    queryKey: historyKey,
    queryFn: ({ pageParam }) => api.history(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: false,
    refetchInterval: (query) =>
      pending ||
      query.state.data?.pages.some((page) =>
        page.items.some((item) => item.status === 'generating' || item.billingStatus === 'pending'),
      )
        ? 2500
        : false,
  });
  const jobs = useMemo(
    () => [
      ...new Map(
        (history.data?.pages.flatMap((page) => page.items) ?? []).map((job) => [job.id, job]),
      ).values(),
    ],
    [history.data],
  );
  const confirmed = pending
    ? jobs.find((job) => job.operationId === pending.operationId && job.status !== 'generating')
    : undefined;
  const persist = (input: ImageGenerateInput | null) => {
    setPending(input);
    try {
      if (input) localStorage.setItem(storageKey, JSON.stringify(input));
      else localStorage.removeItem(storageKey);
    } catch {
      /* Editing and generation still work when persistence is unavailable. */
    }
  };
  useEffect(() => {
    if (!confirmed) return;
    setPending(null);
    setError(null);
    setRejected(null);
    try {
      localStorage.removeItem(storageKey);
    } catch {
      /* Advisory persistence. */
    }
    void invalidatePersonalBilling(queryClient, userId);
  }, [confirmed, storageKey, queryClient, userId]);
  const putResult = (job: ImageJob) =>
    queryClient.setQueryData<InfiniteData<Awaited<ReturnType<typeof api.history>>, string | null>>(
      historyKey,
      (previous) => {
        if (!previous) return { pages: [{ items: [job], nextCursor: null }], pageParams: [null] };
        return {
          ...previous,
          pages: previous.pages.map((page, index) => ({
            ...page,
            items:
              index === 0
                ? [job, ...page.items.filter((item) => item.id !== job.id)]
                : page.items.filter((item) => item.id !== job.id),
          })),
        };
      },
    );
  const execute = async (input: ImageGenerateInput) => {
    if (lock.current) return;
    lock.current = true;
    persist(input);
    setSending(true);
    setError(null);
    setRejected(null);
    try {
      const job = await api.generate(input);
      await queryClient.cancelQueries({ queryKey: historyKey });
      putResult(job);
      if (!alive.current) return;
      if (job.status !== 'generating') persist(null);
      void invalidatePersonalBilling(queryClient, userId);
    } catch (cause) {
      if (alive.current) {
        setError(cause);
        if (
          cause instanceof ApiClientError &&
          cause.kind === 'api' &&
          [400, 402, 403, 404, 409, 413, 429].includes(cause.status ?? 0)
        ) {
          setRejected(input);
          persist(null);
        }
      }
    } finally {
      lock.current = false;
      if (alive.current) setSending(false);
    }
  };
  return {
    models,
    history,
    jobs,
    pending,
    sending,
    error,
    rejected,
    start: (input: Omit<ImageGenerateInput, 'operationId'>) => {
      if (lock.current || pending) return false;
      void execute({ ...input, operationId: crypto.randomUUID() });
      return true;
    },
    confirm: () => {
      if (pending) void execute(pending);
    },
    refresh: () => void history.refetch(),
  };
}
