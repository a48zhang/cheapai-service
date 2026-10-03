import { useId, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { BUILTIN_MODELS, builtinModel } from '@cheapai/model-catalog';
import type { ChannelInput } from '@cheapai/api-client/channels';
import type { GroupView } from '@cheapai/api-client/groups';
import type { ModelMappingView, Protocol } from '@cheapai/api-client/mappings';
import { ApiErrorNotice } from '../../shared/patterns/ApiErrorNotice';
import { Button } from '../../shared/ui/Button';
import { Field } from '../../shared/ui/Field';
import { Input } from '../../shared/ui/Input';
import { Select } from '../../shared/ui/Select';
import { Sheet } from '../../shared/ui/Sheet';
import type { ChannelSetupCommands, ChannelSetupProgress } from './setup-controller';
import { createChannelSetupController } from './setup-controller';
import { uncertainChannelCreationMessage } from './create-outcome';
import { credentialInputError } from './credential-input';

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

interface ChannelDraft {
  name: string;
  baseUrl: string;
  upstreamKey: string;
  priority: string;
}

interface MappingDraft {
  builtinId: string;
  publicModelId: string;
  protocol: Protocol;
  upstreamModel: string;
}

const protocolOptions = [
  { value: 'chat', label: 'Chat Completions' },
  { value: 'responses', label: 'Responses' },
  { value: 'messages', label: 'Messages' },
] as const;

function initialChannelDraft(): ChannelDraft {
  return { name: '', baseUrl: '', upstreamKey: '', priority: '0' };
}

function initialMappingDraft(): MappingDraft {
  return { builtinId: '', publicModelId: '', protocol: 'responses', upstreamModel: '' };
}

function cleanText(value: string, maximum: number) {
  return value.trim().length > 0 && value.length <= maximum && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function readPriority(value: string): number | null {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) return null;
  const priority = Number(value);
  return Number.isSafeInteger(priority) ? priority : null;
}

function stepLabel(step: ChannelSetupProgress['step'], current: ChannelSetupProgress['step'], done: boolean) {
  const labels = { channel: '创建渠道', mapping: '添加映射', group: '关联访问组', complete: '完成' };
  const active = step === current;
  return <span className={active ? 'font-semibold text-[var(--color-primary)]' : done ? 'text-[var(--color-foreground)]' : 'text-[var(--color-muted-foreground)]'}>
    {done ? '✓ ' : active ? '• ' : ''}{labels[step]}
  </span>;
}

function modelMappingReference(mapping: ModelMappingView | null) {
  return mapping ? `${mapping.publicModelId} · ${mapping.protocol} · v${mapping.configVersion}` : null;
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
  const [channelDraft, setChannelDraft] = useState(initialChannelDraft);
  const [mappingDraft, setMappingDraft] = useState(initialMappingDraft);
  const [groupId, setGroupId] = useState('');
  const [busy, setBusy] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const selectedGroup = groups.find(group => group.id === groupId) ?? null;
  const selectedBuiltin = builtinModel(mappingDraft.builtinId);

  const run = async (operation: () => Promise<ChannelSetupProgress>) => {
    if (busy) return;
    setBusy(true);
    const next = await operation();
    setProgress(next);
    setBusy(false);
    if (next.step === 'complete') onComplete?.(next);
  };

  const submitChannel = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (progress.channel || busy || progress.creationUncertain) return;
    const priority = readPriority(channelDraft.priority);
    const credentialError = credentialInputError(channelDraft.upstreamKey, true);
    if (!cleanText(channelDraft.name, 200)) {
      setValidationError('请输入有效的渠道名称。');
      return;
    }
    if (!cleanText(channelDraft.baseUrl, 2048)) {
      setValidationError('请输入有效的上游 Base URL。');
      return;
    }
    if (credentialError) {
      setValidationError(credentialError);
      return;
    }
    if (priority === null) {
      setValidationError('调度优先级必须是非负安全整数。');
      return;
    }
    setValidationError(null);

    const input = {
      name: channelDraft.name,
      baseUrl: channelDraft.baseUrl,
      upstreamKey: channelDraft.upstreamKey,
      status: 'active',
      priority,
      concurrencyLimit: null,
      rpmLimit: null,
    } satisfies ChannelInput;
    void run(async () => {
      const next = await controller.createChannel(input);
      if (next.channel) setChannelDraft(current => ({ ...current, upstreamKey: '' }));
      return next;
    });
  };

  const submitMapping = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!progress.channel || progress.mapping || busy) return;
    const validId = (value: string) => cleanText(value, 128) && /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/u.test(value);
    if (!validId(mappingDraft.publicModelId) || !validId(mappingDraft.upstreamModel)) {
      setValidationError('公开模型 ID 和上游模型 ID 必须使用有效标识格式。');
      return;
    }
    setValidationError(null);
    void run(() => controller.createMapping(mappingDraft.publicModelId, {
      protocol: mappingDraft.protocol,
      upstreamModel: mappingDraft.upstreamModel,
      // This quick setup makes no capability claims; configure verified capabilities in the model detail.
      capabilities: { protocol: mappingDraft.protocol, features: [] },
    }));
  };

  const submitGroup = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedGroup || busy || groupsLoading || groupsError) return;
    setValidationError(null);
    void run(() => controller.updateGroup(selectedGroup));
  };

  const selectBuiltin = (value: string) => {
    const model = builtinModel(value);
    setMappingDraft(current => ({
      ...current,
      builtinId: value,
      ...(model ? { publicModelId: model.id, protocol: model.protocol, upstreamModel: model.id } : {}),
    }));
  };

  const currentStep = progress.step;
  const footer = progress.step === 'channel' ? (
    <Button type="submit" form={channelFormId} busy={busy} disabled={busy || Boolean(progress.channel) || progress.creationUncertain}>
      {progress.creationUncertain ? '等待核对创建结果' : progress.error ? '重试创建渠道' : '创建渠道并继续'}
    </Button>
  ) : progress.step === 'mapping' ? (
    <Button type="submit" form={mappingFormId} busy={busy} disabled={busy || !progress.channel || Boolean(progress.mapping)}>
      {progress.error ? '重试添加映射' : '添加映射并继续'}
    </Button>
  ) : progress.step === 'group' ? (
    <Button type="submit" form={groupFormId} busy={busy} disabled={busy || !selectedGroup || groupsLoading || Boolean(groupsError)}>
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
      onOpenChange={next => { if (!busy && !progress.creationUncertain) onOpenChange(next); }}
      title="渠道快速配置"
      description="分步保存渠道、模型映射和访问组关联。每步都会立即写入服务端；后续失败时，已保存资源会保留。"
      closeButton={!busy && !progress.creationUncertain}
      footer={footer}
    >
      <div className="space-y-5">
        <ol aria-label="配置步骤" className="flex flex-wrap gap-x-5 gap-y-2 rounded-lg bg-[var(--color-muted)] px-4 py-3 text-sm">
          <li>{stepLabel('channel', currentStep, progress.channel !== null)}</li>
          <li>{stepLabel('mapping', currentStep, progress.mapping !== null)}</li>
          <li>{stepLabel('group', currentStep, progress.group !== null)}</li>
        </ol>

        {(progress.channel || progress.mapping || progress.group) && (
          <dl className="grid gap-3 rounded-lg border border-[var(--color-border)] p-4 text-sm sm:grid-cols-3">
            {progress.channel && <div className="min-w-0"><dt className="text-xs text-[var(--color-muted-foreground)]">已保存渠道</dt><dd className="mt-1 break-all font-mono">{progress.channel.id} · v{progress.channel.configVersion}</dd></div>}
            {progress.mapping && <div className="min-w-0"><dt className="text-xs text-[var(--color-muted-foreground)]">已保存映射</dt><dd className="mt-1 break-all">{modelMappingReference(progress.mapping)}</dd></div>}
            {progress.group && <div className="min-w-0"><dt className="text-xs text-[var(--color-muted-foreground)]">已更新访问组</dt><dd className="mt-1 break-all">{progress.group.name} · v{progress.group.version}</dd></div>}
          </dl>
        )}

        {progress.error && <ApiErrorNotice error={progress.error} />}
        {progress.creationUncertain && <div role="alert" className="space-y-2 text-sm">
          <p>{uncertainChannelCreationMessage}</p>
          <a href="/admin/channels" target="_blank" rel="noreferrer" className="underline">在新标签页核对渠道</a>
          {' · '}<a href="/admin/audit" target="_blank" rel="noreferrer" className="underline">查看审计记录</a>
        </div>}
        {validationError && <p role="alert" className="text-sm text-[var(--color-destructive)]">{validationError}</p>}

        {progress.step === 'channel' && (
          <form id={channelFormId} className="grid gap-4" onSubmit={submitChannel}>
            <p className="text-sm text-[var(--color-muted-foreground)]">先创建一条启用渠道，限额默认不限。凭证仅在此处提交，不会回显。</p>
            <Field label="渠道名称" required>
              <Input value={channelDraft.name} onChange={event => { const value = event.currentTarget.value; setChannelDraft(current => ({ ...current, name: value })); }} maxLength={200} required disabled={busy} />
            </Field>
            <Field label="上游 Base URL" required>
              <Input value={channelDraft.baseUrl} onChange={event => { const value = event.currentTarget.value; setChannelDraft(current => ({ ...current, baseUrl: value })); }} maxLength={2048} required inputMode="url" disabled={busy} />
            </Field>
            <Field label="上游凭证" required description="成功创建后会清空本地输入。">
              <Input type="password" value={channelDraft.upstreamKey} onChange={event => { const value = event.currentTarget.value; setChannelDraft(current => ({ ...current, upstreamKey: value })); }} autoComplete="new-password" maxLength={16_384} required disabled={busy} />
            </Field>
            <Field label="调度优先级" description="数值越高越优先；0 为默认值。" required>
              <Input type="number" min={0} step={1} value={channelDraft.priority} onChange={event => { const value = event.currentTarget.value; setChannelDraft(current => ({ ...current, priority: value })); }} required disabled={busy} />
            </Field>
          </form>
        )}

        {progress.step === 'mapping' && (
          <form id={mappingFormId} className="grid gap-4" onSubmit={submitMapping}>
            <p className="text-sm text-[var(--color-muted-foreground)]">渠道已保存。选择已有模型目录中的公开模型，然后声明上游模型 ID 与协议。</p>
            <Field label="内置模型参考" description="内置资料只提供公开模型参考与默认协议，不会替你创建模型或推断上游能力。">
              <Select
                items={[
                  { value: '', label: '不使用内置参考' },
                  ...BUILTIN_MODELS.map(model => ({ value: model.id, label: `${model.id} · ${model.provider}` })),
                ]}
                value={mappingDraft.builtinId}
                onValueChange={selectBuiltin}
                disabled={busy}
              />
            </Field>
            {selectedBuiltin && (
              <div className="rounded-md bg-[var(--color-muted)] p-3 text-xs text-[var(--color-muted-foreground)]">
                <p>{selectedBuiltin.provider} · 上下文窗口 {selectedBuiltin.contextWindow.toLocaleString()} · 最大输出 {selectedBuiltin.maxOutputTokens.toLocaleString()}</p>
                <a href={selectedBuiltin.source} target="_blank" rel="noreferrer" className="mt-1 inline-block text-[var(--color-primary)] underline">查看官方资料</a>
              </div>
            )}
            <Field label="公开模型 ID" description="此模型必须已存在于模型目录。" required>
              <Input value={mappingDraft.publicModelId} onChange={event => { const value = event.currentTarget.value; setMappingDraft(current => ({ ...current, publicModelId: value })); }} maxLength={128} required disabled={busy} />
            </Field>
            <Field label="映射协议" required>
              <Select
                items={protocolOptions}
                value={mappingDraft.protocol}
                onValueChange={value => {
                  if (value === 'chat' || value === 'responses' || value === 'messages') setMappingDraft(current => ({ ...current, protocol: value }));
                }}
                disabled={busy}
              />
            </Field>
            <Field label="上游模型 ID" required>
              <Input value={mappingDraft.upstreamModel} onChange={event => { const value = event.currentTarget.value; setMappingDraft(current => ({ ...current, upstreamModel: value })); }} maxLength={128} required disabled={busy} />
            </Field>
            <p className="text-xs leading-5 text-amber-800">此快捷流程不声明工具、流式或其他能力。创建后请在模型详情确认实际能力配置。</p>
          </form>
        )}

        {progress.step === 'group' && (
          <form id={groupFormId} className="grid gap-4" onSubmit={submitGroup}>
            <p className="text-sm text-[var(--color-muted-foreground)]">渠道与映射已保存。将新渠道加入现有访问组；写入时使用当前组版本。</p>
            {groupsLoading && <p role="status" className="text-sm text-[var(--color-muted-foreground)]">正在读取访问组…</p>}
            {groupsError && (
              <div className="grid gap-2">
                <ApiErrorNotice error={groupsError} onRetry={onRetryGroups} />
                <p className="text-xs text-[var(--color-muted-foreground)]">访问组候选可单独重试，前面已保存的渠道与映射会保留。</p>
              </div>
            )}
            {!groupsLoading && !groupsError && groups.length === 0 && (
              <div className="rounded-lg border border-dashed border-[var(--color-border)] p-4 text-sm">
                <p className="font-medium">还没有访问组</p>
                <p className="mt-1 text-[var(--color-muted-foreground)]">先创建访问组，再回来继续此步骤。</p>
                <Link to="/admin/groups" className="mt-2 inline-block font-medium text-[var(--color-primary)] underline">打开访问组管理</Link>
              </div>
            )}
            {groups.length > 0 && (
              <Field label="访问组" required description="只修改渠道关联，保留组内其他设置。">
                <Select
                  items={groups.map(group => ({
                    value: group.id,
                    label: `${group.name} · ${group.status === 'active' ? '启用' : '停用'} · v${group.version}`,
                  }))}
                  value={groupId}
                  onValueChange={setGroupId}
                  disabled={busy || groupsLoading || Boolean(groupsError)}
                  placeholder="选择访问组"
                  required
                />
              </Field>
            )}
            {selectedGroup && (
              <p className="rounded-md bg-[var(--color-muted)] p-3 text-xs text-[var(--color-muted-foreground)]">
                当前组版本 v{selectedGroup.version}，已有 {selectedGroup.channelIds.length} 个渠道；成功后会追加新渠道，并保留倍率与其他关联。
              </p>
            )}
            {progress.error && <p className="text-xs text-amber-800">若这是版本冲突，请重新读取访问组并重新选中目标组后再试。</p>}
          </form>
        )}

        {progress.step === 'complete' && progress.channel && (
          <section role="status" className="space-y-3 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-950">
            <h3 className="font-semibold">渠道设置已完成</h3>
            <p>渠道、映射和访问组已分别保存。它们不是一个原子事务；各资源可在详情页单独继续管理。</p>
            <div className="flex flex-wrap gap-3">
              <Link to={`/admin/channels/${encodeURIComponent(progress.channel.id)}`} className="font-medium underline">渠道详情</Link>
              {progress.group && <Link to={`/admin/groups/${encodeURIComponent(progress.group.id)}`} className="font-medium underline">访问组详情</Link>}
            </div>
          </section>
        )}
      </div>
    </Sheet>
  );
}
