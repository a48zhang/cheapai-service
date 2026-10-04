import { useId } from 'react';
import type { ChannelView } from '@cheapai/api-client/channels';
import { ApiErrorNotice } from '../../shared/patterns/ApiErrorNotice';
import { Button } from '../../shared/ui/Button';
import { Field } from '../../shared/ui/Field';
import { Input } from '../../shared/ui/Input';
import { Select } from '../../shared/ui/Select';
import { Sheet } from '../../shared/ui/Sheet';
import type { AdminChannelsApi } from './api';
import { useChannelForm } from './useChannelForm';

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

export function ChannelForm({ open, channel, api, onOpenChange, onSaved }: ChannelFormProps) {
  const generatedId = useId().replace(/:/gu, '');
  const formId = `channel-form-${generatedId}`;
  const {
    draft,
    errors,
    saveError,
    saving,
    creationUncertain,
    creating,
    updateDraft,
    handleOpenChange,
    submit,
  } = useChannelForm({ open, channel, api, onOpenChange, onSaved });

  return (
    <Sheet
      open={open}
      onOpenChange={handleOpenChange}
      title={channel === null ? '创建渠道' : `编辑渠道：${channel.name}`}
      description={
        channel === null
          ? '填写安全连接信息与调度限额。凭证只提交给服务端，不会再次显示。'
          : channel.hasCredential
            ? '现有凭证不会显示。替换凭证时填写新值，留空会保留当前凭证。'
            : '此渠道尚未配置凭证。留空会保留当前状态。'
      }
      closeButton={!saving && !creationUncertain}
      footer={
        <>
          <Button
            variant="outline"
            disabled={saving || creationUncertain}
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button type="submit" form={formId} busy={saving} disabled={creationUncertain}>
            {creating ? '创建渠道' : '保存更改'}
          </Button>
        </>
      }
    >
      <form id={formId} className="space-y-4" onSubmit={submit}>
        {saveError && <ApiErrorNotice error={saveError} />}

        {creationUncertain && (
          <p className="text-sm">
            <a href="/admin/channels" target="_blank" rel="noreferrer" className="underline">
              在新标签页核对渠道
            </a>
            {' · '}
            <a href="/admin/audit" target="_blank" rel="noreferrer" className="underline">
              查看审计记录
            </a>
          </p>
        )}

        <Field label="渠道名称" error={errors.name} required>
          <Input
            value={draft.name}
            onChange={(event) => updateDraft('name', event.currentTarget.value)}
            required
            disabled={saving}
            autoComplete="off"
          />
        </Field>
        <Field
          label="上游 Base URL"
          error={errors.baseUrl}
          description="服务端还会检查协议与目标地址安全策略。"
          required
        >
          <Input
            value={draft.baseUrl}
            onChange={(event) => updateDraft('baseUrl', event.currentTarget.value)}
            required
            disabled={saving}
            autoComplete="url"
            inputMode="url"
          />
        </Field>
        <Field
          label={creating ? '上游凭证' : '替换上游凭证'}
          error={errors.upstreamKey}
          description={
            creating
              ? '密钥不会回显或写入页面持久状态。'
              : '留空以保留已保存的凭证；输入新值才会替换。'
          }
          required={creating}
        >
          <Input
            type="password"
            value={draft.upstreamKey}
            onChange={(event) => updateDraft('upstreamKey', event.currentTarget.value)}
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
            onValueChange={(value) => {
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
                onValueChange={(value) => {
                  if (value === 'unlimited' || value === 'finite')
                    updateDraft('concurrencyMode', value);
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
                  onChange={(event) => updateDraft('concurrencyValue', event.currentTarget.value)}
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
                onValueChange={(value) => {
                  if (value === 'unlimited' || value === 'finite') updateDraft('rpmMode', value);
                }}
                disabled={saving}
              />
            </Field>
            {draft.rpmMode === 'finite' && (
              <Field
                label="每分钟请求上限"
                error={errors.rpm}
                description="有限 RPM 范围为 1 到 4096。"
                required
              >
                <Input
                  type="number"
                  min={1}
                  max={4096}
                  step={1}
                  value={draft.rpmValue}
                  onChange={(event) => updateDraft('rpmValue', event.currentTarget.value)}
                  required
                  disabled={saving}
                />
              </Field>
            )}
          </div>
        </div>

        <Field
          label="调度优先级"
          error={errors.priority}
          description="数值越高越优先；0 为默认优先级。"
          required
        >
          <Input
            type="number"
            min={0}
            step={1}
            value={draft.priority}
            onChange={(event) => updateDraft('priority', event.currentTarget.value)}
            required
            disabled={saving}
          />
        </Field>
      </form>
    </Sheet>
  );
}
