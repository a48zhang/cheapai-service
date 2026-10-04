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
  { value: 'active', label: '已启用' },
  { value: 'disabled', label: '已停用' },
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
    <section>
      <PageHeader
        eyebrow="资源配置"
        heading="访问组"
        description="管理服务端访问组、精确计费倍率和已保存的渠道关联。组成员和最终请求授权仍以服务端规则为准。"
        actions={
          <Button asChild>
            <Link to="/admin/groups/new">创建访问组</Link>
          </Button>
        }
      />
      <FilterBar>
        <label className="grid min-w-44 gap-1.5 text-sm font-medium text-[var(--color-foreground)]">
          组状态
          <Select
            aria-label="组状态"
            value={status ?? 'all'}
            items={statusItems}
            onValueChange={updateStatus}
          />
        </label>
      </FilterBar>
      <GroupTable
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
