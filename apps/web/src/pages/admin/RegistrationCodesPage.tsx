import { useEffect, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import type { CodeStatus } from '@cheapai/contracts/registration-admin';
import { createAdminRegistrationApi } from '@cheapai/api-client/registration-admin';
import { useSession } from '../../features/session/useSession';
import { registrationCodesQuery, registrationKeys } from '../../features/admin-registration/api';
import { CodeBatchDialog } from '../../features/admin-registration/CodeBatchDialog';
import { CodeTable } from '../../features/admin-registration/CodeTable';
import { Button } from '../../shared/ui/Button';
import { Select } from '../../shared/ui/Select';
import { Input } from '../../shared/ui/Input';
import { PageHeader } from '../../shared/patterns/PageHeader';
import { FilterBar } from '../../shared/patterns/FilterBar';
import { ApiErrorNotice } from '../../shared/patterns/ApiErrorNotice';
import { mergePageItems } from '../../shared/lib/pagination';

export default function RegistrationCodesPage() {
  const { client, user, queryClient } = useSession();
  const [params, setParams] = useSearchParams();
  const creatorFilter = params.get('creatorFilter') || undefined;
  const statusParam = params.get('status');
  const status = ['unused', 'used', 'expired', 'revoked'].includes(statusParam ?? '')
    ? (statusParam as CodeStatus)
    : undefined;
  const [selectedStatus, setSelectedStatus] = useState(status ?? 'all');
  const [creator, setCreator] = useState(creatorFilter ?? '');
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const query = useInfiniteQuery(registrationCodesQuery(client, user!.id, creatorFilter, status));
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: registrationKeys.root(user!.id) });
  };
  const rows = mergePageItems(query.data?.pages);
  useEffect(() => {
    setCreator(creatorFilter ?? '');
    setSelectedStatus(status ?? 'all');
  }, [creatorFilter, status]);
  return (
    <section className="space-y-5">
      <PageHeader
        heading="邀请码"
        actions={<Button onClick={() => setOpen(true)}>生成邀请码</Button>}
      />
      <FilterBar
        onReset={() => {
          setCreator('');
          setSelectedStatus('all');
          setParams({});
        }}
      >
        <form
          className="flex w-full flex-wrap items-center gap-3 sm:w-auto"
          onSubmit={(event) => {
            event.preventDefault();
            const filters: Record<string, string> = {};
            if (creator.trim()) filters.creatorFilter = creator.trim();
            if (selectedStatus !== 'all') filters.status = selectedStatus;
            setParams(filters);
          }}
        >
          <Select
            aria-label="邀请码状态"
            className="w-full sm:w-36"
            value={selectedStatus}
            onValueChange={setSelectedStatus}
            items={[
              { value: 'all', label: '全部状态' },
              { value: 'unused', label: '未使用' },
              { value: 'used', label: '已使用' },
              { value: 'expired', label: '已过期' },
              { value: 'revoked', label: '已撤销' },
            ]}
          />
          <Input
            className="w-full sm:w-64"
            aria-label="创建者 ID"
            placeholder="创建者 ID"
            value={creator}
            onChange={(event) => setCreator(event.target.value)}
          />
          <Button type="submit" variant="secondary">
            筛选
          </Button>
        </form>
      </FilterBar>
      {(error || query.error) && (
        <ApiErrorNotice
          error={error ?? query.error}
          onRetry={() =>
            void (query.isFetchNextPageError ? query.fetchNextPage() : query.refetch())
          }
        />
      )}
      {query.isPending ? (
        <p role="status">正在读取邀请码…</p>
      ) : (
        <CodeTable
          rows={rows}
          filtered={!!creatorFilter || !!status}
          onCreate={() => setOpen(true)}
          hasMore={query.hasNextPage}
          loadingMore={query.isFetchingNextPage}
          onLoadMore={() => void query.fetchNextPage()}
          onRevoke={(id) => {
            setError(null);
            void createAdminRegistrationApi(client).revokeCode(id).then(refresh).catch(setError);
          }}
        />
      )}
      <CodeBatchDialog key={user!.id} open={open} onOpenChange={setOpen} onCreated={refresh} />
    </section>
  );
}
