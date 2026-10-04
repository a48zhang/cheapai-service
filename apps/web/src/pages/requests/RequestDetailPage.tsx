import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { requestDetailQueryOptions } from '../../features/request-history/api';
import { PriceSnapshot } from '../../features/request-history/PriceSnapshot';
import { RequestStatus } from '../../features/request-history/RequestStatus';
import { UsageBreakdown } from '../../features/request-history/UsageBreakdown';
import { useSession } from '../../features/session/useSession';
import { safeReturnPath } from '../../shared/lib/return-path';
import { formatDateTime } from '../../shared/lib/datetime';
import { ApiErrorNotice } from '../../shared/patterns/ApiErrorNotice';
import { PageHeader } from '../../shared/patterns/PageHeader';

export function RequestDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { client, user, state: session } = useSession();
  const scope = location.pathname.startsWith('/admin/') ? 'admin' : 'personal';
  const listPath = scope === 'admin' ? '/admin/requests' : '/requests';
  const requestedReturn = safeReturnPath(searchParams.get('returnTo'), listPath);
  const returnTo =
    requestedReturn === listPath || requestedReturn.startsWith(`${listPath}?`)
      ? requestedReturn
      : listPath;
  const context = { client, userId: user?.id ?? 'anonymous', scope } as const;
  const detailQuery = requestDetailQueryOptions(context, id);
  const query = useQuery({
    ...detailQuery,
    enabled: Boolean(id) && session.status === 'authenticated' && user !== null,
  });
  const item = query.data;

  return (
    <section className="space-y-5">
      <PageHeader
        heading="请求详情"
        description={id ? `请求编号 ${id}` : '请求编号无效。'}
        actions={
          <Link
            className="rounded-md border border-[var(--color-border)] bg-white px-3 py-2 text-sm font-medium"
            to={returnTo}
          >
            返回请求列表
          </Link>
        }
      />
      {query.error && <ApiErrorNotice error={query.error} onRetry={() => void query.refetch()} />}
      {query.isPending && (
        <p className="text-sm text-[var(--color-muted-foreground)]" role="status">
          正在读取请求详情…
        </p>
      )}
      {item && (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(18rem,0.8fr)]">
          <div className="space-y-5">
            <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
              <h2 className="mb-4 text-base font-semibold">执行状态</h2>
              <RequestStatus
                executionStatus={item.execution_status}
                billingStatus={item.billing_status}
              />
              <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-xs text-[var(--color-muted-foreground)]">来源</dt>
                  <dd className="m-0 mt-1">
                    {item.source === 'web_chat' ? '网页聊天' : 'API 请求'}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-[var(--color-muted-foreground)]">访问组</dt>
                  <dd className="m-0 mt-1 break-all">{item.group_id ?? '未知'}</dd>
                </div>
                <div>
                  <dt className="text-xs text-[var(--color-muted-foreground)]">上游模型</dt>
                  <dd className="m-0 mt-1 break-all">{item.upstream_model}</dd>
                </div>
                <div>
                  <dt className="text-xs text-[var(--color-muted-foreground)]">重试次数</dt>
                  <dd className="m-0 mt-1 tabular-nums">{item.retry_count}</dd>
                </div>
                {scope === 'admin' && (
                  <>
                    <div>
                      <dt className="text-xs text-[var(--color-muted-foreground)]">用户</dt>
                      <dd className="m-0 mt-1 break-all">{item.user_id}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-[var(--color-muted-foreground)]">API Key ID</dt>
                      <dd className="m-0 mt-1 break-all font-mono text-xs">{item.api_key_id}</dd>
                    </div>
                  </>
                )}
              </dl>
              {item.error && (
                <div
                  className="mt-5 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900"
                  role="alert"
                >
                  <strong>{item.error.code}</strong>
                  <p className="mb-0 mt-1">{item.error.message}</p>
                </div>
              )}
            </section>
            <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
              <h2 className="mb-4 text-base font-semibold">用量</h2>
              <UsageBreakdown usage={item.usage} usageValid={item.usage_valid} />
            </section>
          </div>
          <div className="space-y-5">
            <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
              <h2 className="mb-4 text-base font-semibold">时间</h2>
              <dl className="space-y-3 text-sm">
                <div>
                  <dt className="text-xs text-[var(--color-muted-foreground)]">创建</dt>
                  <dd className="m-0 mt-1">{formatDateTime(item.created_at)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-[var(--color-muted-foreground)]">开始</dt>
                  <dd className="m-0 mt-1">{formatDateTime(item.started_at)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-[var(--color-muted-foreground)]">完成</dt>
                  <dd className="m-0 mt-1">{formatDateTime(item.finished_at)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-[var(--color-muted-foreground)]">最后更新</dt>
                  <dd className="m-0 mt-1">{formatDateTime(item.updated_at)}</dd>
                </div>
                {item.next_retry_at !== null && (
                  <div>
                    <dt className="text-xs text-[var(--color-muted-foreground)]">下次结算重试</dt>
                    <dd className="m-0 mt-1">{formatDateTime(item.next_retry_at)}</dd>
                  </div>
                )}
              </dl>
            </section>
            <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
              <PriceSnapshot
                snapshot={item.price_snapshot}
                snapshotValid={item.price_snapshot_valid}
                costUnits={item.cost_units}
                billingStatus={item.billing_status}
              />
            </section>
          </div>
        </div>
      )}
    </section>
  );
}
