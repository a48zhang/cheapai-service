import { useEffect, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { createAdminRegistrationApi } from '@cheapai/api-client/registration-admin';
import { useSession } from '../../features/session/useSession';
import { registrationCodesQuery, registrationKeys } from '../../features/admin-registration/api';
import { CodeBatchDialog } from '../../features/admin-registration/CodeBatchDialog';
import { CodeTable } from '../../features/admin-registration/CodeTable';
import { Button } from '../../shared/ui/Button';
import { Input } from '../../shared/ui/Input';
import { PageHeader } from '../../shared/patterns/PageHeader';
import { FilterBar } from '../../shared/patterns/FilterBar';
import { ApiErrorNotice } from '../../shared/patterns/ApiErrorNotice';
import { mergePageItems } from '../../shared/lib/pagination';

export default function RegistrationCodesPage() {
  const { client, user, queryClient } = useSession();
  const [params, setParams] = useSearchParams();
  const creatorFilter = params.get('creatorFilter') || undefined;
  const [creator, setCreator] = useState(creatorFilter ?? '');
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const query = useInfiniteQuery(registrationCodesQuery(client, user!.id, creatorFilter));
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: registrationKeys.root(user!.id) });
  };
  const rows = mergePageItems(query.data?.pages);
  useEffect(() => {
    setCreator(creatorFilter ?? '');
  }, [creatorFilter]);
  return (
    <>
      <PageHeader
        heading="邀请码"
        description="管理注册资格；账户余额由授额操作单独控制。"
        actions={<Button onClick={() => setOpen(true)}>生成邀请码</Button>}
      />
      <FilterBar
        onReset={() => {
          setCreator('');
          setParams({});
        }}
      >
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setParams(creator ? { creatorFilter: creator } : {});
          }}
        >
          <Input
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
    </>
  );
}
