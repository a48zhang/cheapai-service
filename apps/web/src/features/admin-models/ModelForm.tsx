import { Controller } from 'react-hook-form';
import type { ModelView } from '@cheapai/api-client/models';
import type { ApiClient } from '@cheapai/api-client/types';
import { builtinModel } from '@cheapai/model-catalog';
import { ApiErrorNotice } from '../../shared/patterns/ApiErrorNotice';
import { Field } from '../../shared/ui/Field';
import { Input } from '../../shared/ui/Input';
import { Button } from '../../shared/ui/Button';
import { ModelIdentity } from '../../shared/ui/ModelIdentity';
import { PriceFields } from './PriceFields';
import { modelPriceErrors } from './model-form-model';
import { useModelForm } from './useModelForm';

export interface ModelFormProps {
  readonly client: ApiClient;
  readonly initialPublicModelId?: string | undefined;
  readonly model?: ModelView | undefined;
  readonly onSaved: (model: ModelView) => void;
  readonly onCancel?: (() => void) | undefined;
}

/** Model edits send only changed fields against the loaded priceVersion. */
export function ModelForm({
  client,
  model,
  initialPublicModelId,
  onSaved,
  onCancel,
}: ModelFormProps) {
  const { form, saving, saveError, submit } = useModelForm({
    client,
    model,
    initialPublicModelId,
    onSaved,
  });
  const publicModelId = form.watch('publicModelId');
  const reference = builtinModel(publicModelId);
  const errors = form.formState.errors;

  return (
    <form className="space-y-6" noValidate onSubmit={form.handleSubmit(submit)}>
      <fieldset disabled={saving} className="grid gap-5 sm:grid-cols-2">
        <legend className="sr-only">模型设置</legend>
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
        <Field label="目录状态" required error={errors.status?.message}>
          <select
            {...form.register('status')}
            className="min-h-10 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm"
          >
            <option value="active">已启用</option>
            <option value="disabled">已停用</option>
          </select>
        </Field>
        {reference && (
          <details className="rounded-lg border border-[var(--color-border)] bg-[var(--color-muted)]/30 p-4 sm:col-span-2">
            <summary className="cursor-pointer text-sm font-medium">
              <ModelIdentity modelId={reference.id} secondary={`${reference.provider} 官方参考`} />
            </summary>
            <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
              <div className="sm:col-span-2">
                <dt className="console-muted">参考价格说明</dt>
                <dd>{reference.pricingNote}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="console-muted">官方资料</dt>
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
