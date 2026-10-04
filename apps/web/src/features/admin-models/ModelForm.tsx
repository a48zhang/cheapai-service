import { Controller } from 'react-hook-form';
import type { ModelView } from '@cheapai/api-client/models';
import type { ApiClient } from '@cheapai/api-client/types';
import { builtinModel } from '@cheapai/model-catalog';
import { ApiErrorNotice } from '../../shared/patterns/ApiErrorNotice';
import { Field } from '../../shared/ui/Field';
import { Input } from '../../shared/ui/Input';
import { Button } from '../../shared/ui/Button';
import { PriceFields } from './PriceFields';
import { modelPriceErrors } from './model-form-model';
import { useModelForm } from './useModelForm';

export interface ModelFormProps {
  readonly client: ApiClient;
  readonly model?: ModelView | undefined;
  readonly onSaved: (model: ModelView) => void;
  readonly onCancel?: (() => void) | undefined;
}

/** Model edits send only changed fields against the loaded priceVersion. */
export function ModelForm({ client, model, onSaved, onCancel }: ModelFormProps) {
  const { form, saving, saveError, submit } = useModelForm({ client, model, onSaved });
  const publicModelId = form.watch('publicModelId');
  const reference = builtinModel(publicModelId);
  const errors = form.formState.errors;

  return (
    <form className="space-y-6" noValidate onSubmit={form.handleSubmit(submit)}>
      <fieldset
        disabled={saving}
        className="grid gap-5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 sm:grid-cols-2"
      >
        <legend className="px-1 text-sm font-semibold">模型设置</legend>
        <Field
          label="公开模型 ID"
          required
          error={errors.publicModelId?.message}
          description="供 API 请求使用的公开名称。"
        >
          <Input
            {...form.register('publicModelId')}
            required
            readOnly={model !== undefined}
            autoComplete="off"
            maxLength={128}
          />
        </Field>
        {reference && (
          <details className="rounded-lg border border-[var(--color-border)] bg-[var(--color-muted)]/30 p-4 sm:col-span-2">
            <summary className="cursor-pointer text-sm font-medium">
              {reference.provider} 官方参考：{reference.id}
            </summary>
            <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs text-[var(--color-muted-foreground)]">上下文窗口</dt>
                <dd className="font-mono tabular-nums">
                  {reference.contextWindow.toLocaleString()} Token
                </dd>
              </div>
              <div>
                <dt className="text-xs text-[var(--color-muted-foreground)]">参考最大输出</dt>
                <dd className="font-mono tabular-nums">
                  {reference.maxOutputTokens.toLocaleString()} Token
                </dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-xs text-[var(--color-muted-foreground)]">参考价格说明</dt>
                <dd>{reference.pricingNote}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-xs text-[var(--color-muted-foreground)]">官方资料</dt>
                <dd>
                  <a
                    href={reference.source}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[var(--color-primary)] underline underline-offset-2"
                  >
                    打开供应商价格与模型文档
                  </a>
                </dd>
              </div>
            </dl>
          </details>
        )}
        <Field label="目录状态" required error={errors.status?.message}>
          <select
            {...form.register('status')}
            className="min-h-10 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm"
          >
            <option value="active">已启用</option>
            <option value="disabled">已停用</option>
          </select>
        </Field>
        <Controller
          name="sellPrices"
          control={form.control}
          render={({ field, fieldState }) => (
            <div className="sm:col-span-2">
              <PriceFields
                value={field.value}
                errors={modelPriceErrors(fieldState.error)}
                disabled={saving}
                onChange={field.onChange}
              />
            </div>
          )}
        />
        <Field
          label="最低余额门槛（USD 最小单位）"
          required
          error={errors.admissionMinBalanceUnits?.message}
          description="填写非负整数。"
        >
          <Input
            {...form.register('admissionMinBalanceUnits')}
            required
            inputMode="numeric"
            maxLength={17}
            placeholder="例如 0"
          />
        </Field>
        <Field label="最大输出 Token" required error={errors.maxOutputTokens?.message}>
          <Input
            {...form.register('maxOutputTokens')}
            required
            inputMode="numeric"
            maxLength={16}
            placeholder="请输入正整数"
          />
        </Field>
      </fieldset>
      {saveError && <ApiErrorNotice error={saveError} />}
      <div className="flex flex-wrap justify-end gap-3">
        {onCancel && (
          <Button variant="secondary" disabled={saving} onClick={onCancel}>
            取消
          </Button>
        )}
        <Button type="submit" busy={saving}>
          {model ? '保存模型' : '创建模型'}
        </Button>
      </div>
    </form>
  );
}
