import type { FormEvent } from 'react';
import type { ApiClient } from '@cheapai/api-client/types';
import { PublicModelPicker } from '../admin-models/public';
import type { GroupView } from '@cheapai/api-client/groups';
import type { ChannelSetupProgress } from './setup-controller';
import type { SetupChannelDraft, SetupMappingDraft } from './setup-form-model';
import { ApiErrorNotice } from '../../shared/patterns/ApiErrorNotice';
import { Field } from '../../shared/ui/Field';
import { Input } from '../../shared/ui/Input';
import { Select } from '../../shared/ui/Select';
import { Link } from 'react-router-dom';

export interface ChannelSetupStepsProps {
  readonly client: ApiClient;
  readonly actorId: string;
  readonly step: ChannelSetupProgress['step'];
  readonly channelFormId: string;
  readonly mappingFormId: string;
  readonly groupFormId: string;
  readonly channelDraft: SetupChannelDraft;
  readonly mappingDraft: SetupMappingDraft;
  readonly groupId: string;
  readonly groups: readonly GroupView[];
  readonly groupsLoading: boolean;
  readonly groupsError: Error | null | undefined;
  readonly onRetryGroups: (() => void) | undefined;
  readonly selectedGroup: GroupView | null;
  readonly progressError: Error | null;
  readonly busy: boolean;
  readonly onSubmitChannel: (event: FormEvent<HTMLFormElement>) => void;
  readonly onChannelDraftChange: <K extends keyof SetupChannelDraft>(
    key: K,
    value: SetupChannelDraft[K],
  ) => void;
  readonly onSubmitMapping: (event: FormEvent<HTMLFormElement>) => void;
  readonly onMappingDraftChange: <K extends keyof SetupMappingDraft>(
    key: K,
    value: SetupMappingDraft[K],
  ) => void;
  readonly onSubmitGroup: (event: FormEvent<HTMLFormElement>) => void;
  readonly onGroupIdChange: (value: string) => void;
}

const protocolOptions = [
  { value: 'chat', label: 'Chat Completions' },
  { value: 'responses', label: 'Responses' },
  { value: 'messages', label: 'Messages' },
] as const;

export function ChannelSetupSteps({
  client,
  actorId,
  step,
  channelFormId,
  mappingFormId,
  groupFormId,
  channelDraft,
  mappingDraft,
  groupId,
  groups,
  groupsLoading,
  groupsError,
  onRetryGroups,
  selectedGroup,
  progressError,
  busy,
  onSubmitChannel,
  onChannelDraftChange,
  onSubmitMapping,
  onMappingDraftChange,
  onSubmitGroup,
  onGroupIdChange,
}: ChannelSetupStepsProps) {
  return (
    <>
      {step === 'channel' && (
        <form id={channelFormId} className="grid gap-4" onSubmit={onSubmitChannel}>
          <p className="console-muted">新渠道默认启用，请求与并发上限不限。</p>
          <Field label="渠道名称" required>
            <Input
              value={channelDraft.name}
              onChange={(event) => onChannelDraftChange('name', event.currentTarget.value)}
              maxLength={200}
              required
              disabled={busy}
            />
          </Field>
          <Field label="上游地址" required>
            <Input
              value={channelDraft.baseUrl}
              onChange={(event) => onChannelDraftChange('baseUrl', event.currentTarget.value)}
              maxLength={2048}
              required
              inputMode="url"
              disabled={busy}
            />
          </Field>
          <Field label="上游凭证" required>
            <Input
              type="password"
              value={channelDraft.upstreamKey}
              onChange={(event) => onChannelDraftChange('upstreamKey', event.currentTarget.value)}
              autoComplete="new-password"
              maxLength={16_384}
              required
              disabled={busy}
            />
          </Field>
          <Field label="调度优先级" description="数值越高越优先；0 为默认值。" required>
            <Input
              type="number"
              min={0}
              step={1}
              value={channelDraft.priority}
              onChange={(event) => onChannelDraftChange('priority', event.currentTarget.value)}
              required
              disabled={busy}
            />
          </Field>
        </form>
      )}

      {step === 'mapping' && (
        <form id={mappingFormId} className="grid gap-4" onSubmit={onSubmitMapping}>
          <p className="console-muted">
            渠道已保存。搜索选择或新增对外模型，然后填写上游模型名称与协议。
          </p>
          <Field label="对外模型" required>
            <PublicModelPicker
              client={client}
              actorId={actorId}
              value={mappingDraft.publicModelId}
              onValueChange={(value) => onMappingDraftChange('publicModelId', value)}
              disabled={busy}
            />
          </Field>
          <Field label="映射协议" required>
            <Select
              items={protocolOptions}
              value={mappingDraft.protocol}
              onValueChange={(value) => {
                if (value === 'chat' || value === 'responses' || value === 'messages')
                  onMappingDraftChange('protocol', value);
              }}
              disabled={busy}
            />
          </Field>
          <Field label="上游模型 ID">
            <Input
              value={mappingDraft.upstreamModel}
              onChange={(event) => onMappingDraftChange('upstreamModel', event.currentTarget.value)}
              disabled={busy}
            />
          </Field>
        </form>
      )}

      {step === 'group' && (
        <form id={groupFormId} className="grid gap-4" onSubmit={onSubmitGroup}>
          <p className="console-muted">将新渠道加入访问组。</p>
          {groupsLoading && (
            <p role="status" className="console-muted">
              正在读取访问组…
            </p>
          )}
          {groupsError && (
            <div className="grid gap-2">
              <ApiErrorNotice error={groupsError} onRetry={onRetryGroups} />
              <p className="console-muted">请重试加载访问组；渠道与映射已保存。</p>
            </div>
          )}
          {!groupsLoading && !groupsError && groups.length === 0 && (
            <div className="rounded-lg border border-dashed border-[var(--color-border)] p-4 text-sm">
              <p className="font-medium">还没有访问组</p>
              <p className="mt-1 text-[var(--color-muted-foreground)]">
                先创建访问组，再回来继续此步骤。
              </p>
              <Link
                to="/admin/groups"
                className="mt-2 inline-block font-medium text-[var(--color-primary)] underline"
              >
                打开访问组管理
              </Link>
            </div>
          )}
          {groups.length > 0 && (
            <Field label="访问组" required>
              <Select
                items={groups.map((group) => ({
                  value: group.id,
                  label: `${group.name} · ${group.status === 'active' ? '启用' : '停用'}`,
                }))}
                value={groupId}
                onValueChange={onGroupIdChange}
                disabled={busy || groupsLoading || Boolean(groupsError)}
                placeholder="选择访问组"
                required
              />
            </Field>
          )}
          {selectedGroup && (
            <p className="rounded-md bg-[var(--color-muted)] p-3 console-muted">
              已有 {selectedGroup.channelIds.length} 个渠道
            </p>
          )}
          {progressError && (
            <p className="text-sm text-[var(--color-warning)]">
              若配置已变更，请刷新并重新选择访问组。
            </p>
          )}
        </form>
      )}
    </>
  );
}
