import { useId, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { GroupView } from '@cheapai/api-client/groups';
import type { ModelMappingView } from '@cheapai/api-client/mappings';
import { ApiErrorNotice } from '../../shared/patterns/ApiErrorNotice';
import { Button } from '../../shared/ui/Button';
import { Sheet } from '../../shared/ui/Sheet';
import type { ChannelSetupCommands, ChannelSetupProgress } from './setup-controller';
import { createChannelSetupController } from './setup-controller';
import { uncertainChannelCreationMessage } from './create-outcome';
import { ChannelSetupSteps } from './ChannelSetupSteps';
import {
  buildSetupChannelInput,
  buildSetupMappingDraft,
  initialSetupChannelDraft,
  initialSetupMappingDraft,
  selectBuiltinReference,
  selectedBuiltinReference,
  validateSetupChannelDraft,
  validateSetupMappingDraft,
} from './setup-form-model';
import type { SetupChannelDraft, SetupMappingDraft } from './setup-form-model';

export interface ChannelSetupProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly commands: ChannelSetupCommands;
  readonly groups: readonly GroupView[];
  readonly groupsLoading?: boolean;
  readonly groupsError?: Error | null;
  readonly onRetryGroups?: () => void;
  readonly onComplete?: (progress: ChannelSetupProgress) => void;
}

function stepLabel(
  step: ChannelSetupProgress['step'],
  current: ChannelSetupProgress['step'],
  done: boolean,
) {
  const labels = {
    channel: '创建渠道',
    mapping: '添加映射',
    group: '关联访问组',
    complete: '完成',
  };
  const active = step === current;
  return (
    <span
      className={
        active
          ? 'font-semibold text-[var(--color-primary)]'
          : done
            ? 'text-[var(--color-foreground)]'
            : 'text-[var(--color-muted-foreground)]'
      }
    >
      {done ? '✓ ' : active ? '• ' : ''}
      {labels[step]}
    </span>
  );
}

function modelMappingReference(mapping: ModelMappingView | null) {
  return mapping
    ? `${mapping.publicModelId} · ${mapping.protocol} · v${mapping.configVersion}`
    : null;
}

/** Guided setup records each successful resource and resumes at the next unfinished step. */
export function ChannelSetup({
  open,
  onOpenChange,
  commands,
  groups,
  groupsLoading = false,
  groupsError,
  onRetryGroups,
  onComplete,
}: ChannelSetupProps) {
  const id = useId().replace(/:/gu, '');
  const channelFormId = `channel-setup-channel-${id}`;
  const mappingFormId = `channel-setup-mapping-${id}`;
  const groupFormId = `channel-setup-group-${id}`;
  const controller = useMemo(() => createChannelSetupController(commands), [commands]);
  const [progress, setProgress] = useState<ChannelSetupProgress>(() => controller.getSnapshot());
  const [channelDraft, setChannelDraft] = useState<SetupChannelDraft>(initialSetupChannelDraft);
  const [mappingDraft, setMappingDraft] = useState<SetupMappingDraft>(initialSetupMappingDraft);
  const [groupId, setGroupId] = useState('');
  const [busy, setBusy] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const selectedGroup = groups.find((group) => group.id === groupId) ?? null;
  const selectedBuiltin = selectedBuiltinReference(mappingDraft);

  const run = async (operation: () => Promise<ChannelSetupProgress>) => {
    if (busy) return;
    setBusy(true);
    const next = await operation();
    setProgress(next);
    setBusy(false);
    if (next.step === 'complete') onComplete?.(next);
  };

  const updateChannelDraft = <K extends keyof SetupChannelDraft>(
    key: K,
    value: SetupChannelDraft[K],
  ) => {
    setChannelDraft((current) => ({ ...current, [key]: value }));
  };

  const updateMappingDraft = <K extends keyof SetupMappingDraft>(
    key: K,
    value: SetupMappingDraft[K],
  ) => {
    setMappingDraft((current) => ({ ...current, [key]: value }));
  };

  const submitChannel = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (progress.channel || busy || progress.creationUncertain) return;
    const error = validateSetupChannelDraft(channelDraft);
    if (error !== null) {
      setValidationError(error);
      return;
    }
    setValidationError(null);

    const input = buildSetupChannelInput(channelDraft);
    void run(async () => {
      const next = await controller.createChannel(input);
      if (next.channel) setChannelDraft((current) => ({ ...current, upstreamKey: '' }));
      return next;
    });
  };

  const submitMapping = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!progress.channel || progress.mapping || busy) return;
    const error = validateSetupMappingDraft(mappingDraft);
    if (error !== null) {
      setValidationError(error);
      return;
    }
    setValidationError(null);
    void run(() =>
      controller.createMapping(mappingDraft.publicModelId, buildSetupMappingDraft(mappingDraft)),
    );
  };

  const submitGroup = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedGroup || busy || groupsLoading || groupsError) return;
    setValidationError(null);
    void run(() => controller.updateGroup(selectedGroup));
  };

  const selectBuiltin = (value: string) => {
    setMappingDraft((current) => selectBuiltinReference(current, value));
  };

  const currentStep = progress.step;
  const footer =
    progress.step === 'channel' ? (
      <Button
        type="submit"
        form={channelFormId}
        busy={busy}
        disabled={busy || Boolean(progress.channel) || progress.creationUncertain}
      >
        {progress.creationUncertain
          ? '等待核对创建结果'
          : progress.error
            ? '重试创建渠道'
            : '创建渠道并继续'}
      </Button>
    ) : progress.step === 'mapping' ? (
      <Button
        type="submit"
        form={mappingFormId}
        busy={busy}
        disabled={busy || !progress.channel || Boolean(progress.mapping)}
      >
        {progress.error ? '重试添加映射' : '添加映射并继续'}
      </Button>
    ) : progress.step === 'group' ? (
      <Button
        type="submit"
        form={groupFormId}
        busy={busy}
        disabled={busy || !selectedGroup || groupsLoading || Boolean(groupsError)}
      >
        {progress.error ? '重试关联访问组' : '关联访问组并完成'}
      </Button>
    ) : progress.channel ? (
      <Button asChild variant="outline">
        <Link to={`/admin/channels/${encodeURIComponent(progress.channel.id)}`}>打开渠道详情</Link>
      </Button>
    ) : null;

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!busy && !progress.creationUncertain) onOpenChange(next);
      }}
      title="渠道快速配置"
      description="分步保存渠道、模型映射和访问组关联。每步都会立即写入服务端；后续失败时，已保存资源会保留。"
      closeButton={!busy && !progress.creationUncertain}
      footer={footer}
    >
      <div className="space-y-5">
        <ol
          aria-label="配置步骤"
          className="flex flex-wrap gap-x-5 gap-y-2 rounded-lg bg-[var(--color-muted)] px-4 py-3 text-sm"
        >
          <li>{stepLabel('channel', currentStep, progress.channel !== null)}</li>
          <li>{stepLabel('mapping', currentStep, progress.mapping !== null)}</li>
          <li>{stepLabel('group', currentStep, progress.group !== null)}</li>
        </ol>

        {(progress.channel || progress.mapping || progress.group) && (
          <dl className="grid gap-3 rounded-lg border border-[var(--color-border)] p-4 text-sm sm:grid-cols-3">
            {progress.channel && (
              <div className="min-w-0">
                <dt className="text-xs text-[var(--color-muted-foreground)]">已保存渠道</dt>
                <dd className="mt-1 break-all font-mono">
                  {progress.channel.id} · v{progress.channel.configVersion}
                </dd>
              </div>
            )}
            {progress.mapping && (
              <div className="min-w-0">
                <dt className="text-xs text-[var(--color-muted-foreground)]">已保存映射</dt>
                <dd className="mt-1 break-all">{modelMappingReference(progress.mapping)}</dd>
              </div>
            )}
            {progress.group && (
              <div className="min-w-0">
                <dt className="text-xs text-[var(--color-muted-foreground)]">已更新访问组</dt>
                <dd className="mt-1 break-all">
                  {progress.group.name} · v{progress.group.version}
                </dd>
              </div>
            )}
          </dl>
        )}

        {progress.error && <ApiErrorNotice error={progress.error} />}
        {progress.creationUncertain && (
          <div role="alert" className="space-y-2 text-sm">
            <p>{uncertainChannelCreationMessage}</p>
            <a href="/admin/channels" target="_blank" rel="noreferrer" className="underline">
              在新标签页核对渠道
            </a>
            {' · '}
            <a href="/admin/audit" target="_blank" rel="noreferrer" className="underline">
              查看审计记录
            </a>
          </div>
        )}
        {validationError && (
          <p role="alert" className="text-sm text-[var(--color-destructive)]">
            {validationError}
          </p>
        )}

        <ChannelSetupSteps
          step={progress.step}
          channelFormId={channelFormId}
          mappingFormId={mappingFormId}
          groupFormId={groupFormId}
          channelDraft={channelDraft}
          mappingDraft={mappingDraft}
          groupId={groupId}
          groups={groups}
          groupsLoading={groupsLoading}
          groupsError={groupsError}
          onRetryGroups={onRetryGroups}
          selectedGroup={selectedGroup}
          selectedBuiltin={selectedBuiltin}
          progressError={progress.error}
          busy={busy}
          onSubmitChannel={submitChannel}
          onChannelDraftChange={updateChannelDraft}
          onSubmitMapping={submitMapping}
          onMappingDraftChange={updateMappingDraft}
          onSelectBuiltin={selectBuiltin}
          onSubmitGroup={submitGroup}
          onGroupIdChange={setGroupId}
        />

        {progress.step === 'complete' && progress.channel && (
          <section
            role="status"
            className="space-y-3 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-950"
          >
            <h3 className="font-semibold">渠道设置已完成</h3>
            <p>
              渠道、映射和访问组已分别保存。它们不是一个原子事务；各资源可在详情页单独继续管理。
            </p>
            <div className="flex flex-wrap gap-3">
              <Link
                to={`/admin/channels/${encodeURIComponent(progress.channel.id)}`}
                className="font-medium underline"
              >
                渠道详情
              </Link>
              {progress.group && (
                <Link
                  to={`/admin/groups/${encodeURIComponent(progress.group.id)}`}
                  className="font-medium underline"
                >
                  访问组详情
                </Link>
              )}
            </div>
          </section>
        )}
      </div>
    </Sheet>
  );
}
