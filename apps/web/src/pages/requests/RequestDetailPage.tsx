import { useState } from 'react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { requestDetailQueryOptions } from '../../features/request-history/api';
import { PriceSnapshot } from '../../features/request-history/PriceSnapshot';
import { billingLabels } from '../../features/request-history/RequestStatus';
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
import { Button } from '../../shared/ui/Button';
import { StatusBadge } from '../../shared/ui/StatusBadge';

export function RequestDetailPage() {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
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
  const duration =
    item?.started_at != null && item.finished_at !== null
      ? `${((item.finished_at - item.started_at) / 1000).toLocaleString('zh-CN', { maximumFractionDigits: 3 })} 秒`
      : '—';
  const errorSummary: Record<string, string> = {
    upstream_error: '上游模型请求失败',
    client_cancelled: '请求已取消',
    request_timeout: '请求超时',
    internal_error: '请求处理失败',
    unclassified_error: '请求处理失败',
  };
  const result = item ? requestResultPresentation(item.execution_status) : null;

  return (
    <section className="space-y-5">
      <PageHeader
        heading={scope === 'admin' ? '请求详情' : '使用记录详情'}
        description={!id ? '请求编号无效。' : undefined}
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
        <p className="console-label" role="status">
          正在读取请求详情…
        </p>
      )}
      {item && (
        <div className="space-y-4">
          <section className="console-panel p-4 sm:p-5">
            <h2 className="sr-only">使用记录摘要</h2>
            <dl className="grid gap-x-6 gap-y-5 sm:grid-cols-2 xl:grid-cols-3">
              <div className="min-w-0">
                <dt className="console-label">时间</dt>
                <dd className="m-0 mt-2 console-value">{formatDateTime(item.created_at)}</dd>
              </div>
              <div className="min-w-0">
                <dt className="console-label">模型</dt>
                <dd className="m-0 mt-2 break-words console-value font-medium">
                  {item.public_model_id}
                </dd>
              </div>
              <div>
                <dt className="console-label">耗时</dt>
                <dd className="m-0 mt-2 console-value console-number">{duration}</dd>
              </div>
              <div>
                <dt className="console-label">来源</dt>
                <dd className="m-0 mt-2 console-value">{requestSourceLabel(item.source)}</dd>
              </div>
              <div>
                <dt className="console-label">结果</dt>
                <dd className="m-0 mt-1">
                  {result && <StatusBadge tone={result.tone}>{result.label}</StatusBadge>}
                </dd>
              </div>
              <div>
                <dt className="console-label">费用</dt>
                <dd className="m-0 mt-2 break-words console-number text-lg font-semibold text-[var(--color-ink)]">
                  {requestCostLabel(item)}
                </dd>
                <dd className="m-0 mt-2">
                  <StatusBadge tone={billingLabels[item.billing_status].tone}>
                    {billingLabels[item.billing_status].label}
                  </StatusBadge>
                </dd>
              </div>
            </dl>
            <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-[var(--color-border)] pt-4">
              <span className="console-label">请求 ID</span>
              <code className="min-w-0 break-all text-sm text-[var(--color-ink-secondary)]">
                {item.id}
              </code>
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(item.id);
                    setCopyState('copied');
                  } catch {
                    setCopyState('failed');
                  }
                }}
              >
                {copyState === 'copied' ? '已复制' : '复制'}
              </Button>
              {copyState === 'failed' && (
                <span role="status" className="text-sm text-[var(--color-danger)]">
                  复制失败，请手动选择复制。
                </span>
              )}
              {scope === 'admin' && (
                <Link
                  className="ml-auto text-sm text-[var(--color-accent)] hover:underline"
                  to={`/admin/billing?${new URLSearchParams({ userId: item.user_id, requestId: item.id })}`}
                >
                  相关账单
                </Link>
              )}
            </div>
            {item.error && (
              <div
                className="mt-5 rounded-lg border border-[var(--color-danger-line)] bg-[var(--color-danger-soft)] p-4 text-[15px] leading-7 text-[var(--color-danger)]"
                role="alert"
              >
                <strong className="block break-words">
                  {errorSummary[item.error.code] ?? '请求未能完成'}
                </strong>
                <details className="mt-2 text-sm">
                  <summary className="cursor-pointer">服务返回信息</summary>
                  <p className="mb-0 mt-2 break-words">{item.error.message}</p>
                  <p className="mb-0 mt-1 break-all font-mono">{item.error.code}</p>
                </details>
              </div>
            )}
          </section>

          <details className="console-panel p-4 sm:p-5">
            <summary className="console-section-title cursor-pointer">技术详情</summary>
            <div className="mt-4 space-y-4">
              <dl className="grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
                <div>
                  <dt className="console-label">访问组</dt>
                  <dd className="m-0 mt-1 break-all">
                    {item.group_name ?? item.group_id ?? '未记录分组'}
                  </dd>
                </div>
                <div>
                  <dt className="console-label">请求协议</dt>
                  <dd className="m-0 mt-1">{item.downstream_protocol}</dd>
                </div>
                <div>
                  <dt className="console-label">上游协议</dt>
                  <dd className="m-0 mt-1">{item.upstream_protocol}</dd>
                </div>
                <div>
                  <dt className="console-label">上游模型</dt>
                  <dd className="m-0 mt-1 break-all">{item.upstream_model}</dd>
                </div>
                <div>
                  <dt className="console-label">渠道 ID</dt>
                  <dd className="m-0 mt-1 break-all font-mono text-sm">{item.channel_id}</dd>
                </div>
                <div>
                  <dt className="console-label">重试次数</dt>
                  <dd className="m-0 mt-1 tabular-nums">{item.retry_count}</dd>
                </div>
                {scope === 'admin' && (
                  <>
                    <div>
                      <dt className="console-label">用户</dt>
                      <dd className="m-0 mt-1 break-all">
                        <Link
                          className="text-[var(--color-accent)] hover:underline"
                          to={`/admin/users/${encodeURIComponent(item.user_id)}`}
                        >
                          {item.user_email ?? item.user_id}
                        </Link>
                      </dd>
                    </div>
                    <div>
                      <dt className="console-label">API Key ID</dt>
                      <dd className="m-0 mt-1 break-all font-mono text-sm">{item.api_key_id}</dd>
                    </div>
                  </>
                )}
              </dl>
              <dl className="grid gap-x-6 gap-y-3 border-t border-[var(--color-border)] pt-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
                <div>
                  <dt className="console-label">开始</dt>
                  <dd className="m-0 mt-1">{formatDateTime(item.started_at)}</dd>
                </div>
                <div>
                  <dt className="console-label">完成</dt>
                  <dd className="m-0 mt-1">{formatDateTime(item.finished_at)}</dd>
                </div>
                <div>
                  <dt className="console-label">最后更新</dt>
                  <dd className="m-0 mt-1">{formatDateTime(item.updated_at)}</dd>
                </div>
                {item.next_retry_at !== null && (
                  <div>
                    <dt className="console-label">下次结算重试</dt>
                    <dd className="m-0 mt-1">{formatDateTime(item.next_retry_at)}</dd>
                  </div>
                )}
              </dl>
            </div>
          </details>

          <details className="console-panel p-4 sm:p-5" open>
            <summary className="console-section-title cursor-pointer">Token 用量</summary>
            <div className="mt-4">
              <UsageBreakdown usage={item.usage} usageValid={item.usage_valid} />
            </div>
          </details>

          <details className="console-panel p-4 sm:p-5">
            <summary className="console-section-title cursor-pointer">价格快照</summary>
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
