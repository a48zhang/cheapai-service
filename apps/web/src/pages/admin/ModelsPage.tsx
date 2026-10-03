import { useInfiniteQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import type { ModelStatus } from '@cheapai/api-client/models';
import { useSession } from '../../features/session/useSession';
import { modelListQueryOptions } from '../../features/admin-models/api';
import { ModelTable } from '../../features/admin-models/ModelTable';
import { FilterBar } from '../../shared/patterns/FilterBar';
import { PageHeader } from '../../shared/patterns/PageHeader';
import { Select } from '../../shared/ui/Select';
import { Button } from '../../shared/ui/Button';

const statusItems = [
  { value: 'all', label: '全部状态' },
  { value: 'active', label: '已启用' },
  { value: 'disabled', label: '已停用' },
] as const;

function filterStatus(value: string | null): ModelStatus | undefined {
  return value === 'active' || value === 'disabled' ? value : undefined;
}

export default function ModelsPage() {
  const { client, user } = useSession();
  const [searchParams, setSearchParams] = useSearchParams();
  const status = filterStatus(searchParams.get('status'));
  const query = useInfiniteQuery(modelListQueryOptions({
    client,
    actorId: user?.id ?? 'unknown-admin',
  }, status === undefined ? {} : { status }));
  const rows = query.data?.pages.flatMap(page => page.items) ?? [];
  const error = query.isError ? (query.error instanceof Error ? query.error.message : '模型列表读取失败。') : null;

  function changeStatus(value: string) {
    const next = new URLSearchParams(searchParams);
    next.delete('cursor');
    if (value === 'active' || value === 'disabled') next.set('status', value);
    else next.delete('status');
    setSearchParams(next, { replace: true });
  }

  return <section>
    <PageHeader
      eyebrow="资源配置"
      heading="模型与价格"
      description="管理公开模型目录、精确价格和渠道映射。目录启用状态与渠道可用性分别配置。"
      actions={<Button asChild><Link to="/admin/models/actions/create">新增模型</Link></Button>}
    />
    <FilterBar>
      <label className="grid min-w-44 gap-1.5 text-sm font-medium text-[var(--foreground)]">
        模型状态
        <Select
          aria-label="模型状态"
          value={status ?? 'all'}
          items={statusItems}
          onValueChange={changeStatus}
        />
      </label>
    </FilterBar>
    <ModelTable
      rows={rows}
      loading={query.isPending && query.data === undefined}
      loadingMore={query.isFetchingNextPage}
      hasMore={query.hasNextPage}
      error={error}
      onRetry={() => { void query.refetch(); }}
      onLoadMore={() => { void query.fetchNextPage(); }}
    />
  </section>;
}
