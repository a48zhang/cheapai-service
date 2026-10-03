import { useEffect, useId, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiClientError } from '@cheapai/api-client/errors';
import type { ChannelInput, ChannelPatch, ChannelStatus, ChannelView } from '@cheapai/api-client/channels';
import { Button } from '../../shared/ui/Button';
import { Field } from '../../shared/ui/Field';
import { Input } from '../../shared/ui/Input';
import { Select } from '../../shared/ui/Select';
import { Sheet } from '../../shared/ui/Sheet';
import type { AdminChannelsApi } from './api';
import { channelCreationMayHaveSucceeded, uncertainChannelCreationMessage } from './create-outcome';
import { credentialInputError, credentialReplacement } from './credential-input';

type LimitMode = 'unlimited' | 'finite';

interface ChannelDraft {
  name: string;
  baseUrl: string;
  status: ChannelStatus;
  priority: string;
  concurrencyMode: LimitMode;
  concurrencyValue: string;
  rpmMode: LimitMode;
  rpmValue: string;
  upstreamKey: string;
}

interface ChannelFormErrors {
  name?: string;
  baseUrl?: string;
  status?: string;
  priority?: string;
  concurrency?: string;
  rpm?: string;
  upstreamKey?: string;
}

export interface ChannelFormProps {
  open: boolean;
  channel: ChannelView | null;
  api: AdminChannelsApi;
  onOpenChange: (open: boolean) => void;
  onSaved: (channel: ChannelView) => void;
}

const statusOptions = [
  { value: 'active', label: '启用' },
  { value: 'disabled', label: '停用' },
];

const limitModeOptions = [
  { value: 'unlimited', label: '不限' },
  { value: 'finite', label: '设置上限' },
];

function limitDraft(value: number | undefined): { mode: LimitMode; value: string } {
  if (value === undefined || value === Number.MAX_SAFE_INTEGER) return { mode: 'unlimited', value: '' };
  return { mode: 'finite', value: String(value) };
}

function createDraft(channel: ChannelView | null): ChannelDraft {
  const concurrency = limitDraft(channel?.concurrencyLimit);
  const rpm = limitDraft(channel?.rpmLimit);
  return {
    name: channel?.name ?? '',
    baseUrl: channel?.baseUrl ?? '',
    status: channel?.status ?? 'active',
    priority: String(channel?.priority ?? 0),
    concurrencyMode: concurrency.mode,
    concurrencyValue: concurrency.value,
    rpmMode: rpm.mode,
    rpmValue: rpm.value,
    // Channel credentials are write-only; never initialize this from a response.
    upstreamKey: '',
  };
}

function readLimit(mode: LimitMode, value: string, maximum?: number): { value?: number | null; error?: string } {
  if (mode === 'unlimited') return { value: null };
  if (!/^[0-9]+$/u.test(value)) return { error: '请输入正整数，或选择不限。' };
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number === Number.MAX_SAFE_INTEGER || (maximum !== undefined && number > maximum)) {
    return { error: maximum === undefined ? '请输入有效的并发上限。' : `上限需为 1 到 ${maximum} 的整数。` };
  }
  return { value: number };
}

function readPriority(value: string): { value?: number; error?: string } {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) return { error: '优先级必须是非负整数。' };
  const number = Number(value);
  return Number.isSafeInteger(number) ? { value: number } : { error: '优先级超出可用范围。' };
}

function cleanNameError(value: string): string | undefined {
  if (!value.trim()) return '请输入渠道名称。';
  if (value.length > 200 || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) return '渠道名称最多 200 个字符，且不能包含首尾空格或控制字符。';
  return undefined;
}

function cleanUrlError(value: string): string | undefined {
  if (!value.trim()) return '请输入上游 Base URL。';
  if (value.length > 2048 || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) return 'Base URL 格式无效。';
  return undefined;
}

export function ChannelForm({ open, channel, api, onOpenChange, onSaved }: ChannelFormProps) {
  const generatedId = useId().replace(/:/gu, '');
  const formId = `channel-form-${generatedId}`;
  const [draft, setDraft] = useState(() => createDraft(channel));
  const [errors, setErrors] = useState<ChannelFormErrors>({});
  const [saveError, setSaveError] = useState<{ message: string; requestId?: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [creationUncertain, setCreationUncertain] = useState(false);
  const creating = channel === null;

  useEffect(() => {
    if (!open || creationUncertain) return;
    setDraft(createDraft(channel));
    setErrors({});
    setSaveError(null);
  }, [open, channel, creationUncertain]);

  const updateDraft = <K extends keyof ChannelDraft>(key: K, value: ChannelDraft[K]) => {
    setDraft(current => ({ ...current, [key]: value }));
    setErrors(current => ({ ...current, [key]: undefined }));
    if (!creationUncertain) setSaveError(null);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving || creationUncertain) return;

    const nextErrors: ChannelFormErrors = {};
    const nameError = cleanNameError(draft.name);
    if (nameError !== undefined) nextErrors.name = nameError;
    const baseUrlError = cleanUrlError(draft.baseUrl);
    if (baseUrlError !== undefined) nextErrors.baseUrl = baseUrlError;
    const concurrency = readLimit(draft.concurrencyMode, draft.concurrencyValue);
    const rpm = readLimit(draft.rpmMode, draft.rpmValue, 4096);
    const priority = readPriority(draft.priority);
    if (concurrency.error !== undefined) nextErrors.concurrency = concurrency.error;
    if (rpm.error !== undefined) nextErrors.rpm = rpm.error;
    if (priority.error !== undefined) nextErrors.priority = priority.error;
    const upstreamKeyError = credentialInputError(draft.upstreamKey, creating);
    if (upstreamKeyError !== null) nextErrors.upstreamKey = upstreamKeyError;
    setErrors(nextErrors);

    if (Object.values(nextErrors).some(Boolean)
      || concurrency.value === undefined || rpm.value === undefined || priority.value === undefined) return;

    setSaving(true);
    setSaveError(null);
    try {
      const common = {
        name: draft.name,
        baseUrl: draft.baseUrl,
        status: draft.status,
        priority: priority.value,
        concurrencyLimit: concurrency.value,
        rpmLimit: rpm.value,
      };
      let saved: ChannelView;
      if (channel === null) {
        saved = await api.create({ ...common, upstreamKey: draft.upstreamKey } satisfies ChannelInput);
      } else {
        saved = await api.update(channel.id, channel.configVersion, {
          ...common,
          ...credentialReplacement(draft.upstreamKey),
        } satisfies ChannelPatch);
      }
      onSaved(saved);
    } catch (cause) {
      const conflict = cause instanceof ApiClientError && (cause.status === 409 || cause.code === 'conflict');
      const uncertain = creating && channelCreationMayHaveSucceeded(cause);
      if (uncertain) setCreationUncertain(true);
      const message = uncertain ? uncertainChannelCreationMessage : conflict
        ? '此渠道已被其他操作修改。你的输入仍保留，请关闭后重新打开最新配置，再合并后保存。'
        : cause instanceof Error ? cause.message : '渠道配置未能保存，请重试。';
      setSaveError({
        message,
        ...(cause instanceof ApiClientError && cause.request_id ? { requestId: cause.request_id } : {}),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet
      open={open}
      onOpenChange={value => { if (!saving && !creationUncertain) onOpenChange(value); }}
      title={creating ? '创建渠道' : `编辑渠道：${channel.name}`}
      description={creating
        ? '填写安全连接信息与调度限额。凭证只提交给服务端，不会再次显示。'
        : channel.hasCredential
          ? '现有凭证不会显示。替换凭证时填写新值，留空会保留当前凭证。'
          : '此渠道尚未配置凭证。留空会保留当前状态。'}
      closeButton={!saving && !creationUncertain}
      footer={(
        <>
          <Button variant="outline" disabled={saving || creationUncertain} onClick={() => onOpenChange(false)}>取消</Button>
          <Button type="submit" form={formId} busy={saving} disabled={creationUncertain}>{creating ? '创建渠道' : '保存更改'}</Button>
        </>
      )}
    >
      <form id={formId} className="space-y-4" onSubmit={submit}>
        {saveError && (
          <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900">
            <p>{saveError.message}</p>
            {saveError.requestId && <p className="mt-2 text-xs">请求编号：<code>{saveError.requestId}</code></p>}
          </div>
        )}

        {creationUncertain && <p className="text-sm">
          <a href="/admin/channels" target="_blank" rel="noreferrer" className="underline">在新标签页核对渠道</a>
          {' · '}<a href="/admin/audit" target="_blank" rel="noreferrer" className="underline">查看审计记录</a>
        </p>}

        <Field label="渠道名称" error={errors.name} required>
          <Input value={draft.name} onChange={event => updateDraft('name', event.currentTarget.value)} required disabled={saving} autoComplete="off" />
        </Field>
        <Field label="上游 Base URL" error={errors.baseUrl} description="服务端还会检查协议与目标地址安全策略。" required>
          <Input value={draft.baseUrl} onChange={event => updateDraft('baseUrl', event.currentTarget.value)} required disabled={saving} autoComplete="url" inputMode="url" />
        </Field>
        <Field
          label={creating ? '上游凭证' : '替换上游凭证'}
          error={errors.upstreamKey}
          description={creating ? '密钥不会回显或写入页面持久状态。' : '留空以保留已保存的凭证；输入新值才会替换。'}
          required={creating}
        >
          <Input
            type="password"
            value={draft.upstreamKey}
            onChange={event => updateDraft('upstreamKey', event.currentTarget.value)}
            autoComplete="new-password"
            disabled={saving}
            required={creating}
            placeholder={creating ? '输入上游凭证' : '留空以保留当前凭证'}
          />
        </Field>

        <Field label="渠道状态" required>
          <Select
            items={statusOptions}
            value={draft.status}
            onValueChange={value => {
              if (value === 'active' || value === 'disabled') updateDraft('status', value);
            }}
            disabled={saving}
            required
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-3">
            <Field label="并发规则" error={errors.concurrency}>
              <Select
                items={limitModeOptions}
                value={draft.concurrencyMode}
                onValueChange={value => {
                  if (value === 'unlimited' || value === 'finite') updateDraft('concurrencyMode', value);
                }}
                disabled={saving}
              />
            </Field>
            {draft.concurrencyMode === 'finite' && (
              <Field label="并发上限" error={errors.concurrency} required>
                <Input
                  type="number"
                  min={1}
                  max={Number.MAX_SAFE_INTEGER - 1}
                  step={1}
                  value={draft.concurrencyValue}
                  onChange={event => updateDraft('concurrencyValue', event.currentTarget.value)}
                  required
                  disabled={saving}
                />
              </Field>
            )}
          </div>
          <div className="space-y-3">
            <Field label="RPM 规则" error={errors.rpm}>
              <Select
                items={limitModeOptions}
                value={draft.rpmMode}
                onValueChange={value => {
                  if (value === 'unlimited' || value === 'finite') updateDraft('rpmMode', value);
                }}
                disabled={saving}
              />
            </Field>
            {draft.rpmMode === 'finite' && (
              <Field label="每分钟请求上限" error={errors.rpm} description="有限 RPM 范围为 1 到 4096。" required>
                <Input
                  type="number"
                  min={1}
                  max={4096}
                  step={1}
                  value={draft.rpmValue}
                  onChange={event => updateDraft('rpmValue', event.currentTarget.value)}
                  required
                  disabled={saving}
                />
              </Field>
            )}
          </div>
        </div>

        <Field label="调度优先级" error={errors.priority} description="数值越高越优先；0 为默认优先级。" required>
          <Input
            type="number"
            min={0}
            step={1}
            value={draft.priority}
            onChange={event => updateDraft('priority', event.currentTarget.value)}
            required
            disabled={saving}
          />
        </Field>
      </form>
    </Sheet>
  );
}
