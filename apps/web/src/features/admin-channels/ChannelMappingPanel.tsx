import { ModelIdentity } from '../../shared/ui/ModelIdentity';
import { useEffect, useId, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { createChannelsApi } from '@cheapai/api-client/channels';
import type { ChannelView } from '@cheapai/api-client/channels';
import { ApiClientError } from '@cheapai/api-client/errors';
import { createMappingsApi } from '@cheapai/api-client/mappings';
import type { Protocol } from '@cheapai/api-client/mappings';
import type { ApiClient } from '@cheapai/api-client/types';
import { modelListQueryOptions, recordMappingSaved } from '../admin-models/public';
import { withErrorContext } from '../../shared/lib/api-error';
import { ApiErrorNotice } from '../../shared/patterns/ApiErrorNotice';
import { Button } from '../../shared/ui/Button';
import { Field } from '../../shared/ui/Field';
import { Input } from '../../shared/ui/Input';
import { Select } from '../../shared/ui/Select';
import { invalidateAdminChannels, recordChannelSaved } from './api';

export interface ChannelMappingPanelProps {
  readonly channel: ChannelView;
  readonly client: ApiClient;
  readonly actorId: string;
  readonly sessionEpoch: number;
  readonly onBusyChange?: (busy: boolean) => void;
}

type ChannelMapping = ChannelView['models'][number];
const protocols = [
  { value: 'chat', label: 'Chat Completions' },
  { value: 'responses', label: 'Responses' },
  { value: 'messages', label: 'Messages' },
];

/** Edits mappings in the channel workspace without asking the user to switch resource pages. */
export function ChannelMappingPanel({
  channel,
  client,
  actorId,
  sessionEpoch,
  onBusyChange,
}: ChannelMappingPanelProps) {
  const queryClient = useQueryClient();
  const api = useMemo(() => createMappingsApi(client), [client]);
  const [editor, setEditor] = useState<ChannelMapping | 'new' | null>(null);
  const [modelId, setModelId] = useState('');
  const [modelSearch, setModelSearch] = useState('');
  const [upstreamModel, setUpstreamModel] = useState('');
  const [protocol, setProtocol] = useState<Protocol>('chat');
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const editorId = useId();
  const models = useInfiniteQuery({
    ...modelListQueryOptions({ client, actorId }),
    enabled: editor === 'new',
  });
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = models;
  useEffect(() => {
    if (editor === 'new' && hasNextPage && !isFetchingNextPage && !isFetchNextPageError)
      void fetchNextPage();
  }, [editor, hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage]);
  const modelOptions = (models.data?.pages.flatMap((page) => page.items) ?? [])
    .filter(
      (model) =>
        model.publicModelId === modelId ||
        model.publicModelId.toLocaleLowerCase().includes(modelSearch.trim().toLocaleLowerCase()),
    )
    .map((model) => ({ value: model.publicModelId, label: model.publicModelId }));

  const openEditor = (mapping: ChannelMapping | 'new') => {
    setEditor(mapping);
    setModelSearch('');
    setModelId(mapping === 'new' ? '' : mapping.publicModelId);
    setUpstreamModel(mapping === 'new' ? '' : mapping.upstreamModel);
    setProtocol(mapping === 'new' ? 'chat' : mapping.protocol);
    setError(null);
    setConflict(false);
    setNotice(null);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editor || saving) return;
    setSaving(true);
    onBusyChange?.(true);
    setError(null);
    try {
      const saved =
        editor === 'new'
          ? await api.createMapping(modelId, {
              channelId: channel.id,
              protocol,
              upstreamModel,
            })
          : await api.updateMapping(
              editor.publicModelId,
              channel.id,
              editor.protocol,
              editor.mappingVersion,
              { upstreamModel },
            );
      await Promise.all([
        recordMappingSaved(queryClient, actorId, saved),
        invalidateAdminChannels(queryClient, actorId, sessionEpoch),
      ]);
      setEditor(null);
    } catch (cause) {
      if (editor !== 'new' && cause instanceof ApiClientError && cause.status === 409) {
        setError(
          withErrorContext(
            cause,
            '模型映射已被其他操作修改。你的输入仍保留，请重新读取后确认并保存。',
          ),
        );
        setConflict(true);
        void invalidateAdminChannels(queryClient, actorId, sessionEpoch);
      } else {
        setError(cause instanceof Error ? cause : new Error('模型映射未能保存，请重试。'));
      }
    } finally {
      setSaving(false);
      onBusyChange?.(false);
    }
  };

  const reloadMapping = async () => {
    if (!editor || editor === 'new') return;
    setSaving(true);
    onBusyChange?.(true);
    try {
      const latest = await createChannelsApi(client).get(channel.id);
      await recordChannelSaved(queryClient, actorId, sessionEpoch, latest);
      const mapping = latest.models.find(
        (item) => item.publicModelId === editor.publicModelId && item.protocol === editor.protocol,
      );
      if (!mapping) throw new Error('此映射已被移除，请取消编辑后重新添加。');
      setEditor(mapping);
      setConflict(false);
      setError(null);
      setNotice('已读取最新配置，你的输入已保留。请确认后保存。');
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error('读取失败，请重试。'));
    } finally {
      setSaving(false);
      onBusyChange?.(false);
    }
  };

  const form = (
    <form
      id={editorId}
      onSubmit={(event) => {
        void submit(event);
      }}
      className="space-y-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-muted)] p-5"
    >
      <h3 className="font-semibold">{editor === 'new' ? '添加模型' : '编辑模型映射'}</h3>
      {error && <ApiErrorNotice error={error} />}
      {conflict && (
        <Button
          variant="outline"
          size="sm"
          busy={saving}
          onClick={() => {
            void reloadMapping();
          }}
        >
          重新读取
        </Button>
      )}
      {notice && (
        <p role="status" className="console-muted">
          {notice}
        </p>
      )}
      {editor === 'new' && (
        <Input
          aria-label="搜索模型"
          placeholder="搜索模型名称"
          value={modelSearch}
          onChange={(event) => setModelSearch(event.currentTarget.value)}
          disabled={saving}
          autoComplete="off"
        />
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="对外模型" required>
          {editor === 'new' ? (
            <Select
              aria-label="对外模型"
              items={modelOptions}
              value={modelId}
              placeholder={models.isPending ? '正在读取模型…' : '选择已有模型'}
              required
              disabled={saving || models.isPending}
              onValueChange={(value) => {
                setModelId(value);
                if (!upstreamModel) setUpstreamModel(value);
              }}
            />
          ) : (
            <Input value={modelId} disabled />
          )}
        </Field>
        <Field label="接口协议" required>
          <Select
            aria-label="接口协议"
            items={protocols}
            value={protocol}
            disabled={saving || editor !== 'new'}
            onValueChange={(value) => {
              if (value === 'chat' || value === 'responses' || value === 'messages')
                setProtocol(value);
            }}
          />
        </Field>
      </div>
      {editor === 'new' && models.isError && (
        <ApiErrorNotice
          error={models.error}
          onRetry={() => {
            void models.refetch();
          }}
        />
      )}
      {editor === 'new' && models.hasNextPage && (
        <Button
          variant="ghost"
          size="sm"
          busy={models.isFetchingNextPage}
          onClick={() => {
            void models.fetchNextPage();
          }}
        >
          加载更多模型
        </Button>
      )}
      {editor === 'new' &&
        !models.isPending &&
        !models.isError &&
        !modelSearch &&
        modelOptions.length === 0 && (
          <p className="console-muted">模型目录为空，请先在模型目录创建对外模型。</p>
        )}
      <Field label="上游模型名称">
        <Input
          value={upstreamModel}
          onChange={(event) => setUpstreamModel(event.currentTarget.value)}
          disabled={saving}
          placeholder="例如 gpt-5"
          autoComplete="off"
        />
      </Field>
      <div className="flex justify-end gap-2">
        <Button variant="outline" disabled={saving} onClick={() => setEditor(null)}>
          取消
        </Button>
        <Button type="submit" busy={saving} disabled={conflict || !modelId}>
          {editor === 'new' ? '添加模型' : '保存更改'}
        </Button>
      </div>
    </form>
  );

  return (
    <section aria-label="渠道模型映射" className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="console-section-title">
          已关联模型{' '}
          <span className="ml-2 text-sm font-normal text-[var(--color-muted-foreground)]">
            {channel.models.length}
          </span>
        </h2>
        <Button size="sm" disabled={saving} onClick={() => openEditor('new')}>
          <Plus size={16} aria-hidden="true" />
          添加模型
        </Button>
      </div>
      {editor === 'new' && form}
      {channel.models.length ? (
        <div className="overflow-hidden rounded-xl border border-[var(--color-border)]">
          <div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,1fr)_8rem_4rem] gap-3 bg-[var(--color-muted)] px-4 py-3 text-sm text-[var(--color-muted-foreground)] sm:grid">
            <span>对外模型</span>
            <span>上游模型</span>
            <span>接口协议</span>
            <span />
          </div>
          {channel.models.map((mapping) => (
            <div
              key={`${mapping.publicModelId}:${mapping.protocol}`}
              className="border-t border-[var(--color-border)] first:border-t-0"
            >
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_8rem_4rem]">
                <ModelIdentity modelId={mapping.publicModelId} />
                <span
                  className="truncate text-sm text-[var(--color-muted-foreground)]"
                  title={mapping.upstreamModel}
                >
                  {mapping.upstreamModel}
                </span>
                <span className="text-sm">
                  {protocols.find((item) => item.value === mapping.protocol)?.label}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={saving}
                  onClick={() => openEditor(mapping)}
                >
                  编辑
                </Button>
              </div>
              {editor !== null &&
                editor !== 'new' &&
                editor.publicModelId === mapping.publicModelId &&
                editor.protocol === mapping.protocol && <div className="px-4 pb-4">{form}</div>}
            </div>
          ))}
        </div>
      ) : (
        editor !== 'new' && (
          <div className="rounded-xl border border-dashed border-[var(--color-border)] px-6 py-12 text-center">
            <p className="font-medium">此渠道尚未添加模型</p>
            <p className="mt-2 console-muted">添加模型后，即可通过此渠道转发请求。</p>
            <Button className="mt-5" variant="outline" onClick={() => openEditor('new')}>
              添加第一个模型
            </Button>
          </div>
        )
      )}
    </section>
  );
}
