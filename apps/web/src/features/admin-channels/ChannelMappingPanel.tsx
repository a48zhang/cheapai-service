import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { ChannelView } from '@cheapai/api-client/channels';
import {
  MappingForm,
  MappingTable,
  modelMappingQueryKeys,
  modelMappingsQueryOptions,
} from '../admin-models/public';
import type { ModelMappingView } from '../admin-models/public';
import type { ApiClient } from '@cheapai/api-client/types';
import { adminChannelsQueryKeys } from './api';

export interface ChannelMappingPanelProps {
  readonly channel: ChannelView;
  readonly client: ApiClient;
  readonly actorId: string;
  readonly sessionEpoch: number;
}

function ChannelModelMappings({
  channel,
  publicModelId,
  client,
  actorId,
  sessionEpoch,
}: ChannelMappingPanelProps & { readonly publicModelId: string }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<ModelMappingView | null>(null);
  const query = useQuery(modelMappingsQueryOptions({ client, actorId }, publicModelId));
  const rows = query.data?.items.filter(mapping => mapping.channelId === channel.id) ?? [];
  const error = query.isError
    ? query.error instanceof Error ? query.error.message : '模型映射读取失败。'
    : null;

  const saved = () => {
    setEditing(null);
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: modelMappingQueryKeys.root(actorId, publicModelId) }),
      queryClient.invalidateQueries({ queryKey: adminChannelsQueryKeys.detail(actorId, sessionEpoch, channel.id) }),
    ]);
  };

  return (
    <section className="space-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="break-all font-mono text-sm font-semibold">{publicModelId}</h3>
          <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">映射版本独立于渠道配置版本。</p>
        </div>
        <Link
          to={`/admin/models/${encodeURIComponent(publicModelId)}`}
          className="text-sm font-medium text-[var(--color-primary)] underline-offset-4 hover:underline"
        >查看模型详情</Link>
      </div>

      <MappingTable
        rows={rows}
        loading={query.isPending}
        error={error}
        onRetry={() => { void query.refetch(); }}
        onEdit={setEditing}
      />

      {!query.isPending && !query.isError && rows.length === 0 && (
        <p role="status" className="rounded-md bg-[var(--color-muted)] p-3 text-sm text-[var(--color-muted-foreground)]">
          渠道详情引用了此模型，但模型映射列表中没有对应记录。请重新读取或检查并发配置变化。
        </p>
      )}

      {editing && (
        <div className="border-t border-[var(--color-border)] pt-4">
          <MappingForm
            client={client}
            actorId={actorId}
            sessionEpoch={sessionEpoch}
            publicModelId={publicModelId}
            initialMapping={editing}
            onSaved={saved}
            onCancel={() => setEditing(null)}
          />
        </div>
      )}
    </section>
  );
}

/** Shows only mappings that belong to this channel, with edits delegated through the models public API. */
export function ChannelMappingPanel({ channel, client, actorId, sessionEpoch }: ChannelMappingPanelProps) {
  const publicModelIds = [...new Set(channel.models.map(mapping => mapping.publicModelId))];

  return (
    <section aria-label="渠道模型映射" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-[var(--color-foreground)]">模型映射</h2>
          <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
            映射来自实际管理配置；配置存在不代表渠道已连通或该模型已授权给用户。
          </p>
        </div>
        <Link to="/admin/models" className="text-sm font-medium text-[var(--color-primary)] underline-offset-4 hover:underline">
          浏览模型目录
        </Link>
      </div>

      {publicModelIds.length > 0 ? (
        <div className="space-y-4">
          {publicModelIds.map(publicModelId => (
            <ChannelModelMappings
              key={publicModelId}
              channel={channel}
              publicModelId={publicModelId}
              client={client}
              actorId={actorId}
              sessionEpoch={sessionEpoch}
            />
          ))}
        </div>
      ) : (
        <div role="status" className="rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-10 text-center">
          <p className="font-medium text-[var(--color-foreground)]">此渠道尚无模型映射</p>
          <p className="mt-2 text-sm text-[var(--color-muted-foreground)]">从模型目录选择模型后，可在对应模型详情添加渠道映射。</p>
        </div>
      )}
    </section>
  );
}
