import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useLocation, useParams } from 'react-router-dom';
import { ChannelDiagnostics } from '../../features/admin-channels/ChannelDiagnostics';
import {
  channelDetailQueryOptions,
  createAdminChannelsFeatureApi,
} from '../../features/admin-channels/api';
import { ChannelManagement } from '../../features/admin-channels/ChannelManagement';
import { ChannelMappingPanel } from '../../features/admin-channels/ChannelMappingPanel';
import { useSession } from '../../features/session/useSession';
import { ApiErrorNotice } from '../../shared/patterns/ApiErrorNotice';
import { PageHeader } from '../../shared/patterns/PageHeader';
import { formatDateTime } from '../../shared/lib/datetime';
import { Button } from '../../shared/ui/Button';
import { StatusBadge } from '../../shared/ui/StatusBadge';

function limitLabel(limit: number): string {
  return limit === Number.MAX_SAFE_INTEGER ? '不限' : limit.toLocaleString();
}

export function ChannelDetailPage() {
  const { channelId: routeChannelId } = useParams<{ channelId: string }>();
  const channelId = routeChannelId ?? '';
  const location = useLocation();
  const { user, epoch, client, isAdmin } = useSession();
  const [editing, setEditing] = useState(false);
  const [managementTab, setManagementTab] = useState<'models' | 'settings'>('models');
  const [diagnosing, setDiagnosing] = useState(false);
  const userId = user?.id ?? 'anonymous';
  const api = useMemo(() => createAdminChannelsFeatureApi(client), [client]);
  const channelQuery = useQuery({
    ...channelDetailQueryOptions(api, userId, epoch, channelId),
    enabled: isAdmin && channelId.length > 0,
  });
  const channel = channelQuery.data;
  useEffect(() => {
    if (!channel || !location.hash.startsWith('#channel-model-mappings')) return;
    const target = document.getElementById('channel-model-mappings');
    target?.scrollIntoView({ block: 'start' });
    target?.focus({ preventScroll: true });
  }, [channel, location.hash]);

  return (
    <section className="space-y-6">
      <PageHeader
        heading={channel?.name ?? '渠道详情'}
        actions={
          <>
            <Button asChild variant="outline">
              <Link to="/admin/channels">返回渠道列表</Link>
            </Button>
            {channel && (
              <>
                <Button
                  variant="outline"
                  disabled={channel.status !== 'active'}
                  onClick={() => setDiagnosing(true)}
                >
                  连接诊断
                </Button>
                <Button
                  onClick={() => {
                    setManagementTab('models');
                    setEditing(true);
                  }}
                >
                  管理渠道
                </Button>
              </>
            )}
          </>
        }
      />

      {!isAdmin ? (
        <div
          role="alert"
          className="rounded-lg border border-[var(--color-warning-line)] bg-[var(--color-warning-soft)] p-4 text-sm text-[var(--color-warning)]"
        >
          此页面需要管理员权限。
        </div>
      ) : !channelId ? (
        <div
          role="alert"
          className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-ink-secondary)]"
        >
          渠道编号无效。
        </div>
      ) : channelQuery.isPending ? (
        <p
          role="status"
          className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] p-5 text-sm text-[var(--color-ink-secondary)]"
        >
          正在读取渠道配置…
        </p>
      ) : channelQuery.isError ? (
        <ApiErrorNotice
          error={channelQuery.error}
          onRetry={() => {
            void channelQuery.refetch();
          }}
        />
      ) : channel ? (
        <>
          <section aria-label="渠道配置" className="console-panel">
            <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-[var(--color-muted-foreground)]">渠道状态</p>
                <div className="mt-2">
                  <StatusBadge tone={channel.status === 'active' ? 'success' : 'neutral'}>
                    {channel.status === 'active' ? '启用' : '停用'}
                  </StatusBadge>
                </div>
              </div>
            </div>
            <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-2 xl:grid-cols-3">
              <div className="min-w-0">
                <dt className="console-muted">上游地址</dt>
                <dd className="mt-1 break-all text-sm">{channel.baseUrl}</dd>
              </div>
              <div>
                <dt className="console-muted">凭证</dt>
                <dd className="mt-1 text-sm">{channel.hasCredential ? '已配置' : '未配置'}</dd>
              </div>
              <div>
                <dt className="console-muted">并发上限</dt>
                <dd className="mt-1 text-sm tabular-nums">
                  {limitLabel(channel.concurrencyLimit)}
                </dd>
              </div>
              <div>
                <dt className="console-muted">每分钟请求上限</dt>
                <dd className="mt-1 text-sm tabular-nums">{limitLabel(channel.rpmLimit)}</dd>
              </div>
              <div>
                <dt className="console-muted">调度优先级</dt>
                <dd className="mt-1 text-sm tabular-nums">{channel.priority}</dd>
              </div>
              <div>
                <dt className="console-muted">创建时间</dt>
                <dd className="mt-1 text-sm">{formatDateTime(channel.createdAt)}</dd>
              </div>
              <div>
                <dt className="console-muted">最近更新</dt>
                <dd className="mt-1 text-sm">{formatDateTime(channel.updatedAt)}</dd>
              </div>
            </dl>
            <details className="mt-6 border-t border-[var(--color-border)] pt-4">
              <summary className="cursor-pointer console-muted">技术信息</summary>
              <dl className="mt-4 grid gap-4 sm:grid-cols-2">
                <div>
                  <dt className="console-label">渠道 ID</dt>
                  <dd className="mt-1 break-all font-mono text-sm select-all">{channel.id}</dd>
                </div>
              </dl>
            </details>
          </section>

          <div
            id="channel-model-mappings"
            tabIndex={-1}
            className="outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
          >
            <ChannelMappingPanel
              channel={channel}
              client={client}
              actorId={userId}
              sessionEpoch={epoch}
            />
          </div>
        </>
      ) : (
        <div
          role="status"
          className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-ink-secondary)]"
        >
          未找到此渠道。
        </div>
      )}

      {editing && channel && (
        <ChannelManagement
          initialTab={managementTab}
          channel={channel}
          client={client}
          actorId={userId}
          sessionEpoch={epoch}
          onOpenChange={(open) => {
            if (!open) setEditing(false);
          }}
        />
      )}
      {diagnosing && channel && (
        <ChannelDiagnostics
          open
          channel={channel}
          api={api}
          sessionIdentity={{ userId, epoch }}
          onRepair={(kind) => {
            setDiagnosing(false);
            if (kind === 'credentials') {
              setManagementTab('settings');
              setEditing(true);
            } else
              requestAnimationFrame(() => {
                const target = document.getElementById('channel-model-mappings');
                target?.scrollIntoView({ block: 'start' });
                target?.focus({ preventScroll: true });
              });
          }}
          onOpenChange={(open) => {
            if (!open) setDiagnosing(false);
          }}
        />
      )}
    </section>
  );
}

export default ChannelDetailPage;
