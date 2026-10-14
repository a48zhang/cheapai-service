import { useEffect, useId } from 'react';
import { createPortal } from 'react-dom';
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
  embedded?: boolean;
  footerContainer?: HTMLElement | null;
  onBusyChange?: (busy: boolean) => void;
}

const statusOptions = [
  { value: 'active', label: '启用' },
  { value: 'disabled', label: '停用' },
];

const limitModeOptions = [
  { value: 'unlimited', label: '不限' },
  { value: 'finite', label: '设置上限' },
];

export function ChannelForm({
  open,
  channel,
  api,
  onOpenChange,
  onSaved,
  embedded = false,
  footerContainer,
  onBusyChange,
}: ChannelFormProps) {
  const generatedId = useId().replace(/:/gu, '');
  const formId = `channel-form-${generatedId}`;
  const {
    draft,
    errors,
    saveError,
    saving,
    saved,
    creationUncertain,
    creating,
    updateDraft,
    handleOpenChange,
    submit,
  } = useChannelForm({ open, channel, api, onOpenChange, onSaved });

  useEffect(() => {
    onBusyChange?.(saving || creationUncertain);
  }, [saving, creationUncertain, onBusyChange]);

  const footer = (
    <>
      {saved && (
        <p role="status" className="mr-auto text-sm text-[var(--color-success)]">
          更改已保存
        </p>
      )}
      <Button
        variant="outline"
        disabled={saving || creationUncertain}
        onClick={() => handleOpenChange(false)}
      >
        {embedded ? '关闭面板' : '取消'}
      </Button>
      <Button type="submit" form={formId} busy={saving} disabled={creationUncertain}>
        {creating ? '创建渠道' : '保存更改'}
      </Button>
    </>
  );
  const body = (
    <form id={formId} className="space-y-5" onSubmit={submit}>
      {saveError && <ApiErrorNotice error={saveError} />}

      {creationUncertain && (
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm">
            <a href="/admin/channels" target="_blank" rel="noreferrer">
              在新标签页核对渠道
            </a>
          </Button>
          <Button asChild variant="outline" size="sm">
            <a href="/admin/audit" target="_blank" rel="noreferrer">
              查看审计记录
            </a>
          </Button>
        </div>
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
        label="上游地址"
        error={errors.baseUrl}

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
      <details
        className="border-t border-[var(--color-border)] pt-5"
        open={Boolean(errors.concurrency || errors.rpm || errors.priority) || undefined}
      >
        <summary className="cursor-pointer font-medium">高级调度设置</summary>
        <fieldset className="mt-5 space-y-5">
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
              <Field label="每分钟请求规则" error={errors.rpm}>
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
                  description="范围：1–4096。"
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
        </fieldset>
      </details>
    </form>
  );

  if (embedded)
    return (
      <div className="space-y-6">
        {body}
        {footerContainer && createPortal(footer, footerContainer)}
      </div>
    );

  return (
    <Sheet
      open={open}
      onOpenChange={handleOpenChange}
      title={creating ? '创建渠道' : `编辑渠道：${channel?.name}`}
      closeButton={!saving && !creationUncertain}
      footer={footer}
    >
      {body}
    </Sheet>
  );
}
