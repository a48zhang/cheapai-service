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
            先创建一条启用渠道，限额默认不限。凭证仅在此处提交，不会回显。
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
          <Field label="上游凭证" required description="成功创建后会清空本地输入。">
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
          <Field
            label="内置模型参考"
            description="内置资料只提供公开模型参考与默认协议，不会替你创建模型或推断上游能力。"
          >
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
          <p className="text-xs leading-5 text-amber-800">
            此快捷流程不声明工具、流式或其他能力。创建后请在模型详情确认实际能力配置。
          </p>
        </form>
      )}

      {step === 'group' && (
        <form id={groupFormId} className="grid gap-4" onSubmit={onSubmitGroup}>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            渠道与映射已保存。将新渠道加入现有访问组；写入时使用当前组版本。
          </p>
          {groupsLoading && (
            <p role="status" className="text-sm text-[var(--color-muted-foreground)]">
              正在读取访问组…
            </p>
          )}
          {groupsError && (
            <div className="grid gap-2">
              <ApiErrorNotice error={groupsError} onRetry={onRetryGroups} />
              <p className="text-xs text-[var(--color-muted-foreground)]">
                访问组候选可单独重试，前面已保存的渠道与映射会保留。
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
            <Field label="访问组" required description="只修改渠道关联，保留组内其他设置。">
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
              当前组版本 v{selectedGroup.version}，已有 {selectedGroup.channelIds.length}{' '}
              个渠道；成功后会追加新渠道，并保留倍率与其他关联。
            </p>
          )}
          {progressError && (
            <p className="text-xs text-amber-800">
              若这是版本冲突，请重新读取访问组并重新选中目标组后再试。
            </p>
          )}
        </form>
      )}
    </>
  );
}
