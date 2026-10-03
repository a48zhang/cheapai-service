import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import type { ChannelView } from '@cheapai/api-client/channels';
import { ChannelDiagnostics } from '../../features/admin-channels/ChannelDiagnostics';
import {
  adminChannelsQueryKeys,
  channelDetailQueryOptions,
  createAdminChannelsFeatureApi,
  invalidateAdminChannels,
} from '../../features/admin-channels/api';
import { ChannelForm } from '../../features/admin-channels/ChannelForm';
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
  const { user, epoch, client, isAdmin } = useSession();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [diagnosing, setDiagnosing] = useState(false);
  const userId = user?.id ?? 'anonymous';
  const api = useMemo(() => createAdminChannelsFeatureApi(client), [client]);
  const channelQuery = useQuery({
    ...channelDetailQueryOptions(api, userId, epoch, channelId),
    enabled: isAdmin && channelId.length > 0,
  });
  const channel = channelQuery.data;

  const onSaved = (saved: ChannelView) => {
    setEditing(false);
    queryClient.setQueryData(adminChannelsQueryKeys.detail(userId, epoch, saved.id), saved);
    void invalidateAdminChannels(queryClient, userId, epoch);
  };

  return (
    <section className="space-y-5">
      <PageHeader
        eyebrow="资源配置 · 渠道详情"
        heading={channel?.name ?? '渠道详情'}
        description="查看渠道配置、真实映射与版本。启用状态不会代表连接健康。"
        actions={(
          <>
            <Button asChild variant="outline"><Link to="/admin/channels">返回渠道列表</Link></Button>
            {channel && (
              <>
                <Button variant="outline" disabled={channel.status !== 'active'} onClick={() => setDiagnosing(true)}>连接诊断</Button>
                <Button onClick={() => setEditing(true)}>编辑配置</Button>
              </>
            )}
          </>
        )}
      />

      {!isAdmin ? (
        <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          此页面需要管理员权限。
        </div>
      ) : !channelId ? (
        <div role="alert" className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-700">
          渠道编号无效。
        </div>
      ) : channelQuery.isPending ? (
        <p role="status" className="rounded-lg border border-slate-200 bg-white p-5 text-sm text-slate-600">正在读取渠道配置…</p>
      ) : channelQuery.isError ? (
        <ApiErrorNotice error={channelQuery.error} onRetry={() => { void channelQuery.refetch(); }} />
      ) : channel ? (
        <>
          <section aria-label="渠道配置" className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
            <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-[var(--color-muted-foreground)]">渠道状态</p>
                <div className="mt-2">
                  <StatusBadge tone={channel.status === 'active' ? 'success' : 'neutral'}>
                    {channel.status === 'active' ? '启用' : '停用'}
                  </StatusBadge>
                </div>
              </div>
              <p className="text-sm text-[var(--color-muted-foreground)]">配置版本 <span className="font-mono">v{channel.configVersion}</span></p>
            </div>
            <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-2 xl:grid-cols-3">
              <div className="min-w-0"><dt className="text-xs text-[var(--color-muted-foreground)]">渠道 ID</dt><dd className="mt-1 break-all font-mono text-sm">{channel.id}</dd></div>
              <div className="min-w-0"><dt className="text-xs text-[var(--color-muted-foreground)]">上游 Base URL</dt><dd className="mt-1 break-all text-sm">{channel.baseUrl}</dd></div>
              <div><dt className="text-xs text-[var(--color-muted-foreground)]">凭证</dt><dd className="mt-1 text-sm">{channel.hasCredential ? '已配置（不回显）' : '未配置'}</dd></div>
              <div><dt className="text-xs text-[var(--color-muted-foreground)]">并发上限</dt><dd className="mt-1 text-sm tabular-nums">{limitLabel(channel.concurrencyLimit)}</dd></div>
              <div><dt className="text-xs text-[var(--color-muted-foreground)]">每分钟请求上限</dt><dd className="mt-1 text-sm tabular-nums">{limitLabel(channel.rpmLimit)}</dd></div>
              <div><dt className="text-xs text-[var(--color-muted-foreground)]">调度优先级</dt><dd className="mt-1 text-sm tabular-nums">{channel.priority}</dd></div>
              <div><dt className="text-xs text-[var(--color-muted-foreground)]">创建时间</dt><dd className="mt-1 text-sm">{formatDateTime(channel.createdAt)}</dd></div>
              <div><dt className="text-xs text-[var(--color-muted-foreground)]">最近更新</dt><dd className="mt-1 text-sm">{formatDateTime(channel.updatedAt)}</dd></div>
            </dl>
          </section>

          <ChannelMappingPanel channel={channel} client={client} actorId={userId} sessionEpoch={epoch} />
        </>
      ) : (
        <div role="status" className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-700">未找到此渠道。</div>
      )}

      {editing && channel && (
        <ChannelForm
          open
          channel={channel}
          api={api}
          onOpenChange={open => { if (!open) setEditing(false); }}
          onSaved={onSaved}
        />
      )}
      {diagnosing && channel && (
        <ChannelDiagnostics
          open
          channel={channel}
          api={api}
          onOpenChange={open => { if (!open) setDiagnosing(false); }}
        />
      )}
    </section>
  );
}

export default ChannelDetailPage;
