import type { FormEvent } from 'react';
import { BUILTIN_MODELS } from '@cheapai/model-catalog';
import type { BuiltinModel } from '@cheapai/model-catalog';
import type { GroupView } from '@cheapai/api-client/groups';
import type { ChannelSetupProgress } from './setup-controller';
import type { SetupChannelDraft, SetupMappingDraft } from './setup-form-model';
import { ApiErrorNotice } from '../../shared/patterns/ApiErrorNotice';
import { Field } from '../../shared/ui/Field';
import { Input } from '../../shared/ui/Input';
import { Select } from '../../shared/ui/Select';
import { Link } from 'react-router-dom';

export interface ChannelSetupStepsProps {
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
  readonly selectedBuiltin: BuiltinModel | undefined;
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
  readonly onSelectBuiltin: (value: string) => void;
  readonly onSubmitGroup: (event: FormEvent<HTMLFormElement>) => void;
  readonly onGroupIdChange: (value: string) => void;
}

const protocolOptions = [
  { value: 'chat', label: 'Chat Completions' },
  { value: 'responses', label: 'Responses' },
  { value: 'messages', label: 'Messages' },
] as const;

export function ChannelSetupSteps({
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
  selectedBuiltin,
  progressError,
  busy,
  onSubmitChannel,
  onChannelDraftChange,
  onSubmitMapping,
  onMappingDraftChange,
  onSelectBuiltin,
  onSubmitGroup,
  onGroupIdChange,
}: ChannelSetupStepsProps) {
  return (
    <>
      {step === 'channel' && (
        <form id={channelFormId} className="grid gap-4" onSubmit={onSubmitChannel}>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            新渠道默认启用，请求与并发上限不限。
          </p>
          <Field label="渠道名称" required>
            <Input
              value={channelDraft.name}
              onChange={(event) => onChannelDraftChange('name', event.currentTarget.value)}
              maxLength={200}
              required
              disabled={busy}
            />
          </Field>
          <Field label="上游 Base URL" required>
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
          <p className="text-sm text-[var(--color-muted-foreground)]">
            渠道已保存。选择已有模型目录中的公开模型，然后声明上游模型 ID 与协议。
          </p>
          <Field label="内置模型参考">
            <Select
              items={[
                { value: '', label: '不使用内置参考' },
                ...BUILTIN_MODELS.map((model) => ({
                  value: model.id,
                  label: `${model.id} · ${model.provider}`,
                })),
              ]}
              value={mappingDraft.builtinId}
              onValueChange={onSelectBuiltin}
              disabled={busy}
            />
          </Field>
          {selectedBuiltin && (
            <div className="rounded-md bg-[var(--color-muted)] p-3 text-xs text-[var(--color-muted-foreground)]">
              <p>
                {selectedBuiltin.provider} · 上下文窗口{' '}
                {selectedBuiltin.contextWindow.toLocaleString()} · 最大输出{' '}
                {selectedBuiltin.maxOutputTokens.toLocaleString()}
              </p>
              <a
                href={selectedBuiltin.source}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-block text-[var(--color-primary)] underline"
              >
                查看官方资料
              </a>
            </div>
          )}
          <Field label="公开模型 ID" description="此模型必须已存在于模型目录。" required>
            <Input
              value={mappingDraft.publicModelId}
              onChange={(event) => onMappingDraftChange('publicModelId', event.currentTarget.value)}
              maxLength={128}
              required
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
          <Field label="上游模型 ID" required>
            <Input
              value={mappingDraft.upstreamModel}
              onChange={(event) => onMappingDraftChange('upstreamModel', event.currentTarget.value)}
              maxLength={128}
              required
              disabled={busy}
            />
          </Field>
          <p className="text-xs leading-5 text-[var(--color-warning)]">
            流式、工具调用等能力需在模型详情配置。
          </p>
        </form>
      )}

      {step === 'group' && (
        <form id={groupFormId} className="grid gap-4" onSubmit={onSubmitGroup}>
          <p className="text-sm text-[var(--color-muted-foreground)]">将新渠道加入访问组。</p>
          {groupsLoading && (
            <p role="status" className="text-sm text-[var(--color-muted-foreground)]">
              正在读取访问组…
            </p>
          )}
          {groupsError && (
            <div className="grid gap-2">
              <ApiErrorNotice error={groupsError} onRetry={onRetryGroups} />
              <p className="text-xs text-[var(--color-muted-foreground)]">
                请重试加载访问组；渠道与映射已保存。
              </p>
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
                  label: `${group.name} · ${group.status === 'active' ? '启用' : '停用'} · v${group.version}`,
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
            <p className="rounded-md bg-[var(--color-muted)] p-3 text-xs text-[var(--color-muted-foreground)]">
              已有 {selectedGroup.channelIds.length} 个渠道
            </p>
          )}
          {progressError && (
            <p className="text-xs text-[var(--color-warning)]">
              若配置已变更，请刷新并重新选择访问组。
            </p>
          )}
        </form>
      )}
    </>
  );
}
