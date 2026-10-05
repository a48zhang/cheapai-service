import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { requestDetailQueryOptions } from '../../features/request-history/api';
import { PriceSnapshot } from '../../features/request-history/PriceSnapshot';
import { RequestStatus } from '../../features/request-history/RequestStatus';
import { UsageBreakdown } from '../../features/request-history/UsageBreakdown';
import {
  requestCostLabel,
  requestResultPresentation,
  requestSourceLabel,
} from '../../features/request-history/presentation';
import { useSession } from '../../features/session/useSession';
import { formatDateTime } from '../../shared/lib/datetime';
import { safeReturnPath } from '../../shared/lib/return-path';
import { ApiErrorNotice } from '../../shared/patterns/ApiErrorNotice';
import { PageHeader } from '../../shared/patterns/PageHeader';
import { StatusBadge } from '../../shared/ui/StatusBadge';

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
  const result = item ? requestResultPresentation(item.execution_status) : null;

  return (
    <section className="space-y-5">
      <PageHeader
        heading={scope === 'admin' ? '请求详情' : '使用记录详情'}
        description={id ? `请求编号 ${id}` : '请求编号无效。'}
        actions={
          <Link
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm font-medium"
            to={returnTo}
          >
            {scope === 'admin' ? '返回请求列表' : '返回使用记录'}
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
        <div className="space-y-4">
          <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
            <h2 className="sr-only">使用记录摘要</h2>
            <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
              <div className="min-w-0">
                <dt className="text-xs text-[var(--color-muted-foreground)]">时间</dt>
                <dd className="m-0 mt-1 text-sm text-[var(--color-ink)]">
                  {formatDateTime(item.created_at)}
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-xs text-[var(--color-muted-foreground)]">模型</dt>
                <dd className="m-0 mt-1 break-all text-sm font-medium text-[var(--color-ink)]">
                  {item.public_model_id}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-[var(--color-muted-foreground)]">来源</dt>
                <dd className="m-0 mt-1 text-sm text-[var(--color-ink)]">
                  {requestSourceLabel(item.source)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-[var(--color-muted-foreground)]">结果</dt>
                <dd className="m-0 mt-1">
                  {result && <StatusBadge tone={result.tone}>{result.label}</StatusBadge>}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-[var(--color-muted-foreground)]">费用</dt>
                <dd className="m-0 mt-1 break-words font-mono text-sm tabular-nums text-[var(--color-ink)]">
                  {requestCostLabel(item)}
                </dd>
              </div>
            </dl>
            {item.error && (
              <div
                className="mt-5 rounded-lg border border-[var(--color-danger-line)] bg-[var(--color-danger-soft)] p-4 text-sm text-[var(--color-danger)]"
                role="alert"
              >
                <strong>{item.error.code}</strong>
                <p className="mb-0 mt-1">{item.error.message}</p>
              </div>
            )}
          </section>

          <details
            className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5"
            open={scope === 'admin'}
          >
            <summary className="cursor-pointer text-sm font-semibold text-[var(--color-ink)]">
              技术详情
            </summary>
            <div className="mt-4 space-y-4">
              <RequestStatus
                executionStatus={item.execution_status}
                billingStatus={item.billing_status}
              />
              <dl className="grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
                <div>
                  <dt className="text-xs text-[var(--color-muted-foreground)]">请求 ID</dt>
                  <dd className="m-0 mt-1 break-all font-mono text-xs">{item.id}</dd>
                </div>
                <div>
                  <dt className="text-xs text-[var(--color-muted-foreground)]">访问组</dt>
                  <dd className="m-0 mt-1 break-all">{item.group_id ?? '未知'}</dd>
                </div>
                <div>
                  <dt className="text-xs text-[var(--color-muted-foreground)]">请求协议</dt>
                  <dd className="m-0 mt-1">{item.downstream_protocol}</dd>
                </div>
                <div>
                  <dt className="text-xs text-[var(--color-muted-foreground)]">上游协议</dt>
                  <dd className="m-0 mt-1">{item.upstream_protocol}</dd>
                </div>
                <div>
                  <dt className="text-xs text-[var(--color-muted-foreground)]">上游模型</dt>
                  <dd className="m-0 mt-1 break-all">{item.upstream_model}</dd>
                </div>
                <div>
                  <dt className="text-xs text-[var(--color-muted-foreground)]">渠道 ID</dt>
                  <dd className="m-0 mt-1 break-all font-mono text-xs">{item.channel_id}</dd>
                </div>
                <div>
                  <dt className="text-xs text-[var(--color-muted-foreground)]">重试次数</dt>
                  <dd className="m-0 mt-1 tabular-nums">{item.retry_count}</dd>
                </div>
                {scope === 'admin' && (
                  <>
                    <div>
                      <dt className="text-xs text-[var(--color-muted-foreground)]">用户 ID</dt>
                      <dd className="m-0 mt-1 break-all font-mono text-xs">{item.user_id}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-[var(--color-muted-foreground)]">API Key ID</dt>
                      <dd className="m-0 mt-1 break-all font-mono text-xs">{item.api_key_id}</dd>
                    </div>
                  </>
                )}
              </dl>
              <dl className="grid gap-x-6 gap-y-3 border-t border-[var(--color-border)] pt-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
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
            </div>
          </details>

          <details
            className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5"
            open={scope === 'admin'}
          >
            <summary className="cursor-pointer text-sm font-semibold text-[var(--color-ink)]">
              Token 用量
            </summary>
            <div className="mt-4">
              <UsageBreakdown usage={item.usage} usageValid={item.usage_valid} />
            </div>
          </details>

          <details
            className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5"
            open={scope === 'admin'}
          >
            <summary className="cursor-pointer text-sm font-semibold text-[var(--color-ink)]">
              价格快照
            </summary>
            <PriceSnapshot
              className="mt-4"
              snapshot={item.price_snapshot}
              snapshotValid={item.price_snapshot_valid}
              costUnits={item.cost_units}
              billingStatus={item.billing_status}
            />
          </details>
        </div>
      )}
    </section>
  );
}
