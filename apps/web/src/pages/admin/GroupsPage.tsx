import { useInfiniteQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import type { GroupStatus } from '@cheapai/api-client/groups';
import { useSession } from '../../features/session/useSession';
import { groupListQueryOptions } from '../../features/admin-groups/api';
import { GroupTable } from '../../features/admin-groups/GroupTable';
import { FilterBar } from '../../shared/patterns/FilterBar';
import { PageHeader } from '../../shared/patterns/PageHeader';
import { Select } from '../../shared/ui/Select';
import { Button } from '../../shared/ui/Button';
import { mergePageItems } from '../../shared/lib/pagination';

const statusItems = [
  { value: 'all', label: '全部状态' },
  { value: 'active', label: '启用' },
  { value: 'disabled', label: '停用' },
] as const;

function statusFromUrl(value: string | null): GroupStatus | undefined {
  return value === 'active' || value === 'disabled' ? value : undefined;
}

/** Filterable cursor list with deep links to each access-group configuration. */
export function GroupsPage() {
  const { client, user } = useSession();
  const [searchParams, setSearchParams] = useSearchParams();
  const actorId = user?.id ?? 'unknown-admin';
  const status = statusFromUrl(searchParams.get('status'));
  const query = useInfiniteQuery(
    groupListQueryOptions({ client, actorId }, status === undefined ? {} : { status }),
  );
  const rows = mergePageItems(
    query.data?.pages,
    (candidate, current) => candidate.version - current.version,
  );
  const error = query.isError
    ? query.error instanceof Error
      ? query.error.message
      : '访问组读取失败。'
    : null;

  function updateStatus(value: string) {
    const next = new URLSearchParams(searchParams);
    if (value === 'active' || value === 'disabled') next.set('status', value);
    else next.delete('status');
    next.delete('cursor');
    setSearchParams(next, { replace: true });
  }

  return (
    <section className="space-y-4">
      <PageHeader
        heading="访问组"
        actions={
          <Button asChild>
            <Link to="/admin/groups/new">创建访问组</Link>
          </Button>
        }
      />
      <FilterBar onReset={() => updateStatus('all')}>
        <label className="grid min-w-44 gap-1.5 text-sm font-medium text-[var(--color-foreground)]">
          状态
          <Select
            aria-label="组状态"
            value={status ?? 'all'}
            items={statusItems}
            onValueChange={updateStatus}
          />
        </label>
      </FilterBar>
      <GroupTable
        emptyMessage={
          status
            ? '没有符合当前状态的访问组，可重置筛选查看全部。'
            : '暂无访问组，创建访问组后将在这里显示。'
        }
        rows={rows}
        loading={query.isPending && query.data === undefined}
        loadingMore={query.isFetchingNextPage}
        hasMore={query.hasNextPage}
        error={error}
        onRetry={() => {
          void (query.isFetchNextPageError ? query.fetchNextPage() : query.refetch());
        }}
        onLoadMore={() => {
          void query.fetchNextPage();
        }}
      />
    </section>
  );
}

export default GroupsPage;
