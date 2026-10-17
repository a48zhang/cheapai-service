import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ChannelView } from '@cheapai/api-client/channels';
import type { ApiClient } from '@cheapai/api-client/types';
import { Sheet } from '../../shared/ui/Sheet';
import { Tabs } from '../../shared/ui/Tabs';
import { StatusBadge } from '../../shared/ui/StatusBadge';
import { ApiErrorNotice } from '../../shared/patterns/ApiErrorNotice';
import { DeleteChannelAction } from './DeleteChannelAction';
import { ChannelForm } from './ChannelForm';
import { ChannelMappingPanel } from './ChannelMappingPanel';
import {
  channelDetailQueryOptions,
  createAdminChannelsFeatureApi,
  recordChannelSaved,
} from './api';

export interface ChannelManagementProps {
  readonly channel: ChannelView;
  readonly client: ApiClient;
  readonly actorId: string;
  readonly sessionEpoch: number;
  readonly onOpenChange: (open: boolean) => void;
  readonly initialTab?: 'models' | 'settings';
}

/** One wide workspace for a channel's model mappings and upstream settings. */
export function ChannelManagement({
  channel: initialChannel,
  client,
  actorId,
  sessionEpoch,
  onOpenChange,
  initialTab = 'models',
}: ChannelManagementProps) {
  const queryClient = useQueryClient();
  const api = useMemo(() => createAdminChannelsFeatureApi(client), [client]);
  const channelQuery = useQuery({
    ...channelDetailQueryOptions(api, actorId, sessionEpoch, initialChannel.id),
    initialData: initialChannel,
  });
  const channel = channelQuery.data;
  const [tab, setTab] = useState<string>(initialTab);
  const [busy, setBusy] = useState(false);
  const [footerContainer, setFooterContainer] = useState<HTMLDivElement | null>(null);
  const close = (open: boolean) => {
    if (!busy) onOpenChange(open);
  };

  return (
    <Sheet
      open
      onOpenChange={close}
      title={
        <span className="flex flex-wrap items-center gap-3">
          管理渠道
          <span className="font-normal text-[var(--color-muted-foreground)]">{channel.name}</span>
          <StatusBadge tone={channel.status === 'active' ? 'success' : 'neutral'}>
            {channel.status === 'active' ? '启用' : '停用'}
          </StatusBadge>
        </span>
      }
      closeButton={!busy}
      className="md:!w-[min(52rem,92vw)]"
      footer={
        tab === 'settings' ? (
          <div
            ref={setFooterContainer}
            className="flex w-full flex-wrap items-center justify-end gap-2"
          />
        ) : undefined
      }
    >
      <div
        className="mb-5 truncate text-sm text-[var(--color-muted-foreground)]"
        title={channel.baseUrl}
      >
        {channel.baseUrl}
      </div>
      {channelQuery.isError && (
        <div className="mb-4">
          <ApiErrorNotice
            error={channelQuery.error}
            onRetry={() => {
              void channelQuery.refetch();
            }}
          />
        </div>
      )}
      <div className="mb-5 flex justify-end">
        <DeleteChannelAction
          channel={channel}
          api={api}
          actorId={actorId}
          epoch={sessionEpoch}
          busy={busy}
          onBusyChange={setBusy}
          onDeleted={() => onOpenChange(false)}
        />
      </div>
      <Tabs
        value={tab}
        onValueChange={(value) => {
          if (!busy) {
            setTab(value);
          }
        }}
        ariaLabel="渠道管理"
        contentClassName="pt-6"
        items={[
          {
            value: 'models',
            label: '模型管理',
            keepMounted: true,
            disabled: busy && tab !== 'models',
            content: (
              <ChannelMappingPanel
                channel={channel}
                client={client}
                actorId={actorId}
                sessionEpoch={sessionEpoch}
                onBusyChange={setBusy}
              />
            ),
          },
          {
            value: 'settings',
            label: '渠道配置',
            keepMounted: true,
            disabled: busy && tab !== 'settings',
            content: (
              <ChannelForm
                embedded
                footerContainer={footerContainer}
                open
                channel={channel}
                api={api}
                onOpenChange={close}
                onBusyChange={setBusy}
                onSaved={(saved) => {
                  void recordChannelSaved(queryClient, actorId, sessionEpoch, saved);
                }}
              />
            ),
          },
        ]}
      />
    </Sheet>
  );
}
