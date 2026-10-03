import { useMemo, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { createGroupsApi } from '@cheapai/api-client/groups';
import { createMappingsApi } from '@cheapai/api-client/mappings';
import type { GroupView } from '@cheapai/api-client/groups';
import { useSearchParams } from 'react-router-dom';
import type { ChannelView } from '@cheapai/api-client/channels';
import { ChannelDiagnostics } from '../../features/admin-channels/ChannelDiagnostics';
import { ChannelSetup } from '../../features/admin-channels/ChannelSetup';
import type { ChannelSetupCommands, ChannelSetupProgress } from '../../features/admin-channels/setup-controller';
import {
  adminChannelsQueryKeys,
  createAdminChannelsFeatureApi,
  channelsListQueryOptions,
  invalidateAdminChannels,
} from '../../features/admin-channels/api';
import { ChannelForm } from '../../features/admin-channels/ChannelForm';
import { ChannelTable } from '../../features/admin-channels/ChannelTable';
import { useSession } from '../../features/session/useSession';
import { FilterBar } from '../../shared/patterns/FilterBar';
import { PageHeader } from '../../shared/patterns/PageHeader';
import { Field } from '../../shared/ui/Field';
import { Select } from '../../shared/ui/Select';
import { Button } from '../../shared/ui/Button';

const statusOptions = [
  { value: 'all', label: '全部状态' },
  { value: 'active', label: '启用' },
  { value: 'disabled', label: '停用' },
] as const;

function channelStatusFromUrl(value: string | null): 'all' | 'active' | 'disabled' {
  return value === 'active' || value === 'disabled' ? value : 'all';
}

export function ChannelsPage() {
  const { user, epoch, client, isAdmin } = useSession();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [formChannel, setFormChannel] = useState<ChannelView | null | undefined>(undefined);
  const [diagnosticChannel, setDiagnosticChannel] = useState<ChannelView | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const userId = user?.id ?? 'anonymous';
  const status = channelStatusFromUrl(searchParams.get('status'));
  const api = useMemo(() => createAdminChannelsFeatureApi(client), [client]);
  const mappingApi = useMemo(() => createMappingsApi(client), [client]);
  const groupApi = useMemo(() => createGroupsApi(client), [client]);
  const setupGroupsQueryKey = ['admin', 'groups', userId, epoch, 'setup-candidates'] as const;
  const setupGroups = useQuery({
    queryKey: setupGroupsQueryKey,
    queryFn: () => groupApi.listAll(),
    enabled: isAdmin,
  });
  const setupCommands = useMemo<ChannelSetupCommands>(() => ({
    createChannel: input => api.create(input),
    createMapping: (publicModelId, input) => mappingApi.createMapping(publicModelId, input),
    updateGroup: (groupId, version, patch) => groupApi.update(groupId, version, patch),
  }), [api, mappingApi, groupApi]);
  const channels = useInfiniteQuery(channelsListQueryOptions(api, userId, epoch, status, isAdmin));
  const rows = channels.data?.pages.flatMap(page => page.items) ?? [];
  const nextCursor = channels.data?.pages.at(-1)?.nextCursor ?? null;
  const error = channels.error instanceof Error ? channels.error.message : null;

  const updateStatus = (value: string) => {
    if (value !== 'all' && value !== 'active' && value !== 'disabled') return;
    const next = new URLSearchParams(searchParams);
    if (value === 'all') next.delete('status');
    else next.set('status', value);
    setSearchParams(next, { replace: true });
  };

  const openCreate = () => setFormChannel(null);
  const openEdit = (channel: ChannelView) => setFormChannel(channel);
  const closeForm = (open: boolean) => { if (!open) setFormChannel(undefined); };
  const onSaved = (channel: ChannelView) => {
    setFormChannel(undefined);
    void Promise.all([
      invalidateAdminChannels(queryClient, userId, epoch),
      queryClient.invalidateQueries({ queryKey: ['admin', 'channels', userId, epoch, 'detail', channel.id] }),
    ]);
  };

  const onSetupComplete = (progress: ChannelSetupProgress) => {
    if (progress.channel) {
      queryClient.setQueryData(adminChannelsQueryKeys.detail(userId, epoch, progress.channel.id), progress.channel);
      void invalidateAdminChannels(queryClient, userId, epoch);
    }
    void queryClient.invalidateQueries({ queryKey: setupGroupsQueryKey });
  };

  return (
    <section className="space-y-5">
      <PageHeader
        eyebrow="资源配置"
        heading="渠道"
        description="查看上游渠道、已配置的模型映射与实际限额。连接诊断由管理员明确发起，并可能产生上游费用。"
        actions={(
          <>
            <Button variant="outline" onClick={() => setSetupOpen(true)}>渠道快速配置</Button>
            <Button onClick={openCreate}>创建渠道</Button>
          </>
        )}
      />

      <FilterBar>
        <Field label="状态">
          <Select
            aria-label="按渠道状态筛选"
            items={statusOptions}
            value={status}
            onValueChange={updateStatus}
          />
        </Field>
      </FilterBar>

      {!isAdmin && (
        <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          此页面需要管理员权限。
        </div>
      )}

      <ChannelTable
        rows={rows}
        hasMore={nextCursor !== null}
        loading={channels.isPending && isAdmin}
        loadingMore={channels.isFetchingNextPage}
        error={channels.isError ? error ?? '渠道读取失败。' : null}
        onLoadMore={() => { void channels.fetchNextPage(); }}
        onRetry={() => {
          if (channels.isFetchNextPageError) void channels.fetchNextPage();
          else void channels.refetch();
        }}
        onEdit={openEdit}
        onDiagnose={setDiagnosticChannel}
      />

      {formChannel !== undefined && (
        <ChannelForm
          open
          channel={formChannel}
          api={api}
          onOpenChange={closeForm}
          onSaved={onSaved}
        />
      )}

      {diagnosticChannel && (
        <ChannelDiagnostics
          open
          channel={diagnosticChannel}
          api={api}
          onOpenChange={open => { if (!open) setDiagnosticChannel(null); }}
        />
      )}

      <ChannelSetup
        key={`${userId}:${epoch}`}
        open={setupOpen}
        onOpenChange={setSetupOpen}
        commands={setupCommands}
        groups={(setupGroups.data ?? []) as readonly GroupView[]}
        groupsLoading={setupGroups.isPending && isAdmin}
        groupsError={setupGroups.isError
          ? setupGroups.error instanceof Error ? setupGroups.error : new Error('访问组候选读取失败。')
          : null}
        onRetryGroups={() => { void setupGroups.refetch(); }}
        onComplete={onSetupComplete}
      />
    </section>
  );
}

export default ChannelsPage;
